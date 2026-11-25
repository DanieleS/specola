// Data snapshots (docs/page-backends.md, "Data lifecycle" and "Wire formats
// for data (exact)"). A snapshot is every database of the page copied with
// VACUUM INTO (consistent while the worker keeps writing) plus the file
// store's index; the blobs the index names stay where they are and are kept
// as long as a snapshot names them.
//
// Each snapshot is a directory snapshots/{pageId}/{id}/ holding the copies
// and a meta.json ({kind, label?, version?, createdAt, sizeBytes}). It is
// written aside (.tmp-{id}) and renamed into place, so a directory with a
// snapshot id is always complete, meta.json included.
//
// VACUUM INTO is synchronous and can take seconds on a large database, so
// the copies (and anything else that reads SQLite in bulk) run on a worker
// thread: the runner keeps serving other pages meanwhile.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { RunnerError } from './errors.js';
import { INDEX_SCHEMA } from './worker/files.mjs';
import { heldBlobs } from './worker/usage.mjs';

/** A snapshot id, exactly as the contract has it. */
export const SNAPSHOT_ID = /^[0-9]{8}T[0-9]{6}Z-[a-z-]+(-v[0-9]+)?$/;
const PARSE_ID = /^([0-9]{8}T[0-9]{6})Z-(version|daily|manual|before-restore|before-import|before-wipe)(?:-v([0-9]+))?$/;
// What step 1 named a version snapshot: "20261125T101500.123Z-v3".
const LEGACY_ID = /^([0-9]{8}T[0-9]{6})\.([0-9]{3})Z-v([0-9]+)$/;
export const KINDS = new Set(['version', 'daily', 'manual', 'before-restore', 'before-import', 'before-wipe']);
const BLOB_GRACE_MS = 60 * 60 * 1000;
// SQLite's "not a database" and "malformed": a file the page's code broke.
const SQLITE_BROKEN = new Set([11, 26]);
// The databases the runner itself creates in a page's directory. Anything
// else there is the page code's own business and is not snapshotted.
export const USER_DB = /^[0-9a-f]{64}\.sqlite$/;

