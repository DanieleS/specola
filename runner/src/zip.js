// Just enough zip for the data export and import (docs/page-backends.md,
// "Export zip"), written by hand: no npm dependencies.
//
// The writer streams: each entry is a local header with sizes and CRC left
// for a data descriptor after the data (bit 3), so nothing is held in memory
// or read twice. Entries whose size is near 4 GiB get zip64 fields, and so do
// the central directory and the end record when offsets or counts need it.
//
// The reader takes a zip that is already on disk (an upload, untrusted) and
// trusts nothing in it: the central directory is parsed with every bound
// checked, each local header is checked against it, entries may not overlap
// (the "overlapping files" bomb), encrypted entries, methods other than
// stored and deflate, and links are refused, and while an entry is inflated
// its output is held to the size it declares and checked against its CRC.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const UNIX = 3;
// Past this an entry's sizes may not fit in 32 bits (deflate can grow
// incompressible data a little): it gets zip64 fields.
const ZIP64_ENTRY = 0xffff0000;
// Deflate cannot expand data by much more than 1032:1. An entry that
// declares more than this is lying about its size; it is refused before
// anything is inflated.
export const MAX_RATIO = 1100;

/** A problem with the zip itself; its message names it. */
export class ZipError extends Error {}

// --- writer -------------------------------------------------------------------

function dosTime(date) {
  const d = new Date(Math.max(date.getTime(), Date.UTC(1980, 0, 1)));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Streams a zip of `entries`, an iterable of {name, size, method, data},
 * where size is the entry's uncompressed size as known up front (it decides
 * zip64), method 0 (stored) or 8 (deflate), and data() returns an async
 * iterable of Buffers. Yields Buffers. zip64At is the size from which an
 * entry gets zip64 fields (tests lower it).
 */
