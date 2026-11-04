import { afterEach, expect, test } from 'vitest';
import type { ActionEnvelope } from './contracts.js';
import type { LayoutGenesis } from './layout/index.js';
import { resourceKey } from './layout/index.js';
import { NativeFixture } from './ownership/test-fixtures.js';
import type { NativeBody } from './text/cache.js';
import { openReferenceDocument } from './reference/document.js';
import {
  ProvenanceError,
  reconstructBirths,
  reconstructProvenance,
} from './reference/provenance.js';

// Fixed regressions for the approved grain/89 constructor rule. NativeFixture
// prepares envelopes only; each document reconstructs provenance from retained facts.
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const paragraph = (id: string, text: string, parent = 'root') => ({
  id,
  parent,
  role: 'inline' as const,
  flow: `f${id}`,
  run: `r${id}`,
  tape: `t${id}`,
  cells: [...text].map((text, i) => ({ id: `${id}${i}`, text })),
});

function open(genesis: LayoutGenesis, body: NativeBody) {
  const document = openReferenceDocument({
    documentId: 'D',
    genesisId: 'G',
    layout: genesis,
    body,
  });
  cleanup.push(() => document.destroy());
  return {
    store: document.store,
    publish() {
      const result = document.publication.refresh();
      if (result.state !== 'complete') throw new Error('Unexpected deferred reconstruction');
      return result.value;
    },
  };
}
function constructorCoverage(genesis: LayoutGenesis, actions: readonly ActionEnvelope[]) {
  return reconstructProvenance(genesis, actions).birthContent;
}

function retract(target: ActionEnvelope): ActionEnvelope {
  return {
    ...structuredClone(target),
    id: { ...target.id, sequence: 2n },
    lamport: 2n,
    dependencies: [target.id],
    groupId: { ...target.groupId, sequence: 2n },
    allocations: [],
    nativeManifest: [],
    nativeInsertUpdates: [],
    effects: [
      {
        type: 'SetGroupActive',
        group: target.groupId,
        actions: [target.id],
        active: false,
        previousControl: null,
      },
    ],
  };
}

function fixture() {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'W', parent: 'root', role: 'quote' },
    paragraph('P', 'abc'),
    paragraph('Q', ''),
    paragraph('R', 'XY'),
  ]);
  cleanup.push(() => f.destroy());
  return f;
}
function peer(f: NativeFixture) {
  return open(f.genesis, { ...f.bodies.get('G')!, allocations: f.genesis.allocations });
}
function append(f: NativeFixture, names: readonly string[]) {
  const p = peer(f);
  for (const name of names) p.store.append(f.envelope(name));
  expect(p.store.snapshot().ready).toHaveLength(names.length);
  return p;
}
function textEntry(
  p: ReturnType<ReturnType<typeof open>['publish']>,
  range: import('./contracts.js').NativeTextRange,
) {
  return p.value.visibility.text.filter(
    (entry) =>
      resourceKey(entry.token.tape) === resourceKey(range.tape) &&
      entry.token.native.client === range.client &&
      entry.token.native.clock >= range.clock &&
      entry.token.native.clock < range.clock + range.length,
  );
}
function reconstruct(f: NativeFixture, p: ReturnType<typeof open>) {
  const bytes = p.store.encodeUpdate();
  const before = p.publish();
  const fresh = peer(f);
  fresh.store.applyUpdate(bytes);
  const after = fresh.publish();
  expect(after.value.view).toEqual(before.value.view);
  expect(after.value.visibility).toEqual(before.value.visibility);
  expect(after.value.ownership.assignments).toEqual(before.value.ownership.assignments);
  expect(after.value.ownership.runLayouts).toEqual(before.value.ownership.runLayouts);
  for (const node of before.value.ownership.nodeAllocations)
    expect(after.value.ownership.blockPlacement(node.id)).toEqual(
      before.value.ownership.blockPlacement(node.id),
    );
  expect(after.value.ownership.flowPlacements).toEqual(before.value.ownership.flowPlacements);
  expect(after.native.lookup(f.aliases.get('P1')!)).toEqual(
    before.native.lookup(f.aliases.get('P1')!),
  );
  expect(fresh.store.encodeUpdate()).toEqual(bytes);
  expect(p.store.encodeUpdate()).toEqual(bytes);
  return before;
}

