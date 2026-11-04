import { afterEach, expect, it } from 'vitest';
import { contractCorpus } from '../../../../test/multiwriter/corpus.js';
import type { ContractTrace, Intent, Observation } from '../../../../test/multiwriter/trace.js';
import type { CellAssignment, SemanticEffect } from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import { NativeFixture } from './test-fixtures.js';
import { reduceOwnership } from './index.js';
import type { OwnershipResult } from './index.js';

const fixtures: NativeFixture[] = [];
function fixture(seed?: ConstructorParameters<typeof NativeFixture>[0]): NativeFixture {
  const f = new NativeFixture(seed);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.destroy();
});
function cells(result: OwnershipResult, f: NativeFixture, flow: string): readonly CellAssignment[] {
  return result
    .raw(f.id(flow, 'flow'))
    .flatMap((entry) => (entry.type === 'cell' ? [entry.assignment] : []));
}
function invariant(result: OwnershipResult): void {
  const assignments = result.assignments;
  const all = result.flowPlacements
    .filter((flow) => flow.parent.type === 'block')
    .flatMap((flow) => result.raw(flow.flow))
    .flatMap((entry) => (entry.type === 'cell' ? [entry] : []));
  expect(all).toHaveLength(assignments.length);
  const cellKeys = all.map((entry) =>
    JSON.stringify([
      resourceKey(entry.assignment.cell.tape),
      resourceKey(entry.assignment.cell.start),
      resourceKey(entry.assignment.cell.end),
    ]),
  );
  expect(new Set(cellKeys).size).toBe(cellKeys.length);
  const native = all.flatMap((entry) =>
    entry.fragments.flatMap((fragment) =>
      Array.from(
        { length: fragment.range.length },
        (_, offset) => `${fragment.range.client}:${fragment.range.clock + offset}`,
      ),
    ),
  );
  expect(new Set(native).size).toBe(native.length);
  for (const assignment of assignments) {
    expect(result.cells(assignment.cell)).toEqual([assignment]);
    expect(
      result.runLayouts.some((run) => resourceKey(run.run) === resourceKey(assignment.run)),
    ).toBe(true);
  }
}

it.each([false, true])(
  'retains authored suffixes and selects ab/c/def in both semantic priorities (reverse %s)',
  (reverse) => {
    const f = fixture();
    const l = reverse ? 'B1' : 'A1';
    const r = reverse ? 'A1' : 'B1';
    f.author(l, (f) => [f.split('P', 'L', 'P1')]);
    f.author(r, (f) => [f.split('P', 'R', 'P2')]);
    expect(f.text(f.reduce(l[0]), 'fL')).toBe('cdef');
    const lBefore = f.reduce(l[0]).runLayouts.find((run) => f.alias(run.run) === 'rL')!;
    const slot = structuredClone(f.slots.get('L:end')!);
    for (const delivery of [
      [l, r],
      [r, l],
    ]) {
      f.fresh('C', delivery);
      const snapshots = [...f.peers.get('C')!.snapshot(f.id('tP', 'tape')).parts];
      const states = [
        { inactive: [r], text: ['ab', 'cdef', ''] },
        { inactive: [], text: ['ab', 'c', 'def'] },
        { inactive: [l], text: ['abc', '', 'def'] },
        { inactive: [l, r], text: ['abcdef', '', ''] },
        { inactive: [], text: ['ab', 'c', 'def'] },
        { inactive: [r], text: ['ab', 'cdef', ''] },
      ];
      for (const state of states) {
        const result = f.reduce('C', state.inactive);
        invariant(result);
        expect(['fP', 'fL', 'fR'].map((flow) => f.text(result, flow))).toEqual(state.text);
        expect(result.runLayouts.find((run) => f.alias(run.run) === 'rL')).toEqual(lBefore);
        expect(result.resolveSlot(structuredClone(slot)).slot).toEqual(slot);
        expect(result.resolveSlot(slot).membership).toBe('available');
        expect(
          result
            .children(f.id('root', 'node'))
            .map((node) => f.alias(node))
            .filter((node) => node !== 'P')
            .sort(),
        ).toEqual(['L', 'R']);
        if (!state.inactive.length) {
          expect(result.children(f.id('root', 'node')).map((node) => f.alias(node))).toEqual([
            'P',
            'L',
            'R',
          ]);
          expect(f.cellRuns(result)).toEqual({
            P0: 'rP',
            P1: 'rP',
            P2: 'rL',
            P3: 'rR',
            P4: 'rR',
            P5: 'rR',
          });
          const skeleton = result.runLayouts.find((run) => f.alias(run.run) === 'rL')!.skeleton[0];
          expect(
            f.peers
              .get('C')!
              .range(skeleton)
              .map((part) => part.text)
              .join(''),
          ).toBe('cdef');
        }
        expect(f.peers.get('C')!.snapshot(f.id('tP', 'tape')).parts).toEqual(snapshots);
      }
    }
  },
);

