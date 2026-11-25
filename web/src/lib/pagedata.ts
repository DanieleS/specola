// The viewer's half of the localStorage Specola gives pages (see
// internal/server/pagesdk.js). The page runs on an opaque origin and cannot
// call the API, so the viewer loads its data before loading it, passes it in
// the frame's name, and saves its writes, as the signed-in user, from a
// MessagePort handed to the page on its first hello. Offline, the same port
// hands a kept bundle's files to the page (see offline.svelte.ts), and it
// carries the page's calls to its backend (docs/page-backends.md, "Frame ↔
// viewer"): see relay below, and its subscriptions to what the backend
// pushes: see pushStream.
// A numbered version is cached for a year with the runtime it was served with,
// so this side must keep answering older runtimes: extend the protocol, don't
// change it.

import { api, UNAUTHORIZED_EVENT, type PushMessage } from "./api";
import { index as offlineIndex, type BundleFile } from "./offline.svelte";

type Write = { op: "write"; clear?: boolean; set?: Record<string, string>; remove?: string[] };
type Reply = { ok: true } | { ok: false; error: string };
type Fetch = { op: "fetch"; id: number; method: string; path: string; headers: [string, string][]; body?: ArrayBuffer };
type Abort = { op: "abort"; id: number };
type Sub = { op: "sub" | "unsub"; topic: string };

/** The backend of the page shown in a frame, for serveStorage to relay its calls to. */
export type Backend = {
  /** GET /api/me's backends, read when the page says hello. */
  status: () => { enabled: boolean; available: boolean };
  /** The version the frame shows, sent as X-Specola-Version. */
  version: number;
  /** The frame shows the copy kept offline: calls fail with reason "offline". */
  offline?: boolean;
  /** A call or the push stream was refused because a newer version is current. */
  onSuperseded?: () => void;
};

// The errors from Specola or the runner (X-Specola-Error) that the page gets
// as a BackendUnavailable rather than as a Response, with their reason.
const UNAVAILABLE: Record<string, string> = {
  "backend-disabled": "disabled",
  "backend-unavailable": "unavailable",
  superseded: "superseded",
};

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
 * they go to the page over the port when its hello asks for them. backend,
 * when the version shown has one, is where its specola.fetch calls go and
 * where its specola.subscribe pushes come from; the returned function also
 * aborts the calls under way and closes the push stream.
 */
