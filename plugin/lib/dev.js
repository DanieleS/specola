// The page backend under `vite dev` (docs/page-backends.md, "Plugin and CLI"):
// the handler is mounted at /__specola/x/*, loaded with the dev server's SSR
// loader (so editing server code takes effect on the next request), with a
// ctx implemented on the developer's machine: SQLite and files under
// <root>/.specola-dev/, secrets from the environment and .env, the user from
// SPECOLA_DEV_USER. It follows the runner's contract (request URL, headers,
// error format) so that what works here works once published.

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathProblem } from './rules.js';

/** Where the dev middleware is mounted; the dev window.specola.fetch goes there. */
export const DEV_PREFIX = '/__specola/x';
/** The directory, under the project root, that holds the dev backend's data. */
export const DEV_DATA_DIR = '.specola-dev';

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
// Response headers with an effect on the whole origin, which specola and the
// runner drop (runner/src/process.js, ORIGIN_WIDE): dropped here too, so a
// handler that relies on one finds out in dev.
const ORIGIN_WIDE = new Set(['clear-site-data', 'nel', 'report-to', 'reporting-endpoints', 'strict-transport-security', 'alt-svc', 'accept-ch', 'critical-ch', 'origin-agent-cluster', 'service-worker-allowed', 'set-login', 'refresh']);
const require = createRequire(import.meta.url);

/** The headers a handler sees: the page's, minus cookies, hop-by-hop ones and X-Specola-*. */
export function requestHeaders(raw) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    const name = k.toLowerCase();
    if (name === 'cookie' || name === 'host' || HOP_BY_HOP.has(name) || name.startsWith('x-specola-') || name.startsWith(':')) continue;
    for (const one of [v].flat()) if (one !== undefined) headers.append(name, one);
  }
  return headers;
}

/**
 * The response headers sent to the page: Set-Cookie, hop-by-hop, X-Specola-*,
 * CORS and origin-wide ones are dropped, as specola does.
 */
export function responseHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) {
    if (k === 'set-cookie' || HOP_BY_HOP.has(k) || ORIGIN_WIDE.has(k) || k.startsWith('x-specola-') || k.startsWith('access-control-')) continue;
    out[k] = k in out ? `${out[k]}, ${v}` : v;
  }
  return out;
}

/** The dev user, from SPECOLA_DEV_USER ("me@example.com" or "Name <me@example.com>"). */
export function devUser(value = process.env.SPECOLA_DEV_USER) {
  const raw = (value ?? '').trim() || 'dev@localhost';
  const m = /^(.*?)\s*<([^>]+)>$/.exec(raw);
  const email = m ? m[2].trim() : raw;
  const name = (m && m[1].trim()) || email.split('@')[0];
  return Object.freeze({ sub: email, email, name });
}

/**
 * Whether a request comes from another site. The dev backend runs as the
 * developer, as owner, on their dev data: a page they visit elsewhere must
 * not be able to post to it (a form needs no preflight). Tools without these
 * headers (curl) are let through.
 */
export function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return Boolean(origin);
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/** Answers one of the runner's own errors: X-Specola-Error and a JSON body. */
function sendError(res, status, code, message, ref) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: code, message, ...(ref ? { ref } : {}) });
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Specola-Error': code, 'Cache-Control': 'no-store' });
  res.end(body);
}

const newRef = () => randomBytes(5).toString('hex');

/**
 * Creates the dev backend. load() returns the entry module (the dev
 * server's ssrLoadModule of the entry); env the variables the secrets come
 * from (an object, or a function returning one, read per request so that
 * an edited .env applies). Returns {middleware, close, dataDir}.
 */
