// What a page's data uses on disk, split between the page's own quota and
// its snapshots' (docs/page-backends.md, "Limits": 1 GiB for the page, 2 GiB
// for snapshots beyond it).
//
// A snapshot copies the file index, not the blobs: they stay under the
// page's files/blobs for as long as any index names them. A blob that only
// snapshots name (the files a wipe or an import replaced, kept so the
// before-* snapshot can bring them back) is the snapshots' cost, not the
// page's: counted against the page it would leave a reset page full, and
// an import could pile the old files on top of the new ones. So the page's
// usage is everything under its directory less those blobs, and the
// snapshots' usage is their copies plus those blobs, which their retention
// can then free.
// This file runs inside page workers too: it must only import node: modules.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Snapshot directory → the sha256s its index names. A snapshot never
// changes once its directory has its id (it is written aside and renamed
// into place), so each index is read once.
const named = new Map();

function indexNames(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    if (err.code === 'ENOENT' || !fs.existsSync(file)) return [];
    throw err;
  }
  try {
    // The live index may be mid-write: wait, don't fail.
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare('SELECT DISTINCT sha256 FROM files').all().map((r) => r.sha256);
  } catch (err) {
    if (/no such table/.test(err.message)) return [];
    throw err;
  } finally {
    db.close();
  }
}

function snapshotNames(dir) {
  let set = named.get(dir);
  if (!set) {
    const file = path.join(dir, 'files.sqlite');
    set = new Set(fs.existsSync(file) ? indexNames(file) : []);
    named.set(dir, set);
  }
  return set;
}

/**
 * The blobs that snapshots name and the live index does not, as
 * Map<sha256, {size, by: Set<snapshot directory name>}>. Snapshots still
 * being written (.tmp-*) are left out: they name live blobs.
 */
export function heldBlobs(pageDir, snapshotsDir) {
  const held = new Map();
  if (!snapshotsDir) return held;
  let dirs;
  try {
    dirs = fs.readdirSync(snapshotsDir).filter((n) => !n.startsWith('.'));
  } catch (err) {
    if (err.code === 'ENOENT') return held;
    throw err;
  }
  const seen = new Set();
  for (const n of dirs) {
    const dir = path.join(snapshotsDir, n);
    seen.add(dir);
    for (const sha of snapshotNames(dir)) {
      let h = held.get(sha);
      if (!h) held.set(sha, (h = { size: 0, by: new Set() }));
      h.by.add(n);
    }
  }
  // Forget the snapshots that went (in this directory).
  for (const dir of named.keys()) {
    if (path.dirname(dir) === snapshotsDir && !seen.has(dir)) named.delete(dir);
  }
  if (held.size === 0) return held;
  const live = path.join(pageDir, 'files.sqlite');
  if (fs.existsSync(live)) for (const sha of indexNames(live)) held.delete(sha);
  const blobs = path.join(pageDir, 'files', 'blobs');
  for (const [sha, h] of held) {
    try {
      h.size = fs.lstatSync(path.join(blobs, sha)).size;
    } catch {
      held.delete(sha); // not on disk: costs nothing
    }
  }
  return held;
}

function heldSafe(pageDir, snapshotsDir) {
  try {
    return heldBlobs(pageDir, snapshotsDir);
  } catch {
    // An index that can't be read: count everything, as is safe.
    return new Map();
  }
}

/**
 * Bytes the page's own quota counts: everything under its directory
 * (databases with their WAL and shared memory, the file store with puts in
 * progress, whatever the code wrote) except the blobs only snapshots keep.
 */
export async function pageUsage(pageDir, snapshotsDir) {
  const held = heldSafe(pageDir, snapshotsDir);
  const blobs = path.join(pageDir, 'files', 'blobs');
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(pageDir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const dir = e.parentPath ?? e.path;
    if (dir === blobs && held.has(e.name)) continue;
    try {
      total += (await fs.promises.lstat(path.join(dir, e.name))).size;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // deleted meanwhile
    }
  }
  return total;
}

/** pageUsage, for a database opening in a synchronous getter (ctx.db). */
export function pageUsageSync(pageDir, snapshotsDir) {
  const held = heldSafe(pageDir, snapshotsDir);
  const blobs = path.join(pageDir, 'files', 'blobs');
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(pageDir, { recursive: true, withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const dir = e.parentPath ?? e.path;
    if (dir === blobs && held.has(e.name)) continue;
    try {
      total += fs.lstatSync(path.join(dir, e.name)).size;
    } catch {
      // deleted meanwhile
    }
  }
  return total;
}
