import { expect, test } from 'vitest';
import { PersistentMap } from './map.js';

test('persistent insertion order and deletion match Map while old roots retain their values', () => {
  const actual = new PersistentMap<number>();
  const expected = new Map<string, number>();
  const held: { map: PersistentMap<number>; entries: [string, number][] }[] = [];
  let seed = 8500;
  for (let step = 0; step < 1200; step++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const key = String(seed % 129);
    if (seed % 5 < 2) expect(actual.delete(key)).toBe(expected.delete(key));
    else {
      actual.set(key, step);
      expected.set(key, step);
    }
    expect(actual.size).toBe(expected.size);
    expect([...actual]).toEqual([...expected]);
    expect(actual.get(key)).toBe(expected.get(key));
    expect(actual.has(key)).toBe(expected.has(key));
    if (step % 61 === 0) held.push({ map: actual.fork(), entries: [...expected] });
  }
  for (const { map, entries } of held) expect([...map]).toEqual(entries);
  for (const key of expected.keys()) {
    actual.delete(key);
    expected.delete(key);
  }
  expect([...actual]).toEqual([]);
  expect(actual.size).toBe(0);
  actual.set('reused', 1).set('other', 2);
  actual.delete('reused');
  actual.set('reused', 3);
  expect([...actual]).toEqual([
    ['other', 2],
    ['reused', 3],
  ]);
  for (const { map, entries } of held) expect([...map]).toEqual(entries);
});
