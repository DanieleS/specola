# Specola

Self-hosted viewer for **versioned, interactive HTML pages**. Publish a
self-contained HTML page (an explainer, a report, a small interactive app),
organise pages in folders, keep a version history, and share them read-only or
read-write with other people — all behind your own OIDC login.

Pages are private to their author until shared. An item you can't see answers
404; one you can see but not change answers 403.

Pages are rendered in a sandboxed iframe with an opaque origin, so a page's
scripts can run without being able to touch Specola's session or API.

> Status: early. Publish, browse, version with notes, view, share, public
> links, favorites,
> full-text search, offline viewing as an installable PWA, SPA bundles
> (multi-file apps built with the Specola Vite plugin), optional page
> backends (server code shipped in a bundle, run by a separate runner: calls,
> databases, files, logs, snapshots, export/import, secrets, an egress
> allowlist, realtime push, scheduled jobs, public routes), and an
> OAuth-protected MCP endpoint for agents.

## Stack

Small on purpose: a single static Go binary serves a JSON API, the sandboxed
page viewer, and the built SPA.

| Area | Choice |
| --- | --- |
| Backend | Go, [`chi`](https://github.com/go-chi/chi) router, [`pgx`](https://github.com/jackc/pgx), [`goose`](https://github.com/pressly/goose) migrations |
| Database | PostgreSQL (HTML stored inline; SPA bundle files stored too, as `bytea`) |
| Auth | OIDC (tested against Logto); dev bypass for local work |
| Frontend | Vite + Svelte + TypeScript, built to static assets embedded in the binary |
| Image | multi-stage build to a distroless static base (~15 MB) |

## Data model

Users are identified by their OIDC `sub` (stable, and present in API access
tokens), not by email.

- **app_user** — one row per `sub` seen at login, with the latest email and
  name. Used to resolve an email to a `sub` when sharing.
- **folder** — a tree; soft-delete + archive aware.
- **asset** — a page. `current_version` points at the latest version.
- **asset_version** — immutable history; the HTML lives inline in `content`,
  with an optional `note` on what changed. A version with a `bundle_key` is
  an SPA bundle: `content` is its `index.html`, and the key is the capability
  in its files' URLs.
- **asset_version_file** — a bundle version's other files: path, content
  type, size and the sha256 of their content.
- `asset_version.backend` / `backend_hash` — on a bundle version with a
  [page backend](#page-backends), its validated manifest and the hash that
  identifies its server code. The backend's data is not in Postgres: it
  lives on the runner's volume.
- **page_secret** — a backend page's secrets, by name, encrypted with
  `SPECOLA_SECRETS_KEY` (AES-256-GCM).
- **backend_cron** — the scheduled jobs of each page's current version, with
  their next and last runs.
- **bundle_blob** — bundle file contents by sha256, deduplicated across all
  versions and pages, stored uncompressed as `bytea` (up to 25 MiB per file,
  100 MiB per bundle). A periodic sweep deletes blobs no version uses (and no
  live upload names) after 24 hours. Plan database size and backups with
  them in mind.
- **acl_entry** — one user (`sub`), one role (`VIEWER` / `EDITOR`) on a folder *xor* an
  asset. A folder grant is inherited by everything beneath it.
- **asset_grant** — short-lived, single-use token so a client can `curl` a large
  HTML body instead of inlining it in a request, or upload a bundle (`bundle`,
  with the `manifest` it accepted and the blobs `uploaded` through it).
- **favorite** — personal stars.
- **page_data** — per page and user, the page's `localStorage`.
- **public_link** — a page's public links: the sha256 of the token, an
  optional pinned version, label and expiry, and a view count.
- **search_document** — per page, the title and tag-stripped text of the
  current version with a `tsvector`, for full-text search.

## Organising

- **Folders** nest; publish into the folder you're browsing with **+ Page**.
- **Rename**, **move** and **archive** from a card's ⋯ menu. Editors can
  rename and move within folders they can edit; moving to Home and
  archiving are for owners.
- **Archiving** a folder hides everything in it, from you and from everyone
  it's shared with, including in search. Restore it from **Archived**.
- **History**: every publish is a new version. Open any version in the
  viewer and restore it as a new version; nothing is ever overwritten.
  `/view/{id}?v=N` serves a specific version.
- **Notes**: a version can carry a one-line note (up to 500 characters) on
  what changed, shown in the history. `note` is accepted by
  `POST /api/pages`, `POST /api/pages/{id}/versions` (also when restoring),
  and the MCP publishing tools.
- **Favorites**: star a folder or page, yours or shared with you, from its
  card or the viewer; starred items are listed under **Favorites**. A star
  you can no longer see (unshared, archived) is hidden, not dropped, and comes
  back with the access. API: `PUT/DELETE /api/{pages|folders}/{id}/favorite`,
  `GET /api/favorites`.

## Caching and compression

Responses in HTML, CSS, JS, JSON and SVG are gzip-compressed for clients that
accept it; pages with their data inlined shrink several times over.

- `/view/{id}?v=N` is immutable: `Cache-Control: private, max-age=31536000,
  immutable`. The viewer always asks for a numbered version, so reopening a
  page costs no download. Not on a page with a backend, whose versions can
  stop being openable: there it is `private, no-cache`.
- `/view/{id}` (the current version) carries a weak `ETag` from the version's
  content hash and `Cache-Control: private, no-cache`; a matching
  `If-None-Match` answers 304 without reading the HTML out of the database.
- The SPA shell is `no-cache`, so a deploy reaches the browser at once; the
  bundle under `/assets/` has hashed names and is cached for a year.
- A page bundle's files (`/b/{key}/{path}`) never change under their key and
  are sent `Cache-Control: public, max-age=31536000, immutable` with their
  sha256 as `ETag`; a `HEAD`, a 304 or a small range reads little or nothing
  from the database.

## Offline and install (PWA)

Specola is an installable Progressive Web App (manifest, icons, service
worker), and pages can be read without a connection.

- **Kept pages**: every page you open is kept on the device (the last 30,
  and no more than 256 MiB of them). A bundle is kept with all its files.
  **Save offline** in the viewer pins a page: it is never evicted and is
  brought up to its current version each time Specola opens online; pages
  you've lost access to are dropped then. The **Offline** tab lists what the
  device keeps, readable with no network.
- **Lists and metadata** you've browsed (folders, favorites, shared, history)
  are read from the service worker's copy when the server can't be reached.
  Search, publishing and every change need a connection.
- Offline, a kept page is shown from a `blob:` URL in the same sandboxed
  iframe (no `allow-same-origin`), so its scripts still run on an opaque
  origin. A bundle's files are handed to the page SDK, which serves them
  from `blob:` URLs ([docs/spa-bundles.md](docs/spa-bundles.md), "Offline").
- What the device keeps belongs to the signed-in user: **Logout** wipes it,
  and so does signing in as someone else on the same browser.

The service worker (`web/sw.js`) is built with the list of the build's files
to precache. The shell is network-first, so a deploy still reaches the
browser at once; `sw.js` and the manifest are served `no-cache`. It only runs
over HTTPS (or on `localhost`) and isn't registered by the Vite dev server.

## Sharing

Share a folder or page with another user by email, as **viewer** (read) or
**editor** (also add versions and create items inside a folder).

- The **owner** is whoever created the item or any folder above it, so pages
  an editor adds to your shared folder stay yours to manage. Only owners
  manage shares.
- A folder share applies to everything beneath it. The nearest share wins:
  a viewer share on a sub-folder narrows an editor share above it.
- You can only share with someone who has signed in once, since that's how
  their email maps to a `sub`.
- Shared items show up under **Shared with me**.

API: `GET/PUT/DELETE /api/{pages|folders}/{id}/acl` (`PUT` takes
`{"email" | "sub", "role"}`, `DELETE` takes `?sub=`), and `GET /api/shared`.

## Public links

To show a page to someone without a Specola account, its owner makes a
**public link** from the Share dialog: a secret URL that shows the page,
read-only, to anyone who has it, without signing in. Nothing else in Specola
is reachable from it, except the files of an SPA bundle it shows (see
below).

- A link follows the current version, or is **pinned** to one. It can expire
  after a number of days (at most 366) or never, and carries an optional
  label saying who it is for.
- Only the token's sha256 is stored, so the URL is shown once, when the link
  is made. The owner sees each link's label, expiry, views and last use, and
  can **revoke** it; it stops working at once (nothing is cached).
- An SPA bundle's files are served by an unguessable per-version key with no
  per-user check, and the key is in the HTML. Revoking a link (or removing a
  share) stops the page being served, but whoever loaded that version can
  still fetch its files, and pass their URLs on, until the page is archived;
  the files are cached publicly, so copies may outlive even that. Treat
  what a bundle's files contain as shared with everyone who opened it. A new
  version gets a new key.
- A link works only while the page is active and its creator still owns it:
  archiving the page or a folder above it takes its links down, and
  restoring it brings them back.
- The page is served at `/s/{token}` (on `SPECOLA_VIEW_ORIGIN` when set) as
  the whole document, with the same CSP sandbox, `frame-ancestors 'none'`,
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. Its
  `localStorage` works in memory only, for that load. An expired link
  answers 410; an unknown or revoked one 404.
- A page with a [backend](#page-backends) is served instead in a small
  **shell** that frames it (at `/s/{token}/~page/…`) and relays its
  `specola.fetch` and `specola.subscribe` to `/p/{token}/x/…` and
  `/p/{token}/events`, without a session: only the routes and topics its
  manifest makes public, as role `public`, rate limited per link and client
  IP (see Page backends).

API (owner only): `GET/POST /api/pages/{id}/links` (`POST` takes
`{"label", "version", "expiresInDays"}`, all optional, and answers with the
`url`), `DELETE /api/pages/{id}/links/{linkId}`.

## Preferences for agents

Agents publishing through the MCP otherwise pick stack and style from scratch
every time. Two things steer them
([docs/agent-preferences.md](docs/agent-preferences.md)):

- **Preferences** (header → *Preferences*, `#/settings`), private to each
  user: a publishing mode (the agent decides, or always an SPA bundle),
  free-form Markdown on stack and style (up to 4000 characters), and an
  optional **style reference**: a page agents take colours, typography and
  components from.
- **Folder conventions** (a folder's ⋯ menu → *Conventions…*, or
  *Conventions* in an open folder's bar): Markdown and a style reference set
  by the folder's **owner** only, readable by anyone who can see the folder,
  and inherited by its sub-folders; the nearest folder that has some wins.
  Folders that have them show a small marker.

Precedence: the user's explicit request > folder conventions > preferences.
A style reference counts only for a user who can see that page.

Agents get the preferences in the MCP server instructions at `initialize`
(personalised per user: every request carries the user's token), and, when
they work in a folder, a `conventions` object in the results of `list` (on a
folder), `publish_page`, `create_upload_grant` and `create_bundle_upload`.
Conventions are text written by someone else that lands in another user's
agent, so they are framed as data written by a named user, to respect and
never to execute.

API: `GET/PUT /api/me/preferences` (`{mode, text, styleRefId}`),
`GET/PUT/DELETE /api/folders/{id}/conventions` (`PUT {text, styleRefId}`,
owner only; `GET` answers `{own, effective, canEdit}`, `effective` being the
conventions in force there, perhaps inherited).

## Page storage

A page runs on an opaque origin, where `localStorage`, `sessionStorage` and
cookies throw `SecurityError`. Specola adds a small script to every page it
serves, ahead of the page's own, that puts working ones in their place, so
pages (and libraries) use the standard APIs unchanged:

- **`localStorage` is kept on the server, per user.** Everyone who can see the
  page has their own data, private to them; the owner doesn't see viewers'
  data. It is the same on every version of the page, and follows the page's
  visibility: archived or unshared, it is kept but out of reach.
- Reads are synchronous from the first script: the viewer loads the data
  before loading the page and passes it in the frame's `name`. Writes are
  batched and saved by the viewer, which retries while offline, even after
  the page is gone, and folds unsaved writes into the data it passes next.
  Unsaved writes are also kept in the browser, so they survive reloading or
  closing the app offline and are sent when it next runs online; the copy of
  the data kept for offline is updated with each saved write.
- Up to 1000 keys and 1 MB per user and page; past that `setItem` throws
  `QuotaExceededError`, as the real one does.
- `sessionStorage` and `document.cookie` work in memory, for that load only.
  IndexedDB stays unavailable.
- Only in the viewer: opened raw, or after the page reloads itself or
  navigates its frame, `localStorage` works in memory only and never writes
  to the server, so a page that finds nothing can't overwrite what is saved.
  `window.specola.persistent` tells which; `await specola.flush()` resolves
  once every write so far is saved.
- The page itself still never reaches Specola: the viewer hands it a
  `MessagePort` on its first request after loading it, answers only that
  document, and saves through the API as the signed-in user.
- The script is added when the page is served (after the doctype), not
  stored: the history, search and MCP keep the HTML as published.

API: `GET /api/pages/{id}/data`; `PATCH` with
`{"clear": bool, "set": {...}, "remove": [...]}`, applied at once;
`DELETE` to clear.

## Page backends

A bundle can carry **server code** for its page: a `fetch(request, ctx)`
handler with standard `Request`/`Response`, built by the Vite plugin from
`server/index.ts` into the bundle's `.specola/` directory and reached from
the app with `specola.fetch("/api/…")`. It runs in Node, in the **runner**,
a separate and optional service ([`runner/`](runner/README.md)), with a
SQLite database shared by everyone on the page (`ctx.db`), one per user
(`ctx.userDb`) and a file store (`ctx.files`). Responses stream, uploads are
`FormData`. It can also read **secrets** set by the page's owners, reach the
hosts its manifest allows, **push** to the open page
(`ctx.publish` → `specola.subscribe`), run **scheduled jobs**, and serve
routes to **public links**. The contract is
[docs/page-backends.md](docs/page-backends.md); the plugin side is in
[plugin/README.md](plugin/README.md).

```js
// server/index.ts
export default {
  async fetch(request, ctx) {
    ctx.db.exec("CREATE TABLE IF NOT EXISTS votes (by TEXT PRIMARY KEY, choice TEXT)");
    if (request.method === "POST") {
      ctx.db.prepare("INSERT OR REPLACE INTO votes VALUES (?, ?)").run(ctx.user.sub, await request.text());
    }
    return Response.json(ctx.db.prepare("SELECT choice, count(*) AS n FROM votes GROUP BY choice").all());
  },
};
```

- **Optional.** Without a runner configured, backends are *disabled*:
  everything else works as before, a bundle with a backend is refused at
  upload (`backend-disabled`), and the API (`GET /api/me` has
  `backends: {enabled, available}`), the MCP instructions, the publish form
  and the viewer all say so. A page published with a backend while they
  were on still opens; its `specola.fetch` rejects with `BackendUnavailable`.
  When the runner is configured but not answering (Specola checks its health
  every 30 s), calls answer 503 `backend-unavailable` until it is back.
- **Calls** go frame → viewer (the page's `MessagePort`) →
  `ANY /api/pages/{id}/x/{path}` with the user's session → runner. Specola
  checks access, that the frame shows the current version, the body size
  (25 MiB) and that the user has at most 8 calls running on the page, then
  streams the answer through. Errors Specola or the runner produce carry an
  `X-Specola-Error` code and a JSON body; an uncaught exception answers 500
  `backend-error` with a `ref` to the line of the **backend log**
  (`GET /api/pages/{id}/backend/logs?since=`, owners and editors, and the
  *Log* tab of the viewer's *Backend* panel).
- **Only the current version is live.** On a page whose current version has
  a backend, older versions stay in the history (marked *not viewable*) and
  can be restored, but can't be opened: `/view/{id}?v=N`, the token view and
  pinned public links answer 410. A frame still showing an older version
  gets 409 `superseded` on its calls and the viewer offers to reload it.
  Public links on a backend page can't be pinned.
- **Data belongs to the page, not the version.** It survives new versions;
  the code migrates its own schema. Restoring a version restores code; the
  viewer offers to restore, too, the data as that version left it.
- **Data lifecycle**, in the *Data* tab of the viewer's *Backend* panel
  (`/api/pages/{id}/backend/…`):
  - **Snapshots** of every database and the file index (`VACUUM INTO`, on
    the runner's volume), taken when a new version becomes current (the last
    5 kept), daily when the page is called (7), before every restore,
    import or reset (5), and by hand by an owner, with a label (up to 10).
    They have their own budget (2 GiB per page); past it the oldest
    automatic ones go first. An owner **restores** one: it replaces all of
    the page's data, every user's included, after a snapshot of what was
    there.
  - **Export** (owners and editors): a zip of the shared database and the
    files, with a `manifest.json`. **Import** (owners) takes such a zip
    (≤ 1 GiB), checks all of it first and replaces the shared database and
    the files; users' own databases are never in it.
  - **Reset** (owners): the shared data and files, or every user's data,
    each after a snapshot. **My data** (anyone who can view the page):
    download your own database as a SQLite file, or delete it.
  - Restore, import, reset and snapshots are UI-only; MCP gets none of them.
  Snapshots protect from bad code, not from losing the volume: **back up the
  runner's volume** with the database.
- **Dormant data.** Archiving a page (or a folder above it) keeps its data
  untouched but out of reach; a page whose current version has no backend
  keeps it for a later version that has one (its panel keeps the Data tab).
  With `SPECOLA_BACKEND_PURGE_AFTER_DAYS` set, the data of a page dormant
  that long is deleted with its snapshots (checked every hour); the panel
  and the Archived list show the date from 7 days ahead. Unset, nothing is
  ever purged.
- **Offline**, a backend page is kept at its current version only, and its
  `specola.fetch` rejects with `BackendUnavailable` (`reason: "offline"`).
- **Secrets.** The manifest's `secrets` names what the code reads from
  `ctx.secrets`. Owners set and remove the values in the *Secrets* tab of the
  viewer's *Backend* panel (`PUT/DELETE /api/pages/{id}/secrets/{name}`);
  editors see the list. Nobody can read a value back, through the UI, the API
  or MCP. Values are encrypted with `SPECOLA_SECRETS_KEY` (keep it with the
  database backups: without it they are lost) and sent to the runner with
  each call, only the names the current version declares. The viewer warns
  owners and editors when a declared secret has no value
  (`backendSecretsMissing` on `GET /api/pages/{id}`).
- **Outbound HTTP** from a backend goes through the runner's **egress
  proxy**: only to the hosts the manifest's `egress` lists (`api.example.com`,
  `*.example.org`), on 443 or 80, never to an IP address or to a name that
  resolves to a private, loopback, link-local or metadata address. Refusals
  are in the backend log. Raw sockets (`net`, `tls`) don't go through the
  proxy: to close that, give the runner's container a network policy that
  allows outbound traffic from the proxy only, as
  [runner/README.md](runner/README.md#security-model) explains.
- **Push.** `ctx.publish(topic, data, {to?})` (JSON up to 7 KiB, 50 a
  second per page) reaches the open pages that `specola.subscribe(topic, …)`,
  and only the user `to` names when it is set. The runner posts to Specola,
  which relays with Postgres `NOTIFY`, so every replica serves its own
  streams (`GET /api/pages/{id}/events`, server-sent events). Best effort:
  nothing is replayed after a reconnect. A stream on a version that is no
  longer current tells the viewer, which offers to reload.
- **Scheduled jobs.** The manifest's `cron` (up to 10, 5-field schedules in
  UTC, at most once a minute) calls the handler's `scheduled(event, ctx)`,
  with `ctx.role` `"cron"` and no user, for up to 5 minutes. Specola keeps
  the schedule; every replica ticks every 30 s and claims due jobs in
  Postgres, so a run happens once, and runs missed while down are not caught
  up. Archived pages don't run. The *Jobs* tab shows each job's next and
  last run and its outcome (`GET /api/pages/{id}/backend/cron`).
- **Public routes.** The manifest's `public` routes (`"GET /api/stats"`,
  `"GET /api/public/*"`) and `topics.public` are what a public link's
  visitors may call and subscribe to, with `ctx.role` `"public"`, no user and
  `ctx.link` set; anything else answers them 403 `not-public` without
  reaching the backend. At most 60 calls a minute per link and client IP, and
  600 per link (429 with `Retry-After`). The client IP is the connection's,
  or the first `X-Forwarded-For` hop with `SPECOLA_TRUST_FORWARDED=1`.
- **For agents**, MCP has `call_backend` (a request as the user, as
  `specola.fetch` would send it), `backend_logs`, `backend_query` (one
  read-only SQL statement on the shared database, owners and editors) and
  `list_secrets` (names only); `get_page` carries the manifest and the missing
  secrets. There is no tool to set a secret: a value typed to an agent would
  pass through the model.

### Security model

- **For an instance among trusted people.** Whoever can publish a bundle can
  run Node code on the runner. Workers run one process per page under
  Node's permission model (their code and their own data only, no child
  processes), with memory, time and disk limits: enough to stop accidents
  and keep pages apart, not a sandbox against a deliberately malicious
  author. Put the runner on a private network; for more, an OS-level
  sandbox around its container.
- **Viewer = may call the backend.** Whoever can open the page can send any
  request with any body to its backend, also from devtools: handlers must
  check `ctx.user` and `ctx.role` on every request.
- **Editor = may change the backend**, and so read all its data. Share
  editor access on a backend page accordingly.
- The page still never reaches Specola directly and holds no credential:
  calls go through the viewer as the signed-in user. The internal hop
  (Specola ↔ runner) is authenticated with a shared bearer token both ways;
  `/internal/` answers 404 to anything else.

### Running the runner

Set all three on Specola, or none (Specola refuses to start with only some):

| Var | Meaning |
| --- | --- |
| `SPECOLA_RUNNER_URL` | the runner's base URL on the private network, e.g. `http://runner:8081`; unset = backends disabled |
| `SPECOLA_RUNNER_TOKEN` | shared bearer for the internal API (the runner needs the same value), at least 16 characters, e.g. `openssl rand -base64 32` |
| `SPECOLA_SECRETS_KEY` | 32 bytes, base64 (`openssl rand -base64 32`); encrypts page secrets. Back it up: the secrets can't be read without it |

And, optionally, `SPECOLA_BACKEND_PURGE_AFTER_DAYS`: delete the backend data
of pages dormant (archived, or with no backend in their current version)
for this many days. Unset, never. Behind a reverse proxy that sets
`X-Forwarded-For`, `SPECOLA_TRUST_FORWARDED=1` makes the public routes' rate
limits count per client rather than per proxy; leave it unset when clients
can reach Specola directly, since they could then pick their own IP.

The runner (`node:24-slim` image built from `runner/`, single replica) takes
`SPECOLA_URL` (Specola's internal base URL, where it fetches code),
`SPECOLA_RUNNER_TOKEN`, `RUNNER_DATA_DIR` (its volume, default `/data`) and
`RUNNER_LISTEN` (default `:8081`), plus `RUNNER_*` limits listed in
[runner/README.md](runner/README.md). `docker-compose.yaml` has the service,
network and volume commented out, ready to enable. The runner must reach
Specola at `SPECOLA_URL` (it fetches code there and posts pushes to
`/internal/runner/publish`), and Specola the runner; for the egress
allowlist to hold against raw sockets, see
[runner/README.md](runner/README.md#security-model).

## Search

The search box (and `GET /api/search?q=`, and the MCP `search` tool) searches
the titles and visible text of every page you can see. It uses PostgreSQL
full-text search with web-search syntax: `"quoted phrases"`, `OR`, `-word`.
Matching is on whole words without stemming, so it behaves the same in any
language. The index is updated with every new version.

## Configuration

All via environment variables (see [`specola.env.example`](./specola.env.example)):

| Var | Required | Meaning |
| --- | --- | --- |
| `SPECOLA_DATABASE_URL` | yes | Postgres DSN |
| `SPECOLA_BASE_URL` | yes | public origin, e.g. `https://specola.example.com` |
| `SPECOLA_SESSION_SECRET` | yes* | random ≥32 bytes, signs the session cookie |
| `SPECOLA_OIDC_ISSUER` | prod | OIDC issuer URL, e.g. `https://auth.example.com/oidc`; also enables the MCP endpoint |
| `SPECOLA_OIDC_CLIENT_ID` | prod | OIDC client id |
| `SPECOLA_OIDC_CLIENT_SECRET` | prod | OIDC client secret |
| `SPECOLA_MCP_RESOURCE` | no | audience required on MCP access tokens (default `<base>/mcp`) |
| `SPECOLA_TRUSTED_USER_HEADER` | no | trust this proxy header as the user's `sub` instead of running OIDC |
| `SPECOLA_VIEW_ORIGIN` | no | serve rendered pages from this separate origin, e.g. `https://view.example.com` (needs `SPECOLA_SESSION_SECRET`) |
| `SPECOLA_DEV_AUTH_EMAIL` | dev | bypass OIDC; treat every request as this user (used as both `sub` and email) |
| `SPECOLA_LISTEN` | no | listen address (default `:8080`) |
| `SPECOLA_RUNNER_URL` | no | the page backend runner; with `SPECOLA_RUNNER_TOKEN` and `SPECOLA_SECRETS_KEY`, enables [page backends](#page-backends) |
| `SPECOLA_RUNNER_TOKEN` | with the runner | shared bearer for the internal API (≥ 16 characters) |
| `SPECOLA_SECRETS_KEY` | with the runner | 32 bytes, base64 |
| `SPECOLA_BACKEND_PURGE_AFTER_DAYS` | no | delete the backend data of pages dormant this many days (default: never) |
| `SPECOLA_TRUST_FORWARDED` | no | `1`: the client IP for public links' rate limits is the first `X-Forwarded-For` hop (only behind a proxy that sets it); otherwise the connection's address |
| `SPECOLA_TEST_CRON_EVERY` | **tests only** | the scheduled jobs' tick (a Go duration, at least `100ms`) instead of 30 s. Refused without `SPECOLA_DEV_AUTH_EMAIL` |
| `SPECOLA_TEST_CLOCK_OFFSET` | **tests only** | moves the scheduling clock (jobs, purge) ahead by this duration, so a job due soon runs at once. Refused without `SPECOLA_DEV_AUTH_EMAIL` |

\* Not required when `SPECOLA_DEV_AUTH_EMAIL` is set.

The `SPECOLA_TEST_*` hooks exist for `e2e/backends.mjs`; Specola logs a
warning when they are set. Never set them in production.

## Local development

```sh
# 1. a throwaway Postgres
docker run -d --name specola-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17

# 2. backend (no OIDC — dev bypass)
export SPECOLA_DATABASE_URL="postgres://postgres:dev@localhost:5432/postgres?sslmode=disable"
export SPECOLA_DEV_AUTH_EMAIL="you@example.com"
go run ./cmd/specola

# 3. frontend dev server (proxies /api, /view, /auth to :8080)
cd web && npm install && npm run dev
```

Migrations run automatically on boot.

To try page backends locally, run the runner next to it (Node 22 or later)
and give Specola the same token:

```sh
export SPECOLA_RUNNER_TOKEN=$(openssl rand -base64 32)
(cd runner && SPECOLA_URL=http://localhost:8080 RUNNER_DATA_DIR=./data npm start) &
SPECOLA_RUNNER_URL=http://localhost:8081 SPECOLA_SECRETS_KEY=$(openssl rand -base64 32) go run ./cmd/specola
```

Tests that need a database create a throwaway one per test on the server named
by `SPECOLA_TEST_DATABASE_URL`, and are skipped when it is unset:

```sh
SPECOLA_TEST_DATABASE_URL="postgres://postgres:dev@localhost:5432/postgres?sslmode=disable" go test ./...
```

The runner's tests run with `cd runner && npm test`, the plugin's with
`cd plugin && node --test test/*.test.js` (both: `make test`).

`node e2e/bundles.mjs` publishes a real SPA bundle and checks it in Chromium,
`node e2e/backends.mjs` does the same for a bundle with a backend, against a
real runner, and `node e2e/sdk-bridge.mjs` checks the page ↔ viewer bridge of
backend calls (all three: `make e2e`); see [`e2e/README.md`](e2e/README.md).

## Production (container)

```sh
docker build -t specola .
docker run -p 8080:8080 --env-file specola.env specola
```

Create an OIDC "traditional web" application in your identity provider with the
redirect URI `https://<your-host>/auth/callback`, then fill the `SPECOLA_OIDC_*`
variables.

## MCP endpoint

`/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server
(streamable HTTP) that lets an AI agent publish and organise pages **as the
user**, so they land in that user's gallery.

| Tool | Input | Output |
| --- | --- | --- |
| `publish_page` | `title`, `html`, `folder_id?`, `note?` | `{id, version, url}` |
| `new_version` | `id`, `html`, `note?` | `{version, url}` |
| `list` | `folder_id?`, `shared_with_me?` or `archived?` | folders and pages |
| `get_page` | `id`, `version?` | metadata and the HTML of that version (default current); for a version that can't be opened (a backend page's older one), a note saying so |
| `list_versions` | `id` | the history, newest first, with notes, and per version `backend` and `viewable` |
| `search` | `query`, `limit?` | matching pages with snippets |
| `create_folder` | `name`, `parent_id?` | `{id}` |
| `rename` | `kind`, `id`, `name` | `{ok}` |
| `move` | `kind`, `id`, `folder_id?` (the root when omitted) | `{ok}` |
| `archive` / `unarchive` | `kind`, `id` | `{ok}` |
| `share` | `kind`, `id`, `email`, `role` (`viewer` / `editor` / `none`) | the item's shares |
| `create_public_link` | `id`, `label?`, `version?`, `expires_in_days?` | the link and its `url` (shown only now) |
| `list_public_links` | `id` | the page's public links, with expiry and views |
| `revoke_public_link` | `id`, `link_id` | `{ok}` |
| `create_upload_grant` | `kind` (`new` / `version`), `title?`, `folder_id?`, `id?`, `note?` | one-time upload URL and a `curl` example |
| `create_bundle_upload` | `kind` (`new` / `version`), `title?`, `folder_id?`, `id?`, `note?` | bundle upload URL, the `npx --no -- specola-publish` command to run, the plugin install command, and `backend: {enabled, available, reason?}` |

`list` (on a folder), `publish_page`, `create_upload_grant` and
`create_bundle_upload` also return a `conventions` object when preferences or
folder conventions apply (see [Preferences for agents](#preferences-for-agents)).

Apps with a build step are published as **SPA bundles** with the Vite plugin
in [`plugin/`](plugin/README.md), which each instance serves at
`/tools/specola-vite-plugin-<version>.tgz`; the server instructions steer
agents there. See [`docs/spa-bundles.md`](docs/spa-bundles.md).

The instructions also follow [page backends](#page-backends): with backends
disabled they carry one line saying so (bundles are static, `server/` code
and `specola.fetch` are unavailable, don't design apps that need them) and
nothing else about them; with backends enabled, a *PAGE BACKENDS* section on
how to add one, what `ctx` offers, who may call it, and what is not
available yet. MCP tools to call a backend, read its log or query its data
come in a later step.

The same access rules as the UI apply to every tool. Tools carry MCP
annotations: the reading ones (`list`, `get_page`, `list_versions`, `search`,
`list_public_links`) are `readOnlyHint`, which clients such as Hermes use to retry them safely and
to skip confirmation; the organising ones are `idempotentHint`.

Large pages shouldn't travel as tool arguments (models truncate long outputs),
so an agent can ask for an **upload grant** and send the file over plain HTTP:

```sh
curl -sS -X PUT -H 'Content-Type: text/html' --data-binary @page.html \
  https://specola.example.com/upload/<token>
# → {"id": "...", "version": 1, "url": "https://specola.example.com/#/p/..."}
```

A grant is single-use and valid for 10 minutes; only its sha256 is stored.
Access is checked again when it is redeemed, so access lost in between is
respected. Used or expired grants answer 410.

Specola is an OAuth 2.1 **resource server**. `/mcp` requires
`Authorization: Bearer <JWT>` issued by `SPECOLA_OIDC_ISSUER` with
`aud` = `SPECOLA_MCP_RESOURCE`; the token's `sub` is the user. Unauthenticated
requests get a 401 whose `WWW-Authenticate` header points clients at
`/.well-known/oauth-protected-resource` (RFC 9728), which names the issuer as
the authorization server.

With the dev bypass and no issuer, `/mcp` needs no token and acts as the dev
user. With neither, it is off.

### Logto setup

Logto has no Dynamic Client Registration; it supports **Client ID Metadata
Documents**, which MCP clients use instead.

1. Create an **API resource** whose indicator equals `SPECOLA_MCP_RESOURCE`
   (e.g. `https://specola.example.com/mcp`). Without it Logto won't issue a
   JWT with that audience.
2. Enable **Dynamic apps**: Console → Applications → Third-party apps →
   Dynamic app (Logto ≥ 1.43, OIDC SSRF protection left on).
3. Grant the dynamic app permission on that API resource.
4. Optional, Logto ≥ 1.44: turn on "Add consent prompt for offline access" so
   MCP clients get refresh tokens.

CIMD clients then connect without being registered in advance.

## Security notes

- Rendered pages are served with `Content-Security-Policy: sandbox` and shown
  in a sandboxed iframe without `allow-same-origin`, so they run on an opaque
  origin and cannot read Specola's cookies or call its API. `frame-ancestors`
  stops other sites from framing them. Their only way to Specola is their
  `localStorage`, saved by the viewer and scoped to that page and user.
- For defense in depth, set `SPECOLA_VIEW_ORIGIN` to a second hostname that
  also reaches Specola (requests are routed by `Host`). Pages are then served
  only from that origin, which serves nothing else (the pages, public links,
  and SPA bundle files under `/b/`), and the app origin refuses `/view` and
  `/b/`. The view origin has no session: the SPA gets a signed view token
  (one user, one page, valid for an hour) with the page metadata, and access
  is still checked on every request, so removing a share takes effect at once
  for the page. Not for an SPA bundle's files: they are reached by a
  per-version key in the page's HTML, with no user check, so someone who
  loaded a version keeps access to its files until the page is archived (see
  Public links).
  Responses carry `Referrer-Policy: no-referrer` so the token doesn't leak.
  They also allow CORS reads from the app origin, which is how the app keeps
  pages for offline viewing; offline, a kept page is rendered from the app
  origin in the sandboxed iframe, without the separate origin.
- Page backends run page authors' code on the runner: see
  [their security model](#security-model). Backend answers are relayed to
  the viewer's `fetch` only, never rendered on the app origin
  (`X-Specola-Version` is required, and they carry `Content-Security-Policy:
  sandbox`).
- No secrets are committed; only `*.env.example` placeholders.

## License

MIT
