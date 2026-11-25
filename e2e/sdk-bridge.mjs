#!/usr/bin/env node
// Browser check of the page backend bridge (docs/page-backends.md, "Frame ↔
// viewer"), without a Specola server: both halves of it, as they ship. The
// frame runs internal/server/pagesdk.js (specola.fetch); the parent runs the
// viewer's half, web/src/lib/pagedata.ts (serveStorage), bundled here with
// esbuild; a small Node server plays Specola's /api/pages/{id}/x/… and the
// runner behind it. Checked in Chromium, in a frame sandboxed as the viewer
// sandboxes pages (opaque origin):
//
// - an answer streams: a chunk reaches the page while the backend is still
//   writing, and the body ends when the backend does;
// - calls made before the port arrives wait for it; specola.backend follows
//   the port's handover;
// - the request goes out with its method, the page's headers (not its
//   X-Specola-* ones), listed in X-Specola-Headers too (only those reach a
//   handler), X-Specola-Version, and a FormData body whose bytes and
//   multipart boundary the backend parses back;
// - aborting (before the answer and while it streams) rejects with an
//   AbortError and cancels the viewer's request; so does the frame going;
// - backend-disabled / backend-unavailable / superseded become a
//   BackendUnavailable with that reason (superseded tells the viewer), other
//   errors (backend-error) and the handler's own statuses reach the page as
//   a Response; a redirect is not followed;
// - only paths are accepted, and dot segments can't leave the page's /x/;
// - opened raw, offline, or without a backend, calls reject at once with the
//   right reason.
//
// Needs: the web dependencies (cd web && npm install, for esbuild) and
// Playwright with Chromium. Run: node e2e/sdk-bridge.mjs

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Playwright is usually installed globally, which import can't find.
const { chromium } = require('playwright');
const esbuild = require(join(root, 'web/node_modules/esbuild'));

