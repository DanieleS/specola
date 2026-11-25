// The egress proxy (docs/page-backends.md, "Runner" and "Egress proxy
// (step 3)"): page workers reach the internet only through it, with
// HTTP_PROXY/HTTPS_PROXY pointing here and a credential per worker that
// says which page, and so which `egress` list, a connection is for.
//
//   CONNECT host:443|80          a tunnel (HTTPS, or HTTP that the client
//                                 chose to tunnel, as undici does)
//   GET http://host[:80]/path    plain HTTP, forwarded
//
// The proxy resolves names itself and refuses a host when any of its
// addresses is loopback, private, link-local, CGNAT, ULA, multicast,
// unspecified or the metadata address, whatever the allowlist says: an
// allowed name must not lead into the runner's own network. It then
// connects to one of the addresses it checked, never resolving again, so a
// name that answers public then private (DNS rebinding) gets nowhere.
//
// Raw sockets (net, tls) bypass the proxy: this is a guard against
// accidents and SSRF through fetch, not a sandbox (Trust model).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';

const CONNECT_TIMEOUT_MS = 10_000;
// A tunnel or a forwarded request with no traffic either way for this long
// is closed: a stuck upstream must not hold sockets in the runner forever.
const IDLE_TIMEOUT_MS = 2 * 60_000;
const REALM = 'specola egress';

// Hop-by-hop headers (RFC 9110 7.6.1), plus the proxy's own: they describe
// the hop between the worker and the proxy, not the request.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// --- addresses ---------------------------------------------------------------

/** Parses a dotted IPv4 address into a 32-bit unsigned integer, or null. */
function parseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const b = Number(m[i]);
    if (b > 255) return null;
    n = n * 256 + b;
  }
  return n;
}

/** Parses an IPv6 address (with "::", an embedded dotted IPv4 and a zone) into 16 bytes, or null. */
function parseV6(s) {
  s = s.replace(/%.*$/, '');
  // An embedded dotted IPv4 (::ffff:10.0.0.1) becomes its two words.
  const dot = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dot) {
    const n = parseV4(dot[2]);
    if (n === null) return null;
    s = dot[1] + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (h) => (h === '' ? [] : h.split(':'));
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  for (const w of [...head, ...rest]) if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return null;
  const given = head.length + rest.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return null;
  const all = [...head, ...Array(8 - given).fill('0'), ...rest].map((w) => parseInt(w, 16));
  const bytes = new Uint8Array(16);
  all.forEach((w, i) => {
    bytes[2 * i] = w >> 8;
    bytes[2 * i + 1] = w & 0xff;
  });
  return bytes;
}

// [base, prefix length, reason]. The doc's list, plus the other ranges that
// are never a public internet host (reserved, benchmarking, documentation).
const V4_RANGES = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'CGNAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.169.254', 32, 'metadata'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'reserved'],
  ['203.0.113.0', 24, 'reserved'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
].map(([base, bits, reason]) => ({ base: parseV4(base), bits, reason }));

function forbiddenV4(n) {
  for (const r of V4_RANGES) {
    // Shifting by 32 is a no-op in JS: a /0 never appears here.
    if (n >>> (32 - r.bits) === r.base >>> (32 - r.bits)) return r.reason;
  }
  return null;
}

const v4At = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const zero = (b, from, to) => b.slice(from, to).every((x) => x === 0);

function forbiddenV6(b) {
  const w0 = (b[0] << 8) | b[1];
  if (zero(b, 0, 16)) return 'unspecified';
  if (zero(b, 0, 15) && b[15] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): the
  // stack may reach the IPv4 address itself.
  if (zero(b, 0, 10) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    const why = forbiddenV4(v4At(b, 12));
    return why && `IPv4-mapped ${why}`;
  }
  if ((b[0] & 0xfe) === 0xfc) return 'ULA';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return 'site-local';
  if (b[0] === 0xff) return 'multicast';
  // NAT64 (64:ff9b::/96 maps the IPv4 address in its last 32 bits; the
  // local-use 64:ff9b:1::/48 is the operator's own network).
  if (w0 === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b[4] === 0 && b[5] === 1) return 'NAT64 local-use';
    const why = forbiddenV4(v4At(b, 12));
    return why && `NAT64 ${why}`;
  }
  // 6to4 (2002:a.b.c.d::/48) and Teredo (2001:0::/32, server in bits
  // 32–63, client inverted in the last 32): both route to an embedded IPv4.
  if (w0 === 0x2002) {
    const why = forbiddenV4(v4At(b, 2));
    return why && `6to4 ${why}`;
  }
  if (w0 === 0x2001 && b[2] === 0 && b[3] === 0) {
    const why = forbiddenV4(v4At(b, 4)) ?? forbiddenV4((~v4At(b, 12)) >>> 0);
    return why && `Teredo ${why}`;
  }
  if (w0 === 0x2001 && b[2] === 0x0d && b[3] === 0xb8) return 'reserved';
  if (w0 === 0x0100 && zero(b, 2, 8)) return 'reserved'; // 100::/64, discard
  return null;
}

