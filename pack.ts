// Git wire formats: pkt-line framing and packfiles (v2, zlib entries,
// OFS/REF deltas on read, plain entries on write). Written from the git
// protocol specification; no git binary is involved.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hashObject, type ObjType, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

const MAX_PKT = 65520;

/** Frame one payload as a pkt-line (4 hex length digits + payload). */
export function pkt(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (payload.length + 4 > MAX_PKT) throw new Error('pkt-line payload too large');
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  data: Buffer;
}

/**
 * Decode pkt-lines from the front of `buf`. Stops at the first flush/delim/
 * response-end or at the end of the buffer, and reports how many bytes were
 * consumed, so a caller can keep the remainder (pack bytes follow a flush).
 */
export function decodePkts(buf: Buffer, stopAtSpecial: boolean): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      off += 4;
      if (stopAtSpecial) break;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      off += 4;
      if (stopAtSpecial) break;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', data: Buffer.alloc(0) });
      off += 4;
      if (stopAtSpecial) break;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, consumed: off };
}

/** Decode every pkt-line in a buffer; trailing garbage is ignored. */
export function decodeAllPkts(buf: Buffer): Pkt[] {
  return decodePkts(buf, false).packets;
}

/** Strip a single trailing LF from a pkt-line payload, for text lines. */
export function pktText(data: Buffer): string {
  let text = data.toString('utf8');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

/** Frame sideband packets: one band byte + data chunks, each a pkt-line. */
export function sideband(band: 1 | 2 | 3, payload: Buffer, chunkSize = 32768): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < payload.length; off += chunkSize) {
    const chunk = payload.subarray(off, Math.min(payload.length, off + chunkSize));
    out.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (payload.length === 0) out.push(pkt(Buffer.from([band])));
  return out;
}

// ---------------------------------------------------------------------------
// Pack reading
// ---------------------------------------------------------------------------

const TYPE_BY_CODE: Record<number, ObjType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const CODE_BY_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackEntry {
  type: ObjType;
  data: Buffer;
}

/** Apply a git delta to a base object, producing the reconstructed object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('delta truncated');
      const b = delta[off++];
      out |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return out;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if ((op & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) {
        if ((op & (1 << i)) !== 0) {
          if (off >= delta.length) throw new Error('delta copy truncated');
          cpOff |= delta[off++] << (i * 8);
        }
      }
      for (let i = 0; i < 3; i++) {
        if ((op & (0x10 << i)) !== 0) {
          if (off >= delta.length) throw new Error('delta copy truncated');
          cpSize |= delta[off++] << (i * 8);
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta copy out of range');
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      if (off + op > delta.length) throw new Error('delta insert truncated');
      parts.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts, total);
  if (out.length !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

/**
 * Parse a packfile and return its objects. Deltas resolve against earlier
 * entries in the same pack or objects already in the repo (thin packs).
 * The trailer checksum is verified when present.
 */
export function readPack(pack: Buffer, repo: Repo): PackEntry[] {
  if (pack.length < 12) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Trailer: the last 20 bytes are the SHA-1 of everything before them.
  if (pack.length >= 32) {
    const want = pack.subarray(pack.length - 20);
    const got = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
    if (!want.equals(got)) throw new Error('pack checksum mismatch');
  }

  interface RawEntry {
    typeCode: number;
    baseOffset: number; // for OFS_DELTA
    baseOid: string; // for REF_DELTA
    data: Buffer; // inflated bytes (delta instructions for delta types)
    start: number;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const start = off;
    if (off >= pack.length) throw new Error('pack truncated');
    let b = pack[off++];
    const typeCode = (b >> 4) & 0x7;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (off >= pack.length) throw new Error('pack truncated');
      b = pack[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseOid = '';
    if (typeCode === 6) {
      // OFS_DELTA: negative offset, MSB-continuation varint.
      if (off >= pack.length) throw new Error('pack truncated');
      b = pack[off++];
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        if (off >= pack.length) throw new Error('pack truncated');
        b = pack[off++];
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base object id.
      if (off + 20 > pack.length) throw new Error('pack truncated');
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!(typeCode >= 1 && typeCode <= 4)) {
      throw new Error(`bad pack entry type ${typeCode}`);
    }
    // Inflate one zlib stream; the engine reports how many input bytes it took.
    const inflated = inflateSync(pack.subarray(off), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const consumed = inflated.engine.bytesWritten;
    if (!consumed || consumed <= 0) throw new Error('could not measure zlib stream');
    const data = inflated.buffer;
    if (data.length !== size && typeCode !== 6 && typeCode !== 7) {
      throw new Error('pack entry size mismatch');
    }
    off += consumed;
    byOffset.set(start, raw.length);
    raw.push({ typeCode, baseOffset, baseOid, data, start });
  }

  const resolved = new Map<number, PackEntry>();
  const resolve = (idx: number, depth: number): PackEntry => {
    if (depth > 1024) throw new Error('delta chain too deep');
    const done = resolved.get(idx);
    if (done) return done;
    const entry = raw[idx];
    let out: PackEntry;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      out = { type: TYPE_BY_CODE[entry.typeCode], data: entry.data };
    } else if (entry.typeCode === 6) {
      const baseIdx = byOffset.get(entry.baseOffset);
      if (baseIdx === undefined) throw new Error('ofs-delta base outside pack');
      const base = resolve(baseIdx, depth + 1);
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      // REF_DELTA: base may be in this pack or already in the repo.
      let base: PackEntry | null = null;
      for (let i = 0; i < raw.length; i++) {
        if (i === idx) continue;
        const candidate = resolve(i, depth + 1);
        if (hashObject(candidate.type, candidate.data) === entry.baseOid) {
          base = candidate;
          break;
        }
      }
      if (!base) {
        const held = repo.objects.get(entry.baseOid);
        if (held) base = { type: held.type, data: held.data };
      }
      if (!base) throw new Error('ref-delta base not found');
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolved.set(idx, out);
    return out;
  };

  const entries: PackEntry[] = [];
  for (let i = 0; i < raw.length; i++) entries.push(resolve(i, 0));
  return entries;
}

// ---------------------------------------------------------------------------
// Pack writing (plain entries, no deltas)
// ---------------------------------------------------------------------------

/** Encode a pack entry header: type + size varint. */
function entryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let b = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Build a packfile holding the given objects, in oid order, with a trailer. */
export function writePack(objects: Array<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    parts.push(entryHeader(CODE_BY_TYPE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
