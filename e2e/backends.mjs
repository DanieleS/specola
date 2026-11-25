#!/usr/bin/env node
// End-to-end check of page backends (docs/page-backends.md, delivery steps
// 1 to 7): a real runner (runner/), a real Specola in front of it, and a Vite app
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
// 3. Data lifecycle (step 2), through the Backend panel where it has the
//    action and the API otherwise: a manual snapshot, restored after the
//    data changed; an export, a reset of the shared data and the export
//    imported back, byte for byte; a zip that reaches outside its layout is
//    refused (bad-import) and changes nothing; an editor may export but not
//    restore, import or reset; a viewer downloads their own data (a real
//    SQLite database with their rows), deletes it and then has none; version
//    1 restored from the history with its data brings that data back.
// 4. Steps 3–7, Specola restarted with its test hooks (a 1 s cron tick and
//    a clock a minute ahead) and the runner with its loopback allowance:
//    - secrets: backendSecretsMissing names the declared one (owners and
//      editors, not viewers); an editor can't set it (403) but sees the
//      list; the owner sets it from the viewer's notice and Secrets tab;
//      the handler has it (the test reads its length, never the value),
//      the API never shows it and the database holds it encrypted; an
//      undeclared secret never reaches the handler.
//    - egress: a backend fetch reaches "localhost" (served here), a host
//      not on the list is refused and the refusal is in the backend log.
//    - scheduled jobs: "tick" (every minute) runs scheduled() with role
//      cron, writes to ctx.db, and shows ok in the API and the Jobs tab.
//    - MCP: the instructions describe backends; call_backend,
//      backend_logs, backend_query (on the counter) and list_secrets.
//    - push: two users in two browser contexts (on two Specolas, so through
//      NOTIFY): a call from one publishes, the other's subscribe callback
//      fires; a targeted push reaches only its user; a new version makes
//      the open streams send superseded and the viewer shows its notice.
//    - public link: /s/<token> serves the shell with its CSP; in a fresh
//      context the page calls a public route (role public, ctx.link), a
//      non-public one answers 403 not-public, a public topic's push
//      arrives, a non-public topic is refused; the per-IP rate limit
//      answers 429 with Retry-After; a revoked link stops calls.
// 5. Purge: Specola restarted with SPECOLA_BACKEND_PURGE_AFTER_DAYS; the page
//    archived, its archive date moved back in the database: the Archived
//    list shows the purge date, then the purge deletes the runner's data.
// 6. Specola restarted without the backend variables: /api/me says
//    disabled, the MCP instructions carry the disabled sentence, a bundle
//    with a backend is refused (CLI and server, backend-disabled), and the
//    existing page opens with the disabled notice while its specola.fetch
//    rejects with BackendUnavailable (reason "disabled").
//
// Needs: Go, Node 22+, a PostgreSQL to create a throwaway database on, the
// SPA built (cd web && npm run build), plugin dependencies (cd plugin && npm
// install) and Playwright with Chromium. See e2e/README.md.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHTTPServer } from 'node:http';
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
const EDITOR = 'editor@example.com';
const TITLE = 'E2E backend';
const PURGE_DAYS = 30;
const USER_HEADER = 'X-E2E-User';
const SECRET = 'sk-e2e-' + randomBytes(16).toString('hex');
const LINK_LABEL = 'e2e public';
// Specola's test hooks (internal/config, dev bypass only): the cron tick
// every second, and the scheduling clock a minute ahead, so the job "tick"
// made due a minute from now runs at once.
const TEST_HOOKS = { SPECOLA_TEST_CRON_EVERY: '1s', SPECOLA_TEST_CLOCK_OFFSET: '1m' };
const SHELL_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; style-src 'unsafe-inline'";

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
// The counter as version 1 left it: what its snapshot holds.
let v1Count;
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
    // Lets the egress check reach the "outside" host this script serves on
    // loopback (runner/src/egress.js; refused under NODE_ENV=production).
    RUNNER_EGRESS_ALLOW_LOOPBACK_FOR_TESTS: '1',
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

  console.log('\n== data lifecycle');
  const second = await startSpecola(viewerPort, { SPECOLA_TRUSTED_USER_HEADER: USER_HEADER, ...backendEnv });
  await dataLifecycle(id);
  await stop(second);

  console.log('\n== secrets, egress, scheduled jobs, MCP, push, public links');
  await stop(server);
  // The job is made due a minute from now in real time, its last run
  // forgotten: only the test clock (a minute ahead) finds it due at once,
  // and a run recorded from here on is one this phase caused.
  sql(`UPDATE backend_cron SET next_run_at = date_trunc('minute', now()) + interval '1 minute', last_run_at = NULL, last_status = NULL, last_error = NULL, last_duration_ms = NULL WHERE asset_id = '${id}'`);
  server = await startSpecola(port, { SPECOLA_DEV_AUTH_EMAIL: DEV_USER, ...backendEnv, ...TEST_HOOKS });
  const third = await startSpecola(viewerPort, { SPECOLA_TRUSTED_USER_HEADER: USER_HEADER, ...backendEnv });
  await secrets(id);
  await egress(id);
  await scheduledJobs(id);
  await mcp(id);
  await push(id);
  await publicLink(id);
  await stop(third);

  console.log('\n== purge');
  await stop(server);
  server = await startSpecola(port, { SPECOLA_DEV_AUTH_EMAIL: DEV_USER, ...backendEnv, SPECOLA_BACKEND_PURGE_AFTER_DAYS: String(PURGE_DAYS) });
  await purge(id);

  console.log('\n== backends disabled');
  await stop(server);
  await stop(runner);
  server = await startSpecola(port, { SPECOLA_DEV_AUTH_EMAIL: DEV_USER });
  await disabled(id);
}

