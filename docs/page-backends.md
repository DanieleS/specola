# Page backends — design and contract

Status: **proposal**, nothing implemented yet. Decisions taken so far are
stated as the contract; what is still open is listed at the end.

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
  to: one bundle version = one frontend + one backend, restored together.
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
every 30 s; "enabled" is a configuration fact, "available" is the latest
health check.

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

The manifest is validated at `POST /upload/bundle/{token}/manifest` (shape
and limits; the entry's presence at commit). It is stored parsed on the
version (`asset_version.backend jsonb`), so specola reads routes, secrets and
cron without touching blobs.

## Handler contract

The entry's default export is an object with any of:

```ts
export default {
  fetch?(request: Request, ctx: Ctx): Response | Promise<Response>;
  scheduled?(event: { name: string; scheduledTime: number }, ctx: Ctx): void | Promise<void>;
};
```

`request.url` is `https://page.invalid/<path>?<query>` (the path the page
asked for; the origin is a fixed placeholder). Request headers are the
page's, minus `Cookie`, hop-by-hop headers and anything `X-Specola-*`.
Response headers `Set-Cookie` and hop-by-hop ones are dropped.

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
  restores code, never data, so migrations must be forward-compatible.
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
`X-Specola-Version: N` — the version the frame shows. The viewer copies
method, page headers and body, and streams the response body back as
chunks. Pushes: one `EventSource` per open backend page, `GET
/api/pages/{id}/events?topic=a&topic=b`, reopened when the subscription set
changes.

Specola:

1. authenticates, checks the user can **view** the page (404/403 as
   everywhere), and that the version has a backend (404 `no-backend`);
2. resolves the role (owner/editor/viewer);
3. checks limits (body size, concurrent requests per user and page);
4. forwards to the runner with the request, the `ctx` identity, the
   version's code reference and the page's declared secrets (decrypted);
5. streams the runner's response through, flushing each chunk.

**The version runs the backend it was published with**, so a frontend is
always paired with its own backend, including when someone opens an old
version from the history. Cron runs only for the current version.

### specola ↔ runner (internal)

- `POST {runner}/invoke` — JSON head (`page`, `version`, `codeHash`,
  `ctx` identity, `secrets`, `egress`, `request` head) then the raw body;
  answers with the handler's status, headers and streamed body.
- `POST {runner}/scheduled` — same, with the cron event and no request.
- `GET {runner}/logs?page=…` — recent log lines of a page.
- `GET {runner}/health`.
- Runner → specola: `GET /internal/runner/code/{versionId}` (the
  `.specola/` files of a version, as a tar stream; cached on the runner's
  disk by `codeHash`) and `POST /internal/runner/publish` (a push).

`/internal/*` is only on the app listener, requires the runner token, and
answers 404 otherwise.

## Runner

A small Node service (`runner/` in this repo, its own image on
`node:24-slim`), single replica, with a data volume:

```
/data/code/{codeHash}/…                 extracted .specola/ files
/data/pages/{pageId}/shared.sqlite
/data/pages/{pageId}/users/{sha256(sub)}.sqlite
/data/pages/{pageId}/files/…
```

- **One worker process per (page, version)**, started on first request,
  kept warm, stopped after 5 minutes idle (and on a new code hash for that
  version, which doesn't happen: versions are immutable). Each worker runs
  with `node --permission --allow-fs-read=<its code dir>,<its page dir>
  --allow-fs-write=<its page dir>` and no child processes, workers or
  addons, `--max-old-space-size` from the limits, and its own environment
  (no runner secrets, `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY`/`HTTP_PROXY`
  pointing at the egress proxy with a per-worker credential).
- **Egress proxy**: in the runner process; HTTP `CONNECT` and plain HTTP;
  identifies the worker by its credential and allows only the hosts of that
  version's `egress`. Private, loopback and link-local addresses are refused
  after DNS resolution whatever the allowlist says (no SSRF into the
  runner's network).
- **Limits** per request (wall time, response bytes), per worker (memory,
  concurrent requests) and per page (disk), see Limits. A worker that
  exceeds memory is killed and the request answers 502 `backend-crashed`.
- SQLite files are opened by the worker only; WAL mode; one worker per page
  version, and versions of the same page share the files (SQLite's locking
  serialises writers across them).

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
- a pinned link runs its pinned version's backend;
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
- MCP `call_backend(id, method, path, body?, version?)` lets an agent
  exercise the backend as its user, to test what it published (returns
  status, headers and up to 64 KiB of body).

## Plugin and CLI

`specola({ server: "server/index.ts", backend: {…manifest fields} })`:

- builds the server entry with Vite's SSR build (`ssr`, `target: node24`,
  everything bundled — `noExternal: true`) into `.specola/server/`, after
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

Runner env (`RUNNER_*`) overrides the runner-side ones; specola env
(`SPECOLA_BACKEND_*`) the specola-side ones.

## Configuration

| Var | Where | Meaning |
| --- | --- | --- |
| `SPECOLA_RUNNER_URL` | specola | runner base URL; unset = backends disabled |
| `SPECOLA_RUNNER_TOKEN` | both | shared bearer for the internal API |
| `SPECOLA_SECRETS_KEY` | specola | 32 bytes, base64; encrypts page secrets |
| `SPECOLA_URL` | runner | specola's internal base URL |
| `RUNNER_DATA_DIR` | runner | the volume (default `/data`) |

`docker-compose.yaml` gains a `runner` service and volume, commented out by
default.

## Offline

Backend calls need the network. Offline, `specola.backend.available` is
false and `specola.fetch` rejects with `BackendUnavailable`
(`reason: "offline"`); the app decides what to show. Nothing is queued.

## Delivery plan

1. Runner skeleton, internal API, `specola.fetch` over the port with
   streaming, `db`/`userDb`/`files`, plugin server build and dev server,
   backend log, the disabled/unavailable states everywhere (MCP included).
2. Secrets and egress proxy.
3. Realtime push.
4. Scheduled jobs.
5. Public links shell.
6. MCP `call_backend`, `backend_logs`, `list_secrets`, instructions.

## Open questions

- **Old versions writing to new data.** Opening an old version runs its
  backend against today's data. Alternative: old versions get a read-only
  `db`, or no backend at all. Current choice: same rights, author's job.
- **Data lifecycle**: export (zip of SQLite + files for the owner), wipe,
  and what happens to data when a page is archived for good (today nothing
  is ever hard-deleted).
- **Bun-compatible handlers**: the contract is web-standard, so it may run
  on another runtime later; nothing depends on it now.
- **Single runner replica** because SQLite lives on its volume; sharding by
  page is possible later without changing the contract.
