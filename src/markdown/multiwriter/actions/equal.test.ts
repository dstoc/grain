import { expect, test } from 'vitest';
import { sameEnvelopeData } from './equal.js';
import { encodeEnvelope } from './codec.js';
import { compareBytes } from './cbor.js';
import { fullEnvelope } from './test-fixtures.js';

test('exact positive envelope comparison preserves all fields, order and native bytes', () => {
  const original = fullEnvelope();
  const copy = structuredClone(original);
  expect(sameEnvelopeData(copy, original)).toBe(true);
  expect(compareBytes(encodeEnvelope(copy), encodeEnvelope(original))).toBe(0);
  const reordered = Object.fromEntries(Object.entries(copy).reverse()) as unknown as typeof copy;
  expect(sameEnvelopeData(reordered, original)).toBe(true);
  for (const mutate of [
    (value: typeof copy) => {
      Object.assign(value.id, { sequence: 2n });
    },
    (value: typeof copy) => {
      value.nativeInsertUpdates[0][0] ^= 1;
    },
    (value: typeof copy) => {
      (value.effects as unknown[]).reverse();
    },
    (value: typeof copy) => {
      Object.assign(value.allocations[0].id, { ordinal: 999 });
    },
    (value: typeof copy) => {
      Object.assign(value, { nativeManifest: [] });
    },
    (value: typeof copy) => {
      Object.assign(value, { dependencies: [value.id] });
    },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    expect(sameEnvelopeData(changed, original)).toBe(false);
    expect(compareBytes(encodeEnvelope(changed), encodeEnvelope(original))).not.toBe(0);
  }
});

test('accessors, non-enumerable properties and cyclic extras decline without reading getters', () => {
  const original = fullEnvelope();
  const hidden = structuredClone(original);
  Object.defineProperty(hidden, 'lamport', { enumerable: false, value: 99n });
  expect(sameEnvelopeData(hidden, original)).toBe(false);
  const getter = structuredClone(original);
  Object.defineProperty(getter, 'lamport', {
    enumerable: true,
    get() {
      throw new Error('Host getter');
    },
  });
  expect(sameEnvelopeData(getter, original)).toBe(false);
  const a = Object.assign(structuredClone(original), { extra: {} });
  const b = Object.assign(structuredClone(original), { extra: {} });
  a.extra = a;
  b.extra = b;
  expect(sameEnvelopeData(a, b)).toBe(false);
  expect(() => encodeEnvelope(a)).toThrow();
  expect(() => encodeEnvelope(b)).toThrow();
});
