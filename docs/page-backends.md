# Page backends — design and contract

Status: **implemented** — all seven steps of the delivery plan, checked
end to end in Chromium by `e2e/backends.mjs`. Where the code refines this
contract, the "Settled in implementation" notes say so; known limits and
open questions are listed there and at the end.

A **page backend** is server-side code that ships inside an SPA bundle,
next to the app, and that the page reaches through Specola. It runs in
Node, in a separate, optional service (the **runner**), with a SQLite
database of its own, a key/value file store, outbound HTTP to declared hosts
with secrets the page never sees, scheduled jobs and push to open pages.

The page talks to it over standard `Request`/`Response`:

```js
// in the app (the frame)
const res = await specola.fetch("/api/orders", { method: "POST", body: JSON.stringify(order) });

// server/index.ts (the backend, in the same project)
export default {
  async fetch(request, ctx) {
    const order = await request.json();
    ctx.db.prepare("INSERT INTO orders (by, body) VALUES (?, ?)").run(ctx.user.sub, JSON.stringify(order));
    ctx.publish("orders", { added: 1 });
    return Response.json({ ok: true });
  },
};
```

This document is the contract between the server, the runner, the
plugin/CLI, the page SDK and the SPA. Keep it in sync with the code.

## Goals and non-goals

- Arbitrary server-side logic per page, versioned with the app it belongs
  to: one bundle version = one frontend + one backend. Only the current
  version of a page with a backend is live (see Versions).
- Standard web APIs (`fetch(request, ctx)` handlers, `Request`, `Response`,
  streams), so routers like Hono work unchanged.
- Batteries included: SQLite (shared and per user), a file store, outbound
  HTTP with secrets, cron, realtime push, streaming responses, uploads.
- Specola stays a single small Go binary: the backend runtime is a separate
  service, and **optional**. Without it everything else keeps working, and
  every surface (MCP, API, UI) says plainly that backends are off.
- The page still never reaches Specola directly, holds no credential, and
  stays on an opaque origin. The bridge is the same `MessagePort` that
  carries `localStorage` today.
- Non-goals (v1): backends for single-file pages (only bundles), npm
  packages with native addons, more than one runner replica, per-page
  resource accounting/billing, a hostile-tenant sandbox (see Trust model).

## Trust model

**Specola with backends enabled is for an instance among trusted people.**
Anyone who can publish a bundle can run Node code on the runner. The runner
applies Node's permission model, process separation, resource limits and an
egress proxy, which stop accidents and keep pages from stepping on each
other; it is **not** a sandbox against a deliberately malicious author (raw
sockets, CPU exhaustion within limits, reading other processes' memory are
not defended against). An operator who wants more puts the runner container
behind a network policy and an OS-level sandbox; nothing in the contract
prevents that.

Consequences that hold whatever the hardening:

- **Viewer = may call the backend.** Whoever can open the page can send any
  request to its backend, with any body, including from devtools in the
  frame. Backend code must treat every request as untrusted input and decide
  per request using `ctx.user` / `ctx.role`.
- **Editor = may change the backend**, so an editor of a page can read its
  secrets (by publishing code that prints them) and all its data. Share
  editor access on a page with a backend accordingly.
- **Public link = anonymous caller**, limited to the routes the manifest
  declares public (see Public links).
- The frame's network is **not** closed (the CSP stays `sandbox …` as
  today): a page may still call external APIs directly. Secrets stay safe
  because they never reach the frame; data the backend returns to the page
  can be sent anywhere by the page, as any data a page holds today.

## Architecture

```
 frame (opaque origin)          viewer (app origin)            specola (Go)                 runner (Node)
 ─────────────────────          ───────────────────            ────────────                 ─────────────
 specola.fetch(req) ──port──▶   fetch /api/pages/{id}/x/… ──▶  auth + ACL, version,   ──▶  worker per (page, version)
                     ◀─port──   stream chunks back         ◀── secrets, limits        ◀──  node:sqlite, files, egress
 specola.subscribe() ◀─port──   EventSource /events        ◀── LISTEN/NOTIFY          ◀──  ctx.publish
                                                               cron scheduler         ──▶  scheduled(event, ctx)
```

- **specola** owns identity, access, versions, secrets, the cron schedule
  and fan-out of pushes. It never runs page code.
- **runner** owns the processes, the data on its volume (SQLite, files) and
  the egress proxy. It trusts specola (shared token) and nothing else.
- The internal hop is plain HTTP on a private network, authenticated by
  `Authorization: Bearer $SPECOLA_RUNNER_TOKEN` in both directions.

### Enabled or not

Backends are enabled when `SPECOLA_RUNNER_URL` is set (with
`SPECOLA_RUNNER_TOKEN` and `SPECOLA_SECRETS_KEY`; specola refuses to start
with only some of them). Specola checks `GET {runner}/health` at start and
every 30 s (every 5 s while it is failing), and a call that cannot reach
the runner marks it unavailable at once; "enabled" is a configuration fact,
"available" is the latest health check. `SPECOLA_RUNNER_TOKEN` must be at
least 16 characters.

When **disabled** (not configured):

- A bundle upload whose manifest contains a backend (`.specola/backend.json`)
  is refused at `POST …/manifest` with 400 `backend-disabled` and a message
  saying this instance has no backend runner, so the plugin fails before
  uploading anything.
- MCP: the server `instructions` carry an explicit line, *"Page backends are
  not enabled on this instance: bundles are static, `server/` code and
  `specola.fetch` are unavailable. Do not design apps that need them."*, and
  `create_bundle_upload` returns `backend: {enabled: false, reason}`.
- `GET /api/me` carries `backends: {enabled, available}`; the publish hint
  and the viewer say so where relevant.
- A page whose version has a backend (published while enabled) still opens;
  `specola.fetch` rejects with `BackendUnavailable` (`reason: "disabled"`),
  and the viewer shows a one-line notice.

When **enabled but unavailable** (health check failing): uploads are
accepted, calls answer 503 `backend-unavailable`, MCP `instructions` say
backends are enabled, and tool results that touch them carry the current
state.

## Bundle layout and manifest

The backend travels inside the bundle under the reserved prefix
`.specola/`:

| Path | What |
| --- | --- |
| `.specola/backend.json` | the manifest; its presence makes the version a **backend version** |
| `.specola/server/index.mjs` | the entry, a single ESM file built by the plugin |
| `.specola/server/*` | other server chunks/assets, if any |

Files under `.specola/` are stored like any bundle file
(`asset_version_file`) but **never served** by `/b/{key}/…` (404), not
listed by `GET …/files`, not kept offline and not indexed by search. Only
the runner reads them, through the internal API.

