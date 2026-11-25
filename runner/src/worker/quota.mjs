// The page's disk quota (docs/page-backends.md, "Limits": disk per page,
// SQLite + files) as it applies to its databases. The file store checks its
// own writes (files.mjs); a database can't be checked write by write, so each
// one open gets a SQLite max_page_count: its current size plus what the page
// has left. Past it, writes fail with SQLITE_FULL ("database or disk is
// full") instead of filling the runner's volume.
//
// The room left is measured when a database opens and after every call, not
// after every statement: databases written in the same moment can each take
// all of it, so the page may end a little over its quota, never without
// bound. Files the code writes with node:fs directly are not refused, only
// counted.
// This file runs inside page workers: it must only import node: modules.

import fs from 'node:fs';
import path from 'node:path';
import { formatBytes, pageUsage } from './files.mjs';

const MIN_INTERVAL_MS = 1000;

export class PageQuota {
  #pageDir;
  #limit;
  #warn;
  #free = 0;
  #dbs = new Set();
  #running = null;
  #again = false;
  #last = 0;
  #full = false;

  /**
   * @param {string} pageDir
   * @param {number} limit bytes
   * @param {(text: string) => void} warn writes to the backend log
   */
  constructor(pageDir, limit, warn) {
    this.#pageDir = pageDir;
    this.#limit = limit;
    this.#warn = warn;
  }

  /** Caps a database that just opened to the room the page has left. */
  track(db) {
    // Measured now (once per database and worker): the last measurement may
    // predate what another database wrote since.
    this.#free = Math.max(0, this.#limit - usageSync(this.#pageDir));
    this.#dbs.add(db);
    this.#cap(db);
  }

  #cap(db) {
    try {
      const size = db.prepare('PRAGMA page_size').get().page_size;
      const pages = db.prepare('PRAGMA page_count').get().page_count;
      // 0 would mean "no change" to SQLite; it never lowers below the
      // current size either.
      const max = Math.max(1, pages + Math.floor(this.#free / size));
      db.exec(`PRAGMA max_page_count = ${max}`);
    } catch {
      this.#dbs.delete(db); // closed (by the code that opened it)
    }
  }

  /**
   * Measures what the page uses and caps every open database again.
   * Concurrent calls share one measurement, at most one a second.
   */
  refresh() {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          const wait = this.#last + MIN_INTERVAL_MS - Date.now();
          if (wait > 0 && this.#last) await new Promise((r) => setTimeout(r, wait).unref());
          this.#last = Date.now();
          const used = await pageUsage(this.#pageDir);
          this.#free = Math.max(0, this.#limit - used);
          for (const db of this.#dbs) this.#cap(db);
          // SQLite stops a little short of the limit: "full" is 99% used.
          const full = this.#free <= this.#limit / 100;
          if (full && !this.#full) {
            this.#warn(`the page's data uses ${formatBytes(used)} of its ${formatBytes(this.#limit)} disk quota: writes to its databases and files fail past it`);
          }
          this.#full = full;
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }
}

// pageUsage, for a database opening in a synchronous getter (ctx.db).
function usageSync(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      total += fs.lstatSync(path.join(e.parentPath ?? e.path, e.name)).size;
    } catch {
      // deleted meanwhile
    }
  }
  return total;
}