export function createDevBackend({ root, load, manifest, env = process.env, logger = console, pageTitle = 'dev' }) {
  const getEnv = typeof env === 'function' ? env : () => env;
  const dataDir = join(root, DEV_DATA_DIR);
  const page = Object.freeze({ id: 'dev', version: 1, title: pageTitle });
  let sharedDb = null;
  const userDbs = new Map();
  let files = null;
  let publishWarned = false;

  const openDb = (file) => {
    let sqlite;
    try {
      sqlite = require('node:sqlite');
    } catch {
      throw new Error(`ctx.db needs node:sqlite, which this Node (${process.version}) does not have: use Node 22.13 or newer`);
    }
    mkdirSync(dirname(file), { recursive: true });
    const db = new sqlite.DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    return db;
  };

  const secrets = (env) => {
    const out = {};
    for (const name of manifest.secrets) if (typeof env[name] === 'string') out[name] = env[name];
    return Object.freeze(out);
  };

  // Outbound fetch from the handler is not restricted to the manifest's
  // egress hosts, here or (until the egress proxy lands) on the runner.
  function makeCtx(env, waits) {
    const user = devUser(env.SPECOLA_DEV_USER);
    return {
      user,
      role: 'owner',
      link: null,
      page,
      get db() {
        sharedDb ??= openDb(join(dataDir, 'shared.sqlite'));
        return sharedDb;
      },
      get userDb() {
        let db = userDbs.get(user.sub);
        if (!db) {
          db = openDb(join(dataDir, 'users', `${createHash('sha256').update(user.sub).digest('hex')}.sqlite`));
          userDbs.set(user.sub, db);
        }
        return db;
      },
      get files() {
        files ??= new DevFileStore(dataDir);
        return files;
      },
      secrets: secrets(env),
      publish() {
        // Realtime push is a later step of docs/page-backends.md ("Delivery plan").
        if (!publishWarned) {
          publishWarned = true;
          logger.warn('[specola] ctx.publish: push is not available yet; the event was dropped');
        }
      },
      waitUntil(p) {
        waits.push(Promise.resolve(p).catch((err) => logger.error('[specola] a waitUntil promise rejected:', err)));
      },
      log: console,
    };
  }

  async function middleware(req, res) {
    // Mounted under DEV_PREFIX: req.url is the rest of the path.
    const path = req.url.startsWith('/') ? req.url : '/' + req.url;
    const method = req.method ?? 'GET';
    if (crossSite(req)) {
      sendError(res, 403, 'forbidden', 'The dev backend only answers the dev server\'s own pages.');
      req.resume();
      return;
    }
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort(new DOMException('The request was aborted.', 'AbortError'));
    });

    let body = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          sendError(res, 413, 'body-too-large', `the request body is over ${MAX_BODY_BYTES} bytes`);
          return;
        }
        chunks.push(c);
      }
      body = Buffer.concat(chunks);
    }

    let mod;
    try {
      mod = await load();
    } catch (err) {
      const ref = newRef();
      logger.error(`[specola] loading the backend failed (ref ${ref}):`, err);
      sendError(res, 500, 'backend-error', 'Loading the backend failed.', ref);
      return;
    }
    const handler = mod?.default;
    if (!handler || typeof handler.fetch !== 'function') {
      const ref = newRef();
      logger.error(`[specola] the backend entry has no fetch handler (ref ${ref}): its default export must be an object with a fetch(request, ctx) method`);
      sendError(res, 500, 'backend-error', 'The backend has no fetch handler.', ref);
      return;
    }

    const waits = [];
    let response;
    try {
      const request = new Request('https://page.invalid' + path, {
        method,
        headers: requestHeaders(req.headers),
        body,
        signal: abort.signal,
      });
      response = await handler.fetch(request, makeCtx(getEnv(), waits));
    } catch (err) {
      const ref = newRef();
      logger.error(`[specola] ${method} ${path} failed (ref ${ref}):`, err);
      sendError(res, 500, 'backend-error', 'The backend failed to handle the request.', ref);
      return;
    }
    if (!(response instanceof Response)) {
      const ref = newRef();
      logger.error(`[specola] ${method} ${path}: the fetch handler returned ${typeof response}, not a Response (ref ${ref})`);
      sendError(res, 500, 'backend-error', 'The backend did not return a Response.', ref);
      return;
    }

    res.writeHead(response.status, response.statusText || undefined, responseHeaders(response.headers));
    // Send the head at once: a streamed response may take long for its first chunk.
    res.flushHeaders();
    try {
      if (response.body && method !== 'HEAD') {
        for await (const chunk of response.body) {
          if (abort.signal.aborted) break;
          // 'close' too: a caller gone mid-stream never drains.
          if (!res.write(chunk)) await new Promise((r) => (res.once('drain', r), res.once('close', r)));
        }
      }
      res.end();
    } catch (err) {
      logger.error(`[specola] ${method} ${path}: the response body failed:`, err);
      res.destroy();
    }
    await Promise.all(waits);
  }

  return {
    dataDir,
    middleware(req, res, next) {
      middleware(req, res).catch(next);
    },
    close() {
      for (const db of [sharedDb, ...userDbs.values()]) {
        try {
          db?.close();
        } catch {
          // already closed by the handler
        }
      }
      sharedDb = null;
      userDbs.clear();
      files?.close();
      files = null;
    },
  };
}

