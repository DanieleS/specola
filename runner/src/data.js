// What the data lifecycle does to a page's files (docs/page-backends.md,
// "Export, import, wipe" and "Wire formats for data (exact)"): the export
// zip, checking and staging an import, and replacing data for a restore,
// an import or a wipe. Pages (pages.js) decides when: these run with the
// page offline (no worker) when they change anything.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { RunnerError } from './errors.js';
import { DATA_DIR, USER_DB, copyData, dirBytes, sqliteCheck, vacuumCopy, writeIndex } from './snapshot.js';
import { contentTypeProblem } from './worker/files.mjs';
import { pathProblem } from './worker/paths.mjs';
import { ZipError, entryData, readZip, zipStream } from './zip.js';

export const FORMAT = 'specola-backend-data';
export const FORMAT_VERSION = 1;
const SHA = /^[0-9a-f]{64}$/;
const MAX_MANIFEST = 1024 * 1024;
const MAX_INDEX = 64 * 1024 * 1024;
const DATA_PREFIX = 'files/data/';
// The page's data directory (ctx.dataDir) in the zip.
const DIR_PREFIX = DATA_DIR + '/';
const SIDECARS = ['', '-wal', '-shm', '-journal'];

// Content that is compressed already: deflating it again costs time for
// nothing, so it is stored as is (as is shared.sqlite, which a reader may
// want to open straight from the zip).
const COMPRESSED = /^(image\/(jpeg|png|gif|webp|avif|heic|heif|jxl)|video\/|audio\/(?!(wav|x-wav|wave)\b)|font\/woff2?|application\/(zip|gzip|x-gzip|x-bzip2|x-xz|x-7z-compressed|vnd\.rar|x-rar-compressed|zstd|x-zstd|java-archive|epub\+zip|vnd\.openxmlformats-[a-z.-]+))\b/i;

/** Removes a SQLite database with its WAL, shared memory and journal. */
export async function removeDb(file) {
  for (const s of SIDECARS) await fs.rm(file + s, { force: true });
}

