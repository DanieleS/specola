// specola-publish: the client side of the bundle upload protocol
// (docs/spa-bundles.md, "Upload protocol"). Progress goes to stderr; the
// only thing written to stdout is the server's JSON result, so the command can
// be piped.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { MANIFEST_PATH, ManifestError, validateManifest } from './manifest.js';
import { DEFAULT_LIMITS, bundleProblems, compareVersions, formatBytes, isJunk } from './rules.js';
import { VERSION } from './version.js';

const CONCURRENCY = 4;
const MAX_RETRIES = 4;

export const USAGE = `Usage: npx --no -- specola-publish --upload <url> [options]

Builds the Vite app in the current directory and uploads it to Specola as a
bundle. The upload URL comes from the MCP tool create_bundle_upload.

Options:
  --upload <url>   the upload URL (required)
  --dir <dir>      the build output directory (default: dist)
  --no-build       upload --dir as it is, without running vite build
  --note <text>    the version note (overrides the one given to create_bundle_upload)
  --help           show this help
`;

/** An error whose message is meant for the user as it is. */
export class PublishError extends Error {}

/** Parses the command line. Throws PublishError on bad usage. */
export function parseArgs(argv) {
  const opts = { dir: 'dist', build: true, note: undefined, upload: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const take = () => {
      if (value !== undefined) return value;
      if (i + 1 >= argv.length) throw new PublishError(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--upload':
        opts.upload = take();
        break;
      case '--dir':
        opts.dir = take();
        break;
      case '--note':
        opts.note = take();
        break;
      case '--no-build':
        opts.build = false;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new PublishError(`unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`);
    }
  }
  if (!opts.help && !opts.upload) throw new PublishError(`--upload <url> is required\n\n${USAGE}`);
  return opts;
}

/**
 * Runs the whole publish flow and returns the server's commit result.
 *
 * env lets tests replace the process-wide pieces: { cwd, log, fetch,
 * retryDelayMs, build }.
 */
export async function publish(opts, env = {}) {
  const cwd = env.cwd ?? process.cwd();
  const log = env.log ?? ((msg) => process.stderr.write(msg + '\n'));
  const http = client(env.fetch ?? globalThis.fetch, env.retryDelayMs ?? 500, log);
  const base = uploadBase(opts.upload);

  log('specola: checking the upload link…');
  const grant = await http.json('GET', base, undefined, 200);
  if (grant.minPluginVersion && olderThan(VERSION, grant.minPluginVersion)) {
    throw new PublishError(
      `this Specola needs @specola/vite-plugin ${grant.minPluginVersion} or newer, but ${VERSION} is installed.\n` +
        `Update it with: npm i -D ${new URL(base).origin}/tools/specola-vite-plugin-${grant.minPluginVersion}.tgz`,
    );
  }
  const target = grant.kind === 'version' ? `a new version of page ${grant.pageId}` : `a new page${grant.title ? ` "${grant.title}"` : ''}`;
  log(`specola: uploading ${target} (link valid until ${grant.expiresAt})`);

  if (opts.build) await (env.build ?? viteBuild)(cwd);

  const dir = resolve(cwd, opts.dir);
  const files = walk(dir);
  const problems = bundleProblems(files, { ...DEFAULT_LIMITS, ...grant.limits });
  if (problems.length > 0) {
    throw new PublishError(`${opts.dir} is not a valid Specola bundle:\n  - ${problems.join('\n  - ')}`);
  }
  checkIndex(join(dir, 'index.html'), log);
  checkBackend(files, grant, log);

  for (const f of files) f.sha256 = createHash('sha256').update(readFileSync(f.full)).digest('hex');
  const total = files.reduce((n, f) => n + f.size, 0);
  log(`specola: ${files.length} files, ${formatBytes(total)}`);

  const manifest = {
    pluginVersion: VERSION,
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  };
  const { missing = [] } = await http.json('POST', `${base}/manifest`, manifest, 200);

  // Identical files share a blob: upload each missing hash once.
  const byHash = new Map(files.map((f) => [f.sha256, f]));
  const uploads = missing.map((h) => {
    const f = byHash.get(h);
    if (!f) throw new PublishError(`the server asked for blob ${h}, which is not in the manifest`);
    return f;
  });
  const already = new Set(files.map((f) => f.sha256)).size - uploads.length;
  log(`specola: uploading ${uploads.length} new files (${already} already on the server)`);
  let done = 0;
  await pool(uploads, CONCURRENCY, async (f) => {
    // Send exactly the bytes that were hashed: a file rewritten since (a
    // build still running in watch mode) would otherwise be refused by the
    // server with a bare "does not match the manifest".
    const bytes = readFileSync(f.full);
    if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) {
      throw new PublishError(`${f.path} changed while it was being uploaded: is a build still running? Run specola-publish again.`);
    }
    await http.send('PUT', `${base}/blobs/${f.sha256}`, bytes, 204, 'application/octet-stream');
    done++;
    log(`specola:   [${done}/${uploads.length}] ${f.path}`);
  });

  log('specola: committing…');
  const body = opts.note !== undefined ? { note: opts.note } : {};
  // The commit consumes the grant, so it is the one request that is not
  // idempotent: see client() for what a 410 on a retry means.
  const result = await http.json('POST', `${base}/commit`, body, 201, { consumes: true });
  log(`specola: published version ${result.version}: ${result.url}`);
  return result;
}

