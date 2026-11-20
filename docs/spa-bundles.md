# SPA bundles — design and contract

Status: being implemented on branch `ccr-c6bf3320-7faeji`.

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
  `sha256` is 64 lowercase hex chars.
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
   `Content-Length` says so; a chunked body longer than its entry answers 400).
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
before any other error (an invalid manifest, an old plugin, a bad body). A plain upload
grant used on these endpoints, or a bundle grant used on `PUT /upload/{token}`,
answers 400. Access lost between mint and commit answers 404 (403 if the user
can still see the page but no longer edit it).

### App API

- `POST /api/bundle-uploads` (signed in) with
  `{"kind":"new"|"version","title","folderId","id","note"}` (`title` required
  for `new`, `id` for `version`) mints a bundle upload grant, valid 30 minutes,
  and answers `201 {"uploadUrl","expiresAt","command"}` where `command` is
  `npx specola-publish --upload '<uploadUrl>'`.
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
page is served under, for client-side routers, see Routing).

The SDK wraps `window.Worker`: `new Worker(url, opts)` where `url` resolves to
an `http(s):` URL becomes a classic worker from a `blob:` URL whose source is
`importScripts(<absolute url>)`. `{type:"module"}` is honoured only for
`blob:`/`data:` URLs given by the page; for an http(s) URL it is dropped with a
`console.warn` (module workers cannot run on an opaque origin). The plugin
builds workers as classic scripts (`worker.format: "iife"`) so this works.

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
(or uses a hash router).

## MCP

- New tool `create_bundle_upload` (`kind` new|version, `title?`, `folder_id?`,
  `id?`, `note?`) → `{upload_url, expires_at, command}` where `command` is the
  exact `npx specola-publish --upload '<upload_url>'` to run in the project.
- `get_page` on a bundle version also returns `bundle: {files:[{path,size,content_type}], base}`
  and a `note` saying it is a bundle that must be changed from its source
  project and republished with the plugin.
- `list_versions`, page metadata: versions/pages carry `bundle: true`.
- Server `instructions` and the `publish_page`/`new_version` descriptions are
  rewritten so an agent **uses the Vite plugin for anything with a build step**
  (framework apps, multiple files, lazy loading), with the exact install
  command (plugin tarball URL of this instance) and steps. Single-file pages
  keep using `publish_page`. This steering is a product requirement.

## Plugin and CLI distribution

- Source in `plugin/` in this repo (package `@specola/vite-plugin`, ESM, no
  runtime dependencies, Node ≥ 18, `vite` ≥ 5 as a peer dependency).
- Exports `specola(options?)` (the Vite plugin) and ships the bin
  `specola-publish`.
- The Go server embeds `plugin/` sources and serves an npm tarball built at
  startup (deterministic tar.gz, files under `package/`) at
  `GET /tools/specola-vite-plugin-<version>.tgz` (public, immutable, on the app
  origin). Install: `npm i -D <appBase>/tools/specola-vite-plugin-<version>.tgz`.

### Plugin behaviour

- Sets `base: "./"`, `worker.format: "iife"`, keeps hashed file names.
- Rewrites `index.html` references to bundle files to `__SPECOLA_BASE__/…`.
- Adds `<meta name="generator" content="specola-vite-plugin/<version>">`.
- Option `searchText` (string): emitted as `<noscript data-specola-search>…</noscript>`
  in `index.html` so full-text search finds the page.
- Fails the build when limits are exceeded or another `.html` is emitted; warns
  when the app references root-absolute paths (`"/…"`) that would escape the
  bundle (e.g. files from `public/` referenced from JS as `/logo.png`).
- Dev server: provides a stand-in `window.specola` (`base: "/"`, `basename: ""`,
  `persistent: false`, a no-op `flush`; `localStorage` is the browser's own)
  so apps can use the API locally.

### CLI `specola-publish`

`npx specola-publish --upload <url> [--dir dist] [--no-build] [--note "…"]`:
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
in Cache Storage (list from `GET /api/pages/{id}/versions/{v}/files`). Offline,
the viewer renders the kept index from a `blob:` URL and hands the files to the
SDK over the existing `MessagePort`; the SDK, inside the page's origin:

1. makes `blob:` URLs for leaf files (non-JS);
2. rewrites CSS `url(...)` and relative JS module specifiers (`"./x.js"`,
   `"../x.js"` to known bundle files) to absolute `{base}path` URLs (a module
   from `blob:` can't resolve relative specifiers), then makes `blob:` URLs for
   them;
3. installs an import map from every `{base}path.js` to its `blob:` URL (this
   handles import cycles), maps `specola.base` lookups, and patches `fetch` /
   `XMLHttpRequest` for known bundle URLs;
4. then loads the entry module(s) that the viewer removed from the index.

If any of this proves impossible in a browser, a bundle that isn't fully
available is reported as "not available offline" rather than shown broken.
