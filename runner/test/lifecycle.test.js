import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { backend, logText, startRunner, until } from './helpers.js';
import { DEFAULT_LIMITS } from '../src/config.js';
import { sweepSnapshots, takeSnapshot } from '../src/snapshot.js';
import { FileStore } from '../src/worker/files.mjs';

async function withRunner(limits, fn) {
  const r = await startRunner(limits);
  try {
    await fn(r);
  } finally {
    await r.close();
  }
}

describe('streaming and aborts', () => {
  test('response chunks reach the caller before the handler ends', () =>
    withRunner({}, async (r) => {
      const v = r.publish(
        backend(`let release;
          export default {
            fetch(request) {
              if (new URL(request.url).pathname === '/release') { release(); return new Response('ok'); }
              const gate = new Promise((r) => { release = r; });
              const enc = new TextEncoder();
              return new Response(new ReadableStream({
                async start(c) {
                  c.enqueue(enc.encode('first;'));
                  await gate;
                  c.enqueue(enc.encode('second'));
                  c.close();
                },
              }), { headers: { 'content-type': 'text/plain' } });
            },
          };`),
      );
      const res = await r.invoke({ ...v, page: 's-1' });
      assert.equal(res.status, 200);
      const reader = res.body.getReader();
      const first = await reader.read();
      assert.equal(new TextDecoder().decode(first.value), 'first;');
      // The handler is still waiting: only now let it finish.
      assert.equal(await (await r.invoke({ ...v, page: 's-1', path: '/release' })).text(), 'ok');
      let rest = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += new TextDecoder().decode(value);
      }
      assert.equal(rest, 'second');
    }));

  test('request bodies stream to the handler', () =>
    withRunner({}, async (r) => {
      const v = r.publish(
        backend(`export default {
          async fetch(request) {
            const reader = request.body.getReader();
            const first = await reader.read();
            console.log('got first chunk: ' + new TextDecoder().decode(first.value));
            let n = first.value.length;
            for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
            return new Response(String(n));
          },
        }`),
      );
      let push;
      const body = new ReadableStream({
        start(c) {
          push = c;
          c.enqueue(new TextEncoder().encode('chunk-1'));
        },
      });
      const pending = r.invoke({ ...v, page: 's-2', method: 'POST', body });
      await until(async () => /got first chunk: chunk-1/.test(await logText(r, 's-2')));
      push.enqueue(new TextEncoder().encode('chunk-2'));
      push.close();
      assert.equal(await (await pending).text(), '14');
    }));

  test('a large response streams whole', () =>
    withRunner({}, async (r) => {
      const v = r.publish(backend(`export default { fetch: () => new Response(new Uint8Array(3 * 1024 * 1024 + 7).fill(97)) }`));
      const res = await r.invoke({ ...v, page: 's-3' });
      const buf = new Uint8Array(await res.arrayBuffer());
      assert.equal(buf.length, 3 * 1024 * 1024 + 7);
      assert.ok(buf.every((b) => b === 97));
    }));

  test('a response over the limit is cut', () =>
    withRunner({ maxResponseBytes: 100_000 }, async (r) => {
      const v = r.publish(backend(`export default { fetch: () => new Response(new Uint8Array(500_000)) }`));
      const res = await r.invoke({ ...v, page: 's-4' });
      assert.equal(res.status, 200);
      await assert.rejects(res.arrayBuffer());
      await until(async () => /response larger than 100000 bytes; cut/.test(await logText(r, 's-4')));
    }));

  test('the caller going away aborts request.signal', () =>
    withRunner({}, async (r) => {
      const v = r.publish(
        backend(`export default {
          fetch(request) {
            request.signal.addEventListener('abort', () => console.log('aborted: ' + request.signal.reason.name));
            return new Response(new ReadableStream({
              start(c) { c.enqueue(new TextEncoder().encode('tick')); },
              cancel() { console.log('body cancelled'); },
            }));
          },
        }`),
      );
      const ac = new AbortController();
      const res = await r.invoke({ ...v, page: 's-5', signal: ac.signal });
      const reader = res.body.getReader();
      await reader.read();
      ac.abort();
      await until(async () => {
        const t = await logText(r, 's-5');
        return /aborted: AbortError/.test(t) && /body cancelled/.test(t);
      });
    }));
});