/**
 * Checks the --upload URL and returns it without a trailing slash. Only a
 * bundle upload link (…/upload/bundle/<token>) will do: anything else (a
 * plain page's /upload/<token> link, a page URL) would fail later with a
 * confusing 404 or 400.
 */
function uploadBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new PublishError(`--upload must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublishError(`--upload must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!/\/upload\/bundle\/[^/]+$/.test(path) || url.search || url.hash) {
    throw new PublishError(
      `--upload must be a bundle upload link (…/upload/bundle/<token>), as given by the MCP tool create_bundle_upload; got ${JSON.stringify(redact(raw))}`,
    );
  }
  return url.origin + path;
}

function olderThan(version, min) {
  try {
    return compareVersions(version, min) < 0;
  } catch {
    throw new PublishError(`the server requires plugin version ${JSON.stringify(min)}, which is not a version this plugin understands`);
  }
}

/**
 * Runs the project's own `vite build` in cwd. Vite is resolved from the
 * project rather than through npx, which would offer to download whatever
 * Vite is latest (and wait for a "y" on stdin) when the project has none.
 * Its stdout goes to our stderr, so that our stdout carries only the JSON
 * result.
 */
function viteBuild(cwd) {
  let viteBin;
  try {
    const pkgFile = createRequire(join(cwd, 'package.json')).resolve('vite/package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    viteBin = join(dirname(pkgFile), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.vite);
  } catch {
    throw new PublishError(
      `vite is not installed in ${cwd}: run specola-publish from the Vite project's directory, ` +
        'or build yourself and pass --no-build --dir <output directory>',
    );
  }
  return new Promise((resolveBuild, reject) => {
    const child = spawn(process.execPath, [viteBin, 'build'], {
      cwd,
      stdio: ['inherit', 2, 'inherit'],
    });
    child.on('error', (err) => reject(new PublishError(`could not run vite build: ${err.message}`)));
    child.on('exit', (code, signal) => {
      if (code === 0) resolveBuild();
      else reject(new PublishError(`vite build failed (${signal ?? `exit code ${code}`})`));
    });
  });
}

/**
 * Lists the files under dir, as bundle paths, dropping junk. Symbolic links
 * are followed only while they stay inside dir: a link out of it (say to
 * ~/.ssh) would otherwise upload files the author never meant to publish,
 * and a link to a directory above would loop.
 */
function walk(dir) {
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new PublishError(`${dir} does not exist: did the build write somewhere else? Pass it with --dir`);
  }
  if (!st.isDirectory()) throw new PublishError(`${dir} is not a directory`);
  const root = realpathSync(dir);
  const inside = (real) => real === root || real.startsWith(root + sep);
  const out = [];
  const visit = (abs, rel, seen) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      const full = join(abs, e.name);
      let real;
      try {
        real = realpathSync(full);
      } catch {
        throw new PublishError(`${path} is a broken symbolic link`);
      }
      if (!inside(real)) {
        throw new PublishError(`${path} is a symbolic link to ${real}, outside ${dir}: copy the file into the build output instead`);
      }
      const s = statSync(real);
      if (s.isDirectory()) {
        if (seen.has(real)) throw new PublishError(`${path} is a symbolic link that loops back to ${relative(root, real) || '.'}`);
        if (!isJunk(`${path}/x`)) visit(full, path, new Set(seen).add(real));
      } else if (s.isFile() && !isJunk(path)) {
        out.push({ path, full, size: s.size });
      }
    }
  };
  visit(dir, '', new Set([root]));
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Checks what the server will check about index.html, and warns when the
 * build did not go through the plugin (the bundle would not load). */
