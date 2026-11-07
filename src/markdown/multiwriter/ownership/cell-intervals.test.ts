import { expect, test } from 'vitest';
import type { TapePart, TapeSnapshot } from '../text/types.js';
import { resource } from '../actions/test-fixtures.js';
import { CellIndex } from './cells.js';

function snapshot(
  parts: readonly ({ type: 'text'; clock: number; text: string } | { type: 'marker' })[],
): TapeSnapshot {
  let index = 0,
    ordinal = 0;
  return {
    tape: resource('tape', 0),
    length: parts.reduce((n, p) => n + (p.type === 'marker' ? 1 : p.text.length), 0),
    parts: parts.map((part): TapePart => {
      const at = index;
      index += part.type === 'marker' ? 1 : part.text.length;
      return part.type === 'marker'
        ? {
            type: 'marker',
            marker: resource('marker', ordinal),
            native: { client: 2, clock: ordinal++ },
            index: at,
            affinity: 'right',
          }
        : { type: 'text', native: { client: 1, clock: part.clock }, text: part.text, index: at };
    }),
  };
}
for (const size of [10, 1000])
  test(`native range queries inspect only overlapping cells among ${size} cells`, () => {
    const tape = snapshot([
      { type: 'marker' },
      ...Array.from({ length: size }, (_, clock) => [
        { type: 'text' as const, clock, text: 'x' },
        { type: 'marker' as const },
      ]).flat(),
    ]);
    const index = new CellIndex([tape]);
    let reads = 0;
    for (const cell of index.cells) {
      const fragments = cell.fragments;
      Object.defineProperty(cell, 'fragments', {
        get() {
          reads++;
          return fragments;
        },
      });
    }
    const clock = Math.floor(size / 2);
    expect(index.token({ tape: tape.tape, client: 1, clock, length: 1 })).toEqual([
      index.cells[clock],
    ]);
    // The assertion itself reads the selected cell; unrelated fragments stay unread.
    expect(reads).toBeLessThan(5);
  });

test('clock selection preserves tape order and deduplicates cells with multiple fragments', () => {
  const tape = snapshot([
    { type: 'marker' },
    { type: 'text', clock: 2, text: 'c' },
    { type: 'marker' },
    { type: 'text', clock: 0, text: 'a' },
    { type: 'text', clock: 1, text: 'b' },
    { type: 'marker' },
  ]);
  const index = new CellIndex([tape]);
  expect(index.token({ tape: tape.tape, client: 1, clock: 0, length: 3 })).toEqual(index.cells);
  expect(index.token({ tape: tape.tape, client: 1, clock: 0, length: 2 })).toEqual([
    index.cells[1],
  ]);
});

test('indexed ranges retain missing-identity, gaps, Unicode and malformed-length checks', () => {
  const tape = snapshot([
    { type: 'marker' },
    { type: 'text', clock: 0, text: 'a😀' },
    { type: 'marker' },
    { type: 'text', clock: 4, text: 'z' },
    { type: 'marker' },
  ]);
  const index = new CellIndex([tape]);
  const range = { tape: tape.tape, client: 1, clock: 1, length: 2 };
  expect(index.token(range)).toEqual([index.cells[0]]);
  expect(() => index.token({ ...range, length: 1 })).toThrow('surrogate pair');
  expect(() => index.token({ ...range, clock: 2, length: 1 })).toThrow('surrogate pair');
  expect(() => index.token({ ...range, clock: 0, length: 5 })).toThrow('Unknown native');
  expect(() => index.token({ ...range, client: 99 })).toThrow('Unknown native');
  for (const length of [0, -1, NaN, Infinity, 1.5])
    expect(() => index.token({ ...range, length })).toThrow('Invalid native text range');
});

test('overlapping diagnostic identities retain first-cell lookup and duplicate rejection', () => {
  const tape = snapshot([
    { type: 'marker' },
    { type: 'text', clock: 0, text: 'ab' },
    { type: 'marker' },
    { type: 'text', clock: 0, text: 'ab' },
    { type: 'marker' },
  ]);
  const index = new CellIndex([tape]);
  expect(index.locateToken(tape.tape, { client: 1, clock: 0 })).toBe(index.cells[0]);
  expect(() => index.token({ tape: tape.tape, client: 1, clock: 0, length: 2 })).toThrow(
    'Unknown native',
  );
});
