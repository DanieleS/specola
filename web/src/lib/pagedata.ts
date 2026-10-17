// The viewer's half of the localStorage Specola gives pages (see
// internal/server/pagesdk.js). The page runs on an opaque origin and cannot
// call the API, so the viewer loads its data before loading it, passes it in
// the frame's name, and saves its writes, as the signed-in user, from a
// MessagePort handed to the page on its first hello.
// A numbered version is cached for a year with the runtime it was served with,
// so this side must keep answering older runtimes: extend the protocol, don't
// change it.

import { api, UNAUTHORIZED_EVENT } from "./api";

type Write = { op: "write"; clear?: boolean; set?: Record<string, string>; remove?: string[] };
type Reply = { ok: true } | { ok: false; error: string };

/**
 * The frame name that hands page id's data to the next page loaded in a
 * frame, or null when the data can't be had (the page then keeps localStorage
 * in memory only, and never writes over what is saved).
 */
export async function storageName(id: string): Promise<string | null> {
  let data: Record<string, string>;
  try {
    data = await api.pageData(id);
  } catch {
    return null;
  }
  // Writes still on their way to the server are part of the data.
  for (const { w } of outboxes.get(id) ?? []) {
    if (w.clear) data = {};
    for (const k of w.remove ?? []) delete data[k];
    Object.assign(data, w.set);
  }
  return "specola:" + JSON.stringify({ data });
}

/**
 * Takes the writes of page id from the document in frame. Only the first
 * document to say hello gets a port: a later one is the frame navigated
 * elsewhere (or the page reloading itself), which must not reach the data.
 * The returned function stops answering hellos; a port already handed out
 * keeps working until its frame is gone, so a page's last writes (say, from
 * its pagehide as it is replaced) are still saved.
 */
export function serveStorage(frame: HTMLIFrameElement, id: string): () => void {
  let port: MessagePort | null = null;

  function onMessage(e: MessageEvent) {
    if (e.source !== frame.contentWindow || e.data?.specola !== "hello") return;
    const page = e.source as Window;
    if (port) {
      page.postMessage({ specola: "refused", error: "the page navigated; reopen it from Specola" }, "*");
      return;
    }
    const ch = new MessageChannel();
    const p = (port = ch.port1);
    p.onmessage = (m: MessageEvent<Write>) => {
      if (m.data?.op === "write") send(id, m.data, (r) => p.postMessage(r));
    };
    page.postMessage({ specola: "port" }, "*", [ch.port2]);
  }

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

// Each page's writes not saved yet, in order. They outlive the frame that made
// them: the viewer swaps frames when going offline and back, for instance.
const outboxes = new Map<string, { w: Write; done: (r: Reply) => void }[]>();

function send(id: string, w: Write, done: (r: Reply) => void) {
  const q = outboxes.get(id) ?? [];
  outboxes.set(id, q);
  q.push({ w, done });
  if (q.length === 1) void drain(id, q);
}

// Saves q's writes one at a time, waiting out the server being unreachable.
async function drain(id: string, q: { w: Write; done: (r: Reply) => void }[]) {
  let backoff = 0;
  while (q.length) {
    const { w, done } = q[0];
    try {
      await save(id, w);
      backoff = 0;
    } catch (err) {
      if (err instanceof Unreachable) {
        backoff = Math.min(Math.max(1000, backoff * 2), 30_000);
        await retryAfter(backoff);
        continue;
      }
      q.shift();
      done({ ok: false, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    q.shift();
    done({ ok: true });
  }
  outboxes.delete(id);
}

class Unreachable extends Error {}

// Resolves after ms, or as soon as the browser is back online.
function retryAfter(ms: number) {
  return new Promise<void>((resolve) => {
    const go = () => {
      clearTimeout(t);
      window.removeEventListener("online", go);
      resolve();
    };
    const t = setTimeout(go, ms);
    window.addEventListener("online", go);
  });
}

async function save(id: string, w: Write) {
  const body = JSON.stringify({ clear: !!w.clear, set: w.set ?? {}, remove: w.remove ?? [] });
  let res: Response;
  try {
    res = await fetch(`/api/pages/${id}/data`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "same-origin",
      // Lets the last writes out if the tab closes; browsers cap such bodies.
      keepalive: body.length < 60_000,
    });
  } catch {
    throw new Unreachable("can't reach Specola");
  }
  if (res.status >= 500) throw new Unreachable(res.statusText);
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
}
