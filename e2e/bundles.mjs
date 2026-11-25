#!/usr/bin/env node
// End-to-end check of SPA bundles (docs/spa-bundles.md) in a real browser:
// builds e2e/app with the Vite plugin, starts a real Specola (once on the
// app origin alone, once with a separate view origin), publishes the build
// with the real specola-publish CLI, and checks in Chromium, inside the
// sandboxed frame, that the app renders, a lazy import resolves with its CSS,
// workers run and find their own files, a fragment link routes, fetched JSON
// and CSS url()s load, window.specola.base/basename are right, a deep path
// survives pushState + reload and a direct load, and a public link works
// too; and that the viewer fits a phone's width. Then it keeps the bundle for
// offline viewing in the app, goes offline, and checks the kept copy runs the
// same way (and that a plain page still shows offline), that the page's
// localStorage starts from its latest data offline and keeps its offline
// writes across reloads, and that they are saved once back online.
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
  check(up.command === `npx --no -- specola-publish --upload '${up.uploadUrl}'`, 'upload command', up.command);
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
    check(!consoleLines.some((l) => l.includes("module workers can't run")), 'a bundle worker with {type:"module"} starts without a warning', consoleLines);
    for (const [what, re] of [
      ['CSS font url()', /\/assets\/e2e-[^/]+\.woff2$/],
      ['CSS image url()', /\/assets\/pattern-[^/]+\.svg$/],
    ]) {
      const r = responses.find((r) => r.url.startsWith(base) && re.test(r.url));
      check(r && r.status === 200, `${what} loads from the bundle`, r || responses.map((r) => r.url));
    }

    // 1b. At phone width the viewer's header fits, and its controls don't overlap.
    await checkPhoneWidth(context, app, id);

    // 2. pushState to a deep path, then reload the frame: served again.
    await frame.evaluate((b) => history.pushState({}, '', b + '/deep/route?x=1'), basename);
    const deepURL = await frame.evaluate(() => location.href);
    await frame.evaluate(() => setTimeout(() => location.reload(), 0));
    await frame.waitForURL(deepURL).catch(() => {});
    await frame.waitForFunction(() => document.documentElement.dataset.e2e === 'done' && performance.getEntriesByType('navigation')[0]?.type === 'reload', null, { timeout: 15000 });
    const reloaded = await frame.evaluate(() => window.__e2e);
    expectResults('reloaded deep path', reloaded, { base, basename, path: basename + '/deep/route' });

    // 3. The deep URL loaded directly, as a deep link.
    const direct = await context.newPage();
    const res = await direct.goto(deepURL);
    check(res.status() === 200, 'deep URL loads directly', res.status());
    expectResults('direct deep link', await results(direct.mainFrame()), { base, basename, path: basename + '/deep/route' });

    // 4. A public link, at its root and deep: its shell frames the page at
    // ~page, keeping the path (docs/page-apps.md, "Public apps").
    const link = await api('POST', `/api/pages/${id}/links`, {});
    const linkBase = new URL(link.url).pathname + '/~page';
    for (const url of [link.url, link.url + '/some/deep/path']) {
      const p = await context.newPage();
      const r = await p.goto(url);
      check(r.status() === 200, `public link ${url.slice(link.url.length) || '/'} loads`, r.status());
      const f = await waitFor(() => p.frames().find((fr) => fr.url().includes('/~page')), 'the shell to frame the page');
      const path = linkBase + new URL(url).pathname.slice(new URL(link.url).pathname.length);
      expectResults('public link', await results(f), { base, basename: linkBase, path });
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
      commands.length === 2 && commands[0] === `npm i -D ${app}/tools/specola-vite-plugin-${pluginVersion}.tgz` && /^npx --no -- specola-publish --upload '.+\/upload\/bundle\/[^/]+'$/.test(commands[1]),
      'new-page form shows the plugin install and publish commands',
      commands,
    );
    // The link was made for that title: once it changes, its commands go.
    await page.getByLabel('Title').fill('Another title');
    check((await page.locator('code.font-mono').count()) === 0, 'new-page form hides commands made for an earlier title');

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

    // Files of a version the index doesn't list (a download cut short) are
    // deleted when the app next starts online.
    // Files another tab is storing (it holds the version's lock) stay.
    const orphan = `/__offline/pages/${id}/99/file/assets/gone.js`;
    const storing = `/__offline/pages/${id}/98/file/assets/coming.js`;
    const other = await context.newPage();
    await other.goto(app + '/');
    await other.evaluate(
      (k) =>
        new Promise((held) =>
          navigator.locks.request('specola-keep ' + k.replace(/\/file\/.*/, ''), () => (held(), new Promise((r) => (window.release = r)))),
        ),
      storing,
    );
    const has = (k) => page.evaluate(async (k) => !!(await (await caches.open('specola-pages')).match(k)), k);
    await page.evaluate(async (ks) => {
      const c = await caches.open('specola-pages');
      for (const k of ks) await c.put(k, new Response('x'));
    }, [orphan, storing]);
    await page.reload();
    await waitFor(async () => !(await has(orphan)), 'orphan pruned');
    check(true, 'files no kept version lists are pruned');
    check(await has(storing), 'files another tab is storing are not pruned');
    await other.evaluate(() => window.release());
    await other.close();

    // The page's localStorage across going offline: the reload above opened
    // the bundle again, which counted a load. Once saved, the copy of the
    // page's data kept for offline has it too.
    const reopened = await waitFor(() => page.frames().find((f) => /^https?:/.test(f.url()) && f.url().includes(`/view/${id}`)), 'page frame again');
    const count = (await results(reopened)).count?.value;
    const cachedCount = () =>
      page.evaluate(async (pid) => {
        const hit = await caches.match(`/api/pages/${pid}/data`, { cacheName: 'specola-api' });
        return hit ? Number((await hit.json()).count) : null;
      }, id);
    await waitFor(async () => Number((await api('GET', `/api/pages/${id}/data`)).count) === count, 'count saved').catch(() => {});
    await waitFor(async () => (await cachedCount()) === count, 'count kept for offline').catch(() => {});
    check((await cachedCount()) === count, 'a saved localStorage write updates the data kept for offline', { count, cached: await cachedCount() });

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

    // Offline, the page starts from its latest data, and its writes survive
    // reloading the app.
    check(r.count?.value === count + 1, 'offline: localStorage starts from the data saved last online', { count, offline: r.count });
    await page.reload();
    const again = await waitFor(() => page.frames().find((f) => f.url().startsWith('blob:')), 'offline frame after reload');
    const r2 = await results(again);
    check(r2.count?.value === count + 2, 'offline: localStorage writes survive reloading the app', { count, offline: r2.count });

    // A plain page offline, as before.
    await page.goto(`${app}/#/p/${plain.id}`);
    const pf = await waitFor(() => page.frames().find((f) => f.url().startsWith('blob:') && f !== frame && f !== again), 'plain offline frame');
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

    // Back online, the writes made offline reach the server.
    await context.setOffline(false);
    offline = false;
    await page.reload();
    const back = await waitFor(() => page.frames().find((f) => /^https?:/.test(f.url()) && f.url().includes(`/view/${id}`)), 'page frame back online');
    const r3 = await results(back);
    check(r3.count?.value === count + 3, 'back online: the page sees its offline writes', { count, online: r3.count });
    await waitFor(async () => Number((await api('GET', `/api/pages/${id}/data`)).count) === count + 3, 'offline writes saved').catch(() => {});
    check(Number((await api('GET', `/api/pages/${id}/data`)).count) === count + 3, 'back online: offline writes are saved on the server');
  } finally {
    check(errors.length === 0, 'offline: no uncaught errors', errors);
    await context.close();
  }
}

