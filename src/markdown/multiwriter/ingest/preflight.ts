import { scanUtf8 } from './utf8.js';
import {
  DEFAULT_INGEST_LIMITS,
  IngestCapacityError,
  IngestDataError,
  assertLimit,
} from './work.js';
import type { Work } from './work.js';

/** Pinned Yjs 13.6.33 update-v1 subset. This runs BEFORE either Yjs decoder. */
export function preflightUpdate(
  bytes: Uint8Array,
  stage: 'carrier' | 'native',
  operations = DEFAULT_INGEST_LIMITS.decodeOperations as number,
): void {
  assertLimit(operations);
  const work = scanUpdate(bytes, stage);
  for (let i = 0; i < operations; i++) if (work.next().done) return;
  work.return();
  throw new IngestCapacityError(stage, 'decodeOperations', operations + 1);
}

/** Visits varuint bytes, structs, values and each 1 KiB of payload. No input-sized allocation. */
export function* scanUpdate(bytes: Uint8Array, stage: 'carrier' | 'native'): Work<void> {
  let offset = 0;
  const fail = (code: string, message: string): never => {
    throw new IngestDataError(stage, code, message);
  };
  function byte(): number {
    if (offset === bytes.length) fail('encoding', 'Truncated Yjs update');
    return bytes[offset++];
  }
  function* uint(): Work<number> {
    let value = 0;
    let factor = 1;
    for (let i = 0; i < 8; i++) {
      yield;
      const next = byte();
      value += (next & 127) * factor;
      if (!Number.isSafeInteger(value)) fail('encoding', 'Yjs integer overflow');
      if (next < 128) return value;
      factor *= 128;
    }
    return fail('encoding', 'Yjs integer overflow');
  }
  function* buffer(): Work<Uint8Array> {
    const length = yield* uint();
    if (length > bytes.length - offset) fail('encoding', 'Truncated Yjs buffer');
    const data = bytes.subarray(offset, offset + length);
    offset += length;
    for (let i = 0; i < length; i += 1024) yield;
    return data;
  }
  function* text(): Work<string> {
    const data = yield* buffer();
    yield* scanUtf8(data, stage);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  }
  function* id(): Work<void> {
    if ((yield* uint()) > 0xffffffff) fail('encoding', 'Invalid Yjs client');
    yield* uint();
  }
  const clients = yield* uint();
  if (clients > bytes.length - offset) fail('encoding', 'Inflated Yjs client count');
  const seen = new Set<number>();
  for (let c = 0; c < clients; c++) {
    const count = yield* uint();
    const client = yield* uint();
    let clock = yield* uint();
    if (!count || count > bytes.length - offset || client > 0xffffffff || seen.has(client))
      fail('encoding', 'Invalid Yjs client block');
    seen.add(client);
    for (let index = 0; index < count; index++) {
      yield;
      const info = byte();
      const content = info & 31;
      if (content === 10 && info === 10) {
        const length = yield* uint();
        if (!length || !Number.isSafeInteger(clock + length)) fail('encoding', 'Invalid skip');
        clock += length;
        continue;
      }
      if (info & 32) fail('content', 'Map writes are prohibited');
      if (stage === 'carrier' ? content !== 3 && content !== 8 : content !== 4 && content !== 5)
        fail(
          'content',
          'Only append-only carrier bytes/native string and marker insertions are permitted',
        );
      if (info & 128) yield* id();
      if (info & 64) yield* id();
      if (!(info & 192)) {
        if ((yield* uint()) !== 1) fail('parent', 'Nested shared types are prohibited');
        const name = yield* text();
        if (stage === 'carrier' && name !== 'envelopes') fail('parent', 'Unknown carrier root');
      }
      let length = 1;
      if (content === 3) yield* buffer();
      else if (content === 8) {
        length = yield* uint();
        if (!length || length > bytes.length - offset) fail('encoding', 'Inflated carrier array');
        for (let i = 0; i < length; i++) {
          yield;
          if (byte() !== 116) fail('content', 'Canonical entry must be an encoded envelope');
          yield* buffer();
        }
      } else if (content === 4) {
        length = (yield* text()).length;
        if (!length) fail('content', 'Empty native string');
      } else {
        const json = yield* text();
        // ContentEmbed v1 uses JSON. Only this flat object is legal; do not parse arbitrary JSON.
        // A flat pair of JSON strings is safe to parse without recursive objects/arrays.
        if (
          // eslint-disable-next-line no-control-regex
          !/^[ \t\r\n]*\{[ \t\r\n]*"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"[ \t\r\n]*:[ \t\r\n]*"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"[ \t\r\n]*\}[ \t\r\n]*$/.test(
            json,
          )
        )
          fail('content', 'Unsupported native embed');
        const embed = JSON.parse(json) as Record<string, string>;
        if (!Object.hasOwn(embed, 'grainMarker')) fail('content', 'Unsupported native embed');
      }
      if (!Number.isSafeInteger(clock + length)) fail('encoding', 'Yjs clock overflow');
      clock += length;
    }
  }
  if ((yield* uint()) !== 0) fail('deletion', 'Native deletion violates append-only storage');
  if (offset !== bytes.length) fail('encoding', 'Trailing Yjs update data');
}
