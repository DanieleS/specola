// Specola's page runtime, added to every page it serves ahead of the page's own
// scripts. The page runs on an opaque origin, where localStorage,
// sessionStorage and cookies all throw. This puts working ones in their place:
//
// - localStorage keeps its data on the server, per page and per user. The
//   viewer loads the data before loading the page and passes it in
//   window.name, so reads are synchronous from the first script. Writes are
//   batched and sent to the viewer over a MessagePort it hands to the page on
//   its first hello; the viewer saves them, retrying while it can't reach the
//   server, even after the page is gone.
//   Without the data (opened raw, or after the page reloads itself) it works
//   in memory only and never writes to the server, so a page that finds
//   nothing can't overwrite what was saved.
// - sessionStorage and document.cookie work in memory, for this load only.
//
// window.specola.persistent says whether localStorage reaches the server;
// await window.specola.flush() resolves once every write so far is saved
// (waiting out the viewer being offline), and rejects if one was refused.
(() => {
  if (window.specola) return;
  const MAX_BYTES = 1 << 20;
  const MAX_KEYS = 1000;
  const MAX_KEY_BYTES = 512;
  const enc = new TextEncoder();
  const size = (s) => enc.encode(s).length;
  const blocked = (get) => {
    try {
      get();
      return false;
    } catch {
      return true;
    }
  };

  // A Storage over map. limit enforces the server's quota; onChange hears of
  // every change.
  function storage(map, limit, onChange) {
    let bytes = 0;
    map.forEach((v, k) => (bytes += size(k) + size(v)));
    const api = {
      getItem(k) {
        k = String(k);
        return map.has(k) ? map.get(k) : null;
      },
      setItem(k, v) {
        k = String(k);
        v = String(v);
        const next = bytes - (map.has(k) ? size(k) + size(map.get(k)) : 0) + size(k) + size(v);
        if (limit && (size(k) > MAX_KEY_BYTES || next > MAX_BYTES || (!map.has(k) && map.size >= MAX_KEYS))) {
          throw new DOMException(`Specola keeps up to ${MAX_KEYS} keys and 1 MB per page`, "QuotaExceededError");
        }
        bytes = next;
        map.set(k, v);
        onChange({ set: [[k, v]] });
      },
      removeItem(k) {
        k = String(k);
        if (!map.has(k)) return;
        bytes -= size(k) + size(map.get(k));
        map.delete(k);
        onChange({ remove: [k] });
      },
      clear() {
        map.clear();
        bytes = 0;
        onChange({ clear: true });
      },
      key(i) {
        const k = [...map.keys()][i >>> 0];
        return k === undefined ? null : k;
      },
      get length() {
        return map.size;
      },
    };
    // Like the real thing, keys read and write as properties too.
    const own = (p) => typeof p === "string" && !(p in api) && map.has(p);
    return new Proxy(Object.create(Storage.prototype), {
      get: (t, p) => (typeof p === "string" && p in api ? api[p] : own(p) ? map.get(p) : Reflect.get(t, p)),
      set(t, p, v) {
        if (typeof p === "string" && !(p in api)) api.setItem(p, v);
        return true;
      },
      has: (t, p) => own(p) || (typeof p === "string" && p in api) || Reflect.has(t, p),
      deleteProperty(t, p) {
        if (typeof p === "string") api.removeItem(p);
        return true;
      },
      ownKeys: () => [...map.keys()],
      getOwnPropertyDescriptor: (t, p) =>
        own(p) ? { value: map.get(p), writable: true, enumerable: true, configurable: true } : undefined,
      defineProperty(t, p, d) {
        if (typeof p === "string" && "value" in d) api.setItem(p, d.value);
        return true;
      },
    });
  }

  // The data the viewer passed, if it did.
  let seed = null;
  if (typeof window.name === "string" && window.name.startsWith("specola:")) {
    try {
      seed = JSON.parse(window.name.slice(8)).data || {};
    } catch {}
    window.name = "";
  }
  let persistent = !!seed && window.parent !== window;

  // A change is {clear, set: Map, remove: Set}; compose(a, b) is a then b.
  const change = (c) => ({ clear: !!c.clear, set: new Map(c.set || []), remove: new Set(c.remove || []) });
  function compose(a, b) {
    if (b.clear) return change({ clear: true, set: b.set });
    const c = change({ clear: a.clear, set: a.set, remove: a.remove });
    b.remove.forEach((k) => (c.set.delete(k), c.remove.add(k)));
    b.set.forEach((v, k) => (c.remove.delete(k), c.set.set(k, v)));
    return c;
  }
  const message = (c) => ({ op: "write", clear: c.clear, set: Object.fromEntries(c.set), remove: [...c.remove] });

  let port = null;
  let pending = null; // not sent yet
  let inflight = null; // sent, not acknowledged
  let timer = 0;
  let failed = null; // a refused write not yet reported by flush
  let waiters = [];

  function changed(c) {
    if (!persistent) return;
    pending = pending ? compose(pending, change(c)) : change(c);
    schedule(0);
  }
  function schedule(delay) {
    if (!timer && !inflight && port) timer = setTimeout(send, delay);
  }
  function send() {
    timer = 0;
    if (!pending) return settle();
    inflight = pending;
    pending = null;
    port.postMessage(message(inflight));
  }
  // The viewer answers once a write is saved, or refused for good.
  function reply(r) {
    inflight = null;
    if (!r.ok) {
      failed = new Error(r.error || "not saved");
      console.error("specola: localStorage change not saved:", failed.message);
    }
    if (pending) schedule(0);
    else settle();
  }
  function settle() {
    if (pending || inflight) return;
    const ws = waiters;
    waiters = [];
    const err = failed;
    if (ws.length) failed = null;
    ws.forEach((w) => (err ? w.reject(err) : w.resolve()));
  }

  if (persistent) {
    addEventListener("message", function hello(e) {
      if (e.source !== window.parent || !e.data || typeof e.data.specola !== "string") return;
      removeEventListener("message", hello);
      if (e.data.specola !== "port" || !e.ports[0]) {
        persistent = false;
        pending = null;
        console.warn("specola: localStorage is kept in memory only:", e.data.error);
        settle();
        return;
      }
      port = e.ports[0];
      port.onmessage = (m) => reply(m.data);
      schedule(0);
    });
    window.parent.postMessage({ specola: "hello", v: 1 }, "*");
    // A write made while leaving (say, in beforeunload) can't wait for a timer.
    addEventListener("pagehide", () => {
      if (port && pending) {
        port.postMessage(message(pending));
        pending = null;
      }
    });
  }

  const define = (o, name, value) => Object.defineProperty(o, name, { value, configurable: true, enumerable: true });
  if (blocked(() => window.localStorage)) {
    define(window, "localStorage", storage(new Map(Object.entries(seed || {})), true, changed));
  }
  if (blocked(() => window.sessionStorage)) {
    define(window, "sessionStorage", storage(new Map(), false, () => {}));
  }
  if (blocked(() => document.cookie)) {
    const jar = new Map();
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => [...jar].map(([k, v]) => (k ? `${k}=${v}` : v)).join("; "),
      set(s) {
        const [pair, ...attrs] = String(s).split(";");
        const eq = pair.indexOf("=");
        const k = (eq < 0 ? "" : pair.slice(0, eq)).trim();
        const v = (eq < 0 ? pair : pair.slice(eq + 1)).trim();
        const gone = attrs.some((a) => {
          const [n, x = ""] = a.split("=").map((s) => s.trim().toLowerCase());
          return (n === "max-age" && Number(x) <= 0) || (n === "expires" && Date.parse(x) <= Date.now());
        });
        if (gone) jar.delete(k);
        else jar.set(k, v);
      },
    });
  }

  define(
    window,
    "specola",
    Object.freeze({
      get persistent() {
        return persistent;
      },
      flush() {
        if (!persistent) return Promise.resolve();
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
          settle();
        });
      },
    }),
  );
})();
