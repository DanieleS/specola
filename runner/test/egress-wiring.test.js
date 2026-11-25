// Secrets and the egress proxy as page code sees them (docs/page-backends.md,
// "Secrets (step 3)" and "Egress proxy (step 3)"): ctx.secrets, and the
// global fetch of a real worker going through a real proxy instance. The
// proxy's rules themselves are egress.test.js's; here, that the runner
// wires every worker to it with its own page's list. Loopback servers are
// reached through the proxy's test seams (lookup, forbidden, portAllowed).

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { forbiddenAddress } from '../src/egress.js';
import { backend, backendWith, logText, startRunner, until } from './helpers.js';

describe('ctx.secrets', () => {
  let r;
  before(async () => {
    r = await startRunner();
  });
  after(() => r.close());

  const source = `export default {
    fetch(request, ctx) {
      let threw = false;
      try { ctx.secrets.API_KEY = 'changed'; } catch { threw = true; }
      return Response.json({ secrets: ctx.secrets, frozen: Object.isFrozen(ctx.secrets), threw });
    },
  }`;

  test('only the declared names, frozen, as sent with each call', async () => {
    const v = r.publish(backendWith({ secrets: ['API_KEY', 'OTHER'] }, source));
    const res = await r.invoke({ ...v, page: 'sec-1', secrets: { API_KEY: 'k1', NOT_DECLARED: 'x' } });
    assert.deepEqual(await res.json(), { secrets: { API_KEY: 'k1' }, frozen: true, threw: true });
    // The owner set another one (and changed the first): the next call has them.
    const res2 = await r.invoke({ ...v, page: 'sec-1', secrets: { API_KEY: 'k2', OTHER: 'o' } });
    assert.deepEqual((await res2.json()).secrets, { API_KEY: 'k2', OTHER: 'o' });
  });

  test('a version that declares none gets none', async () => {
    const v = r.publish(backend(source));
    const res = await r.invoke({ ...v, page: 'sec-2', secrets: { API_KEY: 'k1' } });
    assert.deepEqual((await res.json()).secrets, {});
  });
});

