// Specola's service worker for public links (docs/page-apps.md, "Offline"),
// served at /public-sw.js on the origin that serves them, with scope /s/.
//
// - A link's shell (/s/{token} and any path below it but Specola's own ~
//   names) is network first. Each is kept under /s/{token}/; when the server
//   can't be reached, that copy is served with "offline":true in its boot
//   data, and the shell shows the copy of the page it kept itself. A link
//   that answers 404 or 410 (revoked, expired) has its copies deleted.
// - Icons (/app-icons/) are cache first.
// - Nothing else is handled: the page itself, its bundle files, /p/ calls
//   and data go to the network. The pages, on an opaque origin, are never
//   this worker's clients.
"use strict";

const CACHE = "specola-public";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/app-icons/")) {
    e.respondWith(
      caches.match(req, { cacheName: CACHE }).then(
        (hit) =>
          hit ||
          fetch(req).then(async (res) => {
            if (res.ok) await (await caches.open(CACHE)).put(req, res.clone());
            return res;
          }),
      ),
    );
    return;
  }
  const m = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (req.mode !== "navigate" || !m || (m[2] || "").startsWith("/~")) return;
  e.respondWith(shell(req, m[1]));
});

async function shell(req, token) {
  const key = "/s/" + token + "/";
  const cache = await caches.open(CACHE);
  let res;
  try {
    res = await fetch(req);
  } catch (err) {
    const hit = await cache.match(key);
    if (!hit) throw err;
    const text = (await hit.text()).replace('"offline":false', '"offline":true');
    return new Response(text, { status: 200, headers: hit.headers });
  }
  if (res.ok && (res.headers.get("Content-Type") || "").startsWith("text/html")) {
    await cache.put(key, res.clone());
  } else if (res.status === 404 || res.status === 410) {
    // Revoked or expired: nothing of it is kept.
    await Promise.all([cache.delete(key), cache.delete(key + "~kept")]);
  }
  return res;
}