test.each([false, true].flatMap((split) => [false, true].map((reverse) => ({ split, reverse }))))(
  'fixed retained constructor rule: split=$split, reverse=$reverse',
  ({ split, reverse }) => {
    const f = fixture();
    f.author('A1', (f) => {
      if (split)
        return [
          f.split('P', 'N', 'P0', 'left', 'W', null),
          f.transfer(['P1', 'P2'], 'Q:home-end', 'out'),
        ];
      f.createBlock(paragraph('N', '', 'W'), null);
      return [
        f.transfer(['P1', 'P2'], 'N:home-end', 'in'),
        f.transfer(['P1', 'P2'], 'Q:home-end', 'out'),
      ];
    });
    f.author('B1', (f) => [f.deleteSubtree('W', [], [])]);
    const a = append(f, ['A1']);
    const b = append(f, ['B1']);
    const p = peer(f);
    const updates = [a.store.encodeUpdate(), b.store.encodeUpdate()];
    for (const update of reverse ? updates.toReversed() : updates) p.store.applyUpdate(update);
    expect(p.store.snapshot().ready).toHaveLength(2);
    const state = reconstruct(f, p);
    expect(textEntry(state, f.aliases.get('P1')!)[0].visible).toBe(!split);
    expect(textEntry(state, f.aliases.get('P2')!)[0].visible).toBe(!split);
    expect(state.value.ownership.inlineOwner(f.aliases.get('P1')!)).toEqual([f.id('Q', 'node')]);
    const ours = constructorCoverage(f.genesis, [f.envelope('A1')]);
    // Reordering the allocation array cannot choose a different constructor.
    expect(
      constructorCoverage(f.genesis, [
        { ...f.envelope('A1'), allocations: f.envelope('A1').allocations.toReversed() },
      ])
        .map((e) => [resourceKey(e.node), e.intervals])
        .sort(),
    ).toEqual(ours.map((e) => [resourceKey(e.node), e.intervals]).sort());
  },
);

test.each([false, true])(
  'ordinary join changes current ownership but not birth coverage; evacuate=%s',
  (evacuate) => {
    const f = fixture();
    f.author('A1', (f) => {
      f.createBlock(paragraph('N', '', 'W'), null);
      return [
        f.join('fR', 'N:home-end'),
        ...(evacuate ? [f.transfer(['R0', 'R1'], 'Q:home-end', 'out')] : []),
      ];
    });
    f.author('B1', (f) => [f.deleteSubtree('W', [], [])]);
    const p = append(f, ['A1', 'B1']);
    const state = reconstruct(f, p);
    const x = textEntry(state, f.aliases.get('R0')!)[0];
    expect(x.tags).toEqual([]);
    expect(x.deletedDestination).toBe(!evacuate);
    expect(x.visible).toBe(evacuate);
  },
);

test.each([false, true])(
  'later insertion in captured interval follows the constructor mask; split=%s',
  (split) => {
    const f = fixture();
    f.author('A1', (f) => {
      if (split)
        return [
          f.split('P', 'N', 'P0', 'left', 'W', null),
          f.transfer(['P1', 'P2'], 'Q:home-end', 'out'),
        ];
      f.createBlock(paragraph('N', '', 'W'), null);
      return [
        f.transfer(['P1', 'P2'], 'N:home-end', 'in'),
        f.transfer(['P1', 'P2'], 'Q:home-end', 'out'),
      ];
    });
    f.author('B1', (f) => [f.deleteSubtree('W', [], [])]);
    f.deliver('A', 'C', ['A1']);
    f.author('C1', (f) => f.insert('cx', 'x', 'P:after-b'), ['A1'], 2n);
    f.bindInserted('cx', 'C1');
    const p = append(f, ['A1', 'C1', 'B1']);
    const state = reconstruct(f, p);
    const x = textEntry(state, f.aliases.get('cx')!)[0];
    expect(x.visible).toBe(!split);
    expect(x.tags).toHaveLength(split ? 1 : 0);
    expect(x.deletedDestination).toBe(false);
  },
);

