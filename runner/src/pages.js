// Pages and their workers: which version of each page runs, the version
// switch (docs/page-backends.md, "Versions" and "Version switch"), and the
// data lifecycle ("Data lifecycle": snapshots, restore, export, import,
// wipe, my data, purge). Only the current version of a page runs; the
// runner learns which one that is from the invokes specola sends, and
// remembers it on disk (state/{pageId}.json, outside the page's directory,
// which the page's code may write) so that an idle stop or a restart does
// not forget it. Snapshots live outside it too, under snapshots/{pageId}/,
// for the same reason.
//
// Per page, three queues, always taken in this order when nested:
//   maintLock  restore, import, wipe, purge and "delete my data", one at a time
//   lock       which worker runs: starting one, the version switch
//   dataLock   anything that copies or replaces the data: snapshots of
//              every kind, the copies an export or "my data" streams, and
//              the work of a maintenance
// A maintenance takes the page offline first: new calls wait for it (up to
// the first-byte timeout, then 503 backend-unavailable), the worker drains
// and stops, the work runs, and the next call starts a fresh worker.

import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { entryOf } from './code.js';
import { exportZip, prepareExport, removeDb, restoreFrom, stageImport, swapImport, usersBytes, userHash, wipe } from './data.js';
import { RunnerError } from './errors.js';
import { PageWorker } from './process.js';
import { blobNames, collectBlobs, findSnapshot, keep, listSnapshots, publicSnapshot, takeSnapshot, vacuumCopy } from './snapshot.js';
import { pageUsage } from './worker/files.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export class Pages {
  #pages = new Map(); // pageId → Promise<page state>

  /**
   * @param {{config: object, code: import('./code.js').CodeCache, logs: import('./log.js').Logs, now?: () => number}} o
   * now is the clock of snapshots and of the daily one (tests move it).
   */
  constructor({ config, code, logs, now = Date.now }) {
    this.config = config;
    this.code = code;
    this.logs = logs;
    this.now = now;
  }

  get limits() {
    return this.config.limits;
  }

  pageDir(id) {
    return path.join(this.config.dataDir, 'pages', id);
  }

  snapshotsDir(id) {
    return path.join(this.config.dataDir, 'snapshots', id);
  }

  /** Scratch space on the same volume (renames into place), swept at start. */
  get tmpDir() {
    return path.join(this.config.dataDir, 'tmp');
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
    const page = {
      id,
      version: null,
      codeHash: null,
      title: '',
      worker: null,
      draining: new Set(),
      lock: Promise.resolve(),
      dataLock: Promise.resolve(),
      maintLock: Promise.resolve(),
      offline: null, // {what, done} while a maintenance runs
      purged: false,
      // The data was replaced by a restore and no call has run on it since:
      // it is not the state the running version left (see #switch).
      restored: false,
      newestDaily: undefined, // ms of the newest daily snapshot; undefined: not looked yet
      background: Promise.resolve(),
    };
    try {
      const saved = JSON.parse(await fs.readFile(this.#statePath(id), 'utf8'));
      if (Number.isSafeInteger(saved.version)) page.version = saved.version;
      if (typeof saved.codeHash === 'string') page.codeHash = saved.codeHash;
      if (typeof saved.title === 'string') page.title = saved.title;
      page.restored = saved.restored === true;
    } catch (err) {
      if (err.code !== 'ENOENT') this.logs.append(id, 'warn', `runner state for this page is unreadable (${err.message}); starting afresh`);
    }
    return page;
  }

  async #save(page) {
    const file = this.#statePath(page.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: page.version, codeHash: page.codeHash, title: page.title, restored: page.restored }));
    await fs.rename(tmp, file);
  }

  // Runs fn after everything queued before on the page's `queue`.
  #chain(page, queue, fn) {
    const run = page[queue].then(fn);
    page[queue] = run.catch(() => {});
    return run;
  }

  #locked(page, fn) {
    return this.#chain(page, 'lock', fn);
  }

  #dataLocked(page, fn) {
    return this.#chain(page, 'dataLock', fn);
  }

  /** The version the page runs, or null if the runner has not seen it. */
  async currentVersion(id) {
    return (await this.#page(id)).version;
  }

  /** Resolves once the page's background work (the daily snapshot) is done. */
  async idle(id) {
    await (await this.#page(id)).background;
  }

  // --- calls ------------------------------------------------------------------

  /** Runs one /invoke. Throws a RunnerError when it cannot be taken. */
  async invoke(inv, req, res) {
    // Fetching the code, waiting for a version switch or for a maintenance
    // can take a while: a caller that went away meanwhile must not have its
    // call run anyway.
    let gone = false;
    const onClose = () => {
      gone = true;
    };
    res.once('close', onClose);
    const deadline = Date.now() + this.limits.firstByteMs;
    try {
      for (;;) {
        const page = await this.#page(inv.page.id);
        if (page.offline) {
          await waitOnline(page, deadline);
          if (gone) return;
          continue; // a purge replaced the page's state: look again
        }
        // Cheap refusal first: no need to fetch code that will not run.
        if (page.version !== null && inv.page.version < page.version) throw superseded(page.version);
        const codeDir = await this.code.ensure(inv.versionId, inv.codeHash);
        // Inside the lock, a maintenance that started meanwhile wins.
        const worker = await this.#locked(page, () => (page.offline || page.purged ? null : this.#workerFor(page, inv, codeDir)));
        if (!worker) continue;
        if (gone || res.destroyed) return;
        page.title = inv.page.title;
        worker.handle(inv, req, res);
        res.once('close', () => this.#afterCall(page));
        return;
      }
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
      page.title = inv.page.title;
      page.restored = false;
      await this.#save(page);
    } else if (page.restored) {
      // A call runs on the restored data: from now on it is this version's.
      page.restored = false;
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
      limits: this.limits,
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
    if (page.restored) {
      // Restoring a version with its data restores the data before the new
      // version's first call: that data is not what version `old` left (its
      // own is in the before-restore snapshot), so a snapshot labelled with
      // it would bring back the wrong data later.
      this.logs.append(page.id, 'info', `version ${old} left restored data it never ran on: no snapshot (its own data is in the before-restore snapshot)`);
      this.#retire(page);
      return;
    }
    let snap;
    try {
      snap = await this.#dataLocked(page, () => this.#snapshot(page, { kind: 'version', version: old }));
    } catch (err) {
      // Better a page that does not switch than new code on data with no
      // way back: the next request tries again.
      const ref = randomBytes(5).toString('hex');
      this.logs.append(page.id, 'error', `snapshot before switching to version ${newVersion} failed; still on version ${old}: ${err.message}`, ref);
      throw new RunnerError(500, 'backend-error', 'Switching to the new version failed.', ref);
    }
    this.logs.append(page.id, 'info', snap ? `snapshot of version ${old}'s data: ${snap.id}` : `version ${old} left no data to snapshot`);
    this.#retire(page);
  }

  // Lets the running worker drain: the next call starts the new version's.
  #retire(page) {
    if (page.worker) {
      page.draining.add(page.worker);
      page.worker.drain();
      page.worker = null;
    }
  }

  // Takes a snapshot (the caller holds dataLock) and logs what it left out.
  async #snapshot(page, { kind, version, label, protect }) {
    const { snapshot, skipped } = await takeSnapshot({
      pageDir: this.pageDir(page.id),
      snapshotsDir: this.snapshotsDir(page.id),
      kind,
      version,
      label,
      protect,
      now: this.now(),
      limits: this.limits,
    });
    for (const s of skipped) {
      const what = kind === 'version' ? `snapshot of version ${version}'s data` : `${kind} snapshot`;
      this.logs.append(page.id, 'warn', `${what}: left out ${s}, which is not a readable database`);
    }
    // Retention may have removed a daily one.
    page.newestDaily = kind === 'daily' && snapshot ? Date.parse(snapshot.createdAt) : undefined;
    return snapshot;
  }

  // A daily snapshot, in the background, when the newest is a day old.
  #afterCall(page) {
    if (page.offline || page.purged || page.dailyRunning) return;
    page.dailyRunning = true;
    page.background = this.#daily(page)
      .catch((err) => this.logs.append(page.id, 'error', `daily snapshot failed: ${err.message}`))
      .finally(() => {
        page.dailyRunning = false;
      });
  }

  async #daily(page) {
    if (page.newestDaily === undefined) {
      const daily = (await listSnapshots(this.snapshotsDir(page.id))).find((s) => s.kind === 'daily');
      page.newestDaily = daily ? Date.parse(daily.createdAt) : null;
    }
    if (page.newestDaily !== null && this.now() - page.newestDaily < DAY_MS) return;
    await this.#dataLocked(page, async () => {
      if (page.offline || page.purged) return;
      const snap = await this.#snapshot(page, { kind: 'daily' });
      // No data yet: nothing to take; the next call looks again.
      if (snap) this.logs.append(page.id, 'info', `daily snapshot: ${snap.id}`);
      else page.newestDaily = null;
    });
  }

  // --- maintenance ------------------------------------------------------------

  // Takes the page offline, stops its workers, runs fn(page) and brings it
  // back. `what` is for the log and for calls that give up waiting.
  async #maintain(id, what, fn) {
    const page = await this.#page(id);
    return this.#chain(page, 'maintLock', async () => {
      let release;
      page.offline = { what, done: new Promise((r) => (release = r)) };
      try {
        await this.#locked(page, () => this.#stopWorkers(page, what));
        return await this.#dataLocked(page, () => fn(page));
      } finally {
        page.offline = null;
        page.newestDaily = undefined;
        release();
      }
    });
  }

  async #stopWorkers(page, what) {
    const workers = [page.worker, ...page.draining].filter((w) => w && !w.gone);
    page.worker = null;
    if (workers.length) this.logs.append(page.id, 'info', `page offline for ${what}: stopping its worker`);
    for (const w of workers) {
      page.draining.add(w);
      if (w.state !== 'draining') w.drain();
    }
    await Promise.all(workers.map((w) => w.exited()));
  }

  // --- the data routes --------------------------------------------------------

  /** GET /pages/{id}/data. */
  async data(id) {
    const snapshots = await listSnapshots(this.snapshotsDir(id));
    return {
      usage: {
        // The quota's own measure (worker/quota.mjs): everything under the
        // page's directory.
        pageBytes: await pageUsage(this.pageDir(id)),
        pageLimit: this.limits.pageDiskBytes,
        snapshotBytes: snapshots.reduce((n, s) => n + s.sizeBytes, 0),
        snapshotLimit: this.limits.snapshotDiskBytes,
      },
      snapshots: snapshots.map(publicSnapshot),
    };
  }

  /** POST /pages/{id}/snapshots: a manual snapshot. */
  async createSnapshot(id, label) {
    const page = await this.#page(id);
    return this.#dataLocked(page, async () => {
      const manual = (await listSnapshots(this.snapshotsDir(id))).filter((s) => s.kind === 'manual');
      if (manual.length >= this.limits.manualSnapshotsMax) {
        throw new RunnerError(409, 'too-many-snapshots', `This page already has ${manual.length} manual snapshots (the most it can keep): delete one first.`);
      }
      const snap = await this.#snapshot(page, { kind: 'manual', label, version: page.version ?? undefined });
      this.logs.append(id, 'info', `manual snapshot taken: ${snap.id} (${JSON.stringify(label)})`);
      return publicSnapshot(snap);
    });
  }

  /** DELETE /pages/{id}/snapshots/{sid}: manual ones only. */
  async deleteSnapshot(id, sid) {
    const page = await this.#page(id);
    await this.#dataLocked(page, async () => {
      const s = await findSnapshot(this.snapshotsDir(id), sid);
      if (!s) throw noSnapshot();
      if (s.kind !== 'manual') throw new RunnerError(409, 'not-manual', 'Only manual snapshots can be deleted; the others go by themselves.');
      await fs.rm(s.dir, { recursive: true, force: true });
      await collectBlobs(this.pageDir(id), this.snapshotsDir(id));
      this.logs.append(id, 'info', `manual snapshot deleted: ${sid}`);
    });
  }

  /** POST /pages/{id}/snapshots/{sid}/restore → {before}. */
  async restore(id, sid) {
    if (!(await findSnapshot(this.snapshotsDir(id), sid))) throw noSnapshot();
    return this.#maintain(id, 'a restore', async (page) => {
      const s = await findSnapshot(this.snapshotsDir(id), sid);
      if (!s) throw noSnapshot();
      // The blobs it names must be there: they are kept for as long as a
      // snapshot names them, so missing ones mean the volume was tampered
      // with. Better no restore than a file store with holes.
      const blobs = path.join(this.pageDir(id), 'files', 'blobs');
      let names = [];
      try {
        await fs.access(path.join(s.dir, 'files.sqlite'));
        names = await blobNames(path.join(s.dir, 'files.sqlite'));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const missing = [];
      for (const n of names) {
        try {
          await fs.access(path.join(blobs, n));
        } catch {
          missing.push(n);
        }
      }
      if (missing.length) {
        const ref = randomBytes(5).toString('hex');
        this.logs.append(id, 'error', `restore of ${sid} refused: the contents of ${missing.length} of its files are missing (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`, ref);
        throw new RunnerError(500, 'internal', `The snapshot cannot be restored: the contents of ${missing.length} of its files are missing.`, ref);
      }
      const before = await this.#snapshot(page, { kind: 'before-restore', protect: sid });
      await restoreFrom(this.pageDir(id), s.dir);
      page.restored = true;
      await this.#save(page);
      // Kept while the before-restore one was taken; now retention applies
      // to it like to any other.
      await keep(this.snapshotsDir(id), this.limits);
      await collectBlobs(this.pageDir(id), this.snapshotsDir(id));
      this.logs.append(id, 'info', `data restored from snapshot ${sid} (the data before it is in ${before.id})`);
      return { before: publicSnapshot(before) };
    });
  }

  /** POST /pages/{id}/wipe → {before}. scope: "shared" or "users". */
  async wipe(id, scope) {
    return this.#maintain(id, 'a wipe', async (page) => {
      const before = await this.#snapshot(page, { kind: 'before-wipe' });
      await wipe(this.pageDir(id), scope);
      await collectBlobs(this.pageDir(id), this.snapshotsDir(id));
      this.logs.append(id, 'info', `${scope === 'shared' ? 'shared data and files' : 'every user\'s data'} wiped (the data before it is in ${before.id})`);
      return { before: publicSnapshot(before) };
    });
  }

  /** GET /pages/{id}/export: streams the zip to res. */
  async exportTo(id, res) {
    const page = await this.#page(id);
    const pageDir = this.pageDir(id);
    // The copies sit under the page's snapshots as a .tmp- directory: the
    // blob collection (the runner's and the worker's) leaves every blob
    // alone while one exists, so the files the zip names stay until it is
    // written.
    const pin = path.join(this.snapshotsDir(id), `.tmp-export-${randomBytes(6).toString('hex')}`);
    try {
      const { shared, rows } = await this.#dataLocked(page, () => prepareExport(pageDir, pin));
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store' });
      const zip = exportZip({ pageDir, pin, shared, rows, page: { id, title: page.title, version: page.version }, now: this.now() });
      try {
        await pipeline(zip, res);
      } catch (err) {
        // Headers are out: the only way to say it failed is to cut it.
        if (!res.destroyed) this.logs.append(id, 'error', `export failed: ${err.message}`);
        res.destroy();
      }
    } finally {
      await fs.rm(pin, { recursive: true, force: true });
    }
  }

  /** PUT /pages/{id}/import: req is the zip → {before}. */
  async importFrom(id, req) {
    const max = this.limits.importBytes;
    if (Number(req.headers['content-length'] ?? 0) > max) throw tooLarge(max);
    await fs.mkdir(this.tmpDir, { recursive: true });
    const name = `import-${randomBytes(8).toString('hex')}`;
    const zipFile = path.join(this.tmpDir, `${name}.zip`);
    const work = path.join(this.tmpDir, name);
    try {
      let n = 0;
      await pipeline(
        req,
        async function* (src) {
          for await (const c of src) {
            n += c.length;
            if (n > max) throw tooLarge(max);
            yield c;
          }
        },
        createWriteStream(zipFile),
      );
      // Everything is checked and built aside before the page goes offline.
      const room = this.limits.pageDiskBytes - (await usersBytes(this.pageDir(id)));
      const staged = await stageImport(zipFile, work, { room, now: this.now() });
      await fs.rm(zipFile, { force: true });
      return await this.#maintain(id, 'an import', async (page) => {
        const before = await this.#snapshot(page, { kind: 'before-import' });
        await fs.mkdir(this.pageDir(id), { recursive: true });
        await swapImport(this.pageDir(id), work);
        await collectBlobs(this.pageDir(id), this.snapshotsDir(id));
        this.logs.append(id, 'info', `data imported: ${staged.shared ? 'a shared database' : 'no shared database'} and ${staged.files} file(s) (the data before it is in ${before.id})`);
        return { before: publicSnapshot(before) };
      });
    } finally {
      await fs.rm(zipFile, { force: true });
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  #userDb(id, sub) {
    return path.join(this.pageDir(id), 'users', `${userHash(sub)}.sqlite`);
  }

  /** GET /pages/{id}/my-data: streams a copy of the sub's database to res. */
  async myDataTo(id, sub, res) {
    const file = this.#userDb(id, sub);
    if (!(await exists(file))) throw noData();
    const page = await this.#page(id);
    await fs.mkdir(this.tmpDir, { recursive: true });
    const copy = path.join(this.tmpDir, `my-data-${randomBytes(8).toString('hex')}.sqlite`);
    try {
      await this.#dataLocked(page, async () => {
        if (!(await exists(file))) throw noData();
        await vacuumCopy(file, copy);
      });
      const { size } = await fs.stat(copy);
      res.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Length': size, 'Cache-Control': 'no-store' });
      await pipeline(createReadStream(copy), res).catch(() => res.destroy());
    } finally {
      await fs.rm(copy, { force: true });
    }
  }

  /**
   * DELETE /pages/{id}/my-data. The worker may have the database open: it
   * is told to close and delete it itself (one synchronous step there, so
   * no call reopens it in between), rather than taking the whole page
   * offline, which would hold every other user's calls for as long as the
   * slowest call in flight. With the page's lock held no worker starts
   * meanwhile; the runner then deletes what is left (no worker had it).
   */
  async deleteMyData(id, sub) {
    const page = await this.#page(id);
    const file = this.#userDb(id, sub);
    await this.#chain(page, 'maintLock', () =>
      this.#locked(page, async () => {
        for (const w of [page.worker, ...page.draining]) {
          if (w && !w.gone) await w.forgetUser(userHash(sub));
        }
        await removeDb(file);
      }),
    );
  }

  /** DELETE /pages/{id}: everything of the page, idempotent. */
  async purge(id) {
    await this.#maintain(id, 'a purge', async (page) => {
      await fs.rm(this.pageDir(id), { recursive: true, force: true });
      await fs.rm(this.snapshotsDir(id), { recursive: true, force: true });
      await fs.rm(this.#statePath(id), { force: true });
      page.purged = true;
      page.version = null;
      if (this.#pages.get(id) && (await this.#pages.get(id)) === page) this.#pages.delete(id);
      this.logs.delete(id);
    });
  }

  /** Removes what a previous process left in the scratch space. */
  async sweep() {
    await fs.rm(this.tmpDir, { recursive: true, force: true });
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

// Waits for a maintenance to end, until the deadline: then 503.
async function waitOnline(page, deadline) {
  const o = page.offline;
  const left = deadline - Date.now();
  let timer;
  const timedOut = await Promise.race([
    o.done.then(() => false),
    new Promise((r) => {
      timer = setTimeout(() => r(true), Math.max(0, left));
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    throw new RunnerError(503, 'backend-unavailable', `The page's backend is offline for ${o.what}; retry in a moment.`);
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

function superseded(current) {
  return new RunnerError(409, 'superseded', `This version is no longer current: the page now runs version ${current}.`);
}

const noSnapshot = () => new RunnerError(404, 'not-found', 'There is no such snapshot.');
const noData = () => new RunnerError(404, 'no-data', 'You have no data on this page.');
const tooLarge = (max) => new RunnerError(413, 'body-too-large', `The zip is larger than ${max} bytes.`);