it('walks a causally authored follower at the retained L end through ownership loss and retraction', () => {
  const f = fixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [...'abcdef'].map((text, index) => ({ id: `P${index}`, text })),
    },
    {
      id: 'Q',
      parent: 'root',
      role: 'inline',
      flow: 'fQ',
      run: 'rQ',
      tape: 'tQ',
      cells: [{ id: 'Q0', text: 'X' }],
    },
  ]);
  f.author('B1', (f) => [f.split('P', 'L', 'P1')]);
  f.author('A1', (f) => [f.split('P', 'R', 'P2')]);
  f.author('B2', (f) => [f.join('fQ', 'L:end')], ['B1'], 2n);
  const slot = structuredClone(f.slots.get('L:end')!);
  for (const inactive of [[], ['B1'], [], ['A1'], ['A1', 'B1']]) {
    f.fresh('C', ['B1', 'B2', 'A1']);
    const result = f.reduce('C', inactive);
    invariant(result);
    expect(f.text(result, 'fL')).toBe(
      inactive.includes('B1') ? 'X' : inactive.includes('A1') ? 'cdefX' : 'cX',
    );
    expect(result.resolveSlot(slot).slot).toEqual(slot);
    const followers = result.raw(f.id('fL', 'flow')).filter((entry) => entry.type === 'attachment');
    expect(followers).toHaveLength(1);
    expect(followers[0].target).toEqual(f.id('fQ', 'flow'));
  }
});

it.each([false, true])(
  'orders same-gap cuts by the two actual native client orders (swap %s)',
  (swap) => {
    const f = fixture();
    // Assign semantic A to each side of the native tie order, without replacing Yjs IDs.
    const [low, high] = [...f.peers.entries()]
      .filter(([name]) => name !== 'C')
      .sort((a, b) => a[1].clientId - b[1].clientId)
      .map(([name]) => name);
    const first = swap ? high : low;
    const second = swap ? low : high;
    f.author(`${first}1`, (f) => [f.split('P', 'L', 'P1')]);
    f.author(`${second}1`, (f) => [f.split('P', 'R', 'P1')]);
    for (const order of [
      [`${first}1`, `${second}1`],
      [`${second}1`, `${first}1`],
    ]) {
      f.fresh('C', order);
      const result = f.reduce();
      invariant(result);
      const cache = f.peers.get('C')!;
      const names = ['L', 'R'].sort(
        (a, b) =>
          cache.marker(f.id(`cut:${a}`, 'marker')).index -
          cache.marker(f.id(`cut:${b}`, 'marker')).index,
      );
      expect(result.children(f.id('root', 'node')).map((node) => f.alias(node))).toEqual([
        'P',
        ...names,
      ]);
      expect(names.map((name) => f.text(result, `f${name}`))).toEqual(['', 'cdef']);
      expect(
        cells(result, f, `f${names[0]}`).some(
          (assignment) => result.cells(assignment.cell).length === 1,
        ),
      ).toBe(true);
      expect(cells(result, f, `f${names[0]}`).length).toBeGreaterThan(0);
    }
  },
);

