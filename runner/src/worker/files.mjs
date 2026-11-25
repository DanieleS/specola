// ctx.files: the page's key/value file store (docs/page-backends.md, "Data
// lifecycle"). It is content-addressed: an index in files.sqlite and the
// contents under files/blobs/<sha256>, so a snapshot of the store is a copy of
// the index, and a blob is deleted only when neither the live index nor any
// snapshot's index names it.
// This file runs inside page workers: it must only import node: modules.

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { pathProblem } from './paths.mjs';

const MAX_CONTENT_TYPE = 255;

/** The file index's tables (also built by the runner for an import). */
export const INDEX_SCHEMA = `CREATE TABLE IF NOT EXISTS files (
    key TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS files_sha256 ON files (sha256);`;

/** Why a content type is not acceptable, or null. */
export function contentTypeProblem(t) {
  // eslint-disable-next-line no-control-regex
  if (typeof t !== 'string' || t === '' || t.length > MAX_CONTENT_TYPE || /[\u0000-\u001f\u007f]/.test(t)) return 'is not a valid content type';
  return null;
}

/** Thrown by put when the page's data would exceed its disk quota. */
export class QuotaExceededError extends Error {
  constructor(used, quota) {
    super(`page disk quota exceeded: the page's databases and files would use more than ${formatBytes(quota)} (${formatBytes(used)} used before this write)`);
    this.name = 'QuotaExceededError';
    this.code = 'ERR_PAGE_DISK_QUOTA';
  }
}

export function formatBytes(n) {
  if (n >= 1024 ** 3) return `${+(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${+(n / 1024 ** 2).toFixed(2)} MiB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(2)} KiB`;
  return `${n} B`;
}

function checkKey(key) {
  const why = pathProblem(key);
  if (why) throw new TypeError(`files: invalid key ${JSON.stringify(key)}: it ${why}`);
}

/**
 * Bytes the page's directory uses on disk: databases (with their WAL and
 * shared memory files), the file store (writes in progress included) and
 * anything else the code wrote there. Snapshots live elsewhere and have their
 * own quota (see Limits).
 */
export async function pageUsage(pageDir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(pageDir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const dir = e.parentPath ?? e.path;
    try {
      total += (await fs.lstat(path.join(dir, e.name))).size;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // deleted meanwhile
    }
  }
  return total;
}

export class FileStore {
  #pageDir;
  #snapshotsDir;
  #quota;
  #db = null;
  // Blobs written by a put that has not reached the index yet, which a
  // concurrent delete must not collect.
  #pending = new Map();

  /**
   * @param {string} pageDir
   * @param {number} quotaBytes the page's disk quota
   * @param {string} snapshotsDir the page's snapshots, whose indexes keep blobs
   */
  constructor(pageDir, quotaBytes, snapshotsDir) {
    this.#pageDir = pageDir;
    this.#quota = quotaBytes;
    this.#snapshotsDir = snapshotsDir;
  }

  get #blobs() {
    return path.join(this.#pageDir, 'files', 'blobs');
  }

