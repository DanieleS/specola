// window.specola: what Specola gives a page it serves. The page runs on an
// opaque origin, so it has no localStorage, cookies or IndexedDB; instead the
// viewer that frames it keeps data for it, reached over a MessagePort the
// viewer hands to the first page that asks after loading it.
//
// specola.storage is an async localStorage: getItem, setItem, removeItem,
// keys, clear. Values are strings. The data belongs to the user viewing the
// page, is kept on the server, and is the same on every version of the page.
// Writes apply locally at once and are rolled back if the server refuses them.
(() => {
  if (window.specola) return;
  let seq = 0;
  const calls = new Map();
  const port = new Promise((resolve, reject) => {
    if (window.parent === window) {
      reject(new Error("specola.storage works only inside the Specola viewer"));
      return;
    }
    addEventListener("message", function hello(e) {
      if (e.source !== window.parent || !e.data || typeof e.data.specola !== "string") return;
      removeEventListener("message", hello);
      if (e.data.specola !== "port" || !e.ports[0]) {
        reject(new Error(e.data.error || "specola.storage is unavailable; reopen the page from Specola"));
        return;
      }
      const p = e.ports[0];
      p.onmessage = (m) => {
        const c = calls.get(m.data.id);
        if (!c) return;
        calls.delete(m.data.id);
        if (m.data.ok) c.resolve(m.data.result);
        else c.reject(new Error(m.data.error));
      };
      resolve(p);
    });
    window.parent.postMessage({ specola: "hello", v: 1 }, "*");
  });
  port.catch(() => {});

  const call = (op, args) =>
    port.then(
      (p) =>
        new Promise((resolve, reject) => {
          const id = ++seq;
          calls.set(id, { resolve, reject });
          p.postMessage(Object.assign({ id, op }, args));
        }),
    );

  let loaded = null;
  // Loaded once, on first use; a failed load is tried again on the next call.
  const data = () =>
    (loaded ||= call("load").then(
      (d) => new Map(Object.entries(d || {})),
      (err) => {
        loaded = null;
        throw err;
      },
    ));

  // Applies a change locally, sends it, and undoes the local part if it fails
  // (leaving alone keys a later write has changed since).
  async function write(op, args, apply) {
    const undo = apply(await data());
    try {
      await call(op, args);
    } catch (err) {
      undo();
      throw err;
    }
  }

  function put(m, key, value) {
    const had = m.has(key);
    const prev = m.get(key);
    if (value === undefined) m.delete(key);
    else m.set(key, value);
    return () => {
      if (m.get(key) !== value) return;
      if (had) m.set(key, prev);
      else m.delete(key);
    };
  }

  const storage = Object.freeze({
    async getItem(key) {
      const v = (await data()).get(String(key));
      return v === undefined ? null : v;
    },
    setItem(key, value) {
      key = String(key);
      value = String(value);
      return write("set", { key, value }, (m) => put(m, key, value));
    },
    removeItem(key) {
      key = String(key);
      return write("remove", { key }, (m) => put(m, key, undefined));
    },
    async keys() {
      return [...(await data()).keys()];
    },
    clear() {
      return write("clear", {}, (m) => {
        const before = [...m];
        m.clear();
        return () => before.forEach(([k, v]) => m.has(k) || m.set(k, v));
      });
    },
  });

  Object.defineProperty(window, "specola", { value: Object.freeze({ storage }) });
})();