```json
{
  "version": 1,
  "entry": "server/index.mjs",
  "public": ["GET /api/stats", "POST /api/votes", "GET /api/public/*"],
  "egress": ["api.openai.com", "*.googleapis.com"],
  "secrets": ["OPENAI_API_KEY"],
  "cron": [{ "name": "nightly", "schedule": "0 3 * * *" }],
  "topics": { "public": ["scoreboard"] }
}
```

- `entry` — relative to `.specola/`, must exist in the bundle and end in
  `.mjs`/`.js`.
- `public` — routes an anonymous public-link visitor may call: `METHOD
  /path`, `*` as the last segment matching any rest of the path. Default
  none.
- `egress` — hosts the backend may reach over HTTP(S); a leading `*.`
  matches subdomains. Default none. No IP literals, no ports other than
  443/80.
- `secrets` — names (`[A-Z][A-Z0-9_]{0,63}`) the code expects. Values are
  set by the page owner (see Secrets); the list lets the UI and MCP say which
  are missing.
- `cron` — up to 10 jobs; 5-field cron in UTC, at most once a minute.
- `topics.public` — push topics a public-link visitor may subscribe to.

The upload's manifest step only knows paths and hashes, so it checks the
layout (`.specola/` files need a `.specola/backend.json`, at most 64 KiB)
and refuses backends when they are disabled; `backend.json` itself is
validated at commit, once its bytes are there (errors are 400 and name the
field; the commit refuses a backend when backends are disabled too).
Besides the rules above: unknown fields are refused; `public`, `egress`,
`secrets` and `topics.public` hold at most 100 entries, without duplicates;
methods are GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS; egress hosts may
end in `:443` or `:80`; a cron job name is 1–64 of `[A-Za-z0-9_.-]`, a topic
1–128 of `[A-Za-z0-9_.:/-]`, and cron macros (`@daily`) are refused;
`entry` defaults to `server/index.mjs`. It is stored parsed on the
version (`asset_version.backend jsonb`), so specola reads routes, secrets and
cron without touching blobs.

## Versions: only the current one is live

A page whose **current** version has a backend is a **backend page**. Its
data is one live state, so an older frontend+backend pair has nothing
coherent to show, and running it would write today's data with yesterday's
code. So:

- **A version can be opened only if it is the current one, or if neither
  it nor the current version has a backend.** On a backend page every older
  version is closed, with or without a backend of its own; on a page that
  went static, its old backend versions are closed (there is nothing to
  run them).
- A closed version answers **410 `superseded`** on `/view/{id}?v=N`, the
  token view and pinned public links; the viewer shows "This page has a
  backend: only its current version can be opened" with a link to it,
  instead of the frame.
- **History is kept.** Versions stay in the list with their notes, marked
  "not viewable", and **Restore** still works: it makes a new current
  version from the old one, which is the undo for a bad deploy. Restore
  brings back code, not data; the viewer offers to restore, too, the data
  snapshot taken when that version stopped being current (see Data
  lifecycle). Deleting versions would break Specola's "nothing is ever
  overwritten" rule for no gain: they cost only storage.
- MCP `get_page` with a `version` still returns that version's source (it
  reads it, it doesn't run it), with a note that it can't be opened.
- **Public links** on a backend page can't be pinned (400 `backend-pinned`);
  a link pinned earlier to a version that is now closed answers 410.
- **Offline** keeps only the current version of a backend page.
- **Version skew.** When a new version becomes current, frames still
  showing the old one get **409 `superseded`** from `/x/…` and from the
  events stream (specola compares `X-Specola-Version` with the current
  version). The SDK rejects with `BackendUnavailable`
  (`reason: "superseded"`) and the viewer shows "A new version is
  available — Reload". Requests already running finish on the old worker.

## Handler contract

The entry's default export is an object with any of:

```ts
export default {
  fetch?(request: Request, ctx: Ctx): Response | Promise<Response>;
  scheduled?(event: { name: string; scheduledTime: number }, ctx: Ctx): void | Promise<void>;
};
```

`request.url` is `https://page.invalid/<path>?<query>` (the path the page
asked for; the origin is a fixed placeholder). Request headers are only
those the page set (see Viewer ↔ specola), minus `Cookie`, `Host`,
`Content-Length`, `Accept-Encoding`, hop-by-hop headers, anything
`X-Specola-*` and the trusted-user header when one is configured.
Response headers dropped by the runner, specola and the dev server alike:
`Set-Cookie`, `Content-Length`, hop-by-hop ones, every `Access-Control-*`,
and those that act on the whole origin (`Clear-Site-Data`, `NEL`,
`Report-To`, `Reporting-Endpoints`, `Strict-Transport-Security`, `Alt-Svc`,
`Accept-CH`, `Critical-CH`, `Origin-Agent-Cluster`,
`Service-Worker-Allowed`, `Set-Login`, `Refresh`). Specola adds
`X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox;
default-src 'none'` and, when the handler sets none, `Cache-Control:
private, no-store`.

```ts
interface Ctx {
  user: { sub: string; email: string; name: string } | null; // null: anonymous or cron
  role: "owner" | "editor" | "viewer" | "public" | "cron";
  link: { id: string; label: string } | null;                 // the public link used, if any
  page: { id: string; version: number; title: string };
  db: DatabaseSync;            // node:sqlite, shared by everyone on this page
  userDb: DatabaseSync | null; // node:sqlite, private to ctx.user (null when anonymous/cron)
  files: FileStore;            // per-page key/value blobs on disk
  secrets: Record<string, string>; // only the names declared in the manifest
  publish(topic: string, data: unknown, opts?: { to?: string /* sub */ }): void;
  waitUntil(p: Promise<unknown>): void; // keep the worker alive after responding
  log: Console;                // same as console; lines go to the backend log
}
```

- **Databases.** A page gets both, opened lazily on first access, so one
  page can be "a shared app" (`db`), "a private tool per person"
  (`userDb`), or both (shared catalogue, private drafts). Schema is the
  code's job (migrate on first access; `PRAGMA user_version` is the usual
  way). Data belongs to the **page**, not the version: restoring a version
  restores code, never data, unless the owner also restores a snapshot
  (see Data lifecycle).
- **Files.** `files.put(key, body, {contentType})`, `get(key)` →
  `{body: ReadableStream, size, contentType} | null`, `delete(key)`,
  `list(prefix?)`. Keys like bundle paths. For uploads: the page sends a
  `FormData`, the handler reads `await request.formData()` and stores.
- **Outbound HTTP** is the global `fetch`, routed through the runner's
  egress proxy, which allows only the manifest's `egress` hosts (others get
  a `403` from the proxy, which `fetch` surfaces as a failed request with a
  clear message in the backend log).
- `console.*` and uncaught errors go to the **backend log** (see
  Observability).

## Transport

### Frame ↔ viewer (the port)