/** "20261125T101500Z": sortable, and no ":" in a file name. */
export function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function stampTime(s, millis = '000') {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${millis}Z`;
}

function idFor(kind, ms, version) {
  return `${stamp(ms)}-${kind}${kind === 'version' ? `-v${version}` : ''}`;
}

/** The ids' "before" family, kept together (the last 5 of the three). */
const family = (kind) => (kind.startsWith('before-') ? 'before' : kind);

/** The Snapshot of the wire format. */
export function publicSnapshot(s) {
  return {
    id: s.id,
    kind: s.kind,
    ...(s.kind === 'manual' ? { label: s.label ?? '' } : {}),
    ...(s.kind === 'version' ? { version: s.version } : {}),
    createdAt: s.createdAt,
    sizeBytes: s.sizeBytes,
  };
}

// --- the thread -------------------------------------------------------------

/** Runs one of the operations below on a worker thread. */
function thread(op) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { snapshotOp: op } });
    let done = false;
    w.once('message', (m) => {
      done = true;
      if (!m.error) return resolve(m.result);
      const err = new Error(m.error);
      err.errcode = m.errcode;
      reject(err);
    });
    w.once('error', reject);
    w.once('exit', (code) => !done && reject(new Error(`snapshot thread exited with ${code}`)));
  });
}

const OPS = {
  copy: ({ pageDir, dest }) => copyDatabases(pageDir, dest),
  vacuum: ({ src, dest }) => vacuumInto(src, dest),
  collect: ({ pageDir, snapshotsDir }) => collectBlobsNow(pageDir, snapshotsDir),
  names: ({ file }) => indexNames(file),
  check: ({ file }) => quickCheck(file),
  index: ({ file, rows, updatedAt }) => buildIndex(file, rows, updatedAt),
  count: ({ file }) => indexCount(file),
};

if (!isMainThread && workerData?.snapshotOp) {
  const op = workerData.snapshotOp;
  Promise.resolve()
    .then(() => OPS[op.op](op))
    .then(
      (result) => parentPort.postMessage({ result }),
      (err) => parentPort.postMessage({ error: err.message || String(err), errcode: err.errcode }),
    );
}

/** Copies src to dest with VACUUM INTO, on a worker thread. */
export const vacuumCopy = (src, dest) => thread({ op: 'vacuum', src, dest });

/** The sha256 of every blob a file index names, on a worker thread. */
export const blobNames = (file) => thread({ op: 'names', file });

/**
 * Deletes the blobs that neither the live index nor a snapshot names (old
 * enough not to belong to a put in progress).
 */
export const collectBlobs = (pageDir, snapshotsDir) => thread({ op: 'collect', pageDir, snapshotsDir });

/** SQLite's quick_check of a database file ("ok" when sound), on a worker thread. */
export const sqliteCheck = (file) => thread({ op: 'check', file });

/** Writes a file index with rows [{key, sha256, size, contentType}], on a worker thread. */
export const writeIndex = (file, rows, updatedAt) => thread({ op: 'index', file, rows, updatedAt });

// --- helpers -----------------------------------------------------------------

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** The page's databases, relative to its directory. */
export async function databases(pageDir) {
  const dbs = [];
  for (const name of ['shared.sqlite', 'files.sqlite']) {
    if (await exists(path.join(pageDir, name))) dbs.push(name);
  }
  try {
    for (const name of (await fs.readdir(path.join(pageDir, 'users'))).sort()) {
      if (USER_DB.test(name)) dbs.push(path.join('users', name));
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
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

async function copyDatabases(pageDir, dest) {
  const skipped = [];
  await fs.mkdir(path.join(dest, 'users'), { recursive: true });
  for (const rel of await databases(pageDir)) {
    try {
      vacuumInto(path.join(pageDir, rel), path.join(dest, rel));
    } catch (err) {
      // A database the page's code broke can't be copied, now or ever:
      // refusing the snapshot for it would block version switches and
      // restores for good. Anything else (a full disk) fails the snapshot.
      if (!SQLITE_BROKEN.has(err.errcode)) throw err;
      skipped.push(`${rel} (${err.message})`);
      await fs.rm(path.join(dest, rel), { force: true });
    }
  }
  return { skipped };
}

function indexNames(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // The live index may be mid-write in the worker: wait, don't fail.
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare('SELECT DISTINCT sha256 FROM files').all().map((r) => r.sha256);
  } catch (err) {
    if (/no such table/.test(err.message)) return [];
    throw err;
  } finally {
    db.close();
  }
}

function indexCount(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT count(*) AS n FROM files').get().n;
  } catch (err) {
    if (/no such table/.test(err.message)) return 0;
    throw err;
  } finally {
    db.close();
  }
}

function quickCheck(file) {
  // Read-write: a database in WAL mode can't be opened read-only without its
  // -shm file. It is a private copy, nobody else's.
  const db = new DatabaseSync(file);
  try {
    return db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]).join('; ');
  } finally {
    db.close();
  }
}

function buildIndex(file, rows, updatedAt) {
  const db = new DatabaseSync(file);
  try {
    db.exec(INDEX_SCHEMA);
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO files (key, sha256, size, content_type, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.key, r.sha256, r.size, r.contentType, updatedAt);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

async function collectBlobsNow(pageDir, snapshotsDir) {
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
  let snaps = [];
  try {
    snaps = await fs.readdir(snapshotsDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const n of snaps) {
    // A snapshot being written, or an export in progress, may name blobs
    // its index does not show yet.
    if (n.startsWith('.tmp-')) return;
    indexes.push(path.join(snapshotsDir, n, 'files.sqlite'));
  }
  for (const file of indexes) {
    if (!(await exists(file))) continue;
    for (const sha of indexNames(file)) named.add(sha);
  }
  // A blob written moments ago may belong to a put that has not reached the
  // index yet: leave young blobs for the next collection.
  const cutoff = Date.now() - BLOB_GRACE_MS;
  for (const n of names) {
    if (named.has(n)) continue;
    const file = path.join(blobs, n);
    const st = await fs.stat(file).catch(() => null);
    if (st && st.isFile() && st.mtimeMs < cutoff) await fs.rm(file, { force: true });
  }
}

export async function dirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      total += (await fs.lstat(path.join(e.parentPath ?? e.path, e.name))).size;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return total;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

// --- listing ----------------------------------------------------------------

/**
 * The page's snapshots, newest first: {id, kind, label?, version?,
 * createdAt, sizeBytes, dir}. Step 1's version snapshots ("<stamp>.<ms>Z-v<N>",
 * no meta.json) are read as kind "version" under the id they migrate to.
 */
export async function listSnapshots(snapshotsDir) {
  let names = [];
  try {
    names = await fs.readdir(snapshotsDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const out = [];
  const ids = new Set();
  for (const n of names.sort()) {
    const dir = path.join(snapshotsDir, n);
    const m = PARSE_ID.exec(n);
    if (m) {
      let meta = null;
      try {
        meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
      } catch {
        // Written with the directory, so missing only if someone removed
        // it: what the id says is enough.
      }
      out.push({
        id: n,
        kind: m[2],
        ...(m[2] === 'manual' ? { label: typeof meta?.label === 'string' ? meta.label : '' } : {}),
        ...(m[2] === 'version' ? { version: Number(m[3] ?? meta?.version ?? 0) } : {}),
        createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : stampTime(m[1]),
        sizeBytes: Number.isSafeInteger(meta?.sizeBytes) ? meta.sizeBytes : await dirBytes(dir),
        dir,
      });
      ids.add(n);
      continue;
    }
    const legacy = LEGACY_ID.exec(n);
    if (legacy) {
      const id = `${legacy[1]}Z-version-v${legacy[3]}`;
      if (ids.has(id)) continue;
      ids.add(id);
      out.push({ id, kind: 'version', version: Number(legacy[3]), createdAt: stampTime(legacy[1], legacy[2]), sizeBytes: await dirBytes(dir), dir });
    }
  }
  return out.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
}

/** One snapshot by id, or null. */
export async function findSnapshot(snapshotsDir, id) {
  return (await listSnapshots(snapshotsDir)).find((s) => s.id === id) ?? null;
}

// An id not taken yet: the stamp moves a second on when it is (two snapshots
// of a kind in the same second). createdAt keeps the real time.
async function freeId(snapshotsDir, kind, ms, version) {
  for (let t = ms; ; t += 1000) {
    const id = idFor(kind, t, version);
    if (!(await exists(path.join(snapshotsDir, id))) && !(await exists(path.join(snapshotsDir, `.tmp-${id}`)))) return id;
  }
}

// --- taking and keeping -----------------------------------------------------

/**
 * Snapshots the page's data (pageDir) into snapshotsDir. snapshotsDir is
 * outside the page's directory, where the page's code can't reach it: a
 * snapshot must survive the code it protects from.
 *
 * kind: version (with version: the one leaving), daily, manual (with
 * label), before-restore, before-import, before-wipe. Without data, the
 * automatic kinds take nothing (version, daily: there is nothing to come
 * back to), the others take an empty snapshot (restoring it empties the
 * page). Then the page's snapshots are kept within their counts and their
 * budget (keep()). A manual snapshot that would not fit in the budget beside
 * the other manual ones is refused (409 snapshot-quota); automatic ones are
 * never refused.
 *
 * Resolves to {snapshot, skipped}: the snapshot (null when nothing was
 * taken) and the databases left out because they are broken.
 */
export async function takeSnapshot({ pageDir, snapshotsDir, kind, label, version, now = Date.now(), limits, protect }) {
  if (!KINDS.has(kind)) throw new Error(`unknown snapshot kind ${kind}`);
  const dbs = await databases(pageDir);
  if (dbs.length === 0 && (kind === 'version' || kind === 'daily')) return { snapshot: null, skipped: [] };
  await fs.mkdir(snapshotsDir, { recursive: true });
  const id = await freeId(snapshotsDir, kind, now, version);
  const tmp = path.join(snapshotsDir, `.tmp-${id}`);
  let meta;
  let skipped = [];
  try {
    await fs.mkdir(tmp);
    if (dbs.length) ({ skipped } = await thread({ op: 'copy', pageDir, dest: tmp }));
    const sizeBytes = await dirBytes(tmp);
    if (kind === 'manual') {
      const manual = (await listSnapshots(snapshotsDir)).filter((s) => s.kind === 'manual');
      const used = manual.reduce((n, s) => n + s.sizeBytes, 0);
      if (used + sizeBytes > limits.snapshotDiskBytes) {
        throw new RunnerError(409, 'snapshot-quota', `This snapshot (${fmt(sizeBytes)}) does not fit in the page's snapshot space (${fmt(limits.snapshotDiskBytes)}) beside its manual snapshots (${fmt(used)}): delete some manual snapshots first.`);
      }
    }
    meta = {
      kind,
      ...(kind === 'manual' ? { label } : {}),
      ...(kind === 'version' ? { version } : {}),
      createdAt: new Date(now).toISOString(),
      sizeBytes,
    };
    await fs.writeFile(path.join(tmp, 'meta.json'), JSON.stringify(meta));
    await fs.rename(tmp, path.join(snapshotsDir, id));
  } catch (err) {
    // A failed attempt leaves nothing: partial copies would pile up.
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
  await keep(snapshotsDir, limits, [id, protect], pageDir);
  // Housekeeping: the snapshot is taken whatever happens here, and the next
  // collection deletes what this one leaves.
  await collectBlobs(pageDir, snapshotsDir).catch(() => {});
  return { snapshot: { id, ...meta }, skipped };
}

