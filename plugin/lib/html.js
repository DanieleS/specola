// Rewrites of the built index.html. Vite builds with base "./", so the
// index refers to its files as "./assets/…"; the server serves index.html
// from a different URL than the files (see docs/spa-bundles.md, "index.html"),
// so those references become "__SPECOLA_BASE__/assets/…", which the server
// replaces with the bundle's file base when it serves the page.

export const BASE_PLACEHOLDER = '__SPECOLA_BASE__/';

// An attribute value: ` name="value"`, ` name='value'` or ` name=value`
// (unquoted values are valid HTML, and an index.html written by hand may
// use them for attributes Vite does not rewrite itself).
const ATTR_RE = /(\s[^\s"'<>/=]+\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
// A CSS url() in an inline <style> or style attribute.
const CSS_URL_RE = /url\(\s*(["']?)\.\/([^"')\s]+)\1\s*\)/g;
// The parts of a document that matter here: comments (left alone), <script>
// and <style> elements (whose text is not markup), and other start tags.
const TOKEN_RE = /(<!--[\s\S]*?-->)|(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\3\s*>)|(<[a-zA-Z][^>]*>)/gi;

/**
 * Replaces "./<path>" references to files of the bundle (files is a Set of
 * bundle paths) with the placeholder form, in every attribute of every tag
 * (src, href, modulepreload/stylesheet links, data-*, content…), srcset
 * lists and CSS url()s in inline styles. References to anything else, and
 * the text of inline scripts, are left alone.
 */
export function rewriteIndexRefs(html, files) {
  const ref = (url) => {
    const m = /^\.\/([^?#]*)(.*)$/.exec(url);
    if (!m) return null;
    let path = m[1];
    try {
      path = decodeURI(path);
    } catch {
      // keep it as written
    }
    return files.has(path) ? BASE_PLACEHOLDER + m[1] + m[2] : null;
  };
  const cssRefs = (css) =>
    css.replace(CSS_URL_RE, (all, q, path) => {
      const r = ref('./' + path);
      return r === null ? all : `url(${q}${r}${q})`;
    });
  const tagRefs = (tag) =>
    tag.replace(ATTR_RE, (all, pre, dq, sq, uq) => {
      const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
      const value = dq ?? sq ?? uq;
      const name = pre.trim().slice(0, -1).trim().toLowerCase();
      let out;
      if (name === 'srcset' || name === 'imagesrcset') {
        out = value.replace(/(^|,)(\s*)([^\s,]+)/g, (c, sep, sp, url) => sep + sp + (ref(url) ?? url));
      } else if (name === 'style') {
        out = cssRefs(value);
      } else {
        out = ref(value.trim()) ?? value;
      }
      return pre + q + out + q;
    });
  return html.replace(TOKEN_RE, (all, comment, open, element, text, close, tag) => {
    if (comment) return all;
    if (open) return tagRefs(open) + (element.toLowerCase() === 'style' ? cssRefs(text) : text) + close;
    return tagRefs(tag);
  });
}

/** Escapes text for HTML element content and attribute values. */
export function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Inserts markup at the end of <head>, creating a spot if there is none. */
export function injectHead(html, markup) {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `  ${markup}\n  </head>`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => `${m}\n  <head>${markup}</head>`);
  return markup + '\n' + html;
}

/** Inserts markup at the end of <body>, or at the end of the document. */
export function injectBody(html, markup) {
  const i = html.search(/<\/body>(?![\s\S]*<\/body>)/i);
  if (i >= 0) return html.slice(0, i) + `  ${markup}\n  ` + html.slice(i);
  const j = html.search(/<\/html>(?![\s\S]*<\/html>)/i);
  if (j >= 0) return html.slice(0, j) + markup + '\n' + html.slice(j);
  return html + '\n' + markup + '\n';
}