The SDK adds `specola.fetch(input, init)` (same signature as `fetch`;
relative paths only: `/…` resolved against the backend, anything else is a
`TypeError`) and `specola.subscribe(topic, onMessage)` → `unsubscribe()`.
It also adds `specola.backend`: `{enabled, available}` from boot data, so an
app can degrade.

Messages on the existing port (all carry a request `id` chosen by the SDK):

| Direction | Message |
| --- | --- |
| frame → viewer | `{op:"fetch", id, method, path, headers:[[k,v]…], body?: ArrayBuffer}` (body transferred) |
| viewer → frame | `{op:"head", id, status, headers}` then `{op:"chunk", id, data: ArrayBuffer}`… then `{op:"end", id}` |
| viewer → frame | `{op:"error", id, name, message}` (`BackendUnavailable`, `NetworkError`, `AbortError`) |
| frame → viewer | `{op:"abort", id}` (from the request's `AbortSignal`) |
| frame → viewer | `{op:"sub", topic}` / `{op:"unsub", topic}` |
| viewer → frame | `{op:"event", topic, data}` |

The SDK builds the `Response` on `head` with a `ReadableStream` fed by the
chunks, so streaming (LLM output, long exports) works without transferable
streams. Request bodies are sent whole (limit below); a `FormData` or
`Blob` body is serialised by the SDK with `new Response(body)` first, so
multipart boundaries are right.

The rules that protect the bridge today still hold: one port per frame
load; a second hello is refused; the viewer only answers that document.

### Viewer ↔ specola

`ANY /api/pages/{id}/x/{path…}` (session cookie), with
`X-Specola-Version: N` — the version the frame shows; it is required,
which also keeps navigations and cross-site requests out. The viewer copies
method and body, and sends the page's own headers in
`X-Specola-Headers: <base64url(JSON [[name, value]…])>`: specola forwards
only those, so credentials the browser adds on its own (cached Basic auth)
or a proxy in front adds never reach page code. The call is full duplex,
and the response body streams back as chunks. Pushes: one `EventSource` per open backend page, `GET
/api/pages/{id}/events?topic=a&topic=b`, reopened when the subscription set
changes.

Specola:

1. authenticates, checks the user can **view** the page (404/403 as
   everywhere), that `X-Specola-Version` is the current version (409
   `superseded`) and that it has a backend (404 `no-backend`);
2. resolves the role (owner/editor/viewer);
3. checks limits (body size, concurrent requests per user and page);
4. forwards to the runner with the request, the `ctx` identity, the
   version's code reference and the page's declared secrets (decrypted);
5. streams the runner's response through, flushing each chunk.

Only the current version runs: calls, cron and pushes alike (see
Versions).

### specola ↔ runner (internal)

- `POST {runner}/invoke` — JSON head (`page`, `version`, `codeHash`,
  `ctx` identity, `secrets`, `egress`, `request` head) then the raw body;
  answers with the handler's status, headers and streamed body.
- `POST {runner}/scheduled` — same, with the cron event and no request.
- `GET {runner}/logs?page=…` — recent log lines of a page.
- `GET {runner}/health`.
- Runner → specola: `GET /internal/runner/code/{versionId}` (the
  `.specola/` files of a version, as JSON, see Wire formats; cached on the runner's
  disk by `codeHash`) and `POST /internal/runner/publish` (a push).

`/internal/*` is only on the app listener, requires the runner token, and
answers 404 otherwise.

### Wire formats (exact)

**Errors that specola or the runner produce** (as opposed to the handler's
own responses, which pass through untouched whatever their status) carry
the header `X-Specola-Error: <code>` and a JSON body
`{"error":"<code>","message":"…","ref"?:"…"}`. Codes: `no-backend` (404),
`superseded` (409), `backend-disabled` (503), `backend-unavailable` (503),
`body-too-large` (413), `too-many-requests` (429), `backend-error` (500,
uncaught exception, `ref` names the log line), `backend-crashed` (502),
`backend-timeout` (504), `bad-request` (400, e.g. a missing or
non-numeric `X-Specola-Version`), and the access codes `not-found` (404),
`forbidden` (403) and `internal` (500). One exception to the JSON body: a
closed version opened as a page (`/view?v=N`, the token view, a pinned
link) answers 410 with a small HTML page saying so and linking to the
current version, with `X-Specola-Error: superseded`. The viewer turns
`backend-disabled`, `backend-unavailable` and `superseded` into
`{op:"error", id, name:"BackendUnavailable", reason, message}` (`reason` is
`disabled`, `unavailable` or `superseded`); every other response, these
codes included, reaches the page as a `Response`.

**Boot data**: the SDK's boot JSON gains `backend: bool`, true when the
version served has a backend (`asset_version.backend` non-null) and
backends are enabled. The viewer's port handover becomes
`{specola:"port", backend:{enabled, available}}` (the same values as
`GET /api/me`), and the SDK exposes them as `specola.backend`
(`{enabled:false, available:false}` until the port arrives, or forever on
a page without a backend).

**Version data**: `GET /api/pages/{id}`, `GET /api/pages/{id}/versions`
and MCP `list_versions` carry, per version, `backend: bool` and
`viewable: bool` (the rule in Versions). The page carries `backend` for its
current version.

**`asset_version` columns**: `backend jsonb NULL` (the validated manifest,
normalised: defaults filled in) and `backend_hash text NULL`: the hex
sha256 of the lines `"<path>\t<sha256>\n"` of every file under `.specola/`
(path relative to `.specola/`), sorted by path. It identifies the code.

**specola → runner `POST /invoke`**: headers `Authorization: Bearer
<token>`, `X-Specola-Invoke: <base64url(JSON)>`, body the request body
(raw, possibly empty). The JSON:

```json
{
  "page": {"id": "…", "version": 3, "title": "…"},
  "versionId": "<asset_version.id>",
  "codeHash": "<backend_hash>",
  "user": {"sub": "…", "email": "…", "name": "…"},
  "role": "owner",
  "link": null,
  "secrets": {},
  "egress": [],
  "request": {"method": "POST", "path": "/api/orders?x=1", "headers": [["content-type", "application/json"]]}
}
```

The runner answers with the handler's status, headers and body
(streamed), or with one of the error codes above. `user` is null for
anonymous and cron calls.

**runner → specola `GET /internal/runner/code/{versionId}`**: bearer
token; answers `{"codeHash":"…","files":[{"path":"backend.json","content":"<base64>"},
{"path":"server/index.mjs","content":"<base64>"}]}`: every file under
`.specola/`, paths relative to it. 404 for a version without a backend.

**runner `GET /logs?page=<id>&since=<seq>`** → `{"lines":[{"seq":12,
"time":"<RFC 3339>","level":"log|info|warn|error","text":"…","ref"?:"…"}]}`,
oldest first, at most 1000. specola exposes it to owners and editors as
`GET /api/pages/{id}/backend/logs?since=<seq>` (same body).

**runner `GET /health`** → `{"ok":true,"version":"<runner version>"}`.

**Version switch**: the runner keeps, per page, the version its worker
runs. An `/invoke` for a newer version of the page snapshots the data
(`VACUUM INTO` every database under `snapshots/<UTC timestamp>-v<old>/`,
plus a copy of `files.sqlite`), keeps the last 5 such snapshots, starts the
new worker and drains the old one. An `/invoke` for an older version than
the one running answers `superseded` (specola should have refused it).

## Runner

A small Node service (`runner/` in this repo, its own image on
`node:24-slim`), single replica, with a data volume:

```
/data/code/{codeHash}/…                 extracted .specola/ files
/data/pages/{pageId}/shared.sqlite
/data/pages/{pageId}/users/{sha256(sub)}.sqlite
/data/pages/{pageId}/files.sqlite        the file store's index
/data/pages/{pageId}/files/blobs/{sha256}
/data/snapshots/{pageId}/{UTC stamp}-v{old}/
/data/state/{pageId}.json                the version the page's worker runs
```

Snapshots are outside the page directory so page code cannot change them;
the worker may only read them (the file store needs to know which blobs
they still name). Partial snapshots (`.tmp-*`) are removed on failure and
swept at start. Only `shared.sqlite`, `files.sqlite` and
`users/<hex>.sqlite` are snapshotted; a database SQLite reports as broken
is left out with a warning instead of blocking the switch. Snapshots also
have their own budget (`RUNNER_SNAPSHOT_DISK_BYTES`, 2 GiB), oldest first,
always keeping the newest.

- **One worker process per page**, running its current version, started
  on first request, kept warm, stopped after 5 minutes idle. When a new
  version becomes current, the runner snapshots the data (see Data
  lifecycle), then starts a new worker for it and lets the old one drain
  its in-flight requests. Each worker runs
  with `node --permission --allow-fs-read=<its code dir>,<its page dir>,
  <its snapshots dir>,<the runner's worker bootstrap> --allow-fs-write=<its
  page dir>` and no child processes, workers or addons,
  `--max-old-space-size` from the limits, and its own minimal environment
  (`TZ=UTC`, `NODE_ENV=production`, `LANG=C.UTF-8`; no runner secrets). From
  step 3 it also gets `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY`/`HTTP_PROXY`
  pointing at the egress proxy with a per-worker credential; until then
  outbound HTTP is unrestricted.
- **Start-up**: a worker whose entry has not finished loading within the
  first-byte timeout is stopped; the call answers 500 `backend-error` with a
  `ref`, and the log says the entry did not finish loading.
- **Egress proxy**: in the runner process; HTTP `CONNECT` and plain HTTP;
  identifies the worker by its credential and allows only the hosts of that
  version's `egress`. Private, loopback and link-local addresses are refused
  after DNS resolution whatever the allowlist says (no SSRF into the
  runner's network).
- **Limits** per request (wall time, response bytes), per worker (memory,
  concurrent requests) and per page (disk), see Limits. A worker that
  exceeds memory is killed and the request answers 502 `backend-crashed`.
- SQLite files are opened by the page's worker only (and read-only by the
  runner for snapshots, exports and `backend_query`); WAL mode. During a
  version switch the draining worker and the new one overlap briefly;
  SQLite's locking serialises their writes.
- **Single replica, by design**: the data lives on the runner's volume.
  Sharding pages across runners is possible later without changing this
  contract.

## Secrets

- Stored by specola: `page_secret(asset_id, name, ciphertext, nonce,
  updated_by, updated_at)`, AES-256-GCM with `SPECOLA_SECRETS_KEY`.
- **Set and removed by the page's owners only**, from the viewer's
  "Backend" panel (`PUT/DELETE /api/pages/{id}/secrets/{name}`). Nobody can
  read a value back through the UI or API; `GET /api/pages/{id}/secrets`
  lists names declared by the current version with `set: bool` and
  `updatedAt`.
- Passed to the runner per invocation, only the names the version declares.
- MCP gets `list_secrets` (names and whether set) but **no tool to set
  one**: a secret typed to an agent goes through the model's context. The
  MCP result says which are missing and that the owner sets them in the UI.

## Realtime push

`ctx.publish(topic, data, {to?})` from `fetch` or `scheduled`. Runner →
specola `POST /internal/runner/publish` → `NOTIFY specola_push` (payload up
to 7 KiB of JSON; larger is an error in the backend log), so every specola
replica delivers to its own open `EventSource`s. A subscriber gets an event
when it can view the page (re-checked when the stream opens and every 5
minutes), subscribed to the topic, and `to` is empty or its `sub`. Public
link visitors only get topics in `topics.public`, and never targeted ones.
Delivery is best effort: no replay after a reconnect.

## Scheduled jobs

Specola owns the schedule: a `backend_cron(asset_id, name, schedule,
next_run_at, last_status, last_run_at)` table, rewritten when a page's
current version changes. A ticker (every 30 s) claims due rows with
`FOR UPDATE SKIP LOCKED` (so replicas never double-fire), calls
`/scheduled`, records the outcome. Missed runs while down are not caught up:
one run, then the next slot. Archived pages don't run.

## Public links

Today `/s/{token}` serves the page as the whole document, with no viewer
around it to relay. For a **backend version** it instead serves a minimal
shell that frames the page (same sandbox) and relays the port to
`ANY /p/{token}/x/{path…}` and `GET /p/{token}/events` (no session), served
on the same origin as `/s/{token}` (the view origin when set), so the shell
needs no CORS:

- only routes matching `public` reach the runner; others answer 403
  `not-public` without invoking anything;
- `ctx.user = null`, `ctx.role = "public"`, `ctx.link` set, `userDb = null`;
- links on a backend page always follow the current version (see
  Versions);
- rate limits per link and per client IP (below);
- revoking the link stops calls at once, as it stops serving.

Pages without a backend keep today's `/s/{token}` behaviour.

## Observability

- **Backend log**: the runner keeps the last 1000 lines per page (console
  output, uncaught errors with stack, egress refusals, crashes, cron
  outcomes), in memory. Owners and editors read it in the viewer's
  "Backend" panel and through MCP `backend_logs(id, since?)`.
- **Errors to the page** are sanitised: an uncaught exception answers 500
  with `{"error":"backend-error","ref":"<id>"}`; the stack is in the log
  under that `ref`.
- MCP `call_backend(id, method, path, body?)` lets an agent exercise the
  backend as its user, to test what it published (returns status, headers
  and up to 64 KiB of body).
- MCP `backend_query(id, sql)` (owners and editors) runs read-only SQL on
  the shared database, up to 1000 rows, so an agent can check what its code
  wrote. Editors can already read everything through the code they publish,
  so this exposes nothing new. Per-user databases are not reachable this
  way.

## Data lifecycle

A page's backend data is `shared.sqlite`, one `users/*.sqlite` per user,
and the file store. The file store is content-addressed (an index in
`files.sqlite`, blobs under `files/blobs/{sha256}`), so a snapshot of it is
a copy of the index, and blobs are deleted only when neither the live
index nor a snapshot names them.

### Snapshots

A **snapshot** is every database of the page, copied with `VACUUM INTO`
(consistent while the worker runs), plus the file index.

- **Taken automatically** when a new version becomes current, before its
  worker handles anything (labelled with the version that is leaving: it is
  the state that version left, which its restore can bring back), every
  day the page was called, and before any restore, import or wipe (so each
  of those can be undone).
- **Taken by hand** by an owner from the "Backend" panel, with a label.
- **Kept**: the last 5 version snapshots, the last 7 daily ones, up to 10
  manual ones, and the last 5 taken before a restore/import/wipe. They have
  their own quota per page (Limits); past it the oldest automatic ones go
  first.
- **Restored** by an owner only: it replaces all of the page's data
  (shared, every user's, files) with the snapshot. When restoring a version
  from the history, the viewer offers to restore that version's snapshot
  in the same step.

Snapshots live on the runner's volume, so they protect from bad code and
bad migrations, **not** from losing the volume. Back up the volume.

### Export, import, wipe

- **Export** (owners and editors, who can read all of it through code
  anyway): a zip of `shared.sqlite`, the files and a
  `manifest.json` (page, version, date). Users' private databases are not
  in it: each user exports their own (**My data**, any viewer, their
  `userDb` only). `GET /api/pages/{id}/backend/export`,
  `GET /api/pages/{id}/backend/my-data`.
- **Import** (owner): uploads a zip in the export format and replaces the
  shared database and the files (snapshot first). It moves a page's data
  between instances, or seeds it. `PUT /api/pages/{id}/backend/import`.
- **Wipe** (owner): "Reset shared data and files" or "Reset every user's
  data", each after a snapshot. Any user: "Delete my data" (their `userDb`,
  no snapshot: it is theirs to delete).

### When the page changes state

| Event | Data |
| --- | --- |
| Archived (itself or a folder above) | Kept untouched; calls answer 404 like the page; cron paused; snapshots kept |
| Unarchived | Everything resumes |
| New version without a backend | Kept dormant; the panel still offers export, snapshots and wipe; a later backend version finds it |
| A user loses access | Their `userDb` stays, unreachable; it comes back with the access (as `localStorage` does today) |
| Purge | Specola never deletes a page, so backend data of a page that has been **dormant** (archived, itself or through a folder, or whose current version has no backend) for more than `SPECOLA_BACKEND_PURGE_AFTER_DAYS` days (default: never) is deleted with its snapshots. The panel and the Archived list show the date from 7 days ahead |

MCP gets none of the destructive operations (restore, import, wipe): they
are UI-only, for owners.

### Wire formats for data (exact)

**Who has data.** Specola records `asset.backend_used_at` (set on the
first call the runner answers, kept current at most once an hour, cleared
by a purge). A page has **backend data** when it is set. `GET
/api/pages/{id}` carries `backendData: bool` and, when a purge is
scheduled within 7 days, `backendPurgeAt` (RFC 3339); `GET /api/archived`
carries `backendPurgeAt` per page the same way. **Dormant since** is the
latest of: when the page or the folder above it that archived it was
archived, and when the current version became current if it has no
backend. A page with backend data and no current backend still shows the
Backend panel (data only).

**Specola API** (session; `id` must be a page the caller can view, else
404; roles as stated, else 403 `forbidden`; all answers JSON unless said;
every error carries `X-Specola-Error`; disabled/unavailable as for calls):

| Route | Who | What |
| --- | --- | --- |
| `GET /api/pages/{id}/backend/data` | owner, editor | `{usage:{pageBytes, pageLimit, snapshotBytes, snapshotLimit}, snapshots:[Snapshot]}`, newest first |
| `POST /api/pages/{id}/backend/snapshots` | owner | body `{label}` (1–100 chars) → 201 `Snapshot`; 409 `too-many-snapshots` past 10 manual ones |
| `DELETE /api/pages/{id}/backend/snapshots/{sid}` | owner | manual snapshots only (409 `not-manual` otherwise) → 204 |
| `POST /api/pages/{id}/backend/snapshots/{sid}/restore` | owner | → 200 `{before: Snapshot}` (the snapshot taken first) |
| `GET /api/pages/{id}/backend/export` | owner, editor | `application/zip`, `Content-Disposition` attachment `<title>-data.zip` |
| `PUT /api/pages/{id}/backend/import` | owner | body the zip (≤ 1 GiB, `application/zip`) → 200 `{before: Snapshot}`; 400 `bad-import` naming what's wrong |
| `POST /api/pages/{id}/backend/wipe` | owner | body `{scope:"shared"\|"users"}` → 200 `{before: Snapshot}` |
| `GET /api/pages/{id}/backend/my-data` | any viewer | the caller's `userDb` as `application/vnd.sqlite3`, attachment `<title>-my-data.sqlite`; 404 `no-data` when they have none |
| `DELETE /api/pages/{id}/backend/my-data` | any viewer | → 204 (also when there was none) |

Version restore with data: the viewer restores the version as today, then
calls the snapshot restore for the newest `version` snapshot whose
`version` is the restored one, if the owner ticked it.

`Snapshot` is `{"id", "kind", "label"?, "version"?, "createdAt",
"sizeBytes"}`; `kind` is `version` (with `version`: the version that was
leaving), `daily`, `manual` (with `label`), `before-restore`,
`before-import` or `before-wipe`. `id` is `<UTC stamp>-<kind>` with an
optional `-v<N>`, matching `^[0-9]{8}T[0-9]{6}Z-[a-z-]+(-v[0-9]+)?$`.

**Export zip**: `manifest.json` (`{"format":"specola-backend-data",
"formatVersion":1, "page":{"id","title","version"}, "exportedAt"}`),
`shared.sqlite` (absent when the page has none), `files/index.json`
(`[{"key","contentType","size","sha256"}]`) and each file at
`files/data/<key>`. Deflate for everything but the SQLite file and blobs
whose content type is already compressed. Import accepts exactly this
layout (unknown entries, paths outside it, duplicate or invalid keys, a
`sha256` that doesn't match, or an expanded size over the page quota are
`bad-import`; nothing is changed then). Import replaces `shared.sqlite` and
the file store, never users' databases.

**Runner** (bearer; specola has already checked access; page id
canonical; the caller's sub, when one is needed, in
`X-Specola-Sub`, which the runner hashes):

| Route | What |
| --- | --- |
| `GET /pages/{id}/data` | `{usage, snapshots}` as above |
| `POST /pages/{id}/snapshots` | `{kind:"manual", label}` → 201 `Snapshot` |
| `DELETE /pages/{id}/snapshots/{sid}` | → 204 |
| `POST /pages/{id}/snapshots/{sid}/restore` | → `{before}` |
| `GET /pages/{id}/export` | the zip, streamed |
| `PUT /pages/{id}/import` | the zip → `{before}` |
| `POST /pages/{id}/wipe` | `{scope}` → `{before}` |
| `GET /pages/{id}/my-data` | the sub's database, 404 `no-data` |
| `DELETE /pages/{id}/my-data` | → 204 |
| `DELETE /pages/{id}` | purge everything of the page (data, snapshots, state) → 204, also when there was nothing |

Restore, import, wipe and purge take the page **offline** while they run:
the worker is drained and stopped, new calls wait (up to the first-byte
timeout, then 503 `backend-unavailable`), and the next call starts a fresh
worker. Daily snapshots are taken by the runner after a call, in the
background, when the newest `daily` one is older than 24 h.

**Details settled in implementation.**

- *Quota accounting*: blobs only snapshots still name count toward the
  snapshot budget, not the page's 1 GiB, so a wipe frees the page's quota.
  A manual snapshot that doesn't fit the snapshot budget is refused with
  409 `snapshot-quota` (manual snapshots are never deleted for budget).
- *Atomic maintenance*: restore, import and wipe stage the new data under
  `{data}/swap/{pageId}/` with a journal and swap it in; a runner that dies
  midway finishes a committed swap at start and drops an uncommitted one.
- *Empty pages*: `before-*` snapshots of a page with no data are empty (so
  restoring one empties the page); `version` and `daily` ones are skipped.
- *Restore with data*: after a version is restored together with its data,
  that version's first call switches without taking a `version` snapshot
  (the data is no longer what the leaving version left; it is in the
  `before-restore` snapshot). The runner's restore takes the current
  version in `X-Specola-Version` for this; export takes `?title=&version=`
  for its manifest.
- *Transfer limits*: at most 2 exports, imports or my-data downloads at
  once per user and page in specola, plus per-page and global caps in the
  runner: 429 `too-many-requests`. An import over 1 GiB is 413
  `body-too-large`; a content type other than `application/zip` or
  `application/x-zip-compressed` is 400 `bad-import`.
- *Archived pages*: the data routes answer 404 like everything else for an
  archived page; `GET /api/archived` also gives archived **folders**
  `backendPurgeAt` (the earliest among the pages inside, which aren't
  listed). The purge notice in the viewer is for owners and editors.
- *Delete my data* closes that database in the worker without taking the
  page offline, and **also removes the user's database from every snapshot
  of the page** (each snapshot's `meta.json` and size are updated; a
  snapshot left with nothing is deleted). Data a user deleted never comes
  back through a restore. Snapshots are therefore exact copies of the page
  except for the data users chose to delete. The runner records the deletion in
  the page's state before deleting anything (the user's hash and the
  snapshots that held their database), finishes it after a restart if it
  was cut short, and, for as long as one of those snapshots remains, leaves
  that user's database out of any restore of it; data the user makes after
  deleting theirs is kept in later snapshots and restored like any other.

