// @specola/vite-plugin: builds a Vite app as a Specola bundle.
// The contract it implements is docs/spa-bundles.md in the Specola repository,
// and docs/page-backends.md for an app with a server (the `server` option).

import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { buildServer, isServerModule, listOutput, resolveBackend } from './lib/backend.js';
import { CRON_PREFIX, DEV_DATA_DIR, DEV_PREFIX, EVENTS_PATH, createDevBackend, describeCron } from './lib/dev.js';
import { escapeHTML, injectBody, injectHead, rewriteIndexRefs } from './lib/html.js';
import { BACKEND_PREFIX } from './lib/manifest.js';
import { DEFAULT_LIMITS, bundleProblems, isHTMLPath, isJunk } from './lib/rules.js';
import { findSprites, spriteWarning } from './lib/sprites.js';
import { standInScript } from './lib/standin.js';
import { VERSION } from './lib/version.js';

export { VERSION };

/**
 * Stand-in for what the Specola page SDK provides, so that apps that read
 * window.specola run under `vite dev` (lib/standin.js). Storage is the
 * browser's own. specola.fetch and specola.subscribe go to the dev backend
 * when the app has one; otherwise fetch rejects as it does on a page without
 * a backend, and subscribe hears nothing.
 */
export function devSpecola(hasBackend) {
  return standInScript(hasBackend);
}

/**
 * The Specola Vite plugin.
 *
 * @param {import('./index.js').SpecolaOptions} [options]
 * @returns {import('vite').Plugin}
 */
