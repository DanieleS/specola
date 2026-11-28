// The dependency cache: the npm packages a version's manifest lists under
// "dependencies", installed with pnpm for this runner's platform and Node
// (docs/page-backends.md, "Dependencies"). The build leaves them out of the
// bundle, so the worker resolves them here.
//
//   deps/.store/                  pnpm's content-addressed store, shared
//   deps/.home/                   HOME, cache and state of pnpm itself
//   deps/{key}/package.json       {"dependencies": {...exact versions}}
//   deps/{key}/node_modules/…
//
// key = sha256 of the dependencies, the platform and the Node ABI: pages
// with the same dependencies share an install, and a runner on a new Node
// installs again rather than load addons built for another ABI. Like the
// code cache, a directory is only ever created whole (installed aside,
// then renamed into place), so one that exists is complete.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RunnerError } from './errors.js';

const FAILURE_MEMORY_MS = 10 * 60_000;
const OUTPUT_TAIL = 8 * 1024;

// What of the runner's environment reaches pnpm and the packages' install
// scripts: how to reach the registry, never the runner's token.
const PASS_ENV = /^(PATH|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|npm_config_.*|NPM_CONFIG_.*)$/;

/** The dependencies a version's code declares, from its backend.json: {} when none. */
export async function dependenciesOf(codeDir) {
  try {
    const m = JSON.parse(await fs.readFile(path.join(codeDir, 'backend.json'), 'utf8'));
    const d = m?.dependencies;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      return Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v === 'string'));
    }
  } catch {
    // entryOf says what is wrong with a missing or broken manifest
  }
  return {};
}

/** The platform installs are for: os, arch, libc and Node ABI. */
export function platformOf() {
  const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
  const libc = process.platform === 'linux' ? (glibc ? 'glibc' : 'musl') : '';
  return {
    id: [process.platform, process.arch, libc].filter(Boolean).join('-'),
    node: process.versions.node,
    abi: process.versions.modules,
  };
}

export class DepsCache {
  #inflight = new Map(); // key → Promise<dir>
  #failed = new Map(); // key → {at, err}

  /**
   * @param {{dataDir: string, enabled?: boolean, pnpm?: string, registry?: string,
   *   timeoutMs?: number, env?: NodeJS.ProcessEnv, now?: () => number}} opts
   */
  constructor({ dataDir, enabled = true, pnpm = 'pnpm', registry = '', timeoutMs = 300_000, env = process.env, now = Date.now }) {
    this.root = path.join(dataDir, 'deps');
    Object.assign(this, { enabled, pnpm, registry, timeoutMs, env, now });
    this.platform = platformOf();
  }

  keyOf(deps) {
    const sorted = Object.keys(deps).sort().map((n) => [n, deps[n]]);
    return createHash('sha256').update(JSON.stringify({ deps: sorted, platform: this.platform.id, abi: this.platform.abi })).digest('hex');
  }

  /** Removes installs a previous process left half done. */
  async sweep() {
    let names = [];
    try {
      names = await fs.readdir(this.root);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const n of names) {
      if (n.startsWith('.tmp-')) await fs.rm(path.join(this.root, n), { recursive: true, force: true });
    }
  }

  /** Whether deps are installed already (no install starts). */
  async ready(deps) {
    return exists(path.join(this.root, this.keyOf(deps)));
  }

  /**
   * The directory holding deps installed, installing them first if need be.
   * log(level, text) gets what the install does, for the page's backend log.
   * Throws a RunnerError when they can't be installed.
   */
  async ensure(deps, log = () => {}) {
    if (!this.enabled) {
      throw new RunnerError(500, 'backend-error', `This runner does not install backend dependencies (RUNNER_DEPS=off), and this backend needs ${list(deps)}.`);
    }
    const key = this.keyOf(deps);
    const dir = path.join(this.root, key);
    if (await exists(dir)) return dir;
    const failed = this.#failed.get(key);
    if (failed && this.now() - failed.at < FAILURE_MEMORY_MS) throw failed.err;
    let p = this.#inflight.get(key);
    if (!p) {
      p = this.#install(deps, dir, log)
        .then(
          (d) => {
            this.#failed.delete(key);
            return d;
          },
          (err) => {
            this.#failed.set(key, { at: this.now(), err });
            throw err;
          },
        )
        .finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, p);
    }
    return p;
  }

  /** Forgets failed installs, so the next call tries again at once. */
  retry() {
    this.#failed.clear();
  }

  async #install(deps, dir, log) {
    const started = this.now();
    const { id, node, abi } = this.platform;
    log('info', `installing dependencies ${list(deps)} for ${id}, Node ${node} (ABI ${abi})…`);
    const tmp = path.join(this.root, `.tmp-${randomBytes(8).toString('hex')}`);
    const home = path.join(this.root, '.home');
    await fs.mkdir(tmp, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    try {
      await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'specola-backend-deps', private: true, dependencies: deps }, null, 2) + '\n');
      const args = [
        'install',
        '--prod',
        '--ignore-workspace',
        '--reporter=append-only',
        `--store-dir=${path.join(this.root, '.store')}`,
        // Native packages build or fetch their binary in an install script.
        '--config.dangerously-allow-all-builds=true',
        '--config.package-import-method=hardlink',
        '--config.confirm-modules-purge=false',
        '--config.update-notifier=false',
      ];
      if (this.registry) args.push(`--registry=${this.registry}`);
      const env = { HOME: home, XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), CI: '1' };
      for (const [k, v] of Object.entries(this.env)) if (PASS_ENV.test(k) && v !== undefined) env[k] = v;
      const { code, output, timedOut } = await run(this.pnpm, args, { cwd: tmp, env, timeoutMs: this.timeoutMs });
      await fs.writeFile(path.join(tmp, 'install.log'), output).catch(() => {});
      if (code !== 0) {
        const why = timedOut ? `did not finish within ${Math.round(this.timeoutMs / 1000)} s` : `failed (exit ${code})`;
        const tail = output.trim().split('\n').slice(-15).join('\n');
        log('error', `installing ${list(deps)} ${why}:\n${tail}`);
        throw new RunnerError(500, 'backend-error', `Installing the backend's dependencies ${why}; the backend log has pnpm's output.`);
      }
      try {
        await fs.rename(tmp, dir);
      } catch (err) {
        // An earlier process put it in place first: that one is complete.
        if (err.code !== 'EEXIST' && err.code !== 'ENOTEMPTY') throw err;
      }
      log('info', `dependencies installed in ${((this.now() - started) / 1000).toFixed(1)} s`);
      return dir;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}

function list(deps) {
  return Object.entries(deps)
    .map(([n, v]) => `${n}@${v}`)
    .join(', ');
}

function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const keep = (chunk) => {
      output = (output + chunk).slice(-OUTPUT_TAIL * 8);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, output: `cannot run ${cmd}: ${err.message}`, timedOut });
      return;
    }
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: output + `\ncannot run ${cmd}: ${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output, timedOut });
    });
  });
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
