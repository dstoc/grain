import { expect, test } from 'vitest';
import { resource } from '../actions/test-fixtures.js';
import { exactContains } from '../projection/interpretation.js';
import { captureDiagnostics } from '../diagnostics.js';
import { ExactSyntaxMasks } from './masks.js';

const tape = resource('tape', 0),
  other = resource('tape', 1);
const range = (clock: number, length = 1, client = 7, source = tape) => ({
  tape: source,
  client,
  clock,
  length,
});
test('exact syntax masks match full containment across overlaps, tape/client separation, empty ranges and withdrawals', () => {
  const ranges = [range(1, 4), range(3, 5), range(7, 0), range(2, 4, 8), range(1, 4, 7, other)];
  const held = ExactSyntaxMasks.create([]).update([
    { packet: 'a', ranges: ranges.slice(0, 2) },
    { packet: 'b', ranges: ranges.slice(2) },
  ]);
  for (const source of [tape, other])
    for (const client of [7, 8, 9])
      for (let clock = 0; clock < 10; clock++)
        for (let length = 0; length < 4; length++) {
          const value = range(clock, length, client, source);
          expect(held.masked(value)).toBe(ranges.some((mask) => exactContains(mask, value)));
        }
  const removed = held.update([{ packet: 'a' }]);
  expect(removed.masked(range(1))).toBe(false);
  expect(held.masked(range(1))).toBe(true);
  expect(removed.masked(range(3, 1, 8))).toBe(true);
  const replaced = removed.update([{ packet: 'b', ranges: [range(10)] }]);
  expect(replaced.masked(range(3, 1, 8))).toBe(false);
  expect(replaced.masked(range(10))).toBe(true);
});

test('mask changes and selected reads visit affected search paths rather than distant packet masks', () => {
  const held = ExactSyntaxMasks.create([]).update(
    Array.from({ length: 4096 }, (_, i) => ({ packet: `${i}`, ranges: [range(i * 4, 2)] })),
  );
  const { value: next, report } = captureDiagnostics(() => {
    const next = held.update([{ packet: 'new', ranges: [range(3)] }]);
    expect(next.masked(range(3))).toBe(true);
    expect(next.masked(range(8192))).toBe(true);
    return next;
  });
  expect(report.work['driver/masks.rangesIndexed']).toBe(1);
  expect(report.work['driver/masks.intervalNodesSummarized']).toBeLessThan(30);
  expect(report.work['driver/masks.queryNodesVisited']).toBeLessThan(30);
  expect(report.work['driver/masks.fullIndexesConstructed'] ?? 0).toBe(0);
  expect(held.masked(range(3))).toBe(false);
  expect(next.masked(range(3))).toBe(true);
});
