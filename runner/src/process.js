// One page worker process, seen from the runner: spawning it under Node's
// permission model, relaying requests to it and responses back, and the
// per-request limits (docs/page-backends.md, "Runner" and "Limits").
// The IPC protocol is described in worker/bootstrap.mjs.

import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerError, sendError } from './errors.js';

const WORKER_DIR = fileURLToPath(new URL('./worker/', import.meta.url));
const BOOTSTRAP = path.join(WORKER_DIR, 'bootstrap.mjs');
const STOP_GRACE_MS = 5000;
const STDERR_TAIL = 4096;
const MAX_LINE = 16 * 1024;

// Never forwarded to the handler: credentials of the viewer's session,
// specola's own headers, and connection-level headers that describe the hop
// to the runner rather than the page's request.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

export function requestHeaders(headers) {
  return headers.filter(([k]) => {
    const n = k.toLowerCase();
    return n !== 'cookie' && !n.startsWith('x-specola-') && !HOP_BY_HOP.has(n);
  });
}

// Response headers a browser applies to the whole origin they come from, not
// to the one response. The viewer's fetch receives the handler's answer on
// specola's origin, so these would let one page's backend sign every viewer
// out (Clear-Site-Data), install reporting of all their requests (NEL,
// Report-To) or change how the browser reaches specola. Specola drops the
// same list (internal/server/backend.go, originWide).
export const ORIGIN_WIDE = new Set([
  'clear-site-data',
  'nel',
  'report-to',
  'reporting-endpoints',
  'strict-transport-security',
  'alt-svc',
  'accept-ch',
  'critical-ch',
  'origin-agent-cluster',
  'service-worker-allowed',
  'set-login',
  'refresh',
]);

// The handler's response headers, minus what it may not set: cookies (the
// frame has no cookies of its own, and specola's must stay specola's),
// hop-by-hop headers, the length (the body is re-chunked on the way),
// X-Specola-* (a handler must not be able to pose as a specola error such
// as "superseded"), headers with an effect on the whole origin and CORS
// ones (the call is same-origin; a handler must not open it to others).
export function responseHeaders(headers) {
  return headers.filter(([k]) => {
    const n = k.toLowerCase();
    return (
      n !== 'set-cookie' &&
      n !== 'content-length' &&
      !n.startsWith('x-specola-') &&
      !n.startsWith('access-control-') &&
      !HOP_BY_HOP.has(n) &&
      !ORIGIN_WIDE.has(n)
    );
  });
}

// Calls onLine for each line of a stream, cutting lines longer than
// MAX_LINE: page code can write megabytes without a newline, which must not
// pile up in the runner, shared by every page.
function eachLine(stream, onLine) {
  let buf = '';
  let cut = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const parts = (buf + chunk).split('\n');
    buf = parts.pop();
    for (const l of parts) {
      if (!cut) onLine(l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '… (truncated)' : l.replace(/\r$/, ''));
      cut = false;
    }
    if (buf.length > MAX_LINE && !cut) {
      onLine(buf.slice(0, MAX_LINE) + '… (truncated)');
      cut = true;
    }
    if (cut) buf = '';
  });
  stream.on('end', () => {
    if (buf && !cut) onLine(buf);
  });
}

const newRef = () => randomBytes(5).toString('hex');
const seconds = (ms) => (ms % 1000 ? `${ms} ms` : `${ms / 1000} s`);

export class PageWorker {
  #child = null;
  #ready;
  #readyCb;
  #calls = new Map();
  #nextId = 1;
  #idleTimer = null;
  #pingTimer = null;
  #stopping = false;
  #killReason = null;
  #stderrTail = '';
  #startTimer = null;

