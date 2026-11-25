# specola-runner

The **runner** runs Specola's page backends: the server code that ships
inside an SPA bundle under `.specola/` and that a page reaches with
`specola.fetch`. It is a small Node service, separate from Specola's Go
binary and **optional**: without it Specola works as before and says
plainly that backends are off. The contract it implements is
[`docs/page-backends.md`](../docs/page-backends.md); this file is about
running it.

- One **worker process per page**, running the page's current version,
  started on the first request, stopped after 5 minutes idle.
- Each page gets a shared SQLite database (`ctx.db`), one per user
  (`ctx.userDb`) and a content-addressed file store (`ctx.files`), on the
  runner's volume.
- Only the current version runs. When a newer version arrives, the runner
  snapshots the page's data, starts the new worker and lets the old one
  finish what it was doing; an older version answers `409 superseded`.
- A backend log per page (last 1000 lines, in memory): console output,
  uncaught errors with their stack, crashes, timeouts, worker starts and
  stops, version switches.

No npm dependencies and no build step: Node built-ins only (`node:sqlite`,
`node:http`, `child_process`). Runs on Node ≥ 22.13; the image is
`node:24-slim`.

## Running it

```sh
docker build -t ghcr.io/danieles/specola-runner:latest runner
```

`docker-compose.yaml` at the root has a commented-out `runner` service and
volume. Locally:

```sh
SPECOLA_URL=http://localhost:8080 SPECOLA_RUNNER_TOKEN=… RUNNER_DATA_DIR=./data npm start
```

Specola then needs `SPECOLA_RUNNER_URL` (e.g. `http://runner:8081`), the
same `SPECOLA_RUNNER_TOKEN`, and `SPECOLA_SECRETS_KEY` (see
`specola.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPECOLA_URL` | (required) | Specola's internal base URL, where the runner fetches code |
| `SPECOLA_RUNNER_TOKEN` | (required, ≥ 16 chars) | Shared bearer for the internal API, both directions |
| `RUNNER_LISTEN` | `:8081` | `[host]:port` to listen on |
| `RUNNER_DATA_DIR` | `/data` | The volume: code cache, page data, snapshots |
| `RUNNER_MAX_BODY_BYTES` | 25 MiB | Request body |
| `RUNNER_MAX_RESPONSE_BYTES` | 100 MiB | Response body (streamed; cut past it) |
| `RUNNER_FIRST_BYTE_TIMEOUT_MS` | 30000 | Until the handler returns its `Response` (else `504 backend-timeout`) |
| `RUNNER_REQUEST_TIMEOUT_MS` | 300000 | Whole request, `waitUntil` work included |
| `RUNNER_WORKER_MEMORY_MB` | 256 | A worker's heap (`--max-old-space-size`) |
| `RUNNER_WORKER_CONCURRENCY` | 32 | Requests a worker handles at once (more answer `429`) |
| `RUNNER_PAGE_DISK_BYTES` | 1 GiB | A page's databases and files, snapshots excluded |
| `RUNNER_IDLE_TIMEOUT_MS` | 300000 | An idle worker stops after this |

Back up the volume along with Specola's database: page data lives only
here, and snapshots are on the same volume.

## How Specola talks to it

Plain HTTP on a private network, `Authorization: Bearer
$SPECOLA_RUNNER_TOKEN` on every request, both ways (wire formats in the
contract, "Wire formats (exact)"):

| Call | What |
| --- | --- |
| `POST /invoke` | Run a page's `fetch` handler. The head is base64url JSON in `X-Specola-Invoke` (page, version, code hash, user, role, request); the body is the request body, streamed. The answer is the handler's status, headers and streamed body, or a runner error (`X-Specola-Error` + `{"error","message","ref"?}`) |
| `GET /logs?page=…&since=…` | The page's backend log, oldest first |
| `GET /health` | `{"ok":true,"version":…}`; Specola polls it for "available" |
| runner → `GET {SPECOLA_URL}/internal/runner/code/{versionId}` | A version's `.specola/` files. The runner recomputes their hash, refuses a mismatch, and caches them under `code/{hash}/` |

A missing or wrong token answers `401 unauthorized` everywhere.

## Data layout

```
/data/code/{codeHash}/…                      extracted .specola/ files, read-only
/data/state/{pageId}.json                    the version the page runs (outside the page's reach)
/data/pages/{pageId}/shared.sqlite           ctx.db
/data/pages/{pageId}/users/{sha256(sub)}.sqlite   ctx.userDb
/data/pages/{pageId}/files.sqlite            ctx.files index
/data/pages/{pageId}/files/blobs/{sha256}    ctx.files contents
/data/pages/{pageId}/snapshots/{UTC time}-v{N}/   data as version N left it (last 5 kept)
```

## Security model

**The runner is for an instance among trusted people.** Anyone who can
publish a bundle can run Node code on it. What it does is keep accidents
contained and pages from stepping on each other:

- Each page runs in its own process, under Node's **permission model**:
  `--permission`, reading only its code directory, its page directory and
  the worker's own bootstrap files, writing only its page directory; no
  child processes, worker threads, native addons or WASI. A backend that
  opens `node:sqlite` itself is held to its page directory too (Node 22's
  `node:sqlite` does not consult the permission model, so the worker routes
  it through a guard; the guard needs `module.registerHooks`, Node ≥ 22.15).
- A worker's environment is empty but for `TZ`, `NODE_ENV` and `LANG`: the
  runner's token never reaches page code.
- Limits per request (time, body sizes), per worker (heap, concurrency) and
  per page (disk). A worker that runs out of memory, crashes or stops
  answering is killed; its requests answer `502 backend-crashed` and the next
  request gets a fresh worker.
- What a worker sends over IPC is treated as input: page code can call
  `process.send` itself, and a malformed message fails its request, never
  the runner.

What is **not** defended against (by design, see the contract's "Trust
model"): a deliberately malicious author. In particular:

- **Network**: outbound `fetch` is unrestricted for now. The egress proxy
  that limits a backend to its manifest's hosts and refuses private
  addresses comes in a later step; until then a backend can reach whatever
  the runner's container can, Specola's internal API included (which still
  requires the token). Put the runner on a network where that is
  acceptable.
- Raw sockets (`node:net`), CPU exhaustion within the limits, reading other
  processes' memory or `/proc` details the OS exposes, SQL `ATTACH` of a
  database path outside the page directory, side channels.
- Pages that share the runner share its CPU and its volume's I/O.

An operator who wants more puts the runner container behind a network
policy and an OS-level sandbox (gVisor, a seccomp profile, a separate VM);
nothing in the runner prevents that.

## Development

```sh
cd runner && npm test     # node --test test/*.test.js
```

The tests start a fake Specola serving code and a runner on random ports,
with real worker processes.
