// The page backend in the plugin (docs/page-backends.md, "Plugin and CLI"):
// the server build of test/fixture-backend, and the dev server's handler.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build, createLogger, createServer } from 'vite';
import specola, { devSpecola } from '../index.js';
import { DevFileStore, crossSite, devUser, responseHeaders } from '../lib/dev.js';

const fixture = fileURLToPath(new URL('./fixture-backend', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'specola-plugin-backend-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BACKEND = { public: ['get /api/hello'], secrets: ['API_KEY'] };

async function buildApp(root, outDir, pluginOptions) {
  const logger = createLogger('warn', { allowClearScreen: false });
  logger.warn = () => {};
  logger.error = () => {};
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    customLogger: logger,
    build: { outDir, emptyOutDir: true },
    plugins: [specola(pluginOptions)],
  });
}

function listFiles(dir, rel = '') {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`],
  );
}

/** A copy of the fixture to change, in the scratch directory. */
function copyFixture(name) {
  const dir = join(scratch, name);
  cpSync(fixture, dir, { recursive: true, filter: (src) => !src.includes('.specola-dev') && !src.endsWith('/dist') });
  return dir;
}

const outDir = join(scratch, 'out');
before(async () => {
  await buildApp(fixture, outDir, { server: 'server/index.ts', backend: BACKEND });
});

test('the server is built into .specola/server/, next to the app', () => {
  const files = listFiles(outDir).sort();
  assert.deepEqual(
    files.filter((f) => f.startsWith('.specola/')),
    ['.specola/backend.json', '.specola/server/index.mjs'],
  );
  assert.ok(files.includes('index.html'));
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, '.specola/backend.json'), 'utf8')), {
    version: 1,
    entry: 'server/index.mjs',
    public: ['GET /api/hello'],
    egress: [],
    secrets: ['API_KEY'],
    cron: [],
    topics: { public: [] },
  });
  const server = readFileSync(join(outDir, '.specola/server/index.mjs'), 'utf8');
  assert.match(server, /export \{[^}]*default/, 'an ES module with a default export');
  assert.match(server, /hello, \$\{name\}/, 'greet.ts is bundled in');
  assert.doesNotMatch(server, /^\s*import .* from ["']\.\//m, 'nothing left to resolve next to it');
});

test('the app build has none of the server code', () => {
  for (const f of listFiles(outDir).filter((f) => !f.startsWith('.specola/'))) {
    const text = readFileSync(join(outDir, f), 'utf8');
    assert.doesNotMatch(text, /CREATE TABLE|hello, /, f);
  }
});

test('the built entry runs with a ctx', async () => {
  const mod = await import(pathToFileURL(join(outDir, '.specola/server/index.mjs')).href);
  const db = new DatabaseSync(':memory:');
  const ctx = {
    user: { sub: 'u1', email: 'a@b.c', name: 'Ada' },
    role: 'viewer',
    link: null,
    page: { id: 'p', version: 2, title: 'T' },
    db,
    userDb: null,
    files: null,
    secrets: { API_KEY: 'k' },
    publish() {},
    waitUntil() {},
    log: console,
  };
  let res = await mod.default.fetch(new Request('https://page.invalid/api/hello?x=1'), ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.hello, 'hello, Ada');
  assert.equal(body.query, '?x=1');
  res = await mod.default.fetch(new Request('https://page.invalid/api/notes', { method: 'POST', body: '{"body":"hi"}' }), ctx);
  assert.equal(res.status, 201);
  res = await mod.default.fetch(new Request('https://page.invalid/api/notes'), ctx);
  assert.deepEqual(await res.json(), [{ by: 'u1', body: 'hi' }]);
  res = await mod.default.fetch(new Request('https://page.invalid/api/secret'), ctx);
  assert.deepEqual(await res.json(), { API_KEY: 'k' });
});

test('an app without a server option builds exactly as before', async () => {
  const out = join(scratch, 'static');
  await buildApp(fixture, out, {});
  assert.ok(!existsSync(join(out, '.specola')));
});

test('the build fails on a native addon', async () => {
  const root = copyFixture('native');
  writeFileSync(join(root, 'server', 'addon.node'), 'not really');
  writeFileSync(join(root, 'server', 'index.ts'), "import addon from './addon.node';\nexport default { fetch: () => new Response(String(addon)) };\n");
  await assert.rejects(
    buildApp(root, join(root, 'dist'), { server: 'server/index.ts' }),
    /the backend uses the native addon "\.\/addon\.node" \(imported by server\/index\.ts\): page backends can't load native addons/,
  );

  const loader = copyFixture('native-loader');
  writeFileSync(join(loader, 'server', 'index.ts'), "import bindings from 'bindings';\nexport default { fetch: () => new Response(String(bindings)) };\n");
  await assert.rejects(buildApp(loader, join(loader, 'dist'), { server: 'server/index.ts' }), /native addon loader "bindings"/);
});

test('the build fails when the app imports server code', async () => {
  const root = copyFixture('leak');
  writeFileSync(join(root, 'main.js'), "import { greet } from './server/greet.ts';\ndocument.body.textContent = greet('x');\n");
  await assert.rejects(
    buildApp(root, join(root, 'dist'), { server: 'server/index.ts' }),
    /the app imports server code \(server\/greet\.ts\) into assets\/index-.*\.js: it would be served to every viewer/,
  );
});

test('the app may not write into .specola/', async () => {
  const root = copyFixture('reserved');
  cpSync(join(fixture, 'server'), join(root, 'public', '.specola'), { recursive: true });
  await assert.rejects(buildApp(root, join(root, 'dist'), {}), /\.specola\/ is reserved for the page backend, but the app's build has \.specola\/greet\.ts/);
});

test('an invalid manifest fails the build before anything is built', async () => {
  const out = join(scratch, 'invalid');
  await assert.rejects(buildApp(fixture, out, { server: 'server/index.ts', backend: { egress: ['127.0.0.1'] } }), /IP addresses are not allowed/);
  assert.ok(!existsSync(out));
});

test('the dev stand-in has fetch and backend', async () => {
  const run = (hasBackend, fetchImpl) => {
    const window = {};
    new Function('window', 'fetch', devSpecola(hasBackend))(window, fetchImpl);
    return window.specola;
  };
  const off = run(false, () => assert.fail('no request without a backend'));
  assert.deepEqual({ ...off.backend }, { enabled: false, available: false });
  await assert.rejects(off.fetch('/api'), (err) => err.name === 'BackendUnavailable' && err.reason === 'disabled');

  const calls = [];
  const on = run(true, async (url, init) => {
    calls.push([url, init]);
    return new Response('ok');
  });
  assert.deepEqual({ ...on.backend }, { enabled: true, available: true });
  assert.equal(await (await on.fetch('/api/x?y=1', { method: 'POST' })).text(), 'ok');
  assert.deepEqual(calls, [['/__specola/x/api/x?y=1', { method: 'POST' }]]);
  assert.equal(await (await on.fetch(new Request('https://page.invalid/r?q', { method: 'PUT', body: 'b' }))).text(), 'ok');
  assert.equal(calls[1][0], '/__specola/x/r?q');
  assert.equal(calls[1][1].method, 'PUT');
  assert.equal(new TextDecoder().decode(calls[1][1].body), 'b');
  for (const bad of ['api', 'https://x.test/api', '//x.test/api', '/\\x.test/api', new URL('https://x.test/'), 42]) {
    await assert.rejects(on.fetch(bad), TypeError, String(bad));
  }
  const superseded = run(true, async () => new Response('{"error":"superseded","message":"reload"}', { status: 409, headers: { 'X-Specola-Error': 'superseded' } }));
  await assert.rejects(superseded.fetch('/a'), (err) => err.name === 'BackendUnavailable' && err.reason === 'superseded' && err.message === 'reload');
});

test('SPECOLA_DEV_USER sets the dev user', () => {
  assert.deepEqual({ ...devUser(undefined) }, { sub: 'dev@localhost', email: 'dev@localhost', name: 'dev' });
  assert.deepEqual({ ...devUser('Ada Lovelace <ada@example.com>') }, { sub: 'ada@example.com', email: 'ada@example.com', name: 'Ada Lovelace' });
});

test('the dev file store', async () => {
  const store = new DevFileStore(join(scratch, 'store'));
  try {
    assert.deepEqual(await store.put('a/b.txt', 'hello', { contentType: 'text/plain' }), { key: 'a/b.txt', size: 5, contentType: 'text/plain' });
    await store.put('a/c.html', new Blob(['<p>'], { type: 'text/html' }));
    const f = await store.get('a/b.txt');
    assert.equal(await new Response(f.body).text(), 'hello');
    assert.deepEqual((await store.list('a/')).map((x) => [x.key, x.contentType]), [['a/b.txt', 'text/plain'], ['a/c.html', 'text/html']]);
    assert.equal(await store.delete('a/b.txt'), true);
    assert.equal(await store.delete('a/b.txt'), false);
    assert.equal(await store.get('a/b.txt'), null);
    await assert.rejects(store.put('../x', 'x'), /invalid key "\.\.\/x"/);
  } finally {
    store.close();
  }
});

test('the dev server runs the handler at /__specola/x/', async () => {
  const root = copyFixture('dev');
  const warnings = [];
  const logger = createLogger('warn', { allowClearScreen: false });
  logger.warn = (m) => warnings.push(m);
  process.env.API_KEY_FOR_TEST_ONLY = 'x';
  writeFileSync(join(root, '.env'), 'API_KEY=from-dotenv\nOTHER=hidden\n');
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    customLogger: logger,
    server: { port: 0, hmr: false, host: '127.0.0.1' },
    plugins: [specola({ server: 'server/index.ts', backend: BACKEND })],
  });
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const x = (p, init) => fetch(base + '/__specola/x' + p, init);

    let res = await x('/api/hello?q=1', { headers: { cookie: 'session=secret', 'x-specola-version': '3' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      hello: 'hello, dev',
      role: 'owner',
      page: { id: 'dev', version: 1, title: 'dev' },
      query: '?q=1',
      origin: 'https://page.invalid',
      cookie: null,
      specola: null,
    });

    res = await x('/api/notes', { method: 'POST', body: JSON.stringify({ body: 'first' }) });
    assert.equal(res.status, 201);
    res = await x('/api/notes');
    assert.deepEqual(await res.json(), [{ by: 'dev@localhost', body: 'first' }]);
    assert.ok(existsSync(join(root, '.specola-dev', 'shared.sqlite')));

    assert.equal((await x('/api/mine', { method: 'POST', body: 'mine' })).status, 204);
    assert.deepEqual(await (await x('/api/mine')).json(), { v: 'mine' });

    res = await x('/api/file', { method: 'PUT', body: 'file body', headers: { 'content-type': 'text/x-test' } });
    assert.deepEqual(await res.json(), { key: 'uploads/a.txt', size: 9, contentType: 'text/x-test' });
    res = await x('/api/file');
    assert.equal(await res.text(), 'file body');
    assert.equal(res.headers.get('content-type'), 'text/x-test');

    assert.deepEqual(await (await x('/api/secret')).json(), { API_KEY: 'from-dotenv' }, 'only the declared names');

    res = await x('/api/cookie');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('x-kept'), 'yes');

    // The chunks arrive as they are written, not all at the end.
    res = await x('/api/stream');
    const reader = res.body.getReader();
    const first = await reader.read();
    const t0 = Date.now();
    assert.equal(new TextDecoder().decode(first.value), 'chunk 0\n');
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    assert.equal(rest, 'chunk 1\nchunk 2\n');
    assert.ok(Date.now() - t0 >= 250, 'the later chunks came later');

    assert.equal(await (await x('/api/publish')).text(), 'sent');
    assert.ok(warnings.some((w) => /push is not available yet/.test(w)), warnings.join('\n'));

    res = await x('/api/throw');
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('x-specola-error'), 'backend-error');
    const err = await res.json();
    assert.equal(err.error, 'backend-error');
    assert.ok(errors.some((e) => e.includes(err.ref) && /boom/.test(e)), errors.join('\n'));

    res = await x('/api/big', { method: 'POST', body: new Uint8Array(25 * 1024 * 1024 + 1) });
    assert.equal(res.status, 413);
    assert.equal(res.headers.get('x-specola-error'), 'body-too-large');

    // Another site's page can't post to the dev backend.
    res = await x('/api/notes', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('x-specola-error'), 'forbidden');
    assert.equal((await x('/api/notes', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await x('/api/notes', { headers: { origin: base, 'sec-fetch-site': 'same-origin' } })).status, 200);

    // Editing the server code applies to the next request.
    writeFileSync(join(root, 'server', 'greet.ts'), 'export const greet = (name: string): string => `hi again, ${name}`;\n');
    let hello;
    for (let i = 0; i < 50; i++) {
      hello = (await (await x('/api/hello')).json()).hello;
      if (hello !== 'hello, dev') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(hello, 'hi again, dev');

    // The page gets the stand-in, with the backend on.
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /enabled: true, available: true/);
  } finally {
    console.error = origError;
    delete process.env.API_KEY_FOR_TEST_ONLY;
    await server.close();
  }
});

test('dev: cross-site requests and response headers', () => {
  const req = (headers) => ({ headers: { host: 'localhost:5173', ...headers } });
  assert.equal(crossSite(req({})), false, 'curl');
  assert.equal(crossSite(req({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5173' })), false);
  assert.equal(crossSite(req({ 'sec-fetch-site': 'none' })), false, 'typed in the address bar');
  assert.equal(crossSite(req({ 'sec-fetch-site': 'same-site' })), true);
  assert.equal(crossSite(req({ origin: 'http://localhost:9999' })), true);
  assert.equal(crossSite(req({ origin: 'null' })), true);
  const h = new Headers({ 'clear-site-data': '"*"', nel: '{}', 'access-control-allow-origin': '*', 'x-specola-error': 'superseded', 'set-cookie': 'a=b', 'content-type': 'text/plain', 'x-mine': '1' });
  assert.deepEqual(responseHeaders(h), { 'content-type': 'text/plain', 'x-mine': '1' });
});
