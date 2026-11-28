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
// and stops, the work runs, and the next call starts a fresh worker. What
// it replaces is built aside and swapped in all at once (data.js, "replacing
// data"), so a failure leaves the page's data as it was or as it should be,
// never a mix.
//
// Exports, imports and "my data" downloads each hold a copy of up to a
// page's worth of data on the volume for as long as the browser takes, so
// only a few run at once, per page and in all (429 too-many-requests).

import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { entryOf } from './code.js';
import { dependenciesOf } from './deps.js';
import { SLOTS, commitSwap, exportZip, finishSwap, prepareExport, removeDb, stageImport, stageSwapImport, stageSwapRestore, swapNew, usersBytes, userHash, wipeSlots } from './data.js';
import { RunnerError } from './errors.js';
import { PageWorker } from './process.js';
import { QUERY_TIMEOUT_MS, runQuery } from './query.js';
import { blobNames, collectBlobs, eraseUserFromSnapshots, findSnapshot, keep, listSnapshots, publicSnapshot, snapshotBytes, snapshotsHolding, takeSnapshot, vacuumCopy } from './snapshot.js';
import { pageUsage } from './worker/usage.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const HASH = /^[0-9a-f]{64}$/;

export class Pages {
  #pages = new Map(); // pageId → Promise<page state>
  #transfers = 0; // running in all (see #transfer)

  /**
   * @param {object} o
   * @param {object} o.config
   * @param {import('./code.js').CodeCache} o.code
   * @param {import('./deps.js').DepsCache | null} [o.deps] installs the
   *   versions' dependencies; null: a version that has some can't run
   * @param {import('./log.js').Logs} o.logs
   * @param {() => number} [o.now] the clock of snapshots and of the daily
   *   one (tests move it)
   * @param {Promise<object>|object|null} [o.egress] the egress proxy
   *   (egress.js), or a promise of it while it starts
   * @param {import('./push.js').Publisher} [o.publisher] where ctx.publish goes
   */
  constructor({ config, code, deps = null, logs, now = Date.now, egress = null, publisher = null }) {
    this.config = config;
    this.code = code;
    this.deps = deps;
    this.logs = logs;
    this.now = now;
    this.egress = egress;
    this.publisher = publisher;
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

  /** Where a restore, import or wipe builds the data it swaps in (data.js). */
  swapDir(id) {
    return path.join(this.config.dataDir, 'swap', id);
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
      // The data was restored for a version specola had made current and the
      // runner had not run yet (restoring a version with its data): that
      // version, until it runs. The data is not the state the running
      // version left (see #switch), and the versions before it no longer
      // run.
      restoredFor: null,
      // A committed swap that could not be finished (finishSwap): finished
      // before the page runs again.
      swapPending: false,
      // "Delete my data", per user who asked (see deleteMyData):
      // {user: sha256 of the sub, snapshots: ids of the snapshots that held
      // the user's database then, stage: 'live' | 'snapshots' | 'done'}.
      erased: [],
      transfers: 0,
      newestDaily: undefined, // ms of the newest daily snapshot; undefined: not looked yet
      background: Promise.resolve(),
    };
    try {
      const saved = JSON.parse(await fs.readFile(this.#statePath(id), 'utf8'));
      if (Number.isSafeInteger(saved.version)) page.version = saved.version;
      if (typeof saved.codeHash === 'string') page.codeHash = saved.codeHash;
      if (typeof saved.title === 'string') page.title = saved.title;
      if (Number.isSafeInteger(saved.restoredFor)) page.restoredFor = saved.restoredFor;
      if (Array.isArray(saved.erased)) page.erased = saved.erased.filter(validErasure);
    } catch (err) {
      if (err.code !== 'ENOENT') this.logs.append(id, 'warn', `runner state for this page is unreadable (${err.message}); starting afresh`);
    }
    // A restore, import or wipe the previous process died in: finished if
    // it had committed, dropped if not. Before anything uses the data.
    try {
      if (await finishSwap(this.pageDir(id), this.swapDir(id))) {
        this.logs.append(id, 'warn', 'finished replacing the data, which the runner stopped in the middle of');
      }
    } catch (err) {
      page.swapPending = true;
      this.logs.append(id, 'error', `replacing the data, which the runner stopped in the middle of, failed again: ${err.message}`);
    }
    // A "delete my data" the previous process died in (or that failed):
    // finished before anything can read the data, or restore it.
    if (page.erased.some((e) => e.stage !== 'done')) {
      try {
        await this.#finishErasures(page);
        this.logs.append(id, 'warn', 'finished deleting a user\'s data, which the runner stopped in the middle of');
      } catch (err) {
        this.logs.append(id, 'error', `deleting a user's data, which the runner stopped in the middle of, failed again: ${err.message}`);
      }
    }
    return page;
  }

  async #save(page) {
    const file = this.#statePath(page.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(
      tmp,
      JSON.stringify({ version: page.version, codeHash: page.codeHash, title: page.title, restoredFor: page.restoredFor, ...(page.erased.length ? { erased: page.erased } : {}) }),
    );
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
    try {
      const got = await this.#acquire(inv, () => gone || res.destroyed);
      if (!got) return;
      got.worker.handle(inv, req, res);
      res.once('close', () => this.#afterCall(got.page));
    } finally {
      res.off('close', onClose);
    }
  }

  /**
   * Runs one /scheduled (inv carries the event) → {status, ref?}. The same
   * rules as a call: it waits for a maintenance, an older version is
   * superseded, a newer one switches, and it counts as the page's activity
   * (the worker's idle time, the daily snapshot). Throws a RunnerError when
   * it cannot be taken.
   */
  async scheduled(inv) {
    const { page, worker } = await this.#acquire(inv, () => false);
    try {
      return await worker.runJob(inv);
    } finally {
      this.#afterCall(page);
    }
  }

  // The worker that runs inv's version, started if need be: after any
  // maintenance in progress, and after the version switch when inv is for
  // a newer version. Null when the caller went away (isGone) meanwhile.
  async #acquire(inv, isGone) {
    const deadline = Date.now() + this.limits.firstByteMs;
    for (;;) {
      const page = await this.#page(inv.page.id);
      if (page.offline) {
        await waitOnline(page, deadline);
        if (isGone()) return null;
        continue; // a purge replaced the page's state: look again
      }
      // Cheap refusal first: no need to fetch code that will not run.
      refuseOld(page, inv.page.version);
      const codeDir = await this.code.ensure(inv.versionId, inv.codeHash);
      // Outside the lock: an install can take minutes, and needs no data.
      const deps = await this.#depsFor(page.id, codeDir, deadline);
      if (isGone()) return null;
      // Inside the lock, a maintenance that started meanwhile wins.
      const worker = await this.#locked(page, () => (page.offline || page.purged ? null : this.#workerFor(page, inv, codeDir, deps)));
      if (!worker) continue;
      if (isGone()) return null;
      page.title = inv.page.title;
      return { page, worker };
    }
  }