/**
 * Applies retention: the last versionSnapshotsKept version snapshots,
 * dailySnapshotsKept daily ones and beforeSnapshotsKept of the before-*
 * ones (together); manual ones are never removed here. Then, past
 * snapshotDiskBytes, the oldest automatic ones go first. `spare` lists ids
 * kept whatever (the snapshot just taken; the one being restored). With
 * pageDir, the budget counts the blobs only snapshots keep (usage.mjs) as
 * the snapshots' own, so removing the snapshots that name them frees them.
 */
export async function keep(snapshotsDir, limits, spare = [], pageDir = null) {
  const counts = { version: limits.versionSnapshotsKept, daily: limits.dailySnapshotsKept, before: limits.beforeSnapshotsKept };
  const all = await listSnapshots(snapshotsDir);
  const seen = { version: 0, daily: 0, before: 0 };
  const left = [];
  for (const s of all) {
    const f = family(s.kind);
    if (f !== 'manual' && ++seen[f] > counts[f] && !spare.includes(s.id)) await fs.rm(s.dir, { recursive: true, force: true });
    else left.push(s);
  }
  const held = pageDir ? heldOrNone(pageDir, snapshotsDir) : new Map();
  const cost = (set) => snapshotsCost(set, held);
  let kept = [...left];
  for (const s of [...left].reverse()) {
    if (cost(kept) <= limits.snapshotDiskBytes) break;
    if (s.kind === 'manual' || spare.includes(s.id)) continue;
    await fs.rm(s.dir, { recursive: true, force: true });
    kept = kept.filter((k) => k !== s);
  }
}

