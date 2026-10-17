# Specola

Self-hosted viewer for **versioned, interactive HTML pages**. Publish a
self-contained HTML page (an explainer, a report, a small interactive app),
organise pages in folders, keep a version history, and share them read-only or
read-write with other people — all behind your own OIDC login.

Pages are private to their author until shared. An item you can't see answers
404; one you can see but not change answers 403.

Pages are rendered in a sandboxed iframe with an opaque origin, so a page's
scripts can run without being able to touch Specola's session or API.

> Status: early. Publish, browse, version with notes, view, share, favorites,
> full-text search, offline viewing as an installable PWA, and an
> OAuth-protected MCP endpoint for agents.

## Stack

Small on purpose: a single static Go binary serves a JSON API, the sandboxed
page viewer, and the built SPA.

| Area | Choice |
| --- | --- |
| Backend | Go, [`chi`](https://github.com/go-chi/chi) router, [`pgx`](https://github.com/jackc/pgx), [`goose`](https://github.com/pressly/goose) migrations |
| Database | PostgreSQL (HTML stored inline) |
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
  with an optional `note` on what changed.
- **acl_entry** — one user (`sub`), one role (`VIEWER` / `EDITOR`) on a folder *xor* an
  asset. A folder grant is inherited by everything beneath it.
- **asset_grant** — short-lived, single-use token so a client can `curl` a large
  HTML body instead of inlining it in a request.
- **favorite** — personal stars.
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
  page costs no download.
- `/view/{id}` (the current version) carries a weak `ETag` from the version's
  content hash and `Cache-Control: private, no-cache`; a matching
  `If-None-Match` answers 304 without reading the HTML out of the database.
- The SPA shell is `no-cache`, so a deploy reaches the browser at once; the
  bundle under `/assets/` has hashed names and is cached for a year.

## Offline and install (PWA)

Specola is an installable Progressive Web App (manifest, icons, service
worker), and pages can be read without a connection.

- **Kept pages**: every page you open is kept on the device (the last 30).
  **Save offline** in the viewer pins a page: it is never evicted and is
  brought up to its current version each time Specola opens online; pages
  you've lost access to are dropped then. The **Offline** tab lists what the
  device keeps, readable with no network.
- **Lists and metadata** you've browsed (folders, favorites, shared, history)
  are read from the service worker's copy when the server can't be reached.
  Search, publishing and every change need a connection.
- Offline, a kept page is shown from a `blob:` URL in the same sandboxed
  iframe (no `allow-same-origin`), so its scripts still run on an opaque
  origin.
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

\* Not required when `SPECOLA_DEV_AUTH_EMAIL` is set.

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

Tests that need a database create a throwaway one per test on the server named
by `SPECOLA_TEST_DATABASE_URL`, and are skipped when it is unset:

```sh
SPECOLA_TEST_DATABASE_URL="postgres://postgres:dev@localhost:5432/postgres?sslmode=disable" go test ./...
```

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
| `get_page` | `id`, `version?` | metadata and the HTML of that version (default current) |
| `list_versions` | `id` | the history, newest first, with notes |
| `search` | `query`, `limit?` | matching pages with snippets |
| `create_folder` | `name`, `parent_id?` | `{id}` |
| `rename` | `kind`, `id`, `name` | `{ok}` |
| `move` | `kind`, `id`, `folder_id?` (the root when omitted) | `{ok}` |
| `archive` / `unarchive` | `kind`, `id` | `{ok}` |
| `share` | `kind`, `id`, `email`, `role` (`viewer` / `editor` / `none`) | the item's shares |
| `create_upload_grant` | `kind` (`new` / `version`), `title?`, `folder_id?`, `id?`, `note?` | one-time upload URL and a `curl` example |

The same access rules as the UI apply to every tool. Tools carry MCP
annotations: the reading ones (`list`, `get_page`, `list_versions`, `search`)
are `readOnlyHint`, which clients such as Hermes use to retry them safely and
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
  stops other sites from framing them.
- For defense in depth, set `SPECOLA_VIEW_ORIGIN` to a second hostname that
  also reaches Specola (requests are routed by `Host`). Pages are then served
  only from that origin, which serves nothing else, and the app origin refuses
  `/view`. The view origin has no session: the SPA gets a signed view token
  (one user, one page, valid for an hour) with the page metadata, and access
  is still checked on every request, so removing a share takes effect at once.
  Responses carry `Referrer-Policy: no-referrer` so the token doesn't leak.
  They also allow CORS reads from the app origin, which is how the app keeps
  pages for offline viewing; offline, a kept page is rendered from the app
  origin in the sandboxed iframe, without the separate origin.
- No secrets are committed; only `*.env.example` placeholders.

## License

MIT
