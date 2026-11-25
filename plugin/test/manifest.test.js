// The backend manifest checks (lib/manifest.js), which must say what the
// server says (internal/backend/manifest.go) about the same manifest.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { resolveBackend } from '../lib/backend.js';
import { ManifestError, validateManifest } from '../lib/manifest.js';
import { bundleProblems, isJunk } from '../lib/rules.js';

const files = ['index.html', '.specola/backend.json', '.specola/server/index.mjs'];
const check = (m, f = files) => validateManifest(typeof m === 'string' ? m : JSON.stringify(m), f);

test('a minimal manifest is normalised with every field', () => {
  assert.deepEqual(check({ version: 1 }), {
    version: 1,
    entry: 'server/index.mjs',
    public: [],
    egress: [],
    secrets: [],
    cron: [],
    topics: { public: [] },
  });
});

test('a full manifest is normalised as the server stores it', () => {
  const m = check({
    version: 1,
    entry: 'server/index.mjs',
    public: ['get /api/stats', 'POST /api/votes', 'GET /api/public/*', 'GET /'],
    egress: ['API.OpenAI.com', '*.googleapis.com', 'example.org:443'],
    secrets: ['OPENAI_API_KEY'],
    cron: [{ name: 'nightly', schedule: '0  3 * *   *' }, { name: 'weekly', schedule: '*/15 1-5 1,15 jan-mar MON-FRI' }],
    topics: { public: ['scoreboard'] },
  });
  assert.deepEqual(m.public, ['GET /api/stats', 'POST /api/votes', 'GET /api/public/*', 'GET /']);
  assert.deepEqual(m.egress, ['api.openai.com', '*.googleapis.com', 'example.org:443']);
  assert.deepEqual(m.cron, [
    { name: 'nightly', schedule: '0 3 * * *' },
    { name: 'weekly', schedule: '*/15 1-5 1,15 jan-mar MON-FRI' },
  ]);
  assert.deepEqual(m.topics, { public: ['scoreboard'] });
  // null lists are defaults, as in Go.
  assert.deepEqual(check({ version: 1, public: null, topics: null }).public, []);
});

