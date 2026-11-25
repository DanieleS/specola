#!/usr/bin/env node
// End-to-end check of page apps (docs/page-apps.md) in Chromium: starts a
// real Specola (on the app origin alone, then with a separate view origin),
// publishes a page, opens it at /app/{id}/ and checks that the browser
// parses the app's own manifest (its id, scope, name and colors, next to
// Specola's own), that the page shows alone with its localStorage kept
// across reloads, that it opens offline from the copy kept on the device,
// that the viewer links to the app, and that an app for a page that isn't
// there says so.
//
// Needs: Go, a PostgreSQL to create throwaway databases on, the SPA built
// (cd web && npm run build) and Playwright with Chromium. See e2e/README.md.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adminDB = process.env.SPECOLA_E2E_DATABASE_URL || 'postgres://postgres:dev@localhost:5432/postgres?sslmode=disable';
const port = Number(process.env.SPECOLA_E2E_PORT || 18080);

// A page that counts its loads in localStorage, and says once the count is
// saved.
const counter = `<!doctype html>
<html><head><meta name="theme-color" content="#0F766E"><title>counter</title></head>
<body><p id="count"></p><script>
  const n = Number(localStorage.getItem('n') || 0) + 1;
  localStorage.setItem('n', String(n));
  document.getElementById('count').textContent = 'count ' + n;
  (window.specola && window.specola.flush ? window.specola.flush() : Promise.resolve())
    .then(() => { document.body.dataset.saved = String(window.specola ? window.specola.persistent : false); });
</script></body></html>`;