test.each([false, true])(
  'private-home insertion retains mask after evacuation; split=%s',
  (split) => {
    const f = fixture();
    f.author('A1', (f) => {
      if (split) return [f.split('P', 'N', 'P0', 'left', 'W', null)];
      f.createBlock(paragraph('N', '', 'W'), null);
      return [];
    });
    f.author('B1', (f) => [f.deleteSubtree('W', [], [])]);
    f.deliver('A', 'C', ['A1']);
    f.author('C1', (f) => f.insert('cx', 'x', 'N:home-end'), ['A1'], 2n);
    f.bindInserted('cx', 'C1');
    f.author(
      'C2',
      (f) => [
        f.transferRanges(
          f.peers
            .get('C')!
            .snapshot(f.id('tN', 'tape'))
            .parts.filter((p) => p.type === 'text')
            .map((p) => {
              if (p.type !== 'text') throw new Error();
              const snapshot = f.peers.get('C')!.snapshot(f.id('tN', 'tape'));
              const left = snapshot.parts.findLast(
                (e) => e.type === 'marker' && e.index < p.index,
              )!;
              const right = snapshot.parts.find((e) => e.type === 'marker' && e.index > p.index)!;
              if (left.type !== 'marker' || right.type !== 'marker') throw new Error();
              return { tape: snapshot.tape, start: left.marker, end: right.marker };
            }),
          f.slots.get('Q:home-end')!,
          'outX',
        ),
      ],
      ['C1'],
      3n,
    );
    const p = append(f, ['A1', 'C1', 'C2', 'B1']);
    const state = reconstruct(f, p);
    const x = textEntry(state, f.aliases.get('cx')!)[0];
    expect(x.visible).toBe(false);
    expect(x.tags).toHaveLength(1);
    expect(x.deletedDestination).toBe(false);
    expect(state.value.ownership.inlineOwner(f.aliases.get('cx')!)).toEqual([f.id('Q', 'node')]);
  },
);

test('inactive split constructor retains its mask, excluding later same-action visits', () => {
  const f = fixture();
  f.author('A1', (f) => [
    f.split('P', 'N', 'P0', 'left', 'W', null),
    f.transfer(['P1', 'P2'], 'Q:home-end', 'out'),
    f.transfer(['P0'], 'N:home-end', 'inA'),
    f.transfer(['P0'], 'Q:home-end', 'outA'),
  ]);
  f.author('B1', (f) => [f.deleteSubtree('W', [], [])]);
  const p = append(f, ['A1', 'B1']);
  const before = reconstruct(f, p);
  const coverage = constructorCoverage(f.genesis, p.store.snapshot().ready);
  expect(textEntry(before, f.aliases.get('P0')!)[0].visible).toBe(true);
  expect(textEntry(before, f.aliases.get('P1')!)[0].visible).toBe(false);
  p.store.append(retract(f.envelope('A1')));
  expect(p.store.snapshot().ready).toHaveLength(3);
  expect(constructorCoverage(f.genesis, p.store.snapshot().ready)).toEqual(coverage);
  const after = reconstruct(f, p);
  expect(textEntry(after, f.aliases.get('P0')!)[0].visible).toBe(true);
  expect(textEntry(after, f.aliases.get('P1')!)[0].visible).toBe(false);
  expect(after.value.ownership.inlineOwner(f.aliases.get('P1')!)).toEqual([f.id('P', 'node')]);
});

test('joined source in exact dependency closure contributes both tapes to split constructor', () => {
  const f = fixture();
  f.author('A1', (f) => [f.join('fR', 'P:end')]);
  f.author(
    'A2',
    (f) => [
      f.split(
        'P',
        'N',
        'P0',
        'left',
        'W',
        null,
        ['P', 'R'].map((name) => ({
          range: f.contentRanges.get(name)![0],
          occurrence: f.id(`${name}:birth`, 'occurrence'),
        })),
      ),
      f.transfer(['P1', 'P2', 'R0', 'R1'], 'Q:home-end', 'out'),
    ],
    ['A1'],
    2n,
  );
  f.author('B1', (f) => [f.deleteSubtree('W', [], [])]);
  const p = append(f, ['A1', 'A2', 'B1']);
  const state = reconstruct(f, p);
  for (const name of ['P1', 'P2', 'R0', 'R1']) {
    const e = textEntry(state, f.aliases.get(name)!)[0];
    expect(e.visible).toBe(false);
    expect(e.tags).toHaveLength(1);
    expect(e.deletedDestination).toBe(false);
  }
  // Same candidate/native body; its exact dependency closure has no join.
  // No marker IDs are rewritten and the author remains sequence 2.
  const bad = peer(f);
  bad.store.append({ ...f.envelope('A1'), effects: [] });
  expect(bad.store.snapshot().ready).toHaveLength(1);
  bad.store.append(f.envelope('A2'));
  expect(bad.store.snapshot().ready).toHaveLength(1);
  expect(bad.store.snapshot().actions.find((entry) => entry.id.sequence === 2n)!.readiness).toEqual(
    { state: 'quarantined', reason: 'reference' },
  );
});