async function enabled() {
  const me = await api('GET', '/api/me');
  check(me.backends?.enabled === true && me.backends?.available === true, 'GET /api/me: backends enabled and available', me.backends);

  const up = await api('POST', '/api/bundle-uploads', { kind: 'new', title: TITLE, note: 'v1' });
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
  await viewer.getByRole('button', { name: 'Backend', exact: true }).click();
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
  v1Count = before;
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

  const { version } = await api('GET', `/api/pages/${id}`);
  const call = await fetch(`${app}/api/pages/${id}/x/api/counter`, { headers: { 'X-Specola-Version': String(version) } });
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

async function dataLifecycle(id) {
  const meta = await api('GET', `/api/pages/${id}`);
  check(meta.backendData === true && meta.backendPurgeAt === undefined, 'page metadata: backendData, no purge date', meta);

  const ctx = await browser.newContext({ acceptDownloads: true });
  const errors = [];
  ctx.on('weberror', (e) => errors.push(String(e.error())));
  try {
    const page = await ctx.newPage();
    await page.goto(`${app}/#/p/${id}`);
    await ready(await pageFrame(page, id));
    await page.getByRole('button', { name: 'Backend', exact: true }).click();
    await page.locator('[data-backend-panel]').getByRole('tab', { name: 'Data' }).click();
    const panel = page.locator('[data-backend-data]');
    await panel.locator('[data-usage=data]').waitFor();
    const data = await api('GET', `/api/pages/${id}/backend/data`);
    check(data.usage?.pageBytes > 0 && data.usage.pageLimit > 0 && data.usage.snapshotLimit > 0, 'GET …/backend/data: the usage', data.usage);
    const v1Snap = data.snapshots?.find((s) => s.kind === 'version' && s.version === 1);
    check(v1Snap && /^[0-9]{8}T[0-9]{6}Z-version-v1$/.test(v1Snap.id), 'version 1\'s snapshot is listed', data.snapshots);
    check(await panel.locator(`[data-snapshot="${v1Snap?.id}"][data-kind=version]`).isVisible(), 'the panel lists it');

    // A manual snapshot, the data changed, the snapshot restored.
    const c0 = (await x(id, '/api/counter')).json.count;
    await panel.getByLabel('Snapshot label').fill('e2e before');
    await panel.getByRole('button', { name: 'Take snapshot' }).click();
    const manualItem = panel.locator('[data-kind=manual]', { hasText: 'e2e before' });
    await manualItem.waitFor();
    const manual = (await api('GET', `/api/pages/${id}/backend/data`)).snapshots.find((s) => s.kind === 'manual');
    check(manual?.label === 'e2e before' && /^[0-9]{8}T[0-9]{6}Z-manual$/.test(manual.id) && manual.sizeBytes > 0, 'a manual snapshot taken from the panel', manual);
    await x(id, '/api/counter', { method: 'POST' });
    check((await x(id, '/api/counter', { method: 'POST' })).json.count === c0 + 2, 'the data changed since');
    await manualItem.getByRole('button', { name: 'Restore' }).click();
    const dialog = page.locator('[data-confirm-dialog]');
    check(/every user's own data/.test(await dialog.textContent()), 'the restore dialog says every user\'s data is replaced');
    await dialog.getByRole('button', { name: 'Restore data' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 30000 });
    // The page reloads on the restored data, and counts its visit.
    check(await shows(page, id, c0 + 1), 'restored: the page shows the counter as it was, plus its visit', c0);
    const afterRestore = (await api('GET', `/api/pages/${id}/backend/data`)).snapshots;
    check(afterRestore[0]?.kind === 'before-restore', 'a before-restore snapshot was taken first', afterRestore.map((s) => s.id));

    // Export from the panel.
    const counted = (await x(id, '/api/counter')).json.count;
    const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('link', { name: 'Export' }).click()]);
    check(download.suggestedFilename() === `${TITLE}-data.zip`, 'the export downloads as <title>-data.zip', download.suggestedFilename());
    const zipPath = join(tmp, 'export.zip');
    await download.saveAs(zipPath);
    const exported = readExport(zipPath);
    check(
      exported.manifest?.format === 'specola-backend-data' && exported.manifest.formatVersion === 1 && exported.manifest.page?.id === id && exported.manifest.page.version === 2 && exported.manifest.page.title === TITLE && !!exported.manifest.exportedAt,
      'the zip\'s manifest.json',
      exported.manifest,
    );
    const blob = sampleBytes();
    const entry = exported.index?.find((f) => f.key === 'uploads/blob.bin');
    check(entry?.size === blob.length && entry.sha256 === sha256(blob) && entry.contentType === 'application/x-e2e', 'files/index.json names the upload', exported.index);
    check(exported.files['uploads/blob.bin']?.equals(blob), 'files/data/ holds the upload, byte for byte');
    check((await counterIn(exported.shared)) === counted, 'shared.sqlite holds the counter', counted);
    check(!exported.names.some((n) => n.startsWith('users')), 'users\' databases are not in the export', exported.names);

    // Reset the shared data: typing the title arms the button.
    await panel.getByRole('button', { name: 'Reset shared data and files…' }).click();
    const reset = dialog.getByRole('button', { name: 'Reset', exact: true });
    check(await reset.isDisabled(), 'the reset waits for the page\'s title');
    await dialog.getByRole('textbox').fill(TITLE);
    await reset.click();
    await dialog.waitFor({ state: 'detached', timeout: 30000 });
    check(await shows(page, id, 1), 'reset: the counter starts over');
    check((await x(id, '/api/upload?name=blob.bin')).status === 404, 'reset: the file is gone');
    check((await x(id, '/api/note')).json?.note === 'note of the dev user', 'reset: users\' own data is kept');

    // The export imported back from the panel.
    await panel.locator('input[type=file]').setInputFiles(zipPath);
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 60000 });
    check(await shows(page, id, counted + 1), 'imported: the counter is back (plus the visit)', counted);
    const back = await x(id, '/api/upload?name=blob.bin');
    check(back.status === 200 && back.buf.equals(blob) && back.headers.get('content-type') === 'application/x-e2e', 'imported: the file is back byte for byte, with its type');
    const again = readExport(await saveBody(await raw('GET', `/api/pages/${id}/backend/export`), 'export-2.zip'));
    check(JSON.stringify(again.index) === JSON.stringify(exported.index) && again.files['uploads/blob.bin']?.equals(blob), 'a new export has the same files', again.index);
    const kinds = (await api('GET', `/api/pages/${id}/backend/data`)).snapshots.map((s) => s.kind);
    check(kinds[0] === 'before-import' && kinds.includes('before-wipe'), 'before-wipe and before-import snapshots', kinds);

    // A zip reaching outside its layout changes nothing.
    const { craftZip, exportEntries } = await import('../runner/test/zipcraft.js');
    const evil = craftZip([...exportEntries({ files: [{ key: 'a', data: 'a' }] }), { name: 'files/data/../../../state/evil.json', data: '{}' }]);
    const snapsBefore = (await api('GET', `/api/pages/${id}/backend/data`)).snapshots.length;
    const countBefore = (await x(id, '/api/counter')).json.count;
    const refused = await raw('PUT', `/api/pages/${id}/backend/import`, { headers: { 'Content-Type': 'application/zip' }, body: evil });
    const rbody = await refused.json().catch(() => null);
    check(refused.status === 400 && refused.headers.get('x-specola-error') === 'bad-import' && rbody?.error === 'bad-import' && /\.\./.test(rbody.message), 'a path-traversal zip: 400 bad-import, naming what is wrong', { status: refused.status, body: rbody });
    check((await x(id, '/api/counter')).json.count === countBefore && (await x(id, '/api/upload?name=blob.bin')).status === 200, 'it changed no data');
    check((await api('GET', `/api/pages/${id}/backend/data`)).snapshots.length === snapsBefore, 'it took no snapshot');
    check(!findFile(runnerData, 'evil.json'), 'it wrote nothing outside the page');

    // An editor exports, but restores, imports and resets nothing.
    await as(EDITOR, '/api/me');
    await api('PUT', `/api/pages/${id}/acl`, { sub: EDITOR, role: 'editor' });
    const edExport = await as(EDITOR, `/api/pages/${id}/backend/export`);
    const edZip = Buffer.from(await edExport.arrayBuffer());
    check(edExport.status === 200 && edExport.headers.get('content-type') === 'application/zip' && edZip.subarray(0, 2).toString() === 'PK', 'an editor may export', edExport.status);
    check((await as(EDITOR, `/api/pages/${id}/backend/data`)).status === 200, 'an editor may see the snapshots');
    const sid = manual.id;
    for (const [what, method, path, init] of [
      ['restore', 'POST', `/backend/snapshots/${sid}/restore`],
      ['import', 'PUT', '/backend/import', { headers: { 'Content-Type': 'application/zip' }, body: edZip }],
      ['reset', 'POST', '/backend/wipe', { headers: { 'Content-Type': 'application/json' }, body: '{"scope":"shared"}' }],
      ['snapshot', 'POST', '/backend/snapshots', { headers: { 'Content-Type': 'application/json' }, body: '{"label":"x"}' }],
    ]) {
      const res = await as(EDITOR, `/api/pages/${id}${path}`, { method, ...init });
      check(res.status === 403 && res.headers.get('x-specola-error') === 'forbidden', `an editor gets 403 forbidden on ${what}`, res.status);
    }
    check((await x(id, '/api/counter')).json.count === countBefore, 'the editor changed nothing');

    // A viewer's own data, from the panel of their viewer.
    await viewerData(id);

    // Version 1 restored from the history, with its data.
    await x(id, '/api/note', { method: 'PUT', body: 'changed note' });
    await page.getByRole('button', { name: 'History' }).click();
    await page.locator('aside[aria-label="Version history"] button', { hasText: /^\s*v1/ }).click();
    await page.getByRole('button', { name: 'Restore as v3' }).click();
    check(/Also restore the data as version 1 left it/.test(await dialog.textContent()), 'the history restore offers version 1\'s data');
    check(!(await dialog.locator('[data-restore-data]').isChecked()), 'unticked by default');
    await dialog.locator('[data-restore-data]').check();
    await dialog.getByRole('button', { name: 'Restore as v3' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 30000 });
    check(!(await page.locator('[data-restore-data-failed]').count()), 'no data-restore failure');
    const v3 = await api('GET', `/api/pages/${id}`);
    check(v3.version === 3 && v3.backend === true, 'version 3 is current', v3.version);
    const note = await x(id, '/api/note');
    check(note.json?.note === 'note of the dev user', 'version 1\'s data is back (the note as it left it)', note.json);
    // The frame counts a visit once or twice (it may reload on v3 before the
    // data is restored, and again after).
    const count = (await x(id, '/api/counter')).json.count;
    check(count === v1Count + 1 || count === v1Count + 2, 'version 1\'s counter is back (plus the visits)', { v1Count, count });
    check((await x(id, '/api/upload?name=blob.bin')).buf?.equals(blob), 'version 1\'s file is back');
    check(errors.length === 0, 'no uncaught errors in the viewer or the frame', errors);
  } finally {
    await ctx.close();
  }
}

