// The egress proxy (docs/page-backends.md, "Egress proxy (step 3)"): the
// address and host rules, and the proxy itself against local servers. Tests
// reach loopback servers through the lookup/forbidden/portAllowed seams;
// without them the same servers are refused.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { forbiddenAddress, hostAllowed, normalizeHost, parseEgress, startEgressProxy } from '../src/egress.js';

describe('forbiddenAddress', () => {
  const cases = {
    // Public.
    '8.8.8.8': null,
    '93.184.216.34': null,
    '172.32.0.1': null,
    '100.128.0.1': null,
    '2606:4700:4700::1111': null,
    '::ffff:8.8.8.8': null,
    '2002:0808:0808::1': null,
    '64:ff9b::808:808': null,
    // IPv4.
    '0.0.0.0': 'unspecified',
    '10.1.2.3': 'private',
    '172.16.0.1': 'private',
    '172.31.255.255': 'private',
    '192.168.1.1': 'private',
    '127.0.0.1': 'loopback',
    '127.255.255.254': 'loopback',
    '169.254.1.1': 'link-local',
    '169.254.169.254': 'metadata',
    '100.64.0.1': 'CGNAT',
    '100.127.255.255': 'CGNAT',
    '224.0.0.1': 'multicast',
    '239.255.255.250': 'multicast',
    '255.255.255.255': 'reserved',
    // IPv6.
    '::': 'unspecified',
    '::1': 'loopback',
    '0:0:0:0:0:0:0:1': 'loopback',
    'fc00::1': 'ULA',
    'fd12:3456::1': 'ULA',
    'fe80::1': 'link-local',
    'fe80::1%eth0': 'link-local',
    'ff02::1': 'multicast',
    // IPv4 inside IPv6.
    '::ffff:10.0.0.1': 'IPv4-mapped private',
    '::ffff:127.0.0.1': 'IPv4-mapped loopback',
    '::ffff:7f00:1': 'IPv4-mapped loopback',
    '::FFFF:169.254.169.254': 'IPv4-mapped metadata',
    '::127.0.0.1': 'IPv4-mapped loopback',
    '64:ff9b::10.0.0.1': 'NAT64 private',
    '64:ff9b:1::1': 'NAT64 local-use',
    '2002:0a00:0001::1': '6to4 private',
    '2002:7f00:1::': '6to4 loopback',
    // Teredo: client 192.0.2.45 inverted in the last 32 bits.
    '2001:0:4136:e378:8000:63bf:3fff:fdd2': 'Teredo reserved',
    // Teredo whose server is private.
    '2001:0:a00:1::1': 'Teredo private',
    // Not addresses at all.
    garbage: 'not an IP address',
    '1.2.3': 'not an IP address',
    '256.1.1.1': 'not an IP address',
    '1::2::3': 'not an IP address',
  };
  for (const [addr, want] of Object.entries(cases)) {
    test(`${addr} → ${want}`, () => assert.equal(forbiddenAddress(addr), want));
  }
});

describe('host rules', () => {
  test('normalizeHost', () => {
    assert.deepEqual(normalizeHost('API.Example.COM.'), { name: 'api.example.com' });
    for (const ip of ['127.0.0.1', '[::1]', '::1', '127.1', '0x7f000001', '2130706433', 'a.0x7f']) {
      assert.equal(normalizeHost(ip).error, 'IP addresses are not allowed', ip);
    }
    for (const bad of ['', '.', 'a..b', '-a.com', 'a b.com', 'a/b']) {
      assert.equal(normalizeHost(bad).error, 'not a host name', bad);
    }
  });

  test('exact names, wildcards and ports', () => {
    const rules = parseEgress(['api.openai.com', '*.googleapis.com', 'secure.example:443', 'plain.example:80', 'bad:8080']);
    assert.equal(rules.length, 4);
    const ok = (h, p = 443) => hostAllowed(rules, normalizeHost(h).name, p);
    assert.ok(ok('api.openai.com'));
    assert.ok(ok('API.OPENAI.COM.'));
    assert.ok(ok('api.openai.com', 80));
    assert.ok(!ok('openai.com'));
    assert.ok(!ok('x.api.openai.com'));
    assert.ok(!ok('evilapi.openai.com'));
    // *. matches one or more labels below, never the suffix itself.
    assert.ok(ok('storage.googleapis.com'));
    assert.ok(ok('a.b.googleapis.com'));
    assert.ok(!ok('googleapis.com'));
    assert.ok(!ok('evilgoogleapis.com'));
    assert.ok(!ok('googleapis.com.evil.com'));
    // An entry's port is the only one it allows.
    assert.ok(ok('secure.example', 443));
    assert.ok(!ok('secure.example', 80));
    assert.ok(ok('plain.example', 80));
    assert.ok(!ok('plain.example', 443));
  });
});

