// The viewer's half of specola.storage (internal/server/pagesdk.js). The page
// runs on an opaque origin and cannot call the API, so it asks the viewer, as
// the signed-in user, over a MessagePort handed to it on its first hello.
// A numbered version is cached for a year with the SDK it was served with, so
// this side must keep answering older SDKs: extend the protocol, don't change it.

import { api } from "./api";

type Call = { id: number; op: "load" | "set" | "remove" | "clear"; key?: string; value?: string };

/**
 * Serves the data of page id to the document in frame until the returned
 * function is called. Only the first document to say hello gets a port: a
 * later one is the frame navigated elsewhere (or the page reloading itself),
 * which must not reach the data. Serve again after changing the frame's src.
 */
export function serveStorage(frame: HTMLIFrameElement, id: string): () => void {
  let port: MessagePort | null = null;
  // Writes go to the server one at a time, in the order the page made them.
  let writes: Promise<unknown> = Promise.resolve();

  function run(c: Call): Promise<unknown> {
    if (c.op === "load") return api.pageData(id);
    const write = () => {
      if (c.op === "clear") return api.clearPageData(id);
      if (typeof c.key !== "string") throw new Error("key is required");
      if (c.op === "remove") return api.updatePageData(id, { remove: [c.key] });
      return api.updatePageData(id, { set: { [c.key]: String(c.value) } });
    };
    const done = writes.then(write);
    writes = done.catch(() => {});
    return done;
  }

  function onMessage(e: MessageEvent) {
    if (e.source !== frame.contentWindow || e.data?.specola !== "hello") return;
    const page = e.source as Window;
    if (port) {
      page.postMessage({ specola: "refused", error: "specola.storage is unavailable after the page navigated; reopen it from Specola" }, "*");
      return;
    }
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = (m: MessageEvent<Call>) => {
      const c = m.data;
      run(c).then(
        (result) => port?.postMessage({ id: c.id, ok: true, result: result ?? null }),
        (err) => port?.postMessage({ id: c.id, ok: false, error: (err instanceof Error ? err.message : String(err)).trim() }),
      );
    };
    page.postMessage({ specola: "port" }, "*", [ch.port2]);
  }

  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("message", onMessage);
    port?.close();
    port = null;
  };
}