// viewerData: a viewer downloads their own data from the panel, deletes it,
// and has none left; the shared data's routes stay closed to them.
async function viewerData(id) {
  const { version } = await api('GET', `/api/pages/${id}`);
  const put = await as(VIEWER, `/api/pages/${id}/x/api/note`, { method: 'PUT', headers: { 'X-Specola-Version': String(version) }, body: 'note of the viewer' });
  check(put.status === 204, 'the viewer writes a note to their own database', put.status);
  for (const path of ['/backend/data', '/backend/export']) {
    const res = await as(VIEWER, `/api/pages/${id}${path}`);
    check(res.status === 403 && res.headers.get('x-specola-error') === 'forbidden', `a viewer gets 403 on ${path}`, res.status);
  }
  // The user header goes in at the network layer: as a page header it would
  // make the sandboxed frame's own loads cross-origin requests with a
  // custom header, which need a preflight.
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.route((url) => url.origin === viewerApp, (route) => route.continue({ headers: { ...route.request().headers(), [USER_HEADER.toLowerCase()]: VIEWER } }));
  try {
    const page = await ctx.newPage();
    await page.goto(`${viewerApp}/#/p/${id}`);
    await ready(await pageFrame(page, id));
    await page.getByRole('button', { name: 'Backend', exact: true }).click();
    const panel = page.locator('[data-backend-data]');
    await panel.waitFor();
    check(!(await page.locator('[data-backend-panel] [role=tab]').count()) && !(await panel.getByRole('link', { name: 'Export' }).count()), 'a viewer\'s panel has their own data only');
    const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Download my data' }).click()]);
    check(download.suggestedFilename() === `${TITLE}-my-data.sqlite`, 'my data downloads as <title>-my-data.sqlite', download.suggestedFilename());
    const file = join(tmp, 'my-data.sqlite');
    await download.saveAs(file);
    check(readFileSync(file).subarray(0, 16).toString('latin1') === 'SQLite format 3\0', 'it is a SQLite database');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT body FROM note').all().map((r) => r.body);
    db.close();
    check(rows.length === 1 && rows[0] === 'note of the viewer', 'with the viewer\'s rows', rows);
    const head = await as(VIEWER, `/api/pages/${id}/backend/my-data`);
    check(head.headers.get('content-type') === 'application/vnd.sqlite3' && /attachment/.test(head.headers.get('content-disposition')), 'GET …/my-data: application/vnd.sqlite3, as an attachment', Object.fromEntries(head.headers));
    await head.arrayBuffer();

    await panel.getByRole('button', { name: 'Delete my data…' }).click();
    const dialog = page.locator('[data-confirm-dialog]');
    await dialog.getByRole('button', { name: 'Delete my data' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 30000 });
    const gone = await as(VIEWER, `/api/pages/${id}/backend/my-data`);
    const body = await gone.json().catch(() => null);
    check(gone.status === 404 && gone.headers.get('x-specola-error') === 'no-data' && body?.error === 'no-data', 'then GET …/my-data answers 404 no-data', gone.status);
    const twice = await as(VIEWER, `/api/pages/${id}/backend/my-data`, { method: 'DELETE' });
    check(twice.status === 204, 'deleting it again answers 204', twice.status);
    check((await x(id, '/api/note')).json?.note === 'note of the dev user', 'other users\' data is untouched');
  } finally {
    await ctx.close();
  }
}