/**
 * Why an address may not be connected to ("private", "loopback", …), or
 * null when it may. Anything that does not parse is refused.
 */
export function forbiddenAddress(address) {
  const v4 = parseV4(address);
  if (v4 !== null) return forbiddenV4(v4);
  const v6 = address.includes(':') ? parseV6(address) : null;
  if (v6) return forbiddenV6(v6);
  return 'not an IP address';
}

// --- hosts -------------------------------------------------------------------

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * Normalises a requested host name: lower case, without one trailing dot.
 * Returns {name} or {error} (an IP literal or not a host name).
 */
export function normalizeHost(host) {
  let h = String(host).toLowerCase();
  if (h.startsWith('[') || net.isIP(h)) return { error: 'IP addresses are not allowed' };
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === '' || h.length > 253) return { error: 'not a host name' };
  const labels = h.split('.');
  if (!labels.every((l) => LABEL.test(l))) return { error: 'not a host name' };
  // A numeric last label is an IPv4 address in a short or odd form
  // (127.1, 0x7f.1, 2130706433), which resolvers accept.
  const last = labels[labels.length - 1];
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return { error: 'IP addresses are not allowed' };
  return { name: h };
}

/**
 * Parses a version's normalised `egress` list into rules: {name, wildcard,
 * ports}. An entry without a port allows 443 and 80; "host:443" only 443.
 * Entries that do not parse are left out (specola validated the list).
 */
export function parseEgress(list) {
  const rules = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry !== 'string') continue;
    let e = entry.trim().toLowerCase();
    let ports = [443, 80];
    const m = /:(\d+)$/.exec(e);
    if (m) {
      if (m[1] !== '443' && m[1] !== '80') continue;
      ports = [Number(m[1])];
      e = e.slice(0, m.index);
    }
    const wildcard = e.startsWith('*.');
    const { name } = normalizeHost(wildcard ? e.slice(2) : e);
    if (name) rules.push({ name, wildcard, ports });
  }
  return rules;
}

/**
 * Whether a normalised host name and port are allowed by rules: an exact
 * name, or "*.suffix" for one or more labels below suffix (never suffix
 * itself).
 */
export function hostAllowed(rules, name, port) {
  return rules.some(
    (r) => r.ports.includes(port) && (r.wildcard ? name.endsWith('.' + r.name) : name === r.name),
  );
}

// --- the proxy -----------------------------------------------------------------

class Refusal extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
  }
}

/**
 * Starts the egress proxy on 127.0.0.1 and a random port.
 *
 * @param {object} o
 * @param {(pageId: string, level: string, text: string) => void} [o.log]
 *   gets the refusals ("egress refused: host:port (reason)") and failures
 *   for the page's backend log; it matches Logs.append's arguments.
 * @param {(host: string) => Promise<{address: string, family: number}[]>} [o.lookup]
 *   test seam: resolves a name to all its addresses (default dns.lookup, all: true).
 * @param {(address: string) => string|null} [o.forbidden]
 *   test seam: why an address is refused (default forbiddenAddress), e.g. to
 *   let tests reach a loopback server.
 * @param {(port: number, kind: 'connect'|'http') => boolean} [o.portAllowed]
 *   test seam: overrides the port rules (443 or 80, and the entry's port).
 * @param {boolean} [o.allowLoopbackForTests]
 *   RUNNER_EGRESS_ALLOW_LOOPBACK_FOR_TESTS=1 (config.js refuses it under
 *   NODE_ENV=production): a host on the egress list may resolve to
 *   loopback, and then be reached on any port, so an end-to-end test can
 *   serve the "outside" host locally. Every other rule stays.
 * @param {number} [o.connectTimeoutMs]
 * @param {number} [o.idleTimeoutMs]
 * @returns {Promise<{port: number, register: Function, unregister: Function, close: Function}>}
 */
