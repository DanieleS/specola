# Native addons in page backends — design (proposal)

Status: **proposal**, not implemented. Extends
[`page-backends.md`](page-backends.md), which lists "npm packages with
native addons" as a v1 non-goal.

Today a backend is one self-contained ESM tree under `.specola/server/`,
built with `noExternal: true`, and the plugin fails the build on any `.node`
file or native loader (`bindings`, `node-gyp-build`, …). Workers run with
`--permission` and without `--allow-addons`. So `better-sqlite3`, `sharp`,
`argon2`, `duckdb`, `lmdb` and the like can't be used, even though they
work in `vite dev`.

## The core problem

A native addon is a binary for one **platform** (os, arch, libc) and one
**Node ABI** (`process.versions.modules`). The author builds on, say,
macOS arm64 with Node 24; the runner is Linux x64 or arm64 glibc with the
Node of its image, which changes when the image is upgraded. So the
binary **can't travel in the bundle**: it has to be obtained on the runner,
for the runner.

The npm ecosystem already solves "get the right binary for this machine"
at install time (prebuilds downloaded by `prebuild-install`/`node-gyp-build`,
per-platform optional dependencies as in `sharp`, a `node-gyp` compile as
last resort). So the design is: **the bundle declares the native packages,
the runner `npm install`s them for itself, once per (packages, platform,
ABI), and the worker loads them from there.**

## Trust and isolation

Accepted trade-off, in line with the backends' trust model (an instance
among trusted people):

- Native code is **not** subject to Node's permission model: a worker that
  loads an addon can read and write anything the runner's user can, open
  sockets bypassing the egress proxy, and so on. The `sqlite-guard` and
  the quota on `node:sqlite` don't apply to what an addon opens.
- `npm install` runs package **install scripts** on the runner, outside
  any worker.
- So it's **opt-in per instance** (`RUNNER_NATIVE=on`, off by default),
  and every surface says when it's on. Operators who need more isolation
  keep it off, or run the runner in an OS-level sandbox as already
  suggested.

Mitigations that cost little and stop accidents:

- npm runs as the runner's unprivileged user, with a minimal environment
  (no `SPECOLA_RUNNER_TOKEN`, no secrets), `cwd` in its own directory, and
  a timeout.
- A worker only gets `--allow-addons` (and read access to the installed
  dependencies) if its version declares native packages; every other
  backend keeps exactly today's sandbox.
- Exact versions only, so what runs is what the author tested.

## Manifest

A new optional field in `.specola/backend.json`:

```json
{
  "version": 1,
  "native": { "better-sqlite3": "12.4.1", "sharp": "0.34.4" }
}
```

- Keys are npm package names (scoped allowed), validated like npm does;
  values are **exact** semver versions (no ranges, tags, URLs, git or
  file specs). At most 20 entries. Unknown fields still refused.
- Validated by specola at commit. If backends are disabled, as today the
  bundle is refused. If the runner's last health check says native addons
  are off, the commit is refused with 400 `native-disabled` naming the
  packages; if the runner's state is unknown (unavailable), it's accepted
  and the problem surfaces at the first call.
- Stored in `asset_version.backend` with the rest of the manifest; part of
  `backend_hash` like any `.specola/` file, so a dependency bump is a new
  backend.

## Plugin

```js
specola({
  server: "server/index.ts",
  backend: { native: ["better-sqlite3"] },
});
```

- `backend.native` lists **package names**. The plugin reads the version
  actually installed in the project (`node_modules/<name>/package.json`,
  resolved from the server entry) and writes it into the manifest, so the
  runner installs exactly what the author ran with in `vite dev`.
- In the server build those packages (and their subpaths,
  `better-sqlite3/lib/…`) become **external**: the bundle keeps
  `import Database from "better-sqlite3"`. Everything else is still
  bundled.
- `noNativeAddons` stays, but a native addon reached through a package
  that isn't listed now fails with a hint: *"`better-sqlite3` loads a
  native addon: add it to `backend.native`"* (the plugin knows the
  top-level package the import came through). When the instance doesn't
  allow natives, the publish step says so before uploading (from
  `/api/me`, see below).
