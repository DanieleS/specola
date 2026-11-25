// The data lifecycle routes (docs/page-backends.md, "Data lifecycle" and
// "Wire formats for data (exact)"), against a real runner and real workers.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_LIMITS } from '../src/config.js';
import { keep, listSnapshots, sweepSnapshots } from '../src/snapshot.js';
import { pageUsage } from '../src/worker/files.mjs';
import { createRunner } from '../src/server.js';
import { TOKEN, backend, logText, startRunner, until } from './helpers.js';
import { craftZip, exportEntries, sha256 } from './zipcraft.js';

// A backend to drive the data from the tests: rows in the shared database,
// rows per user, files, and slow calls.
const DATA_BACKEND = backend(`export default {
  async fetch(request, ctx) {
    const url = new URL(request.url);
    const q = (k) => url.searchParams.get(k);
    const p = url.pathname;
    ctx.db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT, b BLOB)');
    if (p === '/add') {
      ctx.db.prepare('INSERT INTO t (v, b) VALUES (?, ?)').run(q('v'), q('blob') ? new Uint8Array(Buffer.from(q('blob'), 'hex')) : null);
      return new Response('ok');
    }
    if (p === '/big') {
      ctx.db.prepare('INSERT INTO t (v, b) VALUES (?, randomblob(?))').run('big', Number(q('n')));
      return new Response('ok');
    }
    if (p === '/rows') {
      return Response.json(ctx.db.prepare('SELECT id, v, hex(b) AS b FROM t ORDER BY id').all());
    }
    if (p === '/mine') {
      ctx.userDb.exec('CREATE TABLE IF NOT EXISTS m (v TEXT)');
      if (q('v')) ctx.userDb.prepare('INSERT INTO m VALUES (?)').run(q('v'));
      return Response.json(ctx.userDb.prepare('SELECT v FROM m').all().map((r) => r.v));
    }
    if (p === '/put') {
      await ctx.files.put(q('key'), request.body, { contentType: q('type') ?? 'application/octet-stream' });
      return new Response('ok');
    }
    if (p === '/get') {
      const f = await ctx.files.get(q('key'));
      if (!f) return new Response('none', { status: 404 });
      return new Response(f.body, { headers: { 'content-type': f.contentType } });
    }
    if (p === '/list') return Response.json(await ctx.files.list());
    if (p === '/slow') {
      await new Promise((r) => setTimeout(r, Number(q('ms'))));
      return new Response('slow done');
    }
    if (p === '/stream') {
      // The head at once, the end later: a call in flight that the first-byte
      // timeout does not cut.
      const ms = Number(q('ms'));
      return new Response(new ReadableStream({
        async start(c) {
          c.enqueue(new TextEncoder().encode('start '));
          await new Promise((r) => setTimeout(r, ms));
          c.enqueue(new TextEncoder().encode('end'));
          c.close();
        },
      }));
    }
    return new Response('?', { status: 404 });
  },
}`);

const u2 = { sub: 'user-2', email: 'u2@example.com', name: 'Two' };
const hash = (s) => createHash('sha256').update(s).digest('hex');

async function withRunner(limits, fn, opts) {
  const r = await startRunner(limits, opts);
  try {
    await fn(r);
  } finally {
    await r.close();
  }
}

/** Helpers bound to a runner and a page. */
function pageOf(r, id, version = 1) {
  const v = r.publish(DATA_BACKEND, `data-${version}`);
  const call = async (p, o = {}) => {
    const res = await r.invoke({ ...v, page: id, version, path: p, ...o });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text), error: res.headers.get('x-specola-error') };
  };
  return {
    call,
    rows: async () => (await call('/rows')).json().map((x) => x.v),
    mine: async (user) => (await call('/mine', user ? { user, role: 'viewer' } : {})).json(),
    put: (key, data, type) => call(`/put?key=${encodeURIComponent(key)}${type ? `&type=${encodeURIComponent(type)}` : ''}`, { method: 'POST', body: data }),
    get: async (key) => {
      const res = await r.invoke({ ...v, page: id, version, path: `/get?key=${encodeURIComponent(key)}` });
      return res.status === 404 ? null : Buffer.from(await res.arrayBuffer());
    },
    list: async () => (await call('/list')).json().map((f) => [f.key, f.size, f.contentType]),
    data: async () => (await r.api('GET', `/pages/${id}/data`)).body,
    snap: (label = 'by hand') => r.api('POST', `/pages/${id}/snapshots`, { json: { kind: 'manual', label } }),
  };
}

const pageDir = (r, id) => path.join(r.dataDir, 'pages', id);

