// The child process of a backend_query (docs/page-backends.md, "MCP (step
// 7)"; see ../query.js). It runs under --permission with read access to the
// page's shared database only, gets one job over IPC, answers once and
// exits: whatever the SQL does, it does it in a process that lives for one
// statement and can be killed without touching the runner.
// This file runs under the permission model: it must only import node:
// modules.

import { DatabaseSync } from 'node:sqlite';

// An estimate of a value's size in the JSON answer, so the 1 MiB cap is
// checked without serialising twice.
function jsonSize(v) {
  if (v === null || v === undefined) return 4;
  if (typeof v === 'bigint') return String(v).length;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v).length : 4;
  if (typeof v === 'string') return JSON.stringify(v).length;
  if (v instanceof Uint8Array) return Math.ceil(v.length / 3) * 4 + 14; // {"base64":"…"}
  return JSON.stringify(v).length;
}

function run({ dbPath, sql, params, maxRows, maxBytes }) {
  // readOnly opens it with SQLITE_OPEN_READONLY (the worker's writes are
  // seen through the WAL); query_only refuses writes once more at the
  // statement level.
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
  try {
    db.exec('PRAGMA query_only = 1');
    const stmt = db.prepare(sql);
    // Integers come as BigInt so none is rounded; query.js turns them back
    // into JSON numbers with every digit.
    stmt.setReadBigInts(true);
    const arrays = typeof stmt.setReturnArrays === 'function';
    if (arrays) stmt.setReturnArrays(true);
    let columns = typeof stmt.columns === 'function' ? stmt.columns().map((c) => c.name) : null;
    const args = Array.isArray(params) ? params : [params];
    const rows = [];
    let bytes = 0;
    let truncated = false;
    for (let row of stmt.iterate(...args)) {
      if (!arrays) {
        // Node before 22.16: objects, so a repeated column name keeps one value.
        columns ??= Object.keys(row);
        row = columns.map((c) => row[c]);
      }
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      let size = 2 + row.length;
      for (const v of row) size += jsonSize(v);
      if (bytes + size > maxBytes) {
        truncated = true;
        break;
      }
      bytes += size;
      rows.push(row);
    }
    return { columns: columns ?? [], rows, truncated };
  } finally {
    db.close();
  }
}

process.once('message', (job) => {
  let answer;
  try {
    answer = { ok: run(job) };
  } catch (err) {
    answer = { error: err.message, sqlite: err.code === 'ERR_SQLITE_ERROR' || err.errcode !== undefined };
  }
  process.send(answer, () => process.exit(0));
});
