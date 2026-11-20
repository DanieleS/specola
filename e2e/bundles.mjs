#!/usr/bin/env node
// End-to-end check of SPA bundles (docs/spa-bundles.md) in a real browser:
// builds e2e/app with the Vite plugin, starts a real Specola (once on the
// app origin alone, once with a separate view origin), publishes the build
// with the real specola-publish CLI, and checks in Chromium, inside the
// sandboxed frame, that the app renders, a lazy import resolves, workers run,
// fetched JSON and CSS url()s load, window.specola.base/basename are right,
// a deep path survives pushState + reload and a direct load, and a public
// link works too. Then it keeps the bundle for offline viewing in the app,
// goes offline, and checks the kept copy runs the same way (and that a plain
// page still shows offline).
//
// Needs: Go, a PostgreSQL to create throwaway databases on, the SPA built
// (cd web && npm run build), plugin dependencies (cd plugin && npm install)
// and Playwright with Chromium. See e2e/README.md.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright is usually installed globally, which import can't find.
const { chromium } = createRequire(import.meta.url)('playwright');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adminDB = process.env.SPECOLA_E2E_DATABASE_URL || 'postgres://postgres:dev@localhost:5432/postgres?sslmode=disable';
const port = Number(process.env.SPECOLA_E2E_PORT || 18080);
const pluginVersion = JSON.parse(readFileSync(join(root, 'plugin/package.json'), 'utf8')).version;

