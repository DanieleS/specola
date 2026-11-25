// Path rules shared by the runner (the .specola/ files it extracts) and the
// worker (file store keys). They are the bundle path rules of
// docs/spa-bundles.md ("Paths in a bundle") without the HTML rule, so a key
// or a code path can never climb out of the directory it is joined to.
// This file is loaded by page workers too: it must only import node: modules.

const MAX_PATH_BYTES = 512;

/** Returns why p is not a valid relative path, or null when it is valid. */
export function pathProblem(p) {
  if (typeof p !== 'string' || p === '') return 'is empty';
  if (/[\uD800-\uDFFF]/.test(p.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) {
    return 'is not valid UTF-8';
  }
  const bytes = Buffer.byteLength(p, 'utf8');
  if (bytes > MAX_PATH_BYTES) return `is ${bytes} bytes long (max ${MAX_PATH_BYTES})`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(p)) return 'contains a control character';
  const bad = p.match(/[\\?#%]/);
  if (bad) return `contains "${bad[0]}"`;
  if (p.startsWith('/')) return 'starts with "/"';
  for (const seg of p.split('/')) {
    if (seg === '') return 'has an empty segment';
    if (seg === '.' || seg === '..') return `has a "${seg}" segment`;
  }
  return null;
}
