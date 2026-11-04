import { afterEach, expect, it } from 'vitest';
import type { SemanticEffect } from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import { CellIndex, cellKey } from './cells.js';
import { deriveHomes, HomeIndex } from './homes.js';
import { certifyOwnership } from './ownership.js';
import { NativeFixture } from './test-fixtures.js';
import type { OwnershipResult } from './ownership.js';

const fixtures: NativeFixture[] = [];
function fixture(empty = false) {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: empty ? [] : [...'abcdef'].map((text, i) => ({ id: `P${i}`, text })),
    },
    { id: 'Q', parent: 'root', role: 'inline', flow: 'fQ', run: 'rQ', tape: 'tQ', cells: [] },
  ]);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.destroy();
});
function coverage(f: NativeFixture, result: OwnershipResult, peer = 'C') {
  const raw = result.flowPlacements
    .filter((flow) => flow.parent.type === 'block')
    .flatMap((flow) => result.raw(flow.flow));
  const cells = raw.flatMap((entry) => (entry.type === 'cell' ? [entry] : []));
  expect(cells.map((cell) => cell.assignment)).toEqual(
    expect.arrayContaining([...result.assignments]),
  );
  expect(new Set(cells.map((cell) => cellKey(cell.assignment.cell))).size).toBe(
    result.assignments.length,
  );
  expect(cells).toHaveLength(result.assignments.length);
  const homes = result.homeBindings;
  const index = new CellIndex(homes.map((home) => f.peers.get(peer)!.snapshot(home.cell.tape)));
  const homeIndex = new HomeIndex(homes, index);
  const content = cells.filter((cell) => !homeIndex.isReserved(cell.assignment.cell));
  expect(content.flatMap((cell) => cell.fragments)).toEqual(
    cells.flatMap((cell) => cell.fragments),
  );
  for (const home of homes) {
    const reserved = index.range(home.cell).filter((cell) => homeIndex.isReserved(cell.range));
    expect(reserved.length).toBeGreaterThan(0);
    for (const cell of reserved)
      expect(result.cells(cell.range)).toEqual([
        { cell: cell.range, run: home.run, occurrence: home.occurrence },
      ]);
  }
  for (const placement of result.flowPlacements.filter((flow) => flow.parent.type === 'block')) {
    const slots = result.raw(placement.flow).filter((entry) => entry.type === 'slot');
    const keys = slots.map((entry) =>
      JSON.stringify([
        resourceKey(entry.slot.run),
        resourceKey(entry.slot.boundary),
        entry.slot.side,
      ]),
    );
    expect(new Set(keys).size).toBe(keys.length);
  }
}
function certify(f: NativeFixture, name: string, peer = name[0]) {
  const names = f.ready(peer);
  const input = {
    genesis: f.genesis,
    actions: names.map((key) => f.actions.get(key)!),
    snapshots: f.homes
      .filter(
        (home) =>
          home.cell.tape.birth.type === 'genesis' ||
          names.some((name) =>
            f.actions
              .get(name)!
              .action.allocations.some(
                (allocation) =>
                  allocation.type === 'tape' &&
                  resourceKey(allocation.id) === resourceKey(home.cell.tape),
              ),
          ),
      )
      .map((home) => f.peers.get(peer)!.snapshot(home.cell.tape)),
    isActive: () => true,
  };
  certifyOwnership(input, f.actions.get(name)!.action.id);
}
const permutations = [
  ['A1', 'B1', 'C1'],
  ['A1', 'C1', 'B1'],
  ['B1', 'A1', 'C1'],
  ['B1', 'C1', 'A1'],
  ['C1', 'A1', 'B1'],
  ['C1', 'B1', 'A1'],
];
it('preserves an evacuated split home through the exact empty-source witness, recapture, retyping and reconstruction', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'R', 'P3')]);
  f.author('B1', (f) => [f.split('P', 'L', 'P1')]);
  f.author('C1', (f) => [f.transfer(['P1', 'P2', 'P3', 'P4', 'P5'], 'Q:end', 'rT')]);
  for (const name of ['A1', 'B1', 'C1']) certify(f, name);
  let expected: unknown;
  for (const order of permutations) {
    f.fresh('C', order);
    const result = f.reduce();
    coverage(f, result);
    expect(['fP', 'fL', 'fR', 'fQ'].map((flow) => f.text(result, flow))).toEqual([
      'a',
      '',
      '',
      'bcdef',
    ]);
    expect(result.runLayouts.find((run) => f.alias(run.run) === 'rL')!.skeleton).toHaveLength(2);
    const actual = {
      owners: result.assignments,
      raw: result.flowPlacements.map((flow) => result.raw(flow.flow)),
      homes: result.homeBindings,
    };
    if (expected) expect(actual).toEqual(expected);
    else expected = actual;
    const bytes = f.peers.get('C')!.snapshot(f.id('tL', 'tape'));
    f.reduce();
    expect(f.peers.get('C')!.snapshot(f.id('tL', 'tape'))).toEqual(bytes);
  }
  f.deliver('C', 'B', ['A1', 'C1']);
  const retained = f.reduce('B').homeBindings;
  f.author('B2', (f) => f.insert('home-text', '😀𝄞', 'L:home-end'), ['A1', 'B1', 'C1'], 2n);
  f.bindInserted('home-text', 'B2');
  certify(f, 'B2');
  const brackets = f.bodies
    .get('B2')!
    .allocations.filter((allocation) => allocation.type === 'marker');
  expect(brackets).toHaveLength(2);
  const homeText = { tape: f.id('tL', 'tape'), start: brackets[0].id, end: brackets[1].id };
  f.author('B3', (f) => [f.transferRanges([homeText], f.slots.get('Q:end')!, 'rU')], ['B2'], 3n);
  certify(f, 'B3');
  f.author('B4', (f) => f.insert('again', 'z', 'L:home-end'), ['B3'], 4n);
  f.bindInserted('again', 'B4');
  certify(f, 'B4');
  const all = ['C1', 'A1', 'B1', 'B2', 'B3', 'B4'];
  for (const inactive of [[], ['B3'], ['B1'], ['B1', 'B3'], []]) {
    f.fresh('C', all);
    const result = f.reduce('C', inactive);
    coverage(f, result);
    expect(result.homeBindings).toEqual(retained);
    expect(f.text(result, 'fL')).toBe(inactive.includes('B3') ? '😀𝄞z' : 'z');
    expect(result.inlineOwner(f.aliases.get('again')!)).toEqual([f.id('L', 'node')]);
    expect(result.tokenOwners(f.aliases.get('P2')!)[0].run).toEqual(f.id('rT', 'run'));
    expect(f.text(result, 'fQ')).toBe(inactive.includes('B3') ? 'bcdef' : '😀𝄞bcdef');
  }
});

