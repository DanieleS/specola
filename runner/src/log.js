// The backend log (docs/page-backends.md, "Observability"): per page, the
// last lines the worker printed and what the runner saw happen to it
// (starts, stops, crashes, timeouts, version switches). In memory only: it
// is for debugging what just happened, not an audit trail.

export const MAX_LINES = 1000;
const MAX_TEXT = 16 * 1024;
const LEVELS = new Set(['log', 'info', 'warn', 'error']);

export class Logs {
  #pages = new Map(); // pageId → {lines}
  // One counter for every page, seeded from the clock in microseconds rather
  // than 1, so seq keeps growing across runner restarts: a viewer polling
  // with since=<last seq> sees the new process's lines instead of nothing
  // until seq catches up. (It stays below 2^53 for centuries.)
  #seq = Date.now() * 1000;

  constructor(max = MAX_LINES) {
    this.max = max;
  }

  /** Appends a line and returns it. */
  append(pageId, level, text, ref) {
    let p = this.#pages.get(pageId);
    if (!p) {
      p = { lines: [] };
      this.#pages.set(pageId, p);
    }
    let t = String(text);
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + '… (truncated)';
    const line = {
      seq: ++this.#seq,
      time: new Date().toISOString(),
      level: LEVELS.has(level) ? level : 'log',
      text: t,
      ...(ref ? { ref: String(ref).slice(0, 64) } : {}),
    };
    p.lines.push(line);
    if (p.lines.length > this.max) p.lines.splice(0, p.lines.length - this.max);
    return line;
  }

  /** Lines with seq > since, oldest first. */
  since(pageId, since = 0) {
    const p = this.#pages.get(pageId);
    if (!p) return [];
    return p.lines.filter((l) => l.seq > since);
  }
}
