// The runner's HTTP API, called by specola only (docs/page-backends.md,
// "specola ↔ runner (internal)" and "Wire formats (exact)"):
//
//   POST /invoke   run a page's fetch handler (head in X-Specola-Invoke)
//   GET  /logs     a page's backend log
//   GET  /health   liveness, for specola's "available"
//   /pages/{id}/…  the page's data: snapshots, restore, export, import,
//                  wipe, my data, purge ("Wire formats for data (exact)")
//
// Every endpoint requires the shared bearer token.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { CodeCache } from './code.js';
import { RunnerError, sendError, sendJSON } from './errors.js';
import { Logs } from './log.js';
import { Pages } from './pages.js';
import { SNAPSHOT_ID, sweepSnapshots } from './snapshot.js';

export const RUNNER_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/; // an HTTP method
const ROLES = new Set(['owner', 'editor', 'viewer', 'public', 'cron']);
// Specola caps the encoded X-Specola-Invoke at 48 KiB; Node's default
// header limit (16 KiB) would cut a call with large headers first.
const MAX_INVOKE_HEADER = 48 * 1024;
const MAX_HEADER_SIZE = 64 * 1024;
const MAX_JSON_BODY = 64 * 1024;
// How long specola lets an export, an import or "my data" take (its
// transferCall); a request body may take as long.
const TRANSFER_MS = 2 * 60 * 60 * 1000;
const PAGE_ROUTE = /^\/pages\/([^/]+)(?:\/(data|snapshots|export|import|wipe|my-data)(?:\/([^/]+)(\/restore)?)?)?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string';

/** Decodes and validates the X-Specola-Invoke header. Throws a 400 RunnerError. */
export function parseInvoke(header) {
  const bad = (why) => new RunnerError(400, 'bad-request', `X-Specola-Invoke: ${why}`);
  if (!header) throw bad('missing');
  if (header.length > MAX_INVOKE_HEADER) throw bad('too large');
  let inv;
  try {
    inv = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    throw bad('not base64url JSON');
  }
  if (!isObject(inv)) throw bad('not an object');
  const { page, user, link, request } = inv;
  if (!isObject(page) || !isString(page.id) || !ID.test(page.id)) throw bad('page.id is invalid');
  if (!Number.isSafeInteger(page.version) || page.version < 1) throw bad('page.version is invalid');
  if (!isString(page.title)) throw bad('page.title is invalid');
  if (!isString(inv.versionId) || !ID.test(inv.versionId)) throw bad('versionId is invalid');
  if (!isString(inv.codeHash) || !HASH.test(inv.codeHash)) throw bad('codeHash is invalid');
  if (user !== null && !(isObject(user) && isString(user.sub) && user.sub !== '' && isString(user.email) && isString(user.name))) {
    throw bad('user is invalid');
  }
  if (!ROLES.has(inv.role)) throw bad('role is invalid');
  if ((inv.role === 'public' || inv.role === 'cron') !== (user === null)) throw bad('user and role disagree');
  if (link != null && !(isObject(link) && isString(link.id) && isString(link.label))) throw bad('link is invalid');
  const secrets = inv.secrets ?? {};
  if (!isObject(secrets) || !Object.values(secrets).every(isString)) throw bad('secrets is invalid');
  const egress = inv.egress ?? [];
  if (!Array.isArray(egress) || !egress.every(isString)) throw bad('egress is invalid');
  if (!isObject(request) || !isString(request.method) || !TOKEN.test(request.method)) throw bad('request.method is invalid');
  if (!isString(request.path) || !request.path.startsWith('/')) throw bad('request.path is invalid');
  if (!Array.isArray(request.headers) || !request.headers.every((h) => Array.isArray(h) && h.length === 2 && isString(h[0]) && isString(h[1]))) {
    throw bad('request.headers is invalid');
  }
  return {
    page: { id: page.id, version: page.version, title: page.title },
    versionId: inv.versionId,
    codeHash: inv.codeHash,
    user: user && { sub: user.sub, email: user.email, name: user.name },
    role: inv.role,
    link: link ? { id: link.id, label: link.label } : null,
    secrets,
    egress,
    request: { method: request.method.toUpperCase(), path: request.path, headers: request.headers },
  };
}

