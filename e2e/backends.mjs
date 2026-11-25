#!/usr/bin/env node
// End-to-end check of page backends (docs/page-backends.md, delivery step
// 1): a real runner (runner/), a real Specola in front of it, and a Vite app
// with a backend (e2e/app-backend) built with the plugin and published with
// the real specola-publish CLI, then driven in Chromium through the real
// viewer (/#/p/<id>).
//
// 1. Backends enabled: GET /api/me and the upload grant say so; the app's
//    shared counter (ctx.db) counts and persists; a note goes to the user's
//    own database (ctx.userDb); a FormData upload round-trips byte for byte
//    through ctx.files; a streamed answer reaches the page chunk by chunk as
//    the backend writes it; a route that throws answers 500 backend-error
//    with a ref that names a line of the backend log (API and viewer panel).
//    A viewer-only user (a second Specola on the same database, behind a
//    trusted user header) may call the backend, with a userDb of their own,
//    but gets 403 on the log.
// 2. Version 2 published: v1 answers 410 on /view?v=1 and is not viewable;
//    the v1 frame still open gets "superseded" and the viewer's reload
//    notice, which loads v2; the data survived; the runner took a snapshot
//    of v1's data.
// 3. Specola restarted without the backend variables: /api/me says
//    disabled, the MCP instructions carry the disabled sentence, a bundle
//    with a backend is refused (CLI and server, backend-disabled), and the
//    existing page opens with the disabled notice while its specola.fetch
//    rejects with BackendUnavailable (reason "disabled").
//
// Needs: Go, Node 22+, a PostgreSQL to create a throwaway database on, the
// SPA built (cd web && npm run build), plugin dependencies (cd plugin && npm
// install) and Playwright with Chromium. See e2e/README.md.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright is usually installed globally, which import can't find.
const { chromium } = createRequire(import.meta.url)('playwright');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adminDB = process.env.SPECOLA_E2E_DATABASE_URL || 'postgres://postgres:dev@localhost:5432/postgres?sslmode=disable';
const DEV_USER = 'dev@example.com';
const VIEWER = 'viewer@example.com';
const USER_HEADER = 'X-E2E-User';