**Purge** runs in specola every hour: pages with `backend_used_at` set and
dormant for longer than the setting get `DELETE /pages/{id}` on the runner,
then `backend_used_at` cleared. It never runs when backends are disabled
or the runner is unavailable (it retries the next hour).

## Wire formats for steps 3–7 (exact)

Migrations: `0014_page_secrets.sql`, `0015_backend_cron.sql` (step 2 took
`0013`). New routes are registered from a function per feature in its own
file (`routesSecrets`, `routesPush`, …), called from `server.go`.

### Secrets (step 3)

- `page_secret(asset_id uuid REFERENCES asset, name text, ciphertext bytea,
  nonce bytea, updated_by text, updated_at timestamptz, PRIMARY KEY
  (asset_id, name))`. AES-256-GCM, a fresh 12-byte nonce per write, the
  associated data is `asset_id || 0x00 || name` so a ciphertext cannot be
  moved to another page or name. A value is 1 byte–8 KiB of UTF-8.
- `GET /api/pages/{id}/secrets` (owners, editors) →
  `{"secrets":[{"name","declared":bool,"set":bool,"updatedAt"?,"updatedBy"?}]}`:
  every name the current version declares plus any set but no longer
  declared, sorted by name. Never a value.
- `PUT /api/pages/{id}/secrets/{name}` (owners) body `{"value"}` → 204;
  `DELETE` (owners) → 204, also when unset. 400 `bad-request` for an
  invalid name or value. Names need not be declared (an owner may set one
  ahead of a version that declares it).