function checkIndex(file, log) {
  const bytes = readFileSync(file);
  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PublishError('index.html is not valid UTF-8');
  }
  if (!html.includes('specola-vite-plugin/')) {
    log(
      'specola: warning: index.html was not built with @specola/vite-plugin (no generator meta).\n' +
        'specola: warning: add specola() to the plugins in vite.config, or the page will not find its files.',
    );
  }
}

// The server's words (POST …/manifest answers 400 backend-disabled), so the
// author sees the same thing whichever side refuses.
export const BACKEND_DISABLED =
  'this bundle has a backend (.specola/backend.json), but page backends are not enabled on this Specola instance: it has no backend runner. ' +
  "Publish the app without its server code, or ask the instance's operator to enable backends.";

/**
 * Checks a bundle with a backend before anything is uploaded: its manifest
 * validates as the server will validate it, and the instance runs backends.
 * A grant without "backend" comes from a Specola older than backends, which
 * can't run one either.
 */
function checkBackend(files, grant, log) {
  const manifest = files.find((f) => f.path === MANIFEST_PATH);
  if (!manifest) return;
  try {
    validateManifest(readFileSync(manifest.full), files.map((f) => f.path));
  } catch (err) {
    if (err instanceof ManifestError) throw new PublishError(err.message);
    throw err;
  }
  if (!grant.backend?.enabled) throw new PublishError(BACKEND_DISABLED);
  if (!grant.backend.available) {
    log(
      "specola: warning: the backend runner is not answering right now: the bundle can be published, but its backend can't be called until the runner is back.",
    );
  }
}

/** Runs fn over items with at most n in flight; fails fast on the first error. */
async function pool(items, n, fn) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * A small HTTP client: retries network errors and 5xx answers with
 * exponential backoff, and turns any other unexpected answer into a
 * PublishError that carries the server's message.
 */
function client(fetchFn, retryDelayMs, log) {
  // opts.consumes marks a request that uses up the grant (the commit). If an
  // attempt of it fails without an answer (a dropped connection, a 502 from
  // a proxy), the server may have committed all the same, so a 410 on the
  // retry most likely means success, not an expired link.
  async function send(method, url, body, want, contentType, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      let failure;
      try {
        res = await fetchFn(url, {
          method,
          headers: body === undefined ? {} : { 'Content-Type': contentType },
          body,
        });
      } catch (err) {
        failure = `${err.message}${err.cause?.message ? ` (${err.cause.message})` : ''}`;
      }
      if (res && res.status === want) return res;
      if (res && res.status === 410 && opts.consumes && attempt > 0) {
        throw new PublishError(
          `${method} ${redact(url)}: an earlier attempt failed without an answer, and the upload link is now used: ` +
            'the commit most likely went through. Check the page in Specola (or with the MCP tool get_page) before publishing again.',
        );
      }
      if (res && res.status < 500) throw new PublishError(await describe(method, url, res));
      if (res) failure = await describe(method, url, res);
      if (attempt >= MAX_RETRIES) {
        throw new PublishError(`${method} ${redact(url)} failed after ${attempt + 1} attempts: ${failure}`);
      }
      const delay = retryDelayMs * 2 ** attempt;
      log(`specola: ${method} ${redact(url)}: ${failure}; retrying in ${delay} ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  async function json(method, url, payload, want, opts) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const res = await send(method, url, body, want, 'application/json', opts);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new PublishError(`${method} ${redact(url)}: the server answered ${res.status} with something that is not JSON: ${text.slice(0, 200)}`);
    }
  }
  return { send, json };
}

/** Turns an unexpected answer into a message, with the known statuses
 * explained in terms of what to do next. */
async function describe(method, url, res) {
  let text = (await res.text().catch(() => '')).trim();
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.missing)) text = `the server is still missing ${parsed.missing.length} file(s): ${parsed.missing.join(', ')}`;
    else if (typeof parsed.message === 'string') text = parsed.message;
    else if (typeof parsed.error === 'string') text = parsed.error;
  } catch {
    // plain-text error body, keep it
  }
  const what = `${method} ${redact(url)}: ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`;
  if (res.status === 404) return `${what}\nThe upload link is unknown: check the URL, or create a new one with the MCP tool create_bundle_upload.`;
  if (res.status === 410) return `${what}\nThe upload link was already used or has expired: create a new one with the MCP tool create_bundle_upload.`;
  return what;
}

/** Hides the grant token in messages, keeping its first characters. */
function redact(url) {
  return url.replace(/(\/upload\/bundle\/)([^/]{6})[^/]*/, '$1$2…');
}