describe('the egress proxy', () => {
  let r;
  let upstream;
  let port;
  const seen = [];

  before(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, url: req.url, auth: req.headers['proxy-authorization'] });
      res.end(`upstream ${req.headers.host} ${req.url}`);
    });
    await new Promise((res) => upstream.listen(0, '127.0.0.1', res));
    port = upstream.address().port;
    r = await startRunner(
      { idleMs: 60_000 },
      {
        egress: {
          // Every name is the loopback server, which the proxy may reach
          // here only: without the seams it would refuse it (loopback, and
          // a port other than 80/443).
          lookup: async (host) => (host.endsWith('.test') ? [{ address: '127.0.0.1', family: 4 }] : Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }))),
          forbidden: (a) => (a === '127.0.0.1' ? null : forbiddenAddress(a)),
          portAllowed: () => true,
        },
      },
    );
  });
  after(async () => {
    await r.close();
    await new Promise((res) => upstream.close(res));
  });

  // A backend that fetches ?url= and says what happened, and shows its env.
  const fetcher = backend(`export default {
    async fetch(request) {
      const u = new URL(request.url);
      if (u.pathname === '/env') return Response.json(process.env);
      try {
        const res = await fetch(u.searchParams.get('url'));
        return new Response(res.status + ' ' + (await res.text()));
      } catch (err) {
        return new Response('failed: ' + (err.cause?.message ?? err.message));
      }
    },
  }`);

  const call = async (v, page, url) => (await r.invoke({ ...v, page, path: `/?url=${encodeURIComponent(url)}`, egress: ['allowed.test', '*.wild.test'] })).text();

  test("the worker's environment points fetch at the proxy, and nothing else of the runner's", async () => {
    const v = r.publish(fetcher);
    const env = await (await r.invoke({ ...v, page: 'eg-1', path: '/env' })).json();
    const proxyPort = (await r.runner.egress()).port;
    assert.equal(env.NODE_USE_ENV_PROXY, '1');
    assert.equal(env.NO_PROXY, '');
    assert.match(env.HTTPS_PROXY, new RegExp(`^http://w-\\d+:[0-9a-f]{48}@127\\.0\\.0\\.1:${proxyPort}$`));
    assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
    assert.deepEqual(Object.keys(env).sort(), ['HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'NODE_ENV', 'NODE_USE_ENV_PROXY', 'NO_PROXY', 'TZ']);
  });

  test('an allowed host is reached through the proxy', async () => {
    const v = r.publish(fetcher);
    assert.equal(await call(v, 'eg-2', `http://allowed.test:${port}/x?y=1`), `200 upstream allowed.test:${port} /x?y=1`);
    assert.equal(await call(v, 'eg-2', `http://a.b.wild.test:${port}/`), `200 upstream a.b.wild.test:${port} /`);
    // The proxy's credential never reaches the upstream.
    assert.ok(seen.every((s) => s.auth === undefined));
    // No warning about the experimental proxy agent in the log.
    assert.doesNotMatch(await logText(r, 'eg-2'), /EnvHttpProxyAgent|UNDICI/);
  });

  test('other hosts, IP literals and localhost are refused, and the log says so', async () => {
    const v = r.publish(fetcher);
    const before = seen.length;
    assert.match(await call(v, 'eg-3', `http://wild.test:${port}/`), /^(failed: |403 )/);
    assert.match(await call(v, 'eg-3', `http://other.test:${port}/`), /^(failed: |403 )/);
    assert.match(await call(v, 'eg-3', `http://127.0.0.1:${port}/`), /^(failed: |403 )/);
    // NO_PROXY is empty: localhost goes to the proxy too, which refuses it.
    assert.match(await call(v, 'eg-3', `http://localhost:${port}/`), /^(failed: |403 )/);
    assert.equal(seen.length, before, 'nothing reached the upstream');
    const log = await logText(r, 'eg-3');
    assert.match(log, new RegExp(`\\[warn\\] egress refused: wild\\.test:${port} \\(not in the backend's egress list\\)`));
    assert.match(log, new RegExp(`\\[warn\\] egress refused: other\\.test:${port} \\(not in the backend's egress list\\)`));
    assert.match(log, new RegExp(`\\[warn\\] egress refused: 127\\.0\\.0\\.1:${port} \\(IP addresses are not allowed\\)`));
    assert.match(log, new RegExp(`\\[warn\\] egress refused: localhost:${port} \\(not in the backend's egress list\\)`));
  });

  test("each worker gets its own page's list", async () => {
    const v = r.publish(fetcher);
    // eg-4's version allows nothing: the same host eg-2 reaches is refused.
    const res = await r.invoke({ ...v, page: 'eg-4', path: `/?url=${encodeURIComponent(`http://allowed.test:${port}/`)}`, egress: [] });
    assert.match(await res.text(), /^(failed: |403 )/);
    assert.match(await logText(r, 'eg-4'), /egress refused: allowed\.test:\d+ \(not in the backend's egress list\)/);
    assert.doesNotMatch(await logText(r, 'eg-2'), /egress refused/);
  });

  test("a stopped worker's credential no longer works", async () => {
    const v = r.publish(fetcher);
    const env = await (await r.invoke({ ...v, page: 'eg-5', path: '/env', egress: ['allowed.test'] })).json();
    const proxy = new URL(env.HTTP_PROXY);
    const viaProxy = () =>
      new Promise((resolve, reject) => {
        const req = http.request({
          host: proxy.hostname,
          port: proxy.port,
          method: 'GET',
          path: `http://allowed.test:${port}/direct`,
          headers: { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${proxy.password}`).toString('base64')}` },
        });
        req.on('response', (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
    assert.equal(await viaProxy(), 200);
    // A purge stops the worker.
    assert.equal((await r.api('DELETE', '/pages/eg-5')).status, 204);
    await until(async () => (await viaProxy()) === 407);
  });
});