export function serveStorage(
  frame: HTMLIFrameElement,
  id: string,
  saves = true,
  files?: BundleFile[],
  backend?: Backend,
): () => void {
  let port: MessagePort | null = null;
  // The backend calls under way, to abort when the page asks or goes.
  const calls = new Map<number, AbortController>();
  let gone = false;
  // The frame's push stream, opened on its first subscription.
  let push: PushStream | null = null;

  function onMessage(e: MessageEvent) {
    if (e.source !== frame.contentWindow || e.data?.specola !== "hello") return;
    const page = e.source as Window;
    if (port) {
      page.postMessage({ specola: "refused", error: "the page navigated; reopen it from Specola" }, "*");
      return;
    }
    const ch = new MessageChannel();
    const p = (port = ch.port1);
    p.onmessage = (m: MessageEvent<Write | Fetch | Abort | Sub>) => {
      const d = m.data;
      if (d?.op === "sub" || d?.op === "unsub") {
        if (gone || !backend || backend.offline || typeof d.topic !== "string") return;
        push ??= pushStream(
          (topics) => eventsURL(id, backend.version, topics),
          (topic, data) => p.postMessage({ op: "event", topic, data }),
          () => backend.onSuperseded?.(),
          () => backend.status().enabled,
        );
        if (d.op === "sub") push.sub(d.topic);
        else push.unsub(d.topic);
        return;
      }
      if (d?.op === "fetch") {
        if (!gone) void relay(p, d);
        return;
      }
      if (d?.op === "abort") {
        calls.get(d.id)?.abort();
        calls.delete(d.id);
        return;
      }
      if (d?.op !== "write") return;
      if (saves) send(id, d, (r) => p.postMessage(r));
      else p.postMessage({ ok: false, error: "this page's saved data couldn't be loaded" } satisfies Reply);
    };
    const st = backend?.status();
    page.postMessage(
      {
        specola: "port",
        backend: { enabled: !!st?.enabled, available: !!st?.available && !backend?.offline },
        ...(backend?.offline ? { offline: true } : {}),
      },
      "*",
      [ch.port2],
    );
    if (files && e.data.files) p.postMessage({ op: "files", files });
  }

  // relay makes the page's call to its backend as the signed-in user and
  // sends the answer back over p: head, the body's chunks as they come
  // (transferred, not copied), end; or an error.
  async function relay(p: MessagePort, m: Fetch) {
    const fail = (name: string, message: string, reason?: string) => p.postMessage({ op: "error", id: m.id, name, message, reason });
    if (!backend) return fail("BackendUnavailable", "this page has no backend", "disabled");
    if (backend.offline) return fail("BackendUnavailable", "offline: the page's backend can't be reached", "offline");
    const url = backendURL(id, m.path);
    if (!url) return fail("NetworkError", `not a backend path: ${m.path}`);
    if (calls.has(m.id)) return fail("NetworkError", "this request id is in use");
    const ac = new AbortController();
    calls.set(m.id, ac);
    const live = () => calls.get(m.id) === ac;
    try {
      const headers = new Headers();
      for (const [k, v] of Array.isArray(m.headers) ? m.headers : []) {
        if (/^x-specola-/i.test(k)) continue;
        try {
          headers.append(k, v);
        } catch {
          // A header fetch can't send: dropped, as a browser would.
        }
      }
      // The page's headers, listed apart: the request also carries what the
      // browser adds (the user's HTTP credentials) and what a proxy in front
      // of Specola adds, none of which may reach the page's backend.
      headers.set("X-Specola-Headers", encodeHeaders([...headers]));
      headers.set("X-Specola-Version", String(backend.version));
      const method = String(m.method || "GET").toUpperCase();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : m.body,
          credentials: "same-origin",
          cache: "no-store",
          // A redirect would be followed here, with the user's session, to
          // whatever the backend named, and the answer handed to the page.
          redirect: "manual",
          signal: ac.signal,
        });
      } catch {
        if (!live()) return;
        if (!navigator.onLine) return fail("BackendUnavailable", "offline: the page's backend can't be reached", "offline");
        return fail("NetworkError", "can't reach Specola");
      }
      if (!live()) return;
      if (res.type === "opaqueredirect") return fail("NetworkError", "the backend answered with a redirect, which Specola doesn't follow");
      const reason = UNAVAILABLE[res.headers.get("X-Specola-Error") ?? ""];
      if (reason) {
        let message = res.statusText;
        try {
          message = (await res.json()).message || message;
        } catch {
          // Not the JSON Specola sends: the status says enough.
        }
        if (reason === "superseded") backend.onSuperseded?.();
        if (live()) fail("BackendUnavailable", message, reason);
        return;
      }
      p.postMessage({ op: "head", id: m.id, status: res.status, headers: [...res.headers] });
      if (res.body) {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || !live()) break;
            const buf = whole(value);
            p.postMessage({ op: "chunk", id: m.id, data: buf }, [buf]);
          }
        } catch {
          if (live()) fail("NetworkError", "the answer was cut short");
          return;
        } finally {
          if (!live()) reader.cancel().catch(() => {});
        }
      }
      if (live()) p.postMessage({ op: "end", id: m.id });
    } finally {
      if (live()) calls.delete(m.id);
    }
  }

  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("message", onMessage);
    // The frame is going: its backend calls have no one to answer. (Its
    // last writes are still saved, see above.)
    gone = true;
    for (const ac of calls.values()) ac.abort();
    calls.clear();
    push?.close();
  };
}

/** What a frame's push stream may be asked for; see pushStream. */
export type PushStream = { sub: (topic: string) => void; unsub: (topic: string) => void; close: () => void };

/** A push topic, as ctx.publish and the event stream take it. */
export const TOPIC = /^[A-Za-z0-9_.:/-]{1,128}$/;
/** The most topics one event stream takes. */
export const MAX_TOPICS = 20;

// The event stream of a page's pushes on topics, for the version the frame shows.
export function eventsURL(id: string, version: number, topics: string[]): string {
  const q = new URLSearchParams({ v: String(version) });
  for (const t of topics) q.append("topic", t);
  return new URL(`/api/pages/${encodeURIComponent(id)}/events?${q}`, location.href).href;
}

// The stream errors that end a frame's pushes for good: asking again would
// get the same answer.
const PUSH_FINAL = new Set(["forbidden", "not-found", "no-backend", "backend-disabled", "bad-request", "not-public", "link-expired"]);

/**
 * The viewer's side of a frame's subscriptions (docs/page-backends.md,
 * "Realtime push"): one EventSource for the frame's current topic set, made
 * by url, reopened 100 ms after the set last changed (so a page subscribing
 * to several topics at start opens one stream, not several), closed when the
 * set is empty. Each event on a topic in the set goes to deliver. The stream
 * ends for good on superseded (calling onSuperseded, as a superseded call
 * does) and on forbidden. A stream that fails to open is asked about once
 * with a plain request, since EventSource can't see the status: a final
 * error ends pushes, anything else (Specola restarting, a proxy) is retried
 * with a growing delay. While the network drops, EventSource reconnects on
 * its own. enabled says whether backends are on at all: off, no stream is
 * opened. Best effort, as the SDK says: no replay.
 */
