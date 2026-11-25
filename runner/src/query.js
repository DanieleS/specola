// Read-only SQL on a page's shared database, for MCP's backend_query
// (docs/page-backends.md, "MCP (step 7)"): runner POST /pages/{id}/query
// {sql, params} → {columns, rows, truncated}.
//
// The statement runs in a short-lived child process (worker/query-child.mjs)
// started with --permission and read access to shared.sqlite (and its WAL
// files) only, which opens it readOnly with PRAGMA query_only, and is killed
// after timeoutMs. At most 1000 rows / 1 MiB come back.
//
// How the database is opened: directly, read-only, while the page's worker
// may be writing to it. A WAL database is read through its -wal and -shm
// files, and SQLite's reader takes its locks in the -shm (opened read-write
// by SQLite's VFS, below Node's permission model, as the runner's user that
// owns the page directory). That is the same access snapshot.js has and
// sees the last committed transaction. The alternatives are worse:
// `immutable=1` tells SQLite the file can't change, so it ignores the WAL
// (committed rows missing) and may read a page mid-checkpoint; copying the
// database first (VACUUM INTO a temp file) costs a full copy of up to the
// page's disk quota for every query.
//
// Node 22's node:sqlite does not consult the permission model (see
// worker/sqlite-guard.mjs), so SQL itself could reach other files: ATTACH
// opens any database the runner can read (another page's), VACUUM INTO
// creates a file anywhere. So the statement is checked before it runs: one
// statement, and it must start with SELECT, WITH, VALUES or EXPLAIN, or be a
// PRAGMA from a read-only list. Writes are refused three times over: by that
// check, by query_only, and by the read-only open.

import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerError } from './errors.js';

const CHILD = fileURLToPath(new URL('./worker/query-child.mjs', import.meta.url));
export const MAX_ROWS = 1000;
export const MAX_BYTES = 1024 * 1024;
export const QUERY_TIMEOUT_MS = 5000;
const MAX_SQL = 100 * 1024;
const MAX_PARAMS = 1000;
// Queries running at once in the whole runner: each is a Node process.
const MAX_RUNNING = 4;
const CHILD_MEMORY_MB = 256;

const badRequest = (message) => new RunnerError(400, 'bad-request', message);

// --- the statement -------------------------------------------------------------

/**
 * Splits SQL into tokens (words, quoted strings and identifiers, single
 * punctuation characters), leaving out whitespace and comments. Good enough
 * to find where statements start and end; SQLite parses the real thing.
 */
export function tokenize(sql) {
  const out = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        const e = sql.indexOf(close, j);
        if (e < 0) {
          j = n;
          break;
        }
        // A doubled quote is an escaped one (not in [brackets]).
        if (close !== ']' && sql[e + 1] === close) {
          j = e + 2;
          continue;
        }
        j = e + 1;
        break;
      }
      out.push({ kind: c === "'" ? 'string' : 'ident', text: sql.slice(i, j) });
      i = j;
    } else if (/[A-Za-z0-9_$\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++;
      out.push({ kind: 'word', text: sql.slice(i, j) });
      i = j;
    } else {
      out.push({ kind: 'punct', text: c });
      i++;
    }
  }
  return out;
}

const STARTS = new Set(['SELECT', 'WITH', 'VALUES']);
// PRAGMAs that only read and name nothing outside the database: the plain
// form, or with one argument (a table, an index, a number).
const PRAGMAS = new Set([
  'application_id',
  'auto_vacuum',
  'collation_list',
  'compile_options',
  'data_version',
  'database_list',
  'encoding',
  'foreign_key_check',
  'foreign_key_list',
  'foreign_keys',
  'freelist_count',
  'function_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'integrity_check',
  'journal_mode',
  'module_list',
  'page_count',
  'page_size',
  'pragma_list',
  'quick_check',
  'schema_version',
  'table_info',
  'table_list',
  'table_xinfo',
  'user_version',
]);

