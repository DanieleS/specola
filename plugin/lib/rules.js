// Bundle rules shared by the Vite plugin (at build time) and specola-publish
// (before upload). They mirror the server's checks in docs/spa-bundles.md
// ("Paths in a bundle", "Limits") so a bad bundle fails on the author's
// machine with a precise message instead of as a 400 halfway through an upload.

import { BACKEND_PREFIX, MANIFEST_PATH, MAX_MANIFEST_BYTES } from './manifest.js';

const MiB = 1024 * 1024;

/** The server's limits. A grant reports the authoritative values; these are
 * the defaults the plugin enforces at build time, when no grant is known. */
export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 2000,
  maxFileBytes: 25 * MiB,
  maxIndexBytes: 5 * MiB,
  maxBundleBytes: 100 * MiB,
});

const MAX_PATH_BYTES = 512;

/** Reports whether path names an HTML file (.html/.htm, any case). */
export function isHTMLPath(path) {
  return /\.html?$/i.test(path);
}

/**
 * Returns why path is not a valid bundle path, or null when it is valid.
 * The forbidden characters are those that would change the meaning of the
 * file's URL (`?`, `#`, `%`) or of its directory structure (`\`).
 */
export function pathProblem(path) {
  if (typeof path !== 'string' || path === '') return 'path is empty';
  if (/[\uD800-\uDFFF]/.test(path.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) {
    return 'path is not valid UTF-8';
  }
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > MAX_PATH_BYTES) return `path is ${bytes} bytes long (max ${MAX_PATH_BYTES})`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return 'path contains a control character';
  const bad = path.match(/[\\?#%]/);
  if (bad) return `path contains "${bad[0]}"`;
  if (path.startsWith('/')) return 'path starts with "/"';
  for (const seg of path.split('/')) {
    if (seg === '') return 'path has an empty segment';
    if (seg === '.' || seg === '..') return `path has a "${seg}" segment`;
  }
  if (isHTMLPath(path) && path !== 'index.html') {
    return 'only index.html at the root may be HTML (bundles are single-page apps)';
  }
  return null;
}

const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
const JUNK_DIRS = new Set(['__MACOSX', '.git']);

/**
 * Reports whether path is OS or VCS junk that must not be uploaded. The
 * server does not know about junk (it only validates paths), so the plugin
 * and the CLI drop it. Only these names are junk, not every dot-file: the
 * page backend travels under .specola/ (docs/page-backends.md).
 */
export function isJunk(path) {
  const segs = path.split('/');
  if (JUNK_NAMES.has(segs[segs.length - 1])) return true;
  return segs.slice(0, -1).some((s) => JUNK_DIRS.has(s));
}

/**
 * Checks a whole bundle, given as [{path, size}], against the path rules and
 * limits. Returns a list of human-readable problems (empty when valid).
 */
export function bundleProblems(files, limits = DEFAULT_LIMITS) {
  const problems = [];
  const seen = new Set();
  let total = 0;
  let hasIndex = false;
  let hasManifest = false;
  let hasBackendFiles = false;
  for (const { path, size } of files) {
    if (path.startsWith(BACKEND_PREFIX)) hasBackendFiles = true;
    if (path === MANIFEST_PATH) {
      hasManifest = true;
      if (size > MAX_MANIFEST_BYTES) problems.push(`${MANIFEST_PATH} can be at most ${MAX_MANIFEST_BYTES} bytes`);
    }
    const why = pathProblem(path);
    if (why) problems.push(`${JSON.stringify(path)}: ${why}`);
    if (seen.has(path)) problems.push(`${JSON.stringify(path)}: duplicate path`);
    seen.add(path);
    total += size;
    if (path === 'index.html') {
      hasIndex = true;
      if (size > limits.maxIndexBytes) {
        problems.push(`index.html is ${formatBytes(size)} (max ${formatBytes(limits.maxIndexBytes)})`);
      }
    } else if (size > limits.maxFileBytes) {
      problems.push(`${path} is ${formatBytes(size)} (max ${formatBytes(limits.maxFileBytes)} per file)`);
    }
  }
  if (!hasIndex) problems.push('index.html is missing at the root of the bundle');
  if (hasBackendFiles && !hasManifest) problems.push(`files under ${BACKEND_PREFIX} need a ${MANIFEST_PATH} describing the backend`);
  if (files.length > limits.maxFiles) {
    problems.push(`the bundle has ${files.length} files (max ${limits.maxFiles}, index.html included)`);
  }
  if (total > limits.maxBundleBytes) {
    problems.push(`the bundle is ${formatBytes(total)} (max ${formatBytes(limits.maxBundleBytes)})`);
  }
  return problems;
}

/** Formats a byte count for messages: "512 B", "3.2 KiB", "25 MiB". */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${units[u]}`;
}

/**
 * Compares two versions as major.minor.patch, returning -1, 0 or 1. A
 * `-prerelease` or `+build` suffix is ignored, exactly as the server does
 * when it checks a manifest's pluginVersion against minPluginVersion
 * (docs/spa-bundles.md, "Upload protocol"): the CLI must not refuse a
 * plugin the server would accept, nor accept one it would refuse.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+.*)?$/.exec(String(v).trim());
  if (!m) throw new Error(`invalid version ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}
