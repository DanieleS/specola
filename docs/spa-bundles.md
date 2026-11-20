# SPA bundles — design and contract

Status: implemented. Server, plugin, CLI, MCP, routing, the SDK, the SPA
(badges, publish hint) and offline viewing are checked end to end in
Chromium (`e2e/bundles.mjs`).

A **bundle** is a page whose current (or any) version is a multi-file build of a
single-page app (typically Vite), instead of one self-contained HTML document.
Bundles are built **on the agent's machine** with Specola's Vite plugin
(`@specola/vite-plugin`), uploaded file by file, and served lazily: only the
files the app actually requests are downloaded.

This document is the contract between the server, the plugin/CLI, the page SDK
and the SPA. Keep it in sync with the code.

## Goals and non-goals

- Multi-file output (no base64 tax), lazy loading (code splitting, lazy routes),
  workers, wasm, fonts, images, JSON.
- Same security model as plain pages: everything the bundle runs is on an
  opaque origin (CSP `sandbox` without `allow-same-origin`).
- Same features as plain pages: versions + notes, restore, sharing, public
  links, favorites, search, page storage (`localStorage`), offline viewing.
- MCP-first API: explicit and well described rather than convenient.
- Non-goals (v1): multi-page apps (only `index.html` may be HTML), building on
  the server, service workers / SharedWorkers inside pages, module workers.

## Browser facts this relies on (verified in Chromium 153)

On an opaque-origin document (sandboxed, no `allow-same-origin`):

| Fact | Result |
| --- | --- |
| `import()` / module scripts from another origin with `Access-Control-Allow-Origin: *` | works |
| `fetch` from another origin with `ACAO: *` | works |
| import map added from script before the first module, mapping https URLs to `blob:` URLs, static and dynamic imports | works |
| `history.pushState` changing the path | works |
| `new Worker(httpUrl)` | `SecurityError` |
| module worker from a `blob:` URL | **fails** (even with no imports) |
| classic worker from a `blob:` URL, `importScripts(absolute https asset)` | works |
| classic worker from a `blob:` URL, `importScripts(blob: URL created by the page)` | works |
| relative URL resolved against a `blob:` base (`new URL("./x.js", "blob:…")`) | throws: a module loaded from `blob:` cannot use relative imports |

Safari and Firefox are not verified yet.

## Data model (migration `0009_bundles.sql`)

- `bundle_blob(sha256 text PRIMARY KEY, size_bytes bigint NOT NULL, content bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`
  — content-addressed file contents, deduplicated across all versions and pages.
  `sha256` is 64 lowercase hex chars. `content` is stored uncompressed
  (`STORAGE EXTERNAL`, migration `0010_bundle_blob_storage.sql`), so a slice
  of it can be read without reading the whole value (see Serving).
- `asset_version.bundle_key text UNIQUE NULL` — non-null marks the version as a
  bundle. Random, 32 bytes base64url (43 chars). It is the capability in the
  bundle's file URLs (see Serving). A restored version gets a new key.
- `asset_version_file(asset_version_id uuid REFERENCES asset_version(id) ON DELETE CASCADE, path text NOT NULL, sha256 text NOT NULL REFERENCES bundle_blob(sha256), content_type text NOT NULL, size_bytes bigint NOT NULL, PRIMARY KEY (asset_version_id, path))`
  — the files of a bundle version, **excluding** `index.html`.
- The bundle's `index.html` is stored as the version's `content` (text), exactly
  like a plain page, so viewing, ETags, public links, search, history and the
  MCP keep working unchanged. `content_hash`/`size_bytes` are of `index.html`.
- Upload grants for bundles: `asset_grant` gains `bundle boolean NOT NULL DEFAULT false`,
  `manifest jsonb NULL` (the manifest accepted for this grant, see Upload)
  and `uploaded text[] NOT NULL DEFAULT '{}'` (the sha256 of the blobs sent
  through this grant, which its commit may use).
  The existing `UPLOAD_NEW` / `UPLOAD_VERSION` kinds are reused.