const READ_ONLY_HINT =
  'Only one read-only statement is allowed: SELECT, WITH … SELECT, VALUES, EXPLAIN, or a read-only PRAGMA such as table_info(t) (also as SELECT * FROM pragma_table_info(\'t\')).';

/** Why sql is not one read-only statement, or null when it is. */
export function statementProblem(sql) {
  const tokens = tokenize(sql);
  const end = tokens.findIndex((t) => t.kind === 'punct' && t.text === ';');
  const stmt = end < 0 ? tokens : tokens.slice(0, end);
  if (stmt.length === 0) return 'The SQL is empty.';
  // node:sqlite compiles the first statement only and ignores the rest
  // silently: refuse a second one instead of pretending it ran.
  if (end >= 0 && tokens.slice(end).some((t) => !(t.kind === 'punct' && t.text === ';'))) {
    return `The SQL holds more than one statement. ${READ_ONLY_HINT}`;
  }
  const word = (i) => (stmt[i]?.kind === 'word' ? stmt[i].text.toUpperCase() : '');
  const first = word(0);
  if (first === 'EXPLAIN') {
    // EXPLAIN only compiles its statement, but there is no reason to show
    // the plan of one that could not run here.
    const k = word(1) === 'QUERY' && word(2) === 'PLAN' ? 3 : 1;
    if (STARTS.has(word(k))) return null;
    return `EXPLAIN ${word(k) || '…'} is not allowed: ${READ_ONLY_HINT}`;
  }
  if (STARTS.has(first)) return null;
  if (first === 'PRAGMA') {
    // PRAGMA [schema.]name [ ( arg ) ]: never "= value", which sets.
    let k = 1;
    if (stmt[k + 1]?.text === '.') k += 2;
    const name = stmt[k]?.kind === 'word' ? stmt[k].text.toLowerCase() : '';
    const rest = stmt.slice(k + 1).map((t) => t.text);
    const argOk =
      rest.length === 0 ||
      (rest.length === 3 && rest[0] === '(' && rest[2] === ')' && !/^[()=]$/.test(rest[1])) ||
      (rest.length === 4 && rest[0] === '(' && rest[1] === '-' && /^\d+$/.test(rest[2]) && rest[3] === ')');
    if (PRAGMAS.has(name) && argOk) return null;
    return `PRAGMA ${name || '?'} is not allowed here. ${READ_ONLY_HINT}`;
  }
  return `${first || 'This statement'} is not allowed: ${READ_ONLY_HINT}`;
}

// --- params ------------------------------------------------------------------

function param(v, where) {
  if (v === null || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw badRequest(`${where} is not a finite number`);
    return v;
  }
  // SQLite has no booleans; it stores them as 1 and 0.
  if (typeof v === 'boolean') return v ? 1 : 0;
  // A blob, written as the rows give blobs back.
  if (v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.base64 === 'string') {
    return Buffer.from(v.base64, 'base64');
  }
  throw badRequest(`${where} must be null, a number, a string, a boolean or {"base64": "…"}`);
}

/** Validates params: an array (for ?, ?NNN) or an object (for :name, @name, $name). */
export function normalizeParams(params) {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) {
    if (params.length > MAX_PARAMS) throw badRequest(`at most ${MAX_PARAMS} params`);
    return params.map((v, i) => param(v, `params[${i}]`));
  }
  if (typeof params === 'object') {
    const keys = Object.keys(params);
    if (keys.length > MAX_PARAMS) throw badRequest(`at most ${MAX_PARAMS} params`);
    const out = {};
    for (const k of keys) {
      const name = k.replace(/^[:@$]/, '');
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw badRequest(`params: ${JSON.stringify(k)} is not a parameter name`);
      out[name] = param(params[k], `params.${k}`);
    }
    return out;
  }
  throw badRequest('params must be an array or an object');
}

// --- values back ------------------------------------------------------------------

