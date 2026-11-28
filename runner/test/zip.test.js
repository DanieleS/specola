import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buffer } from 'node:stream/consumers';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import zlib from 'node:zlib';
import { stageImport } from '../src/data.js';
import { RunnerError } from '../src/errors.js';
import { ZipError, entryData, readZip, zipStream } from '../src/zip.js';
import { craftZip, exportEntries, sha256 } from './zipcraft.js';

let dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'specola-zip-test-'));
});
after(() => fs.rm(dir, { recursive: true, force: true }));

let n = 0;
async function write(bytes) {
  const file = path.join(dir, `z-${n++}.zip`);
  await fs.writeFile(file, bytes);
  return file;
}

async function zipOf(entries, opts) {
  const list = entries.map((e) => ({ name: e.name, size: e.data.length, method: e.method ?? 8, data: async function* () {
    // In pieces, as a file stream would give them.
    for (let i = 0; i < e.data.length; i += 7000) yield e.data.subarray(i, i + 7000);
  } }));
  return buffer(Readable.from(zipStream(list, opts)));
}

// An independent reader: Python's zipfile (CRCs checked by testzip).
function python(file) {
  const out = execFileSync('python3', ['-I', '-c', `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps([[i.filename, i.compress_type, i.file_size, z.read(i).hex()] for i in z.infolist()]))
`, file]);
  return JSON.parse(out);
}

async function readAll(file) {
  const out = {};
  for (const e of await readZip(file)) {
    const parts = [];
    for await (const c of entryData(file, e)) parts.push(c);
    out[e.name] = Buffer.concat(parts);
  }
  return out;
}

describe('the zip writer', () => {
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"a":1}') },
    { name: 'stored.bin', data: randomBytes(20_000), method: 0 },
    { name: 'files/data/ünïcode/ok.txt', data: Buffer.from('hello '.repeat(5000)) },
    { name: 'empty', data: Buffer.alloc(0) },
  ];

  test('writes zips other tools read, with stored and deflated entries', async () => {
    const file = await write(await zipOf(entries));
    const got = python(file);
    assert.deepEqual(got.map((g) => [g[0], g[1], g[2]]), [['manifest.json', 8, 7], ['stored.bin', 0, 20_000], ['files/data/ünïcode/ok.txt', 8, 30_000], ['empty', 8, 0]]);
    for (const [i, g] of got.entries()) assert.equal(g[3], entries[i].data.toString('hex'));
    execFileSync('unzip', ['-tq', file]);
    const mine = await readAll(file);
    for (const e of entries) assert.ok(mine[e.name].equals(e.data), e.name);
  });

  test('zip64 entries (forced small) and a zip64 end record (70 000 entries)', async () => {
    const file = await write(await zipOf(entries, { zip64At: 0 }));
    assert.deepEqual(python(file).map((g) => g[2]), [7, 20_000, 30_000, 0]);
    execFileSync('unzip', ['-tq', file]);
    const mine = await readAll(file);
    for (const e of entries) assert.ok(mine[e.name].equals(e.data), e.name);

    const many = Array.from({ length: 70_000 }, (_, i) => ({ name: `f${i}`, data: Buffer.from(String(i)), method: 0 }));
    const big = await write(await zipOf(many));
    const read = await readZip(big);
    assert.equal(read.length, 70_000);
    assert.equal(read[69_999].name, 'f69999');
    const count = execFileSync('python3', ['-I', '-c', 'import sys, zipfile; print(len(zipfile.ZipFile(sys.argv[1]).infolist()))', big]);
    assert.equal(Number(count), 70_000);
  });
});