export async function* zipStream(entries, { date = new Date(), zip64At = ZIP64_ENTRY } = {}) {
  const { time, date: dosDate } = dosTime(date);
  const central = [];
  let offset = 0;
  for await (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const zip64 = e.size >= zip64At;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    // CRC and sizes are in the descriptor; zip64 says so with 0xffffffff
    // and an extra field (zeros), so readers expect 8-byte descriptor sizes.
    local.writeUInt32LE(zip64 ? MAX32 : 0, 18);
    local.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    local.writeUInt16LE(name.length, 26);
    const extra = zip64 ? Buffer.concat([u16(1), u16(16), Buffer.alloc(16)]) : Buffer.alloc(0);
    local.writeUInt16LE(extra.length, 28);
    const head = Buffer.concat([local, name, extra]);
    const start = offset;
    yield head;
    offset += head.length;

    let crc = 0;
    let usize = 0;
    let csize = 0;
    const counted = (async function* () {
      for await (const chunk of e.data()) {
        crc = zlib.crc32(chunk, crc);
        usize += chunk.length;
        yield chunk;
      }
    })();
    let out = counted;
    if (e.method === 8) {
      const deflate = zlib.createDeflateRaw({ level: 6 });
      pipeline(Readable.from(counted), deflate).catch((err) => deflate.destroy(err));
      out = deflate;
    }
    for await (const chunk of out) {
      csize += chunk.length;
      yield chunk;
    }
    offset += csize;
    if (!zip64 && (usize > MAX32 || csize > MAX32)) {
      throw new Error(`${e.name} grew past 4 GiB while it was being written`);
    }
    const desc = zip64 ? Buffer.alloc(24) : Buffer.alloc(16);
    desc.writeUInt32LE(SIG_DESCRIPTOR, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    if (zip64) {
      desc.writeBigUInt64LE(BigInt(csize), 8);
      desc.writeBigUInt64LE(BigInt(usize), 16);
    } else {
      desc.writeUInt32LE(csize, 8);
      desc.writeUInt32LE(usize, 12);
    }
    yield desc;
    offset += desc.length;
    central.push({ name, method: e.method, crc: crc >>> 0, csize, usize, offset: start, zip64 });
  }

  const cdStart = offset;
  for (const c of central) {
    // A zip64 entry carries both sizes in its extra field here too, as its
    // local header said it would (some readers compare the two).
    const big = [];
    const sizes64 = c.zip64 || c.usize >= MAX32 || c.csize >= MAX32;
    if (sizes64) big.push(c.usize, c.csize);
    if (c.offset >= MAX32) big.push(c.offset);
    const extra = big.length ? Buffer.concat([u16(1), u16(big.length * 8), ...big.map(u64)]) : Buffer.alloc(0);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(SIG_CENTRAL, 0);
    h.writeUInt16LE((UNIX << 8) | 45, 4);
    h.writeUInt16LE(big.length ? 45 : 20, 6);
    h.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
    h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(time, 12);
    h.writeUInt16LE(dosDate, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(sizes64 ? MAX32 : c.csize, 20);
    h.writeUInt32LE(sizes64 ? MAX32 : c.usize, 24);
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    h.writeUInt32LE(Math.min(c.offset, MAX32), 42);
    const rec = Buffer.concat([h, c.name, extra]);
    yield rec;
    offset += rec.length;
  }
  const cdSize = offset - cdStart;
  const n = central.length;
  if (n >= MAX16 || cdSize >= MAX32 || cdStart >= MAX32) {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(SIG_END64, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE((UNIX << 8) | 45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(n), 24);
    end64.writeBigUInt64LE(BigInt(n), 32);
    end64.writeBigUInt64LE(BigInt(cdSize), 40);
    end64.writeBigUInt64LE(BigInt(cdStart), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(SIG_LOCATOR64, 0);
    locator.writeBigUInt64LE(BigInt(offset), 8);
    locator.writeUInt32LE(1, 16);
    yield Buffer.concat([end64, locator]);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(Math.min(n, MAX16), 8);
  end.writeUInt16LE(Math.min(n, MAX16), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
  yield end;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

// --- reader -------------------------------------------------------------------

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  if (bytesRead !== len) throw new ZipError('the zip is truncated');
  return buf;
}

function num64(buf, pos) {
  const v = buf.readBigUInt64LE(pos);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('the zip declares a size or offset that is too large');
  return Number(v);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Reads the central directory of the zip at `file`. Returns its entries:
 * {name, dir, method, crc, csize, usize, dataStart}. Throws ZipError.
 */
export async function readZip(file, { maxEntries = 1_000_000, maxCentralBytes = 64 * 1024 * 1024 } = {}) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipError('it is not a zip (too short)');
    const tailLen = Math.min(size, 22 + MAX16);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let endPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      // The record's own comment length must take it exactly to the end.
      if (tail.readUInt32LE(i) === SIG_END && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        endPos = i;
        break;
      }
    }
    if (endPos < 0) throw new ZipError('it is not a zip (no end of central directory)');
    const absEnd = size - tailLen + endPos;
    if (tail.readUInt16LE(endPos + 4) !== 0 || tail.readUInt16LE(endPos + 6) !== 0) throw new ZipError('multi-part zips are not supported');
    let count = tail.readUInt16LE(endPos + 10);
    let cdSize = tail.readUInt32LE(endPos + 12);
    let cdStart = tail.readUInt32LE(endPos + 16);
    let cdLimit = absEnd; // the central directory ends before the end records
    if (count === MAX16 || cdSize === MAX32 || cdStart === MAX32) {
      if (absEnd < 20) throw new ZipError('the zip64 end locator is missing');
      const loc = await readAt(fh, absEnd - 20, 20);
      if (loc.readUInt32LE(0) !== SIG_LOCATOR64) throw new ZipError('the zip64 end locator is missing');
      const end64Pos = num64(loc, 8);
      if (end64Pos + 56 > absEnd - 20) throw new ZipError('the zip64 end record is out of bounds');
      const end64 = await readAt(fh, end64Pos, 56);
      if (end64.readUInt32LE(0) !== SIG_END64) throw new ZipError('the zip64 end record is missing');
      count = num64(end64, 32);
      cdSize = num64(end64, 40);
      cdStart = num64(end64, 48);
      cdLimit = end64Pos;
    }
    if (count > maxEntries) throw new ZipError(`it has ${count} entries (max ${maxEntries})`);
    if (cdSize > maxCentralBytes) throw new ZipError('its central directory is too large');
    if (cdStart + cdSize > cdLimit) throw new ZipError('its central directory is out of bounds');
    const cd = await readAt(fh, cdStart, cdSize);

    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('its central directory is damaged');
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const disk = cd.readUInt16LE(p + 34);
      const attrs = cd.readUInt32LE(p + 38);
      let offset = cd.readUInt32LE(p + 42);
      const end = p + 46 + nameLen + extraLen + commentLen;
      if (end > cd.length) throw new ZipError('its central directory is damaged');
      let name;
      try {
        name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
      } catch {
        throw new ZipError('an entry name is not valid UTF-8');
      }
      const shown = JSON.stringify(name);
      // zip64: the fields set to 0xffffffff are in the extra field, in order.
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      const wanted = [usize === MAX32, csize === MAX32, offset === MAX32];
      if (wanted.some(Boolean) || disk === MAX16) {
        const z = findExtra(extra, 1);
        const need = wanted.filter(Boolean).length * 8;
        if (!z || z.length < need) throw new ZipError(`${shown} has a damaged zip64 extra field`);
        let q = 0;
        if (wanted[0]) (usize = num64(z, q)), (q += 8);
        if (wanted[1]) (csize = num64(z, q)), (q += 8);
        if (wanted[2]) (offset = num64(z, q)), (q += 8);
      } else if (disk !== 0) {
        throw new ZipError('multi-part zips are not supported');
      }
      if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ZipError(`${shown} is encrypted`);
      if (method !== 0 && method !== 8) throw new ZipError(`${shown} uses compression method ${method} (only stored and deflate are accepted)`);
      const dir = name.endsWith('/');
      if (madeBy === UNIX) {
        const type = (attrs >>> 16) & 0o170000;
        if (type === 0o120000) throw new ZipError(`${shown} is a symbolic link`);
        if (type !== 0 && type !== (dir ? 0o040000 : 0o100000)) throw new ZipError(`${shown} is not a regular file`);
      }
      if (dir && usize !== 0) throw new ZipError(`${shown} is a directory with contents`);
      if (method === 0 && csize !== usize) throw new ZipError(`${shown} is stored, but its sizes differ`);
      if (method === 8 && usize > csize * MAX_RATIO + 1024) throw new ZipError(`${shown} declares a size its compressed data cannot have (a zip bomb?)`);
      entries.push({ name, dir, method, flags, crc, csize, usize, offset });
      p = end;
    }

    // Each local header must agree with the central directory, and the
    // entries' data may not overlap each other or the central directory.
    for (const e of entries) {
      if (e.offset + 30 > cdStart) throw new ZipError(`${JSON.stringify(e.name)} is out of bounds`);
      const h = await readAt(fh, e.offset, 30);
      if (h.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError(`${JSON.stringify(e.name)} has no local header`);
      const lflags = h.readUInt16LE(6);
      if (lflags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ZipError(`${JSON.stringify(e.name)} is encrypted`);
      if (h.readUInt16LE(8) !== e.method) throw new ZipError(`${JSON.stringify(e.name)}: its local header disagrees with the central directory`);
      const nameLen = h.readUInt16LE(26);
      const extraLen = h.readUInt16LE(28);
      const lname = await readAt(fh, e.offset + 30, nameLen);
      if (!lname.equals(Buffer.from(e.name, 'utf8'))) throw new ZipError(`${JSON.stringify(e.name)}: its local header names another file`);
      e.dataStart = e.offset + 30 + nameLen + extraLen;
      if (!(lflags & FLAG_DESCRIPTOR)) {
        // Sizes in the local header must agree too (0xffffffff: zip64).
        const lcs = h.readUInt32LE(18);
        const lus = h.readUInt32LE(22);
        if (h.readUInt32LE(14) !== e.crc || (lcs !== MAX32 && lcs !== e.csize) || (lus !== MAX32 && lus !== e.usize)) {
          throw new ZipError(`${JSON.stringify(e.name)}: its local header disagrees with the central directory`);
        }
      }
      e.dataEnd = e.dataStart + e.csize;
      if (e.dataEnd > cdStart) throw new ZipError(`${JSON.stringify(e.name)} is out of bounds`);
    }
    const sorted = [...entries].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].offset < sorted[i - 1].dataEnd) throw new ZipError(`${JSON.stringify(sorted[i].name)} overlaps another entry (a zip bomb?)`);
    }
    return entries;
  } finally {
    await fh.close();
  }
}

function findExtra(extra, id) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const tag = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (p + 4 + len > extra.length) return null;
    if (tag === id) return extra.subarray(p + 4, p + 4 + len);
    p += 4 + len;
  }
  return null;
}

