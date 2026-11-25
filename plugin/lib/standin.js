// The window.specola stand-in under `vite dev`: what the Specola page SDK
// (internal/server/pagesdk.js in the Specola repository) gives a page,
// enough for an app to run against the plugin's dev backend. Storage is the
// browser's own; specola.fetch goes to the dev backend at /__specola/x/ and
// specola.subscribe listens to its ctx.publish through /__specola/events.
//
// standIn is never called here: index.js injects its source into the page
// (standInScript), so it must be self-contained browser code that uses only
// its argument and globals.

/** The dev backend's paths, as the stand-in calls them. */
export const DEV_PATHS = Object.freeze({ fetch: '/__specola/x', events: '/__specola/events' });

/**
 * Runs in the page. cfg: {backend: boolean, fetchPath, eventsPath}.
 * Returns the runtime (also set as window.specola).
 */
export function standIn(cfg) {
  class BackendUnavailable extends Error {
    constructor(reason, message) {
      super(message);
      this.name = 'BackendUnavailable';
      this.reason = reason;
    }
  }
  const backend = Object.freeze({ enabled: cfg.backend, available: cfg.backend });
  const reasons = { 'backend-disabled': 'disabled', 'backend-unavailable': 'unavailable', superseded: 'superseded' };
  const P = 'https://page.invalid';

  // The same inputs as the page SDK's specola.fetch: a path starting with
  // "/", or a URL or Request on the page's own origin.
  async function backendFetch(input, init) {
    const bad = () => new TypeError("specola.fetch takes a path starting with / (it is resolved against the page's backend), got " + String(input));
    let u;
    if (typeof input === 'string') {
      if (input[0] !== '/') throw bad();
      u = new URL(input, P);
      if (u.origin !== P) throw bad();
    } else if (input instanceof URL || (typeof Request !== 'undefined' && input instanceof Request)) {
      u = new URL(input instanceof URL ? input.href : input.url);
      if (u.origin !== P && u.origin !== (window.location && window.location.origin)) throw bad();
    } else throw bad();
    if (typeof input !== 'string' && !(input instanceof URL)) {
      init = { method: input.method, headers: input.headers, body: input.body ? await input.arrayBuffer() : undefined, signal: input.signal, ...init };
    }
    if (!backend.enabled) throw new BackendUnavailable('disabled', 'this app has no backend: add server to specola() in vite.config');
    const res = await fetch(cfg.fetchPath + u.pathname + u.search, init);
    const reason = reasons[res.headers.get('X-Specola-Error')];
    if (reason) {
      const body = await res.json().catch(() => ({}));
      throw new BackendUnavailable(reason, body.message || reason);
    }
    return res;
  }

  // specola.subscribe, as the SDK has it: onMessage(data, topic) for each
  // push on topic until unsubscribe(); subscriptions to one topic share it,
  // and one event stream carries the page's current topics, reopened
  // (debounced 100 ms) when the set changes. Best effort, as published: a
  // push while the stream is reopening is not seen.
  const TOPIC = /^[A-Za-z0-9_.:/-]{1,128}$/;
  const MAX_TOPICS = 20;
  const topics = new Map(); // topic -> Set of {onMessage}
  let source = null;
  let timer = null;
  let warned = false;

  function reopen() {
    timer = null;
    if (source) source.close();
    source = null;
    if (topics.size === 0 || typeof EventSource === 'undefined') return;
    const q = [...topics.keys()].map((t) => 'topic=' + encodeURIComponent(t)).join('&');
    source = new EventSource(cfg.eventsPath + '?' + q);
    source.addEventListener('message', (e) => {
      let d;
      try {
        d = JSON.parse(e.data);
      } catch {
        return;
      }
      deliver(d);
    });
  }

  function changed() {
    if (!backend.enabled) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(reopen, 100);
  }

  function deliver(d) {
    const subs = d && typeof d.topic === 'string' && topics.get(d.topic);
    if (!subs) return;
    for (const entry of [...subs]) {
      if (!subs.has(entry)) continue;
      try {
        entry.onMessage(d.data, d.topic);
      } catch (err) {
        if (typeof reportError === 'function') reportError(err);
        else setTimeout(() => { throw err; });
      }
    }
  }

  function subscribe(topic, onMessage) {
    if (typeof topic !== 'string' || !TOPIC.test(topic)) {
      throw new TypeError('specola.subscribe: a topic is 1 to 128 letters, digits, _, ., :, / or - (got ' + String(topic) + ')');
    }
    if (typeof onMessage !== 'function') throw new TypeError('specola.subscribe: onMessage must be a function');
    let subs = topics.get(topic);
    if (!subs) {
      if (topics.size >= MAX_TOPICS) throw new TypeError('specola.subscribe: at most ' + MAX_TOPICS + ' topics at once');
      subs = new Set();
      topics.set(topic, subs);
      if (!backend.enabled && !warned) {
        warned = true;
        console.warn('specola.subscribe: no pushes will arrive: this app has no backend');
      }
      changed();
    }
    const entry = { onMessage };
    subs.add(entry);
    let done = false;
    return function unsubscribe() {
      if (done) return;
      done = true;
      subs.delete(entry);
      if (subs.size || topics.get(topic) !== subs) return;
      topics.delete(topic);
      changed();
    };
  }

  const runtime = { base: '/', basename: '', persistent: false, flush: async () => {}, backend, fetch: backendFetch, subscribe };
  window.specola = runtime;
  return runtime;
}

/** The inline script that sets window.specola under `vite dev`, unless something already did. */
export function standInScript(hasBackend) {
  const cfg = { backend: Boolean(hasBackend), fetchPath: DEV_PATHS.fetch, eventsPath: DEV_PATHS.events };
  // "<" escaped: the script is inline in index.html.
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `if (typeof window.specola === "undefined") (${standIn.toString()})(${json});`;
}