let failures = 0;
function check(ok, what, detail) {
  if (ok) {
    console.log(`  ok    ${what}`);
  } else {
    failures++;
    console.log(`  FAIL  ${what}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  }
}

if (!existsSync(join(root, 'internal/webui/dist/assets'))) {
  console.error('missing internal/webui/dist/assets: build the SPA first (cd web && npm install && npm run build)');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'specola-e2e-apps-'));
const bin = join(tmp, 'specola');
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
    await checkApps(app);
    await checkPublicApps(app);
  } finally {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    execFileSync('psql', [adminDB, '-qc', `DROP DATABASE ${db}`]);
  }
}

async function checkApps(app) {
  const res = await fetch(app + '/api/pages', { method: 'POST', body: JSON.stringify({ name: 'Load counter', html: counter }) });
  const { id } = await res.json();
  check(res.ok && id, 'page published', res.status);

  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // Specola's own app, as before.
  await page.goto(app + '/');
  let m = await cdp.send('Page.getAppManifest');
  check(m.url === app + '/manifest.webmanifest' && JSON.parse(m.data).id === '/', "Specola's own manifest", m.url);

  // The viewer links to the page's app.
  await page.goto(`${app}/#/p/${id}`);
  const link = page.getByRole('link', { name: /Install as app/ });
  await link.waitFor();
  check((await link.getAttribute('href')) === `/app/${id}/`, 'the viewer links to the app', await link.getAttribute('href'));
  // Its first load is counted and saved.
  await page.frameLocator('iframe').locator('body[data-saved]').waitFor({ timeout: 15000 });

  // The app: its own manifest, title and the page alone.
  await page.goto(`${app}/app/${id}/`);
  m = await cdp.send('Page.getAppManifest');
  const parsed = m.data ? JSON.parse(m.data) : {};
  check(m.url === `${app}/app/${id}/manifest.webmanifest` && !m.errors.length, "the app's manifest is fetched and parses", m);
  check(
    parsed.id === `/app/${id}/` && parsed.scope === `/app/${id}/` && parsed.start_url === `/app/${id}/` &&
      parsed.name === 'Load counter' && parsed.theme_color === '#0f766e',
    'its id, scope, name and theme color',
    parsed,
  );
  check((await page.title()) === 'Load counter', 'the document is titled after the page', await page.title());
  const icon = await fetch(new URL(parsed.icons?.[1]?.src ?? '/', app));
  check(icon.ok && icon.headers.get('content-type') === 'image/png', 'its icon is served', icon.status);

  const frame = async () => {
    const f = page.frameLocator('iframe');
    await f.locator('body[data-saved]').waitFor({ timeout: 15000 });
    return {
      count: await f.locator('#count').textContent(),
      persistent: await f.locator('body').getAttribute('data-saved'),
    };
  };
  let shown = await frame();
  // The viewer loaded it once already: the app has the same data.
  check(shown.count === 'count 2' && shown.persistent === 'true', "the page shows, with the user's storage, as in the viewer", shown);
  check((await page.locator('header').count()) === 0, "no Specola chrome around it");

  await page.reload();
  shown = await frame();
  check(shown.count === 'count 3', 'localStorage is kept across reloads', shown);

  // Offline: once the worker controls the app and the page is kept.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await frame();
  await waitFor(
    () => page.evaluate((id) => !!JSON.parse(localStorage.getItem('specola:offline') || '{}').pages?.[id], id),
    'the page kept for offline',
  );
  await context.setOffline(true);
  await page.reload();
  const offlineFrame = page.frameLocator('iframe');
  await offlineFrame.locator('#count').waitFor({ timeout: 15000 }).catch(() => {});
  const offlineCount = await offlineFrame.locator('#count').textContent().catch(() => null);
  check(/^count \d+$/.test(offlineCount ?? ''), 'offline, the app opens from the kept copy', offlineCount);
  check((await page.title()) === 'Load counter', "offline, the app's own shell", await page.title());
  await context.setOffline(false);

  // The author sets how the app looks: in the viewer's App dialog, a name
  // and an uploaded icon, which the app's manifest then has.
  await page.goto(`${app}/#/p/${id}`);
  await page.getByRole('button', { name: 'App…' }).click();
  const dialog = page.locator('[data-app-settings]');
  await dialog.locator('[data-app-name]').fill('Counter app');
  await dialog.locator('[data-app-save]').click();
  await dialog.getByText('Saved.').waitFor();
  const png = Buffer.from(await (await fetch(`${app}/app-icons/g/1d4ed8/C/512.png`)).arrayBuffer());
  await dialog.locator('[data-app-icon-input]').setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: png });
  await dialog.getByText('Use the generated icon').waitFor();
  await page.goto(`${app}/app/${id}/`);
  const set = await cdp.send('Page.getAppManifest');
  const sm = set.data ? JSON.parse(set.data) : {};
  check(
    sm.name === 'Counter app' && sm.icons?.length === 1 && /^\/app-icons\/[0-9a-f]{64}\.png$/.test(sm.icons[0].src) && sm.icons[0].sizes === '512x512',
    "the author's name and icon reach the app's manifest",
    sm,
  );
  check((await page.title()) === 'Counter app', "and the app's title", await page.title());

  // A page that isn't there (or not for this user).
  await page.goto(`${app}/app/${randomUUID()}/`);
  await page.locator('[data-app-gone]').waitFor({ timeout: 10000 }).catch(() => {});
  check(await page.locator('[data-app-gone]').isVisible(), "an app for a missing page says so");

  check(!errors.length, 'no page errors', errors);
  await context.close();
}