it.each([
  { after: null, retained: 'right' as const, expected: ['abcdef', ''] },
  { after: null, retained: 'left' as const, expected: ['', 'abcdef'] },
  { after: 'P5', retained: 'left' as const, expected: ['abcdef', ''] },
  { after: 'P2', retained: 'right' as const, expected: ['def', 'abc'] },
])(
  'keeps addressable start/end components: $after / $retained',
  ({ after, retained, expected }) => {
    const f = fixture();
    f.author('A1', (f) => [f.split('P', 'L', after, retained)]);
    const result = f.reduce('A');
    invariant(result);
    expect(['fP', 'fL'].map((flow) => f.text(result, flow))).toEqual(expected);
    expect(cells(result, f, 'fL').length).toBeGreaterThan(0);
  },
);

function lower(f: NativeFixture, intent: Intent): readonly SemanticEffect[] {
  switch (intent.type) {
    case 'split':
      return [
        f.split(
          intent.source,
          intent.node,
          intent.after,
          intent.retainedSide,
          intent.parent,
          intent.predecessor,
        ),
      ];
    case 'join':
      return [f.join(intent.source, intent.destinationSlot)];
    case 'transfer':
      return [f.transfer(intent.cells, intent.destinationSlot, intent.run)];
    case 'move':
      return [f.move(intent.node, intent.parent, intent.predecessor)];
    case 'insert':
      return f.insert(intent.cell, intent.text, intent.slot);
    case 'control':
      return [];
    default:
      throw new Error(`Unsupported ownership corpus intent ${intent.type}`);
  }
}
/** Uses corpus inputs only to author native bodies; expected observations never enter reduction.
 * This exercises implemented raw facets, not projection, readiness, or a replica factory.
 */
