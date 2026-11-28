# @specola/vite-plugin

Build a [Vite](https://vite.dev) app as a **Specola bundle** and publish it.

A bundle is a page whose content is a whole single-page app — JavaScript
chunks, CSS, workers, fonts, images, JSON, wasm — uploaded file by file and
served lazily: the viewer downloads only what the app requests. Use it for
anything with a build step (React, Svelte, Vue, plain Vite, several files,
code splitting). A single self-contained HTML file is simpler to publish with
the MCP tool `publish_page`.

The contract between the plugin, the CLI and the server is
[`docs/spa-bundles.md`](../docs/spa-bundles.md).

## Install

The plugin is served by your Specola instance (Node ≥ 18, Vite ≥ 5):

```sh
npm i -D https://<your-specola>/tools/specola-vite-plugin-1.1.0.tgz
```

## Configure

```js
// vite.config.js
import { defineConfig } from 'vite';
import specola from '@specola/vite-plugin';

export default defineConfig({
  plugins: [
    // your framework plugin, e.g. react() or svelte(), then:
    specola({
      // Optional: text full-text search should find the page by (the app's
      // content is rendered by JavaScript, so it is not indexed otherwise).
      searchText: 'Quarterly revenue explorer: regions, products, forecasts',
    }),
  ],
});
```

What the plugin does on `vite build`:

- builds with `base: "./"` so every file refers to the others relatively (a
  `base` you set is ignored, with a warning), and builds workers as classic
  scripts (`worker.format: "iife"`, with a worker's dynamic `import()`s
  inlined into it); file names keep their content hashes;
- rewrites the references in `index.html` to the bundle's files as
  `__SPECOLA_BASE__/assets/…`: the server replaces the placeholder with the
  bundle's file URL when it serves the page;
- adds `<meta name="generator" content="specola-vite-plugin/1.1.0">` and, with
  `searchText`, a `<noscript data-specola-search>` element;
- fails the build when it exceeds the limits or emits an HTML file other
  than `index.html`, and warns when JS or CSS refers to a `public/` file by a
  root-absolute path (`"/logo.png"`), which would not resolve in a bundle,
  and when the app uses an external SVG sprite (`<use href="icons.svg#id">`),
  which can't load in a bundle (see SVG icons).

On `vite dev` it provides a stand-in `window.specola`
(`{ base: "/", basename: "", persistent: false, flush, fetch, backend }`) so
the app runs locally unchanged.

## Publish

1. Ask Specola for an upload link with the MCP tool `create_bundle_upload`
   (`kind: "new"` with a `title`, or `kind: "version"` with the page `id`).
   It answers with the exact command to run.
2. In the project directory, run it:

   ```sh
   npx --no -- specola-publish --upload 'https://<your-specola>/upload/bundle/<token>'
   ```

   `--no` makes `npx` run only the `specola-publish` installed in the
   project. Without it, in a directory where the plugin isn't installed,
   `npx` would download and run whatever package has that name on the public
   npm registry, handing it the upload link. If the command fails with a 404
   from the registry or "npx canceled due to missing packages", install the
   plugin in this directory first (`npm i -D <tarball URL>`, see Install).

`specola-publish` checks the link, runs `vite build`, uploads only the files
the server does not have yet, and prints the result as JSON on stdout
(`{"id","version","url"}`); progress goes to stderr. Options:

| Option | Meaning |
| --- | --- |
| `--upload <url>` | the upload link (required) |
| `--dir <dir>` | the build output directory, if not `dist` |
| `--no-build` | upload `--dir` as it is |
| `--note <text>` | the version note (overrides the one given to `create_bundle_upload`) |

The link is valid for 30 minutes and can be used once: if it has expired or
was used, create a new one. OS junk (`.DS_Store`, `Thumbs.db`, `__MACOSX/`,
`.git/`) is never uploaded.

`specola-publish` runs the project's own Vite, so run it from the project
directory (or build yourself and pass `--no-build --dir <dir>`). Symbolic
links in the output are followed only while they point inside it. If the
connection drops during the final commit and the retry reports the link as
used, the page was most likely published: check it before publishing again.

## Backend

An app can have server-side code: a **page backend**, built from the same
project, published with the same command, and reached from the app with
`specola.fetch`. It runs in Node on the instance's backend runner, with
SQLite databases and a file store of its own. Backends are optional on a
Specola instance: `specola-publish` refuses a bundle with a backend where
they are not enabled (the MCP tool `create_bundle_upload` says whether they
are). The contract is [`docs/page-backends.md`](../docs/page-backends.md).

### Add one

```js
// vite.config.js
specola({
  server: 'server/index.ts',
  backend: {
    secrets: ['OPENAI_API_KEY'], // names the code expects; the page's owner sets the values
  },
});
```

The `backend` option (or a `specola.backend.json` next to `vite.config`,
not both) is the manifest: `public`, `egress`, `secrets`, `cron`, `topics`,
`dependencies` (see the contract). The build fails on a manifest the server would refuse.

```ts
// server/index.ts
import type { Handler } from '@specola/vite-plugin/server';

export default {
  async fetch(request, ctx) {
    const url = new URL(request.url); // https://page.invalid/<path>?<query>
    ctx.db.exec('CREATE TABLE IF NOT EXISTS votes (sub TEXT PRIMARY KEY, choice TEXT)');
    if (request.method === 'POST' && url.pathname === '/api/vote') {
      const { choice } = await request.json();
      ctx.db.prepare('INSERT OR REPLACE INTO votes VALUES (?, ?)').run(ctx.user!.sub, choice);
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
} satisfies Handler;
```

`fetch(request, ctx)` takes a standard `Request` and returns a `Response`
(a router such as Hono works as is). Treat every request as untrusted:
anyone who can open the page can send anything; decide with `ctx.user` and
`ctx.role`. `ctx` has:

| | |
| --- | --- |
| `user`, `role`, `link`, `page` | who is calling (`owner`, `editor`, `viewer`…) and the page |
| `visitor` | on a public link, the anonymous visitor calling (`{id}`, stable per link and browser), or `null` |
| `db` | SQLite (`node:sqlite`) shared by everyone on the page, opened on first use |
| `userDb` | SQLite private to `ctx.user`, or to `ctx.visitor` on a public link (at most 16 MiB); `null` without either |
| `files` | a file store: `put(key, body, {contentType})`, `get(key)`, `delete(key)`, `list(prefix)` |
| `secrets` | the declared secrets that are set (see Secrets) |
| `publish(topic, data, {to})` | push to the open pages subscribed to `topic` (see Push) |
| `waitUntil(p)`, `log` | keep working after responding; `console` for the backend log |

Data belongs to the page, not to a version: migrate the schema in code
(`PRAGMA user_version` is the usual way). Types are in
`@specola/vite-plugin/server` (they need `@types/node` 22.13 or newer).

In the app:

```js
const res = await specola.fetch('/api/vote', { method: 'POST', body: JSON.stringify({ choice: 'a' }) });
```

Same signature as `fetch`, with a path starting with `/` (or a `URL` or
`Request` on the page's own origin); the response
streams (LLM output, long exports). It rejects with an error named
`BackendUnavailable` (`err.reason`: `disabled`, `unavailable`, `superseded`
when a newer version of the page is current, `offline`);
`specola.backend` (`{enabled, available}`) lets the app degrade. Only the
current version of a page with a backend can be opened.

**Offline is the app's to handle.** A page can be installed as an app and
opened with no network (see Specola's docs/page-apps.md): its backend calls
then reject with `reason: "offline"`, and nothing is queued. Show what the
app can without them, and say what needs a connection.

### What the build does

After the app, `vite build` builds the server entry with Vite's SSR build
(target Node 22, ES module, every dependency bundled in but the
`dependencies` below) into
`dist/.specola/server/index.mjs`, and writes the manifest to
`dist/.specola/backend.json`. Specola never serves `.specola/`; only the
runner reads it. The build fails when:

- the app imports the server entry, or anything in its directory: that code
  would be served to every viewer (keep shared code outside `server/`);
- the backend would bundle a native addon (`.node`, or a loader such as
  `bindings`): the error names the package to add to `dependencies`;
- a package listed in `dependencies` isn't installed in the project;
- the app itself puts files under `.specola/` (say, in `public/`).

### Dependencies (native addons)

What can't be bundled — a native addon is a binary for your machine, not
the runner's — goes in `dependencies`; the runner installs it with pnpm
for its own platform and Node:

```js
specola({
  server: 'server/index.ts',
  backend: { dependencies: ['better-sqlite3'] },
});
```

```ts
// server/index.ts
import Database from 'better-sqlite3';
import path from 'node:path';

export default {
  fetch(request, ctx) {
    const db = new Database(path.join(ctx.dataDir, 'app.db'));
    // ...
  },
};
```

- A list of names is pinned to the versions installed in the project
  (the ones `vite dev` runs with): the manifest gets
  `{"better-sqlite3": "12.4.1"}`. An object of exact versions works too.
- Those packages, and their subpaths, stay `import "name"` in the bundle;
  everything else is still bundled.
- The first call after publishing may answer 503 for a few seconds while
  the runner installs them; the backend log shows the install and, if it
  fails, pnpm's output. Packages without a prebuilt binary for Linux need
  a runner image with a toolchain.
- `ctx.dataDir` is a directory of the page's own for files such libraries
  open; it counts against the page's 1 GiB and is in snapshots, exports
  and imports (SQLite databases there are copied consistently, even while
  open). Under `vite dev` it is `.specola-dev/data/`.
- A backend with dependencies can load native code, which isn't held by
  the runner's sandbox: on instances that turned installs off
  (`RUNNER_DEPS=off`) it answers 500.

### Secrets

List the names in the manifest (`secrets: ['OPENAI_API_KEY']`); the code
reads `ctx.secrets.OPENAI_API_KEY`. The values are set by the page's
owners in Specola, in the viewer's **Backend** panel, never in code or in
the bundle: they are stored encrypted, nobody can read one back, and
`ctx.secrets` only has the declared names that are set (check, and answer
something useful when one is missing). An agent can see which are missing
(`list_secrets`, and `get_page`'s `backend.secrets_missing`) but cannot set
one: ask the page's owner to. A secret is a name of `A`–`Z`, digits and
`_`, starting with a letter.

### Outbound HTTP (egress)

The backend calls other services with the global `fetch`, but only the
hosts in the manifest's `egress` (`"api.openai.com"`, or `"*.googleapis.com"`
for any subdomain; ports 443 and 80 only, no IP addresses):

```js
specola({ server: 'server/index.ts', backend: { egress: ['api.openai.com'], secrets: ['OPENAI_API_KEY'] } });
```

```ts
const res = await fetch('https://api.openai.com/v1/models', {
  headers: { authorization: `Bearer ${ctx.secrets.OPENAI_API_KEY}` },
});
```

On the runner every worker's HTTP goes through Specola's egress proxy: a
host not listed, or one that resolves to a private, loopback or link-local
address, makes `fetch` fail, and the backend log says
`egress refused: <host>:<port> (<reason>)`. Raw sockets (`node:net`,
`node:tls`) bypass the proxy; an instance that must close them does it with
a network policy on the runner's container (see the runner's README).

### Push

The backend pushes to the pages open on it; the app subscribes:

```ts
// server: after a change
ctx.publish('scores', { team: 'a', score: 3 });
ctx.publish('inbox', { unread: 2 }, { to: someone.sub }); // only that user's pages
```

```js
// app
const unsubscribe = specola.subscribe('scores', (data, topic) => render(data));
```

A topic is 1 to 128 of letters, digits and `_.:/-`; `data` is anything
JSON can carry, at most 7 KiB serialised (a bad topic or data throws a
`TypeError`); at most 50 pushes a second per page. Several subscriptions to
one topic share one stream; a page listens to at most 20 topics at once.
It is **best effort**: there is no replay, so a push sent while a page was
not connected (offline, reloading, the stream reopening) is not seen. Send
small notices and let the app reload what it shows with `specola.fetch`
(on each notice, or when the tab becomes visible again) rather than
pushing the state itself. Viewers of an older version get no pushes (only
the current version is live).

### Scheduled jobs (cron)

```js
backend: { cron: [{ name: 'nightly', schedule: '0 3 * * *' }] }
```

```ts
export default {
  async fetch(request, ctx) { /* … */ },
  async scheduled(event, ctx) {
    // event: {name: 'nightly', scheduledTime: <ms>}
    if (event.name === 'nightly') ctx.db.exec("DELETE FROM sessions WHERE expires < unixepoch()");
  },
} satisfies Handler;
```

Up to 10 jobs, five-field cron schedules **in UTC**, at most once a minute
(no `@daily`-style macros). Specola runs them while the page is not
archived: one `scheduled` handler gets every job (tell them apart by
`event.name`), with `ctx.role` `"cron"`, no user (`ctx.user` and
`ctx.userDb` are `null`), the secrets and `ctx.publish`, for at most 5
minutes. A run missed while Specola or the runner was down is not caught
up. The **Backend** panel shows each job's next and last run and its
outcome; failures are in the backend log.

### Public routes

A public link (`/s/<token>`) to a page with a backend opens it for anyone
with the link, without signing in, and lets them call only the routes the
manifest lists in `public`:

```js
backend: {
  public: ['GET /api/stats', 'POST /api/votes', 'GET /api/public/*'], // "*" as the last segment: any rest of the path
  topics: { public: ['scoreboard'] }, // topics a public visitor may subscribe to
}
```

Any other route answers 403 `not-public` without reaching the backend. On
a public call `ctx.user` and `ctx.userDb` are `null`, `ctx.role` is
`"public"` and `ctx.link` is `{id, label}` of the link: treat those calls as
coming from anyone on the internet (validate everything, keep them cheap).
Public calls are rate-limited (60 a minute per link and visitor, 600 a
minute per link), public visitors only get the `topics.public` topics and
never targeted pushes, and revoking the link stops them at once. Links to a
backend page always open its current version.

### Under `vite dev`

The handler runs inside the dev server at `/__specola/x/…`, reloaded when
you edit it, and `specola.fetch` goes there:

- `ctx.user` is `SPECOLA_DEV_USER` (`me@example.com` or
  `Name <me@example.com>`; default `dev@localhost`), with the role `owner`;
- the databases and files live in `.specola-dev/` in the project: add it
  to `.gitignore`, delete it to start over;
- `ctx.secrets` come from the environment and `.env` files, only the
  declared names;
- `ctx.publish` reaches the dev pages' `specola.subscribe` (through the
  event stream at `/__specola/events`); a push `to` a user other than the
  dev user reaches nobody;
- scheduled jobs don't run on their schedule: the dev server lists them
  when it starts, and `POST /__specola/cron/<name>` runs one now (with
  `role: "cron"` and no user), answering `{"status":"ok"|"no-handler"|"error"|"timeout"}`
  and logging the outcome in the terminal:

  ```sh
  curl -X POST http://localhost:5173/__specola/cron/nightly
  ```

Not simulated: public links (every dev call is the owner's: try public
routes on the published page, through a public link) and the `egress`
allowlist (the dev backend's `fetch` reaches any host from your machine;
the runner enforces the list, so test the published page too).

### Testing a published backend (agents)

Specola's MCP server has tools to check a backend once it is published,
each acting as the signed-in user with the same access rules as the app:

| Tool | |
| --- | --- |
| `call_backend(id, method, path, body?, headers?)` | calls the current version as `specola.fetch` would; returns status, headers and up to 64 KiB of body |
| `backend_logs(id, since?)` | the backend log: console output, errors with their `ref`, egress refusals, cron outcomes (owners and editors) |
| `backend_query(id, sql, params?)` | one read-only SQL statement on the shared database (`ctx.db`), up to 1000 rows (owners and editors) |
| `list_secrets(id)` | the declared secrets and whether each is set; owners set values in the UI only |

A failed call answers `{"error":"backend-error","ref":"…"}`: look the `ref`
up in `backend_logs`.

## Writing the app

### Routing

A bundle is served under a path such as `/view/<id>` (or `/s/<token>` for a
public link), and every path below it serves the same app, so the History API
works, including reloads and deep links. Tell the router the prefix:

```jsx
<BrowserRouter basename={window.specola?.basename}>
```

or use a hash router (`createHashRouter`, `#/…` URLs), which needs nothing.
A hash router is the better choice for an app people may open offline: a
page kept for offline viewing runs from a `blob:` URL, whose path can't
change, so a path router doesn't route there. Offline, a hash router must
navigate with `history.pushState` (React Router's hash router does) or with
links (`<a href="#/route">`, which Specola handles there); assigning
`location.hash` does nothing on a `blob:` page.

### TypeScript

`window.specola` is typed by `@specola/vite-plugin/client`. The plugin's
main types are only seen by `vite.config.ts`, so add the client types to
the app's own program, in `tsconfig.app.json`:

```json
"types": ["vite/client", "@specola/vite-plugin/client"]
```

or with a line in any `.d.ts` file under `src/` (say, `src/vite-env.d.ts`):

```ts
/// <reference types="@specola/vite-plugin/client" />
```

### Workers

Only classic workers run (pages run on an opaque origin, where module
workers cannot start), and the plugin builds workers as classic scripts.
Write them the usual Vite way, with `{ type: 'module' }`:

```js
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
```

`{ type: 'module' }` is what `vite dev` needs to run a worker that has
`import` statements (in dev, Vite serves the worker's source as a module);
in the published bundle Specola starts it as the classic script the plugin
built. `import` statements and dynamic `import()` inside the worker are fine:
they are bundled into it.

Inside the worker, `self.location` is the worker script's own URL, so its
own files resolve as in the page: `import url from './data.json?url'`,
`new URL('./x.bin', import.meta.url)`, and relative URLs given to `fetch`
or `importScripts`. SharedWorkers and service workers are not supported.

### Fetching your own files

Import the file's URL and fetch it; the URL is relative to the module, so it
resolves inside the bundle:

```js
import dataUrl from './data.json?url';
const data = await (await fetch(dataUrl)).json();
```

The same goes for `new URL('./file.bin', import.meta.url)`. Do not use
root-absolute URLs (`fetch('/data.json')`, `<img src="/logo.png">` from JS):
they point at the Specola server, not at the bundle. Files in `public/` are
included in the bundle, but reach them from code as
`window.specola.base + 'logo.png'`, or better, import them from `src/`.
References to `public/` files in `index.html` itself are rewritten and work.

### SVG icons

External SVG sprites don't work in a bundle: `<svg><use href="/icons.svg#x"></use></svg>`
(as in the `npm create vite` templates) shows nothing, whatever the URL,
because the page runs on an opaque origin and browsers load `<use>`
references only from the page itself. The plugin warns when it sees one.
Inline the sprite instead: import its markup (`import sprite from
'./icons.svg?raw'`), put it in the page once (for instance in a hidden
`<div>` at the top of `<body>`) and use `<use href="#x">`; or inline each
icon's `<svg>`, or use SVG files as images (`<img src={iconUrl}>`), which
work.

### Storage

`localStorage` works and is saved by Specola per page and user
(`window.specola.persistent` says whether it is; `await window.specola.flush()`
waits for pending writes). `sessionStorage` and `document.cookie` work in
memory, for one load only; IndexedDB is not available on the page's opaque
origin.

## Limits

| Limit | Value |
| --- | --- |
| files per bundle (including `index.html`) | 2000 |
| one file | 25 MiB |
| `index.html` | 5 MiB |
| whole bundle | 100 MiB |
| backend request body | 25 MiB |
| backend response | 100 MiB, streamed |
| backend request time | 30 s to the response, 5 min in all |
| backend data (databases and files) | 1 GiB per page |
| backend push (`ctx.publish`) | 7 KiB of JSON, 50 a second per page |
| backend cron jobs | 10 per page, at most once a minute, 5 min per run |
| backend public calls | 60 a minute per link and visitor, 600 per link |

The backend's files under `.specola/` count toward the bundle limits.
Paths must not contain `?`, `#`, `%`, `\` or control characters, and
`index.html` must be the only HTML file. The build fails early when a rule is
broken; `specola({ limits: { … } })` can lower the limits to fail even
earlier.

## Not supported

- Multi-page apps: only `index.html` may be HTML.
- Module workers (a worker is built and run as a classic script),
  SharedWorkers, service workers.
- External SVG sprites (`<use href="icons.svg#id">`): inline them.
- Server-side rendering. Server code is a page backend (see Backend), on
  instances that enable them; elsewhere a bundle is static files.
- Building on the server: bundles are built on your machine and uploaded.

## Developing the plugin

Plain ESM JavaScript with a hand-written `index.d.ts`, no build step (the
Specola server packs these files as they are). Tests use `node --test` and
the `vite` dev dependency:

```sh
cd plugin && npm install && npm test
```