Garbage collection: the periodic sweep (next to `SweepGrants`) deletes blobs not
referenced by any `asset_version_file`, not named by the manifest of an
unused, unexpired bundle grant, and older than 24 hours. (`index.html` lives in
the version's `content`, so its blob is unreferenced once committed and is
swept like any other; a later upload of the same `index.html` sends it again.)
`created_at` is reset whenever a blob is uploaded again (`PUT` of a blob the
server already has), and the sweep rechecks it once it holds the row's lock,
so a blob being uploaded is never swept under the upload. The commit only uses
blobs referenced by versions (never swept) or uploaded through its grant
within its 30 minutes, and takes a key-share lock on them; should a sweep
still race a commit, the sweep fails on the foreign key and retries at the
next tick, never the commit.

## Paths in a bundle

A bundle is the content of the build output directory (e.g. `dist/`). Paths are
relative, `/`-separated. A path is valid when:

- it is 1–512 bytes of valid UTF-8 without control characters, `\`, `?`, `#`, or `%`;
- it does not start with `/`, and has no empty, `.` or `..` segments;
- it is not `index.html` duplicated, and paths are unique (case-sensitive);
- the only HTML file (`.html`/`.htm`, case-insensitive) is `index.html` at the root
  (required).

Hidden junk (`.DS_Store`, `__MACOSX/…`) is rejected by the plugin before upload,
not by the server (the server just validates the rules above).

## Limits

| Limit | Value |
| --- | --- |
| files per bundle (including `index.html`) | 2000 |
| one file | 25 MiB |
| `index.html` | 5 MiB |
| whole bundle | 100 MiB |
| bundle upload grant validity | 30 minutes |

Limits are Go constants, reported by `GET /upload/bundle/{token}`.

## Upload protocol

All bundle upload endpoints live on the **app origin** under
`/upload/bundle/{token}` and are authorized by the grant token only (like
`/upload/{token}`). The grant is minted by the MCP tool `create_bundle_upload`
(or the API, see below) for a new page or a new version, and re-checked on
commit, as the existing grants are.

1. `GET /upload/bundle/{token}` → `200 {"kind":"new"|"version","title"?, "pageId"?, "expiresAt", "limits":{"maxFiles","maxFileBytes","maxIndexBytes","maxBundleBytes"}, "minPluginVersion"}`.
   Lets the CLI check limits and compatibility before building.
2. `POST /upload/bundle/{token}/manifest` with
   `{"pluginVersion":"1.0.0","files":[{"path":"index.html","sha256":"…","size":123}, …]}`
   → validates paths and limits, stores the manifest on the grant (replacing any
   earlier one), answers `200 {"missing":["<sha256>", …]}`: the blobs the upload must
   send. A blob may be skipped only if it belongs to a bundle version the
   minting user can see (or was already sent through this grant); any other
   blob is listed as missing **whether or not the server has it**, so that
   deduplication tells no one which content exists elsewhere, and knowing a
   file's sha256 is never enough to get it into one's own bundle. `index.html`
   is the version's content rather than one of its files, so it is listed
   every time. A file whose blob the user can use but whose size differs from
   the manifest's answers 400. A `pluginVersion` below `minPluginVersion` answers 400 with
   a message telling how to update the plugin; so does a missing
   `pluginVersion`. Versions compare as `major.minor.patch`, ignoring a
   `-pre`/`+build` suffix. The manifest body is limited to 4 MiB.
3. `PUT /upload/bundle/{token}/blobs/{sha256}` with the raw bytes as the body →
   the body's sha256 and size must match an entry of the stored manifest, else
   400 (also 400 before any manifest was posted). The grant and the manifest
   entry are checked before the body is read, and no more than the entry's
   size is read. A body over the per-file limit answers 413 (always when its
   `Content-Length` says so, once the token is checked; a chunked body longer
   than its entry answers 400).
   Stores the blob (an existing one just has its `created_at` reset), records
   it as sent through the grant, answers `204`. Idempotent.
