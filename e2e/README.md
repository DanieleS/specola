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

Run it from the repository root:

```sh
(cd web && npm install && npm run build)   # the SPA, embedded in the server
(cd plugin && npm install)                 # Vite, to build the app
node e2e/bundles.mjs                       # or: make e2e
```

It needs Go, `psql` and a PostgreSQL where it may create and drop throwaway
databases (`SPECOLA_E2E_DATABASE_URL`, default
`postgres://postgres:dev@localhost:5432/postgres?sslmode=disable`), port 18080
free (`SPECOLA_E2E_PORT`), and Playwright with Chromium (`require('playwright')`
must resolve, e.g. installed globally). The web build overwrites the committed
placeholder `internal/webui/dist/index.html`: restore it with
`git checkout internal/webui/dist/index.html` before committing.
