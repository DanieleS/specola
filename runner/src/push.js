// Realtime push, the runner's half (docs/page-backends.md, "Realtime push"
// and "Realtime push (step 4)"): a handler's ctx.publish(topic, data, {to})
// reaches the runner over the worker's IPC channel, and the runner posts it
// to specola's POST /internal/runner/publish, which fans it out to the
// page's open event streams.
//
// Publishing never blocks the handler: the worker sends and forgets, and
// the runner queues. Delivery is best effort, as the contract says: a push
// over the page's rate (50 a second) or past a full queue is dropped, and
// one specola does not take after a few retries is given up, each with a
// line in the page's backend log (at most one a second per page and kind,
// so a backend publishing in a loop cannot flood its own log).

import { RunnerError } from './errors.js';

export const TOPIC = /^[A-Za-z0-9_.:/-]{1,128}$/;
export const MAX_PUSH_DATA = 7 * 1024; // bytes of serialised JSON
const MAX_TO = 1024;

const DEFAULTS = Object.freeze({
  rate: 50, // publishes per second per page, and the bucket's size
  queueMax: 512, // pushes waiting to be sent, in all
  concurrency: 4, // posts to specola at once
  attempts: 5, // tries per push before giving up
  backoffMs: 200, // first retry delay, doubled each time
  timeoutMs: 10_000, // per post
});

/**
 * Checks a push as the worker sent it. The worker validated it already, but
 * page code can call process.send itself, so this is input. Returns the
 * reason it is invalid, or null.
 */
export function pushProblem(m) {
  if (typeof m.topic !== 'string' || !TOPIC.test(m.topic)) return 'the topic is invalid';
  if (typeof m.data !== 'string') return 'the data is not serialised JSON';
  if (Buffer.byteLength(m.data) > MAX_PUSH_DATA) return `the data is larger than ${MAX_PUSH_DATA} bytes serialised`;
  try {
    JSON.parse(m.data);
  } catch {
    return 'the data is not serialised JSON';
  }
  if (m.to !== undefined && (typeof m.to !== 'string' || m.to === '' || m.to.length > MAX_TO)) return 'to is invalid';
  return null;
}

export class Publisher {
  #queue = []; // {pageId, topic, body}
  #running = 0;
  #pages = new Map(); // pageId → {tokens, last, notes: Map<kind, {at, more}>}
  #closed = false;
  #abort = new AbortController();
  #idle = [];

  /**
   * @param {object} o
   * @param {string} o.specolaUrl
   * @param {string} o.token
   * @param {typeof fetch} [o.fetch]
   * @param {import('./log.js').Logs} o.logs
   * @param {() => number} [o.now] the rate limiter's clock (tests move it)
   * @param {Partial<typeof DEFAULTS>} [o.options]
   */
  constructor({ specolaUrl, token, fetch: f = fetch, logs, now = Date.now, options = {} }) {
    this.url = `${specolaUrl}/internal/runner/publish`;
    this.token = token;
    this.fetch = f;
    this.logs = logs;
    this.now = now;
    this.o = { ...DEFAULTS, ...options };
  }

  #page(pageId) {
    let p = this.#pages.get(pageId);
    if (!p) {
      // Pages that stopped publishing are forgotten now and then: a full
      // bucket and no pending note is the same as no entry.
      if (this.#pages.size >= 1000) this.#prune();
      p = { tokens: this.o.rate, last: this.now(), notes: new Map() };
      this.#pages.set(pageId, p);
    }
    return p;
  }

