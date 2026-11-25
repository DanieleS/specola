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

/** "20261125T101500.123Z": sortable, and no ":" in a file name. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '');
}

/**
 * Snapshots the page's data, labelled with the version that is leaving, and
 * keeps the last `keep` version snapshots. Returns the snapshot's directory,
 * or null when the page has no data yet.
 */
export function takeVersionSnapshot(pageDir, oldVersion, keep) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { pageDir, oldVersion, keep } });
    w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(m.dir)));
    w.once('error', reject);
    w.once('exit', (code) => code && reject(new Error(`snapshot thread exited with ${code}`)));
  });
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
      if (name.endsWith('.sqlite')) dbs.push(path.join('users', name));
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

async function snapshot({ pageDir, oldVersion, keep }) {
  const dbs = await databases(pageDir);
  if (dbs.length === 0) return null;
  const root = path.join(pageDir, 'snapshots');
  let name = `${stamp()}-v${oldVersion}`;
  while (await exists(path.join(root, name))) name = `${stamp()}-v${oldVersion}`;
  const tmp = path.join(root, `.tmp-${name}`);
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(path.join(tmp, 'users'), { recursive: true });
  for (const rel of dbs) vacuumInto(path.join(pageDir, rel), path.join(tmp, rel));
  const dir = path.join(root, name);
  await fs.rename(tmp, dir);
  await prune(pageDir, keep);
  return dir;
}

// Keeps the newest `keep` version snapshots, then deletes the blobs that no
// index names any more.
async function prune(pageDir, keep) {
  const root = path.join(pageDir, 'snapshots');
  const names = (await fs.readdir(root)).filter((n) => VERSION_SNAPSHOT.test(n)).sort();
  const old = names.slice(0, Math.max(0, names.length - keep));
  if (old.length === 0) return;
  for (const n of old) await fs.rm(path.join(root, n), { recursive: true, force: true });
  await collectBlobs(pageDir);
}

async function collectBlobs(pageDir) {
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
  for (const n of await fs.readdir(path.join(pageDir, 'snapshots'))) {
    if (!n.startsWith('.tmp-')) indexes.push(path.join(pageDir, 'snapshots', n, 'files.sqlite'));
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
    (dir) => parentPort.postMessage({ dir }),
    (err) => parentPort.postMessage({ error: err.stack || String(err) }),
  );
}
