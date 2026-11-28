// The page backend in the plugin (docs/page-backends.md, "Plugin and CLI"):
// the server build of test/fixture-backend, and the dev server's handler.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build, createLogger, createServer } from 'vite';
import specola, { devSpecola } from '../index.js';
import { DevFileStore, checkPush, createDevBackend, crossSite, describeCron, devUser, responseHeaders } from '../lib/dev.js';

const fixture = fileURLToPath(new URL('./fixture-backend', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'specola-plugin-backend-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BACKEND = { public: ['get /api/hello'], secrets: ['API_KEY'] };
// The dev server's: with cron jobs, one of which throws.
const DEV_BACKEND = { ...BACKEND, cron: [{ name: 'nightly', schedule: '0  3 * * *' }, { name: 'broken', schedule: '*/5 * * * *' }] };

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
    dependencies: {},
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
    /the backend uses the native addon "\.\/addon\.node" \(imported by server\/index\.ts\): native addons \(\.node files\) can't be bundled\. Add the package that loads it/,
  );

  const loader = copyFixture('native-loader');
  writeFileSync(join(loader, 'server', 'index.ts'), "import bindings from 'bindings';\nexport default { fetch: () => new Response(String(bindings)) };\n");
  await assert.rejects(buildApp(loader, join(loader, 'dist'), { server: 'server/index.ts' }), /native addon loader "bindings"/);
});

// A package that loads a native addon, as better-sqlite3 does through bindings.
function addNativePackage(root) {
  const pkg = join(root, 'node_modules', 'fake-native');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fake-native', version: '1.2.3', main: 'index.js' }));
  writeFileSync(join(pkg, 'index.js'), "module.exports = require('bindings')('fake');\n");
  writeFileSync(join(root, 'server', 'index.ts'), "import Fake from 'fake-native';\nimport sub from 'fake-native/index.js';\nexport default { fetch: () => new Response(String(Fake) + String(sub)) };\n");
}

test('a native package not declared fails the build, naming it', async () => {
  const root = copyFixture('native-undeclared');
  addNativePackage(root);
  await assert.rejects(
    buildApp(root, join(root, 'dist'), { server: 'server/index.ts' }),
    /native addon loader "bindings" \(imported by node_modules\/fake-native\/index\.js\).*backend: \{ dependencies: \["fake-native"\] \}/,
  );
});