export function pushStream(
  url: (topics: string[]) => string,
  deliver: (topic: string, data: unknown) => void,
  onSuperseded?: () => void,
  enabled: () => boolean = () => true,
): PushStream {
  const topics = new Set<string>();
  let es: EventSource | null = null;
  let openFor = ""; // the topic set es was opened for, as a key
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probe: AbortController | null = null;
  let backoff = 0;
  let stopped = false;

  function changed() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(reopen, 100);
  }

  function shut() {
    es?.close();
    es = null;
    openFor = "";
    probe?.abort();
    probe = null;
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
    shut();
  }

  function reopen() {
    timer = undefined;
    if (stopped) return;
    const list = [...topics].sort();
    const key = list.join("\n");
    if ((es || probe) && key === openFor) return;
    shut();
    if (!list.length || !enabled()) return;
    openFor = key;
    const s = new EventSource(url(list));
    es = s;
    s.onopen = () => {
      if (es === s) backoff = 0;
    };
    s.addEventListener("message", (e) => {
      if (es !== s) return;
      let m: Partial<PushMessage> | null;
      try {
        m = JSON.parse((e as MessageEvent<string>).data);
      } catch {
        return;
      }
      // The stream may be one opened for an older set, still closing.
      if (typeof m?.topic === "string" && topics.has(m.topic)) deliver(m.topic, m.data);
    });
    s.addEventListener("superseded", () => {
      if (es !== s) return;
      stop();
      onSuperseded?.();
    });
    s.addEventListener("forbidden", () => {
      if (es === s) stop();
    });
    s.onerror = () => {
      // CONNECTING: the browser tries again by itself. CLOSED: it won't
      // (the answer was not a stream), and the reason is only in the status.
      if (es !== s || s.readyState !== EventSource.CLOSED) return;
      es = null;
      void refused(s.url, key);
    };
  }

  async function refused(href: string, key: string) {
    const ac = new AbortController();
    probe = ac;
    let code = "";
    let status = 0;
    try {
      const res = await fetch(href, { credentials: "same-origin", cache: "no-store", signal: ac.signal });
      status = res.status;
      code = res.headers.get("X-Specola-Error") ?? "";
      // A stream that opens this time is not read here: it is reopened.
      ac.abort();
    } catch {
      // Unreachable: retried below.
    }
    if (probe !== ac || stopped) return;
    probe = null;
    if (status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    if (code === "superseded") {
      stop();
      onSuperseded?.();
      return;
    }
    if (PUSH_FINAL.has(code) || status === 401) {
      console.warn(`specola: pushes for this page stopped: ${code || status}`);
      stop();
      return;
    }
    backoff = Math.min(Math.max(1000, backoff * 2), 60_000);
    openFor = key;
    timer = setTimeout(() => {
      openFor = "";
      reopen();
    }, backoff);
  }

  return {
    sub(topic) {
      if (stopped || !TOPIC.test(topic) || topics.has(topic)) return;
      if (topics.size >= MAX_TOPICS) {
        console.warn(`specola: a page takes at most ${MAX_TOPICS} push topics at once; ${topic} is left out`);
        return;
      }
      topics.add(topic);
      changed();
    },
    unsub(topic) {
      if (topics.delete(topic)) changed();
    },
    close: stop,
  };
}

// The URL of a page's backend path, or null when path isn't one. The path is
// normalised on a placeholder origin first, so dot segments ("/../../me")
// can't climb out of /api/pages/{id}/x into the rest of the API.
export function backendURL(id: string, path: unknown): string | null {
  if (typeof path !== "string" || path[0] !== "/") return null;
  let u: URL;
  try {
    u = new URL(path, "https://page.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "https://page.invalid") return null;
  const prefix = `/api/pages/${encodeURIComponent(id)}/x`;
  const out = new URL(prefix + u.pathname + u.search, location.href);
  return out.pathname.startsWith(prefix + "/") ? out.href : null;
}

// X-Specola-Headers: base64url of the JSON [[name, value]…].
export function encodeHeaders(h: [string, string][]): string {
  let bin = "";
  for (const b of new TextEncoder().encode(JSON.stringify(h))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A chunk's bytes as an ArrayBuffer of their own, to transfer.
function whole(v: Uint8Array): ArrayBuffer {
  if (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength && v.buffer instanceof ArrayBuffer) return v.buffer;
  return v.slice().buffer as ArrayBuffer;
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
