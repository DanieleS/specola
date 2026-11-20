import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS, bundleProblems, compareVersions, isJunk, pathProblem } from '../lib/rules.js';

test('pathProblem accepts ordinary bundle paths', () => {
  for (const p of ['index.html', 'assets/index-ab12.js', 'a/b/c.d.e.woff2', 'fonts/Noto Sans.ttf', 'img/città.png', '.well-known/x.json']) {
    assert.equal(pathProblem(p), null, p);
  }
});

test('pathProblem rejects what the server rejects', () => {
  const cases = {
    '': /empty/,
    '/abs.js': /starts with/,
    'a//b.js': /empty segment/,
    'a/': /empty segment/,
    './a.js': /"\." segment/,
    'a/../b.js': /"\.\." segment/,
    'a\\b.js': /"\\"/,
    'a?b.js': /"\?"/,
    'a#b.js': /"#"/,
    'a%20b.js': /"%"/,
    'a\nb.js': /control/,
    'a\u0000b': /control/,
    'a\u007fb': /control/,
    ['x'.repeat(513)]: /513 bytes/,
    ['é'.repeat(257)]: /514 bytes/,
    'bad\uD800.js': /UTF-8/,
    'other.html': /only index.html/,
    'sub/index.html': /only index.html/,
    'INDEX.HTM': /only index.html/,
    'page.HTML': /only index.html/,
  };
  for (const [p, re] of Object.entries(cases)) assert.match(pathProblem(p) ?? 'valid', re, JSON.stringify(p));
  assert.equal(pathProblem('x'.repeat(512)), null);
  assert.equal(pathProblem('emoji-😀.png'), null);
});

test('isJunk drops OS and VCS leftovers only', () => {
  for (const p of ['.DS_Store', 'assets/.DS_Store', 'Thumbs.db', 'img/Thumbs.db', '__MACOSX/x.png', 'a/__MACOSX/._x', '.git/HEAD', 'a/.git/config']) {
    assert.ok(isJunk(p), p);
  }
  for (const p of ['index.html', 'assets/git.js', '.gitignore', 'MACOSX/a', 'x.DS_Store', '.github/x.json']) {
    assert.ok(!isJunk(p), p);
  }
});

test('bundleProblems checks presence of index.html, duplicates and limits', () => {
  const ok = [
    { path: 'index.html', size: 100 },
    { path: 'assets/a.js', size: 100 },
  ];
  assert.deepEqual(bundleProblems(ok), []);

  assert.match(bundleProblems([{ path: 'a.js', size: 1 }]).join('\n'), /index.html is missing/);
  assert.match(bundleProblems([...ok, { path: 'assets/a.js', size: 1 }]).join('\n'), /duplicate/);

  const limits = { maxFiles: 2, maxFileBytes: 50, maxIndexBytes: 80, maxBundleBytes: 150 };
  const msg = bundleProblems([...ok, { path: 'b.js', size: 10 }], limits).join('\n');
  assert.match(msg, /index.html is 100 B \(max 80 B\)/);
  assert.match(msg, /assets\/a.js is 100 B \(max 50 B per file\)/);
  assert.match(msg, /3 files \(max 2/);
  assert.match(msg, /210 B \(max 150 B\)/);

  assert.match(bundleProblems([{ path: 'index.html', size: DEFAULT_LIMITS.maxIndexBytes + 1 }]).join(''), /max 5 MiB/);
});

test('compareVersions orders versions as major.minor.patch', () => {
  const ordered = ['0.9.9', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.equal(compareVersions('1', '1.0.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3+build.5'), 0);
  // Like the server, a prerelease or build suffix is ignored: 1.1.0-beta
  // is accepted where 1.1.0 is required.
  assert.equal(compareVersions('1.1.0-beta.1', '1.1.0'), 0);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), 0);
  assert.equal(compareVersions('1.0.0-rc.1+sha.5', '1.0.1'), -1);
  assert.throws(() => compareVersions('one', '1.0.0'), /invalid version/);
});