let failures = 0;
function check(ok, what, detail) {
  if (ok) {
    console.log(`  ok    ${what}`);
  } else {
    failures++;
    console.log(`  FAIL  ${what}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  }
}

function need(path, hint) {
  if (!existsSync(join(root, path))) {
    console.error(`missing ${path}: ${hint}`);
    process.exit(2);
  }
}
need('internal/webui/dist/assets', 'build the SPA first (cd web && npm install && npm run build)');
need('plugin/node_modules/vite', 'install the plugin dependencies first (cd plugin && npm install)');

const tmp = mkdtempSync(join(tmpdir(), 'specola-e2e-backends-'));
const dist = join(tmp, 'dist');
const bin = join(tmp, 'specola');
const runnerData = join(tmp, 'runner');
console.log('building e2e/app-backend with the plugin, and the server');
execFileSync(process.execPath, [join(root, 'plugin/node_modules/vite/bin/vite.js'), 'build', join(root, 'e2e/app-backend'), '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], { stdio: 'inherit' });
check(existsSync(join(dist, '.specola/backend.json')) && existsSync(join(dist, '.specola/server/index.mjs')), 'the plugin built the backend into .specola/');
execFileSync('go', ['build', '-o', bin, './cmd/specola'], { cwd: root, stdio: 'inherit' });

const [port, viewerPort, runnerPort] = await freePorts(3);
const app = `http://localhost:${port}`;
const viewerApp = `http://localhost:${viewerPort}`;
const token = randomBytes(24).toString('base64url');
const backendEnv = {
  SPECOLA_RUNNER_URL: `http://127.0.0.1:${runnerPort}`,
  SPECOLA_RUNNER_TOKEN: token,
  SPECOLA_SECRETS_KEY: randomBytes(32).toString('base64'),
};
const db = 'specola_e2e_' + randomBytes(4).toString('hex');
execFileSync('psql', [adminDB, '-qc', `CREATE DATABASE ${db}`]);
const dbURL = new URL(db, adminDB.replace(/\/[^/?]*(\?|$)/, '/$1')).href;

const procs = new Set();
// The browser context and viewer page of phase 1, kept open into phase 2:
// its frame still shows version 1 when version 2 is published.
let context, viewer, frame;
const browser = await chromium.launch();
try {
  await main();
} catch (err) {
  failures++;
  console.log(`  FAIL  ${err.stack || err}`);
} finally {
  await browser.close();
  for (const p of procs) await stop(p);
  execFileSync('psql', [adminDB, '-qc', `DROP DATABASE ${db}`]);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

async function main() {
  const runner = start('runner', process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'runner/src/main.js')], {
    SPECOLA_RUNNER_TOKEN: token,
    SPECOLA_URL: app,
    RUNNER_DATA_DIR: runnerData,
    RUNNER_LISTEN: `127.0.0.1:${runnerPort}`,
  });
  await waitFor(async () => (await fetch(`${backendEnv.SPECOLA_RUNNER_URL}/health`, { headers: { authorization: `Bearer ${token}` } })).ok, 'runner start');

  console.log('\n== backends enabled');
  let server = await startSpecola(port, { SPECOLA_DEV_AUTH_EMAIL: DEV_USER, ...backendEnv });
  // A second Specola on the same database, for a user other than the dev
  // one: it takes the user from a header.
  const viewerServer = await startSpecola(viewerPort, { SPECOLA_TRUSTED_USER_HEADER: USER_HEADER, ...backendEnv });
  const id = await enabled();
  await viewerOnly(id);
  await stop(viewerServer);

  console.log('\n== version 2');
  await newVersion(id);

  console.log('\n== backends disabled');
  await stop(server);
  await stop(runner);
  server = await startSpecola(port, { SPECOLA_DEV_AUTH_EMAIL: DEV_USER });
  await disabled(id);
}

async function enabled() {
  const me = await api('GET', '/api/me');
  check(me.backends?.enabled === true && me.backends?.available === true, 'GET /api/me: backends enabled and available', me.backends);

  const up = await api('POST', '/api/bundle-uploads', { kind: 'new', title: 'E2E backend', note: 'v1' });
  check(up.backend?.enabled === true && up.backend?.available === true, 'the upload grant says backends are enabled', up.backend);
  const published = publish(up.uploadUrl);
  check(published.ok && published.json?.version === 1, 'specola-publish published the bundle with its backend', published);
  const id = published.json.id;

  const meta = await api('GET', `/api/pages/${id}`);
  check(meta.backend === true, 'page metadata says backend', meta);
  const versions = await api('GET', `/api/pages/${id}/versions`);
  const v1 = versions.find?.((v) => v.version === 1) ?? versions.versions?.find((v) => v.version === 1);
  check(v1?.backend === true && v1?.viewable === true, 'version 1: backend, viewable', v1);
  const files = await api('GET', `/api/pages/${id}/versions/1/files`);
  check(!JSON.stringify(files).includes('.specola'), 'the files list leaves .specola/ out', files);
  const hidden = await fetch(`${files.base}.specola/backend.json`);
  check(hidden.status === 404, '/b/{key}/.specola/backend.json is not served', hidden.status);

  context = await browser.newContext();
  const errors = [];
  context.on('weberror', (e) => errors.push(String(e.error())));
  viewer = await context.newPage();
  await viewer.goto(`${app}/#/p/${id}`);
  frame = await pageFrame(viewer, id);
  check((await ready(frame)) === 'ready', 'the app loaded and called its backend');
  check((await frame.textContent('#count')) === '1', 'the counter starts at 1', await frame.textContent('#count'));
  const state = await frame.evaluate(() => ({ ...window.specola.backend }));
  check(state.enabled && state.available, 'specola.backend: enabled and available', state);
  check(!(await viewer.locator('[data-backend-notice]').count()), 'no backend notice while it is available');

  // ctx.db: shared, persistent.
  const counted = await call(frame, '/api/counter', { method: 'POST' });
  check(counted.status === 200 && counted.json?.count === 2, 'the shared counter counts', counted);
  const reread = await call(frame, '/api/counter');
  check(reread.json?.count === 2 && reread.json?.version === 1, 'the counter persists (ctx.page.version is 1)', reread);

  // ctx.userDb: the user's own.
  const put = await call(frame, '/api/note', { method: 'PUT', body: 'note of the dev user' });
  check(put.status === 204, 'a note goes to the user database', put);
  const note = await call(frame, '/api/note');
  check(note.json?.note === 'note of the dev user' && note.json?.sub === DEV_USER && note.json?.role === 'owner', 'ctx.userDb and ctx.user', note.json);

  // ctx.files: a FormData upload round-trips byte for byte.
  const upload = await frame.evaluate(async () => {
    const bytes = new Uint8Array(300 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919 + (i >> 8)) & 0xff;
    const fd = new FormData();
    fd.append('file', new File([bytes], 'blob.bin', { type: 'application/x-e2e' }));
    const put = await window.specola.fetch('/api/upload', { method: 'POST', body: fd });
    const info = await put.json();
    const got = await window.specola.fetch('/api/upload?name=blob.bin');
    const back = new Uint8Array(await got.arrayBuffer());
    let same = back.length === bytes.length;
    for (let i = 0; same && i < bytes.length; i++) same = back[i] === bytes[i];
    return { status: put.status, info, type: got.headers.get('content-type'), length: back.length, same };
  });
  check(upload.status === 201 && upload.info.size === 300 * 1024 && upload.info.key === 'uploads/blob.bin', 'the upload is stored', upload);
  check(upload.same && upload.type === 'application/x-e2e', 'the upload reads back byte for byte, with its type', upload);

  // A streamed answer arrives as the backend writes it.
  const stream = await frame.evaluate(async () => {
    const t0 = performance.now();
    const res = await window.specola.fetch('/api/stream');
    const head = performance.now() - t0;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push({ at: performance.now() - t0, text: dec.decode(value) });
    }
    return { head, chunks };
  });
  const text = stream.chunks.map((c) => c.text).join('');
  const firstAt = stream.chunks[0]?.at ?? Infinity;
  const lastAt = stream.chunks.at(-1)?.at ?? 0;
  check(text === 'chunk 0\nchunk 1\nchunk 2\nchunk 3\n', 'the streamed body is complete', text);
  check(stream.chunks.length >= 3 && lastAt - firstAt > 800 && firstAt < 1000, 'streamed chunks arrive incrementally', stream);

  // An uncaught error: 500 backend-error, its ref in the backend log.
  const thrown = await call(frame, '/api/throw');
  check(thrown.status === 500 && thrown.headers['x-specola-error'] === 'backend-error' && thrown.json?.error === 'backend-error' && thrown.json?.ref, 'a throwing route answers 500 backend-error with a ref', thrown);
  check(!JSON.stringify(thrown.json).includes('e2e boom'), 'the error reaches the page sanitised', thrown.json);
  const ref = thrown.json?.ref;
  const logs = await api('GET', `/api/pages/${id}/backend/logs`);
  const line = logs.lines?.find((l) => l.ref === ref);
  check(line && line.level === 'error' && line.text.includes('e2e boom'), 'the ref names the error in the backend log', line ?? logs);
  const later = await api('GET', `/api/pages/${id}/backend/logs?since=${logs.lines.at(-1).seq}`);
  check(Array.isArray(later.lines) && later.lines.length === 0, 'the log since its last line is empty', later);
  await viewer.getByRole('button', { name: 'Backend log' }).click();
  const shown = await waitFor(async () => (await viewer.textContent('body')).includes('e2e boom'), 'backend log panel', 10000).catch(() => false);
  check(shown, 'the viewer\'s backend log panel shows the error');

  // The proxy's own refusals.
  const noVersion = await fetch(`${app}/api/pages/${id}/x/api/counter`);
  check(noVersion.status === 400 && noVersion.headers.get('x-specola-error') === 'bad-request', 'a call without X-Specola-Version is refused', noVersion.status);
  check(errors.length === 0, 'no uncaught errors in the viewer or the frame', errors);
  return id;
}

async function viewerOnly(id) {
  const as = (path, init = {}) => fetch(viewerApp + path, { ...init, headers: { ...init.headers, [USER_HEADER]: VIEWER } });
  // Signing in once makes the user known, so the page can be shared with them.
  await as('/api/me');
  await api('PUT', `/api/pages/${id}/acl`, { sub: VIEWER, role: 'viewer' });
  const logs = await as(`/api/pages/${id}/backend/logs`);
  check(logs.status === 403 && logs.headers.get('x-specola-error') === 'forbidden', 'a viewer gets 403 on the backend log', logs.status);
  const counted = await as(`/api/pages/${id}/x/api/counter`, { method: 'POST', headers: { 'X-Specola-Version': '1' } });
  const body = await counted.json().catch(() => null);
  check(counted.status === 200 && body?.count === 3, 'a viewer may call the backend, on the same shared data', body);
  const note = await (await as(`/api/pages/${id}/x/api/note`, { headers: { 'X-Specola-Version': '1' } })).json();
  check(note.sub === VIEWER && note.role === 'viewer' && note.note === null, 'a viewer has a user database of their own', note);
}

async function newVersion(id) {
  const before = (await call(frame, '/api/counter')).json?.count;
  const up = await api('POST', '/api/bundle-uploads', { kind: 'version', id, note: 'v2' });
  const published = publish(up.uploadUrl);
  check(published.ok && published.json?.version === 2, 'version 2 published', published);

  const old = await fetch(`${app}/view/${id}?v=1`);
  check(old.status === 410 && old.headers.get('x-specola-error') === 'superseded', '/view?v=1 answers 410 superseded', old.status);
  const versions = await api('GET', `/api/pages/${id}/versions`);
  const list = Array.isArray(versions) ? versions : versions.versions;
  const v1 = list?.find((v) => v.version === 1);
  const v2 = list?.find((v) => v.version === 2);
  check(v1?.viewable === false && v2?.viewable === true, 'only version 2 is viewable', list);
  const skew = await fetch(`${app}/api/pages/${id}/x/api/counter`, { headers: { 'X-Specola-Version': '1' } });
  check(skew.status === 409 && skew.headers.get('x-specola-error') === 'superseded', 'a call naming version 1 answers 409 superseded', skew.status);

  // The frame still showing version 1.
  const refused = await frame.evaluate(() =>
    window.specola.fetch('/api/counter').then(
      (r) => ({ status: r.status }),
      (e) => ({ name: e.name, reason: e.reason }),
    ),
  );
  check(refused.name === 'BackendUnavailable' && refused.reason === 'superseded', 'the v1 frame gets BackendUnavailable (superseded)', refused);
  const notice = viewer.locator('[data-superseded]');
  check(await notice.isVisible().catch(() => false) || (await waitFor(() => notice.isVisible(), 'reload notice', 5000).catch(() => false)), 'the viewer shows the reload notice');
  await notice.getByRole('button', { name: 'Reload' }).click();
  frame = await waitFor(() => viewer.frames().find((f) => f.url().includes(`/view/${id}`) && f.url().includes('v=2')), 'version 2 frame');
  check((await ready(frame)) === 'ready', 'Reload opens version 2');
  const count = Number(await frame.textContent('#count'));
  check(count === before + 1, 'the counter survived the new version', { before, count });
  const note = await call(frame, '/api/note');
  check(note.json?.note === 'note of the dev user', 'the user database survived', note.json);
  const file = await frame.evaluate(async () => (await window.specola.fetch('/api/upload?name=blob.bin')).arrayBuffer().then((b) => b.byteLength));
  check(file === 300 * 1024, 'the file store survived', file);
  check((await call(frame, '/api/counter')).json?.version === 2, 'the backend runs version 2');

  const snaps = join(runnerData, 'snapshots', id);
  const names = existsSync(snaps) ? readdirSync(snaps) : [];
  const snap = names.find((n) => n.endsWith('-v1'));
  check(snap && existsSync(join(snaps, snap, 'shared.sqlite')) && existsSync(join(snaps, snap, 'files.sqlite')), 'the runner snapshotted version 1\'s data', names);
  await context.close();
}

async function disabled(id) {
  const me = await api('GET', '/api/me');
  check(me.backends?.enabled === false && me.backends?.available === false, 'GET /api/me: backends disabled', me.backends);

  const init = await fetch(`${app}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }),
  });
  const instructions = (await init.json().catch(() => null))?.result?.instructions ?? '';
  check(
    instructions.includes('Page backends are not enabled on this instance: bundles are static, `server/` code and `specola.fetch` are unavailable. Do not design apps that need them.') &&
      !instructions.includes('PAGE BACKENDS'),
    'the MCP instructions say backends are not enabled',
    instructions.slice(0, 200),
  );

  const up = await api('POST', '/api/bundle-uploads', { kind: 'new', title: 'E2E refused' });
  check(up.backend?.enabled === false && !!up.backend?.reason, 'the upload grant says backends are disabled, and why', up.backend);
  const refused = publish(up.uploadUrl);
  check(!refused.ok && /page backends are not enabled/.test(refused.stderr), 'specola-publish refuses a bundle with a backend', refused.stderr);
  const manifest = await fetch(`${up.uploadUrl}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pluginVersion: JSON.parse(readFileSync(join(root, 'plugin/package.json'), 'utf8')).version,
      files: [
        { path: 'index.html', sha256: '0'.repeat(64), size: 10 },
        { path: '.specola/backend.json', sha256: '1'.repeat(64), size: 10 },
        { path: '.specola/server/index.mjs', sha256: '2'.repeat(64), size: 10 },
      ],
    }),
  });
  const mbody = await manifest.json().catch(() => null);
  check(manifest.status === 400 && manifest.headers.get('x-specola-error') === 'backend-disabled' && mbody?.error === 'backend-disabled', 'the server refuses its manifest: 400 backend-disabled', { status: manifest.status, body: mbody });

  const call = await fetch(`${app}/api/pages/${id}/x/api/counter`, { headers: { 'X-Specola-Version': '2' } });
  check(call.status === 503 && call.headers.get('x-specola-error') === 'backend-disabled', 'a call answers 503 backend-disabled', call.status);

  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`${app}/#/p/${id}`);
    const f = await pageFrame(page, id);
    check((await ready(f)) === 'failed', 'the page still opens');
    const err = await f.evaluate(() => window.__e2eError);
    check(err?.name === 'BackendUnavailable' && err?.reason === 'disabled', 'specola.fetch rejects with BackendUnavailable (disabled)', err);
    const state = await f.evaluate(() => ({ ...window.specola.backend }));
    check(!state.enabled && !state.available, 'specola.backend: not enabled', state);
    const notice = await waitFor(async () => (await page.locator('[data-backend-notice]').textContent()) || false, 'backend notice', 10000).catch(() => '');
    check(/not enabled on this instance/.test(notice), 'the viewer shows the disabled notice', notice);
  } finally {
    await ctx.close();
  }
}

