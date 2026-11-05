import { expect, test } from 'vitest';
import { isImmutableData } from '../../../../test/multiwriter/immutable.js';

test('copy elision accepts only deeply frozen plain data, retaining mutable snapshot isolation', () => {
  const known = new WeakSet<object>();
  const immutable = Object.freeze({
    child: Object.freeze({ value: 1 }),
    list: Object.freeze([1, 2n]),
  });
  expect(isImmutableData(immutable, known)).toBe(true);
  expect(isImmutableData(immutable, known)).toBe(true);
  const mutable = Object.freeze({ child: { value: 1 } });
  expect(isImmutableData(mutable, known)).toBe(false);
  const before = structuredClone(mutable);
  mutable.child.value = 2;
  expect(before.child.value).toBe(1);
  expect(isImmutableData(mutable, known)).toBe(false);
  for (const value of [
    Object.freeze(new Map()),
    Object.freeze(new Set()),
    Object.freeze(new Date()),
    Object.freeze(new Uint8Array()),
  ])
    expect(isImmutableData(value, known)).toBe(false);
});

test('frozen accessors, hidden fields and cyclic records retain the original clone path', () => {
  const known = new WeakSet<object>();
  let reads = 0;
  const getter = Object.freeze({
    get value() {
      reads++;
      return reads;
    },
  });
  expect(isImmutableData(getter, known)).toBe(false);
  expect(reads).toBe(0);
  expect(structuredClone(getter)).toEqual({ value: 1 });
  const hidden = Object.freeze(Object.defineProperty({}, 'value', { value: 1, enumerable: false }));
  expect(isImmutableData(hidden, known)).toBe(false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  Object.freeze(cycle);
  expect(isImmutableData(cycle, known)).toBe(false);
  expect(known.has(cycle)).toBe(false);
});
