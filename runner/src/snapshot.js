// Data snapshots (docs/page-backends.md, "Data lifecycle" and "Version
// switch"). A snapshot is every database of the page copied with VACUUM INTO
// (consistent while the worker keeps writing) plus the file store's index;
// the blobs the index names stay where they are and are kept as long as a
// snapshot names them.
//
// VACUUM INTO is synchronous and can take seconds on a large database, so it
// runs on a worker thread: the runner keeps serving other pages meanwhile.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const VERSION_SNAPSHOT = /^\d{8}T\d{6}\.\d{3}Z-v\d+$/;
const BLOB_GRACE_MS = 60 * 60 * 1000;
// SQLite's "not a database" and "malformed": a file the page's code broke.
const SQLITE_BROKEN = new Set([11, 26]);
// The databases the runner itself creates in a page's directory. Anything
// else there is the page code's own business and is not snapshotted.
const USER_DB = /^[0-9a-f]{64}\.sqlite$/;

/** "20261125T101500.123Z": sortable, and no ":" in a file name. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '');
}

/**
 * Snapshots the page's data (pageDir) into snapshotsDir, labelled with the
 * version that is leaving, then keeps the last `keep` version snapshots
 * within maxBytes. snapshotsDir is outside the page's directory, where the
 * page's code can't reach it: a snapshot must survive the code it protects
 * from. Resolves to {dir, skipped}: the snapshot's directory (null when the
 * page has no data yet) and the databases left out because they are broken.
 */
export function takeVersionSnapshot({ pageDir, snapshotsDir, oldVersion, keep, maxBytes }) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { pageDir, snapshotsDir, oldVersion, keep, maxBytes } });
    w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(m.result)));
    w.once('error', reject);
    w.once('exit', (code) => code && reject(new Error(`snapshot thread exited with ${code}`)));
  });
}

/**
 * Removes snapshots a previous runner process left half written (it died
 * while taking them): under {dataDir}/snapshots/{pageId}/.tmp-*.
 */
export async function sweepSnapshots(dataDir) {
  const root = path.join(dataDir, 'snapshots');
  let pages = [];
  try {
    pages = await fs.readdir(root);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const p of pages) {
    let names = [];
    try {
      names = await fs.readdir(path.join(root, p));
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.startsWith('.tmp-')) await fs.rm(path.join(root, p, n), { recursive: true, force: true });
    }
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** The page's databases, relative to its directory. */
async function databases(pageDir) {
  const dbs = [];
  for (const name of ['shared.sqlite', 'files.sqlite']) {
    if (await exists(path.join(pageDir, name))) dbs.push(name);
  }
  try {
    for (const name of (await fs.readdir(path.join(pageDir, 'users'))).sort()) {
      if (USER_DB.test(name)) dbs.push(path.join('users', name));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return dbs;
}

function vacuumInto(src, dest) {
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(dest);
  } finally {
    db.close();
  }
}

async function snapshot({ pageDir, snapshotsDir, oldVersion, keep, maxBytes }) {
  const dbs = await databases(pageDir);
  if (dbs.length === 0) return { dir: null, skipped: [] };
  let name = `${stamp()}-v${oldVersion}`;
  while (await exists(path.join(snapshotsDir, name))) name = `${stamp()}-v${oldVersion}`;
  const tmp = path.join(snapshotsDir, `.tmp-${name}`);
  const skipped = [];
  try {
    await fs.mkdir(path.join(tmp, 'users'), { recursive: true });
    for (const rel of dbs) {
      try {
        vacuumInto(path.join(pageDir, rel), path.join(tmp, rel));
      } catch (err) {
        // A database the page's code broke can't be copied, now or ever:
        // refusing the switch for it would keep the page's backend down
        // for good. Anything else (a full disk) fails the switch.
        if (!SQLITE_BROKEN.has(err.errcode)) throw err;
        skipped.push(`${rel} (${err.message})`);
        await fs.rm(path.join(tmp, rel), { force: true });
      }
    }
    await fs.rename(tmp, path.join(snapshotsDir, name));
  } catch (err) {
    // A failed attempt leaves nothing: it is retried on the next request,
    // and partial copies would pile up.
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
  await prune(snapshotsDir, keep, maxBytes);
  await collectBlobs(pageDir, snapshotsDir);
  return { dir: path.join(snapshotsDir, name), skipped };
}

async function dirBytes(dir) {
  let total = 0;
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) total += (await fs.lstat(path.join(e.parentPath ?? e.path, e.name))).size;
  }
  return total;
}

// Keeps the newest `keep` version snapshots, and of those only as many as
// fit in maxBytes, oldest going first (the newest is always kept).
async function prune(snapshotsDir, keep, maxBytes) {
  const names = (await fs.readdir(snapshotsDir)).filter((n) => VERSION_SNAPSHOT.test(n)).sort().reverse();
  let total = 0;
  for (const [i, n] of names.entries()) {
    const dir = path.join(snapshotsDir, n);
    total += await dirBytes(dir);
    if (i > 0 && (i >= keep || total > maxBytes)) await fs.rm(dir, { recursive: true, force: true });
  }
}

// Deletes the blobs that neither the live index nor a snapshot's names.
async function collectBlobs(pageDir, snapshotsDir) {
  const blobs = path.join(pageDir, 'files', 'blobs');
  let names;
  try {
    names = await fs.readdir(blobs);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const named = new Set();
  const indexes = [path.join(pageDir, 'files.sqlite')];
  for (const n of await fs.readdir(snapshotsDir)) {
    // A snapshot being written may name blobs its index does not show yet.
    if (n.startsWith('.tmp-')) return;
    indexes.push(path.join(snapshotsDir, n, 'files.sqlite'));
  }
  for (const file of indexes) {
    if (!(await exists(file))) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const r of db.prepare('SELECT sha256 FROM files').all()) named.add(r.sha256);
    } finally {
      db.close();
    }
  }
  // A blob written moments ago may belong to a put that has not reached the
  // index yet: leave young blobs for the next collection.
  const cutoff = Date.now() - BLOB_GRACE_MS;
  for (const n of names) {
    if (named.has(n)) continue;
    const file = path.join(blobs, n);
    const st = await fs.stat(file).catch(() => null);
    if (st && st.mtimeMs < cutoff) await fs.rm(file, { force: true });
  }
}

if (!isMainThread && workerData?.pageDir) {
  snapshot(workerData).then(
    (result) => parentPort.postMessage({ result }),
    (err) => parentPort.postMessage({ error: err.stack || String(err) }),
  );
}
