// Scheduled runs (docs/page-backends.md, "Scheduled jobs (step 5)"): POST
// /scheduled calls the entry's scheduled(event, ctx) as the cron, under the
// same version and maintenance rules as a call. And the read-only query
// route of "MCP (step 7)" (runQuery's own rules are query.test.js's).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { backend, backendWith, logText, startRunner, until } from './helpers.js';

describe('POST /scheduled', () => {
  let r;
  before(async () => {
    r = await startRunner({ cronMs: 400 });
  });
  after(() => r.close());

  const app = backendWith(
    { secrets: ['KEY'], cron: [{ name: 'nightly', schedule: '0 3 * * *' }] },
    `export default {
      fetch(request, ctx) {
        return Response.json(ctx.db.prepare('SELECT * FROM runs').all());
      },
      async scheduled(event, ctx) {
        ctx.db.exec('CREATE TABLE IF NOT EXISTS runs (name, at, role, user, userDb, frozen, secret)');
        ctx.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          event.name, event.scheduledTime, ctx.role, String(ctx.user), String(ctx.userDb), String(Object.isFrozen(event)), ctx.secrets.KEY ?? 'none');
        console.log('ran', event.name, Object.keys(ctx.secrets).join(','));
      },
    }`,
  );

  test('runs scheduled(event, ctx) as the cron, and answers ok', async () => {
    const v = r.publish(app);
    const res = await r.scheduled({ ...v, page: 'cron-1', name: 'nightly', scheduledTime: 1_764_000_000_000, secrets: { KEY: 'k', UNDECLARED: 'x' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await res.json(), { status: 'ok' });
    const rows = await (await r.invoke({ ...v, page: 'cron-1' })).json();
    assert.deepEqual(rows, [{ name: 'nightly', at: 1_764_000_000_000, role: 'cron', user: 'null', userDb: 'null', frozen: 'true', secret: 'k' }]);
    const log = await logText(r, 'cron-1');
    assert.match(log, /\[log\] ran nightly KEY\n/);
    assert.match(log, /\[info\] scheduled job "nightly": ok \(\d+ ms\)/);
  });

  test('no scheduled handler: no-handler', async () => {
    const v = r.publish(backend(`export default { fetch() { return new Response('ok'); } }`));
    assert.deepEqual(await (await r.scheduled({ ...v, page: 'cron-2' })).json(), { status: 'no-handler' });
    assert.match(await logText(r, 'cron-2'), /\[warn\] scheduled job "nightly": the backend has no scheduled handler/);
  });

  test('a backend with only scheduled: its calls answer backend-error', async () => {
    const v = r.publish(backend(`export default { scheduled() {} }`));
    assert.deepEqual(await (await r.scheduled({ ...v, page: 'cron-3' })).json(), { status: 'ok' });
    const res = await r.invoke({ ...v, page: 'cron-3', path: '/x' });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('x-specola-error'), 'backend-error');
    const { ref } = await res.json();
    const { body } = await r.logs('cron-3');
    assert.match(body.lines.find((l) => l.ref === ref).text, /GET \/x: the backend has no fetch handler/);
  });

  test('an exception: error, with the ref of the stack in the log', async () => {
    const v = r.publish(backend(`export default { async scheduled(event) { await null; throw new Error('boom in ' + event.name); } }`));
    const out = await (await r.scheduled({ ...v, page: 'cron-4', name: 'hourly' })).json();
    assert.equal(out.status, 'error');
    assert.match(out.ref, /^[0-9a-f]{10}$/);
    const { body } = await r.logs('cron-4');
    assert.match(body.lines.find((l) => l.ref === out.ref).text, /^scheduled job "hourly" failed: Error: boom in hourly\n\s+at /);
    assert.match(await logText(r, 'cron-4'), /\[error\] scheduled job "hourly": failed/);
    // The worker is fine: the next run works.
    const v2 = r.publish(backend(`export default { scheduled() {} }`));
    assert.deepEqual(await (await r.scheduled({ ...v2, page: 'cron-4', version: 2 })).json(), { status: 'ok' });
  });

  test('past the limit: timeout, and the worker stays usable', async () => {
    const v = r.publish(
      backend(`export default {
        fetch() { return new Response('alive'); },
        async scheduled() { await new Promise((r) => setTimeout(r, 1500)); console.log('finished late'); },
      }`),
    );
    const t0 = Date.now();
    const out = await (await r.scheduled({ ...v, page: 'cron-5' })).json();
    assert.ok(Date.now() - t0 < 1400);
    assert.equal(out.status, 'timeout');
    const { body } = await r.logs('cron-5');
    assert.match(body.lines.find((l) => l.ref === out.ref).text, /scheduled job "nightly": not finished within 400 ms/);
    assert.equal(await (await r.invoke({ ...v, page: 'cron-5' })).text(), 'alive');
    await until(async () => /finished late/.test(await logText(r, 'cron-5')));
  });

  test('a busy loop: timeout, and the worker is killed', async () => {
    const v = r.publish(backend(`export default { scheduled() { for (;;); } }`));
    const out = await (await r.scheduled({ ...v, page: 'cron-6' })).json();
    assert.equal(out.status, 'timeout');
    await until(async () => /worker crashed: it stopped responding/.test(await logText(r, 'cron-6')), { timeout: 8000 });
  });

  test('a crash, or an entry that fails to load: error with a ref', async () => {
    const v = r.publish(backend(`export default { scheduled() { process.exit(3); } }`));
    const out = await (await r.scheduled({ ...v, page: 'cron-7' })).json();
    assert.equal(out.status, 'error');
    const { body } = await r.logs('cron-7');
    assert.match(body.lines.find((l) => l.ref === out.ref).text, /worker crashed: exit code 3; 0 request\(s\) in flight answered 502 and 1 scheduled run\(s\) answered error/);

    const v2 = r.publish(backend(`throw new Error('bad entry');`));
    const out2 = await (await r.scheduled({ ...v2, page: 'cron-8' })).json();
    assert.equal(out2.status, 'error');
    const l2 = (await r.logs('cron-8')).body.lines;
    assert.match(l2.find((l) => l.ref === out2.ref).text, /loading the backend failed: Error: bad entry/);
  });

  test('waitUntil work: the answer does not wait for it, the worker does', async () => {
    const v = r.publish(
      backend(`export default {
        scheduled(event, ctx) {
          ctx.waitUntil(new Promise((r) => setTimeout(r, 200)).then(() => console.log('waited')));
        },
      }`),
    );
    assert.deepEqual(await (await r.scheduled({ ...v, page: 'cron-9' })).json(), { status: 'ok' });
    assert.doesNotMatch(await logText(r, 'cron-9'), /waited/);
    await until(async () => /waited/.test(await logText(r, 'cron-9')));
  });

  test('versions: an older one is superseded, a newer one switches', async () => {
    const v1 = r.publish(backend(`export default { scheduled() { console.log('v1 ran'); } }`));
    const v2 = r.publish(backend(`export default { scheduled() { console.log('v2 ran'); } }`));
    assert.deepEqual(await (await r.scheduled({ ...v1, page: 'cron-10', version: 1 })).json(), { status: 'ok' });
    assert.deepEqual(await (await r.scheduled({ ...v2, page: 'cron-10', version: 2 })).json(), { status: 'ok' });
    const old = await r.scheduled({ ...v1, page: 'cron-10', version: 1 });
    assert.equal(old.status, 409);
    assert.equal(old.headers.get('x-specola-error'), 'superseded');
    const log = await logText(r, 'cron-10');
    assert.match(log, /v1 ran[\s\S]*version switch: 1 → 2[\s\S]*v2 ran/);
    assert.equal(log.match(/v1 ran/g).length, 1);
  });

  test('bad heads are 400, other methods 405', async () => {
    const v = r.publish(app);
    const cases = [
      [{ head: { role: 'owner', user: { sub: 's', email: '', name: '' } } }, /role must be "cron"/],
      [{ head: { user: { sub: 's', email: '', name: '' } } }, /user and role disagree/],
      [{ head: { event: undefined } }, /event\.name is invalid/],
      [{ name: 'bad name!' }, /event\.name is invalid/],
      [{ name: 'x'.repeat(65) }, /event\.name is invalid/],
      [{ scheduledTime: 1.5 }, /event\.scheduledTime is invalid/],
      [{ scheduledTime: -1 }, /event\.scheduledTime is invalid/],
      [{ head: { versionId: '../x' } }, /versionId is invalid/],
    ];
    for (const [o, want] of cases) {
      const res = await r.scheduled({ ...v, page: 'cron-11', ...o });
      assert.equal(res.status, 400, JSON.stringify(o));
      assert.equal(res.headers.get('x-specola-error'), 'bad-request');
      assert.match((await res.json()).message, want);
    }
    const res = await fetch(`${r.url}/scheduled`, { headers: { authorization: 'Bearer test-runner-token-0123456789' } });
    assert.equal(res.status, 405);
    const noAuth = await fetch(`${r.url}/scheduled`, { method: 'POST' });
    assert.equal(noAuth.status, 401);
  });
});

describe('scheduled runs as page activity', () => {
  test('a run keeps the worker from going idle, and takes the daily snapshot', async () => {
    const r = await startRunner({ idleMs: 200, cronMs: 5000 });
    try {
      const v = r.publish(
        backend(`export default {
          async scheduled(event, ctx) {
            ctx.db.exec('CREATE TABLE IF NOT EXISTS t (x)');
            ctx.db.exec('INSERT INTO t VALUES (1)');
            await new Promise((r) => setTimeout(r, 600));
          },
        }`),
      );
      assert.deepEqual(await (await r.scheduled({ ...v, page: 'act-1' })).json(), { status: 'ok' });
      const log = await logText(r, 'act-1');
      assert.match(log, /scheduled job "nightly": ok/);
      assert.doesNotMatch(log.split('scheduled job "nightly": ok')[0], /stopped \(idle\)/);
      await r.runner.pages.idle('act-1');
      const { body } = await r.api('GET', '/pages/act-1/data');
      assert.deepEqual(
        body.snapshots.map((s) => s.kind),
        ['daily'],
      );
      // And idle stops it afterwards, as after a call.
      await until(async () => /stopped \(idle\)/.test(await logText(r, 'act-1')));
    } finally {
      await r.close();
    }
  });

  test('a run waits for a maintenance, up to the first-byte limit', async () => {
    const r = await startRunner({ firstByteMs: 500 });
    try {
      const v = r.publish(
        backend(`export default {
          fetch(request) {
            // Answers at once, then streams for a while: the wipe waits for it.
            return new Response(new ReadableStream({
              async start(c) { await new Promise((r) => setTimeout(r, 1500)); c.enqueue(new TextEncoder().encode('done')); c.close(); },
            }));
          },
          scheduled() { console.log('ran'); },
        }`),
      );
      const slow = await r.invoke({ ...v, page: 'act-2' });
      assert.equal(slow.status, 200);
      const wipe = r.api('POST', '/pages/act-2/wipe', { json: { scope: 'shared' } });
      await until(async () => /page offline for a wipe/.test(await logText(r, 'act-2')));
      const res = await r.scheduled({ ...v, page: 'act-2' });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('x-specola-error'), 'backend-unavailable');
      assert.match((await res.json()).message, /offline for a wipe/);
      assert.equal(await slow.text(), 'done');
      assert.equal((await wipe).status, 200);
      assert.deepEqual(await (await r.scheduled({ ...v, page: 'act-2' })).json(), { status: 'ok' });
    } finally {
      await r.close();
    }
  });
});

