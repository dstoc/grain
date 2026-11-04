import { scanUtf8 } from '../ingest/utf8.js';
import {
  DEFAULT_INGEST_LIMITS,
  IngestCapacityError,
  IngestDataError,
  finish,
} from '../ingest/work.js';
import type { Work } from '../ingest/work.js';

export class CborDecodeError extends IngestDataError {
  constructor(message: string) {
    super('envelope', 'cbor', message);
  }
}

/** The schema-3 CBOR subset: unsigned integers, bytes, UTF-8, arrays and text-keyed maps. */
export type CborValue =
  | bigint
  | string
  | boolean
  | null
  | Uint8Array
  | readonly CborValue[]
  | { readonly [key: string]: CborValue };
const MAX_UINT64 = (1n << 64n) - 1n;
const utf8 = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  function header(major: number, n: bigint): void {
    if (n < 0n || n > MAX_UINT64) throw new Error('CBOR integer overflow');
    if (n < 24n) out.push((major << 5) | Number(n));
    else {
      const size = n <= 0xffn ? 1 : n <= 0xffffn ? 2 : n <= 0xffffffffn ? 4 : 8;
      out.push((major << 5) | (size === 1 ? 24 : size === 2 ? 25 : size === 4 ? 26 : 27));
      for (let shift = (size - 1) * 8; shift >= 0; shift -= 8)
        out.push(Number((n >> BigInt(shift)) & 0xffn));
    }
  }
  function write(v: CborValue): void {
    if (v === null || typeof v === 'boolean') out.push(v === null ? 0xf6 : v ? 0xf5 : 0xf4);
    else if (typeof v === 'bigint') header(0, v);
    else if (typeof v === 'string' || v instanceof Uint8Array) {
      if (typeof v === 'string' && !isWellFormed(v)) throw new Error('Invalid Unicode string');
      const bytes = typeof v === 'string' ? utf8.encode(v) : v;
      header(typeof v === 'string' ? 3 : 2, BigInt(bytes.length));
      for (const byte of bytes) out.push(byte);
    } else if (Array.isArray(v)) {
      header(4, BigInt(v.length));
      for (const item of v) write(item);
    } else {
      const entries = Object.entries(v).map(([key, item]) => ({ key: encodeCbor(key), item }));
      entries.sort((a, b) => compareBytes(a.key, b.key));
      header(5, BigInt(entries.length));
      for (const { key, item } of entries) {
        for (const byte of key) out.push(byte);
        write(item);
      }
    }
  }
  write(value);
  return Uint8Array.from(out);
}

/** Reject nonpreferred encodings rather than silently normalizing immutable payloads. */
export function decodeCbor(
  bytes: Uint8Array,
  depth = DEFAULT_INGEST_LIMITS.depth as number,
): CborValue {
  return finish(decodeCborSteps(bytes, depth));
}

/** Iterative decoding: a visit per value and per 1 KiB of byte/string content. */
export function* decodeCborSteps(bytes: Uint8Array, depth: number): Work<CborValue> {
  let offset = 0;
  function take(length: number): Uint8Array {
    if (length > bytes.length - offset) throw new CborDecodeError('Truncated CBOR');
    const result = bytes.subarray(offset, offset + length);
    offset += length;
    return result;
  }
  type Frame = {
    remaining: number;
    value: CborValue[] | Record<string, CborValue>;
    map: boolean;
    key?: string;
    previous?: Uint8Array;
    start: number;
  };
  const stack: Frame[] = [];
  let result: CborValue | undefined;
  while (result === undefined || stack.length) {
    yield;
    const start = offset;
    const first = take(1)[0];
    let value: CborValue;
    if (first === 0xf4 || first === 0xf5 || first === 0xf6)
      value = first === 0xf6 ? null : first === 0xf5;
    else {
      const major = first >> 5;
      const info = first & 31;
      if (![0, 2, 3, 4, 5].includes(major) || info > 27)
        throw new CborDecodeError('Unsupported CBOR type or indefinite length');
      let n = BigInt(info);
      if (info >= 24) {
        const size = 1 << (info - 24);
        n = 0n;
        for (const byte of take(size)) n = (n << 8n) | BigInt(byte);
        const minimum = size === 1 ? 24n : 1n << BigInt((size / 2) * 8);
        if (n < minimum) throw new CborDecodeError('Nonpreferred CBOR integer/length');
      }
      if (major === 0) value = n;
      else {
        const members = major === 5 ? n * 2n : n;
        if (members > BigInt(bytes.length - offset))
          throw new CborDecodeError('Truncated CBOR container');
        const length = Number(n);
        if (major === 2 || major === 3) {
          const data = take(length);
          for (let i = 0; i < length; i += 1024) yield;
          if (major === 2) value = data.slice();
          else {
            yield* scanUtf8(data, 'envelope');
            value = textDecoder.decode(data);
          }
        } else {
          if (stack.length + 1 > depth)
            throw new IngestCapacityError('envelope', 'depth', stack.length + 1);
          value = major === 4 ? [] : Object.create(null);
          if (length) {
            stack.push({
              remaining: Number(members),
              value: value as Frame['value'],
              map: major === 5,
              start,
            });
            continue;
          }
        }
      }
    }
    let valueStart = start;
    for (;;) {
      const frame = stack.at(-1);
      if (!frame) {
        result = value;
        break;
      }
      if (!frame.map) (frame.value as CborValue[]).push(value);
      else if (frame.remaining % 2 === 0) {
        if (typeof value !== 'string') throw new CborDecodeError('CBOR map key must be text');
        const encoded = bytes.subarray(valueStart, offset);
        if (frame.previous && compareBytes(frame.previous, encoded) >= 0)
          throw new CborDecodeError('Duplicate or unordered CBOR map key');
        frame.previous = encoded;
        frame.key = value;
      } else (frame.value as Record<string, CborValue>)[frame.key!] = value;
      if (--frame.remaining) break;
      yield;
      stack.pop();
      value = frame.value;
      valueStart = frame.start;
    }
  }
  if (offset !== bytes.length) throw new CborDecodeError('Trailing CBOR data');
  return result!;
}

/** Reject isolated UTF-16 surrogates before TextEncoder could replace them. */
export function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