  /**
   * @param {object} o
   * @param {{id: string, version: number, title: string}} o.page
   * @param {string} o.codeDir
   * @param {string} o.entry absolute path of the entry file
   * @param {string} o.pageDir
   * @param {string} o.snapshotsDir the page's snapshots, which it may read only
   * @param {object} o.limits
   * @param {import('./log.js').Logs} o.logs
   * @param {(w: PageWorker) => void} o.onGone called once the process is gone
   */
  constructor({ page, codeDir, entry, pageDir, snapshotsDir, limits, logs, onGone }) {
    Object.assign(this, { page, codeDir, entry, pageDir, snapshotsDir, limits, logs, onGone });
    this.state = 'new'; // new → starting → ready → (draining) → stopped; or failed
    this.#ready = new Promise((resolve, reject) => {
      this.#readyCb = { resolve, reject };
    });
    this.#ready.catch(() => {});
  }

  get version() {
    return this.page.version;
  }

  get inflight() {
    return this.#calls.size;
  }

  get gone() {
    return this.state === 'stopped' || this.state === 'failed';
  }

  #log(level, text, ref) {
    return this.logs.append(this.page.id, level, text, ref);
  }

  start() {
    fs.mkdirSync(this.pageDir, { recursive: true });
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    this.state = 'starting';
    const execArgv = [
      '--permission',
      `--allow-fs-read=${this.codeDir}`,
      `--allow-fs-read=${this.pageDir}`,
      // Read-only: the file store checks which blobs snapshots still name.
      `--allow-fs-read=${this.snapshotsDir}`,
      `--allow-fs-read=${WORKER_DIR}`,
      `--allow-fs-write=${this.pageDir}`,
      `--max-old-space-size=${this.limits.workerMemoryMb}`,
      '--disable-warning=ExperimentalWarning',
    ];
    // A minimal environment: nothing of the runner's (its token above all)
    // reaches page code.
    // Outbound fetch is unrestricted for now: the egress proxy that limits it
    // to the manifest's hosts (HTTPS_PROXY + NODE_USE_ENV_PROXY here) is a
    // later delivery step (docs/page-backends.md, "Delivery plan").
    const env = { TZ: 'UTC', NODE_ENV: 'production', LANG: 'C.UTF-8' };
    const child = fork(BOOTSTRAP, [], {
      execArgv,
      env,
      cwd: this.pageDir,
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.#child = child;
    child.on('message', (m) => this.#onMessage(m));
    child.on('exit', (code, signal) => this.#onExit(code, signal));
    child.on('error', (err) => this.#log('error', `worker process error: ${err.message}`));
    eachLine(child.stdout, (l) => this.#log('log', l));
    eachLine(child.stderr, (l) => {
      this.#stderrTail = (this.#stderrTail + l + '\n').slice(-STDERR_TAIL);
      this.#log('error', l);
    });
    this.#send({
      t: 'init',
      page: this.page,
      pageDir: this.pageDir,
      snapshotsDir: this.snapshotsDir,
      entry: this.entry,
      diskQuota: this.limits.pageDiskBytes,
    });
    this.#log('info', `worker started for version ${this.page.version} (pid ${child.pid})`);
    // An entry whose top-level await never settles would leave every call
    // waiting for a worker that never gets ready (while it still answers
    // pings): it gets as long as a handler gets to answer.
    this.#startTimer = setTimeout(() => this.#startTimeout(), this.limits.firstByteMs);
    this.#armIdle();
  }

  #startTimeout() {
    if (this.state !== 'starting') return;
    const ref = newRef();
    this.#log('error', `the backend entry did not finish loading within ${seconds(this.limits.firstByteMs)} (a top-level await that never settles?)`, ref);
    this.state = 'failed';
    this.#readyCb.reject(new RunnerError(500, 'backend-error', 'The backend failed to start.', ref));
    this.stop('it did not finish loading');
  }

  #send(msg, cb) {
    if (this.#child?.connected) return this.#child.send(msg, cb);
    cb?.();
    return false;
  }

  /**
   * Relays one /invoke to the handler and its response to res. Throws a
   * RunnerError when the request cannot be taken.
   */
  handle(inv, req, res) {
    if (res.destroyed) return; // the caller is gone already
    if (this.gone || this.state === 'draining') {
      throw new RunnerError(503, 'backend-unavailable', 'The backend worker is shutting down; retry.');
    }
    if (this.#calls.size >= this.limits.workerConcurrency) {
      throw new RunnerError(429, 'too-many-requests', `The backend is already handling ${this.limits.workerConcurrency} requests; retry later.`);
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > this.limits.maxBodyBytes) {
      throw new RunnerError(413, 'body-too-large', `The request body is larger than ${this.limits.maxBodyBytes} bytes.`);
    }
    const call = {
      id: this.#nextId++,
      inv,
      req,
      res,
      sent: false, // the worker knows about the call (and will send done)
      headSent: false,
      finished: false, // the HTTP response is complete, failed or abandoned
      settled: false, // the call no longer counts against the worker
      abortSent: false,
      bytes: 0,
      timers: [],
    };
    this.#calls.set(call.id, call);
    clearTimeout(this.#idleTimer);
    call.timers.push(setTimeout(() => this.#firstByteTimeout(call), this.limits.firstByteMs));
    call.timers.push(setTimeout(() => this.#totalTimeout(call), this.limits.requestMs));
    res.on('close', () => {
      // The client went away before the response was complete.
      if (!call.finished) {
        call.finished = true;
        this.#abort(call);
      }
    });
    this.#ready.then(
      () => this.#dispatch(call),
      (err) => this.#fail(call, err.status, err.code, err.message, err.ref),
    );
  }

  #dispatch(call) {
    if (call.finished || call.res.destroyed) {
      call.finished = true;
      this.#settle(call);
      return;
    }
    const { inv, req } = call;
    call.sent = true;
    this.#send({
      t: 'req',
      id: call.id,
      // Per call: the title changes when the page is renamed.
      page: inv.page,
      user: inv.user,
      role: inv.role,
      link: inv.link,
      secrets: inv.secrets,
      request: { method: inv.request.method, path: inv.request.path, headers: requestHeaders(inv.request.headers) },
    });
    const m = inv.request.method;
    if (m === 'GET' || m === 'HEAD') {
      req.resume(); // a body sent with them is ignored, as fetch would
      return;
    }
    let bytes = 0;
    req.on('data', (chunk) => {
      if (call.finished) return;
      bytes += chunk.length;
      if (bytes > this.limits.maxBodyBytes) {
        req.pause();
        call.res.shouldKeepAlive = false; // the rest of the body is never read
        this.#fail(call, 413, 'body-too-large', `The request body is larger than ${this.limits.maxBodyBytes} bytes.`);
        return;
      }
      // One chunk at a time over IPC: a fast client must not queue the whole
      // body in the runner's memory.
      req.pause();
      // Once the response is done, the rest of the body is read and dropped,
      // so the connection to specola stays usable.
      this.#send({ t: 'body', id: call.id, data: chunk }, () => req.resume());
    });
    req.on('end', () => {
      if (!call.finished) this.#send({ t: 'bodyEnd', id: call.id });
    });
  }

  #abort(call) {
    if (call.sent && !call.abortSent) {
      call.abortSent = true;
      this.#send({ t: 'abort', id: call.id });
    }
    if (!call.sent) this.#settle(call);
  }

  // Ends the call's HTTP response with a runner error (or cuts it, once the
  // handler's head was sent) and tells the handler to stop.
  #fail(call, status, code, message, ref) {
    if (call.finished) return;
    call.finished = true;
    sendError(call.res, status, code, message, ref);
    if (call.res.shouldKeepAlive) call.req.resume(); // see #dispatch
    this.#abort(call);
  }

  #settle(call) {
    if (call.settled) return;
    call.settled = true;
    for (const t of call.timers) clearTimeout(t);
    this.#calls.delete(call.id);
    if (this.#calls.size === 0) {
      if (this.state === 'draining') this.stop('drained');
      else this.#armIdle();
    }
  }

  #armIdle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      if (this.#calls.size === 0 && !this.gone) this.stop('idle');
    }, this.limits.idleMs);
    this.#idleTimer.unref();
  }

  #describe(call) {
    return `${call.inv.request.method} ${call.inv.request.path}`;
  }

  #firstByteTimeout(call) {
    if (call.headSent || call.finished) return;
    const ref = newRef();
    this.#log('error', `${this.#describe(call)}: no response within ${seconds(this.limits.firstByteMs)}; answered 504`, ref);
    this.#fail(call, 504, 'backend-timeout', `The backend did not respond within ${seconds(this.limits.firstByteMs)}.`, ref);
    this.#checkAlive();
  }

  #totalTimeout(call) {
    if (!call.finished) {
      const ref = newRef();
      this.#log('error', `${this.#describe(call)}: not finished within ${seconds(this.limits.requestMs)}; ${call.headSent ? 'response cut' : 'answered 504'}`, ref);
      this.#fail(call, 504, 'backend-timeout', `The backend did not finish within ${seconds(this.limits.requestMs)}.`, ref);
    } else if (call.sent) {
      this.#log('warn', `${this.#describe(call)}: work after the response (waitUntil) still running after ${seconds(this.limits.requestMs)}; no longer counted`);
    }
    this.#settle(call);
  }

  // A worker stuck in a busy loop answers nothing, ever: one that does not
  // even answer a ping is killed, so the next request gets a fresh one.
  #checkAlive() {
    if (this.#pingTimer || this.gone) return;
    this.#send({ t: 'ping' });
    this.#pingTimer = setTimeout(() => {
      this.#killReason = 'it stopped responding';
      this.#child?.kill('SIGKILL');
    }, Math.min(5000, this.limits.firstByteMs));
  }

  // Page code can call process.send itself, so a message is input, not
  // trusted: a bad one fails its request, never the runner.
  #onMessage(m) {
    try {
      this.#handleMessage(m);
    } catch (err) {
      const ref = newRef();
      this.#log('error', `the worker sent an invalid message (${err.message})`, ref);
      const call = this.#calls.get(m?.id);
      if (call) this.#fail(call, 500, 'backend-error', 'The backend sent an invalid response.', ref);
    }
  }

  #handleMessage(m) {
    if (m === null || typeof m !== 'object') throw new TypeError('not an object');
    if (m.t === 'log') {
      this.#log(m.level, m.text, m.ref);
      return;
    }
    if (m.t === 'ready') {
      clearTimeout(this.#startTimer);
      if (this.state === 'starting') this.state = 'ready';
      this.#readyCb.resolve();
      return;
    }
    if (m.t === 'fatal') {
      clearTimeout(this.#startTimer);
      this.state = 'failed';
      this.#readyCb.reject(new RunnerError(500, 'backend-error', 'The backend failed to start.', m.ref));
      this.stop('the backend failed to start');
      return;
    }
    if (m.t === 'pong') {
      clearTimeout(this.#pingTimer);
      this.#pingTimer = null;
      return;
    }
    const call = this.#calls.get(m.id);
    if (!call) return;
    const ack = () => this.#send({ t: 'ack', id: call.id });
    switch (m.t) {
      case 'head': {
        if (call.finished) return;
        const { res } = call;
        if (!Number.isInteger(m.status) || m.status < 200 || m.status > 599) throw new RangeError(`status ${m.status}`);
        if (!Array.isArray(m.headers)) throw new TypeError('headers');
        for (const [k, v] of responseHeaders(m.headers)) res.appendHeader(String(k), String(v));
        res.statusCode = m.status;
        res.flushHeaders();
        call.headSent = true;
        break;
      }
      case 'chunk': {
        if (call.finished) {
          ack();
          return;
        }
        if (!(m.data instanceof Uint8Array)) throw new TypeError('chunk is not bytes');
        call.bytes += m.data.length;
        if (call.bytes > this.limits.maxResponseBytes) {
          const ref = newRef();
          this.#log('error', `${this.#describe(call)}: response larger than ${this.limits.maxResponseBytes} bytes; cut`, ref);
          this.#fail(call, 500, 'backend-error', 'The response is too large.', ref);
          return;
        }
        if (call.res.write(m.data)) ack();
        else call.res.once('drain', ack);
        break;
      }
      case 'end':
        if (!call.finished) {
          call.finished = true;
          call.res.end();
          call.req.resume(); // see #dispatch
        }
        break;
      case 'fail':
        // Whatever the worker says, the page gets the documented error.
        this.#fail(call, 500, 'backend-error', 'The backend failed to handle the request.', typeof m.ref === 'string' ? m.ref.slice(0, 32) : undefined);
        break;
      case 'done':
        this.#settle(call);
        break;
    }
  }

  #onExit(code, signal) {
    const wasStopping = this.#stopping;
    this.state = this.state === 'failed' ? 'failed' : 'stopped';
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#pingTimer);
    clearTimeout(this.#startTimer);
    let ref;
    if (!wasStopping || this.#calls.size > 0) {
      ref = newRef();
      const oom = /heap out of memory|Allocation failed/.test(this.#stderrTail);
      const why = this.#killReason ?? (oom ? `it ran out of memory (${this.limits.workerMemoryMb} MiB)` : signal ? `signal ${signal}` : `exit code ${code}`);
      this.#log('error', `worker crashed: ${why}; ${this.#calls.size} request(s) in flight answered 502`, ref);
    }
    this.#readyCb.reject(new RunnerError(502, 'backend-crashed', 'The backend crashed while starting.', ref));
    for (const call of [...this.#calls.values()]) {
      if (!call.finished) {
        call.finished = true;
        sendError(call.res, 502, 'backend-crashed', 'The backend crashed.', ref);
      }
      this.#settle(call);
    }
    this.onGone?.(this);
  }

  /** Stops taking requests; stops once those in flight are done. */
  drain() {
    if (this.gone) return;
    this.state = 'draining';
    this.#log('info', `worker for version ${this.page.version} draining (${this.#calls.size} request(s) in flight)`);
    if (this.#calls.size === 0) this.stop('drained');
  }

  /** Stops the process: gracefully, then by force. */
  stop(reason) {
    if (this.#stopping || !this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#stopping = true;
    if (this.state !== 'failed') this.state = 'stopped';
    this.#log('info', `worker for version ${this.page.version} stopped (${reason})`);
    const child = this.#child;
    this.#send({ t: 'stop' });
    const t = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    t.unref();
    child.once('exit', () => clearTimeout(t));
    this.onGone?.(this);
  }

  /** Resolves once the process has exited. */
  exited() {
    const c = this.#child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
    return new Promise((r) => c.once('exit', r));
  }
}