// Rows leave the runner as JSON. Integers stay exact: a safe one is a
// number, a larger one is written with all its digits (specola decodes
// numbers as json.Number). A blob is {"base64": "…"}.
function jsonValue(v) {
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : JSON.rawJSON(String(v));
  }
  if (v instanceof Uint8Array) return { base64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

// --- the child -----------------------------------------------------------------

let running = 0;

/**
 * Runs one read-only statement on pageDir/shared.sqlite.
 *
 * @param {object} o
 * @param {string} o.pageDir
 * @param {string} o.sql
 * @param {unknown[]|Record<string, unknown>} [o.params]
 * @param {number} [o.timeoutMs]
 * @param {number} [o.maxRows]
 * @param {number} [o.maxBytes]
 * @returns {Promise<{columns: string[], rows: unknown[][], truncated: boolean}>}
 * @throws {RunnerError} code bad-request (not one read-only statement, bad
 *   params, or SQLite's error message), backend-timeout (killed after
 *   timeoutMs), too-many-requests, or backend-error (the child died).
 */
export async function runQuery({ pageDir, sql, params, timeoutMs = QUERY_TIMEOUT_MS, maxRows = MAX_ROWS, maxBytes = MAX_BYTES }) {
  if (typeof sql !== 'string' || sql.trim() === '') throw badRequest('sql is required');
  if (sql.length > MAX_SQL) throw badRequest(`sql is longer than ${MAX_SQL} characters`);
  const problem = statementProblem(sql);
  if (problem) throw badRequest(problem);
  const args = normalizeParams(params);
  const dbPath = path.join(pageDir, 'shared.sqlite');
  // Opening a missing file read-only fails with SQLite's "unable to open
  // database file", which says nothing useful.
  if (!fs.existsSync(dbPath)) {
    throw badRequest('This page has no shared database yet: its backend has not used ctx.db.');
  }
  if (running >= MAX_RUNNING) {
    throw new RunnerError(429, 'too-many-requests', `${MAX_RUNNING} queries are already running; retry shortly.`);
  }
  running++;
  try {
    return await runChild({ dbPath, sql, params: args, timeoutMs, maxRows, maxBytes });
  } finally {
    running--;
  }
}

/**
 * The child's Node flags for dbPath: the permission model with read access
 * to the database and its WAL files, nothing to write, no child processes,
 * workers or addons. (Its own script is added by runChild.)
 */
export function childExecArgv(dbPath) {
  return [
    '--permission',
    `--allow-fs-read=${dbPath}`,
    `--allow-fs-read=${dbPath}-wal`,
    `--allow-fs-read=${dbPath}-shm`,
    `--max-old-space-size=${CHILD_MEMORY_MB}`,
    '--disable-warning=ExperimentalWarning',
  ];
}

function runChild({ dbPath, timeoutMs, ...job }) {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD, [], {
      execArgv: [...childExecArgv(dbPath), `--allow-fs-read=${CHILD}`],
      // Nothing of the runner's environment (its token above all).
      env: { TZ: 'UTC', LANG: 'C.UTF-8' },
      cwd: path.dirname(dbPath),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-2048);
    });
    let settled = false;
    const settle = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new RunnerError(504, 'backend-timeout', `The query took longer than ${timeoutMs / 1000} s and was stopped.`));
    }, timeoutMs);
    child.on('message', (m) => {
      if (m?.ok) {
        const { columns, rows, truncated } = m.ok;
        settle(resolve, { columns, rows: rows.map((r) => r.map(jsonValue)), truncated });
      } else {
        settle(reject, badRequest(String(m?.error ?? 'the query failed')));
      }
    });
    child.on('error', (err) => {
      child.kill('SIGKILL');
      settle(reject, new RunnerError(500, 'backend-error', `the query process failed: ${err.message}`));
    });
    // 'close' rather than 'exit': it comes after the IPC channel is drained,
    // so an answer sent just before exiting is never taken for a crash.
    child.on('close', (code, signal) => {
      const why = signal ? `signal ${signal}` : `code ${code}`;
      const tail = stderr.trim().split('\n').pop();
      settle(reject, new RunnerError(500, 'backend-error', `the query process exited with ${why}${tail ? `: ${tail}` : ''}`));
    });
    child.send({ ...job, dbPath });
  });
}
