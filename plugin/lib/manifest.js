// The backend manifest (.specola/backend.json), checked exactly as the server
// checks it (internal/backend/manifest.go, docs/page-backends.md "Bundle
// layout and manifest"), with the same messages: a manifest the server would
// refuse fails the build, or the publish, on the author's machine instead of
// halfway through an upload.

import { isIP } from 'node:net';

/** The reserved bundle directory the backend travels in. */
export const BACKEND_PREFIX = '.specola/';
/** The manifest's path in a bundle; its presence makes a backend version. */
export const MANIFEST_PATH = BACKEND_PREFIX + 'backend.json';
/** Where the plugin builds the server entry, relative to BACKEND_PREFIX. */
export const DEFAULT_ENTRY = 'server/index.mjs';

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_CRON_JOBS = 10;
const MAX_LIST_ENTRIES = 100;
export const MAX_DEPENDENCIES = 100;

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const CRON_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TOPIC_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// npm package names (lower case, optionally scoped) and exact semver
// versions, as the server checks them.
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const EXACT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const FIELDS = ['version', 'entry', 'public', 'egress', 'secrets', 'cron', 'topics', 'dependencies'];

/** A manifest that doesn't validate; its message names the field. */
export class ManifestError extends Error {
  constructor(reason) {
    super(`${MANIFEST_PATH}: ${reason}`);
    this.name = 'ManifestError';
    this.reason = reason;
  }
}

const q = (s) => JSON.stringify(s);
const invalid = (reason) => new ManifestError(reason);

/** Reports whether a bundle path is under the reserved .specola/ directory. */
export function isBackendPath(path) {
  return path.startsWith(BACKEND_PREFIX);
}

/**
 * Validates a manifest, given as its JSON text (as in a bundle) or as an
 * already parsed value, against the bundle's paths (the entry must be one of
 * them). Returns it normalised the way the server stores it: every field
 * present, methods upper-cased, hosts lower-cased, schedules with single
 * spaces. Throws ManifestError.
 */