describe('the zip reader refuses', () => {
  const cases = [
    ['a file that is not a zip', Buffer.from('hello, this is not a zip at all.....'), /no end of central directory/],
    ['a truncated zip', craftZip([{ name: 'a', data: 'x'.repeat(100) }]).subarray(30), /no end|out of bounds|no local header|damaged/],
    ['encrypted entries', craftZip([{ name: 'a', data: 'x', flags: 1 }]), /"a" is encrypted/],
    ['methods other than stored and deflate', craftZip([{ name: 'a', data: 'x', method: 12, compressed: Buffer.from('zz') }]), /compression method 12/],
    ['symbolic links', craftZip([{ name: 'a', data: '/etc/passwd', method: 0, attrs: (0o120777 << 16) >>> 0 }]), /symbolic link/],
    ['devices and other non-files', craftZip([{ name: 'a', data: '', method: 0, attrs: (0o020644 << 16) >>> 0 }]), /not a regular file/],
    ['a local header naming another file', craftZip([{ name: 'a', localName: 'b', data: 'x' }]), /names another file/],
    ['entries sharing their data (overlap bomb)', craftZip([{ name: 'a', data: 'x'.repeat(50) }, { name: 'b', data: 'x'.repeat(50), offset: 0 }]), /names another file|overlaps/],
    ['an impossible compression ratio', craftZip([{ name: 'a', data: 'x', usize: 2 ** 31 }]), /declares a size its compressed data cannot have/],
    ['stored entries whose sizes differ', craftZip([{ name: 'a', data: 'xyz', method: 0, usize: 2 }]), /stored, but its sizes differ/],
    ['zip64 fields that are cut short', (() => {
      const z = craftZip([{ name: 'a', data: 'x', zip64: {} }]);
      // Shrink the extra field's declared length to 8: only one of two sizes.
      const at = z.indexOf(Buffer.from([1, 0, 16, 0]), z.indexOf(Buffer.from([0x50, 0x4b, 1, 2])));
      z.writeUInt16LE(8, at + 2);
      return z;
    })(), /damaged zip64 extra field|damaged/],
  ];
  for (const [what, bytes, re] of cases) {
    test(what, async () => {
      const file = await write(bytes);
      await assert.rejects(readZip(file), (err) => err instanceof ZipError && re.test(err.message));
    });
  }

  const inflating = [
    ['data that expands past its declared size (bomb)', { name: 'a', data: Buffer.alloc(5_000_000), usize: 1000 }, /expands beyond its declared size of 1000/],
    ['zip64 sizes that lie', { name: 'a', data: Buffer.alloc(100_000), zip64: { usize: 10 } }, /expands beyond its declared size of 10 /],
    ['data shorter than declared', { name: 'a', data: 'hello', method: 0, usize: 5, csize: 5, compressed: Buffer.from('hello') , crc: 0 }, /CRC/],
    ['a CRC that does not match', { name: 'a', data: 'hello', crc: 1234 }, /does not match its CRC/],
    ['truncated deflate data', { name: 'a', data: randomBytes(1000), compressed: zlib.deflateRawSync(randomBytes(1000)).subarray(0, 300), usize: 1000 }, /cannot be decompressed|is \d+ bytes, not the 1000/],
  ];
  for (const [what, entry, re] of inflating) {
    test(what, async () => {
      const file = await write(craftZip([entry]));
      const [e] = await readZip(file);
      await assert.rejects(
        (async () => {
          for await (const c of entryData(file, e)) void c;
        })(),
        (err) => err instanceof ZipError && re.test(err.message),
      );
    });
  }
});

