// The page worker: one process per page, running the backend of the page's
// current version (docs/page-backends.md, "Runner" and "Handler contract").
// The runner forks it with Node's permission model on and talks to it over
// the IPC channel (advanced serialization, so bytes travel as Uint8Array):
//
//   runner → worker  init, req, body, bodyEnd, abort, ack, ping, forget, stop,
//                    job (a scheduled run)
//   worker → runner  ready, fatal, head, chunk, end, fail, done, log, pong, forgot,
//                    jobEnd (a scheduled run's outcome; done follows once its
//                    waitUntil work is over), publish (ctx.publish)
//
// Bodies stream chunk by chunk in both directions. Response chunks are
// acknowledged by the runner once its HTTP response took them, so a slow
// client slows the handler down instead of filling the worker's memory.
// This file runs inside page workers: it must only import node: modules
// and the files next to it (the only runner files the worker may read).

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatWithOptions } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { FileStore } from './files.mjs';
import { PageQuota } from './quota.mjs';

const WINDOW = 8; // response chunks in flight before waiting for an ack
const PIECE = 64 * 1024; // IPC message size for response bytes
const MAX_LINE = 16 * 1024;
// ctx.publish ("Realtime push (step 4)"): the runner checks these again.
const TOPIC = /^[A-Za-z0-9_.:/-]{1,128}$/;
const MAX_PUSH_DATA = 7 * 1024;
// A public link visitor's own database (docs/page-apps.md, "Anonymous
// visitors") stops growing here: anyone holding the link can be a visitor.
const VISITOR_DB_BYTES = 16 * 1024 * 1024;

const send = (msg) => {
  if (process.connected) process.send(msg);
};

const newRef = () => randomBytes(5).toString('hex');

// --- backend log ----------------------------------------------------------

function log(level, args, ref) {
  let text = formatWithOptions({ colors: false, depth: 4 }, ...args);
  if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE) + '… (truncated)';
  send({ t: 'log', level, text, ...(ref ? { ref } : {}) });
}

for (const [name, level] of [['log', 'log'], ['info', 'info'], ['debug', 'log'], ['warn', 'warn'], ['error', 'error'], ['trace', 'log']]) {
  console[name] = (...args) => log(level, args);
}

function logError(prefix, err) {
  const ref = newRef();
  const detail = err instanceof Error ? err.stack || String(err) : formatWithOptions({ depth: 4 }, err);
  log('error', [`${prefix}: ${detail}`], ref);
  return ref;
}

process.on('uncaughtException', (err) => logError('uncaught exception', err));
process.on('unhandledRejection', (err) => logError('unhandled promise rejection', err));
process.on('disconnect', () => process.exit(0)); // the runner is gone

// --- state ----------------------------------------------------------------

let page; // {id, version, title}
let pageDir;
let snapshotsDir;
let diskQuota;
let quota;
let handler;
let sharedDb = null;
const userDbs = new Map();
let files = null;
const calls = new Map();

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL: readers (snapshots, the draining worker) never block the writer.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  quota.track(db);
  return db;
}

// A visitor's subject: never an OIDC sub, and what Specola names it by to
// delete its data.
const visitorSub = (id) => 'anon:' + id;

