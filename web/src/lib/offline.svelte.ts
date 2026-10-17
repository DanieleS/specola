import { api, HttpError, type PageMeta, type Role } from "./api";

// Pages kept for offline viewing. The HTML of each kept version lives in the
// Cache Storage under a key of our own (the view URL may carry a short-lived
// token, or be on another origin); the index of what is kept, small, lives in
// localStorage.
//
// Pages land here two ways: every page opened while online is kept as a
// recent page (the last MAX_RECENT), and a page the user saves for offline is
// pinned: never evicted, and brought up to its current version each time the
// app starts online.
//
// Everything is per user: it is wiped on logout and when someone else signs
// in on this browser.

export type OfflinePage = {
  id: string;
  name: string;
  role: Role;
  /** Versions whose HTML is stored, ascending. */
  versions: number[];
  /** Kept on purpose: never evicted, synced to the current version. */
  pinned: boolean;
  updatedAt: string;
  /** Last opened or synced, for eviction. */
  usedAt: string;
};

type Index = { owner: string; pages: Record<string, OfflinePage> };

const INDEX_KEY = "specola:offline";
const PAGES = "specola-pages";
const API = "specola-api"; // the service worker's API cache
const MAX_RECENT = 30;

export const supported = typeof window !== "undefined" && "caches" in window;

export const net = $state({ online: typeof navigator === "undefined" || navigator.onLine });
if (typeof window !== "undefined") {
  addEventListener("online", () => (net.online = true));
  addEventListener("offline", () => (net.online = false));
}

function loadIndex(): Index {
  try {
    const v = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "null");
    if (v && typeof v.owner === "string" && v.pages && typeof v.pages === "object") return v;
  } catch {
    // Storage unavailable or corrupt: start empty.
  }
  return { owner: "", pages: {} };
}

/** The index, reactive so the views follow what is kept. */
export const index = $state<Index>(loadIndex());

function persist() {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Not essential: the HTML stays in the cache, only the listing is lost.
  }
}

const htmlKey = (id: string, v: number) => `/__offline/pages/${encodeURIComponent(id)}/${v}`;

/** Wipes everything kept offline: pages, the API copies and the index. */
export async function clear() {
  index.pages = {};
  index.owner = "";
  persist();
  if (supported) await Promise.all([caches.delete(PAGES), caches.delete(API)]);
}

/** Binds the offline data to the signed-in user, wiping another user's. */
export async function claim(sub: string) {
  if (index.owner === sub) return;
  if (index.owner !== "") await clear();
  index.owner = sub;
  persist();
}

/** The stored HTML of a version, or null if it isn't kept. */
export async function html(id: string, v: number): Promise<string | null> {
  if (!supported) return null;
  const hit = await caches.match(htmlKey(id, v), { cacheName: PAGES });
  return hit ? hit.text() : null;
}

// fetchHTML downloads a version from the page's view URL, which is either on
// this origin (with the session) or on the view origin (with a token).
async function fetchHTML(viewUrl: string, v: number): Promise<Response> {
  const u = new URL(viewUrl, location.href);
  u.searchParams.set("v", String(v));
  const res = await fetch(u, { credentials: u.origin === location.origin ? "same-origin" : "omit" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

/**
 * Keeps a version of a page that is being viewed online. pin also marks the
 * page as saved for offline; otherwise an existing pin is left as it is.
 */
export async function keep(meta: PageMeta, v: number, pin = false) {
  if (!supported || !index.owner) return;
  if (!index.pages[meta.id]?.versions.includes(v)) {
    const res = await fetchHTML(meta.viewUrl, v);
    const c = await caches.open(PAGES);
    await c.put(htmlKey(meta.id, v), new Response(await res.blob(), { headers: { "Content-Type": "text/html" } }));
  }
  const versions = [...new Set([...(index.pages[meta.id]?.versions ?? []), v])].sort((a, b) => a - b);
  index.pages[meta.id] = {
    id: meta.id,
    name: meta.name,
    role: meta.role,
    versions,
    pinned: pin || (index.pages[meta.id]?.pinned ?? false),
    updatedAt: meta.updatedAt,
    usedAt: new Date().toISOString(),
  };
  await evict();
  persist();
}

/**
 * Saves a page for offline (its current version). Unsaving leaves it kept as
 * a recent page, to be evicted in turn.
 */
export async function setPinned(meta: PageMeta, on: boolean) {
  if (on) {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    await keep(meta, meta.version, true);
  } else if (index.pages[meta.id]) {
    index.pages[meta.id].pinned = false;
    await evict();
    persist();
  }
}

export async function remove(id: string) {
  const p = index.pages[id];
  if (!p) return;
  delete index.pages[id];
  persist();
  if (!supported) return;
  const c = await caches.open(PAGES);
  await Promise.all(p.versions.map((v) => c.delete(htmlKey(id, v))));
}

async function evict() {
  const recent = Object.values(index.pages)
    .filter((p) => !p.pinned)
    .sort((a, b) => b.usedAt.localeCompare(a.usedAt));
  for (const p of recent.slice(MAX_RECENT)) await remove(p.id);
}

/**
 * Brings every saved page up to its current version, dropping the others, and
 * forgets pages the user can no longer see. Run when the app starts online.
 */
export async function sync() {
  if (!supported) return;
  for (const p of Object.values(index.pages).filter((p) => p.pinned)) {
    try {
      const meta = await api.pageMeta(p.id);
      if (meta.offline) return; // the network went away
      await keep(meta, meta.version);
      const stale = index.pages[p.id].versions.filter((v) => v !== meta.version);
      if (stale.length) {
        const c = await caches.open(PAGES);
        await Promise.all(stale.map((v) => c.delete(htmlKey(p.id, v))));
        index.pages[p.id].versions = [meta.version];
        persist();
      }
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 403)) await remove(p.id);
    }
  }
}