- `/invoke` and `/scheduled` heads carry `secrets` = the declared names that
  are set, decrypted, and `egress` = the version's normalised list.
- `GET /api/pages/{id}` carries `backendSecretsMissing: [names]` (declared,
  not set) for owners and editors.

### Egress proxy (step 3)

- The runner listens on `127.0.0.1:<random port>` for proxy traffic.
  Every worker gets `NODE_USE_ENV_PROXY=1`, `HTTP_PROXY` and `HTTPS_PROXY`
  set to `http://w-<worker id>:<random token>@127.0.0.1:<port>`, and
  `NO_PROXY` empty. The credential identifies the worker and so its page's
  `egress`.
- `CONNECT host:port` (port 443, or 80) and absolute-URI HTTP requests
  (`http://host[:80]/…`). The host must match an `egress` entry (exact, or
  `*.suffix` matching one or more labels below `suffix`, never `suffix`
  itself). The proxy resolves the name itself and refuses when any address
  is loopback, private (RFC 1918), link-local, CGNAT (100.64/10), ULA
  (fc00::/7), multicast, unspecified, IPv4-mapped forms of those, or the
  metadata address 169.254.169.254; then connects to a resolved address
  (never re-resolving, so no DNS rebinding). IP-literal hosts are refused.
- Refusal: `403` with a one-line text body; the backend log gets
  `egress refused: <host>:<port> (<reason>)`. A missing or wrong credential
  is `407`.
