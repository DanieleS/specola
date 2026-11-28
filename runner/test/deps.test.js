// Backend dependencies (deps.js, docs/page-backends.md "Dependencies"):
// installed per (dependencies, platform, ABI), resolved by name from the
// bundle, and only the versions that have some may load addons. A fake
// pnpm (fixtures/fake-pnpm.mjs) keeps these tests off the network; the last
// one runs the real pnpm with better-sqlite3 when RUNNER_TEST_PNPM=1.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOKEN, backendWith, logText, startRunner, until } from './helpers.js';

const FAKE_PNPM = fileURLToPath(new URL('./fixtures/fake-pnpm.mjs', import.meta.url));

const SOURCE = `
import a from 'dep-a';
import sub from 'dep-a/sub';
import scoped from '@scope/dep-b';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
export default {
  async fetch(request, ctx) {
    const file = path.join(ctx.dataDir, 'note.txt');
    writeFileSync(file, 'hi');
    return Response.json({ a, sub, scoped, note: readFileSync(file, 'utf8'), dataDir: ctx.dataDir, addons: process.execArgv.includes('--allow-addons') });
  },
};`;

const PLAIN = `export default { fetch: () => Response.json({ addons: process.execArgv.includes('--allow-addons') }) };`;

const DEPS = { 'dep-a': '1.0.0', '@scope/dep-b': '2.0.0-rc.1' };

