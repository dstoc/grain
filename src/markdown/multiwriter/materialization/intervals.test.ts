import { expect, test } from 'vitest';
import type { MarkerId, RangeRef } from '../contracts.js';
import { resource } from '../actions/test-fixtures.js';
import { NativeReadIntervals } from './intervals.js';

const tape = resource('tape', 0);
const position = (marker: MarkerId) => marker.ordinal;
const range = (start: number, end: number): RangeRef => ({
  tape,
  start: resource('marker', start),
  end: resource('marker', end),
});
type Read = { readonly range: RangeRef; readonly count: number };
function full(reads: readonly Read[], point: number, at = position) {
  const found = reads
    .filter((read) => at(read.range.start) < point && point < at(read.range.end))
    .map((read) => read.count);
  return found.length ? Math.min(...found) : undefined;
}

test('indexed reverse reads equal a fresh interval scan through rotations and retained checkpoints', () => {
  let index = NativeReadIntervals.empty(),
    seed = 9413;
  const reads: Read[] = [],
    held: { index: NativeReadIntervals; reads: readonly Read[] }[] = [];
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let step = 0; step < 1200; step++) {
    const start = random() % 4096,
      end = start + 1 + (random() % 512);
    // Most reads arrive in replay order; earlier counts also check minimum
    // replacement and ensure insertion does not discard an earlier dependency.
    const read = { range: range(start, end), count: step % 7 ? step : random() % 100 };
    reads.push(read);
    index = index.add(read.range, read.count, position);
    for (const point of [start, end, (start + end) / 2, random() % 4608])
      expect(index.first(point, position)).toBe(full(reads, point));
    if (step % 61 === 0) held.push({ index, reads: [...reads] });
  }
  for (const prior of held)
    for (let point = 0; point < 4608; point += 17)
      expect(prior.index.first(point, position)).toBe(full(prior.reads, point));
});

test('text shifts and newly subdivided gaps preserve old marker ordering and open endpoints', () => {
  let index = NativeReadIntervals.empty();
  const reads = [
    { range: range(2, 8), count: 5 },
    { range: range(10, 12), count: 9 },
    { range: range(6, 14), count: 11 },
  ];
  for (const read of reads) index = index.add(read.range, read.count, position);
  // Native positions change by different amounts before, inside and after a
  // retained interval. New points can fall between any two retained markers.
  const shifted = (marker: MarkerId) => marker.ordinal * 3 + (marker.ordinal >= 7 ? 1000 : 0);
  for (let point = 0; point <= 1050; point++)
    expect(index.first(point, shifted)).toBe(full(reads, point, shifted));
  const added = index.add(range(5, 7), 15, shifted);
  for (let point = 0; point <= 1050; point++) {
    expect(added.first(point, shifted)).toBe(
      full([...reads, { range: range(5, 7), count: 15 }], point, shifted),
    );
    expect(index.first(point, shifted)).toBe(full(reads, point, shifted));
  }
  expect(NativeReadIntervals.empty().first(1, position)).toBeUndefined();
});

test('repeated covered reads share the root without retaining later reader chains', () => {
  const index = NativeReadIntervals.empty().add(range(1, 10), 3, position);
  expect(index.add(range(1, 10), 3, position)).toBe(index);
  expect(index.add(range(2, 8), 4, position)).toBe(index);
  const earlier = index.add(range(2, 8), 1, position);
  expect(earlier).not.toBe(index);
  expect(earlier.first(5, position)).toBe(1);
  expect(earlier.first(2, position)).toBe(3);
  expect(index.first(5, position)).toBe(3);
});

test('disjoint and overlapping reader queries skip retained tape history', () => {
  let index = NativeReadIntervals.empty();
  for (let i = 0; i < 4096; i++) index = index.add(range(i * 4, i * 4 + 2), i, position);
  for (const point of [-1, 0, 1, 8193, 16381, 16383]) {
    let visits = 0;
    const result = index.first(point, position, () => visits++);
    const expected = point % 4 === 1 ? Math.floor(point / 4) : undefined;
    expect(result).toBe(expected);
    expect(visits).toBeLessThan(40);
  }
  // Every retained interval in this second index overlaps the point. Earliest-count augmentation
  // finds its replay frontier without enumerating all of those intersections.
  let overlapping = NativeReadIntervals.empty();
  for (let i = 0; i < 4096; i++)
    overlapping = overlapping.add(range(i, 20000 + i), i + 4096, position);
  let visits = 0;
  expect(overlapping.first(18000, position, () => visits++)).toBe(4096);
  expect(visits).toBeLessThan(80);
  // Mixed overlap can still require a linear interval-tree search. Keep this
  // adversarial semantic control separate from the disjoint/all-overlap bounds.
  for (let i = 0; i < 4096; i++) index = index.add(range(i, 20000 + i), i + 4096, position);
  expect(index.first(18000, position)).toBe(4096);
});