async function purge(id) {
  // The purge's first round is a minute after start; everything up to the
  // last step is done well before.
  const started = Date.now();
  const meta = await api('GET', `/api/pages/${id}`);
  check(meta.backendData === true && meta.backendPurgeAt === undefined, 'a live page has no purge date', meta.backendPurgeAt);
  await api('POST', `/api/pages/${id}/archive`);
  sql(`UPDATE asset SET archived_at = now() - interval '${PURGE_DAYS - 5} days' WHERE id = '${id}'`);
  const item = (await api('GET', '/api/archived')).find((it) => it.id === id);
  const due = Date.now() + 5 * 86400e3;
  check(item && Math.abs(Date.parse(item.backendPurgeAt) - due) < 3600e3, 'the Archived list carries the purge date, 5 days ahead', item);
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`${app}/#/`);
    await page.getByRole('button', { name: 'Archived' }).click();
    const notice = page.locator('[data-purge-notice]');
    await notice.waitFor({ timeout: 10000 }).catch(() => {});
    check(/Backend data will be deleted on/.test((await notice.textContent().catch(() => '')) ?? ''), 'the Archived list shows it');
  } finally {
    await ctx.close();
  }
  const pageDir = join(runnerData, 'pages', id);
  const snapsDir = join(runnerData, 'snapshots', id);
  check(existsSync(pageDir) && existsSync(snapsDir), 'the runner still has the data');
  check(Date.now() - started < 50000, 'set up before the first purge round', Date.now() - started);
  sql(`UPDATE asset SET archived_at = now() - interval '${PURGE_DAYS + 1} days' WHERE id = '${id}'`);
  const purged = await waitFor(() => !existsSync(pageDir) && !existsSync(snapsDir) && sql(`SELECT backend_used_at IS NULL FROM asset WHERE id = '${id}'`) === 't', 'the purge', 150000).catch(() => false);
  check(purged, 'the purge deleted the runner\'s data and snapshots, and the mark');
  const after = (await api('GET', '/api/archived')).find((it) => it.id === id);
  check(after && after.backendPurgeAt === undefined, 'no purge date once purged', after);
  await api('POST', `/api/pages/${id}/unarchive`);
  check((await api('GET', `/api/pages/${id}`)).backendData === false, 'unarchived: the page has no backend data');
}