export function validateManifest(content, files) {
  let value = content;
  if (typeof content === 'string' || content instanceof Uint8Array) {
    const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw invalid(`larger than ${MAX_MANIFEST_BYTES} bytes`);
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw invalid(`not a valid manifest: ${err.message}`);
    }
  } else if (Buffer.byteLength(JSON.stringify(content) ?? '', 'utf8') > MAX_MANIFEST_BYTES) {
    throw invalid(`larger than ${MAX_MANIFEST_BYTES} bytes`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('not a valid manifest: it must be a JSON object');
  }
  for (const k of Object.keys(value)) {
    if (!FIELDS.includes(k)) throw invalid(`not a valid manifest: json: unknown field ${q(k)}`);
  }
  const list = (name) => {
    const v = value[name];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
      throw invalid(`not a valid manifest: ${q(name)} must be a list of strings`);
    }
    return v;
  };

  if (value.version !== 1) throw invalid('"version" must be 1');
  const m = { version: 1, entry: DEFAULT_ENTRY, public: [], egress: [], secrets: [], cron: [], topics: { public: [] }, dependencies: {} };

  if (value.entry !== undefined && value.entry !== null) {
    if (typeof value.entry !== 'string') throw invalid('not a valid manifest: "entry" must be a string');
    m.entry = value.entry;
  }
  checkEntry(m.entry, files);

  const pub = list('public');
  if (pub.length > MAX_LIST_ENTRIES) throw invalid(`"public" can list at most ${MAX_LIST_ENTRIES} routes`);
  pub.forEach((r, i) => {
    const route = parseRoute(r, (why) => invalid(`"public"[${i}] ${q(r)}: ${why}`));
    if (m.public.includes(route)) throw invalid(`"public"[${i}] ${q(r)} is listed twice`);
    m.public.push(route);
  });

  const egress = list('egress');
  if (egress.length > MAX_LIST_ENTRIES) throw invalid(`"egress" can list at most ${MAX_LIST_ENTRIES} hosts`);
  egress.forEach((h, i) => {
    const host = parseHost(h, (why) => invalid(`"egress"[${i}] ${q(h)}: ${why}`));
    if (m.egress.includes(host)) throw invalid(`"egress"[${i}] ${q(h)} is listed twice`);
    m.egress.push(host);
  });

  const secrets = list('secrets');
  if (secrets.length > MAX_LIST_ENTRIES) throw invalid(`"secrets" can list at most ${MAX_LIST_ENTRIES} names`);
  secrets.forEach((s, i) => {
    if (!SECRET_NAME.test(s)) {
      throw invalid(`"secrets"[${i}] ${q(s)}: a name is an upper-case letter then up to 63 upper-case letters, digits or _`);
    }
    if (m.secrets.includes(s)) throw invalid(`"secrets"[${i}] ${q(s)} is listed twice`);
    m.secrets.push(s);
  });

  const cron = value.cron ?? [];
  if (!Array.isArray(cron)) throw invalid('not a valid manifest: "cron" must be a list of {"name", "schedule"}');
  if (cron.length > MAX_CRON_JOBS) throw invalid(`"cron" can have at most ${MAX_CRON_JOBS} jobs`);
  cron.forEach((j, i) => {
    if (j === null || typeof j !== 'object' || Array.isArray(j)) {
      throw invalid('not a valid manifest: "cron" must be a list of {"name", "schedule"}');
    }
    for (const k of Object.keys(j)) {
      if (k !== 'name' && k !== 'schedule') throw invalid(`not a valid manifest: json: unknown field ${q(k)}`);
    }
    const name = j.name ?? '';
    const schedule = j.schedule ?? '';
    if (typeof name !== 'string' || typeof schedule !== 'string') {
      throw invalid(`not a valid manifest: "cron"[${i}] name and schedule must be strings`);
    }
    if (!CRON_NAME.test(name)) {
      throw invalid(`"cron"[${i}].name ${q(name)}: 1 to 64 letters, digits, _, . or -, starting with a letter or digit`);
    }
    if (m.cron.some((c) => c.name === name)) throw invalid(`"cron"[${i}].name ${q(name)} is used twice`);
    const sched = parseSchedule(schedule, (why) => invalid(`"cron"[${i}].schedule ${q(schedule)}: ${why}`));
    m.cron.push({ name, schedule: sched });
  });

  if (value.topics !== undefined && value.topics !== null) {
    const t = value.topics;
    const bad = (why) => invalid(`"topics" must be {"public": [...]}: ${why}`);
    if (typeof t !== 'object' || Array.isArray(t)) throw bad('not an object');
    for (const k of Object.keys(t)) if (k !== 'public') throw bad(`json: unknown field ${q(k)}`);
    const names = t.public ?? [];
    if (!Array.isArray(names) || names.some((s) => typeof s !== 'string')) throw bad('"public" must be a list of strings');
    if (names.length > MAX_LIST_ENTRIES) throw invalid(`"topics.public" can list at most ${MAX_LIST_ENTRIES} topics`);
    names.forEach((name, i) => {
      if (!TOPIC_NAME.test(name)) {
        throw invalid(`"topics.public"[${i}] ${q(name)}: 1 to 128 letters, digits, _, ., :, / or -, starting with a letter or digit`);
      }
      if (m.topics.public.includes(name)) throw invalid(`"topics.public"[${i}] ${q(name)} is listed twice`);
      m.topics.public.push(name);
    });
  }

  const deps = value.dependencies ?? {};
  if (typeof deps !== 'object' || Array.isArray(deps)) {
    throw invalid('not a valid manifest: "dependencies" must be an object of {"package": "exact version"}');
  }
  const names = Object.keys(deps);
  if (names.length > MAX_DEPENDENCIES) throw invalid(`"dependencies" can list at most ${MAX_DEPENDENCIES} packages`);
  // Sorted (by bytes, as Go sorts), so the first bad entry reported is the server's.
  for (const name of names.sort(byBytes)) {
    if (name.length > 214 || !PACKAGE_NAME.test(name)) throw invalid(`"dependencies" ${q(name)} is not an npm package name`);
    const v = deps[name];
    if (typeof v !== 'string' || !EXACT_VERSION.test(v)) {
      throw invalid(`"dependencies" ${q(name)}: the version must be an exact one, like "1.2.3", got ${JSON.stringify(v)}`);
    }
    m.dependencies[name] = v;
  }
  return m;
}

function byBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The entry: a path relative to .specola/, of a JavaScript module the bundle has. */
function checkEntry(entry, files) {
  if (entry === '') throw invalid('"entry" is empty');
  if (entry.startsWith('/') || entry.startsWith(BACKEND_PREFIX)) {
    throw invalid(`"entry" ${q(entry)} must be relative to .specola/, e.g. ${q(DEFAULT_ENTRY)}`);
  }
  if (entry.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw invalid(`"entry" ${q(entry)} has an empty, "." or ".." segment`);
  }
  if (!entry.endsWith('.mjs') && !entry.endsWith('.js')) throw invalid(`"entry" ${q(entry)} must end in .mjs or .js`);
  if (!files.includes(BACKEND_PREFIX + entry)) {
    throw invalid(`"entry" ${q(entry)} is not in the bundle (expected ${BACKEND_PREFIX}${entry})`);
  }
}

// Go's strings.TrimSpace and strings.Fields work on Unicode white space, as
// JavaScript's trim() and \s do (near enough for a manifest).
function parseRoute(r, fail) {
  const s = r.trim();
  const sp = s.indexOf(' ');
  if (sp < 0) throw fail('must be "METHOD /path"');
  const method = s.slice(0, sp).toUpperCase();
  const p = s.slice(sp + 1);
  if (!METHODS.includes(method)) throw fail(`method must be one of ${METHODS.join(', ')}`);
  if (!p.startsWith('/')) throw fail('the path must start with /');
  if (/[?# \t]/.test(p)) throw fail("the path can't have a query, a fragment or spaces");
  if (p !== '/') {
    const segs = p.slice(1).split('/');
    segs.forEach((seg, i) => {
      if ((seg === '' && i < segs.length - 1) || seg === '.' || seg === '..') {
        throw fail('the path has an empty, "." or ".." segment');
      }
      if (seg.includes('*') && (seg !== '*' || i !== segs.length - 1)) throw fail('* may only be the whole last segment');
    });
  }
  return `${method} ${p}`;
}

function parseHost(raw, fail) {
  const h = raw.trim().toLowerCase();
  let name = h;
  const i = h.lastIndexOf(':');
  if (i >= 0) {
    name = h.slice(0, i);
    const port = h.slice(i + 1);
    if (port !== '443' && port !== '80') throw fail('the only ports allowed are 443 and 80');
  }
  const bare = name.startsWith('*.') ? name.slice(2) : name;
  if (/[[\]:]/.test(bare) || isIP(bare) !== 0) throw fail('IP addresses are not allowed, only host names');
  if (bare === '' || bare.length > 253) throw fail('not a host name');
  const labels = bare.split('.');
  for (const l of labels) {
    if (!HOST_LABEL.test(l)) throw fail('not a host name (letters, digits and -, dot-separated; *. only at the start)');
  }
  // A numeric last label is an IP address in some form (1.2.3, 0x7f.1).
  const last = labels[labels.length - 1];
  if (/^\d+$/.test(last) || /^0x[0-9a-f]+$/.test(last)) throw fail('IP addresses are not allowed, only host names');
  return h;
}

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];

function parseSchedule(s, fail) {
  const fields = s.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) throw fail('must have 5 fields: minute hour day-of-month month day-of-week');
  fields.forEach((f, i) => {
    const spec = CRON_FIELDS[i];
    for (const part of f.split(',')) {
      const why = cronPartProblem(part, spec);
      if (why) throw fail(`${spec.name} field ${q(f)}: ${why}`);
    }
  });
  return fields.join(' ');
}

// Go's strconv.Atoi: an optional sign, then decimal digits.
const atoi = (s) => (/^[+-]?\d+$/.test(s) ? Number(s) : NaN);

function cronPartProblem(part, { min, max, names = [] }) {
  const slash = part.indexOf('/');
  const rng = slash < 0 ? part : part.slice(0, slash);
  if (slash >= 0) {
    const step = part.slice(slash + 1);
    const n = atoi(step);
    if (!(n >= 1 && n <= max - min + 1)) return `step ${q(step)} must be a number from 1 to ${max - min + 1}`;
  }
  if (rng === '*') return null;
  const value = (v) => {
    const i = names.indexOf(v.toLowerCase());
    if (i >= 0) return min + i;
    const n = atoi(v);
    if (!(n >= min && n <= max)) throw `${q(v)} is not a value from ${min} to ${max}`;
    return n;
  };
  try {
    const dash = rng.indexOf('-');
    const a = value(dash < 0 ? rng : rng.slice(0, dash));
    if (dash < 0) return slash >= 0 ? 'a step needs * or a range before it' : null;
    const b = value(rng.slice(dash + 1));
    if (a > b) return `range ${q(rng)} goes backwards`;
    return null;
  } catch (why) {
    return why;
  }
}
