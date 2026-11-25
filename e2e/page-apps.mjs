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

  // A page that isn't there (or not for this user).
  await page.goto(`${app}/app/${randomUUID()}/`);
  await page.locator('[data-app-gone]').waitFor({ timeout: 10000 }).catch(() => {});
  check(await page.locator('[data-app-gone]').isVisible(), "an app for a missing page says so");

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
