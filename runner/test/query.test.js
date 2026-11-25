// backend_query's runner side (docs/page-backends.md, "MCP (step 7)"): one
// read-only statement on shared.sqlite in a short-lived child under the
// permission model, with the row, byte and time limits.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { childExecArgv, normalizeParams, runQuery, statementProblem } from '../src/query.js';

describe('statementProblem', () => {
  const allowed = [
    'SELECT 1',
    '  select * from t;',
    'SELECT 1;;  -- trailing comment',
    '/* lead */ SELECT 1 /* tail */',
    "SELECT 'a;b', \"c;d\", [e;f], `g;h` FROM t",
    "SELECT 'it''s; fine'",
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'VALUES (1), (2)',
    'EXPLAIN QUERY PLAN SELECT * FROM t',
    'explain select 1',
    'PRAGMA table_info(t)',
    "PRAGMA main.table_info('t')",
    'PRAGMA user_version',
    'PRAGMA integrity_check(-1)',
  ];
  for (const sql of allowed) test(`allows ${sql}`, () => assert.equal(statementProblem(sql), null));

  const refused = {
    '': /empty/,
    ' ; ': /empty/,
    '-- only a comment': /empty/,
    'SELECT 1; SELECT 2': /more than one statement/,
    'SELECT 1; DROP TABLE t': /more than one statement/,
    "SELECT ';'; DELETE FROM t": /more than one statement/,
    'INSERT INTO t VALUES (1)': /INSERT is not allowed/,
    'update t set v = 1': /UPDATE is not allowed/,
    'DELETE FROM t': /DELETE is not allowed/,
    'DROP TABLE t': /DROP is not allowed/,
    "ATTACH 'other.sqlite' AS o": /ATTACH is not allowed/,
    "VACUUM INTO '/tmp/x'": /VACUUM is not allowed/,
    'BEGIN': /BEGIN is not allowed/,
    'PRAGMA query_only = 0': /PRAGMA query_only/,
    'PRAGMA query_only(0)': /PRAGMA query_only/,
    'PRAGMA user_version = 3': /PRAGMA user_version/,
    "PRAGMA temp_store_directory = '/tmp'": /PRAGMA temp_store_directory/,
    'PRAGMA writable_schema': /PRAGMA writable_schema/,
    '(SELECT 1)': /not allowed/,
    "EXPLAIN ATTACH 'x' AS y": /EXPLAIN ATTACH is not allowed/,
    'EXPLAIN QUERY PLAN DELETE FROM t': /EXPLAIN DELETE is not allowed/,
  };
  for (const [sql, want] of Object.entries(refused)) {
    test(`refuses ${JSON.stringify(sql)}`, () => assert.match(statementProblem(sql) ?? 'allowed', want));
  }
});

test('normalizeParams', () => {
  assert.deepEqual(normalizeParams(undefined), []);
  assert.deepEqual(normalizeParams([1, 'a', null, true, false]), [1, 'a', null, 1, 0]);
  assert.deepEqual(normalizeParams({ ':a': 1, b: 'x' }), { a: 1, b: 'x' });
  assert.deepEqual(normalizeParams([{ base64: 'AQI=' }]), [Buffer.from([1, 2])]);
  for (const bad of [[{}], [[1]], [Infinity], 'x', { 'a b': 1 }]) {
    assert.throws(() => normalizeParams(bad), { code: 'bad-request' }, JSON.stringify(bad));
  }
});