async function secrets(id) {
  const meta = await api('GET', `/api/pages/${id}`);
  check(same(meta.backendSecretsMissing, ['OPENAI_API_KEY']), 'backendSecretsMissing names the declared secret', meta.backendSecretsMissing);
  const edMeta = await (await as(EDITOR, `/api/pages/${id}`)).json();
  check(same(edMeta.backendSecretsMissing, ['OPENAI_API_KEY']), 'an editor sees it too', edMeta.backendSecretsMissing);
  const viewerMeta = await (await as(VIEWER, `/api/pages/${id}`)).json();
  check(viewerMeta.backendSecretsMissing === undefined, 'a viewer does not', viewerMeta.backendSecretsMissing);
  const none = (await x(id, '/api/secret')).json;
  check(none?.has === false && same(none.names, []), 'the handler has no secret yet', none);

  // Editors read the list, set nothing; viewers neither.
  const edList = await as(EDITOR, `/api/pages/${id}/secrets`);
  const edBody = await edList.json().catch(() => null);
  check(edList.status === 200 && same(edBody?.secrets, [{ name: 'OPENAI_API_KEY', declared: true, set: false }]), 'an editor lists the secrets: declared, not set', edBody);
  const edPut = await as(EDITOR, `/api/pages/${id}/secrets/OPENAI_API_KEY`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'editor value' }) });
  check(edPut.status === 403 && edPut.headers.get('x-specola-error') === 'forbidden', 'an editor gets 403 forbidden setting a secret', edPut.status);
  const vList = await as(VIEWER, `/api/pages/${id}/secrets`);
  check(vList.status === 403, 'a viewer gets 403 on the secrets list', vList.status);

  // The owner sets it from the viewer, at phone width: the notice opens the
  // Secrets tab.
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const errors = [];
  ctx.on('weberror', (e) => errors.push(String(e.error())));
  try {
    const page = await ctx.newPage();
    await page.goto(`${app}/#/p/${id}`);
    await ready(await pageFrame(page, id));
    const notice = page.locator('[data-secrets-missing]');
    await notice.waitFor({ timeout: 10000 }).catch(() => {});
    check(await notice.isVisible(), 'the viewer shows the missing-secret notice');
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check(await fits(), 'at 375 px, with the notice, the viewer does not scroll sideways');
    await notice.click();
    const panel = page.locator('[data-backend-secrets]');
    const row = panel.locator('[data-secret="OPENAI_API_KEY"]');
    await row.waitFor();
    check((await row.getAttribute('data-set')) === 'false', 'the Secrets tab lists it as not set');
    await row.getByRole('button', { name: 'Set OPENAI_API_KEY' }).click();
    await panel.getByLabel('Secret value').fill(SECRET);
    await panel.locator('[data-secret-form] button[type=submit]').click();
    const set = await waitFor(async () => (await row.getAttribute('data-set')) === 'true', 'the secret set', 10000).catch(() => false);
    check(set, 'the owner set it from the Secrets tab');
    check(await fits(), 'nor with the Secrets tab open');
    check(!(await page.content()).includes(SECRET), 'the value is not left in the viewer');
    const gone = await waitFor(async () => !(await notice.count()), 'the notice to go', 10000).catch(() => false);
    check(gone, 'the notice goes once the secret is set');
    check(errors.length === 0, 'no uncaught errors in the viewer', errors);
  } finally {
    await ctx.close();
  }

  const after = await api('GET', `/api/pages/${id}`);
  check(same(after.backendSecretsMissing, []), 'backendSecretsMissing is empty once set', after.backendSecretsMissing);
  const list = await api('GET', `/api/pages/${id}/secrets`);
  const info = list.secrets?.[0];
  check(list.secrets?.length === 1 && info.set === true && info.declared === true && info.updatedBy === DEV_USER && !!info.updatedAt, 'GET …/secrets: set, by whom and when', list);
  check(!JSON.stringify(list).includes(SECRET) && !JSON.stringify(after).includes(SECRET), 'the API never shows the value');
  const stored = sql(`SELECT count(*) FROM page_secret WHERE asset_id = '${id}' AND name = 'OPENAI_API_KEY' AND position(convert_to('${SECRET}', 'UTF8') in ciphertext) = 0 AND length(nonce) = 12`);
  check(stored === '1', 'the database holds it encrypted, with a 12-byte nonce', stored);
  const has = (await x(id, '/api/secret')).json;
  check(has?.has === true && has.length === SECRET.length && same(has.names, ['OPENAI_API_KEY']) && has.frozen === true, 'the handler has the secret (ctx.secrets, frozen)', has);

  // A name the version does not declare: set, listed, never passed.
  await api('PUT', `/api/pages/${id}/secrets/UNDECLARED`, { value: 'x' });
  const both = await api('GET', `/api/pages/${id}/secrets`);
  check(same(both.secrets.map((s) => [s.name, s.declared, s.set]), [['OPENAI_API_KEY', true, true], ['UNDECLARED', false, true]]), 'an undeclared secret is listed, not declared', both.secrets);
  check(same((await x(id, '/api/secret')).json?.names, ['OPENAI_API_KEY']), 'and never reaches the handler');
  const bad = await raw('PUT', `/api/pages/${id}/secrets/not-a-name!`, { headers: { 'Content-Type': 'application/json' }, body: '{"value":"x"}' });
  check(bad.status === 400 && bad.headers.get('x-specola-error') === 'bad-request', 'an invalid name: 400 bad-request', bad.status);
  await api('DELETE', `/api/pages/${id}/secrets/UNDECLARED`);
  check((await raw('DELETE', `/api/pages/${id}/secrets/UNDECLARED`)).status === 204, 'deleting an unset secret answers 204');
}