export async function startEgressProxy({
  log = () => {},
  lookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  forbidden = forbiddenAddress,
  portAllowed = null,
  allowLoopbackForTests = false,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
} = {}) {
  const workers = new Map(); // user → {token: Buffer, pageId, rules}
  const tunnels = new Set(); // sockets the http server no longer tracks

  function authenticate(header) {
    const m = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
    if (!m) return null;
    const cred = Buffer.from(m[1], 'base64').toString('utf8');
    const i = cred.indexOf(':');
    if (i < 0) return null;
    const w = workers.get(cred.slice(0, i));
    if (!w) return null;
    const token = Buffer.from(cred.slice(i + 1));
    return token.length === w.token.length && timingSafeEqual(token, w.token) ? w : null;
  }

  // Checks host:port against the worker's page and resolves it. Returns the
  // checked addresses, or throws a Refusal (403 for policy, 502 when the
  // name doesn't resolve).
  async function admit(w, host, port, kind) {
    const { name, error } = normalizeHost(host);
    if (error) throw new Refusal(403, error);
    const portOk = portAllowed ? portAllowed(port, kind) : kind === 'http' ? port === 80 : port === 443 || port === 80;
    // With the test allowance, another port is decided once the name has
    // resolved: only a loopback-only name may use it.
    const loopbackPort = !portOk && allowLoopbackForTests;
    if (!portOk && !loopbackPort) throw new Refusal(403, `port ${port} is not allowed`);
    const rules = portAllowed || loopbackPort ? w.rules.map((r) => ({ ...r, ports: [port] })) : w.rules;
    if (!hostAllowed(rules, name, port)) throw new Refusal(403, `not in the backend's egress list`);
    let addrs;
    try {
      addrs = await lookup(name);
    } catch (err) {
      throw new Refusal(502, `could not resolve: ${err.code ?? err.message}`);
    }
    if (!Array.isArray(addrs) || addrs.length === 0) throw new Refusal(502, 'could not resolve: no addresses');
    // Any bad address refuses the name: which one the connection would use
    // is not ours to predict, and a name pointing inside is suspect anyway.
    for (const a of addrs) {
      const why = forbidden(a.address);
      if (why && !(allowLoopbackForTests && why === 'loopback')) throw new Refusal(403, `resolves to ${why} address ${a.address}`);
    }
    if (loopbackPort && !addrs.every((a) => forbiddenAddress(a.address) === 'loopback')) throw new Refusal(403, `port ${port} is not allowed`);
    return addrs;
  }

  function report(w, target, err) {
    const verb = err.status === 403 ? 'refused' : 'failed';
    const text = `egress ${verb}: ${target} (${err.message})`;
    if (w) log(w.pageId, 'warn', text);
    return text;
  }

  // Connects to the first of addrs that answers, in order: the addresses
  // were checked, and connecting by address never resolves again.
  function connectAny(addrs, port) {
    return new Promise((resolve, reject) => {
      let i = 0;
      let lastErr;
      const next = () => {
        if (i >= addrs.length) return reject(lastErr);
        const a = addrs[i++];
        const sock = net.connect({ host: a.address, port, family: a.family, allowHalfOpen: true });
        const timer = setTimeout(() => sock.destroy(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })), connectTimeoutMs);
        sock.once('connect', () => {
          clearTimeout(timer);
          sock.removeAllListeners('error');
          resolve(sock);
        });
        sock.once('error', (err) => {
          clearTimeout(timer);
          lastErr = err;
          next();
        });
      };
      next();
    });
  }

  function rawReply(socket, status, text, headers = []) {
    const body = text + '\n';
    socket.end(
      [
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}`,
        'Content-Type: text/plain; charset=utf-8',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        ...headers,
        '',
        body,
      ].join('\r\n'),
    );
  }

  const proxyAuth = [`Proxy-Authenticate: Basic realm="${REALM}"`];

  async function onConnect(req, client, head) {
    // Nothing the client sends early is lost while the target is checked:
    // pipe() resumes the socket once the tunnel is up.
    client.pause();
    tunnels.add(client);
    client.on('close', () => tunnels.delete(client));
    client.on('error', () => client.destroy());
    const w = authenticate(req.headers['proxy-authorization']);
    if (!w) return rawReply(client, 407, 'proxy authentication required', proxyAuth);
    const m = /^(.+):(\d{1,5})$/.exec(req.url);
    if (!m) return rawReply(client, 400, `CONNECT needs host:port, got ${JSON.stringify(req.url)}`);
    const [, host, portText] = m;
    const port = Number(portText);
    const target = `${host}:${port}`;
    let upstream;
    try {
      const addrs = await admit(w, host, port, 'connect');
      upstream = await connectAny(addrs, port);
    } catch (err) {
      if (!(err instanceof Refusal)) err = new Refusal(502, `could not connect: ${err.code ?? err.message}`);
      return rawReply(client, err.status, report(w, target, err));
    }
    if (client.destroyed) return upstream.destroy();
    tunnels.add(upstream);
    upstream.on('close', () => tunnels.delete(upstream));
    // Either side failing, or going quiet for too long, ends both.
    const kill = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on('error', kill);
    client.on('error', kill);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.setTimeout(idleTimeoutMs, kill);
    upstream.setTimeout(idleTimeoutMs, kill);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    // pipe ends the other side's writable when one side ends, keeping the
    // other direction open: half-close passes through.
    client.pipe(upstream);
    upstream.pipe(client);
  }

  async function onRequest(req, res) {
    const plain = (status, text, headers = {}) => {
      if (res.headersSent) return res.destroy();
      const body = text + '\n';
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      });
      res.end(body);
    };
    const w = authenticate(req.headers['proxy-authorization']);
    if (!w) return plain(407, 'proxy authentication required', { 'Proxy-Authenticate': `Basic realm="${REALM}"` });
    let url;
    try {
      url = new URL(req.url);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'http:' || !/^http:\/\//i.test(req.url)) {
      return plain(400, 'the proxy takes absolute http:// URLs, and CONNECT for https');
    }
    if (url.username || url.password) return plain(400, 'credentials in the URL are not forwarded');
    const host = url.hostname;
    const port = url.port ? Number(url.port) : 80;
    const target = `${host}:${port}`;
    let addrs;
    try {
      addrs = await admit(w, host, port, 'http');
    } catch (err) {
      return plain(err.status, report(w, target, err));
    }

    // Hop-by-hop headers go, and any the client's Connection header names.
    const named = new Set(
      String(req.headers.connection ?? '')
        .toLowerCase()
        .split(',')
        .map((s) => s.trim()),
    );
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const n = req.rawHeaders[i].toLowerCase();
      if (HOP_BY_HOP.has(n) || named.has(n) || n === 'host') continue;
      headers.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    // The Host is the one that was checked, whatever the client sent.
    headers.push('Host', url.host);

    let up;
    try {
      // The socket comes from connectAny, so the checked address is used and
      // nothing resolves the name again.
      const sock = await connectAny(addrs, port);
      if (req.destroyed) return sock.destroy();
      up = http.request({
        method: req.method,
        path: url.pathname + url.search,
        headers,
        setHost: false,
        // No agent: with one, Node would open its own connection instead.
        createConnection: () => sock,
      });
    } catch (err) {
      return plain(502, report(w, target, new Refusal(502, `could not connect: ${err.code ?? err.message}`)));
    }
    up.setTimeout(idleTimeoutMs, () => up.destroy(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' })));
    up.on('response', (ures) => {
      const out = [];
      const unamed = new Set(
        String(ures.headers.connection ?? '')
          .toLowerCase()
          .split(',')
          .map((s) => s.trim()),
      );
      for (let i = 0; i < ures.rawHeaders.length; i += 2) {
        const n = ures.rawHeaders[i].toLowerCase();
        if (HOP_BY_HOP.has(n) || unamed.has(n)) continue;
        out.push(ures.rawHeaders[i], ures.rawHeaders[i + 1]);
      }
      res.writeHead(ures.statusCode, ures.statusMessage, out);
      ures.pipe(res);
      ures.on('error', () => res.destroy());
    });
    up.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      const status = err.code === 'ETIMEDOUT' ? 504 : 502;
      plain(status, report(w, target, new Refusal(status, `upstream failed: ${err.code ?? err.message}`)));
    });
    // The client going away mid-request ends the upstream request too.
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  }

  const server = http.createServer({ requestTimeout: 0 }, (req, res) => {
    onRequest(req, res).catch(() => res.destroy());
  });
  server.on('connect', (req, socket, head) => {
    onConnect(req, socket, head).catch(() => socket.destroy());
  });
  // Upgrades (WebSocket over plain http) are not proxied; with no listener
  // Node would leave the socket hanging.
  server.on('upgrade', (req, socket) => rawReply(socket, 501, 'upgrades are not supported by the egress proxy'));
  server.on('clientError', (err, socket) => {
    if (socket.writable) rawReply(socket, 400, 'bad request');
    else socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  return {
    port,
    /**
     * Gives a worker its credential: the user is "w-<workerId>", the token
     * random. Registering a worker id again replaces its entry.
     */
    register(workerId, pageId, egressList) {
      const user = `w-${workerId}`;
      const token = randomBytes(24).toString('hex');
      workers.set(user, { token: Buffer.from(token), pageId, rules: parseEgress(egressList) });
      return { user, token, url: `http://${encodeURIComponent(user)}:${token}@127.0.0.1:${port}` };
    },
    /** Forgets a worker's credential (it exited). */
    unregister(workerId) {
      workers.delete(`w-${workerId}`);
    },
    close() {
      for (const s of tunnels) s.destroy();
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