let failures = 0;
function check(ok, what, detail) {
  if (ok) console.log(`  ok    ${what}`);
  else {
    failures++;
    console.log(`  FAIL  ${what}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  }
}

// The viewer's half, as the SPA has it. offline.svelte.ts needs Svelte's
// compiler (runes); serveStorage only reads the owner of its index.
const bridge = await esbuild.build({
  entryPoints: [join(root, 'web/src/lib/pagedata.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'pagedata',
  target: 'es2022',
  plugins: [
    {
      name: 'stub-offline',
      setup(b) {
        b.onResolve({ filter: /offline\.svelte$/ }, () => ({ path: 'offline', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const index = { owner: "" };', loader: 'js' }));
      },
    },
  ],
});
const bridgeJS = bridge.outputFiles[0].text;
const sdk = readFileSync(join(root, 'internal/server/pagesdk.js'), 'utf8');
const sdkFor = (boot) => sdk.replace(/SPECOLA_BOOT\)\s*;?\s*$/, `${JSON.stringify(boot)});`);

// Gates the streaming answer waits on, opened from here.
const gates = new Map();
const gate = (name) => {
  let open;
  const p = new Promise((r) => (open = r));
  gates.set(name, { p, open });
  return p;
};
const openGate = (name) => gates.get(name)?.open();
const seen = { closed: new Set(), finished: new Set(), paths: [], secret: 0 };

function specolaError(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Specola-Error': code });
  res.end(JSON.stringify({ error: code, message }));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/parent.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><body><script>${bridgeJS}</script></body>`);
    return;
  }
  if (url.pathname === '/frame.html') {
    const boot = { base: '', basename: '/view/p1', backend: url.searchParams.get('backend') !== '0' };
    res.writeHead(200, { 'Content-Type': 'text/html' });
    // A call made by the first script, before any port can have come.
    res.end(`<!doctype html><meta charset="utf-8"><script>${sdkFor(boot)}</script>
<script>
  window.early = specola.backend;
  window.earlyCall = specola.fetch("/echo?early=1").then((r) => r.json(), (e) => ({ name: e.name, reason: e.reason, message: e.message }));
</script><body>frame</body>`);
    return;
  }
  if (url.pathname === '/api/pages/p1/secret') {
    seen.secret++;
    res.end('secret');
    return;
  }
  const m = /^\/api\/pages\/p1\/x(\/.*)$/.exec(url.pathname);
  if (!m) {
    res.writeHead(404);
    res.end();
    return;
  }
  const path = m[1];
  seen.paths.push(path + url.search);
  req.on('close', () => {
    if (!res.writableFinished) seen.closed.add(path);
  });
  res.on('finish', () => seen.finished.add(path));
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  switch (path) {
    case '/echo': {
      const out = {
        method: req.method,
        query: url.search,
        version: req.headers['x-specola-version'] ?? null,
        custom: req.headers['x-custom'] ?? null,
        specolaFoo: req.headers['x-specola-foo'] ?? null,
        listed: req.headers['x-specola-headers'] ? JSON.parse(Buffer.from(req.headers['x-specola-headers'], 'base64url').toString('utf8')) : null,
        contentType: req.headers['content-type'] ?? null,
        size: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      };
      if (/^multipart\/form-data/.test(out.contentType ?? '')) {
        const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': out.contentType }, body }).formData();
        const file = fd.get('file');
        out.form = {
          text: fd.get('text'),
          fileName: file?.name,
          fileType: file?.type,
          fileSha256: file ? createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex') : null,
        };
      } else {
        out.text = body.toString('utf8');
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Handler': 'yes' });
      res.end(JSON.stringify(out));
      return;
    }
    case '/stream':
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('one;');
      await gates.get('stream').p;
      res.write('two;');
      await gates.get('stream2').p;
      res.end('three');
      return;
    case '/hang':
    case '/hang2':
    case '/hang3':
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('start;');
      return; // never ends: the page aborts
    case '/nohead':
      return; // never answers
    case '/disabled':
      return specolaError(res, 503, 'backend-disabled', 'page backends are not enabled on this instance');
    case '/unavailable':
      return specolaError(res, 503, 'backend-unavailable', 'the backend runner is unavailable');
    case '/superseded':
      return specolaError(res, 409, 'superseded', 'a new version of this page is available (version 4): reload it');
    case '/crash':
      return specolaError(res, 500, 'backend-error', 'the backend failed');
    case '/teapot':
      res.writeHead(418, { 'Content-Type': 'text/plain' });
      res.end('short and stout');
      return;
    case '/empty':
      res.writeHead(204);
      res.end();
      return;
    case '/redirect':
      res.writeHead(302, { Location: '/api/pages/p1/secret' });
      res.end();
      return;
    case '/binary': {
      const n = Number(url.searchParams.get('n'));
      const buf = Buffer.alloc(n);
      for (let i = 0; i < n; i++) buf[i] = i % 251;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      // In pieces, as a handler streaming a large answer would.
      for (let i = 0; i < n; i += 65536) res.write(buf.subarray(i, i + 65536));
      res.end();
      return;
    }
    default:
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('handler: no route ' + path);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  await page.goto(origin + '/parent.html');

  // A frame as the viewer makes it: sandboxed, opaque origin, served by
  // serveStorage with the page's backend.
  async function frame(name, opts = {}) {
    await page.evaluate(
      ({ name, opts, origin }) => {
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-scripts');
        f.name = name;
        window.superseded = window.superseded ?? {};
        window.superseded[name] = 0;
        window.stops = window.stops ?? {};
        const backend = opts.none
          ? undefined
          : {
              status: () => ({ enabled: true, available: !opts.unavailable }),
              version: 3,
              offline: !!opts.offline,
              onSuperseded: () => window.superseded[name]++,
            };
        window.stops[name] = pagedata.serveStorage(f, 'p1', false, undefined, backend);
        f.src = `${origin}/frame.html?backend=${opts.boot === false ? 0 : 1}`;
        document.body.append(f);
      },
      { name, opts, origin },
    );
    let fr;
    for (let i = 0; i < 100 && !fr; i++) {
      fr = page.frames().find((x) => x.name() === name);
      if (!fr) await page.waitForTimeout(20);
    }
    await fr.waitForFunction(() => window.earlyCall);
    return fr;
  }

  const f = await frame('main');
  check((await f.evaluate(() => self.origin)) === 'null', 'the frame runs on an opaque origin');
  const early = await f.evaluate(() => window.earlyCall);
  check(early.method === 'GET' && early.query === '?early=1', 'a call made before the port arrives waits for it', early);
  check(
    JSON.stringify(await f.evaluate(() => window.early)) === '{"enabled":false,"available":false}',
    'specola.backend is off until the port arrives',
  );
  check(
    JSON.stringify(await f.evaluate(() => specola.backend)) === '{"enabled":true,"available":true}',
    'specola.backend is the port handover',
  );

  // Streaming.
  gate('stream');
  gate('stream2');
  await f.evaluate(() => {
    window.got = [];
    window.streamDone = (async () => {
      const r = await specola.fetch('/stream');
      window.streamStatus = r.status;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'done';
        window.got.push(dec.decode(value));
      }
    })();
  });
  await f.waitForFunction(() => window.got.join('') === 'one;');
  check(!seen.finished.has('/stream'), 'the first chunk reaches the page while the backend is still writing');
  openGate('stream');
  await f.waitForFunction(() => window.got.join('') === 'one;two;');
  check(!seen.finished.has('/stream'), 'the second chunk too');
  openGate('stream2');
  check((await f.evaluate(() => window.streamDone)) === 'done', 'the body ends when the backend ends');
  check((await f.evaluate(() => window.got.join(''))) === 'one;two;three', 'every chunk, in order');

  // Request: method, headers, body.
  const echo = await f.evaluate(async () => {
    const r = await specola.fetch('/echo?x=1', {
      method: 'PUT',
      headers: { 'X-Custom': 'yes', 'X-Specola-Foo': 'forged', 'X-Specola-Version': '99' },
      body: 'hello',
    });
    return { status: r.status, handler: r.headers.get('x-handler'), body: await r.json(), ok: r.ok };
  });
  check(echo.status === 200 && echo.ok && echo.handler === 'yes', 'the Response has the handler status and headers', echo);
  check(echo.body.method === 'PUT' && echo.body.query === '?x=1' && echo.body.text === 'hello', 'method, query and body arrive', echo.body);
  check(echo.body.custom === 'yes' && echo.body.specolaFoo === null, "the page's headers arrive, its X-Specola-* ones don't", echo.body);
  check(echo.body.version === '3', 'X-Specola-Version is the version the frame shows', echo.body.version);
  check(
    JSON.stringify(echo.body.listed) === JSON.stringify([['content-type', 'text/plain;charset=UTF-8'], ['x-custom', 'yes']]),
    "X-Specola-Headers lists the page's headers, and only those",
    echo.body.listed,
  );
  check(/^text\/plain/.test(echo.body.contentType ?? ''), 'a string body gets its content type', echo.body.contentType);

  const json = await f.evaluate(async () => (await specola.fetch(new Request('/echo', { method: 'POST', body: new URLSearchParams({ a: '1' }) }))).json());
  check(json.method === 'POST' && json.text === 'a=1' && /urlencoded/.test(json.contentType), 'a Request with URLSearchParams works', json);

  const form = await f.evaluate(async () => {
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    const fd = new FormData();
    fd.append('text', 'café');
    fd.append('file', new Blob([bytes], { type: 'application/x-test' }), 'data.bin');
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const r = await specola.fetch('/echo', { method: 'POST', body: fd });
    return { sha, body: await r.json() };
  });
  check(
    /^multipart\/form-data; boundary=/.test(form.body.contentType) &&
      form.body.form?.text === 'café' &&
      form.body.form?.fileName === 'data.bin' &&
      form.body.form?.fileType === 'application/x-test' &&
      form.body.form?.fileSha256 === form.sha,
    'a FormData upload arrives byte for byte, with its boundary',
    { contentType: form.body.contentType, form: form.body.form },
  );

  const big = await f.evaluate(async () => {
    const b = new Uint8Array(await (await specola.fetch('/binary?n=3000000')).arrayBuffer());
    let ok = b.length === 3_000_000;
    for (let i = 0; ok && i < b.length; i++) ok = b[i] === i % 251;
    return ok;
  });
  check(big, 'a 3 MB binary answer arrives intact');

  // Abort.
  const ab1 = await f.evaluate(async () => {
    const ac = new AbortController();
    const p = specola.fetch('/nohead', { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    try {
      await p;
      return 'resolved';
    } catch (e) {
      return e.name;
    }
  });
  check(ab1 === 'AbortError', 'abort before the answer rejects with AbortError', ab1);
  const ab2 = await f.evaluate(async () => {
    const ac = new AbortController();
    const r = await specola.fetch('/hang', { signal: ac.signal });
    const reader = r.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    try {
      await reader.read();
      return 'read on';
    } catch (e) {
      return first + e.name;
    }
  });
  check(ab2 === 'start;AbortError', 'abort while streaming errors the body with AbortError', ab2);
  await page.waitForTimeout(300);
  check(seen.closed.has('/nohead') && seen.closed.has('/hang'), "aborting cancels the viewer's request", [...seen.closed]);
  const ab3 = await f.evaluate(async () => {
    const ac = new AbortController();
    ac.abort();
    try {
      await specola.fetch('/echo', { signal: ac.signal });
      return 'resolved';
    } catch (e) {
      return e.name;
    }
  });
  check(ab3 === 'AbortError', 'an aborted signal rejects at once', ab3);
  const cancel = await f.evaluate(async () => {
    const r = await specola.fetch('/hang2');
    await r.body.cancel();
    return 'ok';
  });
  await page.waitForTimeout(300);
  check(cancel === 'ok' && seen.closed.has('/hang2'), "cancelling the body cancels the viewer's request");

  // Errors.
  const errs = await f.evaluate(async () => {
    const out = {};
    for (const p of ['/disabled', '/unavailable', '/superseded']) {
      try {
        await specola.fetch(p);
        out[p] = 'resolved';
      } catch (e) {
        out[p] = { name: e.name, reason: e.reason, message: e.message, isError: e instanceof Error };
      }
    }
    return out;
  });
  for (const [p, reason] of [
    ['/disabled', 'disabled'],
    ['/unavailable', 'unavailable'],
    ['/superseded', 'superseded'],
  ]) {
    const e = errs[p];
    check(e?.name === 'BackendUnavailable' && e.reason === reason && e.isError && e.message.length > 0, `${p} rejects with BackendUnavailable (${reason})`, e);
  }
  check((await page.evaluate(() => window.superseded.main)) === 1, 'superseded tells the viewer');
  const passed = await f.evaluate(async () => {
    const c = await specola.fetch('/crash');
    const t = await specola.fetch('/teapot');
    const n = await specola.fetch('/nothing');
    const e = await specola.fetch('/empty', { method: 'DELETE' });
    return [c.status, c.headers.get('x-specola-error'), (await c.json()).error, t.status, await t.text(), n.status, e.status, e.body];
  });
  check(
    JSON.stringify(passed) === JSON.stringify([500, 'backend-error', 'backend-error', 418, 'short and stout', 404, 204, null]),
    'other errors and the handler statuses reach the page as a Response',
    passed,
  );
  const redirect = await f.evaluate(async () => {
    try {
      await specola.fetch('/redirect');
      return 'resolved';
    } catch (e) {
      return e.name;
    }
  });
  check(redirect === 'TypeError' && seen.secret === 0, 'a redirect is not followed', { redirect, secret: seen.secret });

  // Paths.
  const bad = await f.evaluate(async () => {
    const out = [];
    for (const input of ['api/x', 'https://evil.example/x', '//evil.example/x', '/\\evil.example/x', 42, new URL('https://evil.example/x')]) {
      try {
        await specola.fetch(input);
        out.push('resolved');
      } catch (e) {
        out.push(e.name);
      }
    }
    return out;
  });
  check(bad.every((x) => x === 'TypeError'), 'anything but a path is a TypeError', bad);
  seen.paths.length = 0;
  await f.evaluate(() => specola.fetch('/../../../secret?a=1'));
  await f.evaluate(() => specola.fetch('/%2e%2e/%2E%2E/secret'));
  check(
    seen.paths.length === 2 && seen.paths.every((p) => p.startsWith('/secret')) && seen.secret === 0,
    "dot segments can't leave the page's /x/",
    seen.paths,
  );
  // A page may skip the SDK and write to the port itself: the viewer
  // normalises too.
  seen.paths.length = 0;
  await f.evaluate(async () => {
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (m, t) {
      if (m && m.op === 'fetch') m = { ...m, path: '/../../secret' };
      return post.call(this, m, t);
    };
    try {
      await specola.fetch('/echo');
    } finally {
      MessagePort.prototype.postMessage = post;
    }
  });
  check(seen.paths.length === 1 && seen.paths[0] === '/secret' && seen.secret === 0, "the viewer keeps a forged path inside the page's /x/", seen.paths);

  // The frame going aborts its calls.
  await f.evaluate(() => {
    window.goneCall = specola.fetch('/hang3').then((r) => r.text()).catch((e) => e.name);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.stops.main());
  await page.waitForTimeout(300);
  check(seen.closed.has('/hang3'), "the frame going aborts the viewer's requests");

  // Without a backend to reach.
  const off = await frame('offline', { offline: true });
  const offErr = await off.evaluate(() => window.earlyCall);
  check(offErr.name === 'BackendUnavailable' && offErr.reason === 'offline', 'offline: BackendUnavailable (offline)', offErr);
  check(
    JSON.stringify(await off.evaluate(() => specola.backend)) === '{"enabled":true,"available":false}',
    'offline: specola.backend is not available',
  );
  const nob = await frame('noboot', { boot: false });
  const nobErr = await nob.evaluate(() => window.earlyCall);
  check(nobErr.name === 'BackendUnavailable' && nobErr.reason === 'disabled', 'boot.backend false: BackendUnavailable (disabled)', nobErr);
  check(
    JSON.stringify(await nob.evaluate(() => specola.backend)) === '{"enabled":false,"available":false}',
    'boot.backend false: specola.backend stays off',
  );
  const raw = await context.newPage();
  await raw.goto(origin + '/frame.html');
  const rawErr = await raw.evaluate(() => window.earlyCall);
  check(rawErr.name === 'BackendUnavailable' && rawErr.reason === 'unavailable', 'opened raw: BackendUnavailable (unavailable)', rawErr);
  await raw.close();

  // One port per load: the frame navigating to another document is refused.
  const again = await frame('again');
  await again.evaluate(() => location.reload());
  let reloaded;
  for (let i = 0; i < 100 && !reloaded; i++) {
    reloaded = page.frames().find((x) => x.name() === 'again');
    try {
      await reloaded.waitForFunction(() => window.earlyCall, null, { timeout: 200 });
    } catch {
      reloaded = null;
    }
  }
  const againErr = await reloaded.evaluate(() => window.earlyCall);
  check(againErr.name === 'BackendUnavailable' && againErr.reason === 'unavailable', 'a second hello is refused: BackendUnavailable (unavailable)', againErr);
} finally {
  await browser.close();
  server.close();
  server.closeAllConnections();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