/**
 * ctx.files under `vite dev`: the runner's store without its quota and
 * snapshots. An index in files.sqlite, contents under files/blobs/<sha256>.
 */
export class DevFileStore {
  #dir;
  #db = null;

  constructor(dataDir) {
    this.#dir = dataDir;
  }

  #index() {
    if (this.#db) return this.#db;
    mkdirSync(this.#dir, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(join(this.#dir, 'files.sqlite'));
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
        content_type TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    this.#db = db;
    return db;
  }

  get #blobs() {
    return join(this.#dir, 'files', 'blobs');
  }

  close() {
    this.#db?.close();
    this.#db = null;
  }

  async put(key, body, opts = {}) {
    checkKey(key);
    if (body === undefined || body === null) throw new TypeError('files.put: body is required');
    const contentType = opts?.contentType || (typeof body?.type === 'string' && body.type) || 'application/octet-stream';
    const stream = new Response(body).body;
    await fs.mkdir(this.#blobs, { recursive: true });
    const tmp = join(this.#blobs, `.tmp-${randomBytes(8).toString('hex')}`);
    const hash = createHash('sha256');
    let size = 0;
    try {
      await pipeline(
        stream ? Readable.fromWeb(stream) : Readable.from([]),
        async function* (source) {
          for await (const chunk of source) {
            size += chunk.length;
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tmp),
      );
      const sha = hash.digest('hex');
      await fs.rename(tmp, join(this.#blobs, sha));
      const db = this.#index();
      const old = db.prepare('SELECT sha256 FROM files WHERE key = ?').get(key)?.sha256;
      db.prepare(`INSERT INTO files (key, sha256, size, content_type, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size,
          content_type = excluded.content_type, updated_at = excluded.updated_at`).run(key, sha, size, contentType, new Date().toISOString());
      if (old && old !== sha) await this.#collect(old);
      return { key, size, contentType };
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async get(key) {
    checkKey(key);
    const row = this.#index().prepare('SELECT sha256, size, content_type FROM files WHERE key = ?').get(key);
    if (!row) return null;
    let handle;
    try {
      handle = await fs.open(join(this.#blobs, row.sha256));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    return { body: Readable.toWeb(handle.createReadStream()), size: row.size, contentType: row.content_type };
  }

  async delete(key) {
    checkKey(key);
    const db = this.#index();
    const row = db.prepare('SELECT sha256 FROM files WHERE key = ?').get(key);
    if (!row) return false;
    db.prepare('DELETE FROM files WHERE key = ?').run(key);
    await this.#collect(row.sha256);
    return true;
  }

  async list(prefix = '') {
    if (typeof prefix !== 'string') throw new TypeError('files.list: prefix must be a string');
    return this.#index()
      .prepare('SELECT key, size, content_type, updated_at FROM files WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key')
      .all(prefix)
      .map((r) => ({ key: r.key, size: r.size, contentType: r.content_type, updatedAt: r.updated_at }));
  }

  async #collect(sha) {
    if (this.#index().prepare('SELECT 1 FROM files WHERE sha256 = ? LIMIT 1').get(sha)) return;
    await fs.rm(join(this.#blobs, sha), { force: true });
  }
}

// File keys follow the bundle path rules, as on the runner (minus the HTML
// rule, which is about bundles).
function checkKey(key) {
  const why = pathProblem(key);
  if (why && !why.startsWith('only index.html')) throw new TypeError(`files: invalid key ${JSON.stringify(key)}: ${why}`);
}