describe('an import is checked before anything is built', () => {
  let shared;
  before(async () => {
    const f = path.join(dir, 'shared-src.sqlite');
    const db = new DatabaseSync(f);
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('x')");
    db.close();
    shared = await fs.readFile(f);
  });

  async function stage(entries, room = 1e9) {
    const file = await write(craftZip(entries));
    const work = path.join(dir, `work-${n++}`);
    return { work, result: stageImport(file, work, { room, now: Date.now() }) };
  }

  test('a valid export is staged: shared.sqlite, the index and the blobs', async () => {
    const files = [{ key: 'a.txt', data: 'aaa' }, { key: 'dir/b.bin', data: randomBytes(100), contentType: 'application/octet-stream' }, { key: 'same.txt', data: 'aaa' }];
    const { work, result } = await stage(exportEntries({ shared, files }));
    assert.deepEqual(await result, { shared: true, files: 3, data: null, bytes: shared.length + 3 + 100 });
    assert.deepEqual((await fs.readdir(path.join(work, 'blobs'))).sort(), [sha256('aaa'), sha256(Buffer.from(files[1].data))].sort());
    const db = new DatabaseSync(path.join(work, 'files.sqlite'), { readOnly: true });
    assert.deepEqual(db.prepare('SELECT key, size, content_type AS t FROM files ORDER BY key').all().map((r) => ({ ...r })), [
      { key: 'a.txt', size: 3, t: 'text/plain' },
      { key: 'dir/b.bin', size: 100, t: 'application/octet-stream' },
      { key: 'same.txt', size: 3, t: 'text/plain' },
    ]);
    db.close();
  });

  test('directory entries above the files are accepted', async () => {
    const entries = exportEntries({ files: [{ key: 'd/a.txt', data: 'a' }] });
    entries.push({ name: 'files/', data: '', method: 0, attrs: (0o040755 << 16) >>> 0 }, { name: 'files/data/d/', data: '', method: 0, madeBy: 0 });
    assert.equal((await (await stage(entries)).result).files, 1);
  });

  const good = () => exportEntries({ shared, files: [{ key: 'a.txt', data: 'aaa' }] });
  const bad = [
    ['an entry outside the layout', () => [...good(), { name: 'extra.txt', data: 'x' }], /"extra.txt" is not part of the export format/],
    ['a path that climbs out', () => [...good(), { name: 'files/data/../../etc/passwd', data: 'x' }], /has a "\.\." segment/],
    ['an absolute path', () => [...good(), { name: '/etc/passwd', data: 'x' }], /not part of the export format/],
    ['a backslash path', () => [...good(), { name: 'files/data/..\\x', data: 'x' }], /contains "\\"/],
    ['the same entry twice', () => [...good(), { name: 'files/data/a.txt', data: 'aaa' }], /"files\/data\/a.txt" is in the zip twice/],
    ['a key listed twice', () => exportEntries({ files: [{ key: 'a.txt', data: 'aaa' }], index: [
      { key: 'a.txt', contentType: 'text/plain', size: 3, sha256: sha256('aaa') },
      { key: 'a.txt', contentType: 'text/plain', size: 3, sha256: sha256('aaa') },
    ] }), /"a.txt" is listed twice/],
    ['an invalid key', () => exportEntries({ index: [{ key: 'a/../b', contentType: 'text/plain', size: 0, sha256: sha256('') }] }), /the key "a\/\.\.\/b" has a "\.\." segment/],
    ['a sha256 that does not match', () => exportEntries({ files: [{ key: 'a.txt', data: 'aaa' }], index: [{ key: 'a.txt', contentType: 'text/plain', size: 3, sha256: sha256('bbb') }] }), /does not match its sha256/],
    ['a size that does not match', () => exportEntries({ files: [{ key: 'a.txt', data: 'aaa' }], index: [{ key: 'a.txt', contentType: 'text/plain', size: 4, sha256: sha256('aaa') }] }), /is 3 bytes, but files\/index.json says 4/],
    ['a file not in the index', () => [...exportEntries({ files: [] }), { name: 'files/data/x', data: 'x' }], /"files\/data\/x" is not listed in files\/index.json/],
    ['an index entry without its file', () => exportEntries({ index: [{ key: 'x', contentType: 'text/plain', size: 1, sha256: sha256('x') }] }), /files\/data\/x is missing/],
    ['no manifest', () => good().slice(1), /manifest.json is missing/],
    ['another format', () => exportEntries({ manifest: { format: 'zip', formatVersion: 1 } }), /format is not "specola-backend-data"/],
    ['a newer formatVersion', () => exportEntries({ manifest: { format: 'specola-backend-data', formatVersion: 2, page: { id: 'p', title: '', version: 1 }, exportedAt: '2026-01-01T00:00:00Z' } }), /formatVersion 2 is not supported/],
    ['a manifest that is not JSON', () => [{ name: 'manifest.json', data: '{' }, ...good().slice(1)], /manifest.json is not valid JSON/],
    ['an index that is not a list', () => exportEntries({ index: {} }), /files\/index.json is not a list/],
    ['a shared.sqlite that is not SQLite', () => exportEntries({ shared: Buffer.from('not a database'.repeat(10)) }), /shared.sqlite is not a SQLite database/],
    ['a damaged shared.sqlite', () => {
      const broken = Buffer.from(shared);
      broken.fill(0xff, 100, broken.length); // the header survives, the pages do not
      return exportEntries({ shared: broken });
    }, /shared.sqlite (is damaged|cannot be opened)/],
    ['a symbolic link', () => [...good(), { name: 'files/data/link', data: '/etc/passwd', method: 0, attrs: (0o120777 << 16) >>> 0 }], /symbolic link/],
    ['an encrypted entry', () => good().map((e) => (e.name === 'files/data/a.txt' ? { ...e, flags: 1 } : e)), /is encrypted/],
    ['a bomb', () => exportEntries({ files: [{ key: 'z', data: Buffer.alloc(3_000_000) }], index: [{ key: 'z', contentType: 'text/plain', size: 100, sha256: sha256(Buffer.alloc(100)) }] }).map((e) => (e.name === 'files/data/z' ? { ...e, usize: 100 } : e)), /expands beyond its declared size of 100/],
    ['zip64 sizes that lie', () => exportEntries({ files: [{ key: 'z', data: Buffer.alloc(100_000) }], index: [{ key: 'z', contentType: 'text/plain', size: 10, sha256: sha256(Buffer.alloc(10)) }] }).map((e) => (e.name === 'files/data/z' ? { ...e, zip64: { usize: 10 } } : e)), /expands beyond its declared size of 10 /],
  ];
  for (const [what, entries, re] of bad) {
    test(`refuses ${what}`, async () => {
      const { result } = await stage(entries());
      await assert.rejects(result, (err) => {
        assert.ok(err instanceof RunnerError, err.stack);
        assert.equal(err.status, 400);
        assert.equal(err.code, 'bad-import');
        assert.match(err.message, re);
        return true;
      });
    });
  }

  test('refuses data over the room the page has, before inflating it', async () => {
    const { work, result } = await stage(exportEntries({ files: [{ key: 'big', data: Buffer.alloc(200_000) }] }), 100_000);
    await assert.rejects(result, /takes 200000 bytes, more than the page has room for \(100000 bytes\)/);
    await assert.rejects(fs.access(path.join(work, 'blobs')), 'nothing was written');
  });

  test('refuses one sha256 listed with two sizes, before inflating it', async () => {
    // The big entry first: counted once at the small size, it would be
    // inflated in full before the small one fails its check.
    const big = Buffer.alloc(2_000_000);
    const sha = sha256(big);
    const index = [
      { key: 'a', contentType: 'text/plain', size: big.length, sha256: sha },
      { key: 'b', contentType: 'text/plain', size: 1, sha256: sha },
    ];
    const entries = [...exportEntries({ index }), { name: 'files/data/a', data: big }, { name: 'files/data/b', data: 'x' }];
    const { work, result } = await stage(entries, 1000);
    await assert.rejects(result, /lists the sha256 [0-9a-f]{64} with two different sizes/);
    await assert.rejects(fs.access(path.join(work, 'blobs')), 'nothing was written');
  });

  test('stages the same content once', async () => {
    const files = [{ key: 'a', data: 'same' }, { key: 'b', data: 'same' }, { key: 'c', data: 'same' }];
    const { work, result } = await stage(exportEntries({ files }), 4);
    assert.deepEqual(await result, { shared: false, files: 3, data: null, bytes: 4 });
    assert.deepEqual(await fs.readdir(path.join(work, 'blobs')), [sha256('same')]);
  });

  test('checks every copy of the same content', async () => {
    const index = ['a', 'b'].map((key) => ({ key, contentType: 'text/plain', size: 4, sha256: sha256('same') }));
    const { result } = await stage([...exportEntries({ index }), { name: 'files/data/a', data: 'same' }, { name: 'files/data/b', data: 'diff' }]);
    await assert.rejects(result, /files\/data\/b does not match its sha256/);
  });
});
