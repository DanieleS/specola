// The viewer's half of the localStorage Specola gives pages (see
// internal/server/pagesdk.js). The page runs on an opaque origin and cannot
// call the API, so the viewer loads its data before loading it, passes it in
// the frame's name, and saves its writes, as the signed-in user, from a
// MessagePort handed to the page on its first hello. Offline, the same port
// hands a kept bundle's files to the page (see offline.svelte.ts).
// A numbered version is cached for a year with the runtime it was served with,
// so this side must keep answering older runtimes: extend the protocol, don't
// change it.

import { api, UNAUTHORIZED_EVENT } from "./api";
import { index as offlineIndex, type BundleFile } from "./offline.svelte";

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
  for (const { w } of outboxes.get(id) ?? []) data = apply(data, w);
  return "specola:" + JSON.stringify({ data });
}

/**
 * Takes the writes of page id from the document in frame. Only the first
 * document to say hello gets a port: a later one is the frame navigated
 * elsewhere (or the page reloading itself), which must not reach the data.
 * The returned function stops answering hellos; a port already handed out
 * keeps working until its frame is gone, so a page's last writes (say, from
 * its pagehide as it is replaced) are still saved.
 * saves is whether the frame was handed the page's data (storageName): only
 * then are its writes saved, so a page that never saw the data can't write
 * over it. files, when given, are the kept bundle shown offline in frame:
 * they go to the page over the port when its hello asks for them.
 */
export function serveStorage(frame: HTMLIFrameElement, id: string, saves = true, files?: BundleFile[]): () => void {
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
      if (m.data?.op !== "write") return;
      if (saves) send(id, m.data, (r) => p.postMessage(r));
      else p.postMessage({ ok: false, error: "this page's saved data couldn't be loaded" } satisfies Reply);
    };
    page.postMessage({ specola: "port" }, "*", [ch.port2]);
    if (files && e.data.files) p.postMessage({ op: "files", files });
  }

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

// Each page's writes not saved yet, in order. They outlive the frame that made
// them: the viewer swaps frames when going offline and back, for instance.
// They outlive the app too: they are kept in localStorage (OUTBOX_KEY, with
// the user they belong to), and resumeWrites() sends what an earlier run of
// the app left unsaved, say after a reload while offline.
const outboxes = new Map<string, { w: Write; done: (r: Reply) => void }[]>();

/** Where unsaved writes are kept; offline.clear() removes it on logout. */
export const OUTBOX_KEY = "specola:outbox";
type Kept = { owner: string; pages: Record<string, Write[]> };

function keepOutboxes() {
  const pages: Record<string, Write[]> = {};
  for (const [id, q] of outboxes) if (q.length) pages[id] = q.map((x) => x.w);
  try {
    if (Object.keys(pages).length) localStorage.setItem(OUTBOX_KEY, JSON.stringify({ owner: offlineIndex.owner, pages } satisfies Kept));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch {
    // Storage full or unavailable: the writes are still sent while the app runs.
  }
}

/**
 * Sends the writes an earlier run of the app left unsaved, if they belong to
 * the signed-in user (offline.claim has bound the offline data to them).
 * Call once the user is known, online or not: unsaved writes wait for the
 * server, and storageName folds them into the data meanwhile.
 */
export function resumeWrites() {
  let kept: Kept | null = null;
  try {
    kept = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "null");
  } catch {
    // Corrupt: nothing to resume.
  }
  if (!kept || typeof kept.pages !== "object" || kept.owner !== offlineIndex.owner || !offlineIndex.owner) {
    if (kept) keepOutboxes();
    return;
  }
  for (const [id, ws] of Object.entries(kept.pages)) {
    if (!Array.isArray(ws) || outboxes.get(id)?.length) continue;
    for (const w of ws) send(id, w, () => {});
  }
}

function send(id: string, w: Write, done: (r: Reply) => void) {
  const q = outboxes.get(id) ?? [];
  outboxes.set(id, q);
  q.push({ w, done });
  keepOutboxes();
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
      keepOutboxes();
      done({ ok: false, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    q.shift();
    keepOutboxes();
    await keptData(id, w).catch(() => {});
    done({ ok: true });
  }
  outboxes.delete(id);
}

// The service worker keeps the last GET of a page's data for offline use
// (web/sw.js), from before the page's writes of that visit: each saved
// write is applied to that copy, so the page starts from its latest data
// offline too.
async function keptData(id: string, w: Write) {
  if (!("caches" in window)) return;
  const url = new URL(`/api/pages/${id}/data`, location.href).href;
  const cache = await caches.open("specola-api");
  const hit = await cache.match(url);
  if (!hit) return;
  const data = apply(await hit.json(), w);
  const headers = new Headers(hit.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  await cache.put(url, new Response(JSON.stringify(data), { status: hit.status, statusText: hit.statusText, headers }));
}

function apply(data: Record<string, string>, w: Write): Record<string, string> {
  if (w.clear) data = {};
  for (const k of w.remove ?? []) delete data[k];
  return Object.assign(data, w.set);
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