test('a transfer before the split constructor does not become its birth content', () => {
  const f = fixture();
  f.author('A1', (f) => {
    const split = f.split('P', 'N', 'P0', 'left', 'W', null);
    return [
      f.transfer(['R0'], 'N:home-end', 'preVisit'),
      split,
      f.transfer(['P1', 'P2', 'R0'], 'Q:home-end', 'evacuate'),
    ];
  });
  f.author('B1', (f) => [f.deleteSubtree('W', [], [])]);
  const p = append(f, ['A1', 'B1']);
  const state = reconstruct(f, p);
  expect(textEntry(state, f.aliases.get('R0')!)[0].visible).toBe(true);
  expect(textEntry(state, f.aliases.get('P1')!)[0].visible).toBe(false);
  const finalOwners = ['R0', 'P1', 'P2'].map((name) =>
    state.value.ownership.inlineOwner(f.aliases.get(name)!),
  );
  expect(finalOwners).toEqual(Array.from({ length: 3 }, () => [f.id('Q', 'node')]));
});

test('a join before a same-action split is part of the source component, not an incoming destination visit', () => {
  const f = fixture();
  f.author('A1', (f) => [
    f.join('fR', 'P:end'),
    f.split(
      'P',
      'N',
      'P0',
      'left',
      'W',
      null,
      ['P', 'R'].map((name) => ({
        range: f.contentRanges.get(name)![0],
        occurrence: f.id(`${name}:birth`, 'occurrence'),
      })),
    ),
    f.transfer(['P1', 'P2', 'R0', 'R1'], 'Q:home-end', 'out'),
  ]);
  f.author('B1', (f) => [f.deleteSubtree('W', [], [])]);
  const p = append(f, ['A1', 'B1']);
  const state = reconstruct(f, p);
  for (const name of ['P1', 'P2', 'R0', 'R1'])
    expect(textEntry(state, f.aliases.get(name)!)[0].visible).toBe(false);
});

test('ordinary births bind by predecessor slots, independent of allocation order', () => {
  const f = fixture();
  f.author('A1', (f) => {
    f.createBlock(paragraph('N', '', 'W'), null);
    f.createBlock(paragraph('M', '', 'W'), 'N:birth');
    return [];
  });
  const original = f.envelope('A1');
  const occurrence = {
    kind: 'occurrence' as const,
    birth: { type: 'action' as const, action: original.id },
    ordinal: 1000,
  };
  const slot = { parent: f.id('W', 'node'), predecessor: null };
  const a: ActionEnvelope = {
    ...original,
    allocations: [...original.allocations, { type: 'occurrence', id: occurrence, slot }],
    effects: [
      {
        type: 'MoveBlock',
        node: f.id('N', 'node'),
        occurrence,
        slot,
        standaloneFlow: f.id('fN', 'flow'),
      },
    ],
  };
  const expected = ['N', 'M'].map((name) => ({
    node: f.id(name, 'node'),
    occurrence: f.id(`${name}:birth`, 'occurrence'),
  }));
  expect(reconstructBirths(a)).toEqual(expected);
  expect(reconstructBirths({ ...a, allocations: a.allocations.toReversed() }).toReversed()).toEqual(
    expected,
  );
  const p = peer(f);
  p.store.append(a);
  expect(p.store.snapshot().ready).toEqual([a]);
  reconstruct(f, p);
});

test('colliding ordinary birth slots stop reconstruction instead of choosing by array order', () => {
  const f = fixture();
  f.author('A1', (f) => {
    f.createBlock(paragraph('N', '', 'W'), null);
    f.createBlock(paragraph('M', '', 'W'), null);
    return [];
  });
  const a = f.envelope('A1');
  expect(() => reconstructBirths(a)).toThrow(ProvenanceError);
  expect(() => reconstructBirths({ ...a, allocations: a.allocations.toReversed() })).toThrow(
    ProvenanceError,
  );
});

test('duplicate explicit constructors and mismatched slots stop provenance assembly', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'N', 'P0', 'left', 'W', null)]);
  const a = f.envelope('A1');
  expect(() => reconstructBirths({ ...a, effects: [...a.effects, a.effects[0]] })).toThrow(
    ProvenanceError,
  );
  const effects = a.effects.map((effect) =>
    effect.type === 'SplitFlow'
      ? {
          ...effect,
          outerSlot: { parent: f.id('root', 'node'), predecessor: null },
        }
      : effect,
  );
  expect(() => reconstructBirths({ ...a, effects })).toThrow(ProvenanceError);
});

