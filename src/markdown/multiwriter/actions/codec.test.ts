import { describe, expect, it } from 'vitest';
import { MAX_COUNTER } from '../contracts.js';
import type { ActionEnvelope } from '../contracts.js';
import { decodeCbor, encodeCbor } from './cbor.js';
import type { CborValue } from './cbor.js';
import { decodeEnvelope, encodeEnvelope, EnvelopeDecodeError } from './codec.js';
import { action, fullEnvelope } from './test-fixtures.js';
const hex = (value: Uint8Array) =>
  Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (b) => parseInt(b, 16));

it.each([
  [0n, '00'],
  [23n, '17'],
  [24n, '1818'],
  [255n, '18ff'],
  [256n, '190100'],
  [65535n, '19ffff'],
  [65536n, '1a00010000'],
  [4294967296n, '1b0000000100000000'],
  [MAX_COUNTER, '1bffffffffffffffff'],
  [false, 'f4'],
  [true, 'f5'],
  [null, 'f6'],
  ['IETF', '6449455446'],
  [new Uint8Array([1, 2]), '420102'],
  [[1n, 2n], '820102'],
])('uses RFC 8949 preferred bytes for %s', (value, expected) => {
  expect(hex(encodeCbor(value))).toBe(expected);
  expect(decodeCbor(bytes(expected))).toEqual(value);
});
it('sorts encoded map keys bytewise, independent of object insertion order', () => {
  const expected = 'a261620162616102';
  expect(hex(encodeCbor({ aa: 2n, b: 1n }))).toBe(expected);
  expect(hex(encodeCbor({ b: 1n, aa: 2n }))).toBe(expected);
});
it.each([
  '1800',
  '190018',
  '1a00000100',
  '1b0000000000010000', // nonpreferred integers
  '5800',
  '7800',
  '9800',
  'b800', // nonpreferred lengths
  '9fff',
  '5fff',
  '7fff',
  'bfff', // indefinite length
  '20',
  'c000',
  'f7',
  'f90000',
  'fa00000000',
  'fb0000000000000000', // outside schema subset
  '00ff',
  '18',
  '1b00',
  '436162',
  '6261',
  '8200',
  'a16161', // trailing/truncated
  'a2616100616101',
  'a2616200616101',
  'a10000', // duplicate, out-of-order, nontext key
  '63eda080',
  '62c080',
  '61ff', // invalid UTF-8
])('rejects malformed/noncanonical CBOR %s', (value) => {
  expect(() => decodeCbor(bytes(value))).toThrow();
});
it('preserves UTF-8 text including an initial BOM and supplementary characters', () => {
  const text = '\ufeff😀e\u0301';
  expect(decodeCbor(encodeCbor(text))).toBe(text);
});
it('encodes actor IDs as 16 bytes and counters as exact unsigned uint64', () => {
  const value = {
    ...action(),
    id: { ...action().id, sequence: MAX_COUNTER },
    lamport: 9007199254740993n,
  };
  const wire = decodeCbor(encodeEnvelope(value)) as Record<string, unknown>;
  expect((wire.id as Record<string, unknown>).actor).toEqual(
    bytes('00000000000000000000000000000001'),
  );
  expect(decodeEnvelope(encodeEnvelope(value))).toEqual(value);
});
it('is deterministic across object key orders, retains exact native bodies and copies bytes', () => {
  const value = fullEnvelope();
  const reversed = Object.fromEntries(Object.entries(value).reverse()) as unknown as ActionEnvelope;
  expect(encodeEnvelope(reversed)).toEqual(encodeEnvelope(value));
  const encoded = encodeEnvelope(value);
  const decoded = decodeEnvelope(encoded);
  encoded.fill(0);
  expect(decoded.nativeInsertUpdates[0]).toEqual(new Uint8Array([0, 128, 255]));
});

describe('schema boundary', () => {
  it.each([
    { lamport: -1n },
    { lamport: MAX_COUNTER + 1n },
    { lamport: 1 },
    { id: { ...action().id, sequence: -1n } },
    { id: { ...action().id, actor: 'A'.repeat(32) } },
    { documentId: '\ud800' },
    { effects: [{ type: 'Unknown' }] },
    { effects: [{ type: 'SetProperties', node: { kind: 'flow' }, values: {} }] },
    { unexpected: true },
    { allocations: undefined },
    { dependencies: [null] },
    { nativeInsertUpdates: [[1, 2]] },
  ])('rejects invalid logical fields %#', (patch) => {
    expect(() => encodeEnvelope({ ...action(), ...patch } as ActionEnvelope)).toThrow();
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe native integers %s',
    (client) => {
      const value = fullEnvelope();
      expect(() =>
        encodeEnvelope({
          ...value,
          nativeManifest: [
            {
              type: 'text',
              tape: value.nativeManifest[0].tape,
              text: '😀',
              native: { client, clock: 0, length: 2 },
            },
          ],
        }),
      ).toThrow();
    },
  );
  it('rejects unsupported versions with a stable identity for quarantine', () => {
    const wire = decodeCbor(encodeEnvelope(action())) as Record<string, never>;
    const encoded = encodeCbor({ ...wire, protocolVersion: 4n });
    try {
      decodeEnvelope(encoded);
      expect.fail('Expected version error');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeDecodeError);
      expect(error).toMatchObject({ reason: 'version', id: action().id });
    }
  });
  it('rejects malformed wire fields without rounding integers or accepting text actors', () => {
    const wire = decodeCbor(encodeEnvelope(action())) as Record<string, never>;
    for (const patch of [
      { id: { actor: action().id.actor, sequence: 1n } },
      { id: { actor: new Uint8Array(15), sequence: 1n } },
      { protocolVersion: 9007199254740992n },
      { effects: [{ type: 'SetProperties', node: null, values: {} }] },
    ])
      expect(() =>
        decodeEnvelope(encodeCbor({ ...wire, ...patch } as unknown as CborValue)),
      ).toThrow();
  });
});

it('round trips every schema-3 allocation, manifest and effect shape', () => {
  expect(decodeEnvelope(encodeEnvelope(fullEnvelope()))).toEqual(fullEnvelope());
});
// Exhaustive prefix decoding exceeds the default timeout on slower CI runners.
it('rejects every truncated prefix of a full envelope', () => {
  const encoded = encodeEnvelope(fullEnvelope());
  for (let length = 0; length < encoded.length; length++)
    expect(() => decodeEnvelope(encoded.subarray(0, length))).toThrow();
}, 20_000);

it('pins the complete empty schema-3 envelope wire representation', () => {
  expect(hex(encodeEnvelope(action()))).toBe(
    'ab626964a2656163746f7250000000000000000000000000000000016873657175656e6365016765666665637473806767726f75704964a26773657373696f6ea2656163746f725000000000000000000000000000000001656c6f63616c66656469746f726873657175656e636501676c616d706f7274016967656e65736973496461476a646f63756d656e74496461446b616c6c6f636174696f6e73806c646570656e64656e63696573806e6e61746976654d616e6966657374806f70726f746f636f6c56657273696f6e03736e6174697665496e736572745570646174657380',
  );
});
