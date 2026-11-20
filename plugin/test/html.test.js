import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHTML, injectBody, injectHead, rewriteIndexRefs } from '../lib/html.js';

const files = new Set(['assets/index-a1.js', 'assets/vendor-b2.js', 'assets/index-c3.css', 'favicon.svg', 'img/a b.png', 'img/2x.png']);

test('rewriteIndexRefs points references to bundle files at the placeholder', () => {
  const html = `<!doctype html><html><head>
<link rel="icon" href="./favicon.svg">
<script type="module" crossorigin src="./assets/index-a1.js"></script>
<link rel="modulepreload" crossorigin href="./assets/vendor-b2.js">
<link rel="stylesheet" crossorigin href='./assets/index-c3.css'>
<link rel="preload" as="image" imagesrcset="./img/2x.png 2x">
<style>body { background: url("./img/2x.png") }</style>
</head><body>
<img src="./img/a%20b.png" srcset="./img/a%20b.png 1x, ./img/2x.png 2x" alt="it's ./favicon.svg" data-x="./unknown.js">
<div style="background:url(./img/2x.png)"></div>
<a href="./favicon.svg#frag">x</a>
<link rel=preload as=script href=./assets/vendor-b2.js><img src=./img/2x.png/>
<script>const s = "./assets/index-a1.js";</script>
<!-- <img src="./favicon.svg"> -->
</body></html>`;
  const out = rewriteIndexRefs(html, files);
  for (const want of [
    'href="__SPECOLA_BASE__/favicon.svg"',
    'src="__SPECOLA_BASE__/assets/index-a1.js"',
    'rel="modulepreload" crossorigin href="__SPECOLA_BASE__/assets/vendor-b2.js"',
    "href='__SPECOLA_BASE__/assets/index-c3.css'",
    'imagesrcset="__SPECOLA_BASE__/img/2x.png 2x"',
    'url("__SPECOLA_BASE__/img/2x.png")',
    'src="__SPECOLA_BASE__/img/a%20b.png"',
    'srcset="__SPECOLA_BASE__/img/a%20b.png 1x, __SPECOLA_BASE__/img/2x.png 2x"',
    'style="background:url(__SPECOLA_BASE__/img/2x.png)"',
    'href="__SPECOLA_BASE__/favicon.svg#frag"',
    'as=script href=__SPECOLA_BASE__/assets/vendor-b2.js>',
  ]) {
    assert.ok(out.includes(want), want);
  }
  // Left alone: unknown files, attribute text that is not a URL, inline
  // script text and comments.
  for (const kept of ['data-x="./unknown.js"', `alt="it's ./favicon.svg"`, 'const s = "./assets/index-a1.js"', '<!-- <img src="./favicon.svg"> -->', '<img src=./img/2x.png/>']) {
    assert.ok(out.includes(kept), kept);
  }
});

test('escapeHTML and the injectors', () => {
  assert.equal(escapeHTML(`<a href="x">Tom & 'Jerry'</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
  assert.match(injectHead('<html><head><title>x</title></head><body></body></html>', '<meta x>'), /<title>x<\/title>\s*<meta x>\s*<\/head>/);
  assert.match(injectHead('<html><body></body></html>', '<meta x>'), /<html>\s*<head><meta x><\/head>/);
  assert.match(injectBody('<body><p>a</p></body></html>', '<noscript>t</noscript>'), /<p>a<\/p>\s*<noscript>t<\/noscript>\s*<\/body>/);
  assert.equal(injectBody('<p>a</p>', '<i>'), '<p>a</p>\n<i>\n');
});