4. `POST /upload/bundle/{token}/commit` with `{"note"?:"…"}` (the note overrides
   the grant's) → every blob of the manifest must be present (else `409` with
   `{"missing":[…]}`, by the rule of step 2: present and usable by this
   upload); a size that differs from the blob's answers 400; `index.html` must
   be valid UTF-8. In one transaction:
   creates the page or adds the version (as the minting user, re-checking
   access), with `content` = `index.html`, a new `bundle_key`, one
   `asset_version_file` row per other file (content type from the extension,
   see Serving), reindexes search, consumes the grant. Answers
   `201 {"id","version","url"}` like `/upload/{token}`. An empty body, or an
   empty `note`, keeps the grant's note. Committing before posting a manifest
   answers 400.

Errors: unknown token 404, used/expired grant 410, as today; these come
before any other error (an invalid manifest, an old plugin, a bad body:
JSON that doesn't parse or is too large, a note that is too long, a blob
over the limit). A plain upload
grant used on these endpoints, or a bundle grant used on `PUT /upload/{token}`,
answers 400. Access lost between mint and commit answers 404 (403 if the user
can still see the page but no longer edit it).

### App API

- `POST /api/bundle-uploads` (signed in) with
  `{"kind":"new"|"version","title","folderId","id","note"}` (`title` required
  for `new`, `id` for `version`) mints a bundle upload grant, valid 30 minutes,
  and answers `201 {"uploadUrl","expiresAt","command","pluginInstall"}` where `command` is
  `npx --no -- specola-publish --upload '<uploadUrl>'` and `pluginInstall` the
  `npm i -D <tarball URL>` of this instance. The new-page form uses it: a
  short hint says apps with a build step are published with the plugin, and a
  button mints a link for the title and folder being filled in and shows both
  commands to copy. (The viewer has no "new version" action, so there is none
  for bundles either.)
- `GET /api/pages/{id}/versions/{v}/files` (viewer access) →
  `{"bundle":bool,"base":"{assetOrigin}/b/{key}/","files":[{"path","size","contentType","sha256"}]}`,
  files sorted by path, **excluding `index.html`** (which is the version's
  HTML, served by `/view`). A plain version answers `base: ""` and `files: []`.
- `GET /api/pages/{id}` and `GET /api/pages/{id}/versions` carry `bundle`
  (the current version / each version is a bundle).

## Serving

### Bundle files

`GET {assetOrigin}/b/{bundleKey}/{path}` where `assetOrigin` is
`SPECOLA_VIEW_ORIGIN` when set, else the app's base URL. On the view origin it
is routed by the view mux; with no view origin it is on the app router,
outside authentication.

- Looks up the file by key and path, only if its version's page is not deleted
  or archived, itself or through a folder above it (else 404). No user check:
  the key is the capability. With a view origin, the app origin answers 404
  for `/b/…`, as it does for `/view`.
- What that means for revoking access: the key is in every `index.html` the
  version is served with, so whoever opened the version (as a viewer, or
  through a public link) can keep fetching all its files after their share is
  removed or the link revoked, and can pass the URLs on, until the page is
  archived. Files are sent `Cache-Control: public, immutable`, so shared
  caches may keep them even after that. Only the HTML, and so the key of a
  later version, is cut off at once. A new version (or a restore) gets a new
  key.
- The lookup reads the file's metadata only; the content is read from the
  database as it is sent, 1 MiB at a time (`substring` on the stored bytes),
  at most 4 reads at once across the server. So a `HEAD`, a matching
  `If-None-Match` (304) or a small range costs no read, or one chunk, of a
  file of up to 25 MiB.
- Headers: `Content-Type` from the extension (table below), `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals`,
  `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`,
  `Referrer-Policy: no-referrer`, `Cache-Control: public, max-age=31536000, immutable`,
  `ETag: "<sha256>"`. Range requests and `HEAD` supported (`http.ServeContent`).