  // The version's dependencies, installed: {dir, names}, or null when it
  // has none. A call doesn't wait for an install longer than it may wait
  // for its first byte: it answers 503 and the install goes on, for the
  // next call.
  async #depsFor(pageId, codeDir, deadline) {
    const deps = await dependenciesOf(codeDir);
    const names = Object.keys(deps);
    if (names.length === 0) return null;
    if (!this.deps) throw new RunnerError(500, 'backend-error', 'This runner does not install backend dependencies.');
    const install = this.deps.ensure(deps, (level, text) => this.logs.append(pageId, level, text));
    install.catch(() => {}); // reported to the call that waits for it, or to the next
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), null);
    });
    try {
      const dir = await Promise.race([install, late]);
      if (dir === null) {
        throw new RunnerError(503, 'backend-unavailable', 'The backend\'s dependencies are being installed; retry in a few seconds.');
      }
      return { dir, names };
    } finally {
      clearTimeout(timer);
    }
  }

  async #workerFor(page, inv, codeDir, deps = null) {
    const v = inv.page.version;
    refuseOld(page, v);
    if (page.swapPending) {
      try {
        await finishSwap(this.pageDir(page.id), this.swapDir(page.id));
        page.swapPending = false;
      } catch (err) {
        this.logs.append(page.id, 'error', `replacing the data failed midway and can't be finished: ${err.message}`);
        throw new RunnerError(503, 'backend-unavailable', 'The page\'s data is being repaired; retry in a moment.');
      }
    }
    if (page.version === null || v > page.version) {
      if (page.version !== null) await this.#switch(page, v);
      page.version = v;
      page.codeHash = inv.codeHash;
      page.title = inv.page.title;
      page.restoredFor = null;
      await this.#save(page);
    }
    if (page.worker && !page.worker.gone) return page.worker;
    const entry = await entryOf(codeDir);
    const worker = new PageWorker({
      page: { ...inv.page },
      codeDir,
      entry,
      deps,
      pageDir: this.pageDir(page.id),
      snapshotsDir: this.snapshotsDir(page.id),
      limits: this.limits,
      logs: this.logs,
      onGone: (w) => {
        if (page.worker === w) page.worker = null;
        page.draining.delete(w);
      },
      proxy: await this.egress,
      // A version's egress list and secrets never change: those of the
      // call that starts the worker are those of every call it takes.
      egress: inv.egress,
      secretNames: await declaredSecretNames(codeDir),
      onPublish: (pageId, m) => this.publisher?.publish(pageId, m),
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
    if (page.restoredFor !== null) {
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
    // A snapshot id the erasures name and that is gone could be taken again
    // now, by a snapshot that holds data a user made after deleting theirs.
    await this.#pruneErased(page);
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
        // A swap that committed and failed to finish: the next call tries
        // again before it runs.
        if (await exists(path.join(this.swapDir(id), 'journal.json'))) page.swapPending = true;
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

  // Replaces `slots` of the page's data (the page is offline) with what
  // stage(swapDir) builds in swapNew(swapDir): all of them or, when
  // anything fails before the commit, none.
  async #replace(id, slots, stage) {
    const dir = this.swapDir(id);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(swapNew(dir), { recursive: true });
    try {
      await stage(dir);
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true });
      throw err;
    }
    await commitSwap(this.pageDir(id), dir, slots);
  }

  // Retention again after a restore, import or wipe, sparing the snapshot
  // taken before it (which is how it is undone): the blobs the operation
  // left to snapshots alone now count against their budget.
  async #afterReplace(id, before) {
    await keep(this.snapshotsDir(id), this.limits, [before.id], this.pageDir(id));
    await collectBlobs(this.pageDir(id), this.snapshotsDir(id));
  }

  // Runs a transfer (an export, an import, a "my data" download), if one
  // more fits: each holds a copy of up to a page's data while it streams.
  async #transfer(page, fn) {
    if (page.transfers >= this.limits.transfersPerPage || this.#transfers >= this.limits.transfersMax) {
      throw new RunnerError(429, 'too-many-requests', 'Too many exports, imports and downloads of data are running; retry in a moment.');
    }
    page.transfers++;
    this.#transfers++;
    try {
      return await fn();
    } finally {
      page.transfers--;
      this.#transfers--;
    }
  }

  // --- the data routes --------------------------------------------------------

  /** GET /pages/{id}/data. */
  async data(id) {
    await this.#page(id); // finishes a "delete my data" a restart cut first
    const snapshots = await listSnapshots(this.snapshotsDir(id));
    return {
      usage: {
        // The quotas' own measures (worker/usage.mjs): everything under the
        // page's directory but the blobs only snapshots keep, which count
        // with the snapshots.
        pageBytes: await pageUsage(this.pageDir(id), this.snapshotsDir(id)),
        pageLimit: this.limits.pageDiskBytes,
        snapshotBytes: await snapshotBytes(this.pageDir(id), this.snapshotsDir(id), snapshots),
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

  /**
   * POST /pages/{id}/snapshots/{sid}/restore → {before}. current is the
   * version specola has current (X-Specola-Version), if it said: when the
   * runner has not run it yet, the data is restored for it (a version
   * restored with its data), see #switch.
   */
  async restore(id, sid, current = null) {
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
      // The users who deleted their data after this snapshot was taken:
      // their databases were removed from it then, and any copy that
      // survived stays out. Only this snapshot's own erasures count: data a
      // user made after deleting theirs is in later snapshots, which come
      // back whole.
      const skip = new Set(page.erased.filter((e) => e.snapshots.includes(sid)).map((e) => `${e.user}.sqlite`));
      await this.#replace(id, SLOTS, (dir) => stageSwapRestore(s.dir, dir, skip));
      const restoredFor = current !== null && page.version !== null && current > page.version ? current : null;
      if (restoredFor !== page.restoredFor) {
        page.restoredFor = restoredFor;
        await this.#save(page);
      }
      // The restored snapshot was spared while the before-restore one was
      // taken; now retention applies to it like to any other.
      await this.#afterReplace(id, before);
      this.logs.append(id, 'info', `data restored from snapshot ${sid} (the data before it is in ${before.id})`);
      return { before: publicSnapshot(before) };
    });
  }

  /** POST /pages/{id}/wipe → {before}. scope: "shared" or "users". */
  async wipe(id, scope) {
    return this.#maintain(id, 'a wipe', async (page) => {
      const before = await this.#snapshot(page, { kind: 'before-wipe' });
      await this.#replace(id, wipeSlots(scope), async () => {});
      if (scope === 'shared') await fs.rm(path.join(this.pageDir(id), 'files', 'tmp'), { recursive: true, force: true });
      await this.#afterReplace(id, before);
      this.logs.append(id, 'info', `${scope === 'shared' ? 'shared data and files' : 'every user\'s data'} wiped (the data before it is in ${before.id})`);
      return { before: publicSnapshot(before) };
    });
  }

  /**
   * GET /pages/{id}/export: streams the zip to res. about is the page as
   * specola knows it ({title, version}), for the manifest; what the runner
   * last saw otherwise.
   */
  async exportTo(id, res, about = {}) {
    const page = await this.#page(id);
    return this.#transfer(page, () => this.#exportTo(page, res, about));
  }

  async #exportTo(page, res, about) {
    const id = page.id;
    const pageDir = this.pageDir(id);
    // The copies sit under the page's snapshots as a .tmp- directory: the
    // blob collection (the runner's and the worker's) leaves every blob
    // alone while one exists, so the files the zip names stay until it is
    // written.
    const pin = path.join(this.snapshotsDir(id), `.tmp-export-${randomBytes(6).toString('hex')}`);
    try {
      const { shared, rows } = await this.#dataLocked(page, () => prepareExport(pageDir, pin));
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store' });
      const manifest = { id, title: about.title ?? page.title, version: about.version !== undefined ? about.version : page.version };
      const zip = exportZip({ pageDir, pin, shared, rows, page: manifest, now: this.now() });
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
    const page = await this.#page(id);
    return this.#transfer(page, () => this.#importFrom(id, req, max));
  }

  async #importFrom(id, req, max) {
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
      // The old files stay only as long as the before-import snapshot names
      // them, on the snapshots' budget: the room is the page's quota less
      // what stays, the users' databases.
      const room = this.limits.pageDiskBytes - (await usersBytes(this.pageDir(id)));
      const staged = await stageImport(zipFile, work, { room, now: this.now() });
      await fs.rm(zipFile, { force: true });
      return await this.#maintain(id, 'an import', async (page) => {
        const before = await this.#snapshot(page, { kind: 'before-import' });
        await fs.mkdir(this.pageDir(id), { recursive: true });
        await this.#replace(id, ['shared.sqlite', 'files.sqlite'], (dir) => stageSwapImport(this.pageDir(id), work, dir));
        await this.#afterReplace(id, before);
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
    return this.#transfer(page, () => this.#myDataTo(page, file, res));
  }

  async #myDataTo(page, file, res) {
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
   * DELETE /pages/{id}/my-data: the user's database, live and in every
   * snapshot of the page (docs/page-backends.md, "Details settled in
   * implementation").
   *
   * The worker may have the database open: it is told to close and delete
   * it itself (one synchronous step there, so no call reopens it in
   * between), rather than taking the whole page offline, which would hold
   * every other user's calls for as long as the slowest call in flight.
   * With the page's lock held no worker starts meanwhile; the runner then
   * deletes what is left (no worker had it).
   *
   * Concurrency: maintLock keeps it apart from restores, imports, wipes,
   * purges and other deletions; the snapshot work runs under dataLock,
   * which every snapshot is taken under, so a snapshot in progress (its
   * .tmp- directory) is finished first and is then one of the snapshots the
   * deletion rewrites, and none starts before the live database is gone.
   *
   * Crash safety: before anything is deleted, the page's state
   * (state/{pageId}.json) records the erasure: the user's hash, the
   * snapshots that hold their database, and the stage reached ('live',
   * then 'snapshots' once the live database is gone, then 'done'). Each
   * step is idempotent, so a runner that dies midway finishes the work when
   * it loads the page again (at start-up, Pages.resumeErasures, or at the
   * page's first use), before anything can read or restore its data. The
   * record names the snapshots that held the data at deletion time, not
   * the user: data the user makes afterwards (a new database, in later
   * snapshots) is never touched by a resumed erasure, nor skipped by a
   * restore. The record stays, done, for as long as one of those snapshots
   * does: a restore of one of them leaves that user's database out even if
   * a copy survived (defence in depth).
   */
  async deleteMyData(id, sub) {
    const name = userHash(sub);
    for (;;) {
      const page = await this.#page(id);
      const done = await this.#chain(page, 'maintLock', () =>
        this.#locked(page, async () => {
          // A purge ran first: this page state is gone, look again.
          if (page.purged) return false;
          for (const w of [page.worker, ...page.draining]) {
            if (w && !w.gone) await w.forgetUser(name);
          }
          await this.#dataLocked(page, async () => {
            await this.#beginErasure(page, name);
            await this.#finishErasures(page);
          });
          return true;
        }),
      );
      if (done) return;
    }
  }

  // Records the erasure of the user `name` (the caller holds dataLock): what
  // it will delete, before deleting anything.
  async #beginErasure(page, name) {
    const live = await dbExists(this.#userDbOf(page.id, name));
    const holding = (await snapshotsHolding(this.snapshotsDir(page.id), name)).map((s) => s.id);
    if (!live && holding.length === 0) return; // nothing of theirs
    const prior = page.erased.find((e) => e.user === name);
    if (prior) {
      prior.snapshots = [...new Set([...prior.snapshots, ...holding])];
      prior.stage = 'live';
    } else {
      page.erased.push({ user: name, snapshots: holding, stage: 'live' });
    }
    await this.#save(page);
  }

  // Carries every erasure not done yet to its end (the caller holds
  // dataLock, or the page is loading: nothing else touches its data).
  async #finishErasures(page) {
    const id = page.id;
    let any = false;
    for (const e of page.erased) {
      if (e.stage === 'done') continue;
      any = true;
      if (e.stage === 'live') {
        await removeDb(this.#userDbOf(id, e.user));
        e.stage = 'snapshots';
        await this.#save(page);
      }
      const snaps = (await listSnapshots(this.snapshotsDir(id))).filter((s) => e.snapshots.includes(s.id));
      const { rewritten, deleted } = await eraseUserFromSnapshots(snaps, e.user);
      e.stage = 'done';
      await this.#save(page);
      if (rewritten.length || deleted.length) {
        this.logs.append(id, 'info', `a user's data deleted from ${rewritten.length + deleted.length} snapshot(s)${deleted.length ? `; left empty and deleted: ${deleted.join(', ')}` : ''}`);
      }
    }
    if (!any) return;
    await this.#pruneErased(page);
    // Deleted snapshots may have been the newest daily one, or the last to
    // name some blobs.
    page.newestDaily = undefined;
    await collectBlobs(this.pageDir(id), this.snapshotsDir(id)).catch(() => {});
  }

  // Forgets, in the erasures, the snapshots that are gone, and the erasures
  // done whose snapshots are all gone.
  async #pruneErased(page) {
    if (page.erased.length === 0) return;
    const ids = new Set((await listSnapshots(this.snapshotsDir(page.id))).map((s) => s.id));
    let changed = false;
    const kept = [];
    for (const e of page.erased) {
      const snapshots = e.snapshots.filter((s) => ids.has(s));
      if (snapshots.length !== e.snapshots.length) changed = true;
      if (snapshots.length === 0 && e.stage === 'done') {
        changed = true;
        continue;
      }
      kept.push({ ...e, snapshots });
    }
    if (!changed) return;
    page.erased = kept;
    await this.#save(page);
  }

  #userDbOf(id, name) {
    return path.join(this.pageDir(id), 'users', `${name}.sqlite`);
  }

  /**
   * Run at start, after the sweeps: finishes the "delete my data" a
   * previous process died in, for every page that has one.
   */
  async resumeErasures() {
    let names = [];
    try {
      names = await fs.readdir(path.join(this.config.dataDir, 'state'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      let saved;
      try {
        saved = JSON.parse(await fs.readFile(path.join(this.config.dataDir, 'state', n), 'utf8'));
      } catch {
        continue; // a .tmp, or unreadable: #load says so when the page is used
      }
      if (Array.isArray(saved?.erased) && saved.erased.some((e) => validErasure(e) && e.stage !== 'done')) {
        await this.#page(n.slice(0, -'.json'.length));
      }
    }
  }

  /** DELETE /pages/{id}: everything of the page, idempotent. */
  async purge(id) {
    await this.#maintain(id, 'a purge', async (page) => {
      await fs.rm(this.pageDir(id), { recursive: true, force: true });
      await fs.rm(this.snapshotsDir(id), { recursive: true, force: true });
      await fs.rm(this.swapDir(id), { recursive: true, force: true });
      await fs.rm(this.#statePath(id), { force: true });
      page.purged = true;
      page.version = null;
      if (this.#pages.get(id) && (await this.#pages.get(id)) === page) this.#pages.delete(id);
      this.logs.delete(id);
    });
  }

  /**
   * POST /pages/{id}/query: one read-only statement on the page's shared
   * database (query.js), stopped after 5 s. 404 no-data when the page has
   * none.
   */
  async query(id, sql, params) {
    if (!(await exists(path.join(this.pageDir(id), 'shared.sqlite')))) {
      throw new RunnerError(404, 'no-data', 'This page has no shared database yet: its backend has not used ctx.db.');
    }
    return runQuery({ pageDir: this.pageDir(id), sql, params, timeoutMs: QUERY_TIMEOUT_MS });
  }

  /** Removes what a previous process left in the scratch space. */
  async sweep() {
    await fs.rm(this.tmpDir, { recursive: true, force: true });
  }

  /** Stops every worker (shutdown), and lets background work finish. */
  async stopAll() {
    const workers = [];
    const background = [];
    for (const p of this.#pages.values()) {
      const page = await p;
      background.push(page.background);
      for (const w of [page.worker, ...page.draining]) {
        if (w) {
          workers.push(w);
          w.stop('runner shutting down');
        }
      }
    }
    await Promise.all(workers.map((w) => w.exited()));
    // A daily snapshot in progress: finished rather than cut (a cut one
    // would only be swept at the next start).
    await Promise.all(background);
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

// The secret names a version's manifest declares (normalised by specola, so
// a list of names; anything else declares none).
async function declaredSecretNames(codeDir) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(codeDir, 'backend.json'), 'utf8'));
    return Array.isArray(manifest?.secrets) ? manifest.secrets.filter((n) => typeof n === 'string') : [];
  } catch {
    return []; // entryOf, just before, said what is wrong with it
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

// A database, or what is left of one (its WAL, shared memory or journal).
async function dbExists(file) {
  for (const s of ['', '-wal', '-shm', '-journal']) if (await exists(file + s)) return true;
  return false;
}

// An erasure as the page's state file has it.
function validErasure(e) {
  return (
    e && typeof e === 'object' && typeof e.user === 'string' && HASH.test(e.user) &&
    Array.isArray(e.snapshots) && e.snapshots.every((s) => typeof s === 'string') &&
    ['live', 'snapshots', 'done'].includes(e.stage)
  );
}

// Refuses a call for a version older than the one the page runs, or than
// the one its data was restored for.
function refuseOld(page, v) {
  if (page.version === null) return;
  const current = Math.max(page.version, page.restoredFor ?? 0);
  if (v < current) throw superseded(current);
}

function superseded(current) {
  return new RunnerError(409, 'superseded', `This version is no longer current: the page now runs version ${current}.`);
}

const noSnapshot = () => new RunnerError(404, 'not-found', 'There is no such snapshot.');
const noData = () => new RunnerError(404, 'no-data', 'You have no data on this page.');
const tooLarge = (max) => new RunnerError(413, 'body-too-large', `The zip is larger than ${max} bytes.`);