function checkCorpus(trace: ContractTrace): number {
  const f = fixture(trace.seed);
  const controls = new Map<string, readonly Intent[]>();
  let assertions = 0;
  for (const step of trace.steps) {
    if (step.type === 'author') {
      f.author(
        step.action.id,
        (f) => step.action.intents.flatMap((intent) => lower(f, intent)),
        step.action.dependencies,
        step.action.lamport,
      );
      controls.set(
        step.action.id,
        step.action.intents.filter((intent) => intent.type === 'control'),
      );
      for (const intent of step.action.intents)
        if (intent.type === 'insert') f.bindInserted(intent.cell, step.action.id);
    } else if (step.type === 'deliver') f.deliver(step.from, step.to, step.actions);
    else if (step.type === 'expect') {
      const activity = new Map<string, boolean>();
      for (const name of f
        .ready(step.peer)
        .sort(
          (a, b) =>
            Number(f.actions.get(a)!.action.lamport - f.actions.get(b)!.action.lamport) ||
            a.localeCompare(b),
        )) {
        for (const control of controls.get(name) ?? [])
          if (control.type === 'control')
            for (const target of control.actions) activity.set(target, control.active);
      }
      const result = f.reduce(
        step.peer,
        [...activity].filter(([, active]) => !active).map(([name]) => name),
      );
      invariant(result);
      if (trace.id === 'same-gap-empty-cut') {
        const cache = f.peers.get(step.peer)!;
        const markers = ['L', 'R']
          .map((name) => f.id(`cut:${name}`, 'marker'))
          .sort((a, b) => cache.marker(a).index - cache.marker(b).index);
        f.emptyAliases.set('between-cuts', {
          tape: f.id('tP', 'tape'),
          start: markers[0],
          end: markers[1],
        });
      }
      const known = new Set(Object.keys(f.cellRuns(result)));
      const state: Partial<Observation> = {
        cellRuns: f.cellRuns(result),
        rawParents: Object.fromEntries(
          result.nodeAllocations.map((node) => [
            f.alias(node.id),
            result.blockPlacement(node.id)
              ? f.alias(result.blockPlacement(node.id)!.slot.parent)
              : null,
          ]),
        ),
        flowParents: Object.fromEntries(
          result.flowPlacements.map((placement) => [
            f.alias(placement.flow),
            placement.parent.type === 'block'
              ? `block:${f.alias(placement.parent.node)}`
              : `flow:${f.alias(f.runFlow(placement.parent.slot.run))}@${[...f.slots].find(([, slot]) => resourceKey(slot.run) === resourceKey(placement.parent.type === 'flow' ? placement.parent.slot.run : placement.flow) && placement.parent.type === 'flow' && resourceKey(slot.boundary) === resourceKey(placement.parent.slot.boundary))?.[0]}`,
          ]),
        ),
        runFlows: Object.fromEntries(
          result.runLayouts.map((run) => [f.alias(run.run), f.alias(run.flow)]),
        ),
        skeletons: Object.fromEntries(
          result.runLayouts
            .map((run) => [
              f.alias(run.run),
              [...f.aliases]
                .filter(
                  ([alias, token]) =>
                    known.has(alias) &&
                    run.skeleton.some((range) =>
                      f.peers
                        .get(step.peer)!
                        .lookup(token)
                        .every((part) =>
                          f.peers
                            .get(step.peer)!
                            .range(range)
                            .some(
                              (piece) =>
                                piece.range.client === part.range.client &&
                                piece.range.clock <= part.range.clock &&
                                piece.range.clock + piece.range.length >=
                                  part.range.clock + part.range.length,
                            ),
                        ),
                    ),
                )
                .map(([alias]) => alias),
            ])
            .filter(([, aliases]) => aliases.length > 0),
        ),
      };
      for (const facet of [
        'cellRuns',
        'rawParents',
        'flowParents',
        'runFlows',
        'skeletons',
      ] as const) {
        if (step.state[facet]) {
          expect(state[facet], `${trace.id} ${step.peer}.${facet}`).toEqual(step.state[facet]);
          assertions++;
        }
      }
      const full = result.flowPlacements.filter((placement) => placement.parent.type === 'block');
      if (step.state.visible) {
        // No visibility effects in these selected traces. Compare exact native identities/order.
        const actual = Object.fromEntries(
          full.map((placement) => {
            const native = result
              .raw(placement.flow)
              .flatMap((entry) => (entry.type === 'cell' ? entry.fragments : []));
            const aliases = native.flatMap((part) =>
              [...f.aliases]
                .filter(
                  ([, token]) =>
                    token.client === part.range.client &&
                    token.clock >= part.range.clock &&
                    token.clock + token.length <= part.range.clock + part.range.length,
                )
                .sort((a, b) => a[1].clock - b[1].clock)
                .map(([alias]) => alias),
            );
            const node = placement.parent.type === 'block' ? f.alias(placement.parent.node) : '';
            return [node, aliases];
          }),
        );
        for (const [node, aliases] of Object.entries(step.state.visible))
          expect(actual[node], `${trace.id} ${node} raw native order`).toEqual(aliases);
        assertions++;
      }
    } else throw new Error(`Unsupported ownership corpus step ${step.type}`);
  }
  return assertions;
}
const corpus = [
  'cuts-earlier-first',
  'cuts-later-first',
  'same-gap-empty-cut',
  'split-at-zero-retains-original-right',
  'cross-tape-join',
  'split-inside-cross-tape-join',
  'opposing-joins',
  'move-overrides-join',
  'overlapping-transfers',
  'ghost-destination-slot',
  'split-sibling-keeps-authored-outer-context',
  'split-sibling-keeps-authored-outer-context-reverse',
  'undo-split-after-peer-insert',
  'undo-cross-tape-join',
];
it.each(corpus)('compares actual native ownership/layout corpus facets: %s', (id) => {
  const trace = contractCorpus.find((trace) => trace.id === id)!;
  expect(trace).toBeDefined();
  expect(checkCorpus(trace)).toBeGreaterThan(0);
});

it('rejects missing/conflicting homes and unknown endpoints without mutating input or native state', () => {
  const f = fixture();
  const snapshot = f.peers.get('A')!.snapshot(f.id('tP', 'tape'));
  const input = {
    genesis: f.genesis,
    actions: [],
    snapshots: [snapshot],
    homes: f.homes,
    isActive: () => true,
  };
  expect(() => reduceOwnership({ ...input, homes: [] })).toThrow('Incomplete home');
  expect(() => reduceOwnership({ ...input, homes: [...f.homes, ...f.homes] })).toThrow(
    'Conflicting home',
  );
  expect(() =>
    reduceOwnership({
      ...input,
      homes: [
        {
          ...f.homes[0],
          cell: { ...f.homes[0].cell, end: { ...f.homes[0].cell.end, ordinal: 999 } },
        },
      ],
    }),
  ).toThrow('Home endpoints');
  const before = {
    ...structuredClone({ ...input, isActive: undefined }),
    isActive: input.isActive,
  };
  expect(() => reduceOwnership(input)).not.toThrow();
  expect(input).toEqual(before);
  expect(f.peers.get('A')!.snapshot(f.id('tP', 'tape'))).toEqual(snapshot);
});