- Dev server: unchanged; `ssrLoadModule` already loads the package from
  the project's `node_modules`.
- `server.d.ts`: `ctx.dataDir` (below).

## Runner

### Installing: the native cache

```
/data/native/{nativeKey}/package.json      {"dependencies": {...exact versions}}
/data/native/{nativeKey}/node_modules/…
/data/native/{nativeKey}/install.log
```

`nativeKey = sha256(canonical JSON of the native map, platform, arch, libc,
process.versions.modules)`. So:

- Pages with the same dependencies share one install.
- A runner image with a new Node (new ABI) gets a new key and reinstalls on
  its own: no stale binaries ever load.
- A directory that exists is complete: install in `.tmp-*`, then rename
  into place, as the code cache does; concurrent first requests share one
  install (in-flight map); `.tmp-*` are swept at start.

The install is `npm install --omit=dev --no-audit --no-fund
--no-package-lock --ignore-scripts=false` with a 5-minute timeout
(`RUNNER_NATIVE_INSTALL_TIMEOUT_MS`). Its output goes to `install.log` and,
summarised, to the page's backend log ("installing better-sqlite3@12.4.1
for linux-x64 node 24 (ABI 137)…", then "installed in 4.2 s" or the error
with the last lines of npm's output). A failed install is remembered for
10 minutes (no reinstall storm on every request), and the next attempt is
immediate after a new version or a manual "retry" in the Backend panel.

Network: npm uses the runner's own network, **not** the egress proxy (the
registry and prebuild hosts — GitHub releases for `better-sqlite3` — are
not the page's business). `RUNNER_NPM_REGISTRY` and a mounted `.npmrc`
cover private registries and mirrors.

Toolchain: the default image (`node:24-slim`) has npm but no compiler, so
only packages with prebuilds for linux x64/arm64 glibc install — which
covers the usual ones (`better-sqlite3`, `sharp`, `argon2`, `bcrypt`,
`@duckdb/node-api`, `lmdb`, `canvas`). A build arg
(`--build-arg NATIVE_TOOLCHAIN=1`, adds `python3 make g++`) produces an
image that can compile the rest with `node-gyp`.

### When it happens

- **On publish**: after committing a version with `native`, specola calls
  `POST {runner}/native/prepare {versionId, codeHash}` (best effort, fire
  and forget), so the install usually finishes before anyone opens the
  page. `specola-publish` waits for it (polling `GET …/native/status`,
  up to the timeout) and prints the outcome, so the author sees "native
  dependencies ready" or npm's error right away, not at the first call.
- **On worker start** otherwise (runner restarted, volume cleaned, new
  ABI): the worker starts once the install is done. Calls arriving
  meanwhile answer 503 `backend-preparing` with `Retry-After: 5`; the SDK
  surfaces it as `BackendUnavailable` (`reason: "preparing"`) and the
  viewer shows "Installing the backend's native dependencies…". Scheduled
  runs wait for it.

### Loading

- The worker of a version with `native` gets `--allow-addons` and
  `--allow-fs-read=/data/native/{nativeKey}`.
- Resolution: the bundle's bare `import "better-sqlite3"` is resolved by a
  `module.registerHooks` resolve hook in `bootstrap.mjs` (next to the
  existing `node:sqlite` one): a specifier whose package name is in the
  version's `native` map is resolved as if imported from
  `/data/native/{nativeKey}/package.json`. Any other bare specifier fails
  as today. The content-addressed code directory stays untouched (no
  `node_modules` symlink in it).
- CommonJS packages (most native ones) load through ESM's CJS interop,
  `require` inside them works normally.

### `ctx.dataDir`

Native libraries want a **file path** (`new Database(path)`), and the
backend has no documented place for one. New:

- `ctx.dataDir`: absolute path of `/data/pages/{pageId}/data/`, created on
  first access, writable by the worker.
- It **counts against the page's disk quota** (the usage walk already covers
  the whole page directory; there is no `max_page_count` on databases the
  addon opens, so the page can overshoot until the next measurement, and
  the next call is refused while over quota).