it('keeps private-home peer text at its birth flow while captured-interval text follows split retraction', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'L', 'P1')]);
  f.deliver('A', 'B', ['A1']);
  f.author('B1', (f) => f.insert('captured', 'x', 'L:start'), ['A1'], 2n);
  f.bindInserted('captured', 'B1');
  f.author('B2', (f) => f.insert('private', '😀', 'L:home-end'), ['B1'], 3n);
  f.bindInserted('private', 'B2');
  f.fresh('C', ['A1', 'B1', 'B2']);
  const before = f.reduce();
  for (const inactive of [[], ['A1'], []]) {
    const result = f.reduce('C', inactive);
    coverage(f, result);
    expect(result.runLayouts).toEqual(before.runLayouts);
    expect(f.text(result, 'fP')).toBe(inactive.length ? 'abxcdef' : 'ab');
    expect(f.text(result, 'fL')).toBe(inactive.length ? '😀' : 'xcdef😀');
    expect(result.inlineOwner(f.aliases.get('private')!)).toEqual([f.id('L', 'node')]);
    expect(result.inlineOwner(f.aliases.get('captured')!)).toEqual([
      f.id(inactive.length ? 'P' : 'L', 'node'),
    ]);
  }
});

it('derives two same-action homes and a dependent empty split without allocation-order inference', () => {
  const f = fixture(true);
  f.author('A1', (f) => [
    f.split('P', 'S', null),
    f.split('S', 'T', null, 'left', 'root', 'P:birth'),
  ]);
  certify(f, 'A1');
  const action = f.actions.get('A1')!;
  const batch = {
    allocations: action.action.allocations.toReversed(),
    births: action.births.toReversed(),
  };
  expect(
    deriveHomes(batch, action.action.effects)
      .map((home) => f.alias(home.run))
      .sort(),
  ).toEqual(['rS', 'rT']);
  f.fresh('C', ['A1']);
  const result = f.reduce();
  coverage(f, result);
  expect(result.children(f.id('root', 'node')).map((node) => f.alias(node))).toEqual([
    'P',
    'T',
    'S',
    'Q',
  ]);
  const homes = result.homeBindings;
  expect(new Set(homes.map((home) => resourceKey(home.cell.tape))).size).toBe(4);
  const original = action.action.effects;
  (action.action as { effects: readonly SemanticEffect[] }).effects = original.toReversed();
  expect(() => certify(f, 'A1')).toThrow('not yet available');
});

