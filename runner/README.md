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
  stops, version switches, snapshots, restores, imports and wipes.
- The page's data lifecycle: snapshots (on a version switch, daily after a
  call, by hand, and before a restore, an import or a wipe), restore,
  export and import as a zip, wipe, each user's own data (download,
  delete) and purge.

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
| `RUNNER_PAGE_DISK_BYTES` | 1 GiB | A page's databases and files, snapshots excluded. Databases get a SQLite `max_page_count` from it (writes past it fail with "database or disk is full"); `files.put` refuses with `QuotaExceededError` |
| `RUNNER_IDLE_TIMEOUT_MS` | 300000 | An idle worker stops after this |
| `RUNNER_SNAPSHOT_DISK_BYTES` | 2 GiB | A page's snapshots; past it the oldest automatic ones go first (the newest is always kept, manual ones never go: a manual one that does not fit is refused) |

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
| `GET /pages/{id}/data` | `{usage:{pageBytes, pageLimit, snapshotBytes, snapshotLimit}, snapshots}`, newest first |
| `POST /pages/{id}/snapshots` | `{kind:"manual", label}` → 201 snapshot; 409 `too-many-snapshots` past 10, 409 `snapshot-quota` past the budget |
| `DELETE /pages/{id}/snapshots/{sid}` | Manual ones only (409 `not-manual`) → 204 |
| `POST /pages/{id}/snapshots/{sid}/restore` | → `{before}`: the snapshot taken first. `X-Specola-Version`: the page's current version in specola |
| `GET /pages/{id}/export?title=…&version=…` | The zip (`manifest.json`, `shared.sqlite`, `files/index.json`, `files/data/<key>`), streamed; the manifest names the page with the title and version given |
| `PUT /pages/{id}/import` | The zip (≤ 1 GiB) → `{before}`; 400 `bad-import` naming what is wrong, nothing changed |
| `POST /pages/{id}/wipe` | `{scope:"shared"\|"users"}` → `{before}` |
| `GET` / `DELETE /pages/{id}/my-data` | The `X-Specola-Sub` user's database (404 `no-data`) / delete it → 204 |
| `DELETE /pages/{id}` | Purge: data, snapshots, state and log → 204, also when there was nothing |

A missing or wrong token answers `401 unauthorized` everywhere. Page ids
and snapshot ids are checked against their exact forms before anything
becomes a path (400 `bad-request`).

Restore, import, wipe and purge take the page **offline** while they run:
new calls wait (up to the first-byte timeout, then `503
backend-unavailable`), the worker drains and stops, the work is done, and
the next call starts a fresh worker. An import is read, checked and built
aside first, so a bad zip never takes the page offline. "Delete my data"
does not take the page offline: the worker closes and deletes that user's
database itself, in one step, so the other users' calls go on.

What a restore, an import or a wipe replaces is built complete under
`swap/{pageId}/new/` first (nothing of the page changes if that fails),
then `swap/{pageId}/journal.json` is written and the databases are swapped
in by renames. A runner that dies after the journal finishes the swap the
next time it loads the page; one that dies before it drops it.

Exports, imports and "my data" downloads each hold a copy of up to a
page's data while they stream: at most 2 run at once per page and 8 in all
(more answer `429 too-many-requests`).

A restore sent with an `X-Specola-Version` newer than the version the
runner runs marks the data as restored for that version (in the state
file). That is what restoring a version with its data from the history
does: the version first, then its snapshot, before the new version's first
call. Until that version runs, calls of older ones answer `409 superseded`
(they would run old code on the restored data), and the switch to it takes
no version snapshot: the data is not what the leaving version left (its
own is in the before-restore snapshot). A restore for the version already
running (from the panel) marks nothing: the restored data is that
version's, and the next switch snapshots it as usual.

Node's own time limit for receiving a request is 2 hours, so a 1 GiB import
uploaded slowly through specola is not cut; calls keep their own limits.

## Data layout

```
/data/code/{codeHash}/…                      extracted .specola/ files, read-only
/data/state/{pageId}.json                    the version the page runs, and the version its data was restored for (outside the page's reach)
/data/pages/{pageId}/shared.sqlite           ctx.db
/data/pages/{pageId}/users/{sha256(sub)}.sqlite   ctx.userDb
/data/pages/{pageId}/files.sqlite            ctx.files index
/data/pages/{pageId}/files/blobs/{sha256}    ctx.files contents
/data/snapshots/{pageId}/{id}/               a snapshot and its meta.json (outside the page's reach)
/data/swap/{pageId}/                         the data a restore, import or wipe swaps in, and its journal
/data/tmp/                                   imports and downloads in progress (emptied at start)
```

A snapshot id is `<UTC stamp>-<kind>`, plus `-v<N>` for a version one
(`20261125T101500Z-version-v3`, `20261126T080000Z-daily`,
`20261126T091200Z-manual`, `…-before-restore`, `…-before-import`,
`…-before-wipe`). Kept: the last 5 version snapshots, 7 daily ones, 5 of
the three before-* kinds together, and up to 10 manual ones. Step 1's
version snapshots (`20261125T101500.123Z-v3`) are read as version
snapshots and renamed, with a `meta.json`, at start.

Snapshots hold copies of the databases (and the file index); the file
store's blobs stay in the page's directory and are deleted only when
neither the live index nor a snapshot names them. While an export streams,
a `.tmp-export-*` directory under the page's snapshots holds its copies and
keeps every blob it names.

A blob that only snapshots name (the files a wipe or an import replaced)
counts against the snapshots' budget, not the page's quota: the page's
usage is everything under its directory less those blobs, and snapshot
retention, which frees them, counts them once with the snapshots that name
them.

A database the page's code broke (one that SQLite says is not a database,
or malformed) is left out of a snapshot with a warning in the backend log,
so it can't block version switches for good. Only the databases the runner
creates are snapshotted; anything else the code writes in its directory is
its own.

## Security model

**The runner is for an instance among trusted people.** Anyone who can
publish a bundle can run Node code on it. What it does is keep accidents
contained and pages from stepping on each other:

- Each page runs in its own process, under Node's **permission model**:
  `--permission`, reading only its code directory, its page directory, its
  snapshots and the worker's own bootstrap files, writing only its page
  directory (so not its snapshots, which must survive its bugs); no
  child processes, worker threads, native addons or WASI. A backend that
  opens `node:sqlite` itself is held to its page directory too (Node 22's
  `node:sqlite` does not consult the permission model, so the worker routes
  it through a guard; the guard needs `module.registerHooks`, Node ≥ 22.15).
- A worker's environment is empty but for `TZ`, `NODE_ENV` and `LANG`: the
  runner's token never reaches page code.
- Limits per request (time, body sizes), per worker (heap, concurrency,
  output lines, start time) and per page (disk: files written with `node:fs`
  directly count against it but are not refused). A worker that runs out of memory, crashes or stops
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