- Raw sockets (`net`, `tls`) bypass the proxy. On a trusted instance that
  is accepted (Trust model); the README says how to close it with a
  container network policy.

### Realtime push (step 4)

- `ctx.publish(topic, data, {to?})`: `topic` matches
  `^[A-Za-z0-9_.:/-]{1,128}$`; `data` is JSON-serialisable and at most
  7 KiB serialised; `to` a `sub`. Invalid → throws `TypeError`. At most 50
  publishes per second per page (token bucket in the runner); beyond that
  they are dropped with one log warning per second.
- Runner → specola `POST /internal/runner/publish` (bearer) body
  `{"page","topic","data","to"?}` → 204. Specola checks the page exists and
  sends `NOTIFY specola_push, '<json>'`. Every specola replica `LISTEN`s
  with a dedicated connection (reconnecting with backoff) and fans out to
  its own streams.
- `GET /api/pages/{id}/events?v=<version>&topic=<t>&topic=<t>…` (session,
  view access, 1–20 topics): `text/event-stream`, never compressed or
  buffered. Each event is `event: message` + `data: {"topic","data"}`. A
  comment line every 25 s keeps it open. If `v` is not the current version,
  or becomes not current, the stream sends `event: superseded` and closes.
  Access is re-checked every 5 minutes; lost access closes the stream with
  `event: forbidden`. Targeted events (`to`) go only to that `sub`.