const twoParagraphs = [
  { id: 'root', parent: null, role: 'root' as const },
  {
    id: 'P',
    parent: 'root',
    role: 'inline' as const,
    flow: 'fP',
    run: 'rP',
    tape: 'tP',
    cells: [...'abcd'].map((text, index) => ({ id: `P${index}`, text })),
  },
  {
    id: 'Q',
    parent: 'root',
    role: 'inline' as const,
    flow: 'fQ',
    run: 'rQ',
    tape: 'tQ',
    cells: [...'XY'].map((text, index) => ({ id: `Q${index}`, text })),
  },
];

it('replays a split across two tapes using the joined prefix, then stops when a join is later or inactive', () => {
  const f = fixture(twoParagraphs);
  f.author('A1', (f) => [f.join('fQ', 'P:end')]);
  f.deliver('A', 'B', ['A1']);
  const pRange = f.homes[0].cell;
  const qRange = f.homes[1].cell;
  const basis = [
    { range: pRange, occurrence: f.id('P:birth', 'occurrence') },
    { range: qRange, occurrence: f.id('Q:birth', 'occurrence') },
  ];
  f.author('B1', (f) => [f.split('P', 'S', 'P1', 'left', 'root', 'P:birth', basis)], ['A1'], 2n);
  f.fresh('C', ['A1', 'B1']);
  const joined = f.reduce();
  invariant(joined);
  expect(f.text(joined, 'fP')).toBe('ab');
  expect(f.text(joined, 'fS')).toBe('cdXY');
  expect(joined.runLayouts.find((run) => f.alias(run.run) === 'rS')!.skeleton).toHaveLength(2);
  const inactive = f.reduce('C', ['A1']);
  invariant(inactive);
  expect(f.text(inactive, 'fS')).toBe('cd');
  expect(f.text(inactive, 'fQ')).toBe('XY');
  // Replaying with a changed activity must not reuse the final joined graph.
  expect(f.text(f.reduce(), 'fS')).toBe('cdXY');
});

it('resolves every effect in a multi-effect action against its own layout prefix', () => {
  const f = fixture(twoParagraphs);
  f.author('A1', (f) => [f.join('fQ', 'P:end'), f.split('Q', 'S', 'Q0')]);
  const result = f.reduce('A');
  invariant(result);
  expect(f.text(result, 'fP')).toBe('abcdX');
  expect(f.text(result, 'fS')).toBe('Y');
  expect(result.flowBlock(f.id('fQ', 'flow'))).toEqual(f.id('P', 'node'));
});

it('stops split selection at a same-flow layout discontinuity', () => {
  const f = fixture(twoParagraphs);
  // Q is inserted in the middle of P; tape adjacency alone must not jump over Q.
  f.author('A1', (f) => [f.join('fQ', 'P:after-c')]);
  f.deliver('A', 'B', ['A1']);
  f.author('B1', (f) => [f.split('P', 'S', 'P1')], ['A1'], 2n);
  f.fresh('C', ['A1', 'B1']);
  const result = f.reduce();
  invariant(result);
  expect(f.text(result, 'fS')).toBe('c');
  expect(f.text(result, 'fP')).toBe('abXYd');
  expect(f.cellRuns(result)).toMatchObject({ P2: 'rS', P3: 'rP' });
});

