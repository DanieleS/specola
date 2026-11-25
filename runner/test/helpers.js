// Test helpers: a fake specola serving backend code, and a runner on a
// random port with its own data directory.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LIMITS } from '../src/config.js';
import { createRunner } from '../src/server.js';

export const TOKEN = 'test-runner-token-0123456789';

/** Builds a version's .specola/ files, with backend_hash computed per the doc. */
export function makeCode(files) {
  const list = Object.entries(files).map(([p, content]) => ({ path: p, content: Buffer.from(content) }));
  const lines = list
    .map((f) => `${f.path}\t${createHash('sha256').update(f.content).digest('hex')}\n`)
    .sort()
    .join('');
  const codeHash = createHash('sha256').update(lines).digest('hex');
  return { codeHash, files: list.map((f) => ({ path: f.path, content: f.content.toString('base64') })) };
}

/** A backend whose entry is `source` (an ES module). */
export function backend(source, extra = {}) {
  return makeCode({ 'backend.json': JSON.stringify({ version: 1, entry: 'server/index.mjs' }), 'server/index.mjs': source, ...extra });
}

/** A fake specola: GET /internal/runner/code/{versionId}. */
export async function fakeSpecola() {
  const versions = new Map();
  const hits = [];
  const state = { delayMs: 30 };
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization });
    const m = /^\/internal\/runner\/code\/([^/]+)$/.exec(req.url);
    if (req.headers.authorization !== `Bearer ${TOKEN}` || !m) {
      res.writeHead(404).end();
      return;
    }
    const code = versions.get(decodeURIComponent(m[1]));
    if (!code) {
      res.writeHead(404).end();
      return;
    }
    // A little latency so concurrent first requests overlap.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(code));
    }, state.delayMs);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    versions,
    hits,
    /** How long code downloads take. */
    set delayMs(ms) {
      state.delayMs = ms;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * A runner on a random port. opts.now is its snapshot clock (a function),
 * for tests that move time.
 */
export async function startRunner(limits = {}, opts = {}) {
  const specola = await fakeSpecola();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'specola-runner-test-'));
  const config = {
    listen: { port: 0, host: '127.0.0.1' },
    token: TOKEN,
    specolaUrl: specola.url,
    dataDir,
    limits: { ...DEFAULT_LIMITS, ...limits },
  };
  const runner = createRunner(config, { now: opts.now });
  const addr = await runner.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${addr.port}`;
  let nextVersion = 1;
  return {
    url,
    runner,
    specola,
    dataDir,
    config,
    /** Registers code on the fake specola and returns a versionId for it. */
    publish(code, versionId = `ver-${nextVersion++}`) {
      specola.versions.set(versionId, code);
      return { versionId, codeHash: code.codeHash };
    },
    invoke(o) {
      return invoke(url, o);
    },
    logs: (page, since = 0) => getJSON(`${url}/logs?page=${page}&since=${since}`),
    /** Calls a /pages/… route: {status, headers, body (parsed JSON, or the bytes)}. */
    api(method, p, o = {}) {
      return api(url, method, p, o);
    },
    async close() {
      await runner.close();
      await specola.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * POSTs an /invoke. o: {page, version, versionId, codeHash, method, path,
 * headers, body, user, role, signal}.
 */
export function invoke(url, o) {
  const head = {
    page: { id: o.page ?? 'page-1', version: o.version ?? 1, title: o.title ?? 'Test page' },
    versionId: o.versionId,
    codeHash: o.codeHash,
    user: o.user === undefined ? { sub: 'user-1', email: 'u1@example.com', name: 'User One' } : o.user,
    role: o.role ?? 'owner',
    link: null,
    secrets: {},
    egress: [],
    request: { method: o.method ?? 'GET', path: o.path ?? '/', headers: o.headers ?? [] },
  };
  return fetch(`${url}/invoke`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-specola-invoke': Buffer.from(JSON.stringify(head)).toString('base64url'),
    },
    body: o.body,
    duplex: 'half',
    signal: o.signal,
  });
}

/** Calls a runner route; o: {json, body, sub, headers}. */
export async function api(url, method, p, o = {}) {
  const headers = { authorization: `Bearer ${TOKEN}`, ...(o.headers ?? {}) };
  let body = o.body;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers['content-type'] = 'application/json';
  }
  if (o.sub !== undefined) headers['x-specola-sub'] = o.sub;
  const res = await fetch(url + p, { method, headers, body, duplex: 'half' });
  const bytes = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, body: type.startsWith('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes };
}

export async function getJSON(url) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: await res.json() };
}

/** Polls fn until it returns a truthy value. */
export async function until(fn, { timeout = 5000, every = 25 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, every));
  }
}

export async function logText(r, page = 'page-1') {
  const { body } = await r.logs(page);
  return body.lines.map((l) => `[${l.level}] ${l.text}`).join('\n');
}