- Port: frame → viewer `{op:"sub", topic}` / `{op:"unsub", topic}`; viewer
  → frame `{op:"event", topic, data}`. The SDK's
  `specola.subscribe(topic, onMessage)` returns `unsubscribe()`; several
  subscriptions to one topic share the stream. The viewer keeps one
  `EventSource` per frame for the current topic set and reopens it (debounced
  100 ms) when the set changes; `superseded` triggers the reload notice.
  Best effort: no replay, and the SDK documents it.

### Scheduled jobs (step 5)

- `backend_cron(asset_id uuid, name text, schedule text, next_run_at
  timestamptz, last_run_at timestamptz NULL, last_status text NULL,
  last_error text NULL, last_duration_ms int NULL, PRIMARY KEY (asset_id,
  name))`. Rewritten in the same transaction that changes a page's current
  version (commit, restore): rows for jobs the new version declares are
  upserted (keeping `last_*` for a name that stays), others deleted.
- A ticker every 30 s (injectable) claims due rows with `FOR UPDATE SKIP
  LOCKED`, skips pages that are archived or whose runner is unavailable
  (`last_status = "skipped"`), sets `next_run_at` to the next slot after
  now (no catch-up), and calls the runner. At most 4 jobs run at once per
  specola process.
- specola → runner `POST /scheduled`: same headers as `/invoke`, the head
  has `"event": {"name","scheduledTime": <ms>}` instead of `request`,
  `user: null`, `role: "cron"`. The runner calls the default export's
  `scheduled(event, ctx)` with a 5-minute limit and answers
  `{"status":"ok"|"no-handler"|"error"|"timeout","ref"?}`. `last_status`
  stores that status (`"unavailable"` when the runner can't be reached),
  `last_error` the ref and message.
- `GET /api/pages/{id}/backend/cron` (owners, editors) →
  `{"jobs":[{"name","schedule","nextRunAt","lastRunAt"?,"lastStatus"?,"lastError"?,"lastDurationMs"?}]}`.
- Cron times are UTC; schedules use the five fields validated in step 1.

### Public links (step 6)

- For a backend page, `/s/{token}` and `/s/{token}/*` serve the **shell**:
  a small HTML document (embedded in the binary, inline script, its own
  CSP: `default-src 'none'; script-src 'self' 'unsafe-inline'; frame-src
  'self'; connect-src 'self'; style-src 'unsafe-inline'`), `Cache-Control:
  no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`. It
  frames `/s/{token}/~page/<rest of the path>?<query>`, which serves the
  page exactly as `/s/{token}` does today, with basename
  `/s/{token}/~page`. A page without a backend keeps today's behaviour (and
  `~page` answers 404 for it).
- The shell implements the viewer's side of the port: the backend state
  (from boot data in the shell), `fetch` → `ANY /p/{token}/x/{path}` with
  `X-Specola-Version` and `X-Specola-Headers`, streaming, abort,
  `sub`/`unsub` → `GET /p/{token}/events?v=&topic=`. It hands no
  `localStorage` data, so the page's storage stays in memory as today.
- `/p/{token}/x/*`: the link must be valid as for serving (else 404/410);
  the method and path (without query) must match one of the version's
  `public` patterns (else 403 `not-public`, the runner is not called); rate
  limits 60 requests/min per (link, client IP) and 600/min per link (429
  `too-many-requests`, `Retry-After`). The head has `user: null`,
  `role: "public"`, `link: {"id","label"}`. Same header rules, limits and
  errors as `/api/pages/{id}/x`.
- `/p/{token}/events`: only topics in `topics.public` (others 403
  `not-public`), never targeted events.
- Client IP is `RemoteAddr`, or the first `X-Forwarded-For` hop only when
  `SPECOLA_TRUST_FORWARDED=1`.

### MCP (step 7)

All four act as the user, with the same access rules as the API; for a
page without a backend they answer an error saying so.

- `call_backend(id, method, path, body?, headers?)` — calls the current
  version exactly as `specola.fetch` would. Returns `{status, headers,
  body, body_encoding: "utf-8"|"base64", truncated}`; at most 64 KiB of body.
- `backend_logs(id, since?)` — owners and editors; the log lines.
- `backend_query(id, sql, params?)` — owners and editors; one read-only
  statement on the shared database through runner `POST
  /pages/{id}/query` `{sql, params}` → `{columns, rows, truncated}`. The
  runner opens `shared.sqlite` read-only (`readOnly: true`, plus `PRAGMA
  query_only`) in a short-lived child process with `--permission` read
  access to that file only, kills it after 5 s (`backend-timeout`), and
  returns at most 1000 rows / 1 MiB.
- `list_secrets(id)` — owners and editors; the same as `GET
  /api/pages/{id}/secrets`, with a note that values are set by owners in
  the UI only.
- Instructions (enabled): the full backend feature as built, kept short:
  plugin option, handler shape, `ctx` fields, `specola.fetch` and
  `subscribe`, `backend.json` fields, secrets set by owners, egress
  allowlist, cron in UTC, public routes, data per page across versions,
  only the current version live, and these four tools for testing.
  `get_page` carries `backend: {manifest, secrets_missing}` for the
  current version.

### Settled in implementation (steps 3–7)

- **Node version**: the runner refuses to start on Node that doesn't route
  `http`/`https` through `NODE_USE_ENV_PROXY` (below 22.21 on 22.x, 23.x,
  24.0–24.4), since the egress allowlist would silently not apply. The
  runner's `engines` is `^22.21 || >=24.5`.
- **Secrets**: names match `^[A-Z][A-Z0-9_]{0,63}$`; the associated data is
  the canonical uuid as text, `0x00`, the name; all of a page's secrets
  together must fit in 24 KiB of the invoke head (a `PUT` past it is 400);
  `PUT` answers 503 `backend-disabled` without a key.
