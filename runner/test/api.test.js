import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { backendHash } from '../src/code.js';
import { loadConfig, parseListen } from '../src/config.js';
import { parseInvoke } from '../src/server.js';
import { TOKEN, backend, invoke, logText, makeCode, startRunner } from './helpers.js';

describe('auth and plumbing', () => {
  let r;
  before(async () => {
    r = await startRunner();
  });
  after(() => r.close());

  test('every endpoint requires the token', async () => {
    for (const [method, p] of [['GET', '/health'], ['GET', '/logs?page=x'], ['POST', '/invoke'], ['GET', '/nope']]) {
      for (const auth of [undefined, 'Bearer wrong', `Bearer ${TOKEN}x`, TOKEN]) {
        const res = await fetch(r.url + p, { method, headers: auth ? { authorization: auth } : {} });
        assert.equal(res.status, 401, `${method} ${p} with ${auth}`);
        assert.equal(res.headers.get('x-specola-error'), 'unauthorized');
      }
    }
  });

  test('health', async () => {
    const res = await fetch(`${r.url}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.version, /^\d+\.\d+\.\d+/);
  });

  test('wrong methods and unknown paths', async () => {
    const h = { authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(`${r.url}/invoke`, { headers: h })).status, 405);
    assert.equal((await fetch(`${r.url}/health`, { method: 'POST', headers: h })).status, 405);
    assert.equal((await fetch(`${r.url}/x`, { headers: h })).status, 404);
  });

  test('a bad invoke head answers 400 bad-request', async () => {
    const res = await fetch(`${r.url}/invoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-specola-invoke': 'not json' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('x-specola-error'), 'bad-request');
    assert.equal((await res.json()).error, 'bad-request');
  });

  test('logs validates its parameters and answers empty for unknown pages', async () => {
    assert.equal((await r.logs('bad/id')).status, 400);
    const res = await fetch(`${r.url}/logs?page=p&since=-1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 400);
    assert.deepEqual((await r.logs('unknown')).body, { lines: [] });
  });
});

test('parseInvoke checks the wire format', () => {
  const ok = {
    page: { id: 'p1', version: 2, title: 't' },
    versionId: 'v1',
    codeHash: 'a'.repeat(64),
    user: { sub: 's', email: 'e', name: 'n' },
    role: 'viewer',
    link: null,
    secrets: {},
    egress: [],
    request: { method: 'post', path: '/api/x?y=1', headers: [['a', 'b']] },
  };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const got = parseInvoke(enc(ok));
  assert.equal(got.request.method, 'POST');
  assert.deepEqual(got.user, ok.user);
  const broken = [
    { ...ok, page: { ...ok.page, id: '../x' } },
    { ...ok, page: { ...ok.page, version: 0 } },
    { ...ok, codeHash: 'xyz' },
    { ...ok, role: 'admin' },
    { ...ok, user: null }, // a viewer is a signed-in user
    { ...ok, role: 'public' }, // a public caller has no user
    { ...ok, secrets: { A: 1 } },
    { ...ok, request: { ...ok.request, path: 'x' } },
    { ...ok, request: { ...ok.request, method: 'GE T' } },
    { ...ok, request: { ...ok.request, headers: [['a']] } },
  ];
  for (const b of broken) assert.throws(() => parseInvoke(enc(b)), { code: 'bad-request' }, JSON.stringify(b));
  assert.doesNotThrow(() => parseInvoke(enc({ ...ok, user: null, role: 'public', link: { id: 'l', label: 'x' } })));
});

test('config', () => {
  assert.throws(() => loadConfig({}), /SPECOLA_RUNNER_TOKEN/);
  assert.throws(() => loadConfig({ SPECOLA_RUNNER_TOKEN: TOKEN }), /SPECOLA_URL/);
  const c = loadConfig({ SPECOLA_RUNNER_TOKEN: TOKEN, SPECOLA_URL: 'http://specola:8080/', RUNNER_IDLE_TIMEOUT_MS: '1000', RUNNER_DATA_DIR: 'rel' });
  assert.equal(c.specolaUrl, 'http://specola:8080');
  assert.equal(c.limits.idleMs, 1000);
  assert.equal(c.limits.workerConcurrency, 32);
  assert.equal(c.listen.port, 8081);
  assert.ok(path.isAbsolute(c.dataDir));
  assert.throws(() => loadConfig({ SPECOLA_RUNNER_TOKEN: TOKEN, SPECOLA_URL: 'http://s', RUNNER_WORKER_MEMORY_MB: 'lots' }), /RUNNER_WORKER_MEMORY_MB/);
  assert.deepEqual(parseListen('127.0.0.1:9000'), { host: '127.0.0.1', port: 9000 });
  assert.deepEqual(parseListen('[::1]:9000'), { host: '::1', port: 9000 });
});

test('backendHash sorts by path bytes', () => {
  const files = [
    { path: 'server/b.mjs', content: Buffer.from('b') },
    { path: 'backend.json', content: Buffer.from('{}') },
    { path: 'server/a.mjs', content: Buffer.from('a') },
  ];
  assert.equal(backendHash(files), makeCode({ 'server/a.mjs': 'a', 'backend.json': '{}', 'server/b.mjs': 'b' }).codeHash);
});

describe('code', () => {
  let r;
  before(async () => {
    r = await startRunner();
  });
  after(() => r.close());

  test('is fetched once, checked and cached by hash', async () => {
    const v = r.publish(backend(`export default { fetch: () => new Response('hi') }`));
    const before = r.specola.hits.length;
    const responses = await Promise.all([1, 2, 3, 4].map(() => r.invoke({ page: 'code-1', ...v })));
    for (const res of responses) {
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'hi');
    }
    const hits = r.specola.hits.slice(before);
    assert.equal(hits.length, 1, 'concurrent first requests share one download');
    assert.equal(hits[0].url, `/internal/runner/code/${v.versionId}`);
    assert.equal(hits[0].auth, `Bearer ${TOKEN}`);
    const dir = path.join(r.dataDir, 'code', v.codeHash);
    assert.equal(await fs.readFile(path.join(dir, 'server/index.mjs'), 'utf8'), `export default { fetch: () => new Response('hi') }`);
    // A later request, even another page with the same code, uses the cache.
    assert.equal((await r.invoke({ page: 'code-2', ...v })).status, 200);
    assert.equal(r.specola.hits.length, before + 1);
    assert.deepEqual((await fs.readdir(path.join(r.dataDir, 'code'))).filter((n) => n.startsWith('.tmp')), []);
  });

  test('a hash mismatch is refused', async () => {
    const code = backend(`export default { fetch: () => new Response('evil') }`);
    const other = backend(`export default { fetch: () => new Response('good') }`);
    // specola claims the files are `other`'s
    const v = r.publish({ ...code, codeHash: other.codeHash });
    const res = await r.invoke({ page: 'code-3', versionId: v.versionId, codeHash: other.codeHash });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('x-specola-error'), 'backend-error');
    assert.match((await res.json()).message, /does not match its hash/);
    await assert.rejects(fs.access(path.join(r.dataDir, 'code', other.codeHash)));
  });

  test('a version specola does not know answers no-backend', async () => {
    const res = await r.invoke({ page: 'code-4', versionId: 'missing', codeHash: 'b'.repeat(64) });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-specola-error'), 'no-backend');
  });

  test('unsafe code paths are refused', async () => {
    const code = makeCode({ '../escape.mjs': 'x' });
    const v = r.publish(code);
    const res = await r.invoke({ page: 'code-5', ...v });
    assert.equal(res.status, 500);
    assert.match((await res.json()).message, /"\.\." segment/);
  });

  test('a missing entry is a clear error', async () => {
    const v = r.publish(makeCode({ 'backend.json': JSON.stringify({ entry: 'server/main.mjs' }) }));
    const res = await r.invoke({ page: 'code-6', ...v });
    assert.equal(res.status, 500);
    assert.match((await res.json()).message, /server\/main\.mjs is missing/);
  });
});

describe('handlers', () => {
  let r;
  before(async () => {
    r = await startRunner();
  });
  after(() => r.close());

  test('the request and ctx follow the handler contract', async () => {
    const v = r.publish(
      backend(`export default {
        async fetch(request, ctx) {
          return Response.json({
            url: request.url,
            method: request.method,
            body: await request.text(),
            headers: [...request.headers],
            user: ctx.user, role: ctx.role, link: ctx.link, page: ctx.page,
            secrets: ctx.secrets,
            hasEnvToken: Object.keys(process.env).some((k) => /TOKEN|SPECOLA/.test(k)),
          }, { headers: { 'set-cookie': 'a=b', 'x-specola-error': 'superseded', 'x-mine': '1' } });
        },
      }`),
    );
    const res = await r.invoke({
      ...v,
      page: 'h-1',
      method: 'POST',
      path: '/api/orders?x=1',
      headers: [['content-type', 'text/plain'], ['cookie', 'sid=1'], ['x-specola-version', '1'], ['connection', 'close'], ['x-app', 'yes']],
      body: 'hello',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('x-specola-error'), null);
    assert.equal(res.headers.get('x-mine'), '1');
    const b = await res.json();
    assert.equal(b.url, 'https://page.invalid/api/orders?x=1');
    assert.equal(b.method, 'POST');
    assert.equal(b.body, 'hello');
    assert.deepEqual(b.headers.map(([k]) => k).sort(), ['content-type', 'x-app']);
    assert.deepEqual(b.user, { sub: 'user-1', email: 'u1@example.com', name: 'User One' });
    assert.equal(b.role, 'owner');
    assert.equal(b.link, null);
    assert.deepEqual(b.page, { id: 'h-1', version: 1, title: 'Test page' });
    assert.deepEqual(b.secrets, {});
    assert.equal(b.hasEnvToken, false);
  });

  test('a path starting with // stays a path', async () => {
    const v = r.publish(backend(`export default { fetch: (req) => new Response(req.url) }`));
    const res = await r.invoke({ ...v, page: 'h-2', path: '//evil.example/x' });
    assert.equal(await res.text(), 'https://page.invalid//evil.example/x');
  });

  test('an invoke head up to the 48 KiB cap specola allows fits', async () => {
    const v = r.publish(backend(`export default { fetch: (req) => new Response(String(req.headers.get('x-big').length)) }`));
    // Base64url grows the JSON by a third: ~44 KiB on the wire, past Node's
    // 16 KiB default header limit.
    const res = await r.invoke({ ...v, page: 'h-big', headers: [['x-big', 'a'.repeat(32 * 1024)]] });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), String(32 * 1024));
  });

  test('db, userDb and files', async () => {
    const v = r.publish(
      backend(`export default {
        async fetch(request, ctx) {
          const url = new URL(request.url);
          if (url.pathname === '/count') {
            ctx.db.exec('CREATE TABLE IF NOT EXISTS hits (by TEXT)');
            ctx.db.prepare('INSERT INTO hits VALUES (?)').run(ctx.user?.sub ?? 'anon');
            const shared = ctx.db.prepare('SELECT count(*) AS n FROM hits').get().n;
            let mine = null;
            if (ctx.userDb) {
              ctx.userDb.exec('CREATE TABLE IF NOT EXISTS mine (x)');
              ctx.userDb.prepare('INSERT INTO mine VALUES (1)').run();
              mine = ctx.userDb.prepare('SELECT count(*) AS n FROM mine').get().n;
            }
            const wal = ctx.db.prepare('PRAGMA journal_mode').get().journal_mode;
            return Response.json({ shared, mine, wal });
          }
          if (url.pathname === '/put') {
            const form = await request.formData();
            const f = form.get('file');
            const r = await ctx.files.put('uploads/' + f.name, f);
            await ctx.files.put('notes/a.txt', 'note a', { contentType: 'text/plain' });
            await ctx.files.put('notes/b.txt', 'note a', { contentType: 'text/plain' }); // same content
            return Response.json(r);
          }
          if (url.pathname === '/get') {
            const got = await ctx.files.get(url.searchParams.get('key'));
            if (!got) return new Response('none', { status: 404 });
            return new Response(got.body, { headers: { 'content-type': got.contentType, 'x-size': String(got.size) } });
          }
          if (url.pathname === '/list') return Response.json(await ctx.files.list(url.searchParams.get('prefix') ?? undefined));
          if (url.pathname === '/delete') return Response.json(await ctx.files.delete(url.searchParams.get('key')));
          if (url.pathname === '/badkey') {
            try { await ctx.files.put('../x', 'x'); } catch (e) { return new Response(e.message); }
          }
          return new Response('?', { status: 404 });
        },
      }`),
    );
    const call = (o) => r.invoke({ ...v, page: 'h-3', ...o });
    const u2 = { sub: 'user-2', email: 'u2@example.com', name: 'Two' };
    assert.deepEqual(await (await call({ path: '/count' })).json(), { shared: 1, mine: 1, wal: 'wal' });
    assert.deepEqual(await (await call({ path: '/count' })).json(), { shared: 2, mine: 2, wal: 'wal' });
    assert.deepEqual(await (await call({ path: '/count', user: u2, role: 'viewer' })).json(), { shared: 3, mine: 1, wal: 'wal' });
    assert.deepEqual(await (await call({ path: '/count', user: null, role: 'public' })).json(), { shared: 4, mine: null, wal: 'wal' });

    const pageDir = path.join(r.dataDir, 'pages', 'h-3');
    const users = (await fs.readdir(path.join(pageDir, 'users'))).filter((n) => n.endsWith('.sqlite')).sort();
    const { createHash } = await import('node:crypto');
    const sha = (s) => createHash('sha256').update(s).digest('hex');
    assert.deepEqual(users, [`${sha('user-1')}.sqlite`, `${sha('user-2')}.sqlite`].sort());

    const form = new FormData();
    form.append('file', new Blob(['picture bytes'], { type: 'image/png' }), 'pic.png');
    const put = new Response(form);
    const res = await call({ method: 'POST', path: '/put', headers: [['content-type', put.headers.get('content-type')]], body: put.body });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { key: 'uploads/pic.png', size: 13, contentType: 'image/png' });

    const got = await call({ path: '/get?key=uploads/pic.png' });
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal(got.headers.get('x-size'), '13');
    assert.equal(await got.text(), 'picture bytes');
    assert.equal((await call({ path: '/get?key=nope' })).status, 404);

    const list = await (await call({ path: '/list?prefix=notes/' })).json();
    assert.deepEqual(list.map((f) => [f.key, f.size, f.contentType]), [['notes/a.txt', 6, 'text/plain'], ['notes/b.txt', 6, 'text/plain']]);
    assert.equal((await (await call({ path: '/list' })).json()).length, 3);
    // content-addressed: two keys, one blob
    assert.equal((await fs.readdir(path.join(pageDir, 'files', 'blobs'))).length, 2);
    assert.equal(await (await call({ path: '/delete?key=notes/a.txt' })).json(), true);
    assert.equal((await fs.readdir(path.join(pageDir, 'files', 'blobs'))).length, 2, 'still named by notes/b.txt');
    assert.equal(await (await call({ path: '/delete?key=notes/b.txt' })).json(), true);
    assert.equal((await fs.readdir(path.join(pageDir, 'files', 'blobs'))).length, 1);
    assert.equal(await (await call({ path: '/delete?key=notes/b.txt' })).json(), false);
    assert.match(await (await call({ path: '/badkey' })).text(), /invalid key "\.\.\/x"/);
  });

  test('an uncaught exception answers backend-error with a ref found in the log', async () => {
    const v = r.publish(backend(`export default { fetch() { throw new Error('kaboom'); } }`));
    const res = await r.invoke({ ...v, page: 'h-4', path: '/boom' });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('x-specola-error'), 'backend-error');
    const body = await res.json();
    assert.equal(body.error, 'backend-error');
    assert.match(body.ref, /^[0-9a-f]{10}$/);
    assert.doesNotMatch(JSON.stringify(body), /kaboom/, 'the page gets no stack');
    const { body: logs } = await r.logs('h-4');
    const line = logs.lines.find((l) => l.ref === body.ref);
    assert.equal(line.level, 'error');
    assert.match(line.text, /GET \/boom failed: Error: kaboom\n\s+at /);
  });

  test('a handler that returns something else than a Response', async () => {
    const v = r.publish(backend(`export default { fetch: () => ({ ok: true }) }`));
    const res = await r.invoke({ ...v, page: 'h-5' });
    assert.equal(res.status, 500);
    const { ref } = await res.json();
    const { body } = await r.logs('h-5');
    assert.match(body.lines.find((l) => l.ref === ref).text, /returned an object \(Object\), not a Response/);
  });

  test('an entry that fails to load, or has no fetch', async () => {
    const v = r.publish(backend(`throw new Error('top-level failure');`));
    const res = await r.invoke({ ...v, page: 'h-6' });
    assert.equal(res.status, 500);
    const { ref } = await res.json();
    const { body } = await r.logs('h-6');
    assert.match(body.lines.find((l) => l.ref === ref).text, /loading the backend failed: Error: top-level failure/);

    const v2 = r.publish(backend(`export default {}`));
    const res2 = await r.invoke({ ...v2, page: 'h-7' });
    assert.equal(res2.status, 500);
    assert.match(await logText(r, 'h-7'), /no fetch handler/);
  });

  test('console output, publish and waitUntil', async () => {
    const v = r.publish(
      backend(`export default {
        async fetch(request, ctx) {
          console.log('hello', { a: 1 });
          console.warn('careful');
          ctx.log.error('bad', 42);
          ctx.publish('topic', {});
          ctx.waitUntil(new Promise((r) => setTimeout(r, 300)).then(() => console.info('later')));
          return new Response('ok');
        },
      }`),
    );
    const res = await r.invoke({ ...v, page: 'h-8' });
    assert.equal(await res.text(), 'ok');
    const { body } = await r.logs('h-8');
    const lines = body.lines.map((l) => [l.level, l.text]);
    assert.deepEqual(lines.filter(([, t]) => !/^worker/.test(t)), [
      ['log', 'hello { a: 1 }'],
      ['warn', 'careful'],
      ['error', 'bad 42'],
      ['warn', 'ctx.publish: push is not available yet; the event was dropped'],
    ]);
    const all = await r.logs('h-8');
    for (const l of all.body.lines) assert.ok(!Number.isNaN(Date.parse(l.time)));
    const seq = all.body.lines.map((l) => l.seq);
    assert.deepEqual(seq, [...seq].sort((a, b) => a - b));
    const since = (await r.logs('h-8', seq[1])).body.lines.map((l) => l.seq);
    assert.deepEqual(since, seq.slice(2));
    const later = await new Promise((resolve) => setTimeout(async () => resolve(await logText(r, 'h-8')), 600));
    assert.match(later, /\[info\] later/);
  });

  test('page code posing as the worker protocol cannot break the runner', async () => {
    const v = r.publish(
      backend(`export default {
        async fetch() {
          for (const id of [1, 2, 3, 4]) {
            process.send({ t: 'head', id, status: 42, headers: [] });
            process.send({ t: 'head', id, status: 200, headers: 'nope' });
            process.send({ t: 'chunk', id, data: 'not bytes' });
            process.send({ t: 'fail', id, status: 99, code: 'x', message: 'y', ref: 'z'.repeat(100) });
          }
          process.send(null);
          process.send({ t: 'log', level: 'nope', text: { a: 1 }, ref: 'r'.repeat(1000) });
          return new Response('still fine');
        },
      }`),
    );
    const res = await r.invoke({ ...v, page: 'h-9' });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('x-specola-error'), 'backend-error');
    const health = await fetch(`${r.url}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(health.status, 200);
    assert.match(await logText(r, 'h-9'), /the worker sent an invalid message \(status 42\)/);
  });

  test('requests over the concurrency limit answer 429', async () => {
    const r2 = await startRunner({ workerConcurrency: 2 });
    try {
      const v = r2.publish(backend(`export default { async fetch() { await new Promise((r) => setTimeout(r, 400)); return new Response('slow'); } }`));
      const results = await Promise.all([1, 2, 3].map(() => r2.invoke({ ...v, page: 'c-1' })));
      const statuses = results.map((x) => x.status).sort();
      assert.deepEqual(statuses, [200, 200, 429]);
      const limited = results.find((x) => x.status === 429);
      assert.equal(limited.headers.get('x-specola-error'), 'too-many-requests');
    } finally {
      await r2.close();
    }
  });

  test('a handler may answer before reading the body', async () => {
    const v = r.publish(backend(`export default { fetch: () => new Response('early') }`));
    const big = 'z'.repeat(2 * 1024 * 1024);
    for (let i = 0; i < 3; i++) {
      const res = await r.invoke({ ...v, page: 'h-10', method: 'PUT', body: big });
      assert.equal(await res.text(), 'early');
    }
  });

  test('a body over the limit answers 413', async () => {
    const r2 = await startRunner({ maxBodyBytes: 1000 });
    try {
      const v = r2.publish(backend(`export default { async fetch(req) { return new Response(String((await req.arrayBuffer()).byteLength)); } }`));
      const ok = await r2.invoke({ ...v, page: 'b-1', method: 'POST', body: 'x'.repeat(1000) });
      assert.equal(await ok.text(), '1000');
      const big = await r2.invoke({ ...v, page: 'b-1', method: 'POST', body: 'x'.repeat(1001) });
      assert.equal(big.status, 413);
      assert.equal(big.headers.get('x-specola-error'), 'body-too-large');
      // chunked, so the length is only known while reading
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('y'.repeat(800)));
          c.enqueue(new TextEncoder().encode('y'.repeat(800)));
          c.close();
        },
      });
      const chunked = await r2.invoke({ ...v, page: 'b-1', method: 'POST', body: stream });
      assert.equal(chunked.status, 413);
    } finally {
      await r2.close();
    }
  });
});
