# End-to-end checks

`bundles.mjs` checks SPA bundles ([docs/spa-bundles.md](../docs/spa-bundles.md))
in a real browser. It builds [`app/`](app) with the Vite plugin, builds and
starts Specola twice (on the app origin alone, then with a separate view
origin), publishes the build with the real `specola-publish` CLI, and checks
inside the sandboxed frame that the app renders, a lazy `import()` resolves
and its CSS applies, workers run (one finding its own files by relative
URLs), a fragment link (`<a href="#/…">`) changes the hash, fetched JSON and
CSS `url()`s load, `window.specola.base` and `basename` are right, a deep
path survives `pushState` + reload and a direct load, and public links work.
It also opens the viewer 375 px wide and checks nothing sticks out or
overlaps. Then, in the app, it opens and saves the bundle
for offline, goes offline (`context.setOffline`), reloads, and checks the
kept copy runs the same way from Cache Storage without a request for its
files, that its `localStorage` starts from the latest saved data and keeps
writes made offline across a reload (and saves them once back online), that
a plain page still shows offline, and that a bundle missing a
file is reported as not available offline. It also checks that the new-page
form's commands are dropped when the title changes, and that files of a
version nobody keeps are pruned when the app starts, unless another tab is
storing it.

`backends.mjs` checks page backends
([docs/page-backends.md](../docs/page-backends.md)) end to end. It starts the
real runner (`runner/`, its data in a temporary directory) and Specola in
front of it on free ports, builds [`app-backend/`](app-backend) (an app whose
`server/index.ts` uses `ctx.db`, `ctx.userDb` and `ctx.files`, streams an
answer and throws on one route), publishes it with `specola-publish` and opens
it through the viewer in Chromium. It checks that the shared counter counts
and persists, that a `FormData` upload round-trips byte for byte, that
streamed chunks reach the page as the backend writes them, that a throwing
route answers 500 `backend-error` with a `ref` found in the backend log (and
in the viewer's log panel), and that a viewer-only user (a second Specola on
the same database, behind a trusted user header) may call the backend with a
database of their own but gets 403 on the log. Then it publishes version 2
and checks that version 1 answers 410 and is no longer viewable, that the
frame still showing it gets `superseded` and the viewer's reload notice, that
the data survived and that the runner snapshotted it. Then the data
lifecycle, through the viewer's Backend panel: a manual snapshot restored
after the data changed, an export, a reset of the shared data and the export
imported back byte for byte, a path-traversal zip refused with `bad-import`
and nothing changed, an editor who may export but gets 403 on restore,
import and reset, a viewer who downloads their own data (a SQLite file with
their rows), deletes it and then gets 404 `no-data`, and version 1 restored
from the history with its data. Then it restarts Specola with
`SPECOLA_BACKEND_PURGE_AFTER_DAYS`, archives the page, moves its archive
date back in the database, and checks the Archived list shows the purge
date and that the purge (its first round, a minute after start) deletes the
runner's data. Last, it restarts
Specola without the backend variables and checks that `/api/me`, the MCP
instructions, the upload grant, the CLI and the manifest step all say
backends are disabled, and that the page still opens with the disabled
notice while `specola.fetch` rejects with `BackendUnavailable`.

Before the purge, it covers steps 3–7, with Specola restarted with its test
hooks (`SPECOLA_TEST_CRON_EVERY=1s`, `SPECOLA_TEST_CLOCK_OFFSET=1m`, honoured
only with the dev auth bypass) and the runner started with
`RUNNER_EGRESS_ALLOW_LOOPBACK_FOR_TESTS=1` (refused under
`NODE_ENV=production`). **Secrets**: `backendSecretsMissing` before and
after, the owner setting the value from the viewer's notice and *Secrets*
tab at 375 px, the handler seeing it (its length only), an editor refused,
the value never in the API and stored encrypted, an undeclared name never
passed. **Egress**: a backend `fetch` to `localhost` (served by the script)
goes through, a host not on the list is refused and logged. **Scheduled
jobs**: the every-minute job runs `scheduled()` (role `cron`), writes to
`ctx.db`, and shows `ok` in the API and the *Jobs* tab. **MCP**: the
instructions, `call_backend`, `backend_logs`, `backend_query` on the
counter (and a write refused), `list_secrets` and `get_page`. **Push**: two
users in two browser contexts, on the two Specolas (so through `NOTIFY`): a
call from one publishes, the other's `specola.subscribe` callback fires, a
targeted push reaches only its user, `unsubscribe()` stops it, and a new
version ends the streams with `superseded` and the viewer's reload notice.
**Public link**: the shell's CSP and headers, a public route answering as
role `public` with `ctx.link`, a private one answering 403 `not-public`, a
public topic's push reaching the page, a private topic refused, the per-IP
rate limit (429 with `Retry-After`), and a revoked link stopping calls.

`sdk-bridge.mjs` checks the frame ↔ viewer half of backend calls on its own,
without Go or Postgres: the page SDK (`internal/server/pagesdk.js`) in a
sandboxed frame and the viewer's relay (`web/src/lib/pagedata.ts`, bundled
with esbuild) in its parent, against a small Node server playing Specola and
the runner: streaming, queueing before the port, headers, `FormData` bodies,
aborts, the `BackendUnavailable` reasons, redirects and path checks. It also
checks `specola.subscribe` (shared subscriptions, unsubscribe, events
through the port), the viewer's push stream against a fake events endpoint
(one `EventSource` per topic set, `superseded`), and the public-link shell
(`internal/server/publicshell.html`) under its real CSP against fake
`/s/…`, `/p/…/x` and `/p/…/events` endpoints.

Run them from the repository root:

```sh
(cd web && npm install && npm run build)   # the SPA, embedded in the server
(cd plugin && npm install)                 # Vite, to build the apps
node e2e/bundles.mjs                       # or: make e2e (all three)
node e2e/sdk-bridge.mjs
node e2e/backends.mjs
```

`bundles.mjs` and `backends.mjs` need Go, `psql` and a PostgreSQL where they
may create and drop throwaway databases (`SPECOLA_E2E_DATABASE_URL`, default
`postgres://postgres:dev@localhost:5432/postgres?sslmode=disable`);
`bundles.mjs` needs port 18080 free (`SPECOLA_E2E_PORT`), `backends.mjs` Node
22 or later (the runner uses `node:sqlite`). All three need Playwright with
Chromium (`require('playwright')` must resolve, e.g. installed globally).
The web build overwrites the committed placeholder
`internal/webui/dist/index.html`: restore it with `git checkout internal/webui/dist/index.html` before committing.