async function installs(r) {
  try {
    const text = await fs.readFile(path.join(r.dataDir, 'deps', 'installs.log'), 'utf8');
    return text.trim().split('\n').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('dependencies with a fake pnpm', () => {
  let r;
  const env = { PATH: process.env.PATH, SPECOLA_RUNNER_TOKEN: TOKEN };
  before(async () => {
    r = await startRunner({ firstByteMs: 1500 }, { deps: { pnpm: FAKE_PNPM, env } });
  });
  after(() => r.close());

  test('are installed once, resolved by name, and the worker may load addons', async () => {
    const v = r.publish(backendWith({ dependencies: DEPS }, SOURCE));
    const [res1, res2] = await Promise.all([r.invoke({ page: 'p1', ...v }), r.invoke({ page: 'p1', ...v })]);
    assert.equal(res1.status, 200, await res1.clone().text());
    assert.equal(res2.status, 200);
    const body = await res1.json();
    assert.deepEqual(body.a, { name: 'dep-a', version: '1.0.0' });
    assert.equal(body.sub, 'sub of dep-a');
    assert.deepEqual(body.scoped, { name: '@scope/dep-b', version: '2.0.0-rc.1' });
    assert.equal(body.note, 'hi');
    assert.equal(body.dataDir, path.join(r.dataDir, 'pages', 'p1', 'data'));
    assert.equal(body.addons, true);

    // Another page with the same dependencies shares the install.
    const v2 = r.publish(backendWith({ dependencies: { '@scope/dep-b': '2.0.0-rc.1', 'dep-a': '1.0.0' } }, SOURCE));
    assert.equal((await r.invoke({ page: 'p2', ...v2 })).status, 200);
    const runs = await installs(r);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].dependencies, DEPS);
    assert.ok(runs[0].args.includes('--config.dangerously-allow-all-builds=true'));
    assert.equal(runs[0].token, null, 'the runner token never reaches pnpm');
    assert.equal(runs[0].home, path.join(r.dataDir, 'deps', '.home'));
    assert.match(await logText(r, 'p1'), /installing dependencies dep-a@1\.0\.0, @scope\/dep-b@2\.0\.0-rc\.1 for [a-z0-9-]+, Node .* \(ABI \d+\)…[\s\S]*dependencies installed in/);
  });

  test('a backend without dependencies keeps addons off', async () => {
    const v = r.publish(backendWith({}, PLAIN));
    const res = await r.invoke({ page: 'p3', ...v });
    assert.deepEqual(await res.json(), { addons: false });
  });

  test('a long install answers 503 and goes on for the next call', async () => {
    env.npm_config_fake_delay_ms = '2500';
    try {
      const v = r.publish(backendWith({ dependencies: { 'dep-slow': '1.0.0' } }, `import s from 'dep-slow'; export default { fetch: () => Response.json(s) };`));
      const res = await r.invoke({ page: 'p4', ...v });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('x-specola-error'), 'backend-unavailable');
      assert.match((await res.json()).message, /dependencies are being installed/);
      await until(async () => (await logText(r, 'p4')).includes('dependencies installed'));
      const ok = await r.invoke({ page: 'p4', ...v });
      assert.deepEqual(await ok.json(), { name: 'dep-slow', version: '1.0.0' });
    } finally {
      delete env.npm_config_fake_delay_ms;
    }
  });

  test('a failed install is reported and remembered', async () => {
    env.npm_config_fake_fail = '1';
    try {
      const v = r.publish(backendWith({ dependencies: { 'dep-missing': '9.9.9' } }, PLAIN));
      const res = await r.invoke({ page: 'p5', ...v });
      assert.equal(res.status, 500);
      assert.match((await res.json()).message, /Installing the backend's dependencies failed \(exit 1\)/);
      assert.match(await logText(r, 'p5'), /installing dep-missing@9\.9\.9 failed \(exit 1\):\nERR_PNPM_FETCH_404/);
      delete env.npm_config_fake_fail;
      // Not tried again at once: no install storm from a page that fails.
      assert.equal((await r.invoke({ page: 'p5', ...v })).status, 500);
      assert.equal((await installs(r)).filter((i) => i.dependencies['dep-missing']).length, 0);
    } finally {
      delete env.npm_config_fake_fail;
    }
  });

  test('health says how dependencies are installed', async () => {
    const res = await fetch(`${r.url}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const { dependencies } = await res.json();
    assert.equal(dependencies.enabled, true);
    assert.equal(dependencies.abi, process.versions.modules);
    assert.match(dependencies.platform, new RegExp(`^${process.platform}-${process.arch}`));
  });
});

test('with RUNNER_DEPS=off a backend with dependencies answers an error', async () => {
  const r = await startRunner({}, { deps: { enabled: false } });
  try {
    const v = r.publish(backendWith({ dependencies: DEPS }, SOURCE));
    const res = await r.invoke(v);
    assert.equal(res.status, 500);
    assert.match((await res.json()).message, /does not install backend dependencies \(RUNNER_DEPS=off\)/);
  } finally {
    await r.close();
  }
});

test('the real pnpm installs better-sqlite3, which the backend loads', { skip: process.env.RUNNER_TEST_PNPM !== '1' && 'set RUNNER_TEST_PNPM=1 (needs pnpm and the npm registry)' }, async () => {
  const r = await startRunner({ firstByteMs: 120_000, requestMs: 180_000 }, { deps: { env: process.env } });
  try {
    const v = r.publish(
      backendWith(
        { dependencies: { 'better-sqlite3': '12.4.1' } },
        `import Database from 'better-sqlite3';
         import path from 'node:path';
         export default {
           fetch(request, ctx) {
             const db = new Database(path.join(ctx.dataDir, 'app.db'));
             db.exec('CREATE TABLE IF NOT EXISTS t (n INTEGER)');
             db.prepare('INSERT INTO t VALUES (?)').run(1);
             const row = db.prepare('SELECT count(*) AS n, sqlite_version() AS v FROM t').get();
             db.close();
             return Response.json(row);
           },
         };`,
      ),
    );
    const res = await r.invoke(v);
    const text = await res.text();
    assert.equal(res.status, 200, `${text}\n${await logText(r)}`);
    assert.equal(JSON.parse(text).n, 1);
    assert.equal((await (await r.invoke(v)).json()).n, 2);
  } finally {
    await r.close();
  }
});