/** The user databases in a users/ directory. */
async function userDbs(dir) {
  try {
    return (await fs.readdir(dir)).filter((n) => USER_DB.test(n));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

/** The sha256 hex of a user's sub, which names their database. */
export const userHash = (sub) => createHash('sha256').update(sub).digest('hex');

// --- export -------------------------------------------------------------------

/**
 * Copies what an export needs into `pin` (a .tmp- directory under the page's
 * snapshots, so the blob collection leaves alone every blob it names while
 * the zip streams): shared.sqlite and files.sqlite, consistent copies, and
 * the data directory. Returns {shared: bool, rows, data: [{path, size}],
 * skipped: [why]} (data files an import would refuse are left out).
 */
export async function prepareExport(pageDir, pin) {
  await fs.mkdir(pin, { recursive: true });
  let shared = false;
  try {
    await fs.access(path.join(pageDir, 'shared.sqlite'));
    shared = true;
  } catch {
    // no shared database yet
  }
  if (shared) await vacuumCopy(path.join(pageDir, 'shared.sqlite'), path.join(pin, 'shared.sqlite'));
  let rows = [];
  try {
    await fs.access(path.join(pageDir, 'files.sqlite'));
    await vacuumCopy(path.join(pageDir, 'files.sqlite'), path.join(pin, 'files.sqlite'));
    const db = new DatabaseSync(path.join(pin, 'files.sqlite'), { readOnly: true });
    try {
      rows = db.prepare('SELECT key, content_type AS contentType, size, sha256 FROM files ORDER BY key').all();
    } finally {
      db.close();
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const { files: data, skipped } = await copyData(path.join(pageDir, DATA_DIR), path.join(pin, DATA_DIR), true);
  return { shared, rows, data, skipped };
}

/**
 * Streams the export zip of a prepared pin: manifest, shared.sqlite, files,
 * the data directory. The manifest's `data: true` says the zip carries the
 * data directory (possibly empty): importing it replaces the page's.
 */
export function exportZip({ pageDir, pin, shared, rows, data = [], page, now }) {
  const date = new Date(now);
  const manifest = Buffer.from(
    JSON.stringify({ format: FORMAT, formatVersion: FORMAT_VERSION, page, exportedAt: date.toISOString(), data: true }, null, 2),
  );
  const index = Buffer.from(JSON.stringify(rows.map((r) => ({ key: r.key, contentType: r.contentType, size: r.size, sha256: r.sha256 }))));
  const once = (buf) => async function* () {
    yield buf;
  };
  const file = (p) => () => createReadStream(p);
  async function* entries() {
    yield { name: 'manifest.json', size: manifest.length, method: 8, data: once(manifest) };
    if (shared) {
      const p = path.join(pin, 'shared.sqlite');
      yield { name: 'shared.sqlite', size: (await fs.stat(p)).size, method: 0, data: file(p) };
    }
    yield { name: 'files/index.json', size: index.length, method: 8, data: once(index) };
    for (const r of rows) {
      const p = path.join(pageDir, 'files', 'blobs', r.sha256);
      yield { name: DATA_PREFIX + r.key, size: r.size, method: COMPRESSED.test(r.contentType) ? 0 : 8, data: file(p) };
    }
    for (const d of data) {
      yield { name: DIR_PREFIX + d.path, size: d.size, method: 8, data: file(path.join(pin, DATA_DIR, d.path)) };
    }
  }
  return Readable.from(zipStream(entries(), { date }));
}

// --- import -------------------------------------------------------------------

const bad = (message) => new RunnerError(400, 'bad-import', message);

async function readSmall(file, e, max, what) {
  if (e.usize > max) throw bad(`${what} is too large`);
  const parts = [];
  for await (const c of entryData(file, e)) parts.push(c);
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw bad(`${what} is not valid JSON`);
  }
}

/**
 * Checks the zip at `zipFile` against the export format and builds what it
 * holds in `work` (shared.sqlite, files.sqlite, blobs/), touching nothing of
 * the page. `room` is how many bytes the imported data may use (the page
 * quota less its users' databases). Throws 400 bad-import naming the
 * problem.
 */
export async function stageImport(zipFile, work, { room, now }) {
  try {
    return await stage(zipFile, work, room, now);
  } catch (err) {
    if (err instanceof ZipError) throw bad(`The zip is not valid: ${err.message}.`);
    throw err;
  }
}

async function stage(zipFile, work, room, now) {
  const entries = await readZip(zipFile);
  const byName = new Map();
  for (const e of entries) {
    if (byName.has(e.name)) throw bad(`${JSON.stringify(e.name)} is in the zip twice.`);
    byName.set(e.name, e);
  }
  // The layout: these three names, files under files/data/, and the
  // directory entries some zip tools add above them. Nothing else.
  for (const e of entries) {
    const shown = JSON.stringify(e.name);
    if (e.dir) {
      const d = e.name.slice(0, -1);
      const inData = d === DATA_DIR || (d.startsWith(DIR_PREFIX) && !pathProblem(d.slice(DIR_PREFIX.length)));
      if (d !== 'files' && d !== 'files/data' && !inData && !(d.startsWith(DATA_PREFIX) && !pathProblem(d.slice(DATA_PREFIX.length)))) {
        throw bad(`${shown} is not part of the export format.`);
      }
      continue;
    }
    if (e.name === 'manifest.json' || e.name === 'shared.sqlite' || e.name === 'files/index.json') continue;
    if (e.name.startsWith(DIR_PREFIX)) {
      const why = pathProblem(e.name.slice(DIR_PREFIX.length));
      if (why) throw bad(`${shown}: the path ${why}.`);
      continue;
    }
    if (!e.name.startsWith(DATA_PREFIX)) throw bad(`${shown} is not part of the export format.`);
    const why = pathProblem(e.name.slice(DATA_PREFIX.length));
    if (why) throw bad(`${shown}: the file key ${why}.`);
  }

  const m = byName.get('manifest.json');
  if (!m) throw bad('manifest.json is missing: this is not a Specola data export.');
  const manifest = await readSmall(zipFile, m, MAX_MANIFEST, 'manifest.json');
  if (manifest?.format !== FORMAT) throw bad(`manifest.json: format is not "${FORMAT}".`);
  if (manifest.formatVersion !== FORMAT_VERSION) throw bad(`manifest.json: formatVersion ${JSON.stringify(manifest.formatVersion)} is not supported (only ${FORMAT_VERSION}).`);
  const p = manifest.page;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.title !== 'string' || !(p.version === null || Number.isSafeInteger(p.version))) {
    throw bad('manifest.json: page is not {id, title, version}.');
  }
  if (typeof manifest.exportedAt !== 'string' || Number.isNaN(Date.parse(manifest.exportedAt))) throw bad('manifest.json: exportedAt is not a date.');
  if (manifest.data !== undefined && typeof manifest.data !== 'boolean') throw bad('manifest.json: data is not true or false.');
  const dataFiles = entries.filter((e) => !e.dir && e.name.startsWith(DIR_PREFIX));
  // Exports from before the data directory have no `data`: importing them
  // leaves the page's data directory as it is.
  const hasDataDir = manifest.data === true || dataFiles.length > 0;

  const ie = byName.get('files/index.json');
  if (!ie) throw bad('files/index.json is missing.');
  const index = await readSmall(zipFile, ie, MAX_INDEX, 'files/index.json');
  if (!Array.isArray(index)) throw bad('files/index.json is not a list.');
  const keys = new Map();
  for (const [i, r] of index.entries()) {
    const at = `files/index.json, entry ${i + 1}`;
    if (!r || typeof r !== 'object') throw bad(`${at} is not an object.`);
    const why = pathProblem(r.key);
    if (why) throw bad(`${at}: the key ${JSON.stringify(r.key)} ${why}.`);
    if (keys.has(r.key)) throw bad(`${at}: the key ${JSON.stringify(r.key)} is listed twice.`);
    if (contentTypeProblem(r.contentType)) throw bad(`${at}: contentType ${contentTypeProblem(r.contentType)}.`);
    if (!Number.isSafeInteger(r.size) || r.size < 0) throw bad(`${at}: size is not a byte count.`);
    if (typeof r.sha256 !== 'string' || !SHA.test(r.sha256)) throw bad(`${at}: sha256 is not a lowercase hex sha256.`);
    const e = byName.get(DATA_PREFIX + r.key);
    if (!e || e.dir) throw bad(`${at}: ${DATA_PREFIX}${r.key} is missing from the zip.`);
    if (e.usize !== r.size) throw bad(`${DATA_PREFIX}${r.key} is ${e.usize} bytes, but files/index.json says ${r.size}.`);
    keys.set(r.key, { key: r.key, contentType: r.contentType, size: r.size, sha256: r.sha256, entry: e });
  }
  for (const e of entries) {
    if (!e.dir && e.name.startsWith(DATA_PREFIX) && !keys.has(e.name.slice(DATA_PREFIX.length))) {
      throw bad(`${JSON.stringify(e.name)} is not listed in files/index.json.`);
    }
  }

  // The size it will take, before inflating anything: what the entries
  // declare (and inflating never goes past that), the same content once.
  const s = byName.get('shared.sqlite');
  if (s?.dir) throw bad('"shared.sqlite/" is not part of the export format.');
  const blobs = new Map();
  for (const k of keys.values()) {
    // The same content is the same size: otherwise the sizes counted here
    // are not what inflating writes.
    if (blobs.has(k.sha256) && blobs.get(k.sha256) !== k.size) {
      throw bad(`files/index.json lists the sha256 ${k.sha256} with two different sizes.`);
    }
    blobs.set(k.sha256, k.size);
  }
  const expanded = (s?.usize ?? 0) + [...blobs.values()].reduce((a, b) => a + b, 0) + dataFiles.reduce((a, e) => a + e.usize, 0);
  if (expanded > room) throw bad(`Its data takes ${expanded} bytes, more than the page has room for (${room} bytes).`);
  // And what is written is counted as it is written, whatever the entries
  // declare: the staging space is no page's quota.
  let written = 0;
  const count = async function* (src) {
    for await (const c of src) {
      written += c.length;
      if (written > expanded) throw bad(`Its data inflates to more than the ${expanded} bytes it declares.`);
      yield c;
    }
  };

  await fs.mkdir(path.join(work, 'blobs'), { recursive: true });
  if (s) {
    const file = path.join(work, 'shared.sqlite');
    await pipeline(Readable.from(entryData(zipFile, s)), count, createWriteStream(file));
    const head = Buffer.alloc(16);
    const fh = await fs.open(file);
    await fh.read(head, 0, 16, 0);
    await fh.close();
    if (!head.equals(Buffer.from('SQLite format 3\0'))) throw bad('shared.sqlite is not a SQLite database.');
    let check;
    try {
      check = await sqliteCheck(file);
    } catch (err) {
      throw bad(`shared.sqlite cannot be opened: ${err.message}.`);
    }
    if (check !== 'ok') throw bad(`shared.sqlite is damaged: ${check.slice(0, 200)}.`);
  }
  let n = 0;
  const staged = new Set();
  for (const k of keys.values()) {
    const hash = createHash('sha256');
    const hashing = async function* (src) {
      for await (const c of src) {
        hash.update(c);
        yield c;
      }
    };
    if (staged.has(k.sha256)) {
      // Content already staged: only checked, not written again.
      let len = 0;
      for await (const c of hashing(Readable.from(entryData(zipFile, k.entry)))) len += c.length;
      if (len !== k.size || hash.digest('hex') !== k.sha256) throw bad(`${DATA_PREFIX}${k.key} does not match its sha256 in files/index.json.`);
      continue;
    }
    const part = path.join(work, 'blobs', `.part-${n++}`);
    await pipeline(Readable.from(entryData(zipFile, k.entry)), count, hashing, createWriteStream(part));
    const got = hash.digest('hex');
    if (got !== k.sha256) throw bad(`${DATA_PREFIX}${k.key} does not match its sha256 in files/index.json.`);
    staged.add(got);
    await fs.rename(part, path.join(work, 'blobs', got));
  }
  if (hasDataDir) {
    await fs.mkdir(path.join(work, DATA_DIR), { recursive: true });
    for (const e of dataFiles) {
      const to = path.join(work, DATA_DIR, ...e.name.slice(DIR_PREFIX.length).split('/'));
      await fs.mkdir(path.dirname(to), { recursive: true });
      await pipeline(Readable.from(entryData(zipFile, e)), count, createWriteStream(to));
    }
  }
  const rows = [...keys.values()].map(({ key, contentType, size, sha256 }) => ({ key, contentType, size, sha256 }));
  await writeIndex(path.join(work, 'files.sqlite'), rows, new Date(now).toISOString());
  return { shared: Boolean(s), files: rows.length, data: hasDataDir ? dataFiles.length : null, bytes: expanded };
}

// --- replacing data, all or nothing ---------------------------------------
//
// A restore, an import or a wipe replaces some of the page's data: its
// "slots", shared.sqlite, files.sqlite, users/ and data/ (ctx.dataDir). Replacing them one by one
// in place would leave a mix (the snapshot's shared data beside the old file
// index, users' databases half copied) when the disk fills up or the runner
// dies midway. So the new data is built complete aside, in a swap directory
// on the same volume (where anything can fail and the page is untouched);
// then a journal naming the slots is written, which is the commit point;
// then each slot is swapped by renames. finishSwap() does that last part and
// can run again from any point, which the runner does at start-up for a
// swap a previous process left with its journal (and drops one left
// without: it never committed).

export const SLOTS = Object.freeze(['shared.sqlite', 'files.sqlite', 'users', DATA_DIR]);
const DIR_SLOTS = new Set(['users', DATA_DIR]);
const JOURNAL = 'journal.json';

/** Where a swap builds the new data (`<swapDir>/new`). */
export const swapNew = (swapDir) => path.join(swapDir, 'new');

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commits the swap built in swapNew(swapDir): each slot ends as it is there,
 * or absent when it is not there. The page is offline.
 */
export async function commitSwap(pageDir, swapDir, slots) {
  const has = {};
  for (const slot of slots) has[slot] = await exists(path.join(swapNew(swapDir), slot));
  const journal = path.join(swapDir, JOURNAL);
  const tmp = `${journal}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ slots, has }));
  await fs.rename(tmp, journal);
  await finishSwap(pageDir, swapDir);
}

/**
 * Finishes a committed swap, or drops one that never committed (no
 * journal). Idempotent. Resolves to whether one was finished.
 */
export async function finishSwap(pageDir, swapDir) {
  let journal;
  try {
    journal = JSON.parse(await fs.readFile(path.join(swapDir, JOURNAL), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    // Never committed (a torn journal.tmp is not one): the page's data is
    // as it was.
    await fs.rm(swapDir, { recursive: true, force: true });
    return false;
  }
  await fs.mkdir(pageDir, { recursive: true });
  for (const slot of journal.slots) {
    if (!SLOTS.includes(slot)) continue;
    const src = path.join(swapNew(swapDir), slot);
    const dest = path.join(pageDir, slot);
    // Already moved in by an earlier run: done.
    if (journal.has[slot] && !(await exists(src))) continue;
    // The old one and its sidecars go first: a WAL left beside the new
    // file would be replayed into it.
    if (DIR_SLOTS.has(slot)) await fs.rm(dest, { recursive: true, force: true });
    else await removeDb(dest);
    if (journal.has[slot]) await fs.rename(src, dest);
  }
  await fs.rm(swapDir, { recursive: true, force: true });
  return true;
}

/**
 * Builds a staged import (stageImport's `work`) into a swap: its blobs go
 * straight into the page's store (content-addressed, so adding them changes
 * nothing until an index names them), its databases and data directory
 * into swapNew(swapDir). Commit with importSlots(staged): users' databases
 * stay.
 */
export async function stageSwapImport(pageDir, work, swapDir) {
  const blobs = path.join(pageDir, 'files', 'blobs');
  await fs.mkdir(blobs, { recursive: true });
  for (const n of await fs.readdir(path.join(work, 'blobs'))) {
    if (SHA.test(n)) await fs.rename(path.join(work, 'blobs', n), path.join(blobs, n));
  }
  for (const slot of ['shared.sqlite', 'files.sqlite', DATA_DIR]) {
    if (await exists(path.join(work, slot))) await fs.rename(path.join(work, slot), path.join(swapNew(swapDir), slot));
  }
}

/** The slots an import replaces: the data directory only when the zip carries one. */
export const importSlots = (staged) => ['shared.sqlite', 'files.sqlite', ...(staged.data !== null ? [DATA_DIR] : [])];

/** The slots a restore of the snapshot in snapDir replaces: data/ only when the snapshot has it. */
export async function restoreSlots(snapDir) {
  return (await exists(path.join(snapDir, DATA_DIR))) ? SLOTS : SLOTS.filter((s) => s !== DATA_DIR);
}

/**
 * Builds a snapshot's data into a swap: every slot as the snapshot has it
 * (the blobs it names are in the page's store: kept for as long as a
 * snapshot names them), except the user databases named in `skip` (file
 * names: the data of users who deleted theirs). Commit with all the SLOTS.
 */
export async function stageSwapRestore(snapDir, swapDir, skip = new Set()) {
  const to = swapNew(swapDir);
  for (const db of ['shared.sqlite', 'files.sqlite']) {
    if (await exists(path.join(snapDir, db))) await fs.copyFile(path.join(snapDir, db), path.join(to, db));
  }
  const users = (await userDbs(path.join(snapDir, 'users'))).filter((n) => !skip.has(n));
  if (users.length) await fs.mkdir(path.join(to, 'users'));
  for (const n of users) await fs.copyFile(path.join(snapDir, 'users', n), path.join(to, 'users', n));
  if (await exists(path.join(snapDir, DATA_DIR))) await fs.cp(path.join(snapDir, DATA_DIR), path.join(to, DATA_DIR), { recursive: true });
}

/** The slots a wipe empties: the shared database, file index and data directory ("shared") or every user's database ("users"). */
export const wipeSlots = (scope) => (scope === 'shared' ? ['shared.sqlite', 'files.sqlite', DATA_DIR] : ['users']);

/** Bytes the users' databases take (they stay through an import). */
export async function usersBytes(pageDir) {
  return dirBytes(path.join(pageDir, 'users'));
}