test('invalid manifests are refused with the server messages', () => {
  const cases = [
    ['{', /^\.specola\/backend\.json: not a valid manifest: /],
    ['[]', /not a valid manifest/],
    [{ version: 1, extra: true }, /not a valid manifest: json: unknown field "extra"/],
    [{}, /"version" must be 1$/],
    [{ version: 2 }, /"version" must be 1$/],
    [{ version: 1, entry: '' }, /"entry" is empty/],
    [{ version: 1, entry: '/server/index.mjs' }, /"entry" "\/server\/index.mjs" must be relative to \.specola\/, e\.g\. "server\/index\.mjs"/],
    [{ version: 1, entry: '.specola/server/index.mjs' }, /must be relative to \.specola\//],
    [{ version: 1, entry: 'server/../x.mjs' }, /has an empty, "\." or "\.\." segment/],
    [{ version: 1, entry: 'server/index.ts' }, /must end in \.mjs or \.js/],
    [{ version: 1, entry: 'other.mjs' }, /"entry" "other\.mjs" is not in the bundle \(expected \.specola\/other\.mjs\)/],
    [{ version: 1, public: ['GET'] }, /"public"\[0\] "GET": must be "METHOD \/path"/],
    [{ version: 1, public: ['FETCH /x'] }, /method must be one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS/],
    [{ version: 1, public: ['GET x'] }, /the path must start with \//],
    [{ version: 1, public: ['GET /x?y'] }, /can't have a query, a fragment or spaces/],
    [{ version: 1, public: ['GET /a//b'] }, /empty, "\." or "\.\." segment/],
    [{ version: 1, public: ['GET /a/*/b'] }, /\* may only be the whole last segment/],
    [{ version: 1, public: ['GET /a*'] }, /\* may only be the whole last segment/],
    [{ version: 1, public: ['GET /a', 'get /a'] }, /"public"\[1\] "get \/a" is listed twice/],
    [{ version: 1, public: [1] }, /not a valid manifest: "public" must be a list of strings/],
    [{ version: 1, egress: ['10.0.0.1'] }, /"egress"\[0\] "10\.0\.0\.1": IP addresses are not allowed, only host names/],
    [{ version: 1, egress: ['[::1]:443'] }, /IP addresses are not allowed/],
    [{ version: 1, egress: ['0x7f.1'] }, /IP addresses are not allowed/],
    [{ version: 1, egress: ['example.com:8080'] }, /the only ports allowed are 443 and 80/],
    [{ version: 1, egress: ['a.*.com'] }, /not a host name \(letters, digits and -/],
    [{ version: 1, egress: [''] }, /"egress"\[0\] "": not a host name$/],
    [{ version: 1, egress: ['a.com', 'A.com'] }, /"egress"\[1\] "A\.com" is listed twice/],
    [{ version: 1, secrets: ['lower'] }, /"secrets"\[0\] "lower": a name is an upper-case letter/],
    [{ version: 1, secrets: ['A', 'A'] }, /"secrets"\[1\] "A" is listed twice/],
    [{ version: 1, cron: Array.from({ length: 11 }, (_, i) => ({ name: `j${i}`, schedule: '* * * * *' })) }, /"cron" can have at most 10 jobs/],
    [{ version: 1, cron: [{ name: '-x', schedule: '* * * * *' }] }, /"cron"\[0\]\.name "-x": 1 to 64 letters/],
    [{ version: 1, cron: [{ name: 'a', schedule: '* * * * *' }, { name: 'a', schedule: '* * * * *' }] }, /"cron"\[1\]\.name "a" is used twice/],
    [{ version: 1, cron: [{ name: 'a', schedule: '* * * *' }] }, /must have 5 fields/],
    [{ version: 1, cron: [{ name: 'a', schedule: '60 * * * *' }] }, /minute field "60": "60" is not a value from 0 to 59/],
    [{ version: 1, cron: [{ name: 'a', schedule: '*/0 * * * *' }] }, /step "0" must be a number from 1 to 60/],
    [{ version: 1, cron: [{ name: 'a', schedule: '5/2 * * * *' }] }, /a step needs \* or a range before it/],
    [{ version: 1, cron: [{ name: 'a', schedule: '* 5-1 * * *' }] }, /range "5-1" goes backwards/],
    [{ version: 1, cron: [{ name: 'a', schedule: '* * * foo *' }] }, /month field "foo": "foo" is not a value from 1 to 12/],
    [{ version: 1, cron: [{ name: 'a', schedule: '* * * * *', at: 1 }] }, /json: unknown field "at"/],
    [{ version: 1, topics: { private: [] } }, /"topics" must be \{"public": \[\.\.\.\]\}: json: unknown field "private"/],
    [{ version: 1, topics: { public: ['bad topic'] } }, /"topics\.public"\[0\] "bad topic": 1 to 128 letters/],
    [{ version: 1, topics: { public: ['a', 'a'] } }, /"topics\.public"\[1\] "a" is listed twice/],
    [{ version: 1, public: Array.from({ length: 101 }, (_, i) => `GET /r${i}`) }, /"public" can list at most 100 routes/],
    [JSON.stringify({ version: 1, secrets: [] }) + ' '.repeat(64 * 1024), /larger than 65536 bytes/],
  ];
  for (const [m, re] of cases) {
    assert.throws(() => check(m), (err) => err instanceof ManifestError && re.test(err.message), JSON.stringify(m).slice(0, 100));
  }
});

test('.specola/ is uploaded like any bundle path, and needs the manifest', () => {
  assert.equal(isJunk('.specola/backend.json'), false);
  assert.equal(isJunk('.specola/server/index.mjs'), false);
  const base = [{ path: 'index.html', size: 10 }];
  assert.deepEqual(bundleProblems([...base, { path: '.specola/backend.json', size: 10 }, { path: '.specola/server/index.mjs', size: 10 }]), []);
  assert.deepEqual(bundleProblems([...base, { path: '.specola/server/index.mjs', size: 10 }]), [
    'files under .specola/ need a .specola/backend.json describing the backend',
  ]);
  assert.deepEqual(bundleProblems([...base, { path: '.specola/backend.json', size: 70000 }]), ['.specola/backend.json can be at most 65536 bytes']);
  assert.match(bundleProblems([...base, { path: '.specola/../x', size: 1 }]).join(), /"\.\." segment/);
});

const scratch = mkdtempSync(join(tmpdir(), 'specola-manifest-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A project directory with a server entry, and the config resolveBackend reads. */
function project(name, { manifestFile } = {}) {
  const root = join(scratch, name);
  mkdirSync(join(root, 'server'), { recursive: true });
  writeFileSync(join(root, 'server', 'index.ts'), 'export default {}');
  if (manifestFile !== undefined) writeFileSync(join(root, 'specola.backend.json'), manifestFile);
  return { root, configFile: join(root, 'vite.config.js') };
}

test('the backend comes from the options or specola.backend.json, never both', () => {
  const plain = project('plain');
  assert.equal(resolveBackend({}, plain), null, 'no server option: no backend, as before');

  const b = resolveBackend({ server: 'server/index.ts', backend: { secrets: ['KEY'], public: ['get /x'] } }, plain);
  assert.equal(b.entry, join(plain.root, 'server', 'index.ts'));
  assert.deepEqual(b.manifest.secrets, ['KEY']);
  assert.deepEqual(b.manifest.public, ['GET /x']);
  assert.equal(b.manifest.entry, 'server/index.mjs');
  assert.deepEqual(resolveBackend({ server: 'server/index.ts' }, plain).manifest.public, []);

  const filed = project('filed', { manifestFile: JSON.stringify({ egress: ['api.example.com'] }) });
  assert.deepEqual(resolveBackend({ server: 'server/index.ts' }, filed).manifest.egress, ['api.example.com']);
  assert.throws(
    () => resolveBackend({ server: 'server/index.ts', backend: {} }, filed),
    /given twice, by the backend option of specola\(\) and by .*specola\.backend\.json: keep one/,
  );
  assert.throws(() => resolveBackend({}, filed), /specola\.backend\.json describes a backend, but specola\(\) has no server option/);
  assert.throws(() => resolveBackend({ backend: {} }, plain), /the backend option needs a server option too/);
  assert.throws(() => resolveBackend({ server: 'server/nope.ts' }, plain), /the server entry server\/nope\.ts does not exist/);
  assert.throws(() => resolveBackend({ server: 'server/index.ts', backend: { entry: 'x.mjs' } }, plain), /"entry" is set by the plugin/);
  assert.throws(
    () => resolveBackend({ server: 'server/index.ts', backend: { secrets: ['bad'] } }, plain),
    /the backend option: \.specola\/backend\.json: "secrets"\[0\] "bad"/,
  );
  assert.throws(() => resolveBackend({ server: 'server/index.ts', backend: { version: 2 } }, plain), /"version" must be 1/);
  const broken = project('broken', { manifestFile: '{' });
  assert.throws(() => resolveBackend({ server: 'server/index.ts' }, broken), /specola\.backend\.json is not valid JSON/);
});
