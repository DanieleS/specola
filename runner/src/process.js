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

// Identifies a worker to the egress proxy (its credential's user, w-<id>).
// Unique within the runner process, which is the proxy's lifetime.
let nextWorkerId = 1;

const JOB_STATUSES = new Set(['ok', 'no-handler', 'error']);

// Only the secrets the version's manifest declares reach its code. Specola
// sends only those already; this keeps it so whatever specola sends.
function declaredSecrets(secrets, names) {
  const out = {};
  if (!names) return out;
  for (const n of names) {
    if (typeof n === 'string' && Object.hasOwn(secrets ?? {}, n) && typeof secrets[n] === 'string') out[n] = secrets[n];
  }
  return out;
}

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
  #forgets = new Map(); // id → resolve, for forgetUser
  #nextForget = 1;
  #jobs = new Map(); // id → a scheduled run (ids shared with #calls)

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
   * @param {{register: Function, unregister: Function} | null} [o.proxy]
   *   the egress proxy (egress.js); null: outbound HTTP is not proxied
   *   (tests of other things only, the runner always has one)
   * @param {string[]} [o.egress] the version's egress list, from the head
   * @param {string[]} [o.secretNames] the secrets the version declares
   * @param {(pageId: string, m: object) => void} [o.onPublish] a ctx.publish
   */
  constructor({ page, codeDir, entry, pageDir, snapshotsDir, limits, logs, onGone, proxy = null, egress = [], secretNames = [], onPublish }) {
    Object.assign(this, { page, codeDir, entry, pageDir, snapshotsDir, limits, logs, onGone, proxy, egress, secretNames, onPublish });
    this.id = nextWorkerId++;
    this.state = 'new'; // new → starting → ready → (draining) → stopped; or failed
    this.#ready = new Promise((resolve, reject) => {
      this.#readyCb = { resolve, reject };
    });
    this.#ready.catch(() => {});
  }

  get version() {
    return this.page.version;
  }

  /** Requests and scheduled runs that count against the worker. */
  get inflight() {
    return this.#calls.size + this.#jobs.size;
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
      // Node 22 says, on stderr (so in the backend log as an error), that
      // the agent behind NODE_USE_ENV_PROXY is experimental, at the first
      // fetch of every worker.
      '--disable-warning=UNDICI-EHPA',
    ];
    // A minimal environment: nothing of the runner's (its token above all)
    // reaches page code.
    const env = { TZ: 'UTC', NODE_ENV: 'production', LANG: 'C.UTF-8' };
    if (this.proxy) {
      // The global fetch goes through the egress proxy ("Egress proxy (step
      // 3)"): NODE_USE_ENV_PROXY makes it honour HTTP(S)_PROXY (Node ≥
      // 22.21 and 24; checked by the tests), and the credential tells the
      // proxy which page, and so which egress list, a connection is for.
      // NO_PROXY empty: nothing bypasses it, localhost included.
      const { user, token } = this.proxy.register(this.id, this.page.id, this.egress);
      const url = `http://${encodeURIComponent(user)}:${token}@127.0.0.1:${this.proxy.port}`;
      Object.assign(env, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: '' });
    }
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
    if (this.inflight >= this.limits.workerConcurrency) {
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
      visitor: inv.visitor ?? null,
      secrets: declaredSecrets(inv.secrets, this.secretNames),
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

  /**
   * Runs the entry's scheduled(event, ctx) for one /scheduled (the head is
   * inv, with inv.event). Resolves with the answer, {status, ref?}: "ok",
   * "no-handler", "error" (the handler threw, the backend failed to start
   * or crashed; ref names the log line) or "timeout" (still running after
   * the cron limit; it no longer counts against the worker then, as work
   * after a response does not). Throws a RunnerError when the run cannot
   * be taken at all.
   */
  runJob(inv) {
    if (this.gone || this.state === 'draining') {
      throw new RunnerError(503, 'backend-unavailable', 'The backend worker is shutting down; retry.');
    }
    if (this.inflight >= this.limits.workerConcurrency) {
      throw new RunnerError(429, 'too-many-requests', `The backend is already handling ${this.limits.workerConcurrency} requests; retry later.`);
    }
    let resolve;
    const answer = new Promise((r) => (resolve = r));
    const job = { id: this.#nextId++, inv, resolve, answered: false, settled: false, started: Date.now(), timer: null };
    this.#jobs.set(job.id, job);
    clearTimeout(this.#idleTimer);
    job.timer = setTimeout(() => this.#jobTimeout(job), this.limits.cronMs);
    this.#ready.then(
      () => {
        if (job.answered) return;
        this.#send({
          t: 'job',
          id: job.id,
          page: inv.page,
          secrets: declaredSecrets(inv.secrets, this.secretNames),
          event: { name: inv.event.name, scheduledTime: inv.event.scheduledTime },
        });
      },
      (err) => {
        this.#answerJob(job, { status: 'error', ...(err.ref ? { ref: err.ref } : {}) });
        this.#settleJob(job);
      },
    );
    return answer;
  }

  // Answers the /scheduled once, and puts the outcome in the backend log
  // ("Observability": cron outcomes). An error's stack is in the line the
  // worker logged under the ref.
  #answerJob(job, result) {
    if (job.answered) return;
    job.answered = true;
    const name = JSON.stringify(job.inv.event.name);
    const took = `${Date.now() - job.started} ms`;
    switch (result.status) {
      case 'ok':
        this.#log('info', `scheduled job ${name}: ok (${took})`);
        break;
      case 'no-handler':
        this.#log('warn', `scheduled job ${name}: the backend has no scheduled handler (its default export needs a scheduled(event, ctx) method)`);
        break;
      case 'error':
        this.#log('error', `scheduled job ${name}: failed (${took})`);
        break;
      // timeout: logged where it is decided, with its ref
    }
    job.resolve(result);
  }

  #settleJob(job) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    this.#jobs.delete(job.id);
    this.#maybeIdle();
  }

  #jobTimeout(job) {
    if (!job.answered) {
      const ref = newRef();
      this.#log('error', `scheduled job ${JSON.stringify(job.inv.event.name)}: not finished within ${seconds(this.limits.cronMs)}; no longer waited for`, ref);
      this.#answerJob(job, { status: 'timeout', ref });
      // One stuck in a busy loop blocks every call of the page: a worker
      // that does not even answer a ping is killed.
      this.#checkAlive();
    } else {
      this.#log('warn', `scheduled job ${JSON.stringify(job.inv.event.name)}: work after it (waitUntil) still running after ${seconds(this.limits.cronMs)}; no longer counted`);
    }
    this.#settleJob(job);
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
    this.#maybeIdle();
  }

  // Once nothing is in flight: a draining worker stops, another starts its
  // idle countdown.
  #maybeIdle() {
    if (this.inflight === 0) {
      if (this.state === 'draining') this.stop('drained');
      else this.#armIdle();
    }
  }

  #armIdle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      if (this.inflight === 0 && !this.gone) this.stop('idle');
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
      const job = this.#jobs.get(m?.id);
      if (job) this.#answerJob(job, { status: 'error', ref });
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
    if (m.t === 'forgot') {
      const done = this.#forgets.get(m.fid);
      done?.();
      return;
    }
    if (m.t === 'pong') {
      clearTimeout(this.#pingTimer);
      this.#pingTimer = null;
      return;
    }
    if (m.t === 'publish') {
      // Checked by the publisher: page code may send anything here.
      this.onPublish?.(this.page.id, { topic: m.topic, data: m.data, to: m.to });
      return;
    }
    const job = this.#jobs.get(m.id);
    if (job) {
      if (m.t === 'jobEnd') {
        if (!JOB_STATUSES.has(m.status)) throw new TypeError(`job status ${m.status}`);
        this.#answerJob(job, { status: m.status, ...(typeof m.ref === 'string' ? { ref: m.ref.slice(0, 32) } : {}) });
      } else if (m.t === 'done') {
        // The handler and its waitUntil work are over.
        if (!job.answered) this.#answerJob(job, { status: 'ok' });
        this.#settleJob(job);
      }
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
    this.proxy?.unregister(this.id);
    let ref;
    if (!wasStopping || this.inflight > 0) {
      ref = newRef();
      const oom = /heap out of memory|Allocation failed/.test(this.#stderrTail);
      const why = this.#killReason ?? (oom ? `it ran out of memory (${this.limits.workerMemoryMb} MiB)` : signal ? `signal ${signal}` : `exit code ${code}`);
      const jobs = this.#jobs.size ? ` and ${this.#jobs.size} scheduled run(s) answered error` : '';
      this.#log('error', `worker crashed: ${why}; ${this.#calls.size} request(s) in flight answered 502${jobs}`, ref);
    }
    this.#readyCb.reject(new RunnerError(502, 'backend-crashed', 'The backend crashed while starting.', ref));
    for (const call of [...this.#calls.values()]) {
      if (!call.finished) {
        call.finished = true;
        sendError(call.res, 502, 'backend-crashed', 'The backend crashed.', ref);
      }
      this.#settle(call);
    }
    for (const job of [...this.#jobs.values()]) {
      this.#answerJob(job, { status: 'error', ...(ref ? { ref } : {}) });
      this.#settleJob(job);
    }
    for (const done of [...this.#forgets.values()]) done();
    this.onGone?.(this);
  }

  /**
   * Tells the worker to close a user's database (users/<name>.sqlite) and
   * delete it, in one step so that no call reopens it in between ("Delete
   * my data"). A call of that user in flight loses its handle; that is the
   * user deleting their data while using it. Resolves once done; a worker
   * that does not answer in time is killed (it might keep writing to the
   * deleted file and bring the data back on its next open otherwise).
   */
  forgetUser(name) {
    if (this.gone || !this.#child?.connected) return Promise.resolve();
    const fid = this.#nextForget++;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#killReason = 'it did not close a user\'s database in time';
        this.#child?.kill('SIGKILL');
        finish();
      }, Math.min(5000, this.limits.firstByteMs));
      const finish = () => {
        clearTimeout(t);
        this.#forgets.delete(fid);
        resolve();
      };
      this.#forgets.set(fid, finish);
      this.#send({ t: 'forget', fid, name });
    });
  }

  /** Stops taking requests; stops once those in flight are done. */
  drain() {
    if (this.gone) return;
    this.state = 'draining';
    this.#log('info', `worker for version ${this.page.version} draining (${this.inflight} request(s) in flight)`);
    if (this.inflight === 0) this.stop('drained');
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