async function egress(id) {
  const seen = [];
  const outside = createHTTPServer((req, res) => {
    seen.push(req.url);
    res.end(`hello from outside ${req.url}`);
  });
  await new Promise((r) => outside.listen(0, '127.0.0.1', r));
  const p = outside.address().port;
  try {
    const ok = await x(id, `/api/egress?url=${encodeURIComponent(`http://localhost:${p}/hi`)}`);
    check(ok.json?.ok === true && ok.json.status === 200 && ok.json.text === 'hello from outside /hi' && seen.includes('/hi'), 'a backend fetch reaches a host on its egress list', ok.json);
    const refused = await x(id, `/api/egress?url=${encodeURIComponent(`http://refused.example:${p}/no`)}`);
    check(refused.json && (refused.json.ok === false || refused.json.status === 403) && !seen.includes('/no'), 'a host not on the list is refused', refused.json);
    const line = `egress refused: refused.example:${p} (not in the backend's egress list)`;
    const logs = await api('GET', `/api/pages/${id}/backend/logs`);
    check(logs.lines?.some((l) => l.level === 'warn' && l.text === line), 'the refusal is in the backend log', logs.lines?.slice(-5));
  } finally {
    await new Promise((r) => outside.close(r));
  }
}

async function scheduledJobs(id) {
  const job = await waitFor(async () => {
    const j = (await api('GET', `/api/pages/${id}/backend/cron`)).jobs?.find((j) => j.name === 'tick');
    return j?.lastStatus && j;
  }, 'the job "tick" to run', 30000).catch(() => null);
  check(job?.lastStatus === 'ok' && job.schedule === '* * * * *' && typeof job.lastDurationMs === 'number' && job.lastError === undefined, 'the job "tick" ran: ok', job);
  check(job && Date.parse(job.nextRunAt) > Date.parse(job.lastRunAt) && new Date(job.nextRunAt).getUTCSeconds() === 0, 'its next run is the next minute', job);
  const runs = (await x(id, '/api/runs')).json?.runs ?? [];
  const last = runs.at(-1);
  check(last?.name === 'tick' && last.role === 'cron' && last.hasUser === 0 && last.scheduledTime % 60000 === 0, 'scheduled() ran with role cron and no user, and wrote to ctx.db', last);
  const ed = await as(EDITOR, `/api/pages/${id}/backend/cron`);
  check(ed.status === 200, 'an editor lists the jobs', ed.status);
  check((await as(VIEWER, `/api/pages/${id}/backend/cron`)).status === 403, 'a viewer gets 403 on the jobs');

  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`${app}/#/p/${id}`);
    await ready(await pageFrame(page, id));
    await page.getByRole('button', { name: 'Backend', exact: true }).click();
    await page.locator('[data-backend-panel]').getByRole('tab', { name: 'Jobs' }).click();
    const row = page.locator('[data-backend-jobs] [data-job="tick"]');
    await row.waitFor({ timeout: 10000 }).catch(() => {});
    check((await row.getAttribute('data-status').catch(() => null)) === 'ok', 'the Jobs tab shows "tick" with status ok');
    check(/\* \* \* \* \*/.test((await row.textContent().catch(() => '')) ?? ''), 'with its schedule');
  } finally {
    await ctx.close();
  }
}