describe('limits and failures', () => {
  test('no response in time answers 504 backend-timeout', () =>
    withRunner({ firstByteMs: 300 }, async (r) => {
      const v = r.publish(
        backend(`export default {
          fetch(request) {
            request.signal.addEventListener('abort', () => console.log('handler told to stop'));
            return new Promise(() => {});
          },
        }`),
      );
      const res = await r.invoke({ ...v, page: 't-1', path: '/slow' });
      assert.equal(res.status, 504);
      assert.equal(res.headers.get('x-specola-error'), 'backend-timeout');
      const { ref } = await res.json();
      const { body } = await r.logs('t-1');
      assert.match(body.lines.find((l) => l.ref === ref).text, /GET \/slow: no response within 300 ms; answered 504/);
      await until(async () => /handler told to stop/.test(await logText(r, 't-1')));
    }));

  test('a response still streaming at the total limit is cut', () =>
    withRunner({ requestMs: 500 }, async (r) => {
      const v = r.publish(
        backend(`export default {
          fetch() {
            return new Response(new ReadableStream({
              async pull(c) { await new Promise((r) => setTimeout(r, 50)); c.enqueue(new TextEncoder().encode('.')); },
            }));
          },
        }`),
      );
      const res = await r.invoke({ ...v, page: 't-2' });
      assert.equal(res.status, 200);
      await assert.rejects(res.text());
      assert.match(await logText(r, 't-2'), /not finished within 500 ms; response cut/);
    }));

  test('a worker stuck in a loop is killed and replaced', () =>
    withRunner({ firstByteMs: 300 }, async (r) => {
      const v = r.publish(
        backend(`export default {
          fetch(request) {
            if (new URL(request.url).pathname === '/spin') for (;;);
            return new Response('fine');
          },
        }`),
      );
      const res = await r.invoke({ ...v, page: 't-3', path: '/spin' });
      assert.equal(res.status, 504);
      await until(async () => /worker crashed: it stopped responding/.test(await logText(r, 't-3')));
      assert.equal(await (await r.invoke({ ...v, page: 't-3' })).text(), 'fine');
    }));

  test('a crash answers 502 to requests in flight, and the next request gets a fresh worker', () =>
    withRunner({}, async (r) => {
      const v = r.publish(
        backend(`const started = Date.now();
          export default {
            async fetch(request) {
              const p = new URL(request.url).pathname;
              if (p === '/crash') setTimeout(() => process.exit(7), 100);
              if (p === '/wait' || p === '/crash') await new Promise(() => {});
              return new Response(String(started));
            },
          }`),
      );
      const t0 = await (await r.invoke({ ...v, page: 'x-1' })).text();
      const [a, b] = await Promise.all([r.invoke({ ...v, page: 'x-1', path: '/wait' }), r.invoke({ ...v, page: 'x-1', path: '/crash' })]);
      for (const res of [a, b]) {
        assert.equal(res.status, 502);
        assert.equal(res.headers.get('x-specola-error'), 'backend-crashed');
      }
      const { ref } = await a.json();
      const { body } = await r.logs('x-1');
      assert.match(body.lines.find((l) => l.ref === ref).text, /worker crashed: exit code 7; 2 request\(s\) in flight answered 502/);
      const t1 = await (await r.invoke({ ...v, page: 'x-1' })).text();
      assert.notEqual(t0, t1, 'a new worker');
    }));

  test('running out of memory kills the worker with 502', () =>
    withRunner({ workerMemoryMb: 32 }, async (r) => {
      const v = r.publish(
        backend(`export default {
          fetch() { const keep = []; for (;;) keep.push(new Array(100000).fill({ x: Math.random() })); },
        }`),
      );
      const res = await r.invoke({ ...v, page: 'x-2' });
      assert.equal(res.status, 502);
      assert.equal(res.headers.get('x-specola-error'), 'backend-crashed');
      assert.match(await logText(r, 'x-2'), /worker crashed: it ran out of memory \(32 MiB\)/);
    }));

  test('an idle worker stops', () =>
    withRunner({ idleMs: 200 }, async (r) => {
      const v = r.publish(backend(`export default { fetch: () => new Response('hi') }`));
      assert.equal(await (await r.invoke({ ...v, page: 'i-1' })).text(), 'hi');
      await until(async () => /worker for version 1 stopped \(idle\)/.test(await logText(r, 'i-1')));
      assert.equal(await (await r.invoke({ ...v, page: 'i-1' })).text(), 'hi');
      const starts = (await logText(r, 'i-1')).match(/worker started/g);
      assert.equal(starts.length, 2);
    }));

  test('waitUntil keeps the worker busy', () =>
    withRunner({ idleMs: 200 }, async (r) => {
      const v = r.publish(
        backend(`export default {
          fetch(req, ctx) { ctx.waitUntil(new Promise((r) => setTimeout(r, 600)).then(() => console.log('background done'))); return new Response('hi'); },
        }`),
      );
      assert.equal(await (await r.invoke({ ...v, page: 'i-2' })).text(), 'hi');
      await until(async () => /stopped \(idle\)/.test(await logText(r, 'i-2')), { timeout: 3000 });
      const t = await logText(r, 'i-2');
      assert.ok(t.indexOf('background done') < t.indexOf('stopped (idle)'), t);
    }));

  test('files.put enforces the page disk quota', () =>
    withRunner({ pageDiskBytes: 200_000 }, async (r) => {
      const v = r.publish(
        backend(`export default {
          async fetch(request, ctx) {
            const n = Number(new URL(request.url).searchParams.get('n'));
            try {
              await ctx.files.put('f/' + n, new Uint8Array(n).fill(n % 251));
              return new Response('stored');
            } catch (e) {
              return new Response(e.name + ': ' + e.message, { status: 507 });
            }
          },
        }`),
      );
      assert.equal(await (await r.invoke({ ...v, page: 'q-1', path: '/?n=100000' })).text(), 'stored');
      const res = await r.invoke({ ...v, page: 'q-1', path: '/?n=150000' });
      assert.equal(res.status, 507);
      assert.match(await res.text(), /QuotaExceededError: page disk quota exceeded: .* more than 195\.31 KiB/);
      const tmp = await fs.readdir(path.join(r.dataDir, 'pages', 'q-1', 'files', 'tmp'));
      assert.deepEqual(tmp, [], 'the partial write is removed');
    }));
});

