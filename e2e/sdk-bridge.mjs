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
//   right reason;
// - specola.subscribe, against a fake parent that records the port: one sub
//   per topic however many subscribe, unsub after the last, subscriptions
//   made before the port wait for it, events reach every callback even when
//   one throws, bad topics and callbacks are a TypeError;
// - the viewer's push stream (pagedata.ts), against a fake
//   /api/pages/{id}/events: one EventSource for the frame's topics, opened
//   once for a burst of subscriptions, reopened when the set changes,
//   closed when it empties or the frame goes; superseded tells the viewer
//   and forbidden stops it; a stream refused for good is not retried, one
//   that fails for a while is;
// - the public-link shell (internal/server/publicshell.html), served with
//   its CSP by a fake /s/{token} and /p/{token}/…: it frames the page in the
//   viewer's sandbox, hands the port once with the boot data's backend
//   state and no localStorage data, relays calls to /p/{token}/x/… without
//   cookies (streaming, abort, headers, version, dot segments), pushes from
//   /p/{token}/events, and shows its notice on superseded.
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
const shell = readFileSync(join(root, 'internal/server/publicshell.html'), 'utf8');
// The shell's own CSP, as publicshell.go sends it (docs/page-backends.md,
// "Public links (step 6)").
const SHELL_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; style-src 'unsafe-inline'";
// JSON as Go's json.Marshal writes it into the shell: <, > and & escaped.
const goJSON = (v) => JSON.stringify(v).replace(/[<>&]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

// The event streams opened, in order: {where, v, topics, res, open}.
const streams = [];
let flaky = 0;
const sse = (st, event, data) => st.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
async function until(cond, what, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  console.log(`  (timed out waiting for ${what})`);
  return false;
}

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
  ${url.searchParams.has('sub') ? 'window.earlyGot = []; window.earlyUnsub = specola.subscribe("early", (d, t) => window.earlyGot.push([t, d]));' : ''}
</script><body>frame</body>`);
    return;
  }
  if (url.pathname === '/fakeparent.html') {
    // A parent that hands the port and records what the frame sends on it.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><script>
  window.portLog = [];
  addEventListener('message', (e) => {
    if (!e.data || e.data.specola !== 'hello' || window.port) return;
    const ch = new MessageChannel();
    window.port = ch.port1;
    ch.port1.onmessage = (m) => window.portLog.push(m.data);
    // Late, so subscriptions made at start are queued first.
    setTimeout(() => e.source.postMessage({ specola: 'port', backend: { enabled: true, available: true } }, '*', [ch.port2]), 150);
  });
  window.sendEvent = (topic, data) => window.port.postMessage({ op: 'event', topic, data });
</script><body><iframe sandbox="allow-scripts" name="fake" src="/frame.html?sub=1"></iframe></body>`);
    return;
  }
  if (url.pathname === '/s/tok' || url.pathname.startsWith('/s/tok/')) {
    if (url.pathname.startsWith('/s/tok/~page')) {
      const boot = { base: '', basename: '/s/tok/~page', backend: true };
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset="utf-8"><script>${sdkFor(boot)}</script>
<script>
  window.early = specola.backend;
  window.earlyCall = specola.fetch("/echo?early=1").then((r) => r.json(), (e) => ({ name: e.name, reason: e.reason, message: e.message }));
</script><body>public frame</body>`);
      return;
    }
    // As internal/server/publicshell.go serves it.
    const rest = url.pathname.slice('/s/tok'.length);
    const boot = { token: 'tok', version: 3, backend: { enabled: true, available: true }, pageSrc: '/s/tok/~page' + rest + url.search };
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': SHELL_CSP,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(shell.replace('SPECOLA_SHELL_BOOT', () => goJSON(boot)));
    return;
  }
  const ev = /^\/(?:api\/pages\/p1|p\/tok)\/events$/.exec(url.pathname);
  if (ev) {
    const st = { where: url.pathname, v: url.searchParams.get('v'), topics: url.searchParams.getAll('topic'), res, open: true };
    streams.push(st);
    if (st.topics.includes('denied')) {
      st.open = false;
      return specolaError(res, 403, 'forbidden', 'you can no longer see this page');
    }
    if (st.topics.includes('flaky') && ++flaky <= 2) {
      // The stream, then the shell's question about it: a proxy's error.
      st.open = false;
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('bad gateway');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write(': open\n\n');
    req.on('close', () => (st.open = false));
    return;
  }
  if (url.pathname === '/api/pages/p1/secret') {
    seen.secret++;
    res.end('secret');
    return;
  }
  const m = /^\/(?:api\/pages\/p1|p\/tok)\/x(\/.*)$/.exec(url.pathname);
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
        cookie: req.headers.cookie ?? null,
        where: url.pathname.split('/x/')[0],
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
  // The old document is marked: until the reload replaces it, it still
  // answers (with its own earlyCall), and then its context goes away under
  // whatever was reading it. So wait for an unmarked document, and retry
  // the read too.
  await again.evaluate(() => {
    window.beforeReload = true;
    location.reload();
  });
  let againErr;
  for (let i = 0; i < 100 && !againErr; i++) {
    try {
      const reloaded = page.frames().find((x) => x.name() === 'again');
      await reloaded.waitForFunction(() => !window.beforeReload && window.earlyCall, null, { timeout: 200 });
      againErr = await reloaded.evaluate(() => window.earlyCall);
    } catch {}
  }
  check(againErr?.name === 'BackendUnavailable' && againErr.reason === 'unavailable', 'a second hello is refused: BackendUnavailable (unavailable)', againErr);

  // specola.subscribe, over a fake parent that records the port.
  {
    const fp = await context.newPage();
    fp.on('pageerror', (e) => console.log('  page error:', e.message));
    await fp.goto(origin + '/fakeparent.html');
    let ff;
    for (let i = 0; i < 100 && !ff; i++) {
      ff = fp.frames().find((x) => x.name() === 'fake');
      if (!ff) await fp.waitForTimeout(20);
    }
    await ff.waitForFunction(() => window.earlyUnsub);
    await fp.waitForFunction(() => window.portLog.some((m) => m.op === 'sub'));
    const ops = () => fp.evaluate(() => window.portLog.filter((m) => m.op === 'sub' || m.op === 'unsub'));
    check(JSON.stringify(await ops()) === '[{"op":"sub","topic":"early"}]', 'a subscription made before the port arrives is sent once it does', await ops());
    await fp.evaluate(() => window.sendEvent('early', { n: 1 }));
    await ff.waitForFunction(() => window.earlyGot.length > 0);
    check(JSON.stringify(await ff.evaluate(() => window.earlyGot)) === '[["early",{"n":1}]]', 'an event reaches the callback as (data, topic)');

    await ff.evaluate(() => {
      window.got = { a1: [], a2: [], b: [] };
      window.errors = [];
      addEventListener('error', (e) => {
        window.errors.push(String(e.error && e.error.message));
        e.preventDefault();
      });
      window.unA0 = specola.subscribe('orders/a', () => {
        throw new Error('callback broke');
      });
      window.unA1 = specola.subscribe('orders/a', (d) => window.got.a1.push(d));
      window.unA2 = specola.subscribe('orders/a', (d) => window.got.a2.push(d));
      window.unB = specola.subscribe('b:1', (d) => window.got.b.push(d));
    });
    await fp.waitForTimeout(100);
    check(
      JSON.stringify(await ops()) === JSON.stringify([{ op: 'sub', topic: 'early' }, { op: 'sub', topic: 'orders/a' }, { op: 'sub', topic: 'b:1' }]),
      'several subscriptions to a topic share one sub',
      await ops(),
    );
    await fp.evaluate(() => {
      window.sendEvent('orders/a', { added: 1 });
      window.sendEvent('nobody', 1);
      window.sendEvent('b:1', 'x');
    });
    await ff.waitForFunction(() => window.got.b.length === 1);
    const got = await ff.evaluate(() => ({ got: window.got, errors: window.errors }));
    check(
      JSON.stringify(got.got) === JSON.stringify({ a1: [{ added: 1 }], a2: [{ added: 1 }], b: ['x'] }),
      "every subscriber gets the event, even after one throws; other topics' don't",
      got.got,
    );
    check(got.errors.length === 1 && got.errors[0] === 'callback broke', 'a throwing callback is reported as uncaught', got.errors);

    await ff.evaluate(() => {
      window.unA0();
      window.unA1();
      window.unA1();
    });
    await fp.waitForTimeout(100);
    check(!(await ops()).some((m) => m.op === 'unsub'), 'no unsub while a subscription to the topic is left');
    await fp.evaluate(() => window.sendEvent('orders/a', 2));
    await ff.waitForFunction(() => window.got.a2.length === 2);
    check(JSON.stringify(await ff.evaluate(() => window.got.a1)) === '[{"added":1}]', 'an unsubscribed callback gets no more events');
    await ff.evaluate(() => {
      window.unA2();
      window.unA2();
      window.unB();
      window.earlyUnsub();
    });
    await fp.waitForTimeout(100);
    const unsubs = (await ops()).filter((m) => m.op === 'unsub').map((m) => m.topic);
    check(JSON.stringify(unsubs) === '["orders/a","b:1","early"]', 'unsub after the last subscription, once', unsubs);
    await fp.evaluate(() => window.sendEvent('orders/a', 3));
    await fp.waitForTimeout(100);
    check((await ff.evaluate(() => window.got.a2.length)) === 2, 'nothing after unsubscribing');

    const invalid = await ff.evaluate(() => {
      const out = [];
      for (const [t, f] of [
        ['', () => {}],
        ['has space', () => {}],
        ['x'.repeat(129), () => {}],
        [42, () => {}],
        ['ok', null],
      ]) {
        try {
          specola.subscribe(t, f);
          out.push('ok');
        } catch (e) {
          out.push(e.name);
        }
      }
      const uns = [];
      try {
        for (let i = 0; i < 21; i++) uns.push(specola.subscribe('t' + i, () => {}));
        out.push('21 topics');
      } catch (e) {
        out.push(e.name + ' at ' + uns.length);
      }
      uns.forEach((u) => u());
      // Again a topic of those 20: the room freed is taken.
      try {
        specola.subscribe('t0', () => {})();
        out.push('ok');
      } catch (e) {
        out.push(e.name);
      }
      return out;
    });
    check(
      JSON.stringify(invalid) === JSON.stringify(['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError at 20', 'ok']),
      'a bad topic or callback, or a 21st topic, is a TypeError',
      invalid,
    );
    await fp.close();
  }

  // The viewer's push stream (pagedata.ts), against a fake events endpoint.
  {
    const before = streams.length;
    const pf = await frame('push');
    await pf.evaluate(() => {
      window.pushed = [];
      window.uns = {};
      for (const t of ['a', 'b', 'c']) window.uns[t] = specola.subscribe(t, (d, topic) => window.pushed.push([topic, d]));
    });
    await until(() => streams.length > before, 'the stream');
    await page.waitForTimeout(250);
    let mine = streams.slice(before);
    check(
      mine.length === 1 && mine[0].v === '3' && JSON.stringify(mine[0].topics) === '["a","b","c"]',
      'a burst of subscriptions opens one stream, for the version shown and every topic',
      mine.map((x) => ({ v: x.v, topics: x.topics })),
    );
    const s1 = mine[0];
    sse(s1, 'message', { topic: 'b', data: { hi: 1 } });
    sse(s1, 'message', { topic: 'zzz', data: 0 });
    sse(s1, 'message', { topic: 'a', data: [1, 2] });
    await pf.waitForFunction(() => window.pushed.length >= 2);
    await page.waitForTimeout(100);
    check(JSON.stringify(await pf.evaluate(() => window.pushed)) === '[["b",{"hi":1}],["a",[1,2]]]', 'events reach the page, only on its topics');

    await pf.evaluate(() => window.uns.c());
    await until(() => streams.length > before + 1 && !s1.open, 'the reopened stream');
    mine = streams.slice(before);
    check(mine.length === 2 && JSON.stringify(mine[1].topics) === '["a","b"]' && !s1.open, 'unsubscribing reopens the stream without the topic', mine.map((x) => x.topics));
    await pf.evaluate(() => {
      window.uns.d = specola.subscribe('d', () => {});
      window.uns.d();
    });
    await page.waitForTimeout(300);
    check(streams.length === before + 2, 'a change undone within the debounce reopens nothing');
    await pf.evaluate(() => {
      window.uns.a();
      window.uns.b();
    });
    await until(() => !mine[1].open, 'the stream to close');
    await page.waitForTimeout(200);
    check(!mine[1].open && streams.length === before + 2, 'the stream closes when no topic is left');

    // superseded: the viewer is told, and the stream stays closed.
    await pf.evaluate(() => (window.uns.s = specola.subscribe('s', () => {})));
    await until(() => streams.length > before + 2, 'the stream');
    const s3 = streams[streams.length - 1];
    sse(s3, 'superseded', {});
    s3.res.end();
    await until(async () => (await page.evaluate(() => window.superseded.push)) === 1, 'superseded');
    await pf.evaluate(() => specola.subscribe('later', () => {}));
    await page.waitForTimeout(500);
    check(
      (await page.evaluate(() => window.superseded.push)) === 1 && streams.length === before + 3,
      'superseded tells the viewer, and no stream opens again',
    );

    // forbidden: stops, without the reload notice.
    const n0 = streams.length;
    const ff2 = await frame('forbid');
    await ff2.evaluate(() => specola.subscribe('f', () => {}));
    await until(() => streams.length > n0, 'the stream');
    const s4 = streams[streams.length - 1];
    sse(s4, 'forbidden', {});
    s4.res.end();
    await page.waitForTimeout(300);
    await ff2.evaluate(() => specola.subscribe('f2', () => {}));
    await page.waitForTimeout(500);
    check(streams.length === n0 + 1 && (await page.evaluate(() => window.superseded.forbid)) === 0, 'forbidden stops the stream for good');

    // A stream refused for good is asked about once, then left; one that
    // fails for a while is tried again.
    const n1 = streams.length;
    const fd = await frame('denied');
    await fd.evaluate(() => specola.subscribe('denied', () => {}));
    await page.waitForTimeout(2500);
    check(streams.length === n1 + 2, 'a stream answered 403 forbidden is not retried (the stream, then one question)', streams.length - n1);
    const n2 = streams.length;
    const fl = await frame('flaky');
    await fl.evaluate(() => {
      window.pushed = [];
      specola.subscribe('flaky', (d) => window.pushed.push(d));
    });
    await until(() => streams.slice(n2).some((st) => st.open), 'the stream to be retried', 5000);
    const ok = streams.slice(n2).find((st) => st.open);
    check(!!ok && streams.length - n2 === 3, 'a stream that failed with a 502 is retried', streams.length - n2);
    if (ok) {
      sse(ok, 'message', { topic: 'flaky', data: 'back' });
      await fl.waitForFunction(() => window.pushed.length === 1);
      check(true, 'and its events arrive');
      await page.evaluate(() => window.stops.flaky());
      await until(() => !ok.open, 'the stream to close');
      check(!ok.open, 'the frame going closes its stream');
    }
  }

  // The public-link shell, as Specola serves it, against fake /p/tok routes.
  {
    await context.addCookies([{ name: 'session', value: 'secret-session', url: origin }]);
    const sp = await context.newPage();
    const cspErrors = [];
    sp.on('console', (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) cspErrors.push(m.text());
    });
    sp.on('pageerror', (e) => console.log('  shell page error:', e.message));
    await sp.goto(origin + '/s/tok/deep/path?q=1');
    let pfr;
    for (let i = 0; i < 100 && !pfr; i++) {
      pfr = sp.frames().find((x) => x.url().includes('/~page'));
      if (!pfr) await sp.waitForTimeout(20);
    }
    await pfr.waitForFunction(() => window.earlyCall);
    check(new URL(pfr.url()).pathname + new URL(pfr.url()).search === '/s/tok/~page/deep/path?q=1', 'the shell frames the page at ~page, keeping the path and query', pfr.url());
    check((await pfr.evaluate(() => self.origin)) === 'null', 'the framed page runs on an opaque origin');
    const attrs = await sp.evaluate(() => {
      const f = document.querySelector('iframe');
      const r = f.getBoundingClientRect();
      return { sandbox: f.getAttribute('sandbox'), full: r.width === innerWidth && r.height === innerHeight, name: f.name };
    });
    check(
      attrs.sandbox === 'allow-scripts allow-popups allow-forms allow-modals' && attrs.full && attrs.name === '',
      "the frame has the viewer's sandbox, fills the window and gets no localStorage data",
      attrs,
    );
    check(
      JSON.stringify(await pfr.evaluate(() => specola.backend)) === '{"enabled":true,"available":true}' &&
        (await pfr.evaluate(() => specola.persistent)) === false,
      "specola.backend is the boot data's; localStorage stays in memory",
    );
    const pe = await pfr.evaluate(() => window.earlyCall);
    check(pe.method === 'GET' && pe.query === '?early=1' && pe.where === '/p/tok', 'a call made before the port goes to /p/{token}/x', pe);
    const pecho = await pfr.evaluate(async () => (await specola.fetch('/echo?x=2', { method: 'POST', headers: { 'X-Custom': 'pub' }, body: 'hi' })).json());
    check(
      pecho.version === '3' && pecho.custom === 'pub' && pecho.text === 'hi' && pecho.cookie === null &&
        JSON.stringify(pecho.listed) === JSON.stringify([['content-type', 'text/plain;charset=UTF-8'], ['x-custom', 'pub']]),
      'calls carry X-Specola-Version, X-Specola-Headers and the body, and no cookie',
      pecho,
    );
    gate('stream');
    gate('stream2');
    await pfr.evaluate(() => {
      window.got = [];
      window.streamDone = (async () => {
        const r = await specola.fetch('/stream');
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return 'done';
          window.got.push(dec.decode(value));
        }
      })();
    });
    await pfr.waitForFunction(() => window.got.join('') === 'one;');
    openGate('stream');
    openGate('stream2');
    check((await pfr.evaluate(() => window.streamDone)) === 'done' && (await pfr.evaluate(() => window.got.join(''))) === 'one;two;three', 'answers stream through the shell');
    seen.closed.delete('/nohead');
    const pab = await pfr.evaluate(async () => {
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
    await sp.waitForTimeout(300);
    check(pab === 'AbortError' && seen.closed.has('/nohead'), "abort reaches the shell's request", pab);
    seen.paths.length = 0;
    await pfr.evaluate(() => specola.fetch('/../../events?x=1'));
    check(seen.paths.length === 1 && seen.paths[0] === '/events?x=1', "dot segments can't leave /p/{token}/x", seen.paths);
    const perr = await pfr.evaluate(async () => {
      try {
        await specola.fetch('/unavailable');
      } catch (e) {
        return { name: e.name, reason: e.reason };
      }
    });
    check(perr?.name === 'BackendUnavailable' && perr.reason === 'unavailable', 'backend-unavailable: BackendUnavailable', perr);
    check(await sp.evaluate(() => document.getElementById('notice').hidden), 'no notice so far');

    // Pushes, from /p/tok/events.
    const n3 = streams.length;
    await pfr.evaluate(() => {
      window.pushed = [];
      specola.subscribe('pub/1', (d, t) => window.pushed.push([t, d]));
      specola.subscribe('pub/2', (d, t) => window.pushed.push([t, d]));
    });
    await until(() => streams.length > n3, 'the public stream');
    await sp.waitForTimeout(250);
    const ps = streams.slice(n3);
    check(
      ps.length === 1 && ps[0].where === '/p/tok/events' && ps[0].v === '3' && JSON.stringify(ps[0].topics) === '["pub/1","pub/2"]',
      'subscriptions open one stream on /p/{token}/events',
      ps.map((x) => ({ where: x.where, v: x.v, topics: x.topics })),
    );
    sse(ps[0], 'message', { topic: 'pub/2', data: { n: 2 } });
    await pfr.waitForFunction(() => window.pushed.length === 1);
    check(JSON.stringify(await pfr.evaluate(() => window.pushed)) === '[["pub/2",{"n":2}]]', 'events reach the page through the shell');

    // Superseded: the call rejects, the notice offers a reload.
    const psup = await pfr.evaluate(async () => {
      try {
        await specola.fetch('/superseded');
      } catch (e) {
        return { name: e.name, reason: e.reason };
      }
    });
    check(psup?.name === 'BackendUnavailable' && psup.reason === 'superseded', 'superseded: BackendUnavailable (superseded)', psup);
    const note = await sp.evaluate(() => {
      const n = document.getElementById('notice');
      return { hidden: n.hidden, text: n.textContent, reload: !n.querySelector('.reload').hidden };
    });
    check(!note.hidden && /new version is available/i.test(note.text) && note.reload, 'superseded shows the reload notice', note);
    check(cspErrors.length === 0, "the shell runs under its own CSP", cspErrors);

    // One port per load: the frame reloading itself is refused. As above,
    // the old document is marked (it has an earlyCall of its own, a
    // successful one) and the read is retried, its context going away under
    // it while the reload replaces it.
    await pfr.evaluate(() => {
      window.beforeReload = true;
      location.reload();
    });
    let reErr;
    for (let i = 0; i < 100 && !reErr; i++) {
      try {
        const again2 = sp.frames().find((x) => x.url().includes('/~page'));
        await again2.waitForFunction(() => !window.beforeReload && window.earlyCall, null, { timeout: 200 });
        reErr = await again2.evaluate(() => window.earlyCall);
      } catch {}
    }
    check(reErr?.name === 'BackendUnavailable' && reErr.reason === 'unavailable', 'the shell refuses a second hello', reErr);
    await sp.close();
  }
} finally {
  await browser.close();
  server.close();
  server.closeAllConnections();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