it('uses authored cross-tape transfer order and retains a source insertion cell for continued typing', () => {
  const f = fixture(twoParagraphs);
  f.author('A1', (f) => [f.transfer(['Q1', 'Q0'], 'P:end', 'rT')]);
  const before = f.reduce('A');
  invariant(before);
  expect(f.text(before, 'fP')).toBe('abcdYX');
  expect(f.text(before, 'fQ')).toBe('');
  expect(cells(before, f, 'fQ').length).toBeGreaterThan(0);
  const oldIds = f.aliases.get('Q0')!;
  f.author('A2', (f) => f.insert('fresh', 'z', 'Q:end'), ['A1'], 2n);
  f.bindInserted('fresh', 'A2');
  const after = f.reduce('A');
  invariant(after);
  expect(f.text(after, 'fP')).toBe('abcdYX');
  expect(f.text(after, 'fQ')).toBe('z');
  expect(after.tokenOwners(oldIds)[0].run).toEqual(f.id('rT', 'run'));
  expect(after.inlineOwner(f.aliases.get('fresh')!)).toEqual([f.id('Q', 'node')]);
  const slot = f.slots.get('Q:end')!;
  expect(after.resolveSlot(slot).slot).toEqual(slot);
});

it('keeps both seam affinities tied to their permanent cells after a transfer', () => {
  const f = fixture(twoParagraphs);
  f.author('A1', (f) => [f.transfer(['P1', 'P2'], 'Q:end', 'rT')]);
  const range = f.ranges.get('P1')!;
  f.slots.set('before-transfer', {
    run: f.id('rP', 'run'),
    boundary: range.start,
    side: 'left',
    predecessor: null,
  });
  f.slots.set('inside-transfer', {
    run: f.id('rP', 'run'),
    boundary: range.start,
    side: 'right',
    predecessor: null,
  });
  f.deliver('A', 'B', ['A1']);
  f.author('A2', (f) => f.insert('left', 'l', 'before-transfer'), ['A1'], 2n);
  f.bindInserted('left', 'A2');
  f.author('B1', (f) => f.insert('right', 'r', 'inside-transfer'), ['A1'], 2n);
  f.bindInserted('right', 'B1');
  for (const order of [
    ['A1', 'A2', 'B1'],
    ['A1', 'B1', 'A2'],
  ]) {
    f.fresh('C', order);
    const result = f.reduce();
    invariant(result);
    expect(f.text(result, 'fP')).toBe('ald');
    expect(f.text(result, 'fQ')).toBe('XYrbc');
    expect(f.cellRuns(result)).toMatchObject({ left: 'rP', right: 'rT' });
  }
});

it('reorders in one flow and transfers the same identities repeatedly without moving its own target', () => {
  const f = fixture(twoParagraphs);
  f.author('A1', (f) => [f.transfer(['P1', 'P2'], 'P:end', 'rT')]);
  expect(f.text(f.reduce('A'), 'fP')).toBe('adbc');
  f.author('A2', (f) => [f.transfer(['P2'], 'Q:end', 'rU')], ['A1'], 2n);
  const second = f.reduce('A');
  invariant(second);
  expect(f.text(second, 'fP')).toBe('adb');
  expect(f.text(second, 'fQ')).toBe('XYc');
  f.author('A3', (f) => [f.transfer(['P2', 'P1'], 'P:start', 'rV')], ['A2'], 3n);
  const third = f.reduce('A');
  invariant(third);
  expect(f.text(third, 'fP')).toBe('cbad');
  expect(f.text(third, 'fQ')).toBe('XY');
  expect(third.tokenOwners(f.aliases.get('P2')!)[0].run).toEqual(f.id('rV', 'run'));
});

it('reaches later followers through an inactive transfer occurrence without reassigning its text', () => {
  const f = fixture([
    ...twoParagraphs,
    {
      id: 'R',
      parent: 'root',
      role: 'inline',
      flow: 'fR',
      run: 'rR',
      tape: 'tR',
      cells: [{ id: 'R0', text: 'Z' }],
    },
  ]);
  f.author('A1', (f) => [f.transfer(['Q0', 'Q1'], 'P:end', 'rT')]);
  f.slots.set('transfer:end', {
    run: f.id('rT', 'run'),
    boundary: f.ranges.get('Q1')!.end,
    side: 'left',
    predecessor: null,
  });
  f.author('A2', (f) => [f.join('fR', 'transfer:end')], ['A1'], 2n);
  const result = f.reduce('A', ['A1']);
  invariant(result);
  expect(f.text(result, 'fP')).toBe('abcdZ');
  expect(f.text(result, 'fQ')).toBe('XY');
  expect(result.tokenOwners(f.aliases.get('Q0')!)[0].run).toEqual(f.id('rQ', 'run'));
});
