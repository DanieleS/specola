// The code cache: a version's .specola/ files, fetched from specola and kept
// on disk under code/{codeHash}/ (docs/page-backends.md, "Wire formats
// (exact)"). A directory is only ever created whole (written aside, then
// renamed into place) and only when its files hash to its name, so a
// directory that exists is complete and is the code it is named after.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RunnerError } from './errors.js';
import { pathProblem } from './worker/paths.mjs';

const MAX_CODE_BYTES = 150 * 1024 * 1024; // a bundle is at most 100 MiB, base64 adds a third
const DEFAULT_ENTRY = 'server/index.mjs';

/**
 * The backend_hash of a set of files: the hex sha256 of the lines
 * "<path>\t<sha256>\n", sorted by path (byte order, as Go sorts).
 */
export function backendHash(files) {
  const lines = files
    .map((f) => ({ path: Buffer.from(f.path, 'utf8'), sha: createHash('sha256').update(f.content).digest('hex') }))
    .sort((a, b) => Buffer.compare(a.path, b.path))
    .map((f) => `${f.path.toString('utf8')}\t${f.sha}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex');
}

/** The entry file of extracted code, from its backend.json. */
export async function entryOf(codeDir) {
  let entry = DEFAULT_ENTRY;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(codeDir, 'backend.json'), 'utf8'));
    if (typeof manifest?.entry === 'string') entry = manifest.entry;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new RunnerError(500, 'backend-error', `backend.json is not valid: ${err.message}`);
  }
  if (pathProblem(entry) || !/\.(mjs|js)$/.test(entry)) {
    throw new RunnerError(500, 'backend-error', `backend.json names an invalid entry ${JSON.stringify(entry)}`);
  }
  const file = path.join(codeDir, entry);
  try {
    await fs.access(file);
  } catch {
    throw new RunnerError(500, 'backend-error', `the backend entry ${entry} is missing from the version's code`);
  }
  return file;
}

export class CodeCache {
  #inflight = new Map(); // codeHash → Promise<dir>

  /**
   * @param {{dataDir: string, specolaUrl: string, token: string, fetch?: typeof fetch}} opts
   */
  constructor({ dataDir, specolaUrl, token, fetch: f = fetch }) {
    this.root = path.join(dataDir, 'code');
    this.specolaUrl = specolaUrl;
    this.token = token;
    this.fetch = f;
  }

  dirFor(codeHash) {
    return path.join(this.root, codeHash);
  }

  /** Removes downloads a previous process left half written. */
  async sweep() {
    let names = [];
    try {
      names = await fs.readdir(this.root);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const n of names) {
      if (n.startsWith('.tmp-')) await fs.rm(path.join(this.root, n), { recursive: true, force: true });
    }
  }

  /** Returns the directory holding the code, fetching it first if needed. */
  async ensure(versionId, codeHash) {
    const dir = this.dirFor(codeHash);
    if (await exists(dir)) return dir;
    // Concurrent first requests for the same code share one download.
    let p = this.#inflight.get(codeHash);
    if (!p) {
      p = this.#download(versionId, codeHash).finally(() => this.#inflight.delete(codeHash));
      this.#inflight.set(codeHash, p);
    }
    return p;
  }

  async #download(versionId, codeHash) {
    const url = `${this.specolaUrl}/internal/runner/code/${encodeURIComponent(versionId)}`;
    let res;
    try {
      res = await this.fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    } catch (err) {
      throw new RunnerError(503, 'backend-unavailable', `fetching the backend code from specola failed: ${err.message}`);
    }
    if (res.status === 404) {
      throw new RunnerError(404, 'no-backend', 'specola has no backend code for this version');
    }
    if (!res.ok) {
      throw new RunnerError(503, 'backend-unavailable', `fetching the backend code from specola answered ${res.status}`);
    }
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_CODE_BYTES) throw new RunnerError(500, 'backend-error', 'the backend code is too large');
    let body;
    try {
      body = await res.json();
    } catch (err) {
      throw new RunnerError(503, 'backend-unavailable', `specola sent backend code that is not JSON: ${err.message}`);
    }

    const files = [];
    const seen = new Set();
    if (!Array.isArray(body?.files)) throw new RunnerError(500, 'backend-error', 'specola sent backend code without files');
    for (const f of body.files) {
      const why = pathProblem(f?.path);
      if (why) throw new RunnerError(500, 'backend-error', `backend code path ${JSON.stringify(f?.path)} ${why}`);
      if (seen.has(f.path)) throw new RunnerError(500, 'backend-error', `backend code path ${JSON.stringify(f.path)} is duplicated`);
      seen.add(f.path);
      if (typeof f.content !== 'string') throw new RunnerError(500, 'backend-error', `backend code file ${f.path} has no content`);
      files.push({ path: f.path, content: Buffer.from(f.content, 'base64') });
    }
    // Refuse code that is not what specola asked to run: a stale cache on
    // specola's side or a corrupted transfer must not run silently.
    const got = backendHash(files);
    if (got !== codeHash || body.codeHash !== codeHash) {
      throw new RunnerError(500, 'backend-error', `the backend code does not match its hash (expected ${codeHash}, files hash to ${got}, specola says ${body.codeHash})`);
    }

    await fs.mkdir(this.root, { recursive: true });
    const tmp = path.join(this.root, `.tmp-${randomBytes(8).toString('hex')}`);
    const dir = this.dirFor(codeHash);
    try {
      for (const f of files) {
        const file = path.join(tmp, f.path);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, f.content, { mode: 0o444 });
      }
      await fs.mkdir(tmp, { recursive: true }); // no files at all
      try {
        await fs.rename(tmp, dir);
      } catch (err) {
        // Someone else (an earlier runner process) put it in place first.
        if (err.code !== 'EEXIST' && err.code !== 'ENOTEMPTY') throw err;
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    return dir;
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