export function specola(options = {}) {
  // Only numbers override a default: `{ maxFiles: undefined }` (say, from an
  // unset environment variable) must not switch a check off.
  const limits = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(options.limits ?? {})) if (k in limits && Number.isFinite(v)) limits[k] = v;
  let userBase;
  let userWorkerFormat;
  let config;
  let backend = null;
  let devBackend = null;

  return {
    name: 'specola',
    enforce: 'post',

    // Bundle files are served from a URL that is only known when the page is
    // viewed, so everything must be relative ("./"), and workers must be
    // classic scripts: the page runs on an opaque origin, where module
    // workers cannot start (the page SDK turns http(s) workers into classic
    // blob: workers that importScripts the real file). A classic script is
    // one file, so a worker's dynamic import()s are inlined into it: Rollup
    // (Vite 5 to 7) can't split an iife build and fails without this, with
    // an error that doesn't point here; Rolldown (Vite 8) inlines them anyway.
    config(user) {
      userBase = user.base;
      userWorkerFormat = user.worker?.format;
      return {
        base: './',
        worker: { format: 'iife', ...workerSplitOptions(this?.meta?.viteVersion) },
        // The dev backend's databases change on every write.
        server: { watch: { ignored: [`**/${DEV_DATA_DIR}/**`] } },
      };
    },

    configResolved(resolved) {
      config = resolved;
      // A build of the project's own SSR entry is none of the plugin's business.
      if (!resolved.build.ssr) backend = resolveBackend(options, resolved);
      if (userBase !== undefined && userBase !== './' && userBase !== '') {
        resolved.logger.warn(`[specola] ignoring base ${JSON.stringify(userBase)}: Specola bundles are built with base "./"`);
      }
      if (userWorkerFormat !== undefined && userWorkerFormat !== 'iife') {
        resolved.logger.warn(
          `[specola] ignoring worker.format ${JSON.stringify(userWorkerFormat)}: pages run on an opaque origin, where only classic workers can start`,
        );
      }
    },

    transformIndexHtml: {
      order: 'pre',
      handler() {
        if (config?.command !== 'serve') return undefined;
        return [{ tag: 'script', children: devSpecola(backend !== null), injectTo: 'head-prepend' }];
      },
    },

    // Mounted directly (not in a returned function) so that it runs before
    // Vite's own middlewares, whose SPA fallback would answer index.html.
    async configureServer(server) {
      if (!backend) return;
      // The project's Vite, for .env files: secrets come from there too.
      const { loadEnv } = await import('vite');
      const envDir = server.config.envDir === false ? null : (server.config.envDir ?? server.config.root);
      devBackend = createDevBackend({
        root: server.config.root,
        manifest: backend.manifest,
        load: () => server.ssrLoadModule(backend.entry),
        env: () => ({ ...(envDir ? loadEnv(server.config.mode, envDir, '') : {}), ...process.env }),
        logger: {
          info: (m) => server.config.logger.info(m, { timestamp: true }),
          warn: (m) => server.config.logger.warn(m, { timestamp: true }),
          error: (...a) => console.error(...a),
        },
      });
      server.middlewares.use(DEV_PREFIX, devBackend.middleware);
      server.middlewares.use(EVENTS_PATH, devBackend.events);
      server.middlewares.use(CRON_PREFIX, devBackend.cron);
      // Jobs don't run on their schedule here: say which there are and how
      // to run one.
      if (backend.manifest.cron.length > 0) {
        const print = () => {
          const addr = server.httpServer?.address();
          const port = addr && typeof addr === 'object' ? addr.port : server.config.server.port;
          server.config.logger.info(describeCron(backend.manifest, `http://localhost:${port ?? 5173}`));
        };
        if (server.httpServer && !server.httpServer.listening) server.httpServer.once('listening', print);
        else print();
      }
    },

    closeBundle() {
      if (config?.command === 'serve') {
        devBackend?.close();
        devBackend = null;
      }
    },

    generateBundle(_outputOptions, bundle) {
      if (config.command !== 'build' || config.build.ssr) return;
      if (this.environment && this.environment.config?.consumer === 'server') return;

      const publicFiles = listPublicFiles(config);
      const files = new Set([...Object.keys(bundle), ...publicFiles.map((f) => f.path)]);

      // .specola/ is the backend's, written by the server build only: the
      // app must not put files there (they would never be served), nor
      // bundle the server's code (which would be).
      const reserved = [...files].filter((p) => p.startsWith(BACKEND_PREFIX));
      if (reserved.length > 0) {
        this.error(`${BACKEND_PREFIX} is reserved for the page backend, but the app's build has ${reserved.join(', ')}`);
      }
      if (backend) {
        for (const f of Object.values(bundle)) {
          if (f.type !== 'chunk') continue;
          const leaked = (f.moduleIds ?? Object.keys(f.modules ?? {})).filter((id) => isServerModule(id, backend, config.root));
          if (leaked.length > 0) {
            this.error(
              `the app imports server code (${leaked.map((id) => relative(config.root, id.split('?')[0])).join(', ')}) into ${f.fileName}: ` +
                'it would be served to every viewer. Reach the backend with specola.fetch instead, and keep shared code outside the server directory.',
            );
          }
        }
      }

      const otherHTML = [...files].filter((p) => isHTMLPath(p) && p !== 'index.html');
      if (otherHTML.length > 0) {
        this.error(
          `Specola bundles are single-page apps: index.html must be the only HTML file, but the build also has ${otherHTML.join(', ')}`,
        );
      }

      const index = bundle['index.html'];
      if (!index || index.type !== 'asset') {
        this.error('Specola bundles need an index.html at the root of the build output (no index.html was emitted)');
      }
      let html = typeof index.source === 'string' ? index.source : Buffer.from(index.source).toString('utf8');
      const sprites = warnSprites(this, bundle, html);
      html = rewriteIndexRefs(html, files);
      html = injectHead(html, `<meta name="generator" content="specola-vite-plugin/${VERSION}">`);
      if (typeof options.searchText === 'string' && options.searchText.trim() !== '') {
        html = injectBody(html, `<noscript data-specola-search>${escapeHTML(options.searchText)}</noscript>`);
      }
      index.source = html;

      warnRootAbsolute(this, bundle, publicFiles, sprites);

      const sizes = [
        ...Object.values(bundle).map((f) => ({
          path: f.fileName,
          size: f.type === 'chunk' ? Buffer.byteLength(f.code, 'utf8') : byteLength(f.source),
        })),
        ...publicFiles,
      ].filter((f) => !isJunk(f.path));
      const problems = bundleProblems(sizes, limits);
      if (problems.length > 0) {
        this.error(`the build is not a valid Specola bundle:\n  - ${problems.join('\n  - ')}`);
      }
    },

    // After the app is written: the server build, into .specola/ of the same
    // output, then the limits again over everything that will be uploaded.
    writeBundle: {
      sequential: true,
      async handler() {
        if (!backend || config.command !== 'build' || config.build.ssr) return;
        if (this.environment && this.environment.config?.consumer === 'server') return;
        await buildServer(await import('vite'), config, backend);
        const outDir = resolve(config.root, config.build.outDir);
        const problems = bundleProblems(listOutput(outDir).filter((f) => !isJunk(f.path)), limits);
        if (problems.length > 0) {
          throw new Error(`[specola] the build with its backend is not a valid Specola bundle:\n  - ${problems.join('\n  - ')}`);
        }
      },
    },
  };
}

