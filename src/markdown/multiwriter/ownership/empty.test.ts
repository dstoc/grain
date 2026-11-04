import { afterEach, expect, it } from 'vitest';
import { resourceKey } from '../layout/index.js';
import { certifyOwnership } from './ownership.js';
import { NativeFixture } from './test-fixtures.js';

const fixtures: NativeFixture[] = [];
function fixture(swap = false) {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'P', parent: 'root', role: 'inline', flow: 'fP', run: 'rP', tape: 'tP', cells: [] },
  ]);
  if (swap) {
    const a = f.peers.get('A')!;
    f.peers.set('A', f.peers.get('B')!);
    f.peers.set('B', a);
  }
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.destroy();
});
function children(f: NativeFixture, inactive: readonly string[] = []) {
  return f
    .reduce('C', inactive)
    .children(f.id('root', 'node'))
    .map((node) => f.alias(node));
}
function certify(f: NativeFixture, name: string) {
  const ready = f.ready(name[0]);
  const actions = ready.map((key) => f.actions.get(key)!);
  const tapes = [
    ...f.genesis.allocations,
    ...actions.flatMap((entry) => entry.action.allocations),
  ].filter((entry) => entry.type === 'tape');
  certifyOwnership(
    {
      genesis: f.genesis,
      actions,
      snapshots: tapes.map((tape) => f.peers.get(name[0])!.snapshot(tape.id)),
      isActive: () => true,
    },
    f.actions.get(name)!.action.id,
  );
}
it.each([
  [true, false],
  [true, true],
  [false, false],
  [false, true],
])('replays the complete two-generation empty witness, native swap %s/%s', (aFirst, swap) => {
  const f = fixture(swap);
  const a = aFirst ? 'A' : 'B';
  const b = aFirst ? 'B' : 'A';
  expect(f.peers.get('A')!.clientId < f.peers.get('B')!.clientId).toBe(!swap);
  f.author(`${a}1`, (f) => [f.split('P', 'SA', null)]);
  f.author(`${a}2`, (f) => [f.split('SA', 'TA', null, 'right', 'root', 'P:birth')], [`${a}1`], 2n);
  f.author(`${b}1`, (f) => [f.split('P', 'SB', null)]);
  f.author(`${b}2`, (f) => [f.split('SB', 'TB', null, 'right', 'root', 'P:birth')], [`${b}1`], 2n);
  certify(f, `${a}2`);
  certify(f, `${b}2`);
  const [a1, a2, b1, b2] = [`${a}1`, `${a}2`, `${b}1`, `${b}2`];
  const schedules = [
    [a1, a2, b1, b2],
    [a1, b1, a2, b2],
    [a1, b1, b2, a2],
    [b1, a1, a2, b2],
    [b1, a1, b2, a2],
    [b1, b2, a1, a2],
  ];
  const expected = aFirst ? ['P', 'TB', 'TA', 'SA', 'SB'] : ['P', 'TA', 'TB', 'SB', 'SA'];
  const ordinary = aFirst ? ['P', 'TB', 'TA', 'SB', 'SA'] : ['P', 'TA', 'TB', 'SA', 'SB'];
  let observation: unknown;
  for (const schedule of schedules) {
    f.fresh('C', schedule);
    expect(children(f)).toEqual(expected);
    const result = f.reduce();
    expect(result.buckets).toEqual([
      {
        roots: (aFirst ? ['SA', 'SB'] : ['SB', 'SA']).map((node) =>
          f.id(`${node}:birth`, 'occurrence'),
        ),
      },
    ]);
    const homes = result.homeBindings;
    expect(homes).toHaveLength(5);
    for (const get of [
      (home: (typeof homes)[number]) => home.run,
      (home: (typeof homes)[number]) => home.occurrence,
      (home: (typeof homes)[number]) => home.cell.tape,
      (home: (typeof homes)[number]) => home.cell.start,
      (home: (typeof homes)[number]) => home.cell.end,
    ])
      expect(new Set(homes.map((home) => resourceKey(get(home)))).size).toBe(5);
    const slots = ['P', 'SA', 'SB', 'TA', 'TB'].map(
      (node) => result.resolveSlot(f.slots.get(`${node}:home-end`)!).slot,
    );
    expect(new Set(slots.map((slot) => resourceKey(slot.boundary))).size).toBe(5);
    expect(result.assignments).toHaveLength(5);
    const snapshots = homes.map((home) => f.peers.get('C')!.snapshot(home.cell.tape));
    const actual = {
      assignments: result.assignments,
      raw: result.flowPlacements.map((placement) => result.raw(placement.flow)),
      snapshots,
      slots,
    };
    if (observation) expect(actual).toEqual(observation);
    else observation = actual;
    const names = [a1, b1, a2, b2];
    for (let mask = 0; mask < 16; mask++) {
      const inactive = names.filter((_, i) => mask & (1 << i));
      expect(children(f, inactive)).toEqual(mask & 3 ? ordinary : expected);
      expect(f.reduce('C', inactive).assignments).toEqual(result.assignments);
      expect(f.reduce('C', inactive).homeBindings).toEqual(homes);
    }
    f.deliver('A', 'C', schedule);
    expect(children(f)).toEqual(expected);
    expect(homes.map((home) => f.peers.get('C')!.snapshot(home.cell.tape))).toEqual(snapshots);
  }
  // A later refinement of the source does not change the recorded empty domain.
  f.author(`${a}3`, (f) => f.insert('later', '😀', 'P:home-end'), [a2], 3n);
  f.bindInserted('later', `${a}3`);
  certify(f, `${a}3`);
  f.fresh('C', [...schedules[0], `${a}3`]);
  expect(children(f)).toEqual(expected);
  expect(f.text(f.reduce(), 'fP')).toBe('😀');
  expect(['fSA', 'fSB', 'fTA', 'fTB'].map((flow) => f.text(f.reduce(), flow))).toEqual([
    '',
    '',
    '',
    '',
  ]);
});

