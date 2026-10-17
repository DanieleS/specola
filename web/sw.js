// Specola's service worker. The build (vite.config.ts) prepends VERSION and
// PRECACHE: the shell, the hashed bundle and the public files of this build.
//
// - The shell is network-first, so a deploy reaches the browser at once, with
//   the cached copy as the offline fallback for every SPA navigation.
// - /assets/ files carry a content hash: cache-first.
// - GET /api reads are network-first and kept for offline use; a copy served
//   from the cache is marked with OFFLINE_HEADER so the app can tell.
// - Rendered pages (/view) are left alone: the app stores the pages it keeps
//   for offline itself (src/lib/offline.svelte.ts), since they may come from
//   another origin and are shown in a sandboxed frame.

/* global VERSION, PRECACHE */
const SHELL = `specola-shell-${VERSION}`;
const API = "specola-api";
const OFFLINE_HEADER = "X-Specola-Offline";

// Reads that make no sense from a stale copy.
const NO_CACHE_API = ["/api/search"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE.map((p) => new Request(p, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("specola-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;

  if (p.startsWith("/api/")) {
    if (!NO_CACHE_API.some((n) => p.startsWith(n))) e.respondWith(apiRead(req));
    return;
  }
  if (p.startsWith("/assets/")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetchAndKeep(req, SHELL)));
    return;
  }
  if (req.mode === "navigate") {
    if (/^\/(view|auth|mcp|upload|healthz|\.well-known)(\/|$)/.test(p)) return;
    e.respondWith(shell(req));
    return;
  }
  if (PRECACHE.includes(p)) e.respondWith(caches.match(p).then((hit) => hit || fetch(req)));
});

// Every SPA route is the same shell: refresh "/" when online, serve it offline.
async function shell(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const c = await caches.open(SHELL);
      await c.put("/", res.clone());
    }
    return res;
  } catch (err) {
    const hit = await caches.match("/");
    if (hit) return hit;
    throw err;
  }
}

async function apiRead(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const c = await caches.open(API);
      await c.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const hit = await caches.match(req, { cacheName: API });
    if (!hit) throw err;
    const headers = new Headers(hit.headers);
    headers.set(OFFLINE_HEADER, "1");
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }
}

async function fetchAndKeep(req, cacheName) {
  const res = await fetch(req);
  if (res.ok) {
    const c = await caches.open(cacheName);
    await c.put(req, res.clone());
  }
  return res;
}