/**
 * The uncompressed bytes of an entry read by readZip, as an async iterable
 * of Buffers. Throws ZipError when the data inflates to more or less than
 * the entry declares or does not match its CRC: output never runs past the
 * declared size.
 */
export async function* entryData(file, e) {
  const name = JSON.stringify(e.name);
  if (e.csize === 0 && e.usize === 0) {
    if (e.crc !== 0) throw new ZipError(`${name} does not match its CRC`);
    return;
  }
  const raw = createReadStream(file, { start: e.dataStart, end: e.dataEnd - 1 });
  let src = raw;
  if (e.method === 8) {
    const inflate = zlib.createInflateRaw();
    pipeline(raw, inflate).catch((err) => inflate.destroy(err));
    src = inflate;
  }
  let n = 0;
  let crc = 0;
  try {
    for await (const chunk of src) {
      n += chunk.length;
      if (n > e.usize) throw new ZipError(`${name} expands beyond its declared size of ${e.usize} bytes (a zip bomb?)`);
      crc = zlib.crc32(chunk, crc);
      yield chunk;
    }
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError(`${name} cannot be decompressed (${err.code === 'Z_BUF_ERROR' ? 'its data is truncated' : err.message})`);
  } finally {
    src.destroy();
    raw.destroy();
  }
  if (n !== e.usize) throw new ZipError(`${name} is ${n} bytes, not the ${e.usize} it declares`);
  if (crc >>> 0 !== e.crc) throw new ZipError(`${name} does not match its CRC`);
}