- Content types: `.js .mjs .cjs` → `text/javascript; charset=utf-8`;
  `.css` → `text/css; charset=utf-8`; `.json .map` → `application/json`;
  `.wasm` → `application/wasm`; `.svg` → `image/svg+xml`; `.png .jpg .jpeg .gif .webp .avif .ico .bmp`;
  `.woff .woff2 .ttf .otf`; `.txt` → `text/plain; charset=utf-8`; `.csv`, `.xml`, `.webmanifest`;
  `.mp3 .wav .ogg .mp4 .webm .m4a`; `.glb .gltf .bin`; anything else
  `application/octet-stream`.
- Gzip via the existing `middleware.Compress` for compressible types. A
  request with a `Range` header is answered uncompressed (a compressed slice
  of the stored bytes would be meaningless).

### index.html

The plugin builds with Vite `base: "./"` (everything relative), then rewrites
the references to bundle files **in `index.html` only** to start with the
placeholder `__SPECOLA_BASE__/` (e.g. `src="__SPECOLA_BASE__/assets/index-ab12.js"`).
JS and CSS keep relative URLs, which resolve against their own URL under
`/b/{key}/`.

When serving a bundle version's HTML (view, token view, public link), the
server replaces every `__SPECOLA_BASE__/` with `{assetOrigin}/b/{bundleKey}/`
before adding the SDK. The stored content keeps the placeholder (so
`get_page` returns it verbatim). A plain version is served as stored, even if
it contains the placeholder text. The current version's `ETag` covers the
bundle key as well as the content hash, since two bundle versions (e.g. a
restore) can share an `index.html` but not a key.

### Page SDK additions (all pages)

