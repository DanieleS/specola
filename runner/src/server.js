// The runner's HTTP API, called by specola only (docs/page-backends.md,
// "specola ↔ runner (internal)" and "Wire formats (exact)"):
//
//   POST /invoke   run a page's fetch handler (head in X-Specola-Invoke)
//   GET  /logs     a page's backend log
//   GET  /health   liveness, for specola's "available"
//
// Every endpoint requires the shared bearer token.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { CodeCache } from './code.js';
import { RunnerError, sendError, sendJSON } from './errors.js';
import { Logs } from './log.js';
import { Pages } from './pages.js';

export const RUNNER_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/; // an HTTP method
const ROLES = new Set(['owner', 'editor', 'viewer', 'public', 'cron']);
// Specola caps the encoded X-Specola-Invoke at 48 KiB; Node's default
// header limit (16 KiB) would cut a call with large headers first.
const MAX_INVOKE_HEADER = 48 * 1024;
const MAX_HEADER_SIZE = 64 * 1024;

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

/**
 * Builds the runner. `fetch` is what fetches code from specola (tests pass
 * their own).
 */
export function createRunner(config, { fetch: f } = {}) {
  const logs = new Logs();
  const code = new CodeCache({ dataDir: config.dataDir, specolaUrl: config.specolaUrl, token: config.token, fetch: f ?? fetch });
  const pages = new Pages({ config, code, logs });
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
    const allow = (method) => {
      if (req.method === method) return true;
      res.setHeader('Allow', method);
      sendError(res, 405, 'method-not-allowed', `Use ${method}.`);
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
      default:
        sendError(res, 404, 'not-found', 'Not found.');
        req.resume();
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
  server.requestTimeout = config.limits.requestMs + 10_000;

  return {
    server,
    pages,
    logs,
    code,
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
