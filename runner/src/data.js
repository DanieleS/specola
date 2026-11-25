// What the data lifecycle does to a page's files (docs/page-backends.md,
// "Export, import, wipe" and "Wire formats for data (exact)"): the export
// zip, checking and staging an import, and replacing data for a restore,
// an import or a wipe. Pages (pages.js) decides when: these run with the
// page offline (no worker) when they change anything.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { RunnerError } from './errors.js';
import { USER_DB, dirBytes, sqliteCheck, vacuumCopy, writeIndex } from './snapshot.js';
import { contentTypeProblem } from './worker/files.mjs';
import { pathProblem } from './worker/paths.mjs';
import { ZipError, entryData, readZip, zipStream } from './zip.js';

export const FORMAT = 'specola-backend-data';
export const FORMAT_VERSION = 1;
const SHA = /^[0-9a-f]{64}$/;
const MAX_MANIFEST = 1024 * 1024;
const MAX_INDEX = 64 * 1024 * 1024;
const DATA_PREFIX = 'files/data/';
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
 * the zip streams): shared.sqlite and files.sqlite, consistent copies.
 * Returns {shared: bool, rows}.
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
  return { shared, rows };
}

/** Streams the export zip of a prepared pin: manifest, shared.sqlite, files. */
export function exportZip({ pageDir, pin, shared, rows, page, now }) {
  const date = new Date(now);
  const manifest = Buffer.from(
    JSON.stringify({ format: FORMAT, formatVersion: FORMAT_VERSION, page, exportedAt: date.toISOString() }, null, 2),
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
      if (d !== 'files' && d !== 'files/data' && !(d.startsWith(DATA_PREFIX) && !pathProblem(d.slice(DATA_PREFIX.length)))) {
        throw bad(`${shown} is not part of the export format.`);
      }
      continue;
    }
    if (e.name === 'manifest.json' || e.name === 'shared.sqlite' || e.name === 'files/index.json') continue;
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
  for (const k of keys.values()) blobs.set(k.sha256, k.size);
  const expanded = (s?.usize ?? 0) + [...blobs.values()].reduce((a, b) => a + b, 0);
  if (expanded > room) throw bad(`Its data takes ${expanded} bytes, more than the page has room for (${room} bytes).`);

  await fs.mkdir(path.join(work, 'blobs'), { recursive: true });
  if (s) {
    const file = path.join(work, 'shared.sqlite');
    await pipeline(Readable.from(entryData(zipFile, s)), createWriteStream(file));
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
  for (const k of keys.values()) {
    const part = path.join(work, 'blobs', `.part-${n++}`);
    const hash = createHash('sha256');
    await pipeline(
      Readable.from(entryData(zipFile, k.entry)),
      async function* (src) {
        for await (const c of src) {
          hash.update(c);
          yield c;
        }
      },
      createWriteStream(part),
    );
    const got = hash.digest('hex');
    if (got !== k.sha256) throw bad(`${DATA_PREFIX}${k.key} does not match its sha256 in files/index.json.`);
    await fs.rename(part, path.join(work, 'blobs', got));
  }
  const rows = [...keys.values()].map(({ key, contentType, size, sha256 }) => ({ key, contentType, size, sha256 }));
  await writeIndex(path.join(work, 'files.sqlite'), rows, new Date(now).toISOString());
  return { shared: Boolean(s), files: rows.length, bytes: expanded };
}

/**
 * Puts a staged import in place of the page's shared database and file
 * store (users' databases stay). The page is offline.
 */
export async function swapImport(pageDir, work) {
  const blobs = path.join(pageDir, 'files', 'blobs');
  await fs.mkdir(blobs, { recursive: true });
  // Content-addressed: a blob already there is the same bytes.
  for (const n of await fs.readdir(path.join(work, 'blobs'))) {
    if (SHA.test(n)) await fs.rename(path.join(work, 'blobs', n), path.join(blobs, n));
  }
  await replaceDb(path.join(work, 'shared.sqlite'), path.join(pageDir, 'shared.sqlite'), { move: true });
  await replaceDb(path.join(work, 'files.sqlite'), path.join(pageDir, 'files.sqlite'), { move: true });
}

// The old database and its sidecars go first: a WAL left beside the new
// file would be replayed into it.
async function replaceDb(src, dest, { move = false } = {}) {
  await removeDb(dest);
  try {
    await fs.access(src);
  } catch {
    return; // none in the source: the page has none either
  }
  if (move) {
    await fs.rename(src, dest);
    return;
  }
  const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.copyFile(src, tmp);
  await fs.rename(tmp, dest);
}

// --- restore and wipe ---------------------------------------------------------

/**
 * Replaces all of the page's data (shared, every user's, the file index)
 * with a snapshot's. The page is offline; the blobs the snapshot names are
 * there (kept by the collection for as long as a snapshot names them).
 */
export async function restoreFrom(pageDir, snapDir) {
  await fs.mkdir(pageDir, { recursive: true });
  await replaceDb(path.join(snapDir, 'shared.sqlite'), path.join(pageDir, 'shared.sqlite'));
  await replaceDb(path.join(snapDir, 'files.sqlite'), path.join(pageDir, 'files.sqlite'));
  const users = path.join(pageDir, 'users');
  for (const n of await userDbs(users)) await removeDb(path.join(users, n));
  const from = await userDbs(path.join(snapDir, 'users'));
  if (from.length) await fs.mkdir(users, { recursive: true });
  for (const n of from) await replaceDb(path.join(snapDir, 'users', n), path.join(users, n));
}

/** Wipes the shared database and file index ("shared") or every user's database ("users"). */
export async function wipe(pageDir, scope) {
  if (scope === 'shared') {
    await removeDb(path.join(pageDir, 'shared.sqlite'));
    await removeDb(path.join(pageDir, 'files.sqlite'));
    await fs.rm(path.join(pageDir, 'files', 'tmp'), { recursive: true, force: true });
    return;
  }
  const users = path.join(pageDir, 'users');
  for (const n of await userDbs(users)) await removeDb(path.join(users, n));
}

/** Bytes the users' databases take (they stay through an import). */
export async function usersBytes(pageDir) {
  return dirBytes(path.join(pageDir, 'users'));
}
