// @specola/vite-plugin: builds a Vite app as a Specola bundle.
// The contract it implements is docs/spa-bundles.md in the Specola repository.

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { escapeHTML, injectBody, injectHead, rewriteIndexRefs } from './lib/html.js';
import { DEFAULT_LIMITS, bundleProblems, isHTMLPath, isJunk } from './lib/rules.js';
import { VERSION } from './lib/version.js';

export { VERSION };

// Stand-in for the boot data the Specola page SDK provides, so that apps that
// read window.specola run under `vite dev`. Storage is the browser's own.
const DEV_SPECOLA =
  'if (typeof window.specola === "undefined") {' +
  ' window.specola = { base: "/", basename: "", persistent: false, flush: async () => {} };' +
  ' }';

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

  return {
    name: 'specola',
    enforce: 'post',

    // Bundle files are served from a URL that is only known when the page is
    // viewed, so everything must be relative ("./"), and workers must be
    // classic scripts: the page runs on an opaque origin, where module
    // workers cannot start (the page SDK turns http(s) workers into classic
    // blob: workers that importScripts the real file).
    config(user) {
      userBase = user.base;
      userWorkerFormat = user.worker?.format;
      return { base: './', worker: { format: 'iife' } };
    },

    configResolved(resolved) {
      config = resolved;
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
        return [{ tag: 'script', children: DEV_SPECOLA, injectTo: 'head-prepend' }];
      },
    },

    generateBundle(_outputOptions, bundle) {
      if (config.command !== 'build' || config.build.ssr) return;
      if (this.environment && this.environment.config?.consumer === 'server') return;

      const publicFiles = listPublicFiles(config);
      const files = new Set([...Object.keys(bundle), ...publicFiles.map((f) => f.path)]);

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
      html = rewriteIndexRefs(html, files);
      html = injectHead(html, `<meta name="generator" content="specola-vite-plugin/${VERSION}">`);
      if (typeof options.searchText === 'string' && options.searchText.trim() !== '') {
        html = injectBody(html, `<noscript data-specola-search>${escapeHTML(options.searchText)}</noscript>`);
      }
      index.source = html;

      warnRootAbsolute(this, bundle, publicFiles);

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
  };
}

export default specola;

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
 * Warns about JS/CSS that refers to a public/ file by a root-absolute path
 * ("/logo.png"): in a bundle that resolves against the Specola server's root,
 * not the bundle, so the file is not found.
 */
function warnRootAbsolute(ctx, bundle, publicFiles) {
  if (publicFiles.length === 0) return;
  const names = new Set(publicFiles.map((f) => f.path));
  const re = /(["'`(])\/([^"'`()\s?#]+)/g;
  for (const f of Object.values(bundle)) {
    let text;
    if (f.type === 'chunk') text = f.code;
    else if (f.fileName.endsWith('.css')) text = String(f.source);
    else continue;
    const found = new Set();
    for (const m of text.matchAll(re)) if (names.has(m[2])) found.add(m[2]);
    for (const p of found) {
      ctx.warn(
        `${f.fileName} refers to "/${p}" (from public/), which will not resolve inside a Specola bundle: ` +
          `root-absolute URLs point at the Specola server, not at the bundle. Import the file instead ` +
          `(move it out of public/ and use import url from './${p}?url'), or build the URL as window.specola.base + '${p}'.`,
      );
    }
  }
}