  #index() {
    if (this.#db) return this.#db;
    const db = new DatabaseSync(path.join(this.#pageDir, 'files.sqlite'));
    db.exec(`PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      ${INDEX_SCHEMA}`);
    this.#db = db;
    return db;
  }

  close() {
    this.#db?.close();
    this.#db = null;
  }

  /**
   * Stores body (anything `new Response(body)` accepts: a string, bytes, a
   * Blob, FormData, a ReadableStream…) under key, replacing what was there.
   */
  async put(key, body, opts = {}) {
    checkKey(key);
    if (body === undefined || body === null) throw new TypeError('files.put: body is required');
    let contentType = opts?.contentType ?? (typeof body?.type === 'string' && body.type) ?? '';
    if (!contentType) contentType = 'application/octet-stream';
    if (contentTypeProblem(contentType)) throw new TypeError('files.put: invalid contentType');
    const stream = new Response(body).body;

    const used = await pageUsage(this.#pageDir);
    const budget = this.#quota - used;
    const tmpDir = path.join(this.#pageDir, 'files', 'tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.mkdir(this.#blobs, { recursive: true });
    const tmp = path.join(tmpDir, randomBytes(12).toString('hex'));
    const hash = createHash('sha256');
    let size = 0;
    try {
      await pipeline(
        stream ? Readable.fromWeb(stream) : Readable.from([]),
        async function* (source) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > budget) throw new QuotaExceededError(used, this.#quota);
            hash.update(chunk);
            yield chunk;
          }
        }.bind(this),
        createWriteStream(tmp),
      );
      // Measured again with the write on disk: concurrent puts each saw
      // the room left before any of them wrote, and the last of them to get
      // here sees every other one's bytes (in files/tmp or committed).
      const now = await pageUsage(this.#pageDir);
      if (now > this.#quota) throw new QuotaExceededError(now - size, this.#quota);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    const sha = hash.digest('hex');
    this.#pending.set(sha, (this.#pending.get(sha) ?? 0) + 1);
    try {
      return await this.#commit(key, sha, tmp, size, contentType);
    } finally {
      const n = this.#pending.get(sha) - 1;
      if (n) this.#pending.set(sha, n);
      else this.#pending.delete(sha);
    }
  }

  async #commit(key, sha, tmp, size, contentType) {
    // Same content already stored: keep the existing blob.
    try {
      await fs.link(tmp, path.join(this.#blobs, sha));
    } catch (err) {
      if (err.code !== 'EEXIST') {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      // Young again, so the runner's blob collection leaves it alone until
      // the index names it.
      const now = new Date();
      await fs.utimes(path.join(this.#blobs, sha), now, now).catch(() => {});
    }
    await fs.rm(tmp, { force: true });

    const db = this.#index();
    const old = db.prepare('SELECT sha256 FROM files WHERE key = ?').get(key)?.sha256;
    db.prepare(`INSERT INTO files (key, sha256, size, content_type, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size,
        content_type = excluded.content_type, updated_at = excluded.updated_at`)
      .run(key, sha, size, contentType, new Date().toISOString());
    if (old && old !== sha) await this.#collect(old);
    return { key, size, contentType };
  }

  /** Returns {body, size, contentType} or null when key is not stored. */
  async get(key) {
    checkKey(key);
    const row = this.#index().prepare('SELECT sha256, size, content_type FROM files WHERE key = ?').get(key);
    if (!row) return null;
    let handle;
    try {
      handle = await fs.open(path.join(this.#blobs, row.sha256));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const body = Readable.toWeb(handle.createReadStream());
    return { body, size: row.size, contentType: row.content_type };
  }

  /** Removes key. Returns whether it was stored. */
  async delete(key) {
    checkKey(key);
    const db = this.#index();
    const row = db.prepare('SELECT sha256 FROM files WHERE key = ?').get(key);
    if (!row) return false;
    db.prepare('DELETE FROM files WHERE key = ?').run(key);
    await this.#collect(row.sha256);
    return true;
  }

  /** Lists stored keys starting with prefix, sorted by key. */
  async list(prefix = '') {
    if (typeof prefix !== 'string') throw new TypeError('files.list: prefix must be a string');
    const rows = this.#index()
      .prepare(`SELECT key, size, content_type, updated_at FROM files
        WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key`)
      .all(prefix);
    return rows.map((r) => ({ key: r.key, size: r.size, contentType: r.content_type, updatedAt: r.updated_at }));
  }

  // Deletes a blob nothing names any more: neither the live index nor the
  // index of a snapshot, which must stay restorable.
  async #collect(sha) {
    if (this.#pending.has(sha)) return;
    const live = this.#index().prepare('SELECT 1 FROM files WHERE sha256 = ? LIMIT 1').get(sha);
    if (live) return;
    const snapshots = this.#snapshotsDir;
    if (!snapshots) return;
    let names = [];
    try {
      names = await fs.readdir(snapshots);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // A snapshot being written may yet name the blob: the runner's own
    // collection, after the snapshot, deletes it if not.
    if (names.some((n) => n.startsWith('.tmp-'))) return;
    for (const name of names) {
      const file = path.join(snapshots, name, 'files.sqlite');
      try {
        await fs.access(file);
      } catch {
        continue;
      }
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        if (db.prepare('SELECT 1 FROM files WHERE sha256 = ? LIMIT 1').get(sha)) return;
      } finally {
        db.close();
      }
    }
    await fs.rm(path.join(this.#blobs, sha), { force: true });
  }
}