describe('disk quota', () => {
  test('database writes stop at the page disk quota', () =>
    withRunner({ pageDiskBytes: 2_000_000 }, async (r) => {
      const v = r.publish(
        backend(`import { DatabaseSync } from 'node:sqlite';
          const fill = (db) => {
            try {
              db.exec('CREATE TABLE IF NOT EXISTS t (b)');
              // Row by row: each one that fits stays.
              for (let i = 0; i < 100; i++) db.exec('INSERT INTO t VALUES (randomblob(100000))');
              return 'stored';
            } catch (e) {
              return e.message;
            }
          };
          export default {
            async fetch(request, ctx) {
              const which = new URL(request.url).pathname;
              const db = which === '/shared' ? ctx.db : which === '/user' ? ctx.userDb : new DatabaseSync('own.sqlite');
              return new Response(fill(db));
            },
          };`),
      );
      for (const p of ['/shared', '/user', '/own']) {
        assert.equal(await (await r.invoke({ ...v, page: 'q-db', path: p })).text(), 'database or disk is full', p);
      }
      const dir = path.join(r.dataDir, 'pages', 'q-db');
      let total = 0;
      for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
        if (e.isFile()) total += (await fs.stat(path.join(e.parentPath, e.name))).size;
      }
      // Thirty megabytes were asked for; a little over the quota at most.
      assert.ok(total < 2_600_000, `page uses ${total} bytes`);
      await until(async () => /of its 1\.91 MiB disk quota: writes to its databases and files fail past it/.test(await logText(r, 'q-db')));
    }));

  test('concurrent files.put cannot go over the quota together', () =>
    withRunner({ pageDiskBytes: 1_000_000 }, async (r) => {
      const v = r.publish(
        backend(`export default {
          async fetch(request, ctx) {
            const slow = new ReadableStream({
              async pull(c) {
                await new Promise((r) => setTimeout(r, 20));
                if ((this.n = (this.n ?? 0) + 1) > 12) c.close();
                else c.enqueue(new Uint8Array(50_000).fill(this.n));
              },
            });
            try {
              await ctx.files.put(new URL(request.url).pathname.slice(1), slow);
              return new Response('stored');
            } catch (e) {
              return new Response(e.name, { status: 507 });
            }
          },
        }`),
      );
      const res = await Promise.all(['a', 'b', 'c'].map((k) => r.invoke({ ...v, page: 'q-race', path: '/' + k }).then((x) => x.text())));
      assert.ok(res.filter((t) => t === 'stored').length <= 1, res.join());
      const blobs = path.join(r.dataDir, 'pages', 'q-race', 'files', 'blobs');
      let total = 0;
      for (const n of await fs.readdir(blobs)) total += (await fs.stat(path.join(blobs, n))).size;
      assert.ok(total <= 1_000_000, `blobs use ${total} bytes`);
    }));
});

