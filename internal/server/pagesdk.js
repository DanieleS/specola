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
// - new Worker(url) works for http(s) URLs, which an opaque origin can't start
//   a worker from: see the Worker wrapper below.
// - Shown from a blob: URL (offline), links to a fragment (<a href="#/x">)
//   still navigate: see "Fragment links" below.
// - Offline, a bundle the viewer kept runs from the files it hands over: see
//   "Offline bundles" below.
//
// window.specola.persistent says whether localStorage reaches the server;
// await window.specola.flush() resolves once every write so far is saved
// (waiting out the viewer being offline), and rejects if one was refused.
// window.specola.base is the URL a bundle's files are served under, ending in
// "/" ("" for a plain page); window.specola.basename is the path the page is
// served under, for a client-side router (<BrowserRouter basename=…>). The
// server passes both as boot, in place of SPECOLA_BOOT at the end, with
// backend: whether the page has a backend it can call.
//
// - specola.fetch(input, init) calls the page's backend: see "Backend" below.
((boot) => {
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

  // Offline, the viewer shows a kept bundle from a blob: URL and hands its
  // files over the port (see "Offline bundles" below), so the page asks for
  // them in its hello whether or not localStorage reaches the server.
  const offline = !!boot.base && location.protocol === "blob:";

  // A page with a backend reaches it over the same port (see "Backend"
  // below), so it says hello even when localStorage stays in memory.
  const framed = window.parent !== window;
  const wantsBackend = !!boot.backend && framed && !offline;
  // The backend bridge's state, used by the hello below; see "Backend".
  const PLACEHOLDER = "https://page.invalid";
  const NULL_BODY = new Set([101, 103, 204, 205, 304]);
  const BACKEND_OPS = new Set(["head", "chunk", "end", "error"]);
  class BackendUnavailable extends Error {
    constructor(reason, message) {
      super(message);
      this.name = "BackendUnavailable";
      this.reason = reason;
    }
  }
  let backendState = Object.freeze({ enabled: false, available: false });
  let viewerOffline = false;
  // "waiting" for the port, "ready", or the BackendUnavailable every call gets.
  let bridge = framed ? "waiting" : new BackendUnavailable("unavailable", "this page reaches its backend only when opened from Specola");
  let bridgeTimer = 0;
  const queued = []; // [message, transfer] made before the port came
  const calls = new Map(); // id -> {resolve, reject, method, signal, onAbort, ctrl, headed}
  let lastId = 0;


  if (persistent || offline || wantsBackend) {
    addEventListener("message", function hello(e) {
      if (e.source !== window.parent || !e.data || typeof e.data.specola !== "string") return;
      removeEventListener("message", hello);
      if (e.data.specola !== "port" || !e.ports[0]) {
        if (offline) console.error("specola: this bundle's files weren't handed over:", e.data.error);
        noBridge(e.data.error || "Specola refused this frame");
        if (!persistent) return;
        persistent = false;
        pending = null;
        console.warn("specola: localStorage is kept in memory only:", e.data.error);
        settle();
        return;
      }
      port = e.ports[0];
      port.onmessage = (m) => {
        const d = m.data;
        if (d && d.op === "files") loadOffline(d.files);
        else if (d && BACKEND_OPS.has(d.op)) backendMessage(d);
        else reply(d);
      };
      bridgeReady(e.data);
      schedule(0);
    });
    // Specola's viewer answers at once; anything else framing the page never
    // will, and calls waiting for the port must not wait forever.
    if (wantsBackend) bridgeTimer = setTimeout(() => noBridge("Specola didn't answer: open this page from Specola"), 10_000);
    window.parent.postMessage({ specola: "hello", v: 1, files: offline }, "*");
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

  // Workers. On an opaque origin, new Worker(httpUrl) throws a SecurityError
  // and a module worker can't start even from a blob: URL; a classic worker
  // from a blob: URL that calls importScripts(httpUrl) works. So an http(s)
  // URL becomes such a worker (one blob per URL), and {type: "module"} is
  // dropped for it: the Vite plugin builds a bundle's workers as classic
  // scripts, so only a worker from elsewhere gets a warning. blob: and data:
  // URLs the page made itself pass through as given.
  // A subclass, so instanceof Worker and Worker.prototype keep working.
  const NativeWorker = window.Worker;
  if (typeof NativeWorker === "function") {
    const shims = new Map();
    const shim = (href) => {
      // Offline, a worker from the bundle runs from the kept copy.
      const file = offline && files.has(strip(href)) ? strip(href) : "";
      const key = file || href;
      if (!shims.has(key)) {
        const src = workerPrelude(href, file ? { raw: Object.fromEntries(raw), loaded: Object.fromEntries(loaded) } : null);
        shims.set(key, URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      }
      return shims.get(key);
    };
    class Worker extends NativeWorker {
      constructor(url, options) {
        let u = null;
        try {
          u = new URL(url, document.baseURI);
        } catch {
          // Offline the document is a blob: URL, which nothing resolves against.
          u = offline ? bundleURL(url) : null;
        }
        if (u && (u.protocol === "http:" || u.protocol === "https:")) {
          if (options && options.type === "module") {
            if (!(boot.base && u.href.startsWith(boot.base))) {
              console.warn("specola: module workers can't run on a page's opaque origin; starting", u.href, "as a classic worker");
            }
            options = { ...options, type: "classic" };
          }
          url = shim(u.href);
        }
        super(url, options);
      }
    }
    Object.defineProperty(window, "Worker", { value: Worker, writable: true, configurable: true });
  }

  // What a worker started from href runs: a prelude, then href. The worker's
  // own location is its blob: URL, against which no relative URL resolves
  // (Vite compiles a worker's new URL(file, import.meta.url) and ?url
  // imports to new URL(file, self.location.href)): the prelude makes
  // self.location the script's real URL, and resolves relative URLs given to
  // fetch and importScripts against it. Offline (maps given), fetch and
  // importScripts of the bundle's files go to the kept copies.
  function workerPrelude(href, maps) {
    return `(() => {
  const here = new URL(${JSON.stringify(href)});
  Object.defineProperty(self, "location", { value: here, configurable: true, enumerable: true });
  const abs = (u) => { if (typeof u !== "string" && !(u instanceof URL)) return u; try { return new URL(u, here).href; } catch { return u; } };
  const m = ${JSON.stringify(maps)};
  const k = (u, map) => { if (!m) return; try { const x = new URL(String(u)); x.hash = x.search = ""; return map[x.href]; } catch {} };
  const f = self.fetch;
  self.fetch = function (i, o) {
    const r = i instanceof Request;
    if (!r) i = abs(i);
    return f.call(this, (/^(GET|HEAD)$/i.test((o && o.method) || (r ? i.method : "GET")) && k(r ? i.url : i, m && m.raw)) || i, o);
  };
  const s = self.importScripts;
  self.importScripts = (...a) => s.apply(self, a.map((u) => ((u = abs(u)), k(u, m && m.loaded) || u)));
})();
importScripts(${JSON.stringify(href)});`;
  }

  // Fragment links. Offline the page is a blob: document, where Chromium
  // refuses every fragment navigation ("Not allowed to load local resource"):
  // a click on <a href="#/route"> would do nothing, and a hash router built on
  // such links or on hashchange wouldn't route. history.pushState still works,
  // so a click on a fragment link nobody handled is done with it, with the
  // popstate and hashchange the navigation would fire (going back fires them
  // natively). Assigning location.hash can't be caught, and still fails.
  if (location.protocol === "blob:") {
    addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement);
      const href = a && a.getAttribute("href");
      if (!href || href[0] !== "#" || a.hasAttribute("download") || (a.target && a.target !== "_self")) return;
      e.preventDefault();
      const oldURL = location.href;
      const newURL = oldURL.split("#")[0] + href;
      if (newURL !== oldURL) {
        history.pushState(null, "", href);
        dispatchEvent(new PopStateEvent("popstate", { state: null }));
        dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL }));
      }
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {}
      const target = id && (document.getElementById(id) || document.getElementsByName(id)[0]);
      if (target) target.scrollIntoView();
      else if (id === "" || id.toLowerCase() === "top") scrollTo(0, 0);
    });
  }

  // Offline bundles (docs/spa-bundles.md, "Offline"). The page is a blob:
  // document, and the network is gone: the viewer hands over every file of
  // the bundle, and this serves them from blob: URLs made here, in the page's
  // own origin. A module loaded from a blob: URL can't resolve a relative
  // specifier, so JS gets its references to bundle files made absolute
  // ({base}path), and an import map sends those to the blob: URLs (cycles
  // included). So do its references to CSS files: Vite's preload helper
  // tells a lazy chunk's CSS by its URL ending in .css, and the link it adds
  // gets the blob: URL from the href setter. CSS url()s and JS references to
  // other files point at the blob: URLs directly. fetch, XMLHttpRequest,
  // workers and the src/href of elements map the files' absolute URLs (say,
  // built from specola.base) too.
  // The viewer left the index's module scripts inert (type
  // "specola-module") and its references to the bundle in data-specola-src
  // and data-specola-href; they are brought to life once all is in place.
  const files = new Map(); // absolute URL -> the file's Blob
  const raw = new Map(); // absolute URL -> blob: URL of the file as published
  const loaded = new Map(); // absolute URL -> blob: URL to load it from
  const isJS = (u) => /\.[mc]?js$/i.test(u);
  const isCSS = (u) => /\.css$/i.test(u);
  const strip = (u) => {
    const x = new URL(u);
    x.hash = x.search = "";
    return x.href;
  };
  // The absolute URL of the bundle file url names (relative to ref), or null.
  function bundleURL(url, ref = boot.base) {
    try {
      const u = strip(new URL(String(url), ref));
      return files.has(u) ? new URL(u) : null;
    } catch {
      return null;
    }
  }
  const mapped = (url, ref) => {
    const u = files.size && bundleURL(url, ref);
    return u ? loaded.get(u.href) : url;
  };
  // A quoted string that may be a path. Narrow on purpose, so a quote in a
  // regex literal or a comment can't swallow the real strings after it.
  const QUOTED = /(["'`])([\w\-.~/@+%\u0080-\uffff]+)\1/g;
  function rewriteJS(text, self) {
    return text
      .replace(QUOTED, (m, q, s) => {
        const u = bundleURL(s, self);
        return u ? q + (isJS(u.href) || isCSS(u.href) ? u.href : loaded.get(u.href)) + q : m;
      })
      .replace(/\bimport\.meta\.url\b/g, JSON.stringify(self));
  }
  function rewriteCSS(text, self) {
    return text.replace(/url\(\s*(["']?)([^"')\s]+)\1\s*\)/g, (m, q, s) => {
      const u = bundleURL(s, self);
      return u && loaded.has(u.href) ? `url(${JSON.stringify(loaded.get(u.href))})` : m;
    });
  }
  const blobURL = (text, type) => URL.createObjectURL(new Blob([text], { type }));

  async function loadOffline(list) {
    if (files.size || !Array.isArray(list)) return;
    for (const f of list) {
      const u = new URL(f.path, boot.base).href;
      files.set(u, f.blob);
      raw.set(u, URL.createObjectURL(f.blob));
    }
    const kind = (u) => (isJS(u) ? 2 : isCSS(u) ? 1 : 0);
    const all = [...files.keys()].sort((a, b) => kind(a) - kind(b));
    for (const u of all) {
      const k = kind(u);
      if (k === 0) loaded.set(u, raw.get(u));
      else {
        const text = await files.get(u).text();
        loaded.set(u, blobURL(k === 2 ? rewriteJS(text, u) : rewriteCSS(text, u), files.get(u).type));
      }
    }
    const map = document.createElement("script");
    map.type = "importmap";
    map.textContent = JSON.stringify({ imports: Object.fromEntries(all.filter(isJS).map((u) => [u, loaded.get(u)])) });
    document.head.append(map);
    for (const a of ["src", "href"]) {
      for (const el of document.querySelectorAll(`[data-specola-${a}]`)) {
        el.setAttribute(a, mapped(el.getAttribute(`data-specola-${a}`)));
        el.removeAttribute(`data-specola-${a}`);
      }
    }
    for (const old of document.querySelectorAll('script[type="specola-module"]')) {
      const s = document.createElement("script");
      s.type = "module";
      s.async = false;
      if (old.hasAttribute("src")) s.src = old.getAttribute("src");
      else s.textContent = rewriteJS(old.textContent, new URL("index.html", boot.base).href);
      old.replaceWith(s);
    }
  }

  if (offline) {
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const req = input instanceof Request;
      const method = (init && init.method) || (req ? input.method : "GET");
      const u = files.size && /^(GET|HEAD)$/i.test(method) && bundleURL(req ? input.url : input, document.baseURI);
      return nativeFetch.call(this, u ? raw.get(u.href) : input, init);
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      const u = files.size && bundleURL(url, document.baseURI);
      return open.call(this, method, u ? raw.get(u.href) : url, ...rest);
    };
    for (const [C, a] of [
      [window.HTMLImageElement, "src"],
      [window.HTMLScriptElement, "src"],
      [window.HTMLLinkElement, "href"],
      [window.HTMLSourceElement, "src"],
      [window.HTMLMediaElement, "src"],
    ]) {
      const d = C && Object.getOwnPropertyDescriptor(C.prototype, a);
      if (!d || !d.set) continue;
      Object.defineProperty(C.prototype, a, { ...d, set(v) { d.set.call(this, mapped(v, document.baseURI)); } });
    }
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      const n = String(name).toLowerCase();
      return setAttribute.call(this, name, n === "src" || n === "href" ? mapped(value, document.baseURI) : value);
    };
  }

  // Backend (docs/page-backends.md, "Transport"). specola.fetch has fetch's
  // signature and answers a real Response, but goes to the page's backend:
  // the request crosses the port to the viewer, which calls Specola as the
  // signed-in user and sends the answer back as a head, chunks of the body as
  // they arrive (so a streamed answer streams here too) and an end. Only
  // paths are accepted ("/api/x"), resolved against the backend. Request
  // bodies go whole, serialised by new Request first, so a FormData's
  // multipart boundary or a string's content type come out right.
  // Calls made before the port arrives wait for it. Without a viewer to
  // relay them (opened raw, offline, the page has no backend) they reject
  // with a BackendUnavailable error carrying a reason; so do calls the
  // viewer refuses because backends are off, or because a newer version of
  // the page has replaced this one ("superseded").
  // TODO(page-backends step 4): specola.subscribe, over the same port.
  function bridgeReady(hello) {
    clearTimeout(bridgeTimer);
    const b = hello.backend;
    viewerOffline = !!hello.offline;
    if (b && typeof b === "object") {
      backendState = Object.freeze({ enabled: !!b.enabled, available: !!b.available && !viewerOffline });
    }
    bridge = "ready";
    for (const [m, t] of queued.splice(0)) port.postMessage(m, t);
  }
  function noBridge(why) {
    clearTimeout(bridgeTimer);
    if (bridge !== "waiting") return;
    bridge = new BackendUnavailable("unavailable", String(why));
    queued.splice(0);
    for (const id of [...calls.keys()]) finish(id, bridge);
  }
  function unavailable() {
    if (!boot.backend) return new BackendUnavailable("disabled", "this page has no backend, or page backends are not enabled on this instance");
    if (offline || viewerOffline) return new BackendUnavailable("offline", "offline: the page's backend can't be reached");
    return bridge instanceof Error ? bridge : null;
  }
  function relay(m, transfer = []) {
    if (bridge === "ready") port.postMessage(m, transfer);
    else if (bridge === "waiting") queued.push([m, transfer]);
  }

  // The path a backend call goes to: "/x?y" as given, or the path of a URL
  // or Request on the page's own origin (new Request("/x") resolves there).
  function backendPath(input) {
    const bad = () => new TypeError(`specola.fetch takes a path starting with "/" (got ${String(input)})`);
    let u;
    if (typeof input === "string") {
      if (input[0] !== "/") throw bad();
      u = new URL(input, PLACEHOLDER);
      // "//host/x" or "/\\host" would name another host.
      if (u.origin !== PLACEHOLDER) throw bad();
    } else if (input instanceof URL || input instanceof Request) {
      u = new URL(input instanceof Request ? input.url : input.href);
      if (u.origin !== PLACEHOLDER && u.origin !== location.origin) throw bad();
    } else {
      throw bad();
    }
    return u.pathname + u.search;
  }

  async function backendFetch(input, init) {
    const path = backendPath(input);
    const req = new Request(input instanceof Request ? input : PLACEHOLDER + path, init);
    const { signal } = req;
    const aborted = () => signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    if (signal.aborted) throw aborted();
    let why = unavailable();
    if (why) throw why;
    const body = req.body ? await req.arrayBuffer() : null;
    if (signal.aborted) throw aborted();
    why = unavailable();
    if (why) throw why;
    return new Promise((resolve, reject) => {
      const id = ++lastId;
      const c = { resolve, reject, method: req.method, signal, ctrl: null, headed: false };
      c.onAbort = () => {
        const i = queued.findIndex(([m]) => m.id === id);
        if (i >= 0) queued.splice(i, 1);
        else if (calls.has(id)) relay({ op: "abort", id });
        finish(id, aborted());
      };
      signal.addEventListener("abort", c.onAbort, { once: true });
      calls.set(id, c);
      const m = { op: "fetch", id, method: req.method, path, headers: [...req.headers] };
      if (body) m.body = body;
      relay(m, body ? [body] : []);
    });
  }

  // finish ends call id with err (or cleanly, without), rejecting its
  // promise or erroring its body.
  function finish(id, err) {
    const c = calls.get(id);
    if (!c) return;
    calls.delete(id);
    c.signal.removeEventListener("abort", c.onAbort);
    if (!err) {
      if (c.ctrl) c.ctrl.close();
      else if (!c.headed) c.reject(new TypeError("specola.fetch: the answer ended before it began"));
    } else if (c.ctrl) {
      c.ctrl.error(err);
    } else {
      c.reject(err);
    }
  }

  function backendError(d) {
    const msg = typeof d.message === "string" && d.message ? d.message : "";
    if (d.name === "BackendUnavailable") return new BackendUnavailable(d.reason || "unavailable", msg || "the page's backend is unavailable");
    if (d.name === "AbortError") return new DOMException(msg || "The operation was aborted.", "AbortError");
    // As fetch does on a network failure.
    return new TypeError(msg || "Failed to fetch");
  }

  function backendMessage(d) {
    const c = calls.get(d.id);
    if (!c) return;
    if (d.op === "head") {
      if (c.headed) return;
      c.headed = true;
      let stream = null;
      if (!NULL_BODY.has(d.status) && c.method !== "HEAD") {
        stream = new ReadableStream({
          start: (ctrl) => void (c.ctrl = ctrl),
          // The page stopped reading: the viewer may stop too.
          cancel: () => {
            if (calls.get(d.id) !== c) return;
            calls.delete(d.id);
            c.signal.removeEventListener("abort", c.onAbort);
            relay({ op: "abort", id: d.id });
          },
        });
      }
      let res;
      try {
        res = new Response(stream, { status: d.status, headers: d.headers });
      } catch (err) {
        c.ctrl = null;
        relay({ op: "abort", id: d.id });
        finish(d.id, err);
        return;
      }
      c.resolve(res);
    } else if (d.op === "chunk") {
      if (c.ctrl && d.data instanceof ArrayBuffer) c.ctrl.enqueue(new Uint8Array(d.data));
    } else if (d.op === "end") {
      finish(d.id);
    } else if (d.op === "error") {
      finish(d.id, backendError(d));
    }
  }

  define(
    window,
    "specola",
    Object.freeze({
      base: typeof boot.base === "string" ? boot.base : "",
      basename: typeof boot.basename === "string" ? boot.basename : "",
      get persistent() {
        return persistent;
      },
      get backend() {
        return backendState;
      },
      fetch: backendFetch,
      flush() {
        if (!persistent) return Promise.resolve();
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
          settle();
        });
      },
    }),
  );
})(SPECOLA_BOOT);