test('dependencies are pinned, left out of the bundle and imported by name', async () => {
  const root = copyFixture('native-declared');
  addNativePackage(root);
  const out = join(root, 'dist');
  await buildApp(root, out, { server: 'server/index.ts', backend: { dependencies: ['fake-native'] } });
  const manifest = JSON.parse(readFileSync(join(out, '.specola', 'backend.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { 'fake-native': '1.2.3' });
  const code = readFileSync(join(out, '.specola', 'server', 'index.mjs'), 'utf8');
  assert.match(code, /from "fake-native"/);
  assert.match(code, /from "fake-native\/index\.js"/);
  assert.doesNotMatch(code, /bindings/);

  await assert.rejects(
    buildApp(root, out, { server: 'server/index.ts', backend: { dependencies: ['not-installed'] } }),
    /the dependency "not-installed" is not installed in the project/,
  );
  await assert.rejects(
    buildApp(root, out, { server: 'server/index.ts', backend: { dependencies: { 'fake-native': '^1.2.3' } } }),
    /"dependencies" "fake-native": the version must be an exact one/,
  );
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
  const infos = [];
  const logger = createLogger('info', { allowClearScreen: false });
  logger.warn = (m) => warnings.push(m);
  logger.info = (m) => infos.push(m);
  process.env.API_KEY_FOR_TEST_ONLY = 'x';
  writeFileSync(join(root, '.env'), 'API_KEY=from-dotenv\nOTHER=hidden\n');
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    customLogger: logger,
    server: { port: 0, hmr: false, host: '127.0.0.1' },
    plugins: [specola({ server: 'server/index.ts', backend: DEV_BACKEND })],
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

    // ctx.publish reaches the open event streams of its topic, and the
    // targeted pushes only when they are for the dev user.
    const stream = await openEvents(base, ['t', 'z']);
    assert.equal(stream.res.headers.get('content-type'), 'text/event-stream');
    assert.equal(await (await x('/api/publish')).text(), 'sent');
    assert.deepEqual(await stream.next(2), [
      { event: 'message', data: { topic: 't', data: { x: 1 } } },
      { event: 'message', data: { topic: 't', data: { mine: true } } },
    ]);
    assert.deepEqual(await (await x('/api/publish-bad')).json(), [
      'TypeError: ctx.publish: the topic must be 1 to 128 letters, digits, _, ., :, / or -; got "bad topic"',
      `TypeError: ctx.publish: the data is ${8 * 1024 + 2} bytes serialised; at most 7168`,
      'TypeError: ctx.publish: the data is not JSON-serialisable (Do not know how to serialize a BigInt)',
      "TypeError: ctx.publish: to must be a user's sub (a non-empty string)",
    ]);

    // POST /__specola/cron/<name> runs scheduled() as cron: no user, its own
    // ctx.publish and secrets; the terminal says how it went.
    res = await fetch(base + '/__specola/cron/nightly', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    const runs = await (await x('/api/runs')).json();
    assert.equal(runs.length, 1);
    assert.deepEqual({ ...runs[0], at: typeof runs[0].at }, { name: 'nightly', at: 'number', role: 'cron', user: 'null', userdb: 'null' });
    assert.ok(Math.abs(runs[0].at - Date.now()) < 60_000);
    assert.deepEqual(await stream.next(1), [{ event: 'message', data: { topic: 't', data: { ran: 'nightly', secret: 'from-dotenv' } } }]);
    assert.ok(infos.some((m) => /scheduled job nightly: run by hand/.test(m)), infos.join('\n'));
    assert.ok(infos.some((m) => /scheduled job nightly: ok \(\d+ ms\)/.test(m)), infos.join('\n'));

    res = await fetch(base + '/__specola/cron/broken', { method: 'POST' });
    const broken = await res.json();
    assert.equal(broken.status, 'error');
    assert.match(broken.ref, /^[0-9a-f]{10}$/);
    assert.ok(errors.some((e) => e.includes(broken.ref) && /cron boom/.test(e)), errors.join('\n'));

    res = await fetch(base + '/__specola/cron/weekly', { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-specola-error'), 'not-found');
    assert.match((await res.json()).message, /the declared jobs are nightly, broken/);
    res = await fetch(base + '/__specola/cron/nightly');
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
    res = await fetch(base + '/__specola/cron/nightly', { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal((await (await x('/api/runs')).json()).length, 1, 'neither ran');

    // The event stream's own errors.
    for (const q of ['', '?topic=bad%20topic', '?' + Array.from({ length: 21 }, (_, i) => `topic=t${i}`).join('&')]) {
      res = await fetch(base + '/__specola/events' + q);
      assert.equal(res.status, 400, q);
      assert.equal(res.headers.get('x-specola-error'), 'bad-request');
    }
    assert.equal((await fetch(base + '/__specola/events?topic=t', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    stream.close();

    // The declared jobs were listed when the dev server started.
    const listed = infos.find((m) => m.includes('scheduled jobs (UTC)'));
    assert.match(listed ?? infos.join('\n'), /nightly {2}0 3 \* \* \*/);
    assert.ok(listed.includes(`curl -X POST http://localhost:${server.httpServer.address().port}/__specola/cron/nightly`), listed);

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
    assert.match(html, /\(function standIn\(cfg\) \{/);
    assert.match(html, /\(\{"backend":true,"fetchPath":"\/__specola\/x","eventsPath":"\/__specola\/events"\}\);/);
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

/**
 * Opens the dev event stream for topics: {res, next(n) → the next n events
 * as {event, data (parsed)}, close()}. Comment lines are skipped.
 */
async function openEvents(base, topics) {
  const abort = new AbortController();
  const res = await fetch(`${base}/__specola/events?${topics.map((t) => `topic=${encodeURIComponent(t)}`).join('&')}`, { signal: abort.signal });
  assert.equal(res.status, 200);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const queue = [];
  return {
    res,
    async next(n) {
      while (queue.length < n) {
        const i = buf.indexOf('\n\n');
        if (i >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = block.split('\n').filter((l) => !l.startsWith(':'));
          if (lines.length === 0) continue;
          const field = (k) => lines.find((l) => l.startsWith(k + ': '))?.slice(k.length + 2);
          queue.push({ event: field('event'), data: JSON.parse(field('data')) });
          continue;
        }
        const { done, value } = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error(`no event in 5 s (got ${JSON.stringify(queue)})`)), 5000))]);
        if (done) throw new Error('the stream ended');
        buf += value;
      }
      return queue.splice(0, n);
    },
    close: () => abort.abort(),
  };
}

test('the dev stand-in subscribes through one shared event stream', async () => {
  const sources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = [];
      this.closed = false;
      sources.push(this);
    }
    addEventListener(type, fn) {
      if (type === 'message') this.listeners.push(fn);
    }
    close() {
      this.closed = true;
    }
    emit(topic, data) {
      for (const fn of this.listeners) fn({ data: JSON.stringify({ topic, data }) });
    }
  }
  const run = (hasBackend) => {
    const window = {};
    const warnings = [];
    const console = { warn: (...a) => warnings.push(a.join(' ')) };
    new Function('window', 'fetch', 'EventSource', 'console', devSpecola(hasBackend))(window, () => assert.fail('no fetch'), FakeEventSource, console);
    return { specola: window.specola, warnings };
  };
  const settle = () => new Promise((r) => setTimeout(r, 150));

  const { specola } = run(true);
  const got = [];
  const stopA = specola.subscribe('scores', (data, topic) => got.push(['a', topic, data]));
  const stopB = specola.subscribe('scores', (data) => got.push(['b', data]));
  const stopC = specola.subscribe('chat/1', (data) => got.push(['c', data]));
  await settle();
  assert.equal(sources.length, 1, 'one stream, opened once for the three calls (debounced)');
  assert.equal(sources[0].url, '/__specola/events?topic=scores&topic=chat%2F1');
  sources[0].emit('scores', { n: 1 });
  sources[0].emit('chat/1', 'hi');
  sources[0].emit('other', 'nobody');
  assert.deepEqual(got, [['a', 'scores', { n: 1 }], ['b', { n: 1 }], ['c', 'hi']]);

  // One of two subscriptions to a topic going changes nothing on the wire.
  stopA();
  stopA();
  await settle();
  assert.equal(sources.length, 1);
  stopC();
  await settle();
  assert.equal(sources.length, 2);
  assert.ok(sources[0].closed);
  assert.equal(sources[1].url, '/__specola/events?topic=scores');
  got.length = 0;
  sources[1].emit('scores', 2);
  assert.deepEqual(got, [['b', 2]]);
  stopB();
  await settle();
  assert.ok(sources[1].closed, 'no topics, no stream');
  assert.equal(sources.length, 2);

  for (const bad of ['', 'a b', 'x'.repeat(129), 42]) assert.throws(() => specola.subscribe(bad, () => {}), TypeError, String(bad));
  assert.throws(() => specola.subscribe('t'), /onMessage must be a function/);
  const stops = Array.from({ length: 20 }, (_, i) => specola.subscribe(`t${i}`, () => {}));
  assert.throws(() => specola.subscribe('t20', () => {}), /at most 20 topics/);
  for (const s of stops) s();

  // Without a backend: subscribing works, nothing is opened, one warning.
  const off = run(false);
  const n = sources.length;
  off.specola.subscribe('a', () => {});
  off.specola.subscribe('b', () => {});
  await settle();
  assert.equal(sources.length, n);
  assert.equal(off.warnings.length, 1);
  assert.match(off.warnings[0], /no pushes will arrive/);
});

test('dev: ctx.publish is checked as on the runner', () => {
  assert.deepEqual(checkPush('a:b/c', { x: 1 }), { topic: 'a:b/c', json: '{"x":1}', to: undefined });
  assert.deepEqual(checkPush('t', null, { to: 'u1' }), { topic: 't', json: 'null', to: 'u1' });
  assert.equal(checkPush('t', 'x'.repeat(7 * 1024 - 2)).json.length, 7 * 1024);
  assert.throws(() => checkPush('t', 'x'.repeat(7 * 1024 - 1)), /7169 bytes serialised; at most 7168/);
  assert.throws(() => checkPush('t', undefined), /not JSON-serialisable \(undefined\)/);
  assert.throws(() => checkPush('t', 1, 'u1'), /options must be an object/);
  for (const bad of ['', 'a b', 'é', 'x'.repeat(129), null]) assert.throws(() => checkPush(bad, 1), TypeError);
});

test('dev: the cron jobs printed at start', () => {
  assert.equal(describeCron({ cron: [] }), '');
  assert.match(describeCron({ cron: [{ name: 'a b', schedule: '* * * * *' }] }, 'http://localhost:3000'), /curl -X POST http:\/\/localhost:3000\/__specola\/cron\/a%20b$/);
  const text = describeCron({ cron: [{ name: 'nightly', schedule: '0 3 * * *' }, { name: 'q', schedule: '*/15 * * * *' }] });
  assert.equal(
    text,
    [
      "[specola] scheduled jobs (UTC). They don't run on their schedule under vite dev; run one with POST /__specola/cron/<name>:",
      '  nightly  0 3 * * *',
      '  q        */15 * * * *',
      '  e.g. curl -X POST http://localhost:5173/__specola/cron/nightly',
    ].join('\n'),
  );
});

test('dev: scheduled() without a handler, and its event', async () => {
  const root = join(scratch, 'cron-unit');
  const logs = [];
  const logger = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (...a) => logs.push(['error', a.join(' ')]) };
  const manifest = { secrets: ['K'], cron: [{ name: 'j', schedule: '* * * * *' }] };
  let mod = { default: { fetch: () => new Response('') } };
  const dev = createDevBackend({ root, manifest, load: async () => mod, env: { K: 'v', OTHER: 'no' }, logger, now: () => 1_700_000_000_000 });
  try {
    assert.deepEqual(await dev.runScheduled('j'), { status: 'no-handler' });
    assert.match(logs.at(-1)[1], /no scheduled handler/);

    let seen;
    let waited = false;
    mod = {
      default: {
        scheduled(event, ctx) {
          seen = { event, role: ctx.role, user: ctx.user, userDb: ctx.userDb, link: ctx.link, secrets: { ...ctx.secrets }, frozen: Object.isFrozen(event) };
          ctx.waitUntil(new Promise((r) => setTimeout(r, 50)).then(() => (waited = true)));
        },
      },
    };
    assert.deepEqual(await dev.runScheduled('j'), { status: 'ok' });
    assert.deepEqual(seen, { event: { name: 'j', scheduledTime: 1_700_000_000_000 }, role: 'cron', user: null, userDb: null, link: null, secrets: { K: 'v' }, frozen: true });
    assert.equal(waited, false, 'answered before the waitUntil work');

    mod = { default: { scheduled: async () => Promise.reject(new TypeError('nope')) } };
    const out = await dev.runScheduled('j');
    assert.equal(out.status, 'error');
    assert.ok(logs.some(([l, m]) => l === 'error' && m.includes(out.ref) && /nope/.test(m)));

    mod = Promise.reject(new SyntaxError('bad code'));
    mod.catch(() => {});
    assert.equal((await dev.runScheduled('j')).status, 'error');
  } finally {
    dev.close();
  }
});