const badRequest = (message) => new RunnerError(400, 'bad-request', message);

/** Reads a small JSON object body. Throws 400 bad-request. */
async function readJSON(req) {
  const parts = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_JSON_BODY) throw badRequest('The body is too large.');
    parts.push(c);
  }
  let v;
  try {
    v = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw badRequest('The body is not JSON.');
  }
  if (!isObject(v)) throw badRequest('The body is not a JSON object.');
  return v;
}

/** The caller's sub, for my-data. Throws 400 bad-request. */
function subOf(req) {
  const sub = req.headers['x-specola-sub'];
  if (typeof sub !== 'string' || sub === '') throw badRequest('X-Specola-Sub is required.');
  return sub;
}

// The page's current version as specola has it (X-Specola-Version), or
// null when not said. Throws 400 bad-request.
function versionOf(req) {
  const v = req.headers['x-specola-version'];
  if (v === undefined) return null;
  if (typeof v !== 'string' || !/^[0-9]{1,15}$/.test(v)) throw badRequest('X-Specola-Version is invalid.');
  return Number(v);
}

// The page as specola has it, for an export's manifest: ?title= and
// ?version= (empty: its current version has none), each when given.
function aboutOf(req) {
  const q = new URL(req.url, 'http://runner.invalid').searchParams;
  const about = {};
  if (q.has('title')) about.title = q.get('title');
  if (q.has('version')) {
    const v = q.get('version');
    if (v !== '' && !/^[0-9]{1,15}$/.test(v)) throw badRequest('version is invalid.');
    about.version = v === '' ? null : Number(v);
  }
  return about;
}

// The /pages/{id}/… routes. The page id and the snapshot id are checked
// against their exact forms before anything becomes a path.
async function pageRoute(pages, m, req, res, allow) {
  const [, id, what, sid, restore] = m;
  if (!ID.test(id)) throw badRequest('The page id is invalid.');
  if (sid !== undefined && (what !== 'snapshots' || !SNAPSHOT_ID.test(sid))) {
    if (what !== 'snapshots') return notFound(req, res);
    throw badRequest('The snapshot id is invalid.');
  }
  switch (what) {
    case undefined:
      if (!allow('DELETE')) return;
      await pages.purge(id);
      return noContent(req, res);
    case 'data':
      if (allow('GET')) sendJSON(res, 200, await pages.data(id));
      return;
    case 'snapshots': {
      if (sid === undefined) {
        if (!allow('POST')) return;
        const body = await readJSON(req);
        if (body.kind !== 'manual') throw badRequest('kind must be "manual".');
        const label = body.label;
        if (typeof label !== 'string' || label.trim() === '' || [...label].length > 100 || CONTROL.test(label)) {
          throw badRequest('label must be 1 to 100 characters, without control characters.');
        }
        sendJSON(res, 201, await pages.createSnapshot(id, label));
        return;
      }
      if (restore) {
        if (!allow('POST')) return;
        req.resume();
        sendJSON(res, 200, await pages.restore(id, sid, versionOf(req)));
        return;
      }
      if (!allow('DELETE')) return;
      await pages.deleteSnapshot(id, sid);
      return noContent(req, res);
    }
    case 'export':
      if (!allow('GET')) return;
      req.resume();
      await pages.exportTo(id, res, aboutOf(req));
      return;
    case 'import':
      if (allow('PUT')) sendJSON(res, 200, await pages.importFrom(id, req));
      return;
    case 'wipe': {
      if (!allow('POST')) return;
      const { scope } = await readJSON(req);
      if (scope !== 'shared' && scope !== 'users') throw badRequest('scope must be "shared" or "users".');
      sendJSON(res, 200, await pages.wipe(id, scope));
      return;
    }
    case 'my-data': {
      if (req.method === 'GET') {
        req.resume();
        await pages.myDataTo(id, subOf(req), res);
        return;
      }
      if (!allow('DELETE', 'GET, DELETE')) return;
      await pages.deleteMyData(id, subOf(req));
      return noContent(req, res);
    }
  }
}