// ---- helpers

async function api(method, path, body) {
  const res = await fetch(app + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// publish runs the real CLI on the built app; it never throws.
function publish(uploadUrl) {
  try {
    const out = execFileSync(process.execPath, [join(root, 'plugin/bin/specola-publish.js'), '--upload', uploadUrl, '--dir', dist, '--no-build'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, json: JSON.parse(out) };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr ?? err.message) };
  }
}

// call makes a specola.fetch from the frame and reads the answer.
function call(frame, path, init) {
  return frame.evaluate(
    async ([path, init]) => {
      const res = await window.specola.fetch(path, init);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, headers: Object.fromEntries(res.headers), json, text: json ? undefined : text };
    },
    [path, init],
  );
}

function pageFrame(page, id) {
  return waitFor(() => page.frames().find((f) => f.url().includes(`/view/${id}`)), 'page frame');
}

// ready waits for the app's first call to its backend to settle.
async function ready(frame) {
  await frame.waitForFunction(() => document.documentElement.dataset.e2e, null, { timeout: 20000 });
  return frame.evaluate(() => document.documentElement.dataset.e2e);
}

async function startSpecola(p, env) {
  const proc = start(`specola :${p}`, bin, [], {
    SPECOLA_DATABASE_URL: dbURL,
    SPECOLA_BASE_URL: `http://localhost:${p}`,
    SPECOLA_LISTEN: `:${p}`,
    SPECOLA_SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret',
    ...env,
  });
  await waitFor(async () => (await fetch(`http://localhost:${p}/healthz`)).ok, `specola :${p} start`);
  return proc;
}

function start(name, cmd, args, env) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (/^SPECOLA_|^RUNNER_/.test(k)) delete clean[k];
  const proc = spawn(cmd, args, { env: { ...clean, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  proc.label = name;
  procs.add(proc);
  return proc;
}

async function stop(proc) {
  if (!procs.delete(proc) || proc.exitCode !== null) return;
  proc.kill();
  await new Promise((r) => proc.once('exit', r));
}

async function freePorts(n) {
  const servers = await Promise.all(
    Array.from({ length: n }, () => new Promise((r) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => r(s));
    })),
  );
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

async function waitFor(fn, what, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