  #prune() {
    const now = this.now();
    for (const [id, p] of this.#pages) {
      if (now - p.last > 10_000 && [...p.notes.values()].every((n) => n.more === 0)) this.#pages.delete(id);
    }
  }

  // A backend log line, at most one a second per page and kind; the ones
  // held back are counted in the next.
  #note(pageId, kind, level, text) {
    const p = this.#page(pageId);
    const now = this.now();
    let n = p.notes.get(kind);
    if (!n) {
      n = { at: -Infinity, more: 0 };
      p.notes.set(kind, n);
    }
    if (now - n.at < 1000) {
      n.more++;
      return;
    }
    const more = n.more ? ` (and ${n.more} more since the last such line)` : '';
    n.at = now;
    n.more = 0;
    this.logs.append(pageId, level, text + more);
  }

  // The page's token bucket: rate tokens, refilled at rate a second.
  #take(pageId) {
    const p = this.#page(pageId);
    const now = this.now();
    p.tokens = Math.min(this.o.rate, p.tokens + ((now - p.last) * this.o.rate) / 1000);
    p.last = now;
    if (p.tokens < 1) return false;
    p.tokens -= 1;
    return true;
  }

  /**
   * Takes a push from a page's worker: {topic, data (serialised JSON), to?}.
   * Never throws, never waits.
   */
  publish(pageId, m) {
    if (this.#closed) return;
    const problem = pushProblem(m);
    if (problem) {
      this.#note(pageId, 'invalid', 'warn', `ctx.publish: a push was dropped: ${problem}`);
      return;
    }
    if (!this.#take(pageId)) {
      this.#note(pageId, 'rate', 'warn', `ctx.publish: more than ${this.o.rate} publishes a second on this page; pushes over the rate are dropped`);
      return;
    }
    if (this.#queue.length >= this.o.queueMax) {
      this.#note(pageId, 'queue', 'warn', 'ctx.publish: specola is not taking pushes fast enough; a push was dropped');
      return;
    }
    // data is spliced in as it came (checked JSON above): parsing and
    // serialising it again would change nothing but cost.
    const body =
      `{"page":${JSON.stringify(pageId)},"topic":${JSON.stringify(m.topic)},"data":${m.data}` +
      (m.to !== undefined ? `,"to":${JSON.stringify(m.to)}` : '') +
      '}';
    this.#queue.push({ pageId, topic: m.topic, body });
    this.#pump();
  }

  #pump() {
    while (!this.#closed && this.#running < this.o.concurrency && this.#queue.length) {
      const item = this.#queue.shift();
      this.#running++;
      this.#deliver(item)
        .catch(() => {})
        .finally(() => {
          this.#running--;
          this.#pump();
          if (this.#running === 0 && this.#queue.length === 0) for (const r of this.#idle.splice(0)) r();
        });
    }
  }

  async #deliver(item) {
    let why;
    for (let attempt = 1; ; attempt++) {
      if (this.#closed) return;
      let status = 0;
      try {
        const res = await this.fetch(this.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
          body: item.body,
          signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(this.o.timeoutMs)]),
        });
        status = res.status;
        const text = await res.text().catch(() => '');
        if (status >= 200 && status < 300) return;
        why = `specola answered ${status}${describe(text)}`;
      } catch (err) {
        if (this.#closed) return;
        why = `specola could not be reached (${err.cause?.code ?? err.cause?.message ?? err.message})`;
      }
      // Only what may pass on a second try is retried: specola or the
      // network failing, or specola busy. A refusal (an unknown page, a
      // push too large) would be refused again.
      const retry = status === 0 || status === 408 || status === 429 || status >= 500;
      if (!retry || attempt >= this.o.attempts) {
        this.#note(item.pageId, retry ? 'failed' : 'refused', 'error', `ctx.publish to ${JSON.stringify(item.topic)}: not delivered: ${why}`);
        return;
      }
      await sleep(this.o.backoffMs * 2 ** (attempt - 1), this.#abort.signal);
    }
  }

  /** Resolves once nothing is queued or being sent (tests). */
  idle() {
    if (this.#running === 0 && this.#queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.#idle.push(r));
  }

  /** Drops what is pending and stops (shutdown). */
  close() {
    this.#closed = true;
    this.#queue.length = 0;
    this.#abort.abort(new RunnerError(503, 'backend-unavailable', 'The runner is shutting down.'));
    for (const r of this.#idle.splice(0)) r();
  }
}

// The message of a specola error body ({"error","message"}), for the log.
function describe(text) {
  try {
    const e = JSON.parse(text);
    if (e && typeof e.error === 'string') return ` ${e.error}${typeof e.message === 'string' ? `: ${e.message}` : ''}`;
  } catch {
    // not JSON
  }
  return '';
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
