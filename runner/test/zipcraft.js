// Hand-made zips for tests, with every field under the test's control, so
// a test can build the lies an attacker would (sizes, CRCs, flags, links,
// zip64 fields that do not match the data).

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/**
 * entries: [{name, data, method = 8, flags = 0, attrs = 0o100644 << 16,
 * madeBy = 3, usize, csize, crc, zip64: {usize?, csize?} (central directory
 * values in a zip64 extra field), localName}].
 */
export function craftZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const method = e.method ?? 8;
    const comp = e.compressed ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = e.crc ?? zlib.crc32(data);
    const usize = e.usize ?? data.length;
    const csize = e.csize ?? comp.length;
    const name = Buffer.from(e.name, 'utf8');
    const lname = Buffer.from(e.localName ?? e.name, 'utf8');
    const flags = (e.flags ?? 0) | 0x0800;
    const z64 = e.zip64;
    const local = Buffer.concat([
      u32(0x04034b50), u16(z64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x5b79),
      u32(crc), u32(z64 ? 0xffffffff : csize), u32(z64 ? 0xffffffff : usize), u16(lname.length), u16(0), lname, comp,
    ]);
    const extra = z64 ? Buffer.concat([u16(1), u16(16), u64(z64.usize ?? usize), u64(z64.csize ?? csize)]) : Buffer.alloc(0);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(((e.madeBy ?? 3) << 8) | 45), u16(z64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x5b79),
      u32(crc), u32(z64 ? 0xffffffff : csize), u32(z64 ? 0xffffffff : usize), u16(name.length), u16(extra.length), u16(0),
      u16(0), u16(0), u32(e.attrs ?? (0o100644 << 16) >>> 0), u32(e.offset ?? offset), name, extra,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, cd, end]);
}

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * The entries of a valid export: manifest, an optional shared.sqlite,
 * files/index.json and each file. `files`: [{key, contentType, data}].
 */
export function exportEntries({ shared, files = [], manifest, index } = {}) {
  const man = manifest ?? { format: 'specola-backend-data', formatVersion: 1, page: { id: 'p', title: 'T', version: 1 }, exportedAt: '2026-11-25T00:00:00.000Z' };
  const idx = index ?? files.map((f) => ({ key: f.key, contentType: f.contentType ?? 'text/plain', size: Buffer.from(f.data).length, sha256: sha256(Buffer.from(f.data)) }));
  return [
    { name: 'manifest.json', data: JSON.stringify(man) },
    ...(shared ? [{ name: 'shared.sqlite', data: shared, method: 0 }] : []),
    { name: 'files/index.json', data: JSON.stringify(idx) },
    ...files.map((f) => ({ name: `files/data/${f.key}`, data: f.data })),
  ];
}
