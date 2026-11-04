import { afterEach, expect, it } from 'vitest';
import { NativeFixture } from './test-fixtures.js';
import { reduceOwnership } from './index.js';
import type { OwnershipInput } from './index.js';
import { resourceKey } from '../layout/index.js';
import { CellIndex } from './cells.js';

const fixtures: NativeFixture[] = [];
function fixture(text = 'a😀𝄞z'): NativeFixture {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [...text].map((text, index) => ({ id: `P${index}`, text })),
    },
  ]);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.destroy();
});

it('preserves exact Unicode fragments and maps both UTF-16 units to the same owner', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'S', 'P1')]);
  const result = f.reduce('A');
  expect(f.text(result, 'fP')).toBe('a😀');
  expect(f.text(result, 'fS')).toBe('𝄞z');
  for (const name of ['P1', 'P2']) {
    const token = f.aliases.get(name)!;
    const first = result.owner({ tape: token.tape, native: token });
    const second = result.owner({
      tape: token.tape,
      native: { client: token.client, clock: token.clock + 1 },
    });
    expect(first).toEqual(second);
    expect(result.tokenOwners(token)).toEqual([first]);
    expect(() => result.tokenOwners({ ...token, length: 1 })).toThrow('surrogate pair');
    expect(result.contains(f.homes[0].cell, { tape: token.tape, native: token })).toBe(true);
  }
  expect(result.inlineOwner(f.aliases.get('P2')!)).toEqual([f.id('S', 'node')]);
  const all = result
    .raw(f.id('fS', 'flow'))
    .flatMap((entry) => (entry.type === 'cell' ? entry.fragments : []));
  expect(all.map((fragment) => fragment.text).join('')).toBe('𝄞z');
  expect(all.map((fragment) => fragment.range.length)).toEqual([2, 1]);
});

it.each(['left', 'right'] as const)(
  'splits an empty input into two distinct addressable locations (%s)',
  (side) => {
    const f = fixture('');
    f.author('A1', (f) => [f.split('P', 'S', null, side)]);
    const result = f.reduce('A');
    const cells = ['fP', 'fS'].map((flow) =>
      result.raw(f.id(flow, 'flow')).filter((entry) => entry.type === 'cell'),
    );
    expect(cells.every((list) => list.length > 0)).toBe(true);
    expect(cells.flat().length).toBe(result.assignments.length);
    const ranges = result.assignments.map((assignment) => assignment.cell);
    expect(ranges.every((range) => resourceKey(range.start) !== resourceKey(range.end))).toBe(true);
    f.author('A2', (f) => f.insert('x', 'x', 'S:end'), ['A1'], 2n);
    f.bindInserted('x', 'A2');
    const typed = f.reduce('A');
    expect(f.text(typed, 'fS')).toBe('x');
    expect(f.text(typed, 'fP')).toBe('');
  },
);

it('rejects a full-cell transfer that omits a distinct source insertion cell', () => {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [{ id: 'P0', text: 'x' }],
    },
    { id: 'Q', parent: 'root', role: 'inline', flow: 'fQ', run: 'rQ', tape: 'tQ', cells: [] },
  ]);
  fixtures.push(f);
  f.author('A1', (f) => [f.transferRanges([f.homes[0].cell], f.slots.get('Q:end')!, 'rT')]);
  const snapshot = f.peers.get('A')!.snapshot(f.id('tP', 'tape'));
  expect(() => f.reduce('A')).toThrow('distinct permanent insertion cell');
  expect(f.peers.get('A')!.snapshot(f.id('tP', 'tape'))).toEqual(snapshot);
  // Discarded replay state cannot leak assignments into the next successful replay.
  expect(f.text(f.reduce('A', ['A1']), 'fP')).toBe('x');
});

it('accepts deeply frozen decoded identities and returns detached query values', () => {
  const f = fixture('abc');
  f.author('A1', (f) => [f.split('P', 'S', 'P0')]);
  const tape = f.id('tP', 'tape');
  const input: OwnershipInput = {
    genesis: structuredClone(f.genesis),
    actions: structuredClone([...f.actions.values()]),
    snapshots: [f.peers.get('A')!.snapshot(tape)],
    homes: structuredClone(f.homes),
    isActive: () => true,
  };
  function freeze(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(input);
  const result = reduceOwnership(input);
  const before = result.assignments;
  const detached = result.assignments as unknown as { run: (typeof before)[0]['run'] }[];
  detached[0].run = f.id('rS', 'run');
  const skeleton = result.runLayouts[0].skeleton as unknown[];
  skeleton.length = 0;
  const raw = result.raw(structuredClone(f.id('fS', 'flow'))) as unknown[];
  raw.length = 0;
  expect(result.assignments).toEqual(before);
  expect(result.runLayouts[0].skeleton.length).toBeGreaterThan(0);
  expect(f.text(result, 'fS')).toBe('bc');
  expect(result.resolveSlot(structuredClone(f.slots.get('S:end')!)).membership).toBe('available');
});

it('rejects malformed endpoints, snapshots, native IDs, and allocations', () => {
  const f = fixture('abc');
  const snapshot = f.peers.get('A')!.snapshot(f.id('tP', 'tape'));
  const input: OwnershipInput = {
    genesis: f.genesis,
    actions: [],
    snapshots: [snapshot],
    homes: f.homes,
    isActive: () => true,
  };
  const result = reduceOwnership(input);
  expect(() => result.cells({ ...f.homes[0].cell, start: f.homes[0].cell.end })).toThrow(
    'Invalid open',
  );
  expect(() => result.owner({ tape: snapshot.tape, native: { client: -1, clock: 0 } })).toThrow(
    'Invalid native',
  );
  expect(() => result.owner({ tape: snapshot.tape, native: { client: 1, clock: 99999 } })).toThrow(
    'Unknown native',
  );
  expect(() => reduceOwnership({ ...input, snapshots: [snapshot, snapshot] })).toThrow(
    'Duplicate native',
  );
  expect(() =>
    reduceOwnership({ ...input, snapshots: [{ ...snapshot, length: snapshot.length + 1 }] }),
  ).toThrow('Missing permanent');
  expect(() =>
    reduceOwnership({ ...input, snapshots: [{ ...snapshot, parts: snapshot.parts.slice(1) }] }),
  ).toThrow('positions');
  expect(() =>
    reduceOwnership({
      ...input,
      genesis: {
        ...input.genesis,
        allocations: input.genesis.allocations.filter((allocation) => allocation.type !== 'marker'),
      },
    }),
  ).toThrow('Snapshot marker');
  const index = new CellIndex([snapshot]);
  expect(() =>
    index.range({ ...f.homes[0].cell, end: { ...f.homes[0].cell.end, ordinal: 999 } }),
  ).toThrow('Unknown native');
});