describe('start and callers', () => {
  test('an entry that never finishes loading fails its calls instead of hanging them', () =>
    withRunner({ firstByteMs: 800 }, async (r) => {
      const v = r.publish(backend(`await new Promise(() => {}); export default { fetch: () => new Response('ok') };`));
      const t0 = Date.now();
      const res = await r.invoke({ ...v, page: 's-load' });
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('x-specola-error'), 'backend-error');
      const { ref } = await res.json();
      assert.ok(Date.now() - t0 < 2000);
      const { body } = await r.logs('s-load');
      assert.match(body.lines.find((l) => l.ref === ref).text, /did not finish loading within 800 ms/);
      await until(async () => /stopped \(it did not finish loading\)/.test(await logText(r, 's-load')));
      // The next call gets a fresh worker (which fails the same way).
      assert.equal((await r.invoke({ ...v, page: 's-load' })).status, 500);
      assert.equal((await logText(r, 's-load')).match(/worker started/g).length, 2);
    }));

  test('a call whose caller left while it waited is never run', () =>
    withRunner({}, async (r) => {
      const v = r.publish(
        backend(`export default {
          async fetch(request) {
            console.log('ran ' + request.method);
            return new Response('ok');
          },
        }`),
      );
      r.specola.delayMs = 400; // the code download is slow
      for (const method of ['GET', 'POST']) {
        const ac = new AbortController();
        const call = r.invoke({ ...v, page: 's-gone', method, body: method === 'POST' ? 'x' : undefined, signal: ac.signal });
        setTimeout(() => ac.abort(), 100);
        await assert.rejects(call);
      }
      await new Promise((res) => setTimeout(res, 700));
      assert.doesNotMatch(await logText(r, 's-gone'), /ran /);
      r.specola.delayMs = 0;
      assert.equal(await (await r.invoke({ ...v, page: 's-gone' })).text(), 'ok');
    }));
});

describe('permissions', () => {
  test('a worker reads and writes only its own directories', () =>
    withRunner({}, async (r) => {
      // Another page's data, and a file of the runner's.
      const other = path.join(r.dataDir, 'pages', 'other');
      await fs.mkdir(other, { recursive: true });
      await fs.writeFile(path.join(other, 'secret.txt'), 'other page');
      const v = r.publish(
        backend(`import fs from 'node:fs';
          import { DatabaseSync } from 'node:sqlite';
          const attempt = (fn) => { try { fn(); return 'allowed'; } catch (e) { return e.code || e.message; } };
          export default {
            async fetch(request) {
              const { other, state, code } = await request.json();
              let spawn;
              try { const cp = await import('node:child_process'); cp.execFileSync('true'); spawn = 'allowed'; } catch (e) { spawn = e.code; }
              let worker;
              try { const wt = await import('node:worker_threads'); new wt.Worker('1', { eval: true }); worker = 'allowed'; } catch (e) { worker = e.code; }
              return Response.json({
                passwd: attempt(() => fs.readFileSync('/etc/passwd')),
                otherPage: attempt(() => fs.readFileSync(other)),
                runnerState: attempt(() => fs.readdirSync(state)),
                writeCode: attempt(() => fs.writeFileSync(code + '/x', 'x')),
                ownWrite: attempt(() => fs.writeFileSync('mine.txt', 'x')),
                ownCode: attempt(() => fs.readFileSync(code + '/backend.json')),
                sqliteOutside: attempt(() => new DatabaseSync('/tmp/specola-escape.sqlite')),
                sqliteInside: attempt(() => new DatabaseSync('mine.sqlite').close()),
                sqliteBuiltin: attempt(() => new (process.getBuiltinModule('node:sqlite').DatabaseSync)(other + '.sqlite')),
                spawn, worker,
              });
            },
          };`),
      );
      const res = await r.invoke({
        ...v,
        page: 'perm-1',
        method: 'POST',
        body: JSON.stringify({
          other: path.join(other, 'secret.txt'),
          state: path.join(r.dataDir, 'state'),
          code: path.join(r.dataDir, 'code', v.codeHash),
        }),
      });
      assert.deepEqual(await res.json(), {
        passwd: 'ERR_ACCESS_DENIED',
        otherPage: 'ERR_ACCESS_DENIED',
        runnerState: 'ERR_ACCESS_DENIED',
        writeCode: 'ERR_ACCESS_DENIED',
        ownWrite: 'allowed',
        ownCode: 'allowed',
        sqliteOutside: 'ERR_ACCESS_DENIED',
        sqliteInside: 'allowed',
        sqliteBuiltin: 'ERR_ACCESS_DENIED',
        spawn: 'ERR_ACCESS_DENIED',
        worker: 'ERR_ACCESS_DENIED',
      });
      await assert.rejects(fs.access('/tmp/specola-escape.sqlite'));
      await fs.access(path.join(r.dataDir, 'pages', 'perm-1', 'mine.txt'));
    }));
});

