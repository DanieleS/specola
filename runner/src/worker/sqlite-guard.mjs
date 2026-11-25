// What a backend gets when it imports node:sqlite itself. Node 22's
// node:sqlite does not consult the permission model, so without this a
// worker could open (and create) a database anywhere the runner's user can
// write. The guard keeps database paths inside the page's directory. It is a
// guard against accidents, not a sandbox: SQL `ATTACH` still names any path.
// Databases opened through it get the page's disk quota (quota.mjs).
// This file runs inside page workers: it must only import node: modules.

import path from 'node:path';
import * as real from 'node:sqlite';

export * from 'node:sqlite';

const pageDir = globalThis[Symbol.for('specola.pageDir')];

function checkPath(location, what) {
  if (location === ':memory:' || location === '') return;
  let p = location;
  if (p instanceof URL) {
    if (p.protocol !== 'file:') throw new TypeError(`${what}: only file paths are allowed`);
    p = decodeURIComponent(p.pathname);
  } else if (Buffer.isBuffer(p) || p instanceof Uint8Array) {
    p = Buffer.from(p).toString('utf8');
  }
  if (typeof p !== 'string') throw new TypeError(`${what}: path must be a string`);
  if (p.startsWith('file:')) throw new TypeError(`${what}: URI file names are not allowed`);
  const abs = path.resolve(pageDir, p);
  if (abs !== pageDir && !abs.startsWith(pageDir + path.sep)) {
    const err = new Error(`${what}: ${JSON.stringify(location)} is outside this page's data directory`);
    err.code = 'ERR_ACCESS_DENIED';
    throw err;
  }
}

export class DatabaseSync extends real.DatabaseSync {
  constructor(...args) {
    checkPath(args[0], 'DatabaseSync');
    super(...args);
    globalThis[Symbol.for('specola.trackDb')]?.(this);
  }
}

export function backup(...args) {
  checkPath(args[1], 'backup');
  return real.backup(...args);
}

export default { ...real, DatabaseSync, backup };