async function mcp(id) {
  const init = await mcpRequest('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  const instructions = init?.instructions ?? '';
  check(['call_backend', 'backend_logs', 'backend_query', 'list_secrets', 'publish(topic', 'subscribe', 'egress', 'scheduled', 'public'].every((w) => instructions.includes(w)), 'the MCP instructions describe backends and the testing tools', instructions.slice(0, 200));
  const tools = (await mcpRequest('tools/list', {}))?.tools?.map((t) => t.name) ?? [];
  check(['call_backend', 'backend_logs', 'backend_query', 'list_secrets'].every((t) => tools.includes(t)), 'the four backend tools are listed', tools);

  const count = (await x(id, '/api/counter')).json.count;
  const called = await mcpTool('call_backend', { id, method: 'GET', path: '/api/counter' });
  const body = called.data?.body && JSON.parse(called.data.body);
  check(!called.isError && called.data.status === 200 && called.data.body_encoding === 'utf-8' && called.data.truncated === false && body?.count === count, 'call_backend calls the current version as the user', called.data);
  const thrown = await mcpTool('call_backend', { id, path: '/api/throw' });
  check(thrown.data?.status === 500 && thrown.data.headers?.['x-specola-error'] === 'backend-error', 'call_backend relays an error answer', thrown.data);

  const logs = await mcpTool('backend_logs', { id });
  const ref = thrown.data?.body && JSON.parse(thrown.data.body).ref;
  check(!logs.isError && logs.data?.lines?.some((l) => l.ref === ref && l.text.includes('e2e boom')), 'backend_logs has the error under its ref', logs.data?.lines?.length);

  const q = await mcpTool('backend_query', { id, sql: 'SELECT n FROM counter WHERE id = ?', params: [1] });
  check(!q.isError && same(q.data?.columns, ['n']) && Number(q.data.rows?.[0]?.[0]) === count && q.data.truncated === false, 'backend_query reads the counter table', q.data);
  const write = await mcpTool('backend_query', { id, sql: 'UPDATE counter SET n = 0' });
  check(write.isError && (await x(id, '/api/counter')).json.count === count, 'backend_query refuses a write', write.text);

  const sec = await mcpTool('list_secrets', { id });
  check(!sec.isError && sec.data?.secrets?.some((s) => s.name === 'OPENAI_API_KEY' && s.set) && same(sec.data.missing ?? [], []) && /owner/i.test(sec.data.note ?? ''), 'list_secrets: names, set, none missing, owners set them in the UI', sec.data);
  check(!JSON.stringify(sec).includes(SECRET), 'list_secrets never shows a value');
  const page = await mcpTool('get_page', { id });
  check(page.data?.backend?.manifest?.cron?.[0]?.name === 'tick' && same(page.data.backend.secrets_missing, []), 'get_page carries backend: {manifest, secrets_missing}', page.data?.backend);
}

async function push(id) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  // The viewer's identity goes in at the network layer (see viewerData).
  await ctxB.route((url) => url.origin === viewerApp, (route) => route.continue({ headers: { ...route.request().headers(), [USER_HEADER.toLowerCase()]: VIEWER } }));
  try {
    const pageA = await ctxA.newPage();
    await pageA.goto(`${app}/#/p/${id}`);
    const frameA = await pageFrame(pageA, id);
    await ready(frameA);
    const pageB = await ctxB.newPage();
    await pageB.goto(`${viewerApp}/#/p/${id}`);
    const frameB = await pageFrame(pageB, id);
    await ready(frameB);
    const listen = (f) => f.evaluate(() => {
      window.__got = [];
      window.__unsub = window.specola.subscribe('chat', (data, topic) => window.__got.push({ topic, data }));
    });
    await listen(frameA);
    await listen(frameB);
    const got = (f) => f.evaluate(() => window.__got);
    const send = (body) => call(frameA, '/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    // Streams open on their own time and push has no replay: publish until
    // both have heard one.
    let n = 0;
    const heard = await waitFor(async () => {
      await send({ topic: 'chat', data: { hello: 'from the owner', n: ++n } });
      await sleep(300);
      return (await got(frameA)).length > 0 && (await got(frameB)).length > 0;
    }, 'both subscribers to hear a push', 20000).catch(() => false);
    const b = await got(frameB);
    check(heard && b[0]?.topic === 'chat' && b[0].data?.hello === 'from the owner', "the owner's call publishes and the viewer's subscribe callback fires (another Specola)", b);

    // Targeted pushes, then a broadcast that marks the end.
    await frameA.evaluate(() => (window.__got = []));
    await frameB.evaluate(() => (window.__got = []));
    await send({ topic: 'chat', data: { for: 'viewer' }, to: VIEWER });
    await send({ topic: 'chat', data: { for: 'owner' }, to: DEV_USER });
    await send({ topic: 'chat', data: { end: true } });
    const ended = await waitFor(async () => (await got(frameA)).some((m) => m.data.end) && (await got(frameB)).some((m) => m.data.end), 'the end marker', 10000).catch(() => false);
    const a = (await got(frameA)).map((m) => m.data);
    const v = (await got(frameB)).map((m) => m.data);
    check(ended && same(a, [{ for: 'owner' }, { end: true }]) && same(v, [{ for: 'viewer' }, { end: true }]), 'a targeted push reaches only its user', { owner: a, viewer: v });

    // Unsubscribed: nothing more arrives.
    await frameB.evaluate(() => {
      window.__unsub();
      window.__got = [];
    });
    await send({ topic: 'chat', data: { after: 'unsubscribe' } });
    await waitFor(async () => (await got(frameA)).some((m) => m.data.after), 'the owner to hear it', 10000).catch(() => {});
    await sleep(500);
    check((await got(frameB)).length === 0, 'after unsubscribe() the callback stays quiet');

    // A new version: the open streams send superseded, the viewer notices.
    const up = await api('POST', '/api/bundle-uploads', { kind: 'version', id, note: 'push superseded' });
    const published = publish(up.uploadUrl);
    check(published.ok, 'a new version published', published);
    const noticed = await waitFor(() => pageA.locator('[data-superseded]').isVisible(), 'the reload notice', 30000).catch(() => false);
    check(noticed, 'the stream says superseded and the viewer shows its reload notice');
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
}

async function publicLink(id) {
  const link = await api('POST', `/api/pages/${id}/links`, { label: LINK_LABEL });
  const tok = link.url.split('/s/')[1];
  const shell = await fetch(link.url);
  const html = await shell.text();
  check(
    shell.status === 200 && shell.headers.get('content-security-policy') === SHELL_CSP && /no-store/.test(shell.headers.get('cache-control')) && shell.headers.get('referrer-policy') === 'no-referrer' && /noindex/.test(shell.headers.get('x-robots-tag')) && !html.includes('SPECOLA_SHELL_BOOT'),
    '/s/<token> serves the shell, with its CSP and headers',
    Object.fromEntries(shell.headers),
  );
  const { version } = await api('GET', `/api/pages/${id}`);
  const before = (await x(id, '/api/counter')).json.count;

  const ctx = await browser.newContext();
  const errors = [];
  ctx.on('weberror', (e) => errors.push(String(e.error())));
  try {
    const page = await ctx.newPage();
    await page.goto(link.url);
    const f = await waitFor(() => page.frames().find((fr) => fr.url().includes(`/s/${tok}/~page`)), 'the shell to frame the page');
    await f.waitForFunction(() => window.specola?.backend?.available, null, { timeout: 20000 });
    const hello = await call(f, '/api/public/hello');
    check(hello.status === 200 && hello.json?.role === 'public' && hello.json.user === null && hello.json.userDb === true && hello.json.link?.id === link.id && hello.json.link.label === LINK_LABEL, 'a public route answers, with role public and ctx.link', hello);
    const closed = await call(f, '/api/counter', { method: 'POST' });
    check(closed.status === 403 && closed.headers['x-specola-error'] === 'not-public', 'a route that is not public answers 403 not-public', closed);
    check((await x(id, '/api/counter')).json.count === before, 'without reaching the backend');

    await f.evaluate(() => {
      window.__got = [];
      window.specola.subscribe('news', (data, topic) => window.__got.push({ topic, data }));
    });
    let n = 0;
    const heard = await waitFor(async () => {
      await x(id, '/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'news', data: { n: ++n } }) });
      await sleep(300);
      return (await f.evaluate(() => window.__got.length)) > 0;
    }, 'the public topic', 20000).catch(() => false);
    check(heard, 'a push on a public topic reaches the public page');
    check(errors.length === 0, 'no uncaught errors in the shell or the page', errors);
  } finally {
    await ctx.close();
  }
  const topic = await fetch(`${app}/p/${tok}/events?v=${version}&topic=chat`);
  check(topic.status === 403 && topic.headers.get('x-specola-error') === 'not-public', 'a topic that is not public: 403 not-public', topic.status);

  // The rate limit per link and client IP (60 a minute).
  let res;
  for (let i = 0; i < 70; i++) {
    res = await fetch(`${app}/p/${tok}/x/api/public/hello`, { headers: { 'X-Specola-Version': String(version) } });
    if (res.status === 429) break;
    await res.arrayBuffer();
  }
  check(res.status === 429 && res.headers.get('x-specola-error') === 'too-many-requests' && Number(res.headers.get('retry-after')) > 0, 'public calls are rate limited: 429 with Retry-After', { status: res.status, retryAfter: res.headers.get('retry-after') });

  await api('DELETE', `/api/pages/${id}/links/${link.id}`);
  const revoked = await fetch(`${app}/p/${tok}/x/api/public/hello`, { headers: { 'X-Specola-Version': String(version) } });
  check(revoked.status === 404, 'a revoked link stops calls at once', revoked.status);
}

// ---- helpers

// mcpRequest sends one JSON-RPC request to the MCP endpoint (stateless,
// JSON answers) as the dev user, and returns its result.
async function mcpRequest(method, params) {
  const res = await fetch(`${app}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomBytes(4).readUInt32BE(), method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`MCP ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

// mcpTool calls a tool and returns its structured result (or its text).
async function mcpTool(name, args) {
  const r = await mcpRequest('tools/call', { name, arguments: args });
  const text = r.content?.map((c) => c.text).join('') ?? '';
  let data = r.structuredContent;
  if (data === undefined) {
    try {
      data = JSON.parse(text);
    } catch {}
  }
  return { isError: !!r.isError, data, text };
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// x calls the page's backend as the dev user, on the current version.
async function x(id, path, init = {}) {
  const { version } = await api('GET', `/api/pages/${id}`);
  const res = await fetch(`${app}/api/pages/${id}/x${path}`, { ...init, headers: { ...init.headers, 'X-Specola-Version': String(version) } });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {}
  return { status: res.status, headers: res.headers, buf, json };
}

// as sends a request as another user, through the second Specola.
function as(user, path, init = {}) {
  return fetch(viewerApp + path, { ...init, headers: { ...init.headers, [USER_HEADER]: user } });
}

function raw(method, path, init = {}) {
  return fetch(app + path, { method, ...init });
}

async function saveBody(res, name) {
  const file = join(tmp, name);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// shows waits for the page's frame to show the counter at n.
async function shows(page, id, n) {
  return waitFor(async () => {
    for (const f of page.frames()) {
      if (f.url().includes(`/view/${id}`) && (await f.textContent('#count').catch(() => null)) === String(n)) return true;
    }
    return false;
  }, `counter ${n}`, 30000).catch(() => false);
}

// readExport reads an export zip with Info-ZIP's unzip.
function readExport(file) {
  const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const read = (n) => execFileSync('unzip', ['-p', file, n], { maxBuffer: 1 << 30 });
  const json = (n) => (names.includes(n) ? JSON.parse(read(n).toString('utf8')) : null);
  const files = {};
  for (const n of names) if (n.startsWith('files/data/') && !n.endsWith('/')) files[n.slice('files/data/'.length)] = read(n);
  return { names, manifest: json('manifest.json'), index: json('files/index.json'), shared: names.includes('shared.sqlite') ? read('shared.sqlite') : null, files };
}

async function counterIn(sqlite) {
  if (!sqlite) return null;
  const file = join(tmp, `counter-${randomBytes(4).toString('hex')}.sqlite`);
  writeFileSync(file, sqlite);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT n FROM counter').get().n;
  } finally {
    db.close();
  }
}

// The bytes the upload check sends (see enabled()).
function sampleBytes() {
  const bytes = Buffer.alloc(300 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919 + (i >> 8)) & 0xff;
  return bytes;
}

function sha256(b) {
  return createHash('sha256').update(b).digest('hex');
}

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === name) return true;
    if (e.isDirectory() && findFile(join(dir, e.name), name)) return true;
  }
  return false;
}

function sql(q) {
  return execFileSync('psql', [dbURL, '-qtAc', q], { encoding: 'utf8' }).trim();
}

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
