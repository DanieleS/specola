// Builds test/fixture with the real Vite and checks the output is a bundle
// the Specola server can serve (docs/spa-bundles.md).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build, createLogger, createServer } from 'vite';
import specola, { VERSION } from '../index.js';

const fixture = fileURLToPath(new URL('./fixture', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'specola-plugin-build-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Builds the fixture with the given plugin options, returning the output
 * directory and the warnings Vite logged. */
async function buildFixture(name, pluginOptions = {}, extra = {}) {
  const outDir = join(scratch, name);
  const warnings = [];
  const logger = createLogger('warn', { allowClearScreen: false });
  logger.warn = (msg) => warnings.push(msg);
  logger.warnOnce = (msg) => warnings.push(msg);
  logger.error = () => {}; // failures surface as the rejected promise
  await build({
    root: fixture,
    configFile: false,
    logLevel: 'silent',
    customLogger: logger,
    ...extra,
    build: { outDir, emptyOutDir: true, assetsInlineLimit: 0, ...extra.build },
    plugins: [specola(pluginOptions)],
  });
  return { outDir, warnings };
}

function listFiles(dir, rel = '') {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`],
  );
}

let out;
before(async () => {
  out = await buildFixture('main', { searchText: 'Fixture <app> & "friends"' }, { base: '/somewhere/' });
});

test('index.html refers to bundle files through the placeholder', () => {
  const html = readFileSync(join(out.outDir, 'index.html'), 'utf8');
  assert.match(html, /<script type="module" crossorigin src="__SPECOLA_BASE__\/assets\/index-[\w-]+\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" crossorigin href="__SPECOLA_BASE__\/assets\/index-[\w-]+\.css">/);
  assert.match(html, /<link rel="icon" href="__SPECOLA_BASE__\/favicon.svg">/);
  assert.doesNotMatch(html, /(src|href)="\.?\//, 'no relative or root-absolute references left');
  for (const m of html.matchAll(/__SPECOLA_BASE__\/([^"']+)/g)) {
    assert.ok(listFiles(out.outDir).includes(m[1]), `${m[1]} exists in the output`);
  }
});

test('index.html carries the generator meta and the search text', () => {
  const html = readFileSync(join(out.outDir, 'index.html'), 'utf8');
  assert.ok(html.includes(`<meta name="generator" content="specola-vite-plugin/${VERSION}">`));
  assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.match(html, /<noscript data-specola-search>Fixture &lt;app&gt; &amp; &quot;friends&quot;<\/noscript>\s*<\/body>/);
});

test('the user base is overridden with a warning', () => {
  assert.ok(out.warnings.some((w) => /ignoring base "\/somewhere\/"/.test(w)), out.warnings.join('\n'));
});

test('JS and CSS refer to bundle files relatively', () => {
  const files = listFiles(out.outDir);
  const css = files.filter((f) => f.endsWith('.css'));
  assert.equal(css.length, 1);
  const cssText = readFileSync(join(out.outDir, css[0]), 'utf8');
  assert.match(cssText, /url\(\.\/fixture-[\w-]+\.woff2\)/);
  assert.match(cssText, /url\(\.\/pattern-[\w-]+\.svg\)/);
  assert.doesNotMatch(cssText, /url\(["']?\//);

  const js = files.filter((f) => f.endsWith('.js'));
  const lazy = js.find((f) => /assets\/lazy-/.test(f));
  const worker = js.find((f) => /assets\/worker-/.test(f));
  const entry = js.find((f) => /assets\/index-/.test(f));
  assert.ok(lazy && worker && entry, js.join(', '));
  assert.ok(files.some((f) => /^assets\/data-[\w-]+\.json$/.test(f)), 'data.json?url is emitted as a file');
  const entryText = readFileSync(join(out.outDir, entry), 'utf8');
  for (const f of [lazy, worker, files.find((f) => f.endsWith('.json'))]) {
    const name = f.slice('assets/'.length);
    assert.match(entryText, new RegExp(`["'\`]\\./${name}|["'\`]${name}`), `${name} referenced relatively`);
  }
  for (const f of js) assert.doesNotMatch(readFileSync(join(out.outDir, f), 'utf8'), /["'`]\/assets\//, f);
});

test('the worker is built as a classic script', () => {
  const worker = listFiles(out.outDir).find((f) => /assets\/worker-/.test(f));
  const code = readFileSync(join(out.outDir, worker), 'utf8');
  // vm.Script parses classic scripts only: import/export would throw.
  assert.doesNotThrow(() => new vm.Script(code));
  assert.doesNotMatch(code, /^\s*(import|export)\b/m);
  assert.match(code, /\*\s*2/, 'math.js is bundled into the worker');
});

test('root-absolute references to public files are reported', () => {
  assert.ok(out.warnings.some((w) => /refers to "\/logo.png"/.test(w)), out.warnings.join('\n'));
  assert.ok(!out.warnings.some((w) => /"\/favicon.svg"/.test(w)));
});

test('the build fails when it exceeds the limits', async () => {
  await assert.rejects(buildFixture('limits-files', { limits: { maxFiles: 3 } }), /max 3, index.html included/);
  await assert.rejects(buildFixture('limits-size', { limits: { maxFileBytes: 64 } }), /max 64 B per file/);
  await assert.rejects(buildFixture('limits-total', { limits: { maxBundleBytes: 1024 } }), /max 1 KiB/);
  // A limit that is not a number keeps the default instead of breaking the check.
  await buildFixture('limits-null', { limits: { maxFiles: null, maxFileBytes: undefined } });
});

test('the build fails when another HTML file is emitted', async () => {
  const pub = join(scratch, 'public-with-html');
  cpSync(join(fixture, 'public'), pub, { recursive: true });
  writeFileSync(join(pub, 'about.html'), '<p>about</p>');
  await assert.rejects(buildFixture('other-html', {}, { publicDir: pub }), /index.html must be the only HTML file.*about\.html/s);
});

test('the build fails on paths the server would refuse', async () => {
  const pub = join(scratch, 'public-bad-path');
  mkdirSync(pub, { recursive: true });
  writeFileSync(join(pub, '100%.txt'), 'x');
  await assert.rejects(buildFixture('bad-path', {}, { publicDir: pub }), /"100%\.txt": path contains "%"/);
});

test('the dev server provides a stand-in window.specola', async () => {
  const server = await createServer({
    root: fixture,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    plugins: [specola()],
  });
  try {
    const html = await server.transformIndexHtml('/index.html', readFileSync(join(fixture, 'index.html'), 'utf8'));
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /if \(typeof window\.specola === "undefined"\) \{ window\.specola = \{ base: "\/", basename: "", persistent: false, flush: async \(\) => \{\} \}; \}/);
    assert.ok(html.indexOf('window.specola') < html.indexOf('main.js'), 'before the app script');
    assert.doesNotMatch(html, /__SPECOLA_BASE__|specola-vite-plugin\//, 'no build-time rewriting in dev');
  } finally {
    await server.close();
  }
});