describe('POST /pages/{id}/query', () => {
  let r;
  before(async () => {
    r = await startRunner();
  });
  after(() => r.close());

  test('a page without a shared database: 404 no-data', async () => {
    const res = await r.api('POST', '/pages/q-none/query', { json: { sql: 'SELECT 1', params: [] } });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-specola-error'), 'no-data');
  });

  test('reads what the backend wrote', async () => {
    const v = r.publish(
      backend(`export default {
        fetch(request, ctx) {
          ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('a'), ('b'), ('c')");
          return new Response('ok');
        },
      }`),
    );
    assert.equal(await (await r.invoke({ ...v, page: 'q-1' })).text(), 'ok');
    const res = await r.api('POST', '/pages/q-1/query', { json: { sql: 'SELECT id, name FROM items WHERE id >= ? ORDER BY id', params: [2] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { columns: ['id', 'name'], rows: [[2, 'b'], [3, 'c']], truncated: false });
    // Named params too, and no params at all.
    const named = await r.api('POST', '/pages/q-1/query', { json: { sql: 'SELECT name FROM items WHERE id = :id', params: { id: 1 } } });
    assert.deepEqual(named.body.rows, [['a']]);
    const none = await r.api('POST', '/pages/q-1/query', { json: { sql: 'SELECT count(*) AS n FROM items' } });
    assert.deepEqual(none.body.rows, [[3]]);
  });

  test('writes and bad SQL are 400, other methods 405, bad ids 400', async () => {
    const v = r.publish(backend(`export default { fetch(request, ctx) { ctx.db.exec('CREATE TABLE IF NOT EXISTS t (x)'); return new Response('ok'); } }`));
    await (await r.invoke({ ...v, page: 'q-2' })).text();
    for (const sql of ['DELETE FROM t', 'SELECT * FROM nope', 'SELECT 1; SELECT 2', '']) {
      const res = await r.api('POST', '/pages/q-2/query', { json: { sql } });
      assert.equal(res.status, 400, sql);
      assert.equal(res.headers.get('x-specola-error'), 'bad-request');
    }
    assert.equal((await r.api('POST', '/pages/q-2/query', { body: 'not json' })).status, 400);
    assert.equal((await r.api('GET', '/pages/q-2/query')).status, 405);
    assert.equal((await r.api('POST', '/pages/bad%20id/query', { json: { sql: 'SELECT 1' } })).status, 400);
  });
});