The server passes boot data to the SDK (same injected `<script>`, ahead of the
page's own): `window.specola.base` (the bundle's file base URL ending in `/`,
or `""` for a plain page) and `window.specola.basename` (the path prefix the
page is served under, for client-side routers, see Routing). `pagesdk.js` is
a function `((boot) => {…})(SPECOLA_BOOT)`; the server puts the JSON of
`{"base","basename"}` in place of `SPECOLA_BOOT` per request (`<`, `>` and `&`
escaped, so it can't close the script). The first-load `window.name` handoff
of `localStorage` data is unchanged.

The SDK wraps `window.Worker` with a subclass (so `instanceof Worker` and
`Worker.prototype` keep working): `new Worker(url, opts)` where `url` resolves
(against `document.baseURI`) to an `http(s):` URL becomes a classic worker
from a `blob:` URL whose source is a prelude then `importScripts(<absolute url>)`,
one blob per URL. `{type:"module"}` is honoured only for `blob:`/`data:` URLs
given by the page, which pass through untouched; for an http(s) URL it is
dropped (module workers cannot run on an opaque origin), with a
`console.warn` unless the URL is under the page's `specola.base`: the plugin
builds a bundle's workers as classic scripts (`worker.format: "iife"`), and
`{type:"module"}` is what `vite dev` needs for a worker with imports.
The prelude makes the worker's `self.location` its script's real URL (a
`URL` object) instead of the `blob:` URL, and resolves relative URLs given
to `fetch` and `importScripts` against it, so Vite's compiled
`new URL(file, self.location.href)` (from `?url` imports and
`new URL(…, import.meta.url)` in a worker) reaches the bundle.

### Routing (deep paths)

Every route that serves a page also serves it for any path below it, so an SPA
using the History API can reload and deep link:

- app origin: `/view/{id}` and `/view/{id}/*` (`?v=N` as today) → basename `/view/{id}`
- view origin: `/t/{viewToken}/view/{id}` and `…/*` → basename `/t/{viewToken}/view/{id}`
  (the token moves from the query to the path so `pushState` keeps it; the old
  `/view/{id}?t=` form keeps working, basename `/view/{id}`)
- public links: `/s/{token}` and `/s/{token}/*` → basename `/s/{token}`

`viewUrl` in `GET /api/pages/{id}` uses the new token-in-path form. An SPA
using React Router writes `<BrowserRouter basename={window.specola?.basename}>`
(or uses a hash router, which the MCP instructions recommend: it also routes
when the page is viewed offline, see Offline).

`?v=N` keeps working below the prefix. Caching is per URL, as before
(`?v=N` immutable, the current version revalidated); the current version's
`ETag` also covers the basename, since it is part of what is sent (a deep path
under the same prefix gets the same tag and the same body).

The SPA's service worker leaves navigations to `/view/…` and `/s/…` alone, as
before, so a reload of a deep path inside the frame reaches the server; so it
does for `/b/…` and `/tools/…`, and it only ever keeps an HTML response as the
app shell (a navigation to the plugin's tarball once replaced the offline
shell with it).

## MCP

- New tool `create_bundle_upload` (`kind` new|version, `title?`, `folder_id?`,
  `id?`, `note?`) → `{upload_url, expires_at, command, plugin_install}` where
  `command` is the exact `npx --no -- specola-publish --upload '<upload_url>'` to run
  in the project and `plugin_install` the `npm i -D <tarball URL>` of this
  instance. The command is built by `plugin.PublishCommand`, shared with
  `POST /api/bundle-uploads`.
- `get_page` returns `bundle: {files:[{path,size,content_type}], base}` when
  the version it returns the HTML of is a bundle (`null` otherwise: this
  replaces the page metadata's boolean `bundle`, which is about the current
  version, in this tool's output), and then a `note` saying it is a bundle
  that must be changed from its source project and republished with the
  plugin.
- `list_versions`, `GET /api/pages/{id}` and `…/versions`: versions/pages carry `bundle`.
- Server `instructions` and the `publish_page`/`new_version`/`create_upload_grant`/`get_page`
  descriptions are rewritten so an agent **chooses**: a single self-contained
  HTML document → `publish_page`; anything with a build step (framework apps,
  multiple files, lazy loading, workers, wasm, many assets) → the Vite plugin,
  with the exact steps and this instance's URLs ((a) `npm i -D <tarball URL>`,
  (b) `specola()` in `vite.config` plugins, (c) `create_bundle_upload`, (d) run
  the returned command, as it is, and what to do when npx says the package is
  missing) and the key constraints (a hash router preferred, since it also
  routes offline when it navigates by `pushState` or links, else the router
  basename; workers with `{type:"module"}`, built and run as classic
  scripts; own files by module-relative URLs, in workers too; no external
  SVG sprites; the `client` types; `localStorage` per user, no IndexedDB,
  limits). This steering is a product requirement.

## Plugin and CLI distribution

- Source in `plugin/` in this repo (package `@specola/vite-plugin`, ESM, no
  runtime dependencies, Node ≥ 18, `vite` ≥ 5 as a peer dependency).
- Exports `specola(options?)` (the Vite plugin) and ships the bin
  `specola-publish`.
- The Go server embeds `plugin/` sources (`plugin/embed.go`, package
  `plugin`: exactly `package.json` and what its `"files"` lists, never
  `node_modules` or the tests; a test checks the two lists agree) and serves
  an npm tarball built once at startup at
  `GET /tools/specola-vite-plugin-<version>.tgz` (public, on the app origin,
  `Content-Type: application/gzip`, `Cache-Control: public, max-age=31536000, immutable`,
  `ETag` its sha256; any other name under `/tools/` answers 404). The
  tarball is deterministic: entries sorted, under `package/`, npm's fixed
  mtime (1985-10-26 08:15 UTC), owner 0, mode 0755 for the `bin` files and
  0644 for the rest. Install: `npm i -D <appBase>/tools/specola-vite-plugin-<version>.tgz`.
  A manifest from a plugin older than `minPluginVersion` is refused with that
  install command.

### Plugin behaviour

- Sets `base: "./"`, `worker.format: "iife"`, keeps hashed file names. A
  classic worker is one file, so a worker's dynamic `import()`s are inlined:
  up to Vite 7 the plugin sets `worker.rollupOptions.output.inlineDynamicImports`
  (Rollup can't split an iife build and would fail with an error that
  doesn't name the plugin); Vite 8's Rolldown inlines them by itself.
- Rewrites `index.html` references to bundle files to `__SPECOLA_BASE__/…`.
- Adds `<meta name="generator" content="specola-vite-plugin/<version>">`.
- Option `searchText` (string): emitted as `<noscript data-specola-search>…</noscript>`
  in `index.html` so full-text search finds the page.
- Fails the build when limits are exceeded or another `.html` is emitted; warns
  when the app references root-absolute paths (`"/…"`) that would escape the
  bundle (e.g. files from `public/` referenced from JS as `/logo.png`), and
  when `index.html` or a JS chunk uses an external SVG sprite
  (`"icons.svg#id"`, or an SVG file's URL with `#id` added, as Vue's
  compiled templates do): an opaque-origin document loads `<use>` references
  from no URL at all, so the advice is to inline the sprite (`?raw`).
- Types: `index.d.ts` for `vite.config`; `client.d.ts`, exported as
  `@specola/vite-plugin/client`, declares `window.specola` for app code
  (add it to `types` in `tsconfig.app.json`).
- Dev server: provides a stand-in `window.specola` (`base: "/"`, `basename: ""`,
  `persistent: false`, a no-op `flush`; `localStorage` is the browser's own)
  so apps can use the API locally.

### CLI `specola-publish`

`npx --no -- specola-publish --upload <url> [--dir dist] [--no-build] [--note "…"]`
(`--no`: npx runs only the project's installed bin, never a package of that
name fetched from the public registry, which would get the upload link; `--`
keeps npm from reading the CLI's options as its own):
GET the grant info, run `vite build` (unless `--no-build`), walk the output
directory, skip junk files, hash, POST the manifest, PUT missing blobs (4 at a
time, retry network errors and 5xx answers up to 4 times with backoff), commit,
print the JSON result on stdout (progress on stderr). Clear errors.

- `--upload` must be a bundle upload link (`…/upload/bundle/<token>`); any
  other URL is refused before a request is made.
- `vite build` is the project's own Vite (resolved from the working
  directory, never downloaded by `npx`); without one the CLI says so.
- Symbolic links in the output directory are followed only while they stay
  inside it; a link out of it, a loop or a broken link fails the publish.
- A file whose bytes changed between hashing and upload fails the publish.
- The commit consumes the grant: when an attempt fails without an answer and
  the retry gets 410, the CLI reports that the commit most likely went
  through instead of calling the link expired.

## Offline

Pinning or opening a bundle version keeps `index.html` and **all** its files
in Cache Storage (list from `GET /api/pages/{id}/versions/{v}/files`, files
fetched from their `/b/` URLs, 6 at a time; a file another kept version of
the page has, by sha256, is copied instead). Keys are per version, under its
HTML's key: `/__offline/pages/{id}/{v}` (HTML), `…/{v}/files` (the list),
`…/{v}/file/{path}`. The HTML is stored last, and only then is the version
recorded as kept (`bundles` in the localStorage index lists the versions kept
as bundles), so a half-kept bundle is never taken for a kept one; a failed
download deletes what it stored, and so does a download that ends after
the user logged out. A download holds a Web Lock named after the version's
key; when the app starts online it deletes whatever the cache holds of a
version that the index doesn't list and no tab is storing (a download cut
short by closing the tab). Removing a page or a stale version deletes its
files too. Each kept version's size, files included, is recorded, and
recent (unpinned) pages are evicted beyond 30 pages **or** 256 MiB together,
oldest first, but never the most recent one.

A bundle's HTML is fetched for keeping with `cache: "no-cache"`: a numbered
version is cached by the browser for a year with the SDK it was first served
with, and running offline needs the current SDK.

Offline, the viewer renders the kept index from a `blob:` URL and hands the
files to the SDK over the existing `MessagePort`:

- the viewer first makes the index's module scripts inert (`type="specola-module"`)
  and moves every `src`/`href` that starts with the bundle's base to
  `data-specola-src`/`data-specola-href` (so nothing is fetched, and no module
  starts before the import map);
- the SDK knows it is offline when it has a base and its document is a
  `blob:` URL; its hello then carries `files: true` (sent whether or not
  localStorage is persistent), and the viewer answers with the port, then
  `{op:"files", files:[{path, type, blob}]}` on it. The port saves the
  page's `localStorage` writes only if the frame was handed its data, as
  online; otherwise it refuses them.

The SDK, inside the page's origin:

1. makes `blob:` URLs for leaf files (non-JS, non-CSS);
2. rewrites CSS `url(...)` to those `blob:` URLs, and in JS every quoted
   path-like string that resolves, against the module's own `{base}path`, to a
   bundle file: to the absolute `{base}path` for a JS file (a module from
   `blob:` can't resolve relative specifiers; this covers static and dynamic
   imports and `new URL("x.js", import.meta.url)` for workers) and for a CSS
   file (Vite's preload helper tells a lazy chunk's CSS by its URL ending in
   `.css`; the `<link>` it adds gets the `blob:` URL from the `href` setter),
   to the file's `blob:` URL otherwise; `import.meta.url` becomes the
   module's `{base}path`.
   Then it makes `blob:` URLs for them (leaves, then CSS, then JS);
3. installs an import map from every `{base}path.js` to its `blob:` URL (this
   handles import cycles), and maps the files' absolute URLs (`specola.base`
   lookups included) in `fetch` and `XMLHttpRequest` (to the file as
   published, GET/HEAD only), the `src`/`href` setters of `img`, `script`,
   `link`, `source`, `audio`/`video` and `setAttribute`, and the Worker
   wrapper (a bundle worker runs its rewritten script, behind a prelude that
   maps `fetch` and `importScripts` in the worker the same way);
4. then restores the `data-specola-*` references and loads the entry module(s)
   in order.

A bundle that isn't kept whole (a file missing from the cache) is reported as
"not available offline" rather than shown broken. A plain page offline works
exactly as before.

On any `blob:` document (a bundle or a plain page offline), Chromium refuses
every fragment navigation ("Not allowed to load local resource"), but
`history.pushState` works: the SDK handles a click on a fragment link
(`<a href="#…">`) that the page didn't `preventDefault`, with `pushState`,
the `popstate` and `hashchange` events the navigation would fire, and the
scroll to the target.

Page storage offline (plain pages and bundles alike): the frame's data comes
from the service worker's copy of `GET /api/pages/{id}/data`, which the
viewer updates with each write once it is saved, so a page opened offline
starts from its latest saved data. Writes not saved yet are kept in
`localStorage` (`specola:outbox`, with the user they belong to, removed on
logout) as well as in memory: they are folded into the data a page is
handed, and sent when the app next runs online, so they survive reloading
or closing the app while offline.

Known limits offline:

- The document is a `blob:` URL: `history.pushState` to a path throws a
  `SecurityError` (verified in Chromium) and `location.pathname` is not under
  `specola.basename`, so an app routing by path (`<BrowserRouter>`) doesn't
  route offline; a hash router works, as long as it navigates with
  `pushState` or links: assigning `location.hash` (or `location.href` to a
  fragment) still fails, and can't be intercepted.
- References the rewriting can't see stay as they are and fail: a path built
  at run time other than from `specola.base` (or `import.meta.url`), or given
  to something other than the APIs above (say, CSS `@import` of another CSS
  file, or `srcset`).
- Range requests aren't emulated.