// A public link is installable too, from its shell at /s/{token}, with no
// account: its own manifest, the page in the frame, offline from the copy
// the shell keeps once installed, and nothing left once revoked.
async function checkPublicApps(app) {
  const res = await fetch(app + '/api/pages', { method: 'POST', body: JSON.stringify({ name: 'Public counter', html: counter }) });
  const { id } = await res.json();
  const link = await (await fetch(`${app}/api/pages/${id}/links`, { method: 'POST', body: '{}' })).json();
  const path = new URL(link.url).pathname;

  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(link.url);
  const m = await cdp.send('Page.getAppManifest');
  const parsed = m.data ? JSON.parse(m.data) : {};
  check(m.url === `${link.url}/~app.webmanifest` && !m.errors.length, "a public link's manifest is fetched and parses", m);
  check(
    parsed.id === path + '/' && parsed.start_url === path + '/' && parsed.scope === path && parsed.name === 'Public counter',
    'its id, start and scope are the link',
    parsed,
  );
  check((await page.title()) === 'Public counter', 'the shell is titled after the page', await page.title());
  const f = page.frameLocator('iframe');
  const shown = async () => {
    await f.locator('body[data-saved]').waitFor({ timeout: 15000 });
    return { count: await f.locator('#count').textContent(), persistent: await f.locator('body').getAttribute('data-saved') };
  };
  let got = await shown();
  check(got.count === 'count 1' && got.persistent === 'true', 'the page shows in the shell, with storage that persists', got);

  // An anonymous visitor: its localStorage is kept across reloads, apart
  // from another browser's (docs/page-apps.md, "Anonymous visitors").
  const token = path.slice(3);
  const secret = await page.evaluate((t) => localStorage.getItem('specola:public-visitor:' + t), token);
  check(/^"[A-Za-z0-9_-]{43}"$/.test(secret ?? ''), "the first write made a visitor, its secret kept by the link's shell", secret);
  check((await context.cookies()).length === 0, 'and no cookies at all');
  await page.reload();
  got = await shown();
  check(got.count === 'count 2', "the visitor's localStorage is kept across reloads", got);
  const other = await browser.newContext();
  const op = await other.newPage();
  await op.goto(link.url);
  await op.frameLocator('iframe').locator('body[data-saved]').waitFor({ timeout: 15000 });
  const otherCount = await op.frameLocator('iframe').locator('#count').textContent();
  check(otherCount === 'count 1', 'another browser is another visitor, with data of its own', otherCount);
  await other.close();
  const listed = await (await fetch(`${app}/api/pages/${id}/links`)).json();
  check(listed[0]?.visitors === 2 && listed[0].visitorBytes > 0, 'the owner sees two visitors keep data', listed[0]);

  // Installed: the shell keeps the page. Headless Chromium can't emulate
  // display-mode, so navigator.standalone (iOS's flag) says it.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
  await page.reload();
  await f.locator('body[data-saved]').waitFor({ timeout: 15000 });
  await waitFor(() => page.evaluate((k) => caches.match(k).then((r) => !!r), path + '/~kept'), 'the page kept for offline');
  check(true, 'installed, the shell keeps a copy of the page');
  check(!(await page.locator('#install').isVisible()), 'no install banner in the installed app');

  await context.setOffline(true);
  await page.reload();
  const offline = page.frameLocator('iframe');
  await offline.locator('#count').waitFor({ timeout: 15000 }).catch(() => {});
  const offCount = await offline.locator('#count').textContent().catch(() => null);
  check(/^count \d+$/.test(offCount ?? ''), 'offline, the public app opens from the kept copy', offCount);
  // Its data is the copy the shell keeps, with what it couldn't save yet.
  const n = Number(offCount?.split(' ')[1]);
  await page.reload();
  await offline.locator('#count').waitFor({ timeout: 15000 }).catch(() => {});
  const again = await offline.locator('#count').textContent().catch(() => null);
  check(again === `count ${n + 1}`, 'offline, writes are kept across reloads', { before: offCount, after: again });
  check((await page.title()) === 'Public counter', "offline, the link's own shell", await page.title());
  await context.setOffline(false);
  // Back online, the shell saves them.
  await page.reload();
  await f.locator('body[data-saved]').waitFor({ timeout: 15000 });
  const online = await f.locator('#count').textContent();
  check(online === `count ${n + 2}`, 'back online, the offline writes are saved', online);

  // Revoked: the link answers 404 and the worker drops what it kept.
  const links = await (await fetch(`${app}/api/pages/${id}/links`)).json();
  await fetch(`${app}/api/pages/${id}/links/${links[0].id}`, { method: 'DELETE' });
  const gone = await page.reload();
  check(gone.status() === 404, 'a revoked link answers 404', gone.status());
  const left = await page.evaluate((k) => Promise.all([caches.match(k + '/'), caches.match(k + '/~kept')]).then((r) => r.some(Boolean)), path);
  check(!left, 'and nothing of it stays on the device');

  check(!errors.length, 'no page errors', errors);
  await context.close();
}

async function waitFor(f, what, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      if (await f()) return;
    } catch {
      // not yet
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