- **Snapshots, export, import and wipe include it**: files that start with
  the SQLite header are copied with SQLite's online backup (consistent while
  the worker writes; WAL is checkpointed into the copy), everything else
  byte for byte (best effort: a file being written during the copy may be
  inconsistent — documented). Per-user data stays `userDb`'s job; nothing
  in `dataDir` is per user.
- `backend_query` (MCP) gains an optional `file` naming a SQLite database
  under `dataDir`, with the same read-only rules.

### Garbage collection

A `native/{key}` directory not used by the current version of any page
for 7 days is removed (checked daily and at start);
`RUNNER_NATIVE_DISK_BYTES` (default 5 GiB) caps the cache, oldest unused
first. Removing one is always safe: it is reinstalled on demand.

## Health, API and MCP

- `GET {runner}/health` gains `native: {enabled, platform: "linux-x64-glibc",
  node: "24.x", abi: 137, toolchain: bool}`.
- `GET /api/me` → `backends.native: {enabled, platform, toolchain}`.
- Backend panel in the viewer: the declared native packages, install state
  (ready / installing / failed, with the log), "Retry install".
- MCP instructions, when enabled: *"Backends may use npm packages with
  native addons: list them in the plugin's `backend.native`; they are
  installed on the runner (`linux-x64`, prebuilds only unless the toolchain
  is present)."* When disabled: *"…native addons (better-sqlite3, sharp, …)
  are not available: use `ctx.db` (node:sqlite) or pure-JS/WASM
  packages."*

## Configuration

| Var | Where | Meaning |
| --- | --- | --- |
| `RUNNER_NATIVE` | runner | `on` allows native packages (default off) |
| `RUNNER_NATIVE_INSTALL_TIMEOUT_MS` | runner | per install, default 300000 |
| `RUNNER_NATIVE_DISK_BYTES` | runner | cache cap, default 5 GiB |
| `RUNNER_NPM_REGISTRY` | runner | registry URL for installs |
| `NATIVE_TOOLCHAIN` | runner image build arg | add python3/make/g++ |

## A cheaper alternative for `better-sqlite3` specifically

Many projects want `better-sqlite3` only because an ORM or query builder
(Drizzle, Kysely, Knex) has a driver for it. `node:sqlite`'s API is close
(`prepare`, `run`, `get`, `all`, `exec`). The plugin could ship an alias,
`@specola/vite-plugin/better-sqlite3`, a thin shim over `ctx.db`/the
guarded `node:sqlite` covering the subset those drivers use (`pragma`,
`transaction`, `.raw()`, `.pluck()`, named parameters), enabled with
`backend: { shims: ["better-sqlite3"] }`. It keeps the full sandbox,
snapshots and quota, and needs no runner change. It doesn't replace the
general mechanism (sharp, argon2, duckdb…), but it's worth doing first if
`better-sqlite3` is the immediate need.

## Delivery plan

1. Manifest field and validation (Go), plugin `backend.native` (version
   pinning, externals, the hint in `noNativeAddons`), runner native cache
   with install on worker start, resolve hook, `--allow-addons`, health
   field, `RUNNER_NATIVE`. e2e: a bundle using `better-sqlite3`.
2. `ctx.dataDir` with quota, snapshots, export/import, wipe.
3. Prepare on publish, `backend-preparing`, publish CLI waiting for the
   install, Backend panel state and retry, MCP instructions.
4. GC, toolchain image variant, `backend_query` on `dataDir` files.

## Open questions

- **Transitive versions**: only the top-level packages are pinned; their
  dependencies resolve at install time. Shipping a trimmed lockfile under
  `.specola/native/` would make installs fully reproducible; probably not
  worth it for native packages, whose dependencies are few.
- **musl**: an Alpine runner image would need musl prebuilds; the key
  includes libc, so it works where prebuilds exist.
- **Pure-JS dependencies next to natives**: a native package's JS
  dependencies come from npm, not from the bundle. If the app also imports
  one of them directly, two copies may load (bundled and installed). Fine
  in practice; listing that package in `native` too makes it one copy.