// checkPhoneWidth opens the page in the app at 375 px wide: nothing may stick
// out sideways, the header's controls mustn't overlap, and the history
// panel mustn't squeeze the page.
async function checkPhoneWidth(context, app, id) {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(`${app}/#/p/${id}`);
    await waitFor(() => page.frames().find((f) => f.url().includes(`/view/${id}`)), 'page frame at phone width');
    await page.getByRole('button', { name: 'History' }).waitFor();
    const layout = () =>
      page.evaluate(() => {
        const header = document.querySelector('[data-viewer-header]');
        const boxes = [...header.querySelectorAll('a, button, span')]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ el, r }) => r.width > 0 && r.height > 0 && !el.querySelector('a, button, span'))
          .map(({ el, r }) => ({ text: el.textContent.trim().slice(0, 20), l: r.left, r: r.right, t: r.top, b: r.bottom }));
        const overlaps = [];
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) overlaps.push([a.text, b.text]);
          }
        const frame = document.querySelector('iframe')?.getBoundingClientRect();
        return {
          scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          outside: boxes.filter((b) => b.l < 0 || b.r > innerWidth + 1).map((b) => b.text),
          overlaps,
          frameWidth: frame ? Math.round(frame.width) : 0,
        };
      });
    const closed = await layout();
    check(closed.scroll <= 0 && closed.outside.length === 0 && closed.overlaps.length === 0, 'phone width: header fits without overlaps', closed);
    await page.getByRole('button', { name: 'History' }).click();
    await page.getByRole('complementary', { name: 'Version history' }).waitFor();
    const open = await waitFor(async () => {
      const l = await layout();
      return l.frameWidth >= 375 ? l : null;
    }, 'page frame at full width').catch(layout);
    check(open.scroll <= 0 && open.frameWidth >= 375, 'phone width: history doesn\'t squeeze the page', open);
  } finally {
    await page.close();
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
  check(v('lazy') === 'bundle lazy chunk|rgb(10, 20, 30)', `${where}: lazy import() resolves, with its CSS`, r.lazy);
  const aw = v('assetWorker')?.value;
  check(
    aw?.viaImport === 'hello from the worker' && aw?.viaURL === 'hello from the worker' && aw?.location?.startsWith(base + 'assets/assetworker-'),
    `${where}: a worker loads its own files by relative URLs`,
    r.assetWorker,
  );
  check(v('hashLink') === '#/e2e-route', `${where}: a fragment link changes the hash and fires hashchange`, r.hashLink);
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