describe('runQuery', () => {
  let dir, pageDir, writer;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'specola-query-test-'));
    pageDir = path.join(dir, 'page');
    await fs.mkdir(pageDir);
    // The page's worker, as it would be: WAL, its connection kept open, no
    // checkpoint, so the rows live in the -wal file.
    writer = new DatabaseSync(path.join(pageDir, 'shared.sqlite'));
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INTEGER, b BLOB, f REAL);
      CREATE TABLE many (i INTEGER);
      CREATE TABLE big (s TEXT);
    `);
    writer.prepare('INSERT INTO t (v, n, b, f) VALUES (?, ?, ?, ?)').run('a', 1, new Uint8Array([0xff, 0]), 1.5);
    writer.prepare('INSERT INTO t (v, n, b, f) VALUES (?, ?, ?, ?)').run('b', 9007199254740993n, null, null);
    writer.exec('WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 1500) INSERT INTO many SELECT i FROM c');
    writer.exec("INSERT INTO big SELECT printf('%.*c', 400000, 'x') FROM many WHERE i <= 5");
    // A file next to the database the child must not be able to read.
    await fs.writeFile(path.join(pageDir, 'secret.txt'), 'top secret');
  });
  after(async () => {
    writer.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('columns, rows and exact values', async () => {
    const r = await runQuery({ pageDir, sql: 'SELECT id, v, n, b, f FROM t ORDER BY id' });
    assert.deepEqual(r.columns, ['id', 'v', 'n', 'b', 'f']);
    assert.equal(r.truncated, false);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[0], [1, 'a', 1, { base64: '/wA=' }, 1.5]);
    // A 64-bit integer keeps every digit in the JSON answer.
    assert.equal(JSON.stringify(r.rows[1]), '[2,"b",9007199254740993,null,null]');
  });

  test('positional and named params', async () => {
    let r = await runQuery({ pageDir, sql: 'SELECT v FROM t WHERE id = ? AND n = ?', params: [1, true] });
    assert.deepEqual(r.rows, [['a']]);
    r = await runQuery({ pageDir, sql: 'SELECT v FROM t WHERE id = :id OR v = $v ORDER BY id', params: { id: 1, $v: 'b' } });
    assert.deepEqual(r.rows, [['a'], ['b']]);
    r = await runQuery({ pageDir, sql: 'SELECT id FROM t WHERE b = ?', params: [{ base64: '/wA=' }] });
    assert.deepEqual(r.rows, [[1]]);
    // Duplicate column names keep both values.
    r = await runQuery({ pageDir, sql: 'SELECT 1 AS x, 2 AS x' });
    assert.deepEqual(r.columns, ['x', 'x']);
    assert.deepEqual(r.rows, [[1, 2]]);
  });

  test('sees the WAL, and a write transaction in progress does not block it', async () => {
    writer.exec("BEGIN; INSERT INTO t (v) VALUES ('uncommitted')");
    try {
      const r = await runQuery({ pageDir, sql: "SELECT count(*) FROM t WHERE v = 'uncommitted'" });
      assert.deepEqual(r.rows, [[0]]);
    } finally {
      writer.exec('ROLLBACK');
    }
  });

  test('at most 1000 rows', async () => {
    const r = await runQuery({ pageDir, sql: 'SELECT i FROM many ORDER BY i' });
    assert.equal(r.rows.length, 1000);
    assert.equal(r.truncated, true);
    assert.deepEqual(r.rows.at(-1), [1000]);
    const exact = await runQuery({ pageDir, sql: 'SELECT i FROM many WHERE i <= 1000' });
    assert.equal(exact.rows.length, 1000);
    assert.equal(exact.truncated, false);
  });

  test('at most 1 MiB', async () => {
    const r = await runQuery({ pageDir, sql: 'SELECT s FROM big' });
    // Each row is ~400 KB: two fit, the third would pass 1 MiB.
    assert.equal(r.rows.length, 2);
    assert.equal(r.truncated, true);
    assert.ok(JSON.stringify(r).length <= 1024 * 1024 + 100);
  });

  test('a statement that runs too long is killed: backend-timeout', async () => {
    const start = Date.now();
    await assert.rejects(
      runQuery({
        pageDir,
        sql: 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c) SELECT count(*) FROM c',
        timeoutMs: 500,
      }),
      { code: 'backend-timeout', status: 504 },
    );
    assert.ok(Date.now() - start < 3000);
  });

  test('more than one statement is refused', async () => {
    await assert.rejects(runQuery({ pageDir, sql: 'SELECT 1; DELETE FROM t' }), { code: 'bad-request', message: /more than one statement/ });
  });

  test('writes are refused, and nothing changes', async () => {
    const before = await runQuery({ pageDir, sql: 'SELECT count(*) FROM t' });
    for (const sql of ["INSERT INTO t (v) VALUES ('x')", 'DELETE FROM t', 'DROP TABLE t', "ATTACH 'x.sqlite' AS x", "VACUUM INTO 'copy.sqlite'", 'PRAGMA query_only = 0']) {
      await assert.rejects(runQuery({ pageDir, sql }), { code: 'bad-request' }, sql);
    }
    // A CTE in front of a write passes the first-word check; the read-only
    // connection refuses it.
    await assert.rejects(runQuery({ pageDir, sql: "WITH x AS (SELECT 1) INSERT INTO t (v) SELECT 'x' FROM x" }), {
      code: 'bad-request',
      message: /readonly|read-only|query_only/i,
    });
    assert.deepEqual(await runQuery({ pageDir, sql: 'SELECT count(*) FROM t' }), before);
    await assert.rejects(fs.access(path.join(pageDir, 'copy.sqlite')));
    await assert.rejects(fs.access(path.join(pageDir, 'x.sqlite')));
  });

  test("SQL errors are bad-request with SQLite's message", async () => {
    await assert.rejects(runQuery({ pageDir, sql: 'SELECT nope FROM t' }), { code: 'bad-request', status: 400, message: /no such column: nope/ });
    await assert.rejects(runQuery({ pageDir, sql: 'SELEC 1' }), { code: 'bad-request' });
    await assert.rejects(runQuery({ pageDir, sql: '' }), { code: 'bad-request' });
    await assert.rejects(runQuery({ pageDir, sql: 'SELECT 1', params: [{}] }), { code: 'bad-request' });
  });

  test('a page without a shared database', async () => {
    const empty = path.join(dir, 'empty');
    await fs.mkdir(empty);
    await assert.rejects(runQuery({ pageDir: empty, sql: 'SELECT 1' }), { code: 'bad-request', message: /no shared database/ });
  });

  test('the child can read the database and nothing else', async () => {
    const dbPath = path.join(pageDir, 'shared.sqlite');
    const probe = path.join(dir, 'probe.mjs');
    await fs.writeFile(
      probe,
      `import fs from 'node:fs';
      import cp from 'node:child_process';
      const out = {};
      const tryIt = (k, f) => { try { f(); out[k] = 'ok'; } catch (e) { out[k] = e.code; } };
      tryIt('db', () => fs.readFileSync(${JSON.stringify(dbPath)}));
      tryIt('secret', () => fs.readFileSync(${JSON.stringify(path.join(pageDir, 'secret.txt'))}));
      tryIt('passwd', () => fs.readFileSync('/etc/passwd'));
      tryIt('write', () => fs.writeFileSync(${JSON.stringify(path.join(pageDir, 'w.txt'))}, 'x'));
      tryIt('spawn', () => cp.execFileSync('true'));
      console.log(JSON.stringify(out));`,
    );
    const stdout = await new Promise((resolve, reject) =>
      execFile(process.execPath, [...childExecArgv(dbPath), `--allow-fs-read=${probe}`, probe], { env: {} }, (err, out) =>
        err ? reject(err) : resolve(out),
      ),
    );
    assert.deepEqual(JSON.parse(stdout), {
      db: 'ok',
      secret: 'ERR_ACCESS_DENIED',
      passwd: 'ERR_ACCESS_DENIED',
      write: 'ERR_ACCESS_DENIED',
      spawn: 'ERR_ACCESS_DENIED',
    });
  });

  test('at most 4 queries at once', async () => {
    const slow = 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c) SELECT count(*) FROM c';
    const running = Array.from({ length: 4 }, () => runQuery({ pageDir, sql: slow, timeoutMs: 1500 }).catch((e) => e.code));
    await assert.rejects(runQuery({ pageDir, sql: 'SELECT 1' }), { code: 'too-many-requests', status: 429 });
    assert.deepEqual(await Promise.all(running), Array(4).fill('backend-timeout'));
    // And free again.
    assert.deepEqual((await runQuery({ pageDir, sql: 'SELECT 1' })).rows, [[1]]);
  });
});
