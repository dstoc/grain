import { expect, test, vi } from 'vitest';
import type { Allocation } from '../contracts.js';
import type { LayoutGenesis } from '../layout/index.js';
import * as layout from '../layout/index.js';
import { resource } from '../actions/test-fixtures.js';
import { deriveHomes } from './homes.js';
import { commandGenesis } from '../../../../test/multiwriter/commands/replica.js';
import { NativeTapeCache } from '../text/cache.js';
import { reduceOwnership } from './ownership.js';

function batch(size: number): LayoutGenesis {
  const allocations: Allocation[] = [],
    births: LayoutGenesis['births'][number][] = [];
  for (let i = 0; i < size; i++) {
    const node = resource('node', i),
      flow = resource('flow', i),
      tape = resource('tape', i),
      start = resource('marker', i * 2),
      end = resource('marker', i * 2 + 1),
      run = resource('run', i),
      occurrence = resource('occurrence', i);
    allocations.push(
      { type: 'flow', id: flow, home: node },
      { type: 'tape', id: tape, start, end },
      { type: 'run', id: run, flow, skeleton: [{ tape, start, end }] },
    );
    births.push({ node, occurrence });
  }
  return { allocations, births };
}

for (const size of [10, 150, 1000])
  test(`fresh home derivation indexes each input instead of rescanning ${size} roots`, () => {
    const input = batch(size),
      calls = vi.spyOn(layout, 'resourceKey');
    try {
      const homes = deriveHomes(input);
      expect(homes.map((home) => home.run.ordinal)).toEqual(
        Array.from({ length: size }, (_, i) => i),
      );
      expect(calls.mock.calls.length).toBeLessThan(size * 20);
    } finally {
      calls.mockRestore();
    }
  });

test('home derivation retains flow order and fresh input validation on every call', () => {
  const input = batch(3),
    original = structuredClone(input),
    first = deriveHomes(input);
  const reversed = {
    allocations: [...input.allocations].reverse(),
    births: [...input.births].reverse(),
  };
  expect(deriveHomes(reversed)).toEqual([...first].reverse());
  const changed = structuredClone(input);
  const run = changed.allocations.find((entry) => entry.type === 'run')!;
  if (run.type !== 'run') throw new Error();
  (run as { skeleton: typeof run.skeleton }).skeleton = [];
  expect(() => deriveHomes(changed)).toThrow('fresh full home tape');
  expect(deriveHomes(input)).toEqual(first);
  expect(input).toEqual(original);
  const extra = input.allocations.find((entry) => entry.type === 'run')!;
  expect(() => deriveHomes({ ...input, allocations: [...input.allocations, extra] })).toThrow(
    'exactly one retained root run',
  );
  expect(() => deriveHomes({ ...input, births: input.births.slice(1) })).toThrow(
    'Missing home run occurrence',
  );
});

test('fresh ownership replay indexes home and tape membership independently of allocation order', () => {
  const genesis = commandGenesis(Array.from({ length: 150 }, () => 'abc').join('\n\n'));
  const native = new NativeTapeCache();
  try {
    native.apply('G', genesis.body);
    const snapshots = genesis.layout.allocations.flatMap((entry) =>
      entry.type === 'tape' ? [native.snapshot(entry.id)] : [],
    );
    const input = { genesis: genesis.layout, snapshots, actions: [], isActive: () => true };
    const calls = vi.spyOn(layout, 'resourceKey');
    let result;
    try {
      result = reduceOwnership(input);
      expect(calls.mock.calls.length).toBeLessThan(150 * 500);
    } finally {
      calls.mockRestore();
    }
    const reordered = reduceOwnership({
      ...input,
      genesis: {
        allocations: [...genesis.layout.allocations].reverse(),
        births: [...genesis.layout.births].reverse(),
      },
    });
    expect(reordered.assignments).toEqual(
      [...result.homeBindings].reverse().flatMap((home) => result.cells(home.cell)),
    );
    expect(result.homeBindings.map((home) => home.run)).toEqual(
      deriveHomes(genesis.layout).map((home) => home.run),
    );
  } finally {
    native.destroy();
  }
});