// heldBlobs, or none when an index can't be read: the budget then counts
// the copies only, as the snapshots' sizes say.
function heldOrNone(pageDir, snapshotsDir) {
  try {
    return heldBlobs(pageDir, snapshotsDir);
  } catch {
    return new Map();
  }
}

// Bytes a set of snapshots costs: their copies, and the blobs only they
// keep, each once.
function snapshotsCost(snaps, held) {
  let total = snaps.reduce((n, s) => n + s.sizeBytes, 0);
  if (held.size === 0) return total;
  const dirs = new Set(snaps.map((s) => path.basename(s.dir)));
  for (const h of held.values()) {
    for (const d of h.by) {
      if (dirs.has(d)) {
        total += h.size;
        break;
      }
    }
  }
  return total;
}

/** Deletes one snapshot and the blobs only it named. */
export async function deleteSnapshot(pageDir, snapshotsDir, s) {
  await fs.rm(s.dir, { recursive: true, force: true });
  await collectBlobs(pageDir, snapshotsDir);
}

/**
 * Bytes the page's snapshots take: their copies and the blobs only they
 * keep. `snaps` is their listing, when the caller has it.
 */
export async function snapshotBytes(pageDir, snapshotsDir, snaps) {
  return snapshotsCost(snaps ?? (await listSnapshots(snapshotsDir)), heldOrNone(pageDir, snapshotsDir));
}

// --- a user's "delete my data" ------------------------------------------------

const DB_SIDECARS = ['', '-wal', '-shm', '-journal'];

/** Whether a snapshot directory holds the user `name`'s database. */
async function holdsUser(dir, name) {
  const file = path.join(dir, 'users', `${name}.sqlite`);
  for (const s of DB_SIDECARS) if (await exists(file + s)) return true;
  return false;
}