it.each([false, true])(
  'merges concurrent bracketed Unicode home typing without capturing either reserved edge (swap %s)',
  (swap) => {
    const f = fixture(true);
    if (swap) {
      const a = f.peers.get('A')!;
      f.peers.set('A', f.peers.get('B')!);
      f.peers.set('B', a);
    }
    f.author('A1', (f) => f.insert('a', '😀', 'P:home-end'));
    f.bindInserted('a', 'A1');
    f.author('B1', (f) => f.insert('b', '𝄞', 'P:home-end'));
    f.bindInserted('b', 'B1');
    for (const name of ['A1', 'B1']) certify(f, name);
    let expected: unknown;
    for (const order of [
      ['A1', 'B1'],
      ['B1', 'A1'],
    ]) {
      f.fresh('C', order);
      const result = f.reduce();
      coverage(f, result);
      const cells = result.cells(f.homes[0].cell);
      expect(cells.length).toBe(5);
      expect(f.text(result, 'fP')).toBe(swap ? '𝄞😀' : '😀𝄞');
      const actual = { assignments: result.assignments, raw: result.raw(f.id('fP', 'flow')) };
      if (expected) expect(actual).toEqual(expected);
      else expected = actual;
      const tokens = ['a', 'b'].map((alias) => f.aliases.get(alias)!);
      for (const token of tokens) expect(result.inlineOwner(token)).toEqual([f.id('P', 'node')]);
    }
  },
);

it('retains home-slot followers through split retraction without redirecting the original captured-end slot', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'L', 'P1')]);
  const oldEnd = structuredClone(f.slots.get('L:end')!);
  const homeEnd = structuredClone(f.slots.get('L:home-end')!);
  expect(oldEnd.boundary).not.toEqual(homeEnd.boundary);
  f.author(
    'A2',
    (f) => [...f.insert('q', 'X', 'Q:home-end'), f.join('fQ', 'L:home-end')],
    ['A1'],
    2n,
  );
  f.bindInserted('q', 'A2');
  f.author('B1', (f) => [f.split('P', 'R', 'P2')]);
  f.fresh('C', ['A1', 'A2', 'B1']);
  for (const inactive of [[], ['A1'], ['A2'], []]) {
    const result = f.reduce('C', inactive);
    coverage(f, result);
    const attachments = result
      .raw(f.id('fL', 'flow'))
      .filter((entry) => entry.type === 'attachment');
    expect(attachments).toHaveLength(inactive.includes('A2') ? 0 : 1);
    if (attachments.length) expect(attachments[0].target).toEqual(f.id('fQ', 'flow'));
    expect(result.resolveSlot(oldEnd).slot).toEqual(oldEnd);
    expect(result.resolveSlot(homeEnd).slot).toEqual(homeEnd);
    // Native facts remain retained even when the typing/join action is inactive;
    // insertion visibility is supplied separately by MW-05.
    expect(f.text(result, 'fL')).toBe(
      inactive.includes('A2') ? 'c' : inactive.includes('A1') ? 'X' : 'cX',
    );
  }
});