it.each(['left', 'right'] as const)(
  'reuses canonical empty cuts for concurrent and repeated %s splits',
  (side) => {
    const f = fixture();
    f.author('A1', (f) => [f.split('P', 'L', null, side)]);
    f.author('B1', (f) => [f.split('P', 'R', null, side)]);
    expect(f.actions.get('A1')!.action.effects[0]).toMatchObject({
      cut: {
        run: f.id('rP', 'run'),
        boundary: f.id('P:end', 'marker'),
        side: 'left',
        predecessor: null,
      },
    });
    expect(f.actions.get('B1')!.action.effects[0]).toMatchObject({
      cut: (f.actions.get('A1')!.action.effects[0] as { cut: unknown }).cut,
    });
    f.author('A2', (f) => [f.split('L', 'S', null, side)], ['A1'], 2n);
    f.author('A3', (f) => [f.split('S', 'T', null, side)], ['A2'], 3n);
    certify(f, 'A3');
    certify(f, 'B1');
    for (const order of [
      ['A1', 'A2', 'A3', 'B1'],
      ['B1', 'A1', 'A2', 'A3'],
    ]) {
      f.fresh('C', order);
      expect(children(f)).toEqual(
        side === 'left' ? ['P', 'L', 'S', 'T', 'R'] : ['T', 'S', 'L', 'R', 'P'],
      );
      expect(f.reduce().homeBindings).toHaveLength(5);
      for (const name of order) expect(f.bodies.get(name)!.nativeManifest).toHaveLength(2);
    }
  },
);

it('breaks an equal-cut same-action tie by effect ordinal, with distinct future insertion locations', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'L', null), f.split('P', 'R', null)]);
  certify(f, 'A1');
  f.fresh('C', ['A1']);
  expect(children(f)).toEqual(['P', 'L', 'R']);
  expect(f.reduce().buckets[0].roots).toEqual(
    ['L', 'R'].map((node) => f.id(`${node}:birth`, 'occurrence')),
  );
  expect(f.slots.get('L:home-end')!.boundary).not.toEqual(f.slots.get('R:home-end')!.boundary);
});

it('retains empty cohorts through rejected moves, removes effective moves, and traverses ghost followers', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'L', null)]);
  f.author('B1', (f) => [f.split('P', 'R', null)]);
  f.author(
    'A2',
    (f) => {
      f.createBlock({ id: 'D', parent: 'L', role: 'quote' }, null);
      f.createBlock({ id: 'F', parent: 'root', role: 'quote' }, 'L:birth');
      return [];
    },
    ['A1'],
    2n,
  );
  f.author('A3', (f) => [f.move('L', 'D')], ['A2'], 3n);
  f.fresh('C', ['B1', 'A1', 'A2', 'A3']);
  expect(children(f)).toEqual(['P', 'L', 'F', 'R']);
  expect(f.reduce().buckets).toHaveLength(1);
  f.deliver('B', 'A', ['B1']);
  f.author('A4', (f) => [f.move('D', 'root')], ['A3', 'B1'], 4n);
  f.fresh('C', ['B1', 'A1', 'A2', 'A3', 'A4']);
  // The earlier cycle rejection is evaluated at A3's prefix, not the final graph.
  expect(f.reduce().buckets).toHaveLength(1);
  expect(children(f, ['A2'])).toContain('F');
  f.author('A5', (f) => [f.move('L', 'P')], ['A4'], 5n);
  f.fresh('C', ['B1', 'A1', 'A2', 'A3', 'A4', 'A5']);
  expect(f.reduce().buckets).toHaveLength(0);
  expect(children(f)).toEqual(['D', 'P', 'R', 'F']);
  expect(f.reduce().children(f.id('P', 'node'))).toEqual([f.id('L', 'node')]);
  expect(f.reduce('C', ['A5']).buckets).toHaveLength(1);
});