describe('routes', () => {
  let r;
  before(async () => {
    r = await startRunner();
  });
  after(() => r.close());

  test('require the token', async () => {
    const res = await fetch(`${r.url}/pages/p/data`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-specola-error'), 'unauthorized');
  });

  test('validate page and snapshot ids before anything else', async () => {
    for (const [method, p] of [
      ['GET', '/pages/a.b/data'],
      ['DELETE', '/pages/' + 'x'.repeat(129)],
      ['DELETE', '/pages/p/snapshots/20261125T000000.000Z-v1'],
      ['POST', '/pages/p/snapshots/20261125T000000Z-manual%2F..%2F..%2Fx/restore'],
      ['DELETE', '/pages/p/snapshots/20261125T000000Z-manual-v1x'],
    ]) {
      const res = await r.api(method, p);
      assert.equal(res.status, 400, p);
      assert.equal(res.headers.get('x-specola-error'), 'bad-request', p);
      assert.equal(res.body.error, 'bad-request');
    }
    // Sent as is (fetch would resolve the dots first).
    for (const p of ['/pages/../data', '/pages/p/snapshots/../restore', '/pages/p/snapshots/%2e%2e/restore', '/pages/p%2F..%2Fq/data']) {
      const status = await new Promise((resolve, reject) => {
        const req = http.request(`${r.url}${p}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
      assert.ok(status === 400 || status === 404, `${p}: ${status}`);
    }
    assert.equal((await r.api('GET', '/pages/p/nope')).status, 404);
    assert.equal((await r.api('GET', '/pages/p/data/x')).status, 404);
    assert.equal((await r.api('GET', '/pages/p/snapshots/x/y/z')).status, 404);
  });

  test('answer 405 to other methods', async () => {
    for (const [method, p, allow] of [
      ['POST', '/pages/p/data', 'GET'],
      ['GET', '/pages/p', 'DELETE'],
      ['GET', '/pages/p/snapshots', 'POST'],
      ['GET', '/pages/p/snapshots/20261125T000000Z-manual', 'DELETE'],
      ['GET', '/pages/p/snapshots/20261125T000000Z-manual/restore', 'POST'],
      ['POST', '/pages/p/export', 'GET'],
      ['POST', '/pages/p/import', 'PUT'],
      ['GET', '/pages/p/wipe', 'POST'],
      ['POST', '/pages/p/my-data', 'GET, DELETE'],
    ]) {
      const res = await r.api(method, p);
      assert.equal(res.status, 405, `${method} ${p}`);
      assert.equal(res.headers.get('allow'), allow);
    }
  });

  test('check their bodies', async () => {
    const bad = async (method, p, o, re) => {
      const res = await r.api(method, p, o);
      assert.equal(res.status, 400, `${p} ${JSON.stringify(o)}`);
      assert.equal(res.body.error, 'bad-request');
      assert.match(res.body.message, re);
    };
    await bad('POST', '/pages/p/snapshots', { body: 'nope' }, /not JSON/);
    await bad('POST', '/pages/p/snapshots', { json: [] }, /not a JSON object/);
    await bad('POST', '/pages/p/snapshots', { json: { kind: 'daily', label: 'x' } }, /kind must be "manual"/);
    await bad('POST', '/pages/p/snapshots', { json: { kind: 'manual' } }, /label/);
    await bad('POST', '/pages/p/snapshots', { json: { kind: 'manual', label: '' } }, /label/);
    await bad('POST', '/pages/p/snapshots', { json: { kind: 'manual', label: 'x'.repeat(101) } }, /label/);
    await bad('POST', '/pages/p/snapshots', { json: { kind: 'manual', label: 'a\nb' } }, /label/);
    await bad('POST', '/pages/p/wipe', { json: { scope: 'all' } }, /scope must be/);
    await bad('GET', '/pages/p/my-data', {}, /X-Specola-Sub is required/);
    await bad('DELETE', '/pages/p/my-data', {}, /X-Specola-Sub is required/);
    await bad('POST', '/pages/p/snapshots/20261125T101500Z-daily/restore', { headers: { 'x-specola-version': 'two' } }, /X-Specola-Version is invalid/);
    await bad('GET', '/pages/p/export?version=-1', {}, /version is invalid/);
    // 100 characters, counted as characters, not UTF-16 units.
    assert.equal((await r.api('POST', '/pages/p-label/snapshots', { json: { kind: 'manual', label: '😀'.repeat(100) } })).status, 201);
  });

  test('a page never seen has no data and no snapshots', async () => {
    const res = await r.api('GET', '/pages/never/data');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      usage: { pageBytes: 0, pageLimit: DEFAULT_LIMITS.pageDiskBytes, snapshotBytes: 0, snapshotLimit: DEFAULT_LIMITS.snapshotDiskBytes },
      snapshots: [],
    });
    assert.equal((await r.api('POST', '/pages/never/snapshots/20261125T000000Z-manual/restore')).status, 404);
    assert.equal((await r.api('DELETE', '/pages/never/snapshots/20261125T000000Z-manual')).body.error, 'not-found');
    const mine = await r.api('GET', '/pages/never/my-data', { sub: 'someone' });
    assert.equal(mine.status, 404);
    assert.equal(mine.headers.get('x-specola-error'), 'no-data');
    assert.equal((await r.api('DELETE', '/pages/never/my-data', { sub: 'someone' })).status, 204);
  });
});

describe('snapshots', () => {
  test('manual ones: taken, listed newest first, at most 10, deleted', () =>
    withRunner({}, async (r) => {
      const p = pageOf(r, 'm-1');
      await p.call('/add?v=a');
      const first = await p.snap('before the migration');
      assert.equal(first.status, 201);
      assert.match(first.body.id, /^[0-9]{8}T[0-9]{6}Z-manual$/);
      assert.deepEqual(Object.keys(first.body).sort(), ['createdAt', 'id', 'kind', 'label', 'sizeBytes']);
      assert.equal(first.body.kind, 'manual');
      assert.equal(first.body.label, 'before the migration');
      assert.ok(first.body.sizeBytes > 0);
      for (let i = 2; i <= 10; i++) assert.equal((await p.snap(`#${i}`)).status, 201);
      const eleventh = await p.snap('one too many');
      assert.equal(eleventh.status, 409);
      assert.equal(eleventh.headers.get('x-specola-error'), 'too-many-snapshots');

      const { usage, snapshots } = await p.data();
      const manual = snapshots.filter((s) => s.kind === 'manual');
      assert.equal(manual.length, 10);
      assert.equal(manual[0].label, '#10', 'newest first');
      assert.equal(new Set(snapshots.map((s) => s.id)).size, snapshots.length, 'ids are unique, even within a second');
      for (const s of snapshots) assert.match(s.id, /^[0-9]{8}T[0-9]{6}Z-[a-z-]+(-v[0-9]+)?$/);
      assert.equal(usage.snapshotBytes, snapshots.reduce((n, s) => n + s.sizeBytes, 0));
      assert.equal(usage.pageBytes, await pageUsage(pageDir(r, 'm-1')));

      assert.equal((await r.api('DELETE', `/pages/m-1/snapshots/${first.body.id}`)).status, 204);
      assert.equal((await r.api('DELETE', `/pages/m-1/snapshots/${first.body.id}`)).status, 404);
      assert.equal((await p.snap('room again')).status, 201);

      const daily = snapshots.find((s) => s.kind === 'daily');
      assert.ok(daily, 'the first call took a daily snapshot');
      const notManual = await r.api('DELETE', `/pages/m-1/snapshots/${daily.id}`);
      assert.equal(notManual.status, 409);
      assert.equal(notManual.body.error, 'not-manual');
    }));

  test('a page without data gets an empty manual snapshot', () =>
    withRunner({}, async (r) => {
      const res = await r.api('POST', '/pages/empty/snapshots', { json: { kind: 'manual', label: 'nothing yet' } });
      assert.equal(res.status, 201);
      assert.deepEqual(await fs.readdir(path.join(r.dataDir, 'snapshots', 'empty', res.body.id)), ['meta.json']);
    }));

  test('version snapshots carry the version that left', () =>
    withRunner({}, async (r) => {
      const p1 = pageOf(r, 'v-snap', 1);
      const p2 = pageOf(r, 'v-snap', 2);
      await p1.call('/add?v=one');
      await p2.call('/add?v=two');
      const v = (await p2.data()).snapshots.find((s) => s.kind === 'version');
      assert.match(v.id, /^[0-9]{8}T[0-9]{6}Z-version-v1$/);
      assert.equal(v.version, 1);
      // What the viewer does after restoring version 1 with its data.
      const res = await r.api('POST', `/pages/v-snap/snapshots/${v.id}/restore`);
      assert.equal(res.status, 200);
      assert.deepEqual(await p2.rows(), ['one']);
    }));

  test('restoring a version with its data: the leaving version does not take the restored data for its own', () =>
    withRunner({}, async (r) => {
      const p1 = pageOf(r, 'v-restore', 1);
      const p2 = pageOf(r, 'v-restore', 2);
      const p3 = pageOf(r, 'v-restore', 3);
      await p1.call('/add?v=one');
      await p2.call('/add?v=two');
      const v1 = (await p2.data()).snapshots.find((s) => s.kind === 'version');
      // The viewer restores version 1 as version 3, then v1's data, before
      // version 3's first call: specola says version 3 is current.
      const res = await r.api('POST', `/pages/v-restore/snapshots/${v1.id}/restore`, { headers: { 'x-specola-version': '3' } });
      assert.equal(res.status, 200);
      const state = JSON.parse(await fs.readFile(path.join(r.dataDir, 'state', 'v-restore.json'), 'utf8'));
      assert.equal(state.restoredFor, 3, 'kept on disk, so a restart does not forget it');
      // A call of version 2 that was on its way meanwhile no longer runs:
      // version 2's code on version 1's data, and taking it for its own.
      const late = await p2.call('/rows');
      assert.equal(late.status, 409);
      assert.equal(late.error, 'superseded');
      assert.deepEqual(await p3.rows(), ['one']);
      const snaps = (await p3.data()).snapshots;
      assert.deepEqual(snaps.filter((s) => s.kind === 'version').map((s) => s.version), [1], 'no "version 2" snapshot of version 1\'s data');
      assert.match(await logText(r, 'v-restore'), /version 2 left restored data it never ran on/);
      // Version 2's own data is in the snapshot taken before the restore.
      const before = snaps.find((s) => s.id === res.body.before.id);
      assert.equal((await r.api('POST', `/pages/v-restore/snapshots/${before.id}/restore`)).status, 200);
      assert.deepEqual(await p3.rows(), ['one', 'two']);
    }));

  test('a plain restore, then a new version: the version snapshot holds the restored data', () =>
    withRunner({}, async (r) => {
      const p1 = pageOf(r, 'v-restore-3', 1);
      const p2 = pageOf(r, 'v-restore-3', 2);
      await p1.call('/add?v=one');
      const manual = await p1.snap('one row');
      await p1.call('/add?v=two');
      // From the panel: specola's current version is the one running.
      const res = await r.api('POST', `/pages/v-restore-3/snapshots/${manual.body.id}/restore`, { headers: { 'x-specola-version': '1' } });
      assert.equal(res.status, 200);
      // Published before any call: the switch keeps what version 1 left.
      assert.deepEqual(await p2.rows(), ['one']);
      const v = (await p2.data()).snapshots.find((s) => s.kind === 'version');
      assert.equal(v?.version, 1, 'version 1 left the restored data');
      await p2.call('/add?v=three');
      assert.equal((await r.api('POST', `/pages/v-restore-3/snapshots/${v.id}/restore`)).status, 200);
      assert.deepEqual(await p2.rows(), ['one']);
    }));

  test('a call on restored data makes it the running version\'s again', () =>
    withRunner({}, async (r) => {
      const p1 = pageOf(r, 'v-restore-2', 1);
      const p2 = pageOf(r, 'v-restore-2', 2);
      await p1.call('/add?v=one');
      const manual = await p1.snap('one row');
      await p1.call('/add?v=more');
      assert.equal((await r.api('POST', `/pages/v-restore-2/snapshots/${manual.body.id}/restore`)).status, 200);
      await p1.call('/add?v=after');
      assert.deepEqual(await p2.rows(), ['one', 'after']);
      const v = (await p2.data()).snapshots.filter((s) => s.kind === 'version');
      assert.deepEqual(v.map((s) => s.version), [1]);
    }));

  test('past the budget, the oldest automatic ones go and a manual one that does not fit is refused', () =>
    withRunner({ snapshotDiskBytes: 350_000 }, async (r) => {
      const p = pageOf(r, 'quota-1');
      await p.call('/big?n=100000');
      await until(async () => (await p.data()).snapshots.some((s) => s.kind === 'daily'));
      for (let i = 1; i <= 3; i++) assert.equal((await p.snap(`m${i}`)).status, 201, `manual ${i}`);
      const kinds = (await p.data()).snapshots.map((s) => s.kind);
      assert.deepEqual(kinds, ['manual', 'manual', 'manual'], 'the daily one made room');
      const refused = await p.snap('m4');
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, 'snapshot-quota');
      assert.match(refused.body.message, /delete some manual snapshots first/);
      assert.equal((await p.data()).snapshots.length, 3, 'nothing was removed for it');
      // An automatic one is never refused: it is taken, over the budget.
      const before = await r.api('POST', '/pages/quota-1/wipe', { json: { scope: 'users' } });
      assert.equal(before.status, 200);
      assert.equal((await p.data()).snapshots.length, 4);
      assert.ok((await p.data()).usage.snapshotBytes > 350_000);
    }));

  test('retention: 5 version, 7 daily, 5 before-* together, every manual one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'specola-keep-test-'));
    try {
      const make = async (id, kind, extra = {}) => {
        await fs.mkdir(path.join(root, id), { recursive: true });
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(id);
        const createdAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
        await fs.writeFile(path.join(root, id, 'meta.json'), JSON.stringify({ kind, createdAt, sizeBytes: 10, ...extra }));
      };
      const ids = [];
      let minute = 0;
      const next = () => `20261125T10${String(Math.floor(minute / 60)).padStart(2, '0')}${String(minute++ % 60).padStart(2, '0')}Z`;
      for (let i = 1; i <= 8; i++) ids.push([`${next()}-version-v${i}`, 'version', { version: i }]);
      for (let i = 1; i <= 9; i++) ids.push([`${next()}-daily`, 'daily']);
      for (const k of ['before-restore', 'before-import', 'before-wipe', 'before-restore', 'before-wipe', 'before-import', 'before-wipe']) ids.push([`${next()}-${k}`, k]);
      for (let i = 1; i <= 10; i++) ids.push([`${next()}-manual`, 'manual', { label: `m${i}` }]);
      for (const [id, kind, extra] of ids) await make(id, kind, extra);
      await keep(root, DEFAULT_LIMITS);
      const left = await listSnapshots(root);
      const count = (k) => left.filter((s) => s.kind === k).length;
      assert.equal(count('version'), 5);
      assert.deepEqual(left.filter((s) => s.kind === 'version').map((s) => s.version), [8, 7, 6, 5, 4]);
      assert.equal(count('daily'), 7);
      assert.equal(left.filter((s) => s.kind.startsWith('before-')).length, 5);
      assert.deepEqual(left.filter((s) => s.kind.startsWith('before-')).map((s) => s.kind), ['before-wipe', 'before-import', 'before-wipe', 'before-restore', 'before-wipe']);
      assert.equal(count('manual'), 10);

      // Budget: 27 left × 10 bytes; 200 bytes keeps the manual ones (100)
      // and the newest automatic ones (10 of them), never `spare`.
      const oldestDaily = left.filter((s) => s.kind === 'daily').at(-1).id;
      await keep(root, { ...DEFAULT_LIMITS, snapshotDiskBytes: 200 }, [oldestDaily]);
      const after = await listSnapshots(root);
      assert.equal(after.filter((s) => s.kind === 'manual').length, 10);
      assert.ok(after.some((s) => s.id === oldestDaily));
      assert.equal(after.length, 20);
      assert.equal((await keep(root, { ...DEFAULT_LIMITS, snapshotDiskBytes: 1 }), (await listSnapshots(root)).length), 10, 'manual ones are never removed for the budget');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('a daily snapshot after a call, when the newest is a day old', async () => {
    let now = Date.UTC(2026, 10, 25, 12);
    await withRunner(
      {},
      async (r) => {
        const p = pageOf(r, 'daily-1');
        const dailies = async () => (await p.data()).snapshots.filter((s) => s.kind === 'daily');
        await p.call('/add?v=1');
        await until(async () => (await dailies()).length === 1);
        assert.match((await dailies())[0].id, /^20261125T120000Z-daily$/);
        assert.equal((await dailies())[0].createdAt, '2026-11-25T12:00:00.000Z');
        now += 23 * 3600_000;
        await p.call('/add?v=2');
        await new Promise((res) => setTimeout(res, 200));
        await r.runner.pages.idle('daily-1');
        assert.equal((await dailies()).length, 1, 'not yet a day');
        now += 2 * 3600_000;
        await p.call('/add?v=3');
        await until(async () => (await dailies()).length === 2);
        for (let d = 0; d < 8; d++) {
          now += 25 * 3600_000;
          const want = Math.min(3 + d, 7);
          // The last one is done (pruning included): a call while it runs
          // would not start another.
          await r.runner.pages.idle('daily-1');
          await p.call('/add?v=x');
          await until(async () => (await dailies()).length === want && (await dailies())[0].createdAt === new Date(now).toISOString());
        }
        assert.equal((await dailies()).length, 7, 'the last 7 are kept');
        assert.match(await logText(r, 'daily-1'), /daily snapshot: \d{8}T\d{6}Z-daily/);
      },
      { now: () => now },
    );
  });

  test('a page whose calls write nothing gets no daily snapshot', () =>
    withRunner({}, async (r) => {
      r.publish(backend(`export default { fetch: () => new Response('hi') }`), 'quiet');
      const code = r.specola.versions.get('quiet');
      await r.invoke({ versionId: 'quiet', codeHash: code.codeHash, page: 'quiet-1' });
      await new Promise((res) => setTimeout(res, 200));
      await r.runner.pages.idle('quiet-1');
      assert.deepEqual((await r.api('GET', '/pages/quiet-1/data')).body.snapshots, []);
    }));
});

describe('restore and wipe', () => {
  test('restore replaces shared, users and files, and can be undone', () =>
    withRunner({}, async (r) => {
      const p = pageOf(r, 'r-1');
      await p.call('/add?v=a');
      await p.mine();
      await p.call('/mine?v=mine-a');
      await p.put('f.txt', 'one', 'text/plain');
      const s = (await p.snap('good state')).body;

      await p.call('/add?v=b');
      await p.put('f.txt', 'two', 'text/plain');
      await p.put('g.txt', 'gee', 'text/plain');
      await p.call('/mine?v=u2', { user: u2, role: 'viewer' });

      const res = await r.api('POST', `/pages/r-1/snapshots/${s.id}/restore`);
      assert.equal(res.status, 200);
      assert.equal(res.body.before.kind, 'before-restore');
      assert.match(res.body.before.id, /Z-before-restore$/);
      assert.deepEqual(await p.rows(), ['a']);
      assert.equal(String(await p.get('f.txt')), 'one');
      assert.equal(await p.get('g.txt'), null);
      assert.deepEqual(await p.mine(), ['mine-a']);
      assert.deepEqual(await p.mine(u2), [], 'user 2 had no data in the snapshot');

      // Undo: the before-restore snapshot holds everything, files included.
      assert.equal((await r.api('POST', `/pages/r-1/snapshots/${res.body.before.id}/restore`)).status, 200);
      assert.deepEqual(await p.rows(), ['a', 'b']);
      assert.equal(String(await p.get('f.txt')), 'two');
      assert.equal(String(await p.get('g.txt')), 'gee');
      assert.deepEqual(await p.mine(u2), ['u2']);
      assert.match(await logText(r, 'r-1'), /data restored from snapshot/);
    }));

  test('a restore whose file contents went missing is refused and changes nothing', () =>
    withRunner({}, async (r) => {
      const p = pageOf(r, 'r-2');
      await p.put('f.txt', 'one', 'text/plain');
      const s = (await p.snap('x')).body;
      await p.put('f.txt', 'two', 'text/plain');
      await fs.rm(path.join(pageDir(r, 'r-2'), 'files', 'blobs', sha256('one')));
      const res = await r.api('POST', `/pages/r-2/snapshots/${s.id}/restore`);
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'internal');
      assert.match(res.body.message, /contents of 1 of its files are missing/);
      assert.equal(String(await p.get('f.txt')), 'two');
      assert.equal((await p.data()).snapshots.filter((x) => x.kind === 'before-restore').length, 0);
    }));

  test('restoring the oldest before-* snapshot keeps it while the new one is taken', () =>
    withRunner({}, async (r) => {
      const p = pageOf(r, 'r-3');
      await p.call('/add?v=0');
      let first;
      for (let i = 1; i <= 5; i++) {
        const w = await r.api('POST', '/pages/r-3/wipe', { json: { scope: 'shared' } });
        first ??= w.body.before;
        await p.call(`/add?v=${i}`);
      }
      const res = await r.api('POST', `/pages/r-3/snapshots/${first.id}/restore`);
      assert.equal(res.status, 200);
      assert.deepEqual(await p.rows(), ['0']);
      assert.equal((await p.data()).snapshots.filter((s) => s.kind.startsWith('before-')).length, 5);
    }));

  test('wipe: shared data and files, or every user\'s data, after a snapshot', () =>
    withRunner({}, async (r) => {
      const p = pageOf(r, 'w-1');
      await p.call('/add?v=a');
      await p.put('k', 'contents', 'text/plain');
      await p.call('/mine?v=mine');
      await p.call('/mine?v=theirs', { user: u2, role: 'viewer' });

      const shared = await r.api('POST', '/pages/w-1/wipe', { json: { scope: 'shared' } });
      assert.equal(shared.status, 200);
      assert.equal(shared.body.before.kind, 'before-wipe');
      assert.deepEqual(await p.rows(), []);
      assert.deepEqual(await p.list(), []);
      assert.deepEqual(await p.mine(), ['mine']);
      // The blob stays for the snapshot that names it.
      await fs.access(path.join(pageDir(r, 'w-1'), 'files', 'blobs', sha256('contents')));

      const users = await r.api('POST', '/pages/w-1/wipe', { json: { scope: 'users' } });
      assert.equal(users.status, 200);
      assert.deepEqual(await p.mine(), []);
      assert.deepEqual(await p.mine(u2), []);
      assert.deepEqual(await p.rows(), []);

      await r.api('POST', `/pages/w-1/snapshots/${shared.body.before.id}/restore`);
      assert.deepEqual(await p.rows(), ['a']);
      assert.equal(String(await p.get('k')), 'contents');
      assert.deepEqual(await p.mine(u2), ['theirs']);
    }));
});

describe('maintenance takes the page offline', () => {
  test('calls wait for it, the worker drains first, the next call starts a fresh one', () =>
    withRunner({}, async (r) => {
      const p = pageOf(r, 'off-1');
      await p.call('/add?v=a');
      const order = [];
      const slow = p.call('/slow?ms=600').then((x) => (order.push('slow'), x));
      await until(async () => /worker started/.test(await logText(r, 'off-1')));
      await new Promise((res) => setTimeout(res, 100));
      const wipe = r.api('POST', '/pages/off-1/wipe', { json: { scope: 'shared' } }).then((x) => (order.push('wipe'), x));
      await new Promise((res) => setTimeout(res, 100));
      const waiting = p.rows().then((x) => (order.push('call'), x));
      assert.equal((await slow).text, 'slow done', 'the call in flight finished');
      assert.equal((await wipe).status, 200);
      assert.deepEqual(await waiting, [], 'the waiting call ran after the wipe, on the wiped data');
      assert.deepEqual(order, ['slow', 'wipe', 'call']);
      const log = await logText(r, 'off-1');
      assert.match(log, /page offline for a wipe: stopping its worker/);
      assert.match(log, /stopped \(drained\)[\s\S]*worker started/);
    }));

  test('a call that waits past the first-byte timeout answers 503 backend-unavailable', () =>
    withRunner({ firstByteMs: 400 }, async (r) => {
      const p = pageOf(r, 'off-2');
      await p.call('/add?v=a');
      const streaming = p.call('/stream?ms=1500');
      await new Promise((res) => setTimeout(res, 150));
      const restore = r.api('POST', '/pages/off-2/wipe', { json: { scope: 'users' } });
      await new Promise((res) => setTimeout(res, 100));
      const t0 = Date.now();
      const late = await p.call('/rows');
      assert.equal(late.status, 503);
      assert.equal(late.error, 'backend-unavailable');
      assert.match(JSON.parse(late.text).message, /offline for a wipe/);
      assert.ok(Date.now() - t0 < 1000);
      assert.equal((await streaming).text, 'start end');
      assert.equal((await restore).status, 200);
      assert.deepEqual(await p.rows(), ['a'], 'back online');
    }));
});

describe('export and import', () => {
  test('round trip: files and shared rows byte for byte, users untouched', () =>
    withRunner({}, async (r) => {
      const src = pageOf(r, 'x-src');
      const blob = randomBytes(64).toString('hex');
      await src.call(`/add?v=${encodeURIComponent('héllo ✓')}&blob=${blob}`);
      await src.call('/add?v=plain');
      const files = [
        ['a.txt', Buffer.from('some text '.repeat(1000)), 'text/plain'],
        ['img/p.png', randomBytes(30_000), 'image/png'],
        ['empty', Buffer.alloc(0), 'application/octet-stream'],
        ['same-as-a.txt', Buffer.from('some text '.repeat(1000)), 'text/plain'],
        ['deep/er/big.bin', randomBytes(3 * 1024 * 1024), 'application/octet-stream'],
        ['ünï code.json', Buffer.from('{"x":1}'), 'application/json'],
      ];
      for (const [k, d, t] of files) assert.equal((await src.put(k, d, t)).status, 200);
      await src.call('/mine?v=src-user');

      const exp = await fetch(`${r.url}/pages/x-src/export`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(exp.status, 200);
      assert.equal(exp.headers.get('content-type'), 'application/zip');
      const zip = Buffer.from(await exp.arrayBuffer());
      const zipFile = path.join(r.dataDir, 'export.zip');
      await fs.writeFile(zipFile, zip);
      // Another reader agrees on the layout and the methods.
      const listing = JSON.parse(execFileSync('python3', ['-I', '-c', `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({i.filename: i.compress_type for i in z.infolist()}))
`, zipFile]));
      assert.deepEqual(listing, {
        'manifest.json': 8,
        'shared.sqlite': 0,
        'files/index.json': 8,
        'files/data/a.txt': 8,
        'files/data/deep/er/big.bin': 8,
        'files/data/empty': 8,
        'files/data/img/p.png': 0,
        'files/data/same-as-a.txt': 8,
        'files/data/ünï code.json': 8,
      });
      const manifest = JSON.parse(execFileSync('unzip', ['-p', zipFile, 'manifest.json']));
      assert.deepEqual(Object.keys(manifest), ['format', 'formatVersion', 'page', 'exportedAt']);
      assert.equal(manifest.format, 'specola-backend-data');
      assert.equal(manifest.formatVersion, 1);
      assert.deepEqual(manifest.page, { id: 'x-src', title: 'Test page', version: 1 });
      const index = JSON.parse(execFileSync('unzip', ['-p', zipFile, 'files/index.json']));
      assert.deepEqual(index.find((f) => f.key === 'img/p.png'), { key: 'img/p.png', contentType: 'image/png', size: 30_000, sha256: sha256(files[1][1]) });
      // The pin goes once the zip is written, which the client may see
      // complete a moment before.
      await until(async () => (await fs.readdir(path.join(r.dataDir, 'snapshots', 'x-src'))).filter((n) => n.startsWith('.tmp-')).length === 0);

      const dst = pageOf(r, 'x-dst');
      await dst.call('/add?v=old');
      await dst.put('old.txt', 'old', 'text/plain');
      await dst.call('/mine?v=dst-user');
      const imp = await r.api('PUT', '/pages/x-dst/import', { body: zip, headers: { 'content-type': 'application/zip' } });
      assert.equal(imp.status, 200, JSON.stringify(imp.body));
      assert.equal(imp.body.before.kind, 'before-import');

      assert.deepEqual((await dst.call('/rows')).json(), (await src.call('/rows')).json());
      assert.deepEqual(await dst.list(), await src.list());
      for (const [k, d] of files) assert.ok((await dst.get(k)).equals(d), k);
      assert.deepEqual(await dst.mine(), ['dst-user'], 'users\' databases are not imported or replaced');
      assert.match(await logText(r, 'x-dst'), /data imported: a shared database and 6 file\(s\)/);

      // And back: the before-import snapshot restores what was there.
      await r.api('POST', `/pages/x-dst/snapshots/${imp.body.before.id}/restore`);
      assert.deepEqual(await dst.rows(), ['old']);
      assert.equal(String(await dst.get('old.txt')), 'old');
    }));

  test('an export of a page without a shared database or files', () =>
    withRunner({}, async (r) => {
      const res = await r.api('GET', '/pages/nothing/export');
      assert.equal(res.status, 200);
      const file = path.join(r.dataDir, 'e.zip');
      await fs.writeFile(file, res.body);
      assert.deepEqual(execFileSync('unzip', ['-Z1', file]).toString().trim().split('\n'), ['manifest.json', 'files/index.json']);
      assert.equal(execFileSync('unzip', ['-p', file, 'files/index.json']).toString(), '[]');
      // Which imports, as an empty page.
      const p = pageOf(r, 'gets-nothing');
      await p.call('/add?v=x');
      assert.equal((await r.api('PUT', '/pages/gets-nothing/import', { body: res.body })).status, 200);
      assert.deepEqual(await p.rows(), []);
    }));

  test('a bad import answers 400 bad-import and changes nothing', () =>
    withRunner({ importBytes: 1_000_000 }, async (r) => {
      const p = pageOf(r, 'evil');
      await p.call('/add?v=keep');
      await p.put('k', 'keep', 'text/plain');
      const state = async () => [await p.rows(), await p.list(), (await p.data()).snapshots.length];
      const before = await state();
      const cases = [
        [craftZip([...exportEntries({ files: [{ key: 'a', data: 'a' }] }), { name: 'files/data/../../../state/evil.json', data: 'x' }]), /"\.\." segment/],
        [craftZip(exportEntries({ files: [{ key: 'a', data: 'a' }], index: [{ key: 'a', contentType: 'text/plain', size: 1, sha256: sha256('b') }] })), /does not match its sha256/],
        [craftZip([{ name: 'manifest.json', data: '{}' }]), /format is not/],
        [craftZip([...exportEntries(), { name: 'files/data/l', data: '/etc', method: 0, attrs: (0o120777 << 16) >>> 0 }]), /symbolic link/],
        [Buffer.from('not a zip'), /not a zip/],
      ];
      for (const [zip, re] of cases) {
        const res = await r.api('PUT', '/pages/evil/import', { body: zip });
        assert.equal(res.status, 400);
        assert.equal(res.headers.get('x-specola-error'), 'bad-import');
        assert.match(res.body.message, re);
      }
      const big = await r.api('PUT', '/pages/evil/import', { body: Buffer.alloc(1_000_001) });
      assert.equal(big.status, 413);
      assert.equal(big.body.error, 'body-too-large');
      const over = craftZip(exportEntries({ files: [{ key: 'z', data: Buffer.alloc(900_000) }] }));
      assert.equal((await r.api('PUT', '/pages/evil/import', { body: over })).status, 200, 'under the zip limit, the quota is the page\'s');
      await r.api('POST', `/pages/evil/snapshots/${(await p.data()).snapshots[0].id}/restore`);
      const after = await state();
      assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
      await fs.access(path.join(r.dataDir, 'tmp'));
      assert.deepEqual(await fs.readdir(path.join(r.dataDir, 'tmp')), [], 'nothing left behind');
    }));

  test('an import over the page quota is refused', () =>
    withRunner({ pageDiskBytes: 500_000 }, async (r) => {
      const p = pageOf(r, 'q-imp');
      await p.call('/mine?v=x'.padEnd(10, 'x'));
      const zip = craftZip(exportEntries({ files: [{ key: 'z', data: Buffer.alloc(600_000) }] }));
      const res = await r.api('PUT', '/pages/q-imp/import', { body: zip });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /more than the page has room for/);
    }));
});

describe('quotas: blobs only snapshots keep are the snapshots\'', () => {
  test('a shared wipe frees the page\'s room; the snapshot carries the files', () =>
    withRunner({ pageDiskBytes: 1_000_000 }, async (r) => {
      const p = pageOf(r, 'qw');
      assert.equal((await p.put('a', randomBytes(600_000))).status, 200);
      assert.equal((await r.api('POST', '/pages/qw/wipe', { json: { scope: 'shared' } })).status, 200);
      const { usage } = await p.data();
      assert.ok(usage.pageBytes < 100_000, `page bytes ${usage.pageBytes}`);
      assert.ok(usage.snapshotBytes >= 600_000, `snapshot bytes ${usage.snapshotBytes}`);
      assert.equal(usage.pageBytes, await pageUsage(pageDir(r, 'qw'), path.join(r.dataDir, 'snapshots', 'qw')));
      // Room for new files.
      assert.equal((await p.put('b', randomBytes(600_000))).status, 200);
    }));

  test('an import does not pile the new files on the old ones', () =>
    withRunner({ pageDiskBytes: 1_000_000 }, async (r) => {
      const p = pageOf(r, 'qi');
      assert.equal((await p.put('old', randomBytes(600_000))).status, 200);
      const zip = craftZip(exportEntries({ files: [{ key: 'new', data: randomBytes(600_000) }] }));
      assert.equal((await r.api('PUT', '/pages/qi/import', { body: zip })).status, 200);
      const { usage } = await p.data();
      assert.ok(usage.pageBytes < 1_000_000, `page bytes ${usage.pageBytes}`);
      assert.equal((await p.put('small', randomBytes(10_000))).status, 200);
    }));

  test('the snapshot budget counts those files once, and retention frees them', () =>
    withRunner({ snapshotDiskBytes: 1_000_000 }, async (r) => {
      const p = pageOf(r, 'qb');
      const ids = [];
      for (const k of ['a', 'b']) {
        assert.equal((await p.put(k, randomBytes(600_000))).status, 200);
        ids.push((await r.api('POST', '/pages/qb/wipe', { json: { scope: 'shared' } })).body.before.id);
      }
      const { usage, snapshots } = await p.data();
      // The first wipe's snapshot (and any daily one that named a) went to
      // make room for the second's.
      assert.deepEqual(snapshots.filter((s) => s.kind === 'before-wipe').map((s) => s.id), [ids[1]]);
      assert.ok(usage.snapshotBytes <= 1_000_000 && usage.snapshotBytes >= 600_000, `snapshot bytes ${usage.snapshotBytes}`);
    }));
});

describe('restore leaves nothing half done', () => {
  test('the before-restore snapshot survives the retention after the restore', () =>
    withRunner({ snapshotDiskBytes: 350_000 }, async (r) => {
      const p = pageOf(r, 'rk');
      await p.call('/big?n=100000');
      const manual = [];
      for (let i = 1; i <= 3; i++) manual.push((await p.snap(`m${i}`)).body);
      await p.call('/add?v=after');
      const res = await r.api('POST', `/pages/rk/snapshots/${manual[0].id}/restore`);
      assert.equal(res.status, 200);
      const ids = (await p.data()).snapshots.map((s) => s.id);
      assert.ok(ids.includes(res.body.before.id), 'the restore can be undone');
      assert.equal((await r.api('POST', `/pages/rk/snapshots/${res.body.before.id}/restore`)).status, 200);
      assert.deepEqual(await p.rows(), ['big', 'after']);
    }));

  test('a restore that fails while building the data changes nothing', () =>
    withRunner({}, async (r) => {
      const p = pageOf(r, 'ra');
      await p.call('/add?v=one');
      await p.put('k', 'one', 'text/plain');
      await p.call('/mine?v=mine');
      const snap = (await p.snap('one')).body;
      await p.call('/add?v=two');
      await p.put('k', 'two', 'text/plain');
      // A user's database in the snapshot that can't be copied: the shared
      // database and the file index were copied already.
      const users = path.join(r.dataDir, 'snapshots', 'ra', snap.id, 'users');
      const [db] = await fs.readdir(users);
      await fs.rm(path.join(users, db));
      await fs.mkdir(path.join(users, db));
      const res = await r.api('POST', `/pages/ra/snapshots/${snap.id}/restore`);
      assert.equal(res.status, 500);
      assert.deepEqual(await p.rows(), ['one', 'two']);
      assert.equal(String(await p.get('k')), 'two');
      assert.deepEqual(await p.mine(), ['mine']);
      await assert.rejects(fs.access(path.join(r.dataDir, 'swap', 'ra')), 'nothing left aside');
    }));

  test('a swap the runner died in is finished if it committed, dropped if not', () =>
    withRunner({}, async (r) => {
      const table = (file, v) => {
        const db = new DatabaseSync(file);
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, b BLOB)');
        db.prepare('INSERT INTO t (v) VALUES (?)').run(v);
        db.close();
      };
      for (const [id, committed] of [['died-1', true], ['died-2', false]]) {
        await fs.mkdir(pageDir(r, id), { recursive: true });
        table(path.join(pageDir(r, id), 'shared.sqlite'), 'old');
        const swap = path.join(r.dataDir, 'swap', id);
        await fs.mkdir(path.join(swap, 'new'), { recursive: true });
        table(path.join(swap, 'new', 'shared.sqlite'), 'new');
        if (committed) {
          const has = { 'shared.sqlite': true, 'files.sqlite': false };
          await fs.writeFile(path.join(swap, 'journal.json'), JSON.stringify({ slots: ['shared.sqlite', 'files.sqlite'], has }));
        }
        assert.deepEqual(await pageOf(r, id).rows(), [committed ? 'new' : 'old'], id);
        await assert.rejects(fs.access(swap), `${id}: the swap is gone`);
      }
      assert.match(await logText(r, 'died-1'), /finished replacing the data/);
    }));
});

describe('transfers', () => {
  test('only a few run at once per page; the others answer 429', () =>
    withRunner({ transfersPerPage: 1 }, async (r) => {
      const p = pageOf(r, 'tr');
      await p.call('/add?v=x');
      // An import whose zip is still coming.
      const req = http.request(`${r.url}/pages/tr/import`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-length': '100000' },
      });
      req.on('error', () => {});
      req.write(Buffer.alloc(1000));
      await until(async () => (await fs.readdir(path.join(r.dataDir, 'tmp')).catch(() => [])).some((n) => n.endsWith('.zip')));
      for (const [method, route] of [['GET', '/pages/tr/export'], ['PUT', '/pages/tr/import']]) {
        const res = await r.api(method, route, method === 'PUT' ? { body: 'PK' } : {});
        assert.equal(res.status, 429, route);
        assert.equal(res.body.error, 'too-many-requests');
      }
      assert.equal((await r.api('GET', '/pages/other/export')).status, 200, 'other pages are not held');
      req.destroy();
      await until(async () => (await r.api('GET', '/pages/tr/export')).status === 200);
    }));

  test('an export\'s manifest says the page as specola has it', () =>
    withRunner({}, async (r) => {
      const p = pageOf(r, 'about');
      await p.call('/add?v=x');
      const res = await r.api('GET', `/pages/about/export?title=${encodeURIComponent('Renamed ✓')}&version=7`);
      const file = path.join(r.dataDir, 'about.zip');
      await fs.writeFile(file, res.body);
      assert.deepEqual(JSON.parse(execFileSync('unzip', ['-p', file, 'manifest.json'])).page, { id: 'about', title: 'Renamed ✓', version: 7 });
    }));
});

describe('my data', () => {
  test('download a consistent copy, then delete it while the worker has it open', () =>
    withRunner({}, async (r) => {
      const p = pageOf(r, 'me-1');
      await p.call('/mine?v=one');
      await p.call('/mine?v=two');
      await p.call('/mine?v=theirs', { user: u2, role: 'viewer' });

      const res = await r.api('GET', '/pages/me-1/my-data', { sub: 'user-1' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/vnd.sqlite3');
      assert.equal(Number(res.headers.get('content-length')), res.body.length);
      const file = path.join(r.dataDir, 'mine.sqlite');
      await fs.writeFile(file, res.body);
      const db = new DatabaseSync(file, { readOnly: true });
      assert.deepEqual(db.prepare('SELECT v FROM m').all().map((x) => x.v), ['one', 'two']);
      db.close();
      assert.equal((await r.api('GET', '/pages/me-1/my-data', { sub: 'nobody' })).body.error, 'no-data');

      assert.equal((await r.api('DELETE', '/pages/me-1/my-data', { sub: 'user-1' })).status, 204);
      const users = path.join(pageDir(r, 'me-1'), 'users');
      assert.deepEqual((await fs.readdir(users)).filter((n) => n.startsWith(hash('user-1'))), []);
      assert.equal((await r.api('GET', '/pages/me-1/my-data', { sub: 'user-1' })).status, 404);
      // The same worker goes on, with a fresh database for that user.
      assert.deepEqual(await p.mine(), []);
      assert.deepEqual(await p.call('/mine?v=again').then((x) => x.json()), ['again']);
      assert.deepEqual(await p.mine(u2), ['theirs']);
      assert.doesNotMatch(await logText(r, 'me-1'), /crashed|stopped/);
      assert.equal((await r.api('DELETE', '/pages/me-1/my-data', { sub: 'never-here' })).status, 204);
    }));
});

// Only the user's database for /mine: a snapshot of a page where one user
// has data and nothing else holds nothing once that user deletes theirs.
const USERS_BACKEND = backend(`export default {
  async fetch(request, ctx) {
    const url = new URL(request.url);
    const v = url.searchParams.get('v');
    if (url.pathname === '/mine') {
      ctx.userDb.exec('CREATE TABLE IF NOT EXISTS m (v TEXT)');
      if (v) ctx.userDb.prepare('INSERT INTO m VALUES (?)').run(v);
      return Response.json(ctx.userDb.prepare('SELECT v FROM m').all().map((r) => r.v));
    }
    ctx.db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT, b BLOB)');
    if (url.pathname === '/add') ctx.db.prepare('INSERT INTO t (v) VALUES (?)').run(v);
    if (url.pathname === '/big') ctx.db.prepare('INSERT INTO t (v, b) VALUES (?, randomblob(?))').run('big', Number(url.searchParams.get('n')));
    return Response.json(ctx.db.prepare('SELECT v FROM t ORDER BY id').all().map((r) => r.v));
  },
}`);

describe('delete my data, in snapshots', () => {
  const usersPage = (r, id) => {
    const v = r.publish(USERS_BACKEND, 'users-1');
    const call = async (p, user) => {
      const res = await r.invoke({ ...v, page: id, version: 1, path: p, ...(user ? { user, role: 'viewer' } : {}) });
      assert.equal(res.status, 200, p);
      return res.json();
    };
    return {
      call,
      snap: async (label) => {
        const res = await r.api('POST', `/pages/${id}/snapshots`, { json: { kind: 'manual', label } });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body;
      },
      restore: async (sid) => assert.equal((await r.api('POST', `/pages/${id}/snapshots/${sid}/restore`)).status, 200),
      data: async () => (await r.api('GET', `/pages/${id}/data`)).body,
      idle: () => r.runner.pages.idle(id),
    };
  };
  const snapDir = (r, id, sid) => path.join(r.dataDir, 'snapshots', id, sid);
  const holds = async (r, id, sid, sub) => fs.access(path.join(snapDir(r, id, sid), 'users', `${hash(sub)}.sqlite`)).then(() => true, () => false);
  const meta = async (r, id, sid) => JSON.parse(await fs.readFile(path.join(snapDir(r, id, sid), 'meta.json'), 'utf8'));
  // What a snapshot's copies take, as meta.json counts them.
  const copies = async (dir) => {
    let n = 0;
    for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
      if (e.isFile() && !(e.name === 'meta.json' && (e.parentPath ?? e.path) === dir)) n += (await fs.stat(path.join(e.parentPath ?? e.path, e.name))).size;
    }
    return n;
  };
  const state = async (r, id) => JSON.parse(await fs.readFile(path.join(r.dataDir, 'state', `${id}.json`), 'utf8'));

  test('removes the user\'s database from every snapshot, updates sizes, deletes the ones left empty, keeps the rest', () =>
    withRunner({}, async (r) => {
      const p = usersPage(r, 'es');
      await p.call('/mine?v=one'); // user-1; the daily snapshot holds only this
      await p.idle();
      const onlyMine = await p.snap('only user-1');
      await p.call('/mine?v=theirs', u2);
      await p.call('/add?v=shared');
      const all = await p.snap('everyone');
      const allBefore = await meta(r, 'es', all.id);
      const daily = (await p.data()).snapshots.find((s) => s.kind === 'daily');
      assert.ok(daily && (await holds(r, 'es', daily.id, 'user-1')));

      assert.equal((await r.api('DELETE', '/pages/es/my-data', { sub: 'user-1' })).status, 204);

      const { snapshots, usage } = await p.data();
      const ids = snapshots.map((s) => s.id);
      assert.ok(!ids.includes(onlyMine.id), 'a snapshot left with nothing is deleted');
      assert.ok(!ids.includes(daily.id), 'automatic ones too');
      assert.ok(ids.includes(all.id));
      for (const s of snapshots) assert.equal(await holds(r, 'es', s.id, 'user-1'), false, s.id);
      assert.equal(await holds(r, 'es', all.id, 'user-2'), true, 'other users\' databases stay');
      await fs.access(path.join(snapDir(r, 'es', all.id), 'shared.sqlite'));
      const allAfter = await meta(r, 'es', all.id);
      assert.ok(allAfter.sizeBytes < allBefore.sizeBytes, 'the size went down');
      assert.equal(allAfter.sizeBytes, await copies(snapDir(r, 'es', all.id)));
      assert.deepEqual({ ...allAfter, sizeBytes: 0 }, { ...allBefore, sizeBytes: 0 }, 'nothing else changes in meta.json');
      assert.equal(snapshots.find((s) => s.id === all.id).sizeBytes, allAfter.sizeBytes);
      assert.equal(usage.snapshotBytes, snapshots.reduce((n, s) => n + s.sizeBytes, 0));
      assert.deepEqual((await fs.readdir(path.join(r.dataDir, 'snapshots', 'es'))).filter((n) => n.startsWith('.tmp-')), []);
      assert.deepEqual((await state(r, 'es')).erased, [{ user: hash('user-1'), snapshots: [all.id], stage: 'done' }]);

      // A restore of the older snapshot: user-1's data does not come back,
      // the rest does.
      await p.call('/add?v=later');
      await p.restore(all.id);
      assert.deepEqual(await p.call('/mine'), []);
      assert.deepEqual(await p.call('/mine', u2), ['theirs']);
      assert.deepEqual(await p.call('/rows'), ['shared']);
      // Not even a copy that survived somehow.
      const stray = path.join(snapDir(r, 'es', all.id), 'users', `${hash('user-1')}.sqlite`);
      await fs.copyFile(path.join(snapDir(r, 'es', all.id), 'users', `${hash('user-2')}.sqlite`), stray);
      await p.restore(all.id);
      assert.deepEqual(await p.call('/mine'), []);
      assert.deepEqual(await p.call('/mine', u2), ['theirs']);
      await fs.rm(stray);

      // Using the page again makes new data, which snapshots keep and
      // restores bring back.
      assert.deepEqual(await p.call('/mine?v=again'), ['again']);
      const later = await p.snap('after deleting');
      await p.call('/mine?v=more');
      await p.restore(all.id);
      assert.deepEqual(await p.call('/mine'), []);
      await p.restore(later.id);
      assert.deepEqual(await p.call('/mine'), ['again']);
      assert.deepEqual(await p.call('/mine', u2), ['theirs']);

      // The record goes with the last snapshot it names.
      assert.equal((await r.api('DELETE', `/pages/es/snapshots/${all.id}`)).status, 204);
      await p.snap('after the old one went');
      assert.equal((await state(r, 'es')).erased, undefined);
    }));

  test('a user without data anywhere: nothing recorded', () =>
    withRunner({}, async (r) => {
      const p = usersPage(r, 'es-none');
      await p.call('/add?v=x');
      await p.snap('x');
      assert.equal((await r.api('DELETE', '/pages/es-none/my-data', { sub: 'never-here' })).status, 204);
      assert.equal((await state(r, 'es-none')).erased, undefined);
      assert.equal((await p.data()).snapshots.length, 2);
    }));

  test('a snapshot in progress during the deletion finishes, and is rewritten too', () =>
    withRunner({}, async (r) => {
      const p = usersPage(r, 'es-race');
      await p.call('/mine?v=mine');
      await p.call('/mine?v=theirs', u2);
      for (let i = 0; i < 4; i++) await p.call('/big?n=10000000'); // a slow VACUUM INTO
      await p.idle();
      const dir = path.join(r.dataDir, 'snapshots', 'es-race');
      const snapping = r.api('POST', '/pages/es-race/snapshots', { json: { kind: 'manual', label: 'racing' } });
      await until(async () => (await fs.readdir(dir)).some((n) => n.startsWith('.tmp-')), { every: 2 });
      const deleting = r.api('DELETE', '/pages/es-race/my-data', { sub: 'user-1' });
      const snap = await snapping;
      assert.equal(snap.status, 201);
      assert.equal((await deleting).status, 204);
      for (const s of (await p.data()).snapshots) assert.equal(await holds(r, 'es-race', s.id, 'user-1'), false, s.id);
      assert.equal(await holds(r, 'es-race', snap.body.id, 'user-2'), true);
      assert.equal((await meta(r, 'es-race', snap.body.id)).sizeBytes, await copies(snapDir(r, 'es-race', snap.body.id)));
      await p.restore(snap.body.id);
      assert.deepEqual(await p.call('/mine'), []);
      assert.deepEqual(await p.call('/mine', u2), ['theirs']);
    }));

  test('a deletion the runner died in is finished at the next start', () =>
    withRunner({}, async (r) => {
      for (const stage of ['live', 'snapshots']) {
        const id = `es-crash-${stage}`;
        const p = usersPage(r, id);
        await p.call('/mine?v=mine');
        await p.call('/mine?v=theirs', u2);
        await p.call('/add?v=shared');
        const snap = await p.snap('before');
        const onlyMine = path.join(r.dataDir, 'snapshots', id, '20200101T000000Z-manual');
        await fs.mkdir(path.join(onlyMine, 'users'), { recursive: true });
        await fs.copyFile(path.join(snapDir(r, id, snap.id), 'users', `${hash('user-1')}.sqlite`), path.join(onlyMine, 'users', `${hash('user-1')}.sqlite`));
        await fs.writeFile(path.join(onlyMine, 'meta.json'), JSON.stringify({ kind: 'manual', label: 'old', createdAt: '2020-01-01T00:00:00.000Z', sizeBytes: 1 }));
        await p.idle();
        // What the runner had done when it died: recorded the erasure and,
        // at the "snapshots" stage, deleted the live database.
        const live = path.join(pageDir(r, id), 'users', `${hash('user-1')}.sqlite`);
        if (stage === 'snapshots') for (const x of ['', '-wal', '-shm']) await fs.rm(live + x, { force: true });
        const st = await state(r, id);
        const holding = [];
        for (const n of await fs.readdir(path.join(r.dataDir, 'snapshots', id))) if (await holds(r, id, n, 'user-1')) holding.push(n);
        assert.ok(holding.includes(snap.id) && holding.length >= 3, 'the daily one holds it too');
        st.erased = [{ user: hash('user-1'), snapshots: holding, stage }];
        await fs.writeFile(path.join(r.dataDir, 'state', `${id}.json`), JSON.stringify(st));
      }
      // A new runner process on the same data.
      const r2 = createRunner({ ...r.config });
      try {
        await r2.sweep();
        for (const stage of ['live', 'snapshots']) {
          assert.match(r2.logs.since(`es-crash-${stage}`).map((l) => l.text).join('\n'), /finished deleting a user's data/);
        }
      } finally {
        await r2.close();
      }
      for (const stage of ['live', 'snapshots']) {
        const id = `es-crash-${stage}`;
        const names = await fs.readdir(path.join(r.dataDir, 'snapshots', id));
        assert.ok(!names.includes('20200101T000000Z-manual'), `${stage}: left empty, deleted`);
        for (const n of names) assert.equal(await holds(r, id, n, 'user-1'), false, `${stage}: ${n}`);
        const [snap] = names.filter((n) => n.endsWith('-manual'));
        assert.equal(await holds(r, id, snap, 'user-2'), true);
        assert.equal((await meta(r, id, snap)).sizeBytes, await copies(snapDir(r, id, snap)));
        assert.deepEqual((await fs.readdir(path.join(pageDir(r, id), 'users'))).filter((n) => n.startsWith(hash('user-1'))), [], `${stage}: the live database is gone`);
        const { erased } = await state(r, id);
        assert.equal(erased[0].stage, 'done');
        assert.ok(erased[0].snapshots.includes(snap) && !erased[0].snapshots.includes('20200101T000000Z-manual'));
      }
    }));
});

describe('purge', () => {
  test('removes data, snapshots, state and logs; again and again', () =>
    withRunner({}, async (r) => {
      const p2 = pageOf(r, 'gone', 2);
      await p2.call('/add?v=a');
      await p2.put('k', 'v');
      await p2.snap('x');
      assert.equal((await r.api('DELETE', '/pages/gone')).status, 204);
      for (const d of [pageDir(r, 'gone'), path.join(r.dataDir, 'snapshots', 'gone'), path.join(r.dataDir, 'state', 'gone.json')]) {
        await assert.rejects(fs.access(d), d);
      }
      assert.deepEqual((await r.logs('gone')).body.lines, []);
      assert.equal((await r.api('DELETE', '/pages/gone')).status, 204);
      assert.equal((await r.api('DELETE', '/pages/never-was')).status, 204);
      // The page's version is forgotten too: version 1 runs, on no data.
      const p1 = pageOf(r, 'gone', 1);
      assert.deepEqual(await p1.rows(), []);
    }));

  test('calls during a purge wait, then start afresh', () =>
    withRunner({}, async (r) => {
      const p = pageOf(r, 'gone-2');
      await p.call('/add?v=a');
      const slow = p.call('/slow?ms=400');
      await new Promise((res) => setTimeout(res, 100));
      const purge = r.api('DELETE', '/pages/gone-2');
      await new Promise((res) => setTimeout(res, 50));
      const after = p.rows();
      assert.equal((await slow).status, 200);
      assert.equal((await purge).status, 204);
      assert.deepEqual(await after, []);
    }));
});

describe('step 1 snapshots', () => {
  test('are read as version snapshots, restorable, and migrated at start', () =>
    withRunner({}, async (r) => {
      const legacy = path.join(r.dataDir, 'snapshots', 'old-1', '20261120T101500.123Z-v3');
      await fs.mkdir(path.join(legacy, 'users'), { recursive: true });
      const db = new DatabaseSync(path.join(legacy, 'shared.sqlite'));
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, b BLOB); INSERT INTO t (v) VALUES ('from step 1')");
      db.close();

      const { snapshots } = (await r.api('GET', '/pages/old-1/data')).body;
      assert.equal(snapshots.length, 1);
      assert.deepEqual({ ...snapshots[0], sizeBytes: 0 }, { id: '20261120T101500Z-version-v3', kind: 'version', version: 3, createdAt: '2026-11-20T10:15:00.123Z', sizeBytes: 0 });
      assert.ok(snapshots[0].sizeBytes > 0);

      const p = pageOf(r, 'old-1', 4);
      await p.call('/add?v=now');
      const res = await r.api('POST', '/pages/old-1/snapshots/20261120T101500Z-version-v3/restore');
      assert.equal(res.status, 200);
      assert.deepEqual(await p.rows(), ['from step 1']);

      await sweepSnapshots(r.dataDir);
      const names = await fs.readdir(path.join(r.dataDir, 'snapshots', 'old-1'));
      assert.ok(names.includes('20261120T101500Z-version-v3'));
      assert.ok(!names.includes('20261120T101500.123Z-v3'));
      const meta = JSON.parse(await fs.readFile(path.join(r.dataDir, 'snapshots', 'old-1', '20261120T101500Z-version-v3', 'meta.json'), 'utf8'));
      assert.deepEqual({ ...meta, sizeBytes: 0 }, { kind: 'version', version: 3, createdAt: '2026-11-20T10:15:00.123Z', sizeBytes: 0 });
      const again = (await r.api('GET', '/pages/old-1/data')).body.snapshots.find((s) => s.kind === 'version');
      assert.equal(again.id, '20261120T101500Z-version-v3');
    }));
});
