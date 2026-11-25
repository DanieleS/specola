// Pages and their workers: which version of each page runs, and the version
// switch (docs/page-backends.md, "Versions" and "Version switch"). Only the
// current version of a page runs; the runner learns which one that is from
// the invokes specola sends, and remembers it on disk (state/{pageId}.json,
// outside the page's directory, which the page's code may write) so that an
// idle stop or a restart does not forget it. Snapshots live outside it too,
// under snapshots/{pageId}/, for the same reason.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { entryOf } from './code.js';
import { RunnerError } from './errors.js';
import { PageWorker } from './process.js';
import { takeVersionSnapshot } from './snapshot.js';

export class Pages {
  #pages = new Map(); // pageId → Promise<page state>

  /**
   * @param {{config: object, code: import('./code.js').CodeCache, logs: import('./log.js').Logs}} o
   */
  constructor({ config, code, logs }) {
    this.config = config;
    this.code = code;
    this.logs = logs;
  }

  pageDir(id) {
    return path.join(this.config.dataDir, 'pages', id);
  }

  snapshotsDir(id) {
    return path.join(this.config.dataDir, 'snapshots', id);
  }

  #statePath(id) {
    return path.join(this.config.dataDir, 'state', `${id}.json`);
  }

  #page(id) {
    let p = this.#pages.get(id);
    if (!p) {
      p = this.#load(id);
      this.#pages.set(id, p);
    }
    return p;
  }

  async #load(id) {
    const page = { id, version: null, codeHash: null, worker: null, draining: new Set(), lock: Promise.resolve() };
    try {
      const saved = JSON.parse(await fs.readFile(this.#statePath(id), 'utf8'));
      if (Number.isSafeInteger(saved.version)) page.version = saved.version;
      if (typeof saved.codeHash === 'string') page.codeHash = saved.codeHash;
    } catch (err) {
      if (err.code !== 'ENOENT') this.logs.append(id, 'warn', `runner state for this page is unreadable (${err.message}); starting afresh`);
    }
    return page;
  }

  async #save(page) {
    const file = this.#statePath(page.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: page.version, codeHash: page.codeHash }));
    await fs.rename(tmp, file);
  }

  // One version decision at a time per page.
  #locked(page, fn) {
    const run = page.lock.then(fn);
    page.lock = run.catch(() => {});
    return run;
  }

  /** The version the page runs, or null if the runner has not seen it. */
  async currentVersion(id) {
    return (await this.#page(id)).version;
  }

  /** Runs one /invoke. Throws a RunnerError when it cannot be taken. */
  async invoke(inv, req, res) {
    // Fetching the code and waiting for a version switch can take a while:
    // a caller that went away meanwhile must not have its call run anyway.
    let gone = false;
    const onClose = () => {
      gone = true;
    };
    res.once('close', onClose);
    try {
      const page = await this.#page(inv.page.id);
      // Cheap refusal first: no need to fetch code that will not run.
      if (page.version !== null && inv.page.version < page.version) throw superseded(page.version);
      const codeDir = await this.code.ensure(inv.versionId, inv.codeHash);
      const worker = await this.#locked(page, () => this.#workerFor(page, inv, codeDir));
      if (gone || res.destroyed) return;
      worker.handle(inv, req, res);
    } finally {
      res.off('close', onClose);
    }
  }

  async #workerFor(page, inv, codeDir) {
    const v = inv.page.version;
    if (page.version !== null && v < page.version) throw superseded(page.version);
    if (page.version === null || v > page.version) {
      if (page.version !== null) await this.#switch(page, v);
      page.version = v;
      page.codeHash = inv.codeHash;
      await this.#save(page);
    }
    if (page.worker && !page.worker.gone) return page.worker;
    const entry = await entryOf(codeDir);
    const worker = new PageWorker({
      page: { ...inv.page },
      codeDir,
      entry,
      pageDir: this.pageDir(page.id),
      snapshotsDir: this.snapshotsDir(page.id),
      limits: this.config.limits,
      logs: this.logs,
      onGone: (w) => {
        if (page.worker === w) page.worker = null;
        page.draining.delete(w);
      },
    });
    page.worker = worker;
    worker.start();
    return worker;
  }

  // The data first, then the new code: the snapshot is the state the old
  // version left, which restoring that version can bring back.
  async #switch(page, newVersion) {
    const old = page.version;
    this.logs.append(page.id, 'info', `version switch: ${old} → ${newVersion}`);
    let snap;
    try {
      snap = await takeVersionSnapshot({
        pageDir: this.pageDir(page.id),
        snapshotsDir: this.snapshotsDir(page.id),
        oldVersion: old,
        keep: this.config.limits.versionSnapshotsKept,
        maxBytes: this.config.limits.snapshotDiskBytes,
      });
    } catch (err) {
      // Better a page that does not switch than new code on data with no
      // way back: the next request tries again.
      const ref = randomBytes(5).toString('hex');
      this.logs.append(page.id, 'error', `snapshot before switching to version ${newVersion} failed; still on version ${old}: ${err.message}`, ref);
      throw new RunnerError(500, 'backend-error', 'Switching to the new version failed.', ref);
    }
    for (const s of snap.skipped) {
      this.logs.append(page.id, 'warn', `snapshot of version ${old}'s data: left out ${s}, which is not a readable database`);
    }
    this.logs.append(page.id, 'info', snap.dir ? `snapshot of version ${old}'s data: ${path.basename(snap.dir)}` : `version ${old} left no data to snapshot`);
    if (page.worker) {
      page.draining.add(page.worker);
      page.worker.drain();
      page.worker = null;
    }
  }

  /** Stops every worker (shutdown). */
  async stopAll() {
    const workers = [];
    for (const p of this.#pages.values()) {
      const page = await p;
      for (const w of [page.worker, ...page.draining]) {
        if (w) {
          workers.push(w);
          w.stop('runner shutting down');
        }
      }
    }
    await Promise.all(workers.map((w) => w.exited()));
  }
}

function superseded(current) {
  return new RunnerError(409, 'superseded', `This version is no longer current: the page now runs version ${current}.`);
}