describe('versions', () => {
  test('a newer version snapshots the data, then runs; older versions are superseded', () =>
    withRunner({}, async (r) => {
      const src = (tag) => `export default {
        async fetch(request, ctx) {
          ctx.db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
          ctx.db.prepare('INSERT INTO t VALUES (?)').run('${tag}');
          ctx.userDb.exec('CREATE TABLE IF NOT EXISTS u (v TEXT)');
          ctx.userDb.prepare('INSERT INTO u VALUES (?)').run('${tag}');
          await ctx.files.put('note.txt', '${tag}');
          const slow = new URL(request.url).pathname === '/slow';
          if (slow) await new Promise((r) => setTimeout(r, 400));
          return new Response('${tag}');
        },
      }`;
      const v1 = r.publish(backend(src('one')));
      const v2 = r.publish(backend(src('two')));
      assert.equal(await (await r.invoke({ ...v1, page: 'v-1', version: 1 })).text(), 'one');
      // A slow request on version 1 is still running when version 2 arrives:
      // it finishes on the old worker.
      const slow = r.invoke({ ...v1, page: 'v-1', version: 1, path: '/slow' });
      await new Promise((res) => setTimeout(res, 100));
      assert.equal(await (await r.invoke({ ...v2, page: 'v-1', version: 2 })).text(), 'two');
      assert.equal(await (await slow).text(), 'one');

      const stale = await r.invoke({ ...v1, page: 'v-1', version: 1 });
      assert.equal(stale.status, 409);
      assert.equal(stale.headers.get('x-specola-error'), 'superseded');
      assert.equal((await stale.json()).error, 'superseded');

      const pageDir = path.join(r.dataDir, 'pages', 'v-1');
      const snaps = (await fs.readdir(path.join(r.dataDir, 'snapshots', 'v-1'))).filter((n) => n.includes('-version-'));
      assert.equal(snaps.length, 1);
      assert.match(snaps[0], /^\d{8}T\d{6}Z-version-v1$/);
      const snap = path.join(r.dataDir, 'snapshots', 'v-1', snaps[0]);
      const rows = (file, table) => {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          return db.prepare(`SELECT v FROM ${table}`).all().map((x) => x.v);
        } finally {
          db.close();
        }
      };
      // The snapshot has version 1's data only (the slow request wrote before
      // its sleep, so before the switch).
      assert.deepEqual(rows(path.join(snap, 'shared.sqlite'), 't'), ['one', 'one']);
      const userFile = (await fs.readdir(path.join(snap, 'users')))[0];
      assert.deepEqual(rows(path.join(snap, 'users', userFile), 'u'), ['one', 'one']);
      const idx = new DatabaseSync(path.join(snap, 'files.sqlite'), { readOnly: true });
      assert.deepEqual(idx.prepare('SELECT key FROM files').all().map((x) => x.key), ['note.txt']);
      idx.close();
      const live = rows(path.join(pageDir, 'shared.sqlite'), 't');
      assert.deepEqual(live, ['one', 'one', 'two']);

      // Both blobs survive: "one" is named by the snapshot, "two" by the index.
      assert.equal((await fs.readdir(path.join(pageDir, 'files', 'blobs'))).length, 2);

      const log = await logText(r, 'v-1');
      assert.match(log, /version switch: 1 → 2/);
      assert.match(log, /snapshot of version 1's data: /);
      assert.match(log, /worker for version 1 draining/);
      await until(async () => /worker for version 1 stopped \(drained\)/.test(await logText(r, 'v-1')));
    }));

  test('the current version survives a runner restart', async () => {
    const r = await startRunner();
    try {
      const v1 = r.publish(backend(`export default { fetch: () => new Response('one') }`));
      const v2 = r.publish(backend(`export default { fetch: () => new Response('two') }`));
      assert.equal((await r.invoke({ ...v2, page: 'v-2', version: 2 })).status, 200);
      // A new runner process on the same data.
      const { createRunner } = await import('../src/server.js');
      const again = createRunner(r.config, {});
      const addr = await again.listen(0, '127.0.0.1');
      try {
        const { invoke } = await import('./helpers.js');
        const res = await invoke(`http://127.0.0.1:${addr.port}`, { ...v1, page: 'v-2', version: 1 });
        assert.equal(res.status, 409);
      } finally {
        await again.close();
      }
    } finally {
      await r.close();
    }
  });

  test('only the last 5 version snapshots are kept', () =>
    withRunner({}, async (r) => {
      const code = r.publish(
        backend(`export default {
          async fetch(request, ctx) {
            ctx.db.exec('CREATE TABLE IF NOT EXISTS t (v)');
            ctx.db.prepare('INSERT INTO t VALUES (?)').run(ctx.page.version);
            await ctx.files.put('v', String(ctx.page.version));
            return new Response(String(ctx.page.version));
          },
        }`),
      );
      for (let v = 1; v <= 8; v++) {
        assert.equal(await (await r.invoke({ ...code, page: 'v-3', version: v })).text(), String(v));
      }
      const snaps = (await fs.readdir(path.join(r.dataDir, 'snapshots', 'v-3'))).filter((n) => n.includes('-version-')).sort();
      assert.deepEqual(snaps.map((s) => s.replace(/^.*-/, '')), ['v3', 'v4', 'v5', 'v6', 'v7']);
    }));
});