function userDbFor(sub) {
  let db = userDbs.get(sub);
  if (!db) {
    const name = createHash('sha256').update(sub).digest('hex');
    db = openDb(path.join(pageDir, 'users', `${name}.sqlite`));
    if (sub.startsWith('anon:')) {
      const pageSize = db.prepare('PRAGMA page_size').get().page_size;
      db.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(VISITOR_DB_BYTES / pageSize))}`);
    }
    userDbs.set(sub, db);
  }
  return db;
}

// "Delete my data": closes the user's database and deletes its files in one
// synchronous step, so no call can reopen it in between. The name is the
// runner's (sha256 hex of the sub), checked anyway since it becomes a path.
function forgetUser(name) {
  if (!/^[0-9a-f]{64}$/.test(name)) return;
  for (const [sub, db] of userDbs) {
    if (createHash('sha256').update(sub).digest('hex') !== name) continue;
    try {
      db.close();
    } catch {
      // closed by the handler already
    }
    userDbs.delete(sub);
  }
  const file = path.join(pageDir, 'users', `${name}.sqlite`);
  for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + s, { force: true });
}

function closeAll() {
  for (const db of [sharedDb, ...userDbs.values()]) {
    try {
      db?.close();
    } catch {
      // already closed by the handler
    }
  }
  files?.close();
}

// Routes the backend's own `import 'node:sqlite'` (and getBuiltinModule) to
// the guard that keeps database paths inside the page directory.
function installSqliteGuard(dir) {
  globalThis[Symbol.for('specola.pageDir')] = dir;
  // Databases the backend opens itself count against the quota too.
  globalThis[Symbol.for('specola.trackDb')] = (db) => quota.track(db);
  const guardURL = new URL('./sqlite-guard.mjs', import.meta.url).href;
  if (typeof module.registerHooks === 'function') {
    module.registerHooks({
      resolve(specifier, context, next) {
        if ((specifier === 'node:sqlite' || specifier === 'sqlite') && context.parentURL !== guardURL) {
          return { url: guardURL, format: 'module', shortCircuit: true };
        }
        return next(specifier, context);
      },
    });
  }
  return guardURL;
}

// --- init -----------------------------------------------------------------

async function init(msg) {
  page = msg.page;
  pageDir = msg.pageDir;
  snapshotsDir = msg.snapshotsDir;
  diskQuota = msg.diskQuota;
  fs.mkdirSync(pageDir, { recursive: true });
  quota = new PageQuota(pageDir, diskQuota, (text) => log('warn', [text]), snapshotsDir);
  await quota.refresh();
  const guardURL = installSqliteGuard(pageDir);
  const guard = await import(guardURL);
  const getBuiltin = process.getBuiltinModule?.bind(process);
  if (getBuiltin) {
    process.getBuiltinModule = (id) => (id === 'node:sqlite' || id === 'sqlite' ? guard : getBuiltin(id));
  }
  let mod;
  try {
    mod = await import(pathToFileURL(msg.entry).href);
  } catch (err) {
    send({ t: 'fatal', ref: logError('loading the backend failed', err) });
    return;
  }
  const h = mod.default;
  // Either handler is optional ("Handler contract"), not both.
  if (!h || (typeof h.fetch !== 'function' && typeof h.scheduled !== 'function')) {
    const ref = newRef();
    log('error', ['the backend entry has no handler: its default export must be an object with a fetch(request, ctx) or a scheduled(event, ctx) method'], ref);
    send({ t: 'fatal', ref });
    return;
  }
  handler = h;
  send({ t: 'ready' });
}

// --- ctx.publish ----------------------------------------------------------

// Checks a push and hands it to the runner, which queues it: the handler
// never waits for delivery. A bad push is the code's mistake, said at once
// with a TypeError; one dropped later (over the page's rate, specola
// refusing it) only gets a line in the backend log, since delivery is best
// effort.
function publish(topic, data, opts) {
  if (typeof topic !== 'string' || !TOPIC.test(topic)) {
    throw new TypeError(`ctx.publish: the topic must be 1 to 128 letters, digits, _, ., :, / or -; got ${typeof topic === 'string' ? JSON.stringify(topic.slice(0, 200)) : typeof topic}`);
  }
  if (opts !== undefined && opts !== null && typeof opts !== 'object') {
    throw new TypeError('ctx.publish: the options must be an object ({to})');
  }
  const to = opts?.to ?? undefined;
  if (to !== undefined && (typeof to !== 'string' || to === '')) {
    throw new TypeError('ctx.publish: to must be a user\'s sub (a non-empty string)');
  }
  let json;
  try {
    json = JSON.stringify(data);
  } catch (err) {
    throw new TypeError(`ctx.publish: the data is not JSON-serialisable (${err.message})`);
  }
  if (json === undefined) {
    throw new TypeError(`ctx.publish: the data is not JSON-serialisable (${typeof data})`);
  }
  const size = Buffer.byteLength(json);
  if (size > MAX_PUSH_DATA) {
    throw new TypeError(`ctx.publish: the data is ${size} bytes serialised; at most ${MAX_PUSH_DATA}`);
  }
  send({ t: 'publish', topic, data: json, ...(to !== undefined ? { to } : {}) });
}

// --- requests -------------------------------------------------------------

function makeCtx(msg, call) {
  const user = msg.user ? Object.freeze({ sub: msg.user.sub, email: msg.user.email, name: msg.user.name }) : null;
  const visitor = msg.visitor ? Object.freeze({ id: msg.visitor.id }) : null;
  const ctx = {
    user,
    role: msg.role,
    link: msg.link ? Object.freeze({ id: msg.link.id, label: msg.link.label }) : null,
    visitor,
    page: Object.freeze({ ...(msg.page ?? page) }),
    get db() {
      sharedDb ??= openDb(path.join(pageDir, 'shared.sqlite'));
      return sharedDb;
    },
    get userDb() {
      if (user) return userDbFor(user.sub);
      return visitor ? userDbFor(visitorSub(visitor.id)) : null;
    },
    get files() {
      files ??= new FileStore(pageDir, diskQuota, snapshotsDir);
      return files;
    },
    // Only the names the version declares: the runner filtered them.
    secrets: Object.freeze({ ...(msg.secrets ?? {}) }),
    publish(topic, data, opts) {
      publish(topic, data, opts);
    },
    waitUntil(p) {
      call.waits.push(Promise.resolve(p).catch((err) => logError('a waitUntil promise rejected', err)));
    },
    log: console,
  };
  return ctx;
}

function buildRequest(msg, call) {
  const headers = new Headers();
  for (const [k, v] of msg.request.headers) {
    try {
      headers.append(k, v);
    } catch {
      // a header the platform refuses: drop it rather than the request
    }
  }
  const method = msg.request.method;
  let body = null;
  if (method !== 'GET' && method !== 'HEAD') {
    body = new ReadableStream({
      start(controller) {
        call.body = controller;
      },
    });
  }
  // Concatenated, not resolved: a path like //host must stay a path.
  return new Request('https://page.invalid' + msg.request.path, {
    method,
    headers,
    body,
    duplex: 'half',
    signal: call.abort.signal,
  });
}

function credit(call) {
  if (call.unacked < WINDOW || call.aborted) return null;
  return new Promise((resolve) => {
    call.onAck = resolve;
  });
}

async function streamBody(call, body) {
  const reader = body.getReader();
  call.reader = reader;
  for (;;) {
    if (call.aborted) {
      reader.cancel(call.abort.signal.reason).catch(() => {});
      return;
    }
    const { done, value } = await reader.read();
    if (done || call.aborted) {
      if (!done) reader.cancel(call.abort.signal.reason).catch(() => {});
      return;
    }
    let bytes = value;
    if (typeof bytes === 'string') bytes = new TextEncoder().encode(bytes);
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('the response body stream produced a chunk that is not a Uint8Array');
    }
    for (let off = 0; off < bytes.length; off += PIECE) {
      await credit(call);
      if (call.aborted) break;
      call.unacked++;
      send({ t: 'chunk', id: call.id, data: bytes.subarray(off, off + PIECE) });
    }
  }
}

async function handle(msg) {
  const call = { id: msg.id, abort: new AbortController(), aborted: false, unacked: 0, onAck: null, body: null, waits: [] };
  calls.set(msg.id, call);
  try {
    await respond(msg, call);
  } finally {
    // waitUntil may add promises while earlier ones run
    for (let n = 0; n < call.waits.length; n = call.waits.length) await Promise.all(call.waits.slice(n));
    calls.delete(msg.id);
    send({ t: 'done', id: msg.id });
    quota.refresh().catch((err) => logError('measuring the page\'s disk use failed', err));
  }
}

async function respond(msg, call) {
  if (typeof handler.fetch !== 'function') {
    const ref = newRef();
    log('error', [`${msg.request.method} ${msg.request.path}: the backend has no fetch handler (its default export has only scheduled)`], ref);
    send({ t: 'fail', id: call.id, status: 500, code: 'backend-error', message: 'The backend has no fetch handler.', ref });
    return;
  }
  let response;
  try {
    const request = buildRequest(msg, call);
    response = await handler.fetch(request, makeCtx(msg, call));
  } catch (err) {
    if (call.aborted && err?.name === 'AbortError') return;
    const ref = logError(`${msg.request.method} ${msg.request.path} failed`, err);
    send({ t: 'fail', id: call.id, status: 500, code: 'backend-error', message: 'The backend failed to handle the request.', ref });
    return;
  }
  if (!(response instanceof Response)) {
    const ref = newRef();
    const got = response === null ? 'null' : typeof response === 'object' ? `an object (${response.constructor?.name ?? 'Object'})` : typeof response;
    log('error', [`${msg.request.method} ${msg.request.path}: the fetch handler returned ${got}, not a Response`], ref);
    send({ t: 'fail', id: call.id, status: 500, code: 'backend-error', message: 'The backend did not return a Response.', ref });
    return;
  }
  if (call.aborted) {
    response.body?.cancel().catch(() => {});
    return;
  }
  send({ t: 'head', id: call.id, status: response.status, headers: [...response.headers] });
  if (response.body && msg.request.method !== 'HEAD') {
    try {
      await streamBody(call, response.body);
    } catch (err) {
      const ref = logError(`${msg.request.method} ${msg.request.path}: the response body failed`, err);
      send({ t: 'fail', id: call.id, status: 500, code: 'backend-error', message: 'The response body failed.', ref });
      return;
    }
  }
  if (!call.aborted) send({ t: 'end', id: call.id });
}

// --- scheduled runs -------------------------------------------------------

// One scheduled(event, ctx) ("Scheduled jobs (step 5)"): as the cron, with
// no user. The outcome goes to the runner as soon as the handler settles;
// done follows once its waitUntil work is over, as for a request.
async function runJob(msg) {
  const call = { id: msg.id, waits: [] };
  const name = String(msg.event?.name);
  let outcome = { status: 'ok' };
  try {
    if (typeof handler.scheduled !== 'function') {
      outcome = { status: 'no-handler' };
    } else {
      const ctx = makeCtx({ page: msg.page, user: null, role: 'cron', link: null, secrets: msg.secrets }, call);
      const event = Object.freeze({ name, scheduledTime: msg.event.scheduledTime });
      await handler.scheduled(event, ctx);
    }
  } catch (err) {
    outcome = { status: 'error', ref: logError(`scheduled job ${JSON.stringify(name)} failed`, err) };
  }
  send({ t: 'jobEnd', id: msg.id, ...outcome });
  try {
    for (let n = 0; n < call.waits.length; n = call.waits.length) await Promise.all(call.waits.slice(n));
  } finally {
    send({ t: 'done', id: msg.id });
    quota.refresh().catch((err) => logError('measuring the page\'s disk use failed', err));
  }
}

function onMessage(msg) {
  const call = msg.id === undefined ? null : calls.get(msg.id);
  switch (msg.t) {
    case 'init':
      init(msg).catch((err) => send({ t: 'fatal', ref: logError('starting the worker failed', err) }));
      break;
    case 'req':
      handle(msg);
      break;
    case 'job':
      runJob(msg);
      break;
    case 'body':
      try {
        call?.body?.enqueue(msg.data);
      } catch {
        // the handler cancelled the body
      }
      break;
    case 'bodyEnd':
      try {
        call?.body?.close();
      } catch {
        // the handler cancelled the body
      }
      break;
    case 'abort':
      if (call && !call.aborted) {
        call.aborted = true;
        const reason = new DOMException('The request was aborted.', 'AbortError');
        call.abort.abort(reason);
        try {
          call.body?.error(reason);
        } catch {
          // body already closed
        }
        // A read pending on a quiet stream would wait forever.
        call.reader?.cancel(reason).catch(() => {});
        call.onAck?.();
      }
      break;
    case 'ack':
      if (call) {
        call.unacked--;
        const wake = call.onAck;
        call.onAck = null;
        wake?.();
      }
      break;
    case 'ping':
      send({ t: 'pong' });
      break;
    case 'forget':
      try {
        forgetUser(msg.name);
      } catch (err) {
        logError('deleting a user\'s data failed', err);
      }
      send({ t: 'forgot', fid: msg.fid });
      break;
    case 'stop':
      closeAll();
      process.exit(0);
  }
}

process.on('message', onMessage);