let failures = 0;
function check(ok, what, detail) {
  if (ok) {
    console.log(`  ok    ${what}`);
  } else {
    failures++;
    console.log(`  FAIL  ${what}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  }
}

function need(path, hint) {
  if (!existsSync(join(root, path))) {
    console.error(`missing ${path}: ${hint}`);
    process.exit(2);
  }
}
need('internal/webui/dist/assets', 'build the SPA first (cd web && npm install && npm run build)');
need('plugin/node_modules/vite', 'install the plugin dependencies first (cd plugin && npm install)');

const tmp = mkdtempSync(join(tmpdir(), 'specola-e2e-'));
const dist = join(tmp, 'dist');
const bin = join(tmp, 'specola');
console.log('building e2e/app with the plugin, and the server');
execFileSync(process.execPath, [join(root, 'plugin/node_modules/vite/bin/vite.js'), 'build', join(root, 'e2e/app'), '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], { stdio: 'inherit' });
execFileSync('go', ['build', '-o', bin, './cmd/specola'], { cwd: root, stdio: 'inherit' });

const browser = await chromium.launch();
try {
  await run('app origin only', {});
  await run('separate view origin', { SPECOLA_VIEW_ORIGIN: `http://127.0.0.1:${port}` });
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

// run starts a server with extra environment, publishes the app and checks it.
async function run(name, env) {
  console.log(`\n== ${name}`);
  const db = 'specola_e2e_' + randomBytes(4).toString('hex');
  execFileSync('psql', [adminDB, '-qc', `CREATE DATABASE ${db}`]);
  const app = `http://localhost:${port}`;
  const server = spawn(bin, [], {
    env: {
      ...process.env,
      SPECOLA_DATABASE_URL: new URL(db, adminDB.replace(/\/[^/?]*(\?|$)/, '/$1')).href,
      SPECOLA_DEV_AUTH_EMAIL: 'dev@example.com',
      SPECOLA_BASE_URL: app,
      SPECOLA_LISTEN: `:${port}`,
      SPECOLA_SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret',
      ...env,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    await waitFor(async () => (await fetch(app + '/healthz')).ok, 'server start');
    await checkServer(app, !!env.SPECOLA_VIEW_ORIGIN);
  } finally {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    execFileSync('psql', [adminDB, '-qc', `DROP DATABASE ${db}`]);
  }
}

async function checkServer(app, viewOrigin) {
  const api = async (method, path, body) => {
    const res = await fetch(app + path, { method, body: body && JSON.stringify(body) });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };

  const tarball = await fetch(`${app}/tools/specola-vite-plugin-${pluginVersion}.tgz`);
  check(tarball.ok && tarball.headers.get('content-type') === 'application/gzip', 'plugin tarball is served', tarball.status);

  const up = await api('POST', '/api/bundle-uploads', { kind: 'new', title: 'E2E bundle', note: 'e2e' });
  check(up.command === `npx specola-publish --upload '${up.uploadUrl}'`, 'upload command', up.command);
  const out = execFileSync(process.execPath, [join(root, 'plugin/bin/specola-publish.js'), '--upload', up.uploadUrl, '--dir', dist, '--no-build'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const published = JSON.parse(out);
  check(published.id && published.version === 1, 'specola-publish published the bundle', published);
  const id = published.id;
  const meta = await api('GET', `/api/pages/${id}`);
  const { base } = await api('GET', `/api/pages/${id}/versions/1/files`);
  check(meta.bundle === true, 'page metadata says bundle');
  const assetOrigin = viewOrigin ? `http://127.0.0.1:${port}` : app;
  check(base.startsWith(assetOrigin + '/b/') && base.endsWith('/'), 'bundle base is on the asset origin', base);

  const context = await browser.newContext();
  const responses = [];
  const consoleLines = [];
  const errors = [];
  context.on('response', (r) => responses.push({ url: r.url(), status: r.status() }));
  context.on('console', (m) => consoleLines.push(m.text()));
  context.on('weberror', (e) => errors.push(String(e.error())));
  try {
    // 1. In the viewer.
    const page = await context.newPage();
    await page.goto(`${app}/#/p/${id}`);
    const frame = await waitFor(() => page.frames().find((f) => f.url().includes(`/view/${id}`)), 'page frame');
    const frameURL = new URL(frame.url());
    const basename = frameURL.pathname;
    if (viewOrigin) {
      check(frameURL.origin === assetOrigin && /^\/t\/[^/]+\/view\/[^/]+$/.test(basename), 'frame uses the token-in-path view URL', frame.url());
    } else {
      check(basename === `/view/${id}`, 'frame is /view/{id}', frame.url());
    }
    const viewer = await results(frame);
    expectResults('viewer', viewer, { base, basename });
    check(viewer.storage?.value?.persistent === true, 'viewer: localStorage reaches the server', viewer.storage);
    check(consoleLines.some((l) => l.includes("module workers can't run")), 'module worker dropped with a console warning');
    for (const [what, re] of [
      ['CSS font url()', /\/assets\/e2e-[^/]+\.woff2$/],
      ['CSS image url()', /\/assets\/pattern-[^/]+\.svg$/],
    ]) {
      const r = responses.find((r) => r.url.startsWith(base) && re.test(r.url));
      check(r && r.status === 200, `${what} loads from the bundle`, r || responses.map((r) => r.url));
    }

    // 2. pushState to a deep path, then reload the frame: served again.
    await frame.evaluate((b) => history.pushState({}, '', b + '/deep/route?x=1'), basename);
    const deepURL = await frame.evaluate(() => location.href);
    await frame.evaluate(() => setTimeout(() => location.reload(), 0));
    await frame.waitForURL(deepURL).catch(() => {});
    await frame.waitForFunction(() => document.documentElement.dataset.e2e === 'done' && performance.navigation.type === 1, null, { timeout: 15000 });
    const reloaded = await frame.evaluate(() => window.__e2e);
    expectResults('reloaded deep path', reloaded, { base, basename, path: basename + '/deep/route' });

    // 3. The deep URL loaded directly, as a deep link.
    const direct = await context.newPage();
    const res = await direct.goto(deepURL);
    check(res.status() === 200, 'deep URL loads directly', res.status());
    expectResults('direct deep link', await results(direct.mainFrame()), { base, basename, path: basename + '/deep/route' });

    // 4. A public link, at its root and deep.
    const link = await api('POST', `/api/pages/${id}/links`, {});
    const linkBase = new URL(link.url).pathname;
    for (const url of [link.url, link.url + '/some/deep/path']) {
      const p = await context.newPage();
      const r = await p.goto(url);
      check(r.status() === 200, `public link ${url.slice(link.url.length) || '/'} loads`, r.status());
      expectResults('public link', await results(p.mainFrame()), { base, basename: linkBase, path: new URL(url).pathname });
    }
  } finally {
    check(errors.length === 0, 'no uncaught errors in any page', errors);
    await context.close();
  }

  await checkOffline(app, api, id, base);
}

// checkOffline opens the bundle and a plain page in the app online (which
// keeps them), saves the bundle for offline, then reloads the app offline and
// checks both run from the kept copies.
async function checkOffline(app, api, id, base) {
  const plain = await api('POST', '/api/pages', {
    name: 'E2E plain',
    html: '<!doctype html><p id="p">plain</p><script>document.getElementById("p").textContent = "plain ran"</script>',
  });
  const context = await browser.newContext();
  const errors = [];
  context.on('weberror', (e) => errors.push(String(e.error())));
  let offline = false;
  const network = []; // requests for the bundle's files while offline
  context.on('request', (r) => offline && r.url().startsWith(base) && network.push(r.url()));
  try {
    const page = await context.newPage();
    await page.goto(app + '/');
    // Once the service worker is in control, the app's own reads (say,
    // /api/me) are kept for offline too.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await waitFor(() => page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker in control');
    const kept = (pid, field = 'versions') =>
      waitFor(() => page.evaluate(([pid, field]) => JSON.parse(localStorage.getItem('specola:offline') || '{}').pages?.[pid]?.[field]?.includes(1), [pid, field]), `page kept (${field})`);

    // The new-page form hands out the commands that publish a bundle.
    await page.goto(`${app}/#/new`);
    await page.getByLabel('Title').fill('From the form');
    await page.getByRole('button', { name: 'Get the commands' }).click();
    await page.locator('code.font-mono').nth(1).waitFor();
    const commands = await page.locator('code.font-mono').allTextContents();
    check(
      commands.length === 2 && commands[0] === `npm i -D ${app}/tools/specola-vite-plugin-${pluginVersion}.tgz` && /^npx specola-publish --upload '.+\/upload\/bundle\/[^/]+'$/.test(commands[1]),
      'new-page form shows the plugin install and publish commands',
      commands,
    );

    await page.goto(`${app}/#/p/${plain.id}`);
    await kept(plain.id);
    await page.goto(`${app}/#/p/${id}`);
    const online = await waitFor(() => page.frames().find((f) => /^https?:/.test(f.url()) && f.url().includes(`/view/${id}`)), 'page frame');
    expectResults('online in the app', await results(online), { base });
    check(await page.locator('span', { hasText: /^bundle$/ }).first().isVisible(), 'viewer header shows the bundle badge');
    await kept(id, 'bundles');
    check(true, 'opening the bundle kept it with its files');
    await page.getByRole('button', { name: 'Save offline' }).click();
    await page.getByRole('button', { name: 'Saved offline ✓' }).waitFor();
    check(true, 'bundle saved offline (pinned)');
    const cached = await page.evaluate(async (pid) => {
      const c = await caches.open('specola-pages');
      return (await c.keys()).map((r) => new URL(r.url).pathname).filter((p) => p.startsWith(`/__offline/pages/${pid}/`)).length;
    }, id);
    check(cached > 5, 'bundle files are in Cache Storage', cached);

    await context.setOffline(true);
    offline = true;
    await page.reload();
    const frame = await waitFor(() => page.frames().find((f) => f.url().startsWith('blob:')), 'offline frame');
    check(await page.locator('text=offline copy').isVisible(), 'viewer shows the offline copy');
    const r = await results(frame);
    expectResults('offline', r, { base });
    // e2e.woff2 is no real font (the check is that it is fetched), so its
    // face fails to decode either way: check the kept bytes reach it.
    const style = await frame.evaluate(async () => {
      const css = [...document.styleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join(' ');
      const font = css.match(/@font-face[^}]*url\("([^"]+)"\)/)?.[1] ?? '';
      return {
        font,
        fontBytes: font.startsWith('blob:') ? (await (await fetch(font)).text()).slice(0, 4) : '',
        fontStatus: [...document.fonts].find((f) => f.family.includes('E2E'))?.status,
        background: getComputedStyle(document.body).backgroundImage,
      };
    });
    check(style.fontBytes === 'wOF2' && style.fontStatus !== 'unloaded', 'offline: CSS font url() loads from a kept blob', style);
    check(style.background.startsWith('url("blob:'), 'offline: CSS image url() points at a kept blob', style.background);

    check(network.length === 0, 'offline: no request for the bundle files', network);

    // A plain page offline, as before.
    await page.goto(`${app}/#/p/${plain.id}`);
    const pf = await waitFor(() => page.frames().find((f) => f.url().startsWith('blob:') && f !== frame), 'plain offline frame');
    await pf.waitForFunction(() => document.getElementById('p')?.textContent === 'plain ran', null, { timeout: 15000 });
    check(true, 'plain page runs offline');

    // A bundle missing a file is reported, not shown broken.
    await page.evaluate(async (pid) => {
      const c = await caches.open('specola-pages');
      const key = (await c.keys()).find((r) => r.url.includes(`/__offline/pages/${pid}/1/file/`));
      await c.delete(key);
    }, id);
    await page.goto(`${app}/#/p/${id}`);
    await page.getByText("isn't available offline").waitFor();
    check(!page.frames().some((f) => f.url().startsWith('blob:')), 'a bundle not kept whole is reported as not available offline');
  } finally {
    check(errors.length === 0, 'offline: no uncaught errors', errors);
    await context.close();
  }
}

// results waits for the app's checks to finish in frame and returns them.
async function results(frame) {
  await frame.waitForFunction(() => document.documentElement.dataset.e2e === 'done', null, { timeout: 15000 });
  return frame.evaluate(() => window.__e2e);
}

function expectResults(where, r, { base, basename, path }) {
  const v = (name) => (r[name] && r[name].ok ? r[name].value : r[name]);
  check(v('render') === 'bundle rendered', `${where}: app renders`, r.render);
  check(v('lazy') === 'bundle lazy chunk', `${where}: lazy import() resolves`, r.lazy);
  check(v('worker')?.value === 42 && v('worker')?.isWorker === true, `${where}: worker runs (instanceof Worker)`, r.worker);
  check(v('moduleWorker')?.value === 42, `${where}: {type:"module"} worker runs as classic`, r.moduleWorker);
  check(v('blobWorker')?.value === 63, `${where}: blob: worker passes through`, r.blobWorker);
  check(v('json') === 'hello from data.json', `${where}: fetched JSON loads`, r.json);
  check(v('image') === 32, `${where}: image loads`, r.image);
  check(v('baseFetch') === 'hello from public/', `${where}: fetch of specola.base + path`, r.baseFetch);
  check(v('baseXHR') === 'hello from public/', `${where}: XHR of specola.base + path`, r.baseXHR);
  check(v('storage')?.value === 'kept', `${where}: localStorage works`, r.storage);
  const s = v('specola') || {};
  check(s.base === base, `${where}: window.specola.base`, s.base);
  if (basename !== undefined) check(s.basename === basename, `${where}: window.specola.basename`, s.basename);
  if (path) check(s.path === path, `${where}: location.pathname`, s.path);
}

async function waitFor(fn, what, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
