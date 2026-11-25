// Runner configuration, from the environment (docs/page-backends.md,
// "Configuration" and "Limits").

import path from 'node:path';

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 25 * MiB,
  maxResponseBytes: 100 * MiB,
  firstByteMs: 30_000,
  requestMs: 5 * 60_000,
  workerMemoryMb: 256,
  workerConcurrency: 32,
  pageDiskBytes: 1024 * MiB,
  idleMs: 5 * 60_000,
  versionSnapshotsKept: 5,
  snapshotDiskBytes: 2048 * MiB,
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
  return {
    listen: parseListen(env.RUNNER_LISTEN || ':8081'),
    token,
    specolaUrl: specolaUrl.replace(/\/+$/, ''),
    // Absolute: it ends up in the workers' --allow-fs-* flags.
    dataDir: path.resolve(env.RUNNER_DATA_DIR || '/data'),
    limits,
  };
}