function noContent(req, res) {
  req.resume();
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function notFound(req, res) {
  sendError(res, 404, 'not-found', 'Not found.');
  req.resume();
}

/**
 * Builds the runner. `fetch` is what fetches code from specola (tests pass
 * their own); `now` is the clock of snapshots (tests move it).
 */
export function createRunner(config, { fetch: f, now } = {}) {
  const logs = new Logs();
  const code = new CodeCache({ dataDir: config.dataDir, specolaUrl: config.specolaUrl, token: config.token, fetch: f ?? fetch });
  const pages = new Pages({ config, code, logs, now });
  // Compared as digests: equal lengths for timingSafeEqual, whatever was sent.
  const expected = createHash('sha256').update(`Bearer ${config.token}`).digest();
  const authorized = (req) => {
    const got = createHash('sha256').update(req.headers.authorization ?? '').digest();
    return timingSafeEqual(got, expected);
  };

  async function route(req, res) {
    if (!authorized(req)) {
      sendError(res, 401, 'unauthorized', 'A valid runner token is required.');
      req.resume();
      return;
    }
    const url = new URL(req.url, 'http://runner.invalid');
    const allow = (method, all = method) => {
      if (req.method === method) return true;
      sendError(res, 405, 'method-not-allowed', `Use ${all}.`, undefined, { Allow: all });
      req.resume();
      return false;
    };
    switch (url.pathname) {
      case '/health':
        if (allow('GET')) sendJSON(res, 200, { ok: true, version: RUNNER_VERSION });
        return;
      case '/logs': {
        if (!allow('GET')) return;
        const page = url.searchParams.get('page') ?? '';
        const since = url.searchParams.get('since') ?? '0';
        if (!ID.test(page)) return sendError(res, 400, 'bad-request', 'page is invalid');
        if (!/^\d{1,16}$/.test(since) || !Number.isSafeInteger(Number(since))) return sendError(res, 400, 'bad-request', 'since is invalid');
        sendJSON(res, 200, { lines: logs.since(page, Number(since)) });
        return;
      }
      case '/invoke': {
        if (!allow('POST')) return;
        const inv = parseInvoke(req.headers['x-specola-invoke']);
        await pages.invoke(inv, req, res);
        return;
      }
      default: {
        const m = PAGE_ROUTE.exec(url.pathname);
        if (m) return pageRoute(pages, m, req, res, allow);
        notFound(req, res);
      }
    }
  }

  const server = http.createServer({ maxHeaderSize: MAX_HEADER_SIZE }, (req, res) => {
    route(req, res).catch((err) => {
      if (err instanceof RunnerError) {
        sendError(res, err.status, err.code, err.message, err.ref);
      } else {
        console.error('runner: unexpected error', err);
        sendError(res, 500, 'backend-error', 'The runner failed.');
      }
      req.resume();
    });
  });
  // The runner's own limits apply per request; Node's must not cut first.
  // An import's zip (up to 1 GiB) comes at the pace of the browser that
  // uploads it to specola, which gives it up to 2 hours (TRANSFER_MS).
  server.requestTimeout = Math.max(config.limits.requestMs + 10_000, TRANSFER_MS);
  // Specola keeps idle connections for up to 90 s (Go's default). Were Node
  // to close one first, a call sent on it just then would fail with nothing
  // run, and one with a body can't be retried: the runner keeps them longer.
  server.keepAliveTimeout = 100_000;
  server.headersTimeout = 110_000;

  return {
    server,
    pages,
    logs,
    code,
    /** Removes what a previous process left half written. */
    async sweep() {
      await code.sweep();
      await pages.sweep();
      await sweepSnapshots(config.dataDir);
    },
    listen(port = config.listen.port, host = config.listen.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await pages.stopAll();
    },
  };
}
