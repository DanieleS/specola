import { api, HttpError, type PageMeta, type Role, type VersionFiles } from "./api";

// Pages kept for offline viewing. The HTML of each kept version lives in the
// Cache Storage under a key of our own (the view URL may carry a short-lived
// token, or be on another origin); the index of what is kept, small, lives in
// localStorage.
//
// A bundle version (docs/spa-bundles.md) is kept whole: its index.html, the
// list of its files and every file, so it can run offline (see bundle()).
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
  /** Those of versions that are bundles, kept with all their files. */
  bundles?: number[];
  /** What each kept version takes up, files included, for eviction. */
  sizes?: Record<number, number>;
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
// Recent pages also give way once they take more than this together: one
// bundle may be as large as 100 MiB.
const MAX_RECENT_BYTES = 256 << 20;
// Bundle files downloaded at once.
const PARALLEL = 6;

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
// A bundle version's list of files, and its files, are under its HTML's key.
const filesKey = (id: string, v: number) => `${htmlKey(id, v)}/files`;
const fileKey = (id: string, v: number, path: string) =>
  `${htmlKey(id, v)}/file/${path.split("/").map(encodeURIComponent).join("/")}`;

/** A kept bundle version's files, as listed by GET …/versions/{v}/files. */
type Manifest = Pick<VersionFiles, "base" | "files">;

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
// A bundle's HTML skips the browser's cache, which keeps a numbered version
// for good with the SDK it was first served with: running offline needs a
// current one.
async function fetchHTML(viewUrl: string, v: number, bundle = false): Promise<Response> {
  const u = new URL(viewUrl, location.href);
  u.searchParams.set("v", String(v));
  const res = await fetch(u, {
    credentials: u.origin === location.origin ? "same-origin" : "omit",
    cache: bundle ? "no-cache" : "default",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

/**
 * Keeps a version of a page that is being viewed online. pin also marks the
 * page as saved for offline; otherwise an existing pin is left as it is.
 */
export async function keep(meta: PageMeta, v: number, pin = false) {
  if (!supported || !index.owner) return;
  let stored: Stored | null = null;
  if (!index.pages[meta.id]?.versions.includes(v)) {
    // Opening a page and saving it at once mustn't download a bundle twice.
    const k = htmlKey(meta.id, v);
    let p = storing.get(k);
    if (!p) {
      p = store(meta, v).finally(() => storing.delete(k));
      storing.set(k, p);
    }
    stored = await p;
  }
  const old = index.pages[meta.id];
  const versions = [...new Set([...(old?.versions ?? []), v])].sort((a, b) => a - b);
  index.pages[meta.id] = {
    id: meta.id,
    name: meta.name,
    role: meta.role,
    versions,
    bundles: [...new Set([...(old?.bundles ?? []), ...(stored?.bundle ? [v] : [])])].sort((a, b) => a - b),
    sizes: stored ? { ...old?.sizes, [v]: stored.bytes } : old?.sizes,
    pinned: pin || (old?.pinned ?? false),
    updatedAt: meta.updatedAt,
    usedAt: new Date().toISOString(),
  };
  await evict();
  persist();
}

type Stored = { bundle: boolean; bytes: number };
const storing = new Map<string, Promise<Stored>>();

// store puts version v of a page in the cache: its HTML and, for a bundle,
// its files.
async function store(meta: PageMeta, v: number): Promise<Stored> {
  // Whether an older version is a bundle takes asking; the current one's
  // metadata says.
  const files = v === meta.version && !meta.bundle ? null : await api.versionFiles(meta.id, v);
  const bundle = !!files?.bundle;
  const res = await fetchHTML(meta.viewUrl, v, bundle);
  const html = await res.blob();
  const c = await caches.open(PAGES);
  // The files first: a version counts as kept once its HTML is.
  const bytes = bundle ? await keepFiles(c, meta.id, v, files!) : 0;
  await c.put(htmlKey(meta.id, v), new Response(html, { headers: { "Content-Type": "text/html" } }));
  return { bundle, bytes: bytes + html.size };
}

// keepFiles stores every file of bundle version v of page id, and then its
// list, and returns their size. A file another kept version of the page has
// too (same content) is copied from there rather than downloaded again.
async function keepFiles(c: Cache, id: string, v: number, m: VersionFiles): Promise<number> {
  const have = new Map<string, string>(); // sha256 -> key of a kept copy
  for (const w of index.pages[id]?.bundles ?? []) {
    const other = await manifest(c, id, w);
    for (const f of other?.files ?? []) have.set(f.sha256, fileKey(id, w, f.path));
  }
  try {
    const queue = [...m.files];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const kept = have.has(f.sha256) ? await c.match(have.get(f.sha256)!) : undefined;
        const res = kept ?? (await fetch(m.base + f.path.split("/").map(encodeURIComponent).join("/"), { credentials: "omit" }));
        if (!res.ok) throw new Error(`${f.path}: ${res.status} ${res.statusText}`);
        const body = await res.blob();
        if (body.size !== f.size) throw new Error(`${f.path}: got ${body.size} bytes, want ${f.size}`);
        await c.put(fileKey(id, v, f.path), new Response(body, { headers: { "Content-Type": f.contentType } }));
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    const list: Manifest = { base: m.base, files: m.files };
    await c.put(filesKey(id, v), new Response(JSON.stringify(list), { headers: { "Content-Type": "application/json" } }));
  } catch (e) {
    await drop(c, id, [v]);
    throw e;
  }
  return m.files.reduce((n, f) => n + f.size, 0);
}

async function manifest(c: Cache, id: string, v: number): Promise<Manifest | null> {
  const hit = await c.match(filesKey(id, v));
  return hit ? hit.json() : null;
}

// drop deletes what is kept of versions of page id: HTML, list and files.
async function drop(c: Cache, id: string, versions: number[]) {
  const prefixes = versions.map((v) => htmlKey(id, v) + "/");
  const keys = await c.keys();
  await Promise.all([
    ...versions.map((v) => c.delete(htmlKey(id, v))),
    ...keys.filter((r) => prefixes.some((p) => new URL(r.url).pathname.startsWith(p))).map((r) => c.delete(r)),
  ]);
}

export type BundleFile = { path: string; type: string; blob: Blob };

/**
 * A kept bundle version's base URL and files (index.html aside), for the SDK
 * to run it from offline; null unless every file is kept.
 */
export async function bundle(id: string, v: number): Promise<{ base: string; files: BundleFile[] } | null> {
  if (!supported || !index.pages[id]?.bundles?.includes(v)) return null;
  const c = await caches.open(PAGES);
  const m = await manifest(c, id, v);
  if (!m) return null;
  const files: BundleFile[] = [];
  for (const f of m.files) {
    const hit = await c.match(fileKey(id, v, f.path));
    if (!hit) return null;
    const body = await hit.blob();
    files.push({ path: f.path, type: f.contentType, blob: new Blob([body], { type: f.contentType }) });
  }
  return { base: m.base, files };
}

/** Whether version v of page id is kept as a bundle (else as plain HTML). */
export const isBundle = (id: string, v: number) => !!index.pages[id]?.bundles?.includes(v);

/**
 * The kept HTML of a bundle, made ready to run offline from a blob: URL with
 * its files handed to the SDK: its module scripts made inert (type
 * "specola-module") and its references to the bundle's files moved to
 * data-specola-src/-href, for the SDK to bring to life once it has the files
 * and has installed an import map (which must come before any module).
 */
export function offlineBundleHTML(html: string, base: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const s of doc.querySelectorAll('script[type="module"]')) s.setAttribute("type", "specola-module");
  for (const a of ["src", "href"]) {
    for (const el of doc.querySelectorAll(`[${a}]`)) {
      const v = el.getAttribute(a)!;
      if (!v.startsWith(base)) continue;
      el.setAttribute(`data-specola-${a}`, v);
      el.removeAttribute(a);
    }
  }
  const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : "";
  return doctype + doc.documentElement.outerHTML;
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
  await drop(await caches.open(PAGES), id, p.versions);
}

// evict drops the least recently used recent pages beyond MAX_RECENT or
// MAX_RECENT_BYTES, but never the last one used, however large.
async function evict() {
  const recent = Object.values(index.pages)
    .filter((p) => !p.pinned)
    .sort((a, b) => b.usedAt.localeCompare(a.usedAt));
  let bytes = 0;
  for (const [i, p] of recent.entries()) {
    bytes += Object.values(p.sizes ?? {}).reduce((a, b) => a + b, 0);
    if (i > 0 && (i >= MAX_RECENT || bytes > MAX_RECENT_BYTES)) await remove(p.id);
  }
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
      const kept = index.pages[p.id];
      const stale = kept.versions.filter((v) => v !== meta.version);
      if (stale.length) {
        await drop(await caches.open(PAGES), p.id, stale);
        kept.versions = [meta.version];
        kept.bundles = kept.bundles?.filter((v) => v === meta.version);
        for (const v of stale) delete kept.sizes?.[v];
        persist();
      }
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 403)) await remove(p.id);
    }
  }
}