// --- the proxy --------------------------------------------------------------------

/** A TCP echo server that echoes until the client half-closes, then says bye and ends. */
async function echoServer() {
  const seen = [];
  const server = net.createServer({ allowHalfOpen: true }, (s) => {
    seen.push(s.remoteAddress);
    s.on('data', (d) => s.write(d));
    s.on('end', () => s.end('bye'));
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

/** An HTTP server that answers what it got. */
async function httpServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/slow') return; // never answers
      res.setHeader('X-Upstream', 'yes');
      res.setHeader('Set-Cookie', ['a=1', 'b=2']);
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body, remote: req.socket.remotePort }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

const basic = (c) => 'Basic ' + Buffer.from(`${c.user}:${c.token}`).toString('base64');

/** Sends a CONNECT; resolves {status, head, socket} once the proxy's answer head is in. */
function connect(proxyPort, target, auth) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    socket.setEncoding('utf8');
    let buf = '';
    const onData = (d) => {
      buf += d;
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const head = buf.slice(0, end);
      const rest = buf.slice(end + 4);
      resolve({ status: Number(head.split(' ')[1]), head, rest, socket });
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
  });
}

/** Reads the rest of a socket until it ends. */
function readAll(socket, already = '') {
  return new Promise((resolve) => {
    let buf = already;
    socket.on('data', (d) => (buf += d));
    socket.on('end', () => resolve(buf));
    socket.on('close', () => resolve(buf));
  });
}

