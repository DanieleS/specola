import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSprites, spriteWarning } from '../lib/sprites.js';

test('finds external sprites as the Vite templates compile them', () => {
  // React (JSX), Svelte (template string), Vue (asset URL + fragment).
  assert.deepEqual(findSprites('(0,h.jsx)(`use`,{href:`/icons.svg#documentation-icon`})'), ['/icons.svg']);
  assert.deepEqual(findSprites('`<svg class="icon"><use href="/icons.svg#social-icon"></use></svg>`'), ['/icons.svg']);
  assert.deepEqual(
    findSprites('var oo=``+new URL(`../icons.svg`,import.meta.url).href,so=1,uo=oo+`#documentation-icon`'),
    ['../icons.svg'],
  );
  // An imported ?url, with a template literal.
  assert.deepEqual(findSprites('const u=new URL("icons-ab.svg",import.meta.url).href;x.innerHTML=`<use href="${u}#a">`'), ['icons-ab.svg']);
  assert.deepEqual(findSprites('<use xlink:href="sprite.svg#x"/>'), ['sprite.svg']);
});

test('leaves SVG images and same-document references alone', () => {
  assert.deepEqual(findSprites('<img src="logo.svg"><use href="#icon"></use>'), []);
  assert.deepEqual(findSprites('var logo = "x.svg"; a = b + "#x"; location.hash = "#top"'), []);
});

test('the warning says to inline the sprite', () => {
  assert.match(spriteWarning('assets/index.js', ['/icons.svg']), /"\/icons\.svg".*blank.*\?raw.*<use href="#id">/s);
});