export default specola;

/**
 * The worker bundler options that keep a worker in one file, for the Vite
 * version running (this.meta.viteVersion, when Vite provides it): Rollup's
 * rollupOptions up to Vite 7; Vite 8 bundles with Rolldown, which inlines a
 * worker's dynamic imports on its own and deprecates rollupOptions.
 */
export function workerSplitOptions(viteVersion) {
  const major = Number(String(viteVersion ?? '').split('.')[0]);
  if (major >= 8) return {};
  return { rollupOptions: { output: { inlineDynamicImports: true } } };
}

function byteLength(source) {
  return typeof source === 'string' ? Buffer.byteLength(source, 'utf8') : source.byteLength;
}

/** Lists the files Vite copies from publicDir into the output, with sizes. */
function listPublicFiles(config) {
  if (!config.publicDir || config.build.copyPublicDir === false) return [];
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const path = relative(config.publicDir, full).split(sep).join('/');
        if (!isJunk(path)) out.push({ path, size: statSync(full).size });
      }
    }
  };
  walk(config.publicDir);
  return out;
}

/**
 * Warns about external SVG sprites in index.html (its source, html) and the
 * JS chunks: they can't load in a bundle (lib/sprites.js). Returns the
 * sprites found, by file, so the root-absolute warning doesn't give advice
 * that can't help them.
 */
function warnSprites(ctx, bundle, html) {
  const found = new Map();
  const texts = [['index.html', html], ...Object.values(bundle).filter((f) => f.type === 'chunk').map((f) => [f.fileName, f.code])];
  for (const [file, text] of texts) {
    const sprites = findSprites(text);
    if (sprites.length === 0) continue;
    found.set(file, new Set(sprites));
    ctx.warn(spriteWarning(file, sprites));
  }
  return found;
}

/**
 * Warns about JS/CSS that refers to a public/ file by a root-absolute path
 * ("/logo.png"): in a bundle that resolves against the Specola server's root,
 * not the bundle, so the file is not found. A sprite has its own warning.
 */
function warnRootAbsolute(ctx, bundle, publicFiles, sprites = new Map()) {
  if (publicFiles.length === 0) return;
  const names = new Set(publicFiles.map((f) => f.path));
  const re = /(["'`(])\/([^"'`()\s?#]+)/g;
  for (const f of Object.values(bundle)) {
    let text;
    if (f.type === 'chunk') text = f.code;
    else if (f.fileName.endsWith('.css')) text = String(f.source);
    else continue;
    const found = new Set();
    for (const m of text.matchAll(re)) if (names.has(m[2]) && !sprites.get(f.fileName)?.has('/' + m[2])) found.add(m[2]);
    for (const p of found) {
      ctx.warn(
        `${f.fileName} refers to "/${p}" (from public/), which will not resolve inside a Specola bundle: ` +
          `root-absolute URLs point at the Specola server, not at the bundle. Import the file instead ` +
          `(move it out of public/ and use import url from './${p}?url'), or build the URL as window.specola.base + '${p}'.`,
      );
    }
  }
}
