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
npm i -D https://<your-specola>/tools/specola-vite-plugin-1.0.0.tgz
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
  scripts (`worker.format: "iife"`); file names keep their content hashes;
- rewrites the references in `index.html` to the bundle's files as
  `__SPECOLA_BASE__/assets/…`: the server replaces the placeholder with the
  bundle's file URL when it serves the page;
- adds `<meta name="generator" content="specola-vite-plugin/1.0.0">` and, with
  `searchText`, a `<noscript data-specola-search>` element;
- fails the build when it exceeds the limits or emits an HTML file other
  than `index.html`, and warns when JS or CSS refers to a `public/` file by a
  root-absolute path (`"/logo.png"`), which would not resolve in a bundle.

On `vite dev` it provides a stand-in `window.specola`
(`{ base: "/", basename: "", persistent: false, flush }`) so the app runs
locally unchanged.

## Publish

1. Ask Specola for an upload link with the MCP tool `create_bundle_upload`
   (`kind: "new"` with a `title`, or `kind: "version"` with the page `id`).
   It answers with the exact command to run.
2. In the project directory, run it:

   ```sh
   npx specola-publish --upload 'https://<your-specola>/upload/bundle/<token>'
   ```

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
change, so a path router doesn't route there.

### Workers

Only classic workers work (pages run on an opaque origin, where module
workers cannot start). Write workers the usual Vite way — the plugin builds
them as classic scripts:

```js
const worker = new Worker(new URL('./worker.js', import.meta.url));
```

`import` statements inside the worker are fine (they are bundled into it).
Inside the worker, `self.location` is a `blob:` URL: pass it any absolute
URL it needs to fetch (for instance `window.specola.base + 'assets/…'` or a
`new URL('./data.bin', import.meta.url).href` computed in the page).
SharedWorkers and service workers are not supported.

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

### Storage

`localStorage` works and is saved by Specola per page and user
(`window.specola.persistent` says whether it is; `await window.specola.flush()`
waits for pending writes). Cookies, IndexedDB and `sessionStorage` are not
available on the page's opaque origin.

## Limits

| Limit | Value |
| --- | --- |
| files per bundle (including `index.html`) | 2000 |
| one file | 25 MiB |
| `index.html` | 5 MiB |
| whole bundle | 100 MiB |

Paths must not contain `?`, `#`, `%`, `\` or control characters, and
`index.html` must be the only HTML file. The build fails early when a rule is
broken; `specola({ limits: { … } })` can lower the limits to fail even
earlier.

## Not supported

- Multi-page apps: only `index.html` may be HTML.
- Module workers, SharedWorkers, service workers.
- Server-side rendering, API routes, or anything that needs a server: a
  bundle is static files.
- Building on the server: bundles are built on your machine and uploaded.

## Developing the plugin

Plain ESM JavaScript with a hand-written `index.d.ts`, no build step (the
Specola server packs these files as they are). Tests use `node --test` and
the `vite` dev dependency:

```sh
cd plugin && npm install && npm test
```