test.each([false, true])(
  'constructor coverage survives independent deletion and construction controls; split=%s',
  (split) => {
    const f = fixture();
    f.author('A1', (f) => {
      if (split)
        return [
          f.split('P', 'N', 'P0', 'left', 'W', null),
          f.transfer(['P1', 'P2'], 'Q:home-end', 'out'),
        ];
      f.createBlock(paragraph('N', '', 'W'), null);
      return [
        f.transfer(['P1', 'P2'], 'N:home-end', 'in'),
        f.transfer(['P1', 'P2'], 'Q:home-end', 'out'),
      ];
    });
    f.author('B1', (f) => [f.deleteSubtree('W', [], [])]);
    const a = append(f, ['A1']);
    const b = append(f, ['B1']);
    const p = peer(f);
    p.store.applyUpdate(a.store.encodeUpdate());
    p.store.applyUpdate(b.store.encodeUpdate());
    const initial = reconstruct(f, p);
    expect(textEntry(initial, f.aliases.get('P1')!)[0].visible).toBe(!split);
    const vectorB = b.store.encodeStateVector();
    b.store.append(retract(f.envelope('B1')));
    p.store.applyUpdate(b.store.encodeUpdate(vectorB));
    expect(textEntry(reconstruct(f, p), f.aliases.get('P1')!)[0].visible).toBe(true);
    const vectorA = a.store.encodeStateVector();
    a.store.append(retract(f.envelope('A1')));
    p.store.applyUpdate(a.store.encodeUpdate(vectorA));
    const final = reconstruct(f, p);
    expect(textEntry(final, f.aliases.get('P1')!)[0].visible).toBe(true);
    expect(final.value.ownership.inlineOwner(f.aliases.get('P1')!)).toEqual([f.id('P', 'node')]);
  },
);

test('an empty split constructor cannot claim unrelated content in its retained skeleton', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('Q', 'N', null, 'left', 'W', null)]);
  const a = f.envelope('A1');
  const split = a.effects.find((effect) => effect.type === 'SplitFlow')!;
  if (split.type !== 'SplitFlow') throw new Error('Missing constructor');
  const forged = {
    ...a,
    allocations: a.allocations.map((entry) =>
      entry.type === 'run' && resourceKey(entry.id) === resourceKey(split.newRun)
        ? { ...entry, skeleton: [...f.contentRanges.get('P')!, ...entry.skeleton] }
        : entry,
    ),
  };
  const p = peer(f);
  p.store.append(forged);
  expect(p.store.snapshot().ready).toEqual([]);
  expect(p.store.snapshot().actions[0].readiness).toEqual({
    state: 'quarantined',
    reason: 'reference',
  });
});

test.each(['text', 'move', 'child'] as const)(
  'a source-deleted split keeps independent %s without a historical-source tombstone',
  (survivor) => {
    const f = fixture();
    f.author('A1', (f) => [f.split('P', 'N', 'P0', 'left', 'root', null)]);
    f.author('B1', (f) => [f.deleteSubtree('P', f.contentRanges.get('P')!, [])]);
    f.deliver('A', 'C', ['A1']);
    f.author(
      'C1',
      (f) => {
        if (survivor === 'text') return f.insert('cx', 'x', 'N:home-end');
        if (survivor === 'move') return [f.move('N', 'W')];
        f.createBlock(paragraph('child', 'x', 'N'), null);
        return [];
      },
      ['A1'],
      2n,
    );
    if (survivor === 'text') f.bindInserted('cx', 'C1');
    const state = reconstruct(f, append(f, ['A1', 'B1', 'C1']));
    const n = state.value.visibility.nodes.find(
      (n) => resourceKey(n.node) === resourceKey(f.id('N', 'node')),
    )!;
    expect(n).toMatchObject({ deleted: false, available: true, suppressed: false, scaffold: true });
    if (survivor === 'text') expect(textEntry(state, f.aliases.get('cx')!)[0].visible).toBe(true);
    expect(textEntry(state, f.aliases.get('P1')!)[0].visible).toBe(false);
  },
);

test('source-deleted split suppression reverses with the deleting owner control', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'N', 'P0', 'left', 'root', null)]);
  f.author('B1', (f) => [f.deleteSubtree('P', f.contentRanges.get('P')!, [])]);
  const p = append(f, ['A1', 'B1']);
  const before = reconstruct(f, p);
  const n = (s: typeof before) =>
    s.value.visibility.nodes.find((n) => resourceKey(n.node) === resourceKey(f.id('N', 'node')))!;
  expect(n(before)).toMatchObject({ deleted: false, suppressed: true, available: false });
  p.store.append(retract(f.envelope('B1')));
  const after = reconstruct(f, p);
  expect(n(after)).toMatchObject({ deleted: false, suppressed: false, available: true });
  expect(textEntry(after, f.aliases.get('P1')!)[0].visible).toBe(true);
});
