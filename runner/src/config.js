// Runner configuration, from the environment (docs/page-backends.md,
// "Configuration" and "Limits").

import path from 'node:path';

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 25 * MiB,
  maxResponseBytes: 100 * MiB,
  firstByteMs: 30_000,
  requestMs: 5 * 60_000,
  // A scheduled(event, ctx) run ("Limits": wall time per cron run).
  cronMs: 5 * 60_000,
  workerMemoryMb: 256,
  workerConcurrency: 32,
  pageDiskBytes: 1024 * MiB,
  idleMs: 5 * 60_000,
  // Snapshots kept per page (docs/page-backends.md, "Snapshots"): the last
  // 5 version ones, 7 daily ones, 5 taken before a restore/import/wipe
  // (together), and at most 10 manual ones (an 11th is refused).
  versionSnapshotsKept: 5,
  dailySnapshotsKept: 7,
  beforeSnapshotsKept: 5,
  manualSnapshotsMax: 10,
  snapshotDiskBytes: 2048 * MiB,
  importBytes: 1024 * MiB,
  // Exports, imports and "my data" downloads running at once, per page and
  // in all: each holds a copy of up to a page's data on the volume while
  // it streams, at the pace of a browser.
  transfersPerPage: 2,
  transfersMax: 8,
});

// RUNNER_* variable for each limit.
const LIMIT_ENV = {
  maxBodyBytes: 'RUNNER_MAX_BODY_BYTES',
  maxResponseBytes: 'RUNNER_MAX_RESPONSE_BYTES',
  firstByteMs: 'RUNNER_FIRST_BYTE_TIMEOUT_MS',
  requestMs: 'RUNNER_REQUEST_TIMEOUT_MS',
  workerMemoryMb: 'RUNNER_WORKER_MEMORY_MB',
  workerConcurrency: 'RUNNER_WORKER_CONCURRENCY',
  pageDiskBytes: 'RUNNER_PAGE_DISK_BYTES',
  idleMs: 'RUNNER_IDLE_TIMEOUT_MS',
  snapshotDiskBytes: 'RUNNER_SNAPSHOT_DISK_BYTES',
};

// The oldest Node releases whose workers honour NODE_USE_ENV_PROXY for
// both the global fetch and http/https.request: 22.21 on 22.x, 24.5 on 24.x
// (24.0-24.4 proxy fetch only). Egress is held to a page's list only
// through that variable ("Egress proxy (step 3)"): on an older release a
// worker's requests go out directly, with no refusal and no log line, so
// the runner refuses to start rather than run with egress silently open.
const MIN_NODE = { 22: 21, 24: 5 };

/**
 * Why this Node release can't run the runner, or null when it can.
 * `version` is process.versions.node ("22.23.0").
 */
export function nodeVersionProblem(version) {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  if (!m) return `cannot read the Node version ${JSON.stringify(version)}`;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major >= 25) return null;
  if (major in MIN_NODE && minor >= MIN_NODE[major]) return null;
  return `Node ${version} does not route workers' outbound requests through the egress proxy (NODE_USE_ENV_PROXY); ` +
    'run the runner on Node 22.21 or later on 22.x, or 24.5 or later';
}

function positiveInt(name, value) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/** Parses ":8081" or "host:8081". */
export function parseListen(listen) {
  const m = /^(.*):(\d{1,5})$/.exec(listen);
  if (!m || Number(m[2]) > 65535) throw new Error(`RUNNER_LISTEN must be [host]:port, got ${JSON.stringify(listen)}`);
  return { host: m[1].replace(/^\[(.*)\]$/, '$1') || undefined, port: Number(m[2]) };
}

export function loadConfig(env = process.env) {
  const token = env.SPECOLA_RUNNER_TOKEN ?? '';
  if (token.length < 16) throw new Error('SPECOLA_RUNNER_TOKEN must be set (at least 16 characters; e.g. openssl rand -base64 32)');
  const specolaUrl = env.SPECOLA_URL ?? '';
  if (!/^https?:\/\//.test(specolaUrl)) throw new Error('SPECOLA_URL must be set to specola\'s internal base URL, e.g. http://specola:8080');
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, name] of Object.entries(LIMIT_ENV)) {
    if (env[name]) limits[key] = positiveInt(name, env[name]);
  }
  // Test only: lets the egress proxy reach loopback (egress.js), so an
  // end-to-end test can serve an "outside" host locally. It opens the
  // runner's own host to page code, so production refuses it outright.
  const loopback = env.RUNNER_EGRESS_ALLOW_LOOPBACK_FOR_TESTS ?? '';
  if (loopback !== '' && loopback !== '1' && loopback !== '0') {
    throw new Error(`RUNNER_EGRESS_ALLOW_LOOPBACK_FOR_TESTS must be 1 or unset, got ${JSON.stringify(loopback)}`);
  }
  const egressAllowLoopbackForTests = loopback === '1';
  if (egressAllowLoopbackForTests && env.NODE_ENV === 'production') {
    throw new Error('RUNNER_EGRESS_ALLOW_LOOPBACK_FOR_TESTS is for tests only and is refused with NODE_ENV=production');
  }
  const depsFlag = env.RUNNER_DEPS || 'on';
  if (depsFlag !== 'on' && depsFlag !== 'off') throw new Error(`RUNNER_DEPS must be on or off, got ${JSON.stringify(depsFlag)}`);
  const registry = env.RUNNER_NPM_REGISTRY || '';
  if (registry && !/^https?:\/\//.test(registry)) throw new Error(`RUNNER_NPM_REGISTRY must be an http(s) URL, got ${JSON.stringify(registry)}`);
  return {
    listen: parseListen(env.RUNNER_LISTEN || ':8081'),
    // Backend dependencies (deps.js): installed with pnpm, from the registry.
    deps: {
      enabled: depsFlag === 'on',
      pnpm: env.RUNNER_PNPM || 'pnpm',
      registry,
      timeoutMs: env.RUNNER_DEPS_INSTALL_TIMEOUT_MS ? positiveInt('RUNNER_DEPS_INSTALL_TIMEOUT_MS', env.RUNNER_DEPS_INSTALL_TIMEOUT_MS) : 300_000,
    },
    egressAllowLoopbackForTests,
    token,
    specolaUrl: specolaUrl.replace(/\/+$/, ''),
    // Absolute: it ends up in the workers' --allow-fs-* flags.
    dataDir: path.resolve(env.RUNNER_DATA_DIR || '/data'),
    limits,
  };
}
