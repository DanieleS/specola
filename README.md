# Specola

Self-hosted viewer for **versioned, interactive HTML pages**. Publish a
self-contained HTML page (an explainer, a report, a small interactive app),
organise pages in folders, keep a version history, and share them read-only or
read-write with other people — all behind your own OIDC login.

Until sharing lands, every folder and page is private to the user who created
it; anything else answers 404.

Pages are rendered in a sandboxed iframe with an opaque origin, so a page's
scripts can run without being able to touch Specola's session or API.

> Status: early. Publish, browse, version, view, and an OAuth-protected MCP
> endpoint for agents. Sharing ACLs and search land next.

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
- **asset_version** — immutable history; the HTML lives inline in `content`.
- **acl_entry** — one user (`sub`), one role (`VIEWER` / `EDITOR`) on a folder *xor* an
  asset. A folder grant is inherited by everything beneath it.
- **asset_grant** — short-lived, single-use token so a client can `curl` a large
  HTML body instead of inlining it in a request.
- **favorite** — personal stars.

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
(streamable HTTP) that lets an AI agent publish pages **as the user**, so they
land in that user's gallery.

| Tool | Input | Output |
| --- | --- | --- |
| `publish_page` | `title`, `html`, `folder_id?` | `{id, version, url}` |
| `new_version` | `id`, `html` | `{version, url}` |
| `list` | `folder_id?` | folders and pages |
| `get_page` | `id` | metadata and the current HTML |

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

- Rendered pages are served with `Content-Security-Policy: sandbox` so they run
  on an opaque origin and cannot read Specola's cookies. For stronger isolation,
  serve `/view/*` from a separate hostname.
- No secrets are committed; only `*.env.example` placeholders.

## License

MIT
