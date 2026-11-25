// The page backend at build time (docs/page-backends.md, "Plugin and CLI"):
// which server entry and manifest the project declares, and the server build
// that turns the entry into .specola/server/index.mjs next to the app.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BACKEND_PREFIX, DEFAULT_ENTRY, MANIFEST_PATH, ManifestError, validateManifest } from './manifest.js';

/** The manifest file a project may keep next to vite.config instead of the backend option. */
export const MANIFEST_FILE = 'specola.backend.json';

/** Node built into the runner's image is newer; this is the oldest the build targets. */
export const SERVER_TARGET = 'node22';

// Packages whose whole job is to find and load a native addon at run time,
// so the bundler never sees the .node file itself.
const NATIVE_LOADERS = new Set(['bindings', 'node-gyp-build', 'node-gyp-build-optional-packages', '@mapbox/node-pre-gyp', 'node-pre-gyp', 'prebuild-install']);

/**
 * Works out the backend a project declares, from the plugin options and the
 * resolved Vite config: null when there is none (no server option), else
 * {entry (absolute path of the server source), manifest (normalised, as
 * written to .specola/backend.json), source (where the manifest came from)}.
 * Throws an Error whose message is meant for the user.
 */
export function resolveBackend(options, config) {
  const configDir = config.configFile ? dirname(config.configFile) : config.root;
  const file = join(configDir, MANIFEST_FILE);
  const hasFile = existsSync(file);
  const hasOption = options.backend !== undefined && options.backend !== null;

  if (options.server === undefined || options.server === null) {
    if (hasOption) throw new Error('[specola] the backend option needs a server option too: specola({ server: "server/index.ts", backend: {…} })');
    if (hasFile) throw new Error(`[specola] ${file} describes a backend, but specola() has no server option: add specola({ server: "server/index.ts" }), or remove the file`);
    return null;
  }
  if (typeof options.server !== 'string' || options.server.trim() === '') {
    throw new Error('[specola] the server option must be the path of the backend entry, e.g. "server/index.ts"');
  }
  const entry = resolve(config.root, options.server);
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    throw new Error(`[specola] the server entry ${options.server} does not exist (looked for ${entry})`);
  }
  if (hasOption && hasFile) {
    throw new Error(`[specola] the backend manifest is given twice, by the backend option of specola() and by ${file}: keep one`);
  }

  let raw = {};
  let source = 'the backend option';
  if (hasFile) {
    source = file;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`[specola] ${file} is not valid JSON: ${err.message}`);
    }
  } else if (hasOption) {
    raw = options.backend;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[specola] ${source} must be an object like {"public": [...], "egress": [...], "secrets": [...]}`);
  }
  // The plugin decides where the entry is built; a version other than 1 is
  // left to the validator, which says what it must be.
  if ('entry' in raw) throw new Error(`[specola] ${source}: "entry" is set by the plugin (it builds ${options.server} into ${BACKEND_PREFIX}${DEFAULT_ENTRY}); remove it`);
  const manifest = check({ version: 1, ...raw, entry: DEFAULT_ENTRY }, source);
  return { entry, manifest, source };
}

function check(value, source) {
  try {
    return validateManifest(value, [BACKEND_PREFIX + DEFAULT_ENTRY]);
  } catch (err) {
    if (err instanceof ManifestError) throw new Error(`[specola] ${source}: ${err.message}`);
    throw err;
  }
}

/** Reports whether module id is the server entry or under its directory (when that isn't the root). */
export function isServerModule(id, backend, root) {
  const file = id.split('?')[0];
  if (file === backend.entry) return true;
  const dir = dirname(backend.entry);
  return dir !== resolve(root) && file.startsWith(dir + sep);
}

/**
 * Builds the server entry with Vite's SSR build into <outDir>/.specola/server/
 * (index.mjs plus chunks), everything bundled, and writes
 * <outDir>/.specola/backend.json. vite is the project's own Vite module;
 * config the resolved config of the client build.
 */
export async function buildServer(vite, config, backend) {
  const outDir = resolve(config.root, config.build.outDir);
  const specolaDir = join(outDir, '.specola');
  const serverDir = join(specolaDir, 'server');
  rmSync(specolaDir, { recursive: true, force: true });

  const major = Number(String(vite.version ?? '').split('.')[0]);
  const output = {
    format: 'es',
    entryFileNames: 'index.mjs',
    chunkFileNames: 'chunks/[name]-[hash].mjs',
    assetFileNames: 'assets/[name]-[hash][extname]',
  };
  // Vite 8 bundles with Rolldown and deprecates rollupOptions.
  const bundlerOptions = major >= 8 ? { rolldownOptions: { output } } : { rollupOptions: { output } };

  const result = await vite.build({
    root: config.root,
    mode: config.mode,
    configFile: false,
    envDir: config.envDir,
    publicDir: false,
    logLevel: config.logLevel,
    customLogger: config.logger,
    resolve: { alias: config.resolve?.alias },
    define: config.define,
    plugins: [noNativeAddons(config.root)],
    // Everything in one tree the runner can load from its code directory:
    // the runner has no node_modules, only the files under .specola/.
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: backend.entry,
      outDir: serverDir,
      emptyOutDir: true,
      target: SERVER_TARGET,
      minify: false,
      sourcemap: 'inline',
      copyPublicDir: false,
      reportCompressedSize: false,
      ...bundlerOptions,
    },
  });

  // The output stays under .specola/server/: a file name that climbs out of
  // it would land among the app's files, which are served to anyone.
  for (const out of [result].flat()) {
    for (const f of out?.output ?? []) {
      const abs = resolve(serverDir, f.fileName);
      if (isAbsolute(f.fileName) || !abs.startsWith(serverDir + sep)) {
        throw new Error(`[specola] the server build wrote ${f.fileName}, outside ${BACKEND_PREFIX}server/`);
      }
    }
  }
  if (!existsSync(join(serverDir, 'index.mjs'))) {
    throw new Error(`[specola] the server build did not produce ${BACKEND_PREFIX}${DEFAULT_ENTRY}`);
  }
  mkdirSync(specolaDir, { recursive: true });
  writeFileSync(join(outDir, MANIFEST_PATH), JSON.stringify(backend.manifest, null, 2) + '\n');
}

/**
 * Fails the server build on a native addon: the runner loads no addons
 * (workers run with Node's permission model, which forbids them), so the
 * build would only fail later, at the first request.
 */
export function noNativeAddons(root) {
  const fail = (ctx, what, importer) => {
    const from = importer ? ` (imported by ${relative(root, importer.split('?')[0]) || importer})` : '';
    ctx.error(
      `[specola] the backend uses the native addon ${what}${from}: page backends can't load native addons (.node files). ` +
        'Use a pure-JavaScript or WebAssembly package instead (node:sqlite is built in for databases).',
    );
  };
  return {
    name: 'specola:no-native-addons',
    enforce: 'pre',
    resolveId(source, importer) {
      if (/\.node$/i.test(source.split('?')[0])) fail(this, JSON.stringify(source), importer);
      if (NATIVE_LOADERS.has(packageName(source))) fail(this, `loader ${JSON.stringify(source)}`, importer);
      return null;
    },
    load(id) {
      if (/\.node$/i.test(id.split('?')[0])) fail(this, JSON.stringify(id));
      return null;
    },
  };
}

function packageName(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('\0') || spec.includes(':')) return '';
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Lists the files under dir as bundle paths with sizes. */
export function listOutput(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listOutput(dir, path));
    else if (e.isFile()) out.push({ path, size: statSync(join(dir, path)).size });
  }
  return out;
}