describe('snapshots', () => {
  test('are out of the page code\'s reach, and a newer version cannot destroy them', () =>
    withRunner({}, async (r) => {
      const src = (tag) => `import fs from 'node:fs';
        import { DatabaseSync } from 'node:sqlite';
        export default {
          async fetch(request, ctx) {
            ctx.db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
            ctx.db.prepare('INSERT INTO t VALUES (?)').run('${tag}');
            const dir = await request.text();
            const attempt = (fn) => { try { fn(); return 'allowed'; } catch (e) { return e.code || e.message; } };
            return Response.json({
              list: attempt(() => fs.readdirSync(dir)),
              remove: attempt(() => fs.rmSync(dir, { recursive: true, force: true })),
              write: attempt(() => fs.writeFileSync(dir + '/x', 'x')),
              sqlite: attempt(() => new DatabaseSync(dir + '/x.sqlite')),
            });
          },
        }`;
      const v1 = r.publish(backend(src('one')));
      const v2 = r.publish(backend(src('two')));
      const dir = path.join(r.dataDir, 'snapshots', 'snap-1');
      await r.invoke({ ...v1, page: 'snap-1', version: 1, method: 'POST', body: dir });
      const res = await r.invoke({ ...v2, page: 'snap-1', version: 2, method: 'POST', body: dir });
      assert.deepEqual(await res.json(), { list: 'allowed', remove: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', sqlite: 'ERR_ACCESS_DENIED' });
      const snaps = (await fs.readdir(dir)).filter((n) => n.includes('-version-'));
      assert.equal(snaps.length, 1);
      const db = new DatabaseSync(path.join(dir, snaps[0], 'shared.sqlite'), { readOnly: true });
      assert.deepEqual(db.prepare('SELECT v FROM t').all().map((x) => x.v), ['one']);
      db.close();
    }));

  test('a database the code broke is left out instead of blocking the switch', () =>
    withRunner({}, async (r) => {
      const src = (tag) => `import fs from 'node:fs';
        export default {
          async fetch(request, ctx) {
            ctx.db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
            ctx.db.prepare('INSERT INTO t VALUES (?)').run('${tag}');
            fs.mkdirSync('users', { recursive: true });
            fs.writeFileSync('users/' + 'a'.repeat(64) + '.sqlite', 'not a database, just some text that is long enough to be read as a header ....................');
            fs.writeFileSync('users/notes.sqlite', 'a file of the code');
            return new Response('${tag}');
          },
        }`;
      const v1 = r.publish(backend(src('one')));
      const v2 = r.publish(backend(src('two')));
      assert.equal(await (await r.invoke({ ...v1, page: 'snap-2', version: 1 })).text(), 'one');
      assert.equal(await (await r.invoke({ ...v2, page: 'snap-2', version: 2 })).text(), 'two');
      const log = await logText(r, 'snap-2');
      assert.match(log, /\[warn\] snapshot of version 1's data: left out users\/a{64}\.sqlite \(file is not a database\)/);
      const dir = path.join(r.dataDir, 'snapshots', 'snap-2');
      const [snap] = (await fs.readdir(dir)).filter((n) => n.includes('-version-'));
      assert.deepEqual((await fs.readdir(path.join(dir, snap), { recursive: true })).sort(), ['data', 'meta.json', 'shared.sqlite', 'users']);
    }));

  test('a failed snapshot leaves nothing behind, and half-written ones are swept', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'specola-snap-test-'));
    try {
      const pageDir = path.join(root, 'pages', 'p');
      const snapshotsDir = path.join(root, 'snapshots', 'p');
      await fs.mkdir(path.join(pageDir, 'users', 'b'.repeat(64) + '.sqlite'), { recursive: true }); // can't be opened
      new DatabaseSync(path.join(pageDir, 'shared.sqlite')).exec('CREATE TABLE t (v)');
      for (let i = 0; i < 3; i++) {
        await assert.rejects(takeSnapshot({ pageDir, snapshotsDir, kind: 'version', version: 1, limits: DEFAULT_LIMITS }));
      }
      assert.deepEqual(await fs.readdir(snapshotsDir), []);

      await fs.mkdir(path.join(snapshotsDir, '.tmp-20261125T000000Z-version-v1', 'users'), { recursive: true });
      await fs.mkdir(path.join(snapshotsDir, '20261125T000000Z-version-v1'));
      await sweepSnapshots(root);
      assert.deepEqual(await fs.readdir(snapshotsDir), ['20261125T000000Z-version-v1']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('past their byte budget, the oldest go first', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'specola-snap-test-'));
    try {
      const pageDir = path.join(root, 'pages', 'p');
      const snapshotsDir = path.join(root, 'snapshots', 'p');
      await fs.mkdir(pageDir, { recursive: true });
      const db = new DatabaseSync(path.join(pageDir, 'shared.sqlite'));
      db.exec("CREATE TABLE t (b); INSERT INTO t VALUES (randomblob(100000))");
      db.close();
      for (let v = 1; v <= 4; v++) {
        await takeSnapshot({ pageDir, snapshotsDir, kind: 'version', version: v, now: Date.UTC(2026, 10, 25, 0, v), limits: { ...DEFAULT_LIMITS, snapshotDiskBytes: 250_000 } });
      }
      assert.deepEqual((await fs.readdir(snapshotsDir)).map((n) => n.replace(/^.*-/, '')).sort(), ['v3', 'v4']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('the file store keeps blobs while a snapshot is being written', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'specola-snap-test-'));
    try {
      const pageDir = path.join(root, 'pages', 'p');
      const snapshotsDir = path.join(root, 'snapshots', 'p');
      const tmp = path.join(snapshotsDir, '.tmp-20261125T000000Z-version-v1');
      await fs.mkdir(tmp, { recursive: true });
      await fs.writeFile(path.join(tmp, 'files.sqlite'), ''); // half written
      const store = new FileStore(pageDir, 1e9, snapshotsDir);
      await store.put('a.png', 'aaa');
      assert.equal(await store.delete('a.png'), true);
      const blobs = path.join(pageDir, 'files', 'blobs');
      assert.equal((await fs.readdir(blobs)).length, 1, 'left for the runner\'s collection');
      await fs.rm(tmp, { recursive: true });
      await store.put('b.png', 'bbb');
      await store.delete('b.png');
      assert.equal((await fs.readdir(blobs)).length, 1, 'b is collected at once');
      store.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