/** An absolute-URI request through the proxy. */
function viaProxy(proxyPort, url, { auth, method = 'GET', body, headers = {}, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method,
        path: url,
        agent,
        headers: { ...(auth ? { 'Proxy-Authorization': auth } : {}), ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('egress proxy', () => {
  let echo, web, logs, lookups, proxy, strict;
  // What the test lookup answers per name; "rebind.test" changes its mind.
  const answers = {
    'ok.test': [{ address: '127.0.0.1', family: 4 }],
    'sub.wild.test': [{ address: '127.0.0.1', family: 4 }],
    'private.test': [{ address: '10.0.0.5', family: 4 }],
    'mixed.test': [
      { address: '127.0.0.1', family: 4 },
      { address: '192.168.0.10', family: 4 },
    ],
    'mapped.test': [{ address: '::ffff:169.254.169.254', family: 6 }],
  };
  let rebinds = 0;
  async function lookup(name) {
    lookups.push(name);
    if (name === 'rebind.test') return rebinds++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '127.0.0.2', family: 4 }];
    const a = answers[name];
    if (!a) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return a;
  }
  // 127.0.0.1 stands for a public address; everything else follows the
  // real rules (so 127.0.0.2 is loopback, refused).
  const forbidden = (a) => (a === '127.0.0.1' ? null : forbiddenAddress(a));
  const EGRESS = ['ok.test', '*.wild.test', 'private.test', 'mixed.test', 'mapped.test', 'rebind.test', 'missing.test', 'closed.test'];

  before(async () => {
    echo = await echoServer();
    web = await httpServer();
    logs = [];
    lookups = [];
    const log = (pageId, level, text) => logs.push({ pageId, level, text });
    proxy = await startEgressProxy({ log, lookup, forbidden, portAllowed: () => true, idleTimeoutMs: 1000 });
    // The real port rules, and the real address rules.
    strict = await startEgressProxy({ log, lookup });
  });
  after(async () => {
    await proxy.close();
    await strict.close();
    await echo.close();
    await web.close();
  });

  test('a missing or wrong credential is 407', async () => {
    const c = proxy.register('a1', 'page-a', EGRESS);
    for (const auth of [undefined, 'Basic ' + Buffer.from(`${c.user}:nope`).toString('base64'), 'Basic ' + Buffer.from(`w-zz:${c.token}`).toString('base64'), 'Bearer x']) {
      const r = await connect(proxy.port, `ok.test:${echo.port}`, auth);
      assert.equal(r.status, 407, String(auth));
      assert.match(r.head, /Proxy-Authenticate: Basic/);
      r.socket.destroy();
      const h = await viaProxy(proxy.port, `http://ok.test:${web.port}/`, { auth });
      assert.equal(h.status, 407);
    }
    // After unregister the credential is dead.
    proxy.unregister('a1');
    const r = await connect(proxy.port, `ok.test:${echo.port}`, basic(c));
    assert.equal(r.status, 407);
    r.socket.destroy();
  });

  test('CONNECT tunnels both ways, with half-close', async () => {
    const c = proxy.register('t1', 'page-t', EGRESS);
    assert.equal(c.user, 'w-t1');
    const r = await connect(proxy.port, `OK.test.:${echo.port}`, basic(c));
    assert.equal(r.status, 200);
    const got = readAll(r.socket, r.rest);
    r.socket.write('ping ');
    r.socket.write('pong');
    // The client stops sending; the echo server still answers and ends.
    r.socket.end();
    assert.equal(await got, 'ping pongbye');
    assert.equal(echo.seen.at(-1), '127.0.0.1');
    proxy.unregister('t1');
  });

  test('CONNECT to a wildcard host', async () => {
    const c = proxy.register('t2', 'page-t', EGRESS);
    const r = await connect(proxy.port, `sub.wild.test:${echo.port}`, basic(c));
    assert.equal(r.status, 200);
    const got = readAll(r.socket, r.rest);
    r.socket.end('x');
    assert.equal(await got, 'xbye');
    const bare = await connect(proxy.port, `wild.test:${echo.port}`, basic(c));
    assert.equal(bare.status, 403);
    bare.socket.destroy();
  });

  test('refusals: 403, a one-line body and the backend log', async () => {
    const c = proxy.register('r1', 'page-r', EGRESS);
    const cases = [
      [`other.test:${echo.port}`, `egress refused: other.test:${echo.port} (not in the backend's egress list)`],
      [`private.test:${echo.port}`, `egress refused: private.test:${echo.port} (resolves to private address 10.0.0.5)`],
      // Any bad address refuses the name, even with a good one beside it.
      [`mixed.test:${echo.port}`, `egress refused: mixed.test:${echo.port} (resolves to private address 192.168.0.10)`],
      [`mapped.test:${echo.port}`, `egress refused: mapped.test:${echo.port} (resolves to IPv4-mapped metadata address ::ffff:169.254.169.254)`],
      [`127.0.0.1:${echo.port}`, `egress refused: 127.0.0.1:${echo.port} (IP addresses are not allowed)`],
      [`[::1]:${echo.port}`, `egress refused: [::1]:${echo.port} (IP addresses are not allowed)`],
    ];
    for (const [target, line] of cases) {
      logs.length = 0;
      const r = await connect(proxy.port, target, basic(c));
      assert.equal(r.status, 403, target);
      assert.equal(await readAll(r.socket, r.rest), line + '\n');
      assert.deepEqual(logs, [{ pageId: 'page-r', level: 'warn', text: line }]);
    }
    proxy.unregister('r1');
  });

  test('a name that does not resolve or a closed port is 502', async () => {
    const c = proxy.register('r2', 'page-r', EGRESS);
    let r = await connect(proxy.port, `missing.test:${echo.port}`, basic(c));
    assert.equal(r.status, 502);
    assert.match(await readAll(r.socket, r.rest), /could not resolve: ENOTFOUND/);
    answers['closed.test'] = [{ address: '127.0.0.1', family: 4 }];
    const closed = net.createServer();
    await new Promise((res) => closed.listen(0, '127.0.0.1', res));
    const port = closed.address().port;
    await new Promise((res) => closed.close(res));
    r = await connect(proxy.port, `closed.test:${port}`, basic(c));
    assert.equal(r.status, 502);
    assert.match(await readAll(r.socket, r.rest), /could not connect: ECONNREFUSED/);
  });

  test('the loopback allowance for tests: only listed names, only loopback, any port', async () => {
    const lb = await startEgressProxy({
      lookup: async (name) => (name === 'private.test' ? answers[name] : name === 'mixed6.test' ? [{ address: '::1', family: 6 }, { address: '10.0.0.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]),
      allowLoopbackForTests: true,
    });
    try {
      const c = lb.register('lb', 'page-lb', ['local.test', 'private.test', 'mixed6.test']);
      // A listed name that resolves to loopback: reached on its own port.
      const ok = await connect(lb.port, `local.test:${echo.port}`, basic(c));
      assert.equal(ok.status, 200);
      const got = readAll(ok.socket, ok.rest);
      ok.socket.end('hi');
      assert.equal(await got, 'hibye');
      // Everything else is still refused.
      for (const [target, why] of [
        [`other.test:${echo.port}`, /not in the backend's egress list/],
        [`private.test:${echo.port}`, /resolves to private address/],
        [`mixed6.test:${echo.port}`, /resolves to private address/],
        [`127.0.0.1:${echo.port}`, /IP addresses are not allowed/],
      ]) {
        const r = await connect(lb.port, target, basic(c));
        assert.equal(r.status, 403, target);
        assert.match(await readAll(r.socket, r.rest), why);
      }
    } finally {
      await lb.close();
    }
    // Without it, the real rules refuse loopback.
    const c = strict.register('lb2', 'page-lb', ['ok.test']);
    const r = await connect(strict.port, 'ok.test:443', basic(c));
    assert.equal(r.status, 403);
    assert.match(await readAll(r.socket, r.rest), /loopback/);
    strict.unregister('lb2');
  });

  test('DNS rebinding: each connection resolves once and connects to what was checked', async () => {
    const c = proxy.register('d1', 'page-d', EGRESS);
    lookups.length = 0;
    // First resolution: the "public" 127.0.0.1, which is where it goes.
    const r = await connect(proxy.port, `rebind.test:${echo.port}`, basic(c));
    assert.equal(r.status, 200);
    const got = readAll(r.socket, r.rest);
    r.socket.end('a');
    assert.equal(await got, 'abye');
    assert.deepEqual(lookups, ['rebind.test']);
    assert.equal(echo.seen.at(-1), '127.0.0.1');
    // The name now answers 127.0.0.2 (loopback): refused, never connected.
    const seen = echo.seen.length;
    const r2 = await connect(proxy.port, `rebind.test:${echo.port}`, basic(c));
    assert.equal(r2.status, 403);
    r2.socket.destroy();
    assert.deepEqual(lookups, ['rebind.test', 'rebind.test']);
    assert.equal(echo.seen.length, seen);
  });

  test('the idle timeout closes a quiet tunnel', async () => {
    const c = proxy.register('i1', 'page-i', EGRESS);
    const r = await connect(proxy.port, `ok.test:${echo.port}`, basic(c));
    assert.equal(r.status, 200);
    const start = Date.now();
    await readAll(r.socket, r.rest);
    assert.ok(Date.now() - start >= 900);
  });

  test('absolute-URI HTTP is forwarded, without proxy headers, with keep-alive', async () => {
    const c = proxy.register('h1', 'page-h', EGRESS);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const a = await viaProxy(proxy.port, `http://OK.test:${web.port}/path?q=1`, {
        auth: basic(c),
        method: 'POST',
        body: 'hello',
        headers: { 'Content-Type': 'text/plain', Host: 'evil.test', 'X-Remove-Me': '1', Connection: 'keep-alive, X-Remove-Me' },
        agent,
      });
      assert.equal(a.status, 200);
      assert.equal(a.headers['x-upstream'], 'yes');
      assert.deepEqual(a.headers['set-cookie'], ['a=1', 'b=2']);
      const seen = JSON.parse(a.text);
      assert.equal(seen.method, 'POST');
      assert.equal(seen.url, '/path?q=1');
      assert.equal(seen.body, 'hello');
      // The Host is the checked one; the proxy's own headers and the ones
      // Connection names stay behind.
      assert.equal(seen.headers.host, `ok.test:${web.port}`);
      assert.equal(seen.headers['proxy-authorization'], undefined);
      assert.equal(seen.headers['x-remove-me'], undefined);
      assert.equal(seen.headers['content-type'], 'text/plain');
      // A second request on the same client connection.
      const b = await viaProxy(proxy.port, `http://ok.test:${web.port}/again`, { auth: basic(c), agent });
      assert.equal(b.status, 200);
      assert.equal(JSON.parse(b.text).url, '/again');
    } finally {
      agent.destroy();
    }
  });

  test('absolute-URI refusals and bad requests', async () => {
    const c = proxy.register('h2', 'page-h', EGRESS);
    logs.length = 0;
    let r = await viaProxy(proxy.port, `http://private.test:${web.port}/`, { auth: basic(c) });
    assert.equal(r.status, 403);
    assert.equal(r.text, `egress refused: private.test:${web.port} (resolves to private address 10.0.0.5)\n`);
    assert.equal(logs.length, 1);
    r = await viaProxy(proxy.port, `https://ok.test/`, { auth: basic(c) });
    assert.equal(r.status, 400);
    r = await viaProxy(proxy.port, `/relative`, { auth: basic(c) });
    assert.equal(r.status, 400);
    r = await viaProxy(proxy.port, `http://127.0.0.1:${web.port}/`, { auth: basic(c) });
    assert.equal(r.status, 403);
    assert.match(r.text, /IP addresses are not allowed/);
  });

  test('an upstream that never answers times out with 504', async () => {
    const c = proxy.register('h3', 'page-h', EGRESS);
    const r = await viaProxy(proxy.port, `http://ok.test:${web.port}/slow`, { auth: basic(c) });
    assert.equal(r.status, 504);
  });

  test('the real port rules: CONNECT 443 or 80, plain HTTP 80, the entry port', async () => {
    const c = strict.register('p1', 'page-p', ['ok.test', 'only443.test:443']);
    const port8443 = await connect(strict.port, 'ok.test:8443', basic(c));
    assert.equal(port8443.status, 403);
    assert.match(await readAll(port8443.socket, port8443.rest), /port 8443 is not allowed/);
    const r80 = await connect(strict.port, 'only443.test:80', basic(c));
    assert.equal(r80.status, 403);
    assert.match(await readAll(r80.socket, r80.rest), /not in the backend's egress list/);
    const h = await viaProxy(strict.port, 'http://ok.test:8080/', { auth: basic(c) });
    assert.equal(h.status, 403);
    assert.match(h.text, /port 8080 is not allowed/);
    // ok.test resolves to 127.0.0.1, which the real rules refuse.
    const lo = await connect(strict.port, 'ok.test:443', basic(c));
    assert.equal(lo.status, 403);
    assert.match(await readAll(lo.socket, lo.rest), /resolves to loopback address 127\.0\.0\.1/);
  });

  test("a worker's fetch goes through the proxy (NODE_USE_ENV_PROXY)", async () => {
    const c = proxy.register('n1', 'page-n', EGRESS);
    const url = `http://${c.user}:${c.token}@127.0.0.1:${proxy.port}`;
    assert.equal(c.url, url);
    const code = `
      const show = (p) => p.then((r) => r.status + ' ' + (r.headers.get('x-upstream') ?? ''), (e) => 'error');
      Promise.all([
        show(fetch('http://ok.test:${web.port}/f')),
        show(fetch('http://other.test:${web.port}/f')),
      ]).then((r) => console.log(JSON.stringify(r)));`;
    const out = await new Promise((resolve, reject) =>
      execFile(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', '--disable-warning=UNDICI-EHPA', '-e', code],
        { env: { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: '' } },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      ),
    );
    const [ok, refused] = JSON.parse(out);
    assert.equal(ok, '200 yes');
    // undici tunnels http too; a refused CONNECT is a network error.
    assert.ok(refused === 'error' || refused.startsWith('403'), refused);
  });
});
