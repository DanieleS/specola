// Runs the specola-publish CLI against an in-process fake of the server side
// of the upload protocol (docs/spa-bundles.md, "Upload protocol").

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS, bundleProblems, compareVersions } from '../lib/rules.js';
import { BACKEND_DISABLED, PublishError, publish } from '../lib/publish.js';
import { VERSION } from '../lib/version.js';

const bin = fileURLToPath(new URL('../bin/specola-publish.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixture', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'specola-publish-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * A fake Specola: one grant per token, a blob store, and knobs to make it
 * misbehave. Records every request in `calls`.
 */
async function fakeServer({ grant = {}, haveBlobs = [], status = 200, failPutOnce = new Set(), rejectManifest, loseBlobs = false, dropCommitOnce = false } = {}) {
  const state = { calls: [], blobs: new Map(haveBlobs.map((b) => [sha256(b), Buffer.from(b)])), manifest: null, commit: null, puts: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    state.calls.push(`${req.method} ${req.url}`);
    const send = (code, payload) => {
      if (payload === undefined) return res.writeHead(code).end();
      if (typeof payload === 'string') return res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }).end(payload + '\n');
      res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
    };
    const m = /^\/upload\/bundle\/([^/]+)(\/.*)?$/.exec(req.url);
    if (!m || m[1] !== 'tok123456789') return send(404, 'not found');
    if (status === 410 || state.used) return send(410, 'grant already used or expired');
    const rest = m[2] ?? '';
    const g = {
      kind: 'new',
      title: 'Demo',
      expiresAt: '2030-01-01T00:00:00Z',
      limits: { ...DEFAULT_LIMITS },
      minPluginVersion: '1.0.0',
      ...grant,
    };
    if (req.method === 'GET' && rest === '') return send(200, g);
    if (req.method === 'POST' && rest === '/manifest') {
      const mf = JSON.parse(body);
      if (rejectManifest) return send(400, rejectManifest);
      if (compareVersions(mf.pluginVersion, g.minPluginVersion) < 0) return send(400, 'plugin too old');
      const problems = bundleProblems(mf.files.map((f) => ({ path: f.path, size: f.size })), g.limits);
      if (problems.length) return send(400, problems.join('; '));
      state.manifest = mf;
      return send(200, { missing: [...new Set(mf.files.map((f) => f.sha256))].filter((h) => !state.blobs.has(h)) });
    }
    const blob = /^\/blobs\/([0-9a-f]{64})$/.exec(rest);
    if (req.method === 'PUT' && blob) {
      if (failPutOnce.delete(blob[1])) return send(503, 'try later');
      const entry = state.manifest?.files.find((f) => f.sha256 === blob[1]);
      if (!entry || sha256(body) !== blob[1] || body.length !== entry.size) return send(400, 'blob does not match the manifest');
      state.puts.push(blob[1]);
      if (!loseBlobs) state.blobs.set(blob[1], body);
      return send(204);
    }
    if (req.method === 'POST' && rest === '/commit') {
      const missing = state.manifest.files.map((f) => f.sha256).filter((h) => !state.blobs.has(h));
      if (missing.length) return send(409, { missing });
      state.commit = JSON.parse(body);
      state.used = true;
      // The commit happens, but the answer never reaches the client.
      if (dropCommitOnce) return res.socket.destroy();
      return send(201, { id: 'page-1', version: 3, url: 'http://specola.test/#/p/page-1' });
    }
    send(405, 'method not allowed');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/upload/bundle/tok123456789`;
  return { state, url, close: () => new Promise((r) => server.close(r)) };
}

/** Runs the CLI, resolving with its exit code and output. */
function run(args, { cwd = scratch } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env, SPECOLA_PUBLISH_RETRY_MS: '5' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Writes a built-looking bundle into a fresh directory. */
function makeDist(name, files) {
  const dir = join(scratch, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const INDEX = '<!doctype html><meta name="generator" content="specola-vite-plugin/1.0.0"><script type="module" src="__SPECOLA_BASE__/assets/a.js"></script>';
const distFiles = {
  'index.html': INDEX,
  'assets/a.js': 'console.log("a")',
  'assets/b.css': 'body{color:red}',
  'assets/c.js': 'console.log("c")',
  'assets/copy-of-c.js': 'console.log("c")',
  'assets/sub/d.bin': Buffer.from([0, 1, 2, 255]),
  '.DS_Store': 'junk',
  'assets/Thumbs.db': 'junk',
  '__MACOSX/assets/._a.js': 'junk',
  '.git/HEAD': 'ref: refs/heads/main',
};

test('uploads only the missing blobs, retries a 503 and commits with the note', async () => {
  const dist = makeDist('ok', distFiles);
  const srv = await fakeServer({ haveBlobs: ['console.log("a")'], failPutOnce: new Set([sha256('body{color:red}')]) });
  try {
    const r = await run(['--upload', srv.url, '--dir', dist, '--no-build', '--note', 'Add the chart']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { id: 'page-1', version: 3, url: 'http://specola.test/#/p/page-1' });

    const mf = srv.state.manifest;
    assert.equal(mf.pluginVersion, VERSION);
    assert.deepEqual(
      mf.files.map((f) => f.path),
      ['assets/a.js', 'assets/b.css', 'assets/c.js', 'assets/copy-of-c.js', 'assets/sub/d.bin', 'index.html'],
      'junk is not uploaded',
    );
    for (const f of mf.files) {
      const content = distFiles[f.path];
      assert.equal(f.sha256, sha256(content), f.path);
      assert.equal(f.size, Buffer.byteLength(content), f.path);
    }

    const expectPuts = ['index.html', 'assets/b.css', 'assets/c.js', 'assets/sub/d.bin'].map((p) => sha256(distFiles[p]));
    assert.deepEqual([...srv.state.puts].sort(), expectPuts.sort(), 'each missing blob once, the known one not at all');
    assert.equal(srv.state.calls.filter((c) => c.includes(sha256('body{color:red}'))).length, 2, 'the 503 was retried');
    assert.match(r.stderr, /503.*retrying/);
    assert.deepEqual(srv.state.commit, { note: 'Add the chart' });
    assert.equal(srv.state.calls[0], 'GET /upload/bundle/tok123456789');
  } finally {
    await srv.close();
  }
});

test('commit without --note sends no note', async () => {
  const dist = makeDist('nonote', { 'index.html': INDEX });
  const srv = await fakeServer();
  try {
    const r = await run([`--upload=${srv.url}/`, `--dir=${dist}`, '--no-build']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(srv.state.commit, {});
  } finally {
    await srv.close();
  }
});

test('a used or expired upload link fails with a clear message', async () => {
  const dist = makeDist('gone', { 'index.html': INDEX });
  const srv = await fakeServer({ status: 410 });
  try {
    const r = await run(['--upload', srv.url, '--dir', dist, '--no-build']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /410 Gone — grant already used or expired/);
    assert.match(r.stderr, /already used or has expired: create a new one with the MCP tool create_bundle_upload/);
    assert.deepEqual(srv.state.calls, ['GET /upload/bundle/tok123456789'], 'stops before building or uploading');
  } finally {
    await srv.close();
  }
});

test('an unknown upload link fails with a clear message', async () => {
  const srv = await fakeServer();
  try {
    const r = await run(['--upload', srv.url.replace('tok123456789', 'nope'), '--no-build']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /404 Not Found — not found\nThe upload link is unknown/);
  } finally {
    await srv.close();
  }
});

test('a plugin older than minPluginVersion is refused before building', async () => {
  const srv = await fakeServer({ grant: { minPluginVersion: '99.0.0' } });
  try {
    const r = await run(['--upload', srv.url]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(`needs @specola/vite-plugin 99.0.0 or newer, but ${VERSION} is installed`), r.stderr);
    assert.match(r.stderr, /npm i -D http:\/\/127\.0\.0\.1:\d+\/tools\/specola-vite-plugin-99\.0\.0\.tgz/);
  } finally {
    await srv.close();
  }
});

test('an invalid bundle is refused locally, with the grant limits', async () => {
  const dist = makeDist('bad', { 'index.html': INDEX, 'about.html': 'x', 'big.bin': Buffer.alloc(2048) });
  const srv = await fakeServer({ grant: { limits: { ...DEFAULT_LIMITS, maxFileBytes: 1024 } } });
  try {
    const r = await run(['--upload', srv.url, '--dir', dist, '--no-build']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"about.html": only index.html at the root may be HTML/);
    assert.match(r.stderr, /big.bin is 2 KiB \(max 1 KiB per file\)/);
    assert.equal(srv.state.manifest, null, 'nothing was sent');
  } finally {
    await srv.close();
  }
});

test('a missing output directory and server errors are reported', async () => {
  const srv = await fakeServer();
  try {
    let r = await run(['--upload', srv.url, '--dir', join(scratch, 'nothing-here'), '--no-build']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing-here does not exist: did the build write somewhere else\? Pass it with --dir/);

    // The server refuses the manifest: its plain-text error is shown.
    const dist = makeDist('refused', { 'index.html': INDEX, 'a.js': 'x' });
    const refusing = await fakeServer({ rejectManifest: 'plugin 1.0.0 is too old: run npm i -D …' });
    try {
      r = await run(['--upload', refusing.url, '--dir', dist, '--no-build']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /POST http:\/\/127\.0\.0\.1:\d+\/upload\/bundle\/tok123…\/manifest: 400 Bad Request — plugin 1\.0\.0 is too old/);
    } finally {
      await refusing.close();
    }

    // Commit answers 409 with the blobs it still misses.
    const forgetful = await fakeServer({ loseBlobs: true });
    try {
      r = await run(['--upload', forgetful.url, '--dir', dist, '--no-build']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`409 Conflict — the server is still missing 2 file\\(s\\): (${sha256('x')}|${sha256(INDEX)})`));
    } finally {
      await forgetful.close();
    }

    r = await run(['--upload', 'ftp://x', '--no-build']);
    assert.match(r.stderr, /--upload must be an http\(s\) URL/);
    r = await run(['--bogus']);
    assert.match(r.stderr, /unknown argument "--bogus"/);
  } finally {
    await srv.close();
  }
});

test('network errors are retried, then reported', async () => {
  const srv = await fakeServer();
  const url = srv.url;
  await srv.close(); // nothing listens there any more
  const r = await run(['--upload', url, '--no-build']);
  assert.equal(r.code, 1);
  assert.equal((r.stderr.match(/retrying in/g) ?? []).length, 4);
  assert.match(r.stderr, /failed after 5 attempts: fetch failed/);
});

test('builds the project with vite, then publishes it', async () => {
  const srv = await fakeServer();
  const outDir = join(fixture, 'dist');
  try {
    const r = await run(['--upload', srv.url, '--note', 'built'], { cwd: fixture });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /built in/, 'vite output goes to stderr');
    assert.equal(JSON.parse(r.stdout).version, 3);
    const paths = srv.state.manifest.files.map((f) => f.path);
    assert.ok(paths.includes('index.html') && paths.includes('favicon.svg') && paths.some((p) => /^assets\/worker-/.test(p)), paths.join(', '));
    assert.equal(srv.state.commit.note, 'built');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    await srv.close();
  }
});

test('only a bundle upload link is accepted', async () => {
  for (const bad of ['http://specola.test/upload/tok123456789', 'http://specola.test/view/abc', 'http://specola.test/upload/bundle/tok?x=1']) {
    const r = await run(['--upload', bad, '--no-build']);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /--upload must be a bundle upload link \(…\/upload\/bundle\/<token>\)/, bad);
  }
});

test('symbolic links are followed only inside the output directory', async () => {
  const outside = makeDist('secrets', { 'id_rsa': 'PRIVATE KEY' });
  const srv = await fakeServer();
  try {
    const leaky = makeDist('leaky', { 'index.html': INDEX });
    symlinkSync(outside, join(leaky, 'assets'));
    let r = await run(['--upload', srv.url, '--dir', leaky, '--no-build']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /assets is a symbolic link to .*secrets, outside/);
    assert.equal(srv.state.manifest, null, 'nothing was sent');

    const loop = makeDist('loop', { 'index.html': INDEX, 'assets/a.js': 'a' });
    symlinkSync('..', join(loop, 'assets', 'up'));
    r = await run(['--upload', srv.url, '--dir', loop, '--no-build']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /assets\/up is a symbolic link that loops back to \./);

    const broken = makeDist('broken', { 'index.html': INDEX });
    symlinkSync(join(broken, 'nowhere.js'), join(broken, 'gone.js'));
    r = await run(['--upload', srv.url, '--dir', broken, '--no-build']);
    assert.match(r.stderr, /gone.js is a broken symbolic link/);

    const linked = makeDist('linked', { 'index.html': INDEX, 'real/a.js': 'a' });
    symlinkSync('real', join(linked, 'alias'));
    r = await run(['--upload', srv.url, '--dir', linked, '--no-build']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(srv.state.manifest.files.map((f) => f.path), ['alias/a.js', 'index.html', 'real/a.js']);
  } finally {
    await srv.close();
  }
});

test('a commit whose answer was lost is not reported as an expired link', async () => {
  const dist = makeDist('dropped', { 'index.html': INDEX });
  const srv = await fakeServer({ dropCommitOnce: true });
  try {
    const r = await run(['--upload', srv.url, '--dir', dist, '--no-build']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /retrying/);
    assert.match(r.stderr, /the commit most likely went through/);
    assert.doesNotMatch(r.stderr, /has expired/);
  } finally {
    await srv.close();
  }
});

test('a project without vite gets a clear message instead of npx', async () => {
  const srv = await fakeServer();
  try {
    const r = await run(['--upload', srv.url], { cwd: makeDist('novite', { 'package.json': '{}' }) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /vite is not installed in .*novite: run specola-publish from the Vite project's directory/);
  } finally {
    await srv.close();
  }
});

test('a file that changes after hashing is not uploaded', async () => {
  const dist = makeDist('changing', { 'index.html': INDEX, 'a.js': 'before' });
  const srv = await fakeServer();
  try {
    // Rewrite a.js between the manifest and the uploads, as a build still
    // running in watch mode would.
    const fetchFn = async (url, init) => {
      const res = await fetch(url, init);
      if (String(url).endsWith('/manifest')) writeFileSync(join(dist, 'a.js'), 'after');
      return res;
    };
    await assert.rejects(
      publish({ upload: srv.url, dir: dist, build: false }, { fetch: fetchFn, log: () => {} }),
      (err) => err instanceof PublishError && /a\.js changed while it was being uploaded/.test(err.message),
    );
    assert.ok(!srv.state.puts.includes(sha256('after')) && !srv.state.puts.includes(sha256('before')));
    assert.equal(srv.state.commit, null);
  } finally {
    await srv.close();
  }
});

// Page backends (docs/page-backends.md): .specola/ travels as bundle files,
// and only to an instance that runs backends.
const MANIFEST = JSON.stringify({ version: 1, entry: 'server/index.mjs', public: [], egress: [], secrets: [], cron: [], topics: { public: [] } });
const backendDist = (name, extra = {}) =>
  makeDist(name, {
    'index.html': INDEX,
    '.specola/backend.json': MANIFEST,
    '.specola/server/index.mjs': 'export default { fetch: () => new Response("ok") };',
    ...extra,
  });

test('a bundle with a backend is uploaded, .specola/ included, where backends are enabled', async () => {
  const dist = backendDist('backend-ok');
  const srv = await fakeServer({ grant: { backend: { enabled: true, available: false } } });
  try {
    const r = await run(['--upload', srv.url, '--dir', dist, '--no-build']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(srv.state.manifest.files.map((f) => f.path), ['.specola/backend.json', '.specola/server/index.mjs', 'index.html']);
    assert.match(r.stderr, /warning: the backend runner is not answering right now/);
  } finally {
    await srv.close();
  }
});

test('a bundle with a backend is refused before uploading where backends are off', async () => {
  const dist = backendDist('backend-off');
  // An older Specola says nothing about backends: it can't run one either.
  for (const grant of [{ backend: { enabled: false, available: false } }, {}]) {
    const srv = await fakeServer({ grant });
    try {
      const r = await run(['--upload', srv.url, '--dir', dist, '--no-build']);
      assert.equal(r.code, 1, JSON.stringify(grant));
      assert.ok(r.stderr.includes(BACKEND_DISABLED), r.stderr);
      assert.match(r.stderr, /it has no backend runner/);
      assert.deepEqual(srv.state.calls, ['GET /upload/bundle/tok123456789'], 'nothing was sent');
    } finally {
      await srv.close();
    }
  }
  // A static bundle is not affected.
  const srv = await fakeServer({ grant: { backend: { enabled: false, available: false } } });
  try {
    const r = await run(['--upload', srv.url, '--dir', makeDist('static-off', { 'index.html': INDEX }), '--no-build']);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await srv.close();
  }
});

test('a backend bundle is checked like the server checks it', async () => {
  const srv = await fakeServer({ grant: { backend: { enabled: true, available: true } } });
  try {
    let r = await run(['--upload', srv.url, '--dir', backendDist('bad-manifest', { '.specola/backend.json': '{"version":1,"secrets":["x"]}' }), '--no-build']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\.specola\/backend\.json: "secrets"\[0\] "x": a name is an upper-case letter/);

    r = await run(['--upload', srv.url, '--dir', makeDist('no-manifest', { 'index.html': INDEX, '.specola/server/index.mjs': 'x' }), '--no-build']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /files under \.specola\/ need a \.specola\/backend\.json describing the backend/);
    assert.equal(srv.state.manifest, null, 'nothing was sent');
  } finally {
    await srv.close();
  }
});

test("the server's JSON errors are shown with their message", async () => {
  const dist = backendDist('server-refuses');
  const srv = await fakeServer({
    grant: { backend: { enabled: true, available: true } },
    rejectManifest: { error: 'backend-disabled', message: 'page backends are not enabled on this Specola instance' },
  });
  try {
    const r = await run(['--upload', srv.url, '--dir', dist, '--no-build']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /400 Bad Request — page backends are not enabled on this Specola instance/);
  } finally {
    await srv.close();
  }
});

test('builds a project with a backend, then publishes it', async () => {
  const project = fileURLToPath(new URL('./fixture-backend', import.meta.url));
  const srv = await fakeServer({ grant: { backend: { enabled: true, available: true } } });
  try {
    const r = await run(['--upload', srv.url], { cwd: project });
    assert.equal(r.code, 0, r.stderr);
    const paths = srv.state.manifest.files.map((f) => f.path);
    assert.ok(paths.includes('.specola/backend.json') && paths.includes('.specola/server/index.mjs') && paths.includes('index.html'), paths.join(', '));
  } finally {
    rmSync(join(project, 'dist'), { recursive: true, force: true });
    await srv.close();
  }
});