/** The snapshots (listSnapshots' entries) that hold the user `name`'s database. */
export async function snapshotsHolding(snapshotsDir, name) {
  const out = [];
  for (const s of await listSnapshots(snapshotsDir)) if (await holdsUser(s.dir, name)) out.push(s);
  return out;
}

// Whether a snapshot holds nothing once the user `name`'s database is out of
// it: no shared database, no file index with entries, no other user's
// database.
async function emptyWithout(dir, name) {
  if (await exists(path.join(dir, 'shared.sqlite'))) return false;
  let users = [];
  try {
    users = await fs.readdir(path.join(dir, 'users'));
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
  }
  if (users.some((n) => USER_DB.test(n) && n !== `${name}.sqlite`)) return false;
  const index = path.join(dir, 'files.sqlite');
  if (await exists(index)) {
    try {
      if ((await thread({ op: 'count', file: index })) > 0) return false;
    } catch {
      return false; // can't tell: keep it
    }
  }
  return true;
}

// Bytes of a snapshot's copies, as its meta.json counts them (everything
// but meta.json itself, which is written after the size is measured).
async function copiesBytes(dir) {
  let total = await dirBytes(dir);
  for (const n of ['meta.json', 'meta.json.tmp']) {
    const st = await fs.lstat(path.join(dir, n)).catch(() => null);
    if (st?.isFile()) total -= st.size;
  }
  return total;
}

/**
 * Removes the user `name`'s database (with its sidecars) from each of
 * `snapshots` (listSnapshots' entries): its meta.json gets the new size,
 * written aside and renamed; a snapshot left with nothing is deleted (renamed
 * to a .tmp- name first, so a snapshot id is there whole or not at all, and
 * the start-up sweep removes what a crash leaves). Idempotent: run again on
 * the same snapshots, it finishes what a previous run left (a database
 * removed but the size not updated yet, a snapshot emptied but not deleted).
 * Resolves to {rewritten, deleted}: snapshot ids.
 */
export async function eraseUserFromSnapshots(snapshots, name) {
  const rewritten = [];
  const deleted = [];
  for (const s of snapshots) {
    if (!(await exists(s.dir))) continue;
    if (await emptyWithout(s.dir, name)) {
      const gone = path.join(path.dirname(s.dir), `.tmp-erased-${randomBytes(6).toString('hex')}`);
      await fs.rename(s.dir, gone);
      await fs.rm(gone, { recursive: true, force: true });
      deleted.push(s.id);
      continue;
    }
    const file = path.join(s.dir, 'users', `${name}.sqlite`);
    for (const x of DB_SIDECARS) await fs.rm(file + x, { force: true });
    const metaFile = path.join(s.dir, 'meta.json');
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    } catch {
      // No meta.json (a step 1 snapshot not migrated yet): its size is
      // measured whenever it is listed.
      rewritten.push(s.id);
      continue;
    }
    const sizeBytes = await copiesBytes(s.dir);
    if (meta.sizeBytes !== sizeBytes) await writeAtomic(metaFile, JSON.stringify({ ...meta, sizeBytes }));
    rewritten.push(s.id);
  }
  return { rewritten, deleted };
}

function fmt(n) {
  if (n >= 1024 ** 3) return `${+(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${+(n / 1024 ** 2).toFixed(2)} MiB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(2)} KiB`;
  return `${n} B`;
}

// --- start-up ----------------------------------------------------------------

/**
 * Run at start, before any worker: removes snapshots a previous runner
 * process left half written (it died while taking them, or exporting:
 * snapshots/{pageId}/.tmp-*), and gives step 1's version snapshots their
 * id and meta.json.
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
    const dir = path.join(root, p);
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.startsWith('.tmp-')) {
        await fs.rm(path.join(dir, n), { recursive: true, force: true });
        continue;
      }
      const legacy = LEGACY_ID.exec(n);
      if (!legacy) continue;
      const ms = Date.parse(stampTime(legacy[1], legacy[2]));
      const version = Number(legacy[3]);
      const id = await freeId(dir, 'version', ms, version);
      const from = path.join(dir, n);
      const meta = { kind: 'version', version, createdAt: new Date(ms).toISOString(), sizeBytes: await dirBytes(from) };
      await writeAtomic(path.join(from, 'meta.json'), JSON.stringify(meta));
      await fs.rename(from, path.join(dir, id));
    }
  }
}
