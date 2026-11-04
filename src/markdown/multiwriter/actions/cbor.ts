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
export function decodeCbor(bytes: Uint8Array): CborValue {
  let offset = 0;
  function take(length: number): Uint8Array {
    if (length > bytes.length - offset) throw new Error('Truncated CBOR');
    const result = bytes.subarray(offset, offset + length);
    offset += length;
    return result;
  }
  function read(): CborValue {
    const first = take(1)[0];
    if (first === 0xf4) return false;
    if (first === 0xf5) return true;
    if (first === 0xf6) return null;
    const major = first >> 5;
    const info = first & 31;
    if (![0, 2, 3, 4, 5].includes(major) || info > 27)
      throw new Error('Unsupported CBOR type or indefinite length');
    let n = BigInt(info);
    if (info >= 24) {
      const size = 1 << (info - 24);
      n = 0n;
      for (const byte of take(size)) n = (n << 8n) | BigInt(byte);
      const minimum = size === 1 ? 24n : 1n << BigInt((size / 2) * 8);
      if (n < minimum) throw new Error('Nonpreferred CBOR integer/length');
    }
    if (major === 0) return n;
    // Each container member consumes at least one byte. Check before allocation/iteration.
    if (n > BigInt(bytes.length - offset)) throw new Error('Truncated CBOR container');
    const length = Number(n);
    if (major === 2) return take(length).slice();
    if (major === 3) return textDecoder.decode(take(length));
    if (major === 4) return Array.from({ length }, () => read());
    const result: Record<string, CborValue> = Object.create(null);
    let previous: Uint8Array | undefined;
    for (let i = 0; i < length; i++) {
      const start = offset;
      const key = read();
      const encoded = bytes.subarray(start, offset);
      if (typeof key !== 'string') throw new Error('CBOR map key must be text');
      if (previous && compareBytes(previous, encoded) >= 0)
        throw new Error('Duplicate or unordered CBOR map key');
      previous = encoded;
      result[key] = read();
    }
    return result;
  }
  const result = read();
  if (offset !== bytes.length) throw new Error('Trailing CBOR data');
  return result;
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