- **Egress**: an entry may carry a port (`host:443` allows only 443); the
  proxy refuses more ranges than listed above; a name that doesn't resolve
  or an upstream failure is 502.
- **`backend_query`**: `node:sqlite` ignores Node's permission model, so
  the read-only guarantee comes from `readOnly` + `query_only` and a
  statement allowlist (one `SELECT`, `WITH`, `VALUES`, `EXPLAIN`, or a
  read-only `PRAGMA`); integers beyond 2^53 come back as strings.
- **Push**: events for a non-current version answer 200 and send
  `event: superseded` at once; `superseded`/`forbidden` carry `data: {}`.
- **Cron**: `next_run_at` is NULL for a schedule that never fires (31
  February); pages published before the table existed get their jobs when
  the ticker starts; the result carries `message` too, stored in
  `last_error` as `<message> (ref <ref>)`.
- **Public links**: the shell also sends `X-Frame-Options: DENY` and
  `nosniff`; paths with `.`/`..` segments, an encoded `/` or `\\` are
  `not-public`; an expired link on `/p/…` is 410 `link-expired`.
- **MCP**: the four backend tools exist only when backends are enabled;
  `call_backend`'s method defaults to GET.
- **Test-only hooks** (documented in the READMEs, never for production):
  `RUNNER_EGRESS_ALLOW_LOOPBACK_FOR_TESTS`, `SPECOLA_TEST_CRON_EVERY`,
  `SPECOLA_TEST_CLOCK_OFFSET`.
- **Known limits, not yet addressed**: a non-public subscribe in the public
  shell stops every push there; public event streams have no open-stream
  limit and outlive a revoked link by up to 5 minutes; the 5-minute cron
  limit is reported, not enforced; pushes from one page can arrive out of
  order; a stream on an old version gets the new version's pushes for up
  to 10 s; the first `X-Forwarded-For` hop is spoofable when trusted.

## Plugin and CLI

`specola({ server: "server/index.ts", backend: {…manifest fields} })`:

- builds the server entry with Vite's SSR build (`ssr`, `target: node24`,
  everything bundled — `noExternal: true`; the build targets `node22`, the
  oldest Node the runner supports) into `.specola/server/`, after
  the client build;
- writes `.specola/backend.json` from the `backend` option (or a
  `specola.backend.json` next to `vite.config`);
- fails the build on a native addon import or a manifest that doesn't
  validate;
- **dev server**: mounts the handler at `/__specola/x/*`, with SQLite and
  files under `.specola-dev/`, secrets from `.env` (only the declared
  names), `ctx.user` from `SPECOLA_DEV_USER`, and the stand-in
  `specola.fetch`/`subscribe` going there, so `vite dev` runs the whole app.
- `client.d.ts` gains `specola.fetch`, `subscribe`, `backend`; a new
  `@specola/vite-plugin/server` export types `Ctx` for the handler.

The CLI and upload protocol are unchanged: `.specola/` files are bundle files.

## Data model

- `asset_version.backend jsonb NULL` — the parsed manifest; non-null marks a
  backend version (bundles only).
- `page_secret` — see Secrets.
- `backend_cron` — see Scheduled jobs.
- Runner-side state (SQLite, files, logs) is not in Postgres. **Back up the
  runner volume** along with the database.

## Limits

| Limit | Default |
| --- | --- |
| request body | 25 MiB |
| response | 100 MiB, streamed |
| wall time per request | 30 s to first byte, 5 min total |
| wall time per cron run | 5 min |
| worker memory | 256 MiB |
| concurrent requests per worker | 32 |
| concurrent requests per user and page | 8 |
| public link calls | 60/min per link and IP, 600/min per link |
| disk per page (SQLite + files) | 1 GiB |
| idle worker lifetime | 5 min |
| push payload | 7 KiB |
| cron jobs per page | 10, at most once a minute |
| snapshots per page | 2 GiB, beyond the page's own 1 GiB |
| import zip | 1 GiB |

Runner env overrides the runner-side ones: `RUNNER_MAX_BODY_BYTES`,
`RUNNER_MAX_RESPONSE_BYTES`, `RUNNER_FIRST_BYTE_TIMEOUT_MS`,
`RUNNER_REQUEST_TIMEOUT_MS`, `RUNNER_WORKER_MEMORY_MB`,
`RUNNER_WORKER_CONCURRENCY`, `RUNNER_PAGE_DISK_BYTES`,
`RUNNER_SNAPSHOT_DISK_BYTES`, `RUNNER_IDLE_TIMEOUT_MS`. The specola-side
ones (request body, calls per user and page, 5-minute cap) are constants
for now.

The page disk limit covers everything under the page's directory. SQLite
databases get a `max_page_count` set from the room the page has left
(re-measured after calls, at most once a second), so writes past it fail
with "database or disk is full"; `files.put` measures again once the bytes
are on disk. A page can end slightly over its quota, never by an unbounded
amount; the log warns at 99%.

## Configuration

| Var | Where | Meaning |
| --- | --- | --- |
| `SPECOLA_RUNNER_URL` | specola | runner base URL; unset = backends disabled |
| `SPECOLA_RUNNER_TOKEN` | both | shared bearer for the internal API |
| `SPECOLA_SECRETS_KEY` | specola | 32 bytes, base64; encrypts page secrets |
| `SPECOLA_URL` | runner | specola's internal base URL |
| `RUNNER_DATA_DIR` | runner | the volume (default `/data`) |
| `RUNNER_LISTEN` | runner | listen address (default `:8081`) |
| `SPECOLA_BACKEND_PURGE_AFTER_DAYS` | specola | purge backend data of pages dormant this long (default: never) |

`docker-compose.yaml` gains a `runner` service and volume, commented out by
default.

## Offline

Backend calls need the network. Offline, `specola.backend.available` is
false and `specola.fetch` rejects with `BackendUnavailable`
(`reason: "offline"`); the app decides what to show. Nothing is queued.

## Delivery plan

1. Runner skeleton, internal API, `specola.fetch` over the port with
   streaming, `db`/`userDb`/`files`, plugin server build and dev server,
   backend log, the disabled/unavailable states everywhere (MCP included),
   only-current-version rules (410/409) and the version-switch snapshot.
2. Data lifecycle: snapshots panel and restore, export, my data, import,
   wipe, purge.
3. Secrets and egress proxy.
4. Realtime push.
5. Scheduled jobs.
6. Public links shell.
7. MCP `call_backend`, `backend_logs`, `backend_query`, `list_secrets`,
   instructions.

## Open questions


- **Bun-compatible handlers**: the contract is web-standard, so it may run
  on another runtime later; nothing depends on it now.
