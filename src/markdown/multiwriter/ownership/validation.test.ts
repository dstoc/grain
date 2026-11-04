import { afterEach, expect, it } from 'vitest';
import type { ActionEnvelope, SemanticEffect } from '../contracts.js';
import { ActionStore } from '../actions/store.js';
import { createIngestValidator } from '../ingest/index.js';
import { reduceActivity } from '../visibility/activity.js';
import { reduceVisibility } from '../visibility/index.js';
import type { TextToken } from '../visibility/index.js';
import { resourceKey } from '../layout/index.js';
import type { BirthPlacement } from '../layout/index.js';
import { sameId } from './cells.js';
import { createOwnershipAuthorValidator } from './validation.js';
import { NativeFixture } from './test-fixtures.js';
import { reduceOwnership } from './ownership.js';
import { NativeTapeCache } from '../text/cache.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(cells: readonly { id: string; text: string }[] = []) {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'P', parent: 'root', role: 'inline', flow: 'fP', run: 'rP', tape: 'tP', cells },
    { id: 'Q', parent: 'root', role: 'inline', flow: 'fQ', run: 'rQ', tape: 'tQ', cells: [] },
  ]);
  cleanup.push(() => f.destroy());
  return f;
}
/** These cases create nodes only via SplitFlow, which carries exact birth bindings. */
function births(action: ActionEnvelope): readonly BirthPlacement[] {
  return action.effects.flatMap((effect) =>
    effect.type === 'SplitFlow' ? [{ node: effect.newNode, occurrence: effect.occurrence }] : [],
  );
}
function store(f: NativeFixture) {
  const validate = createIngestValidator({
    genesis: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
    validateAuthor: createOwnershipAuthorValidator({ genesis: f.genesis, births }),
  });
  const result = new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: f.genesis.allocations,
    validate,
  });
  cleanup.push(() => {
    result.destroy();
    validate.destroy();
  });
  return result;
}
function effect(action: ActionEnvelope) {
  return action.effects[0] as Extract<SemanticEffect, { type: 'SplitFlow' }>;
}
function rejected(f: NativeFixture, action: ActionEnvelope, dependencies: readonly string[] = []) {
  const peer = store(f);
  for (const name of dependencies) peer.append(f.envelope(name));
  peer.append(action);
  const snapshot = peer.snapshot();
  expect(snapshot.integrity).toBe(true);
  const candidate = snapshot.actions.find(
    (entry) => entry.id.actor === action.id.actor && entry.id.sequence === action.id.sequence,
  )!;
  expect(candidate.readiness).toEqual({ state: 'quarantined', reason: 'reference' });
  expect(
    snapshot.ready.some(
      (entry) => entry.id.actor === action.id.actor && entry.id.sequence === action.id.sequence,
    ),
  ).toBe(false);
}
it.each(
  (['left', 'right'] as const).flatMap((side) =>
    (['ordered', 'joined', 'disconnected', 'reordered'] as const).map((variant) => ({
      side,
      variant,
    })),
  ),
)('checks $variant author basis through MW-01/MW-15 ($side retained)', ({ side, variant }) => {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [...'abc'].map((text, i) => ({ id: `P${i}`, text })),
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
  cleanup.push(() => f.destroy());
  const dependencies = variant === 'joined' ? ['A1'] : [];
  if (variant === 'joined') f.author('A1', (f) => [f.join('fQ', 'P:end')]);
  const basis =
    variant === 'reordered'
      ? ['P0', 'P2', 'P1'].map((name) => ({
          range: f.ranges.get(name)!,
          occurrence: f.id('P:birth', 'occurrence'),
        }))
      : (variant === 'ordered' ? ['P'] : ['P', 'Q']).map((name) => ({
          range: f.contentRanges.get(name)![0],
          occurrence: f.id(`${name}:birth`, 'occurrence'),
        }));
  const name = variant === 'joined' ? 'A2' : 'A1';
  f.author(
    name,
    (f) => [f.split('P', 'S', 'P0', side, 'root', side === 'left' ? 'P:birth' : null, basis)],
    dependencies,
    BigInt(dependencies.length + 1),
  );
  if (variant === 'disconnected' || variant === 'reordered') {
    rejected(f, f.envelope(name), dependencies);
  } else {
    const peer = store(f);
    for (const dependency of dependencies) peer.append(f.envelope(dependency));
    peer.append(f.envelope(name));
    expect(peer.snapshot().actions.every((entry) => entry.readiness.state === 'ready')).toBe(true);
    const { result } = project(f, peer);
    const suffix = variant === 'joined' ? 'bcX' : 'bc';
    expect(f.text(result, 'fP')).toBe(side === 'left' ? 'a' : suffix);
    expect(f.text(result, 'fS')).toBe(side === 'left' ? suffix : 'a');
  }
});

it.each(['left', 'right'] as const)(
  'certifies the current traversal after a same-flow transfer (%s retained)',
  (side) => {
    const f = fixture([...'abc'].map((text, i) => ({ id: `P${i}`, text })));
    f.author('A1', (f) => [f.transfer(['P1'], 'P:end', 'rT')]);
    const before = f.reduce('A');
    expect(f.text(before, 'fP')).toBe('acb');
    const basis = ['P0', 'P2', 'P1'].map((name) => ({
      range: f.ranges.get(name)!,
      occurrence: before.tokenOwners(f.aliases.get(name)!)[0].occurrence,
    }));
    f.author(
      'A2',
      (f) => [f.split('P', 'S', 'P0', side, 'root', side === 'left' ? 'P:birth' : null, basis)],
      ['A1'],
      2n,
    );
    const peer = store(f);
    peer.append(f.envelope('A1'));
    peer.append(f.envelope('A2'));
    expect(peer.snapshot().ready).toHaveLength(2);
    const { result } = project(f, peer);
    expect(f.text(result, 'fP')).toBe(side === 'left' ? 'a' : 'cb');
    expect(f.text(result, 'fS')).toBe(side === 'left' ? 'cb' : 'a');
    const reopened = store(f);
    reopened.applyUpdate(peer.encodeUpdate());
    expect(project(f, reopened).result.assignments).toEqual(result.assignments);
  },
);

it.each(['b', ''])(
  'rejects a basis that skips an intervening ordinary cell containing %j',
  (text) => {
    const f = fixture([
      { id: 'P0', text: 'a' },
      { id: 'P1', text },
      { id: 'P2', text: 'c' },
    ]);
    const basis = ['P0', 'P2'].map((name) => ({
      range: f.ranges.get(name)!,
      occurrence: f.id('P:birth', 'occurrence'),
    }));
    f.author('A1', (f) => [f.split('P', 'S', 'P0', 'left', 'root', 'P:birth', basis)]);
    rejected(f, f.envelope('A1'));
  },
);

it.each([
  'missing-home',
  'foreign-home',
  'duplicate-home',
  'non-root-cut',
  'wrong-side',
  'wrong-marker',
  'wrong-predecessor',
  'captured-empty-home',
] as const)(
  'quarantines malformed retained empty-split facts through MW-01/MW-15: %s',
  (variant) => {
    const f = fixture();
    f.author('A1', (f) => [f.split('P', 'S', null)]);
    const action = f.envelope('A1');
    const split = effect(action);
    if (variant === 'missing-home') {
      (action as { allocations: ActionEnvelope['allocations'] }).allocations =
        action.allocations.map((allocation) =>
          allocation.type === 'run' ? { ...allocation, skeleton: [] } : allocation,
        );
    } else if (variant === 'foreign-home') {
      (action as { allocations: ActionEnvelope['allocations'] }).allocations =
        action.allocations.map((allocation) =>
          allocation.type === 'run' ? { ...allocation, skeleton: [f.homes[0].cell] } : allocation,
        );
    } else if (variant === 'duplicate-home') {
      (action as { allocations: ActionEnvelope['allocations'] }).allocations = [
        ...action.allocations,
        ...action.allocations.filter((allocation) => allocation.type === 'run'),
      ];
    } else if (variant === 'non-root-cut') {
      (split.cut as { run: typeof split.cut.run }).run = split.newRun;
    } else if (variant === 'wrong-side') {
      (split.cut as { side: 'left' | 'right' }).side = 'right';
    } else if (variant === 'wrong-marker') {
      (split.cut as { boundary: typeof split.cut.boundary }).boundary = f.id('P:start', 'marker');
    } else if (variant === 'wrong-predecessor') {
      (split.cut as { predecessor: typeof split.cut.predecessor }).predecessor = f.id(
        'P:birth',
        'occurrence',
      );
    } else {
      (split as { basis: typeof split.basis }).basis = {
        ranges: [{ range: f.homes[0].cell, occurrence: f.id('P:birth', 'occurrence') }],
      };
    }
    rejected(f, action);
  },
);
it.each(['x', ''])(
  'rejects a false empty basis even when omitted ordinary content is %j',
  (text) => {
    const f = fixture([{ id: 'P0', text }]);
    f.author('A1', (f) => [f.split('P', 'S', null, 'left', 'root', 'P:birth', [])]);
    rejected(f, f.envelope('A1'));
  },
);
it('rejects an empty basis that omits joined content and a cut addressed through a transfer run', () => {
  const f = fixture([{ id: 'P0', text: 'x' }]);
  f.author('A1', (f) => [f.join('fP', 'Q:end')]);
  f.author('A2', (f) => [f.split('Q', 'S', null)], ['A1'], 2n);
  rejected(f, f.envelope('A2'), ['A1']);
  const g = fixture([{ id: 'P0', text: 'x' }]);
  g.author('A1', (f) => [f.transfer(['P0'], 'Q:end', 'rT')]);
  g.author('A2', (f) => [f.split('P', 'S', null, 'left', 'root', 'P:birth', [])], ['A1'], 2n);
  const malformed = g.envelope('A2');
  (effect(malformed).cut as { run: ReturnType<typeof effect>['cut']['run'] }).run = g.id(
    'rT',
    'run',
  );
  rejected(g, malformed, ['A1']);
});
it.each(['bare', 'one-bracket'] as const)('rejects %s edge typing before readiness', (variant) => {
  const f = fixture();
  f.author('A1', (f) => {
    const tape = f.id('tP', 'tape');
    if (variant === 'one-bracket')
      f.native([
        { type: 'marker', tape, index: 1, marker: f.allocate('one', 'marker'), affinity: 'left' },
      ]);
    f.native([{ type: 'text', tape, index: variant === 'bare' ? 1 : 2, text: '😀' }]);
    return [];
  });
  rejected(f, f.envelope('A1'));
});
it('rejects one newly allocated bracket even when the final edge cells are text-free', () => {
  const f = fixture([{ id: 'P0', text: 'x' }]);
  f.author('A1', (f) => {
    // Existing P0 end is the left edge of the trailing reserved cell. Only one
    // new bracket would make final edges text-free but violates authoring.
    const tape = f.id('tP', 'tape');
    const end = f.peers.get('A')!.marker(f.id('P:end', 'marker')).index;
    f.native([
      { type: 'text', tape, index: end, text: '😀' },
      {
        type: 'marker',
        tape,
        index: end + 2,
        marker: f.allocate('one', 'marker'),
        affinity: 'right',
      },
    ]);
    return [];
  });
  rejected(f, f.envelope('A1'));
});
it.each(['overlap', 'wrong-occurrence', 'wrong-skeleton', 'sentinel-transfer'] as const)(
  'quarantines malformed structural ownership facts: %s',
  (variant) => {
    const f = fixture([
      { id: 'P0', text: 'x' },
      { id: 'P1', text: 'y' },
    ]);
    f.author('A1', (f) => [
      variant === 'sentinel-transfer'
        ? f.transferRanges([f.homes[0].cell], f.slots.get('Q:end')!, 'rT')
        : f.split('P', 'S', 'P0'),
    ]);
    const action = f.envelope('A1');
    if (variant === 'wrong-occurrence')
      (effect(action).basis as { ranges: ReturnType<typeof effect>['basis']['ranges'] }).ranges = [
        { ...effect(action).basis.ranges[0], occurrence: f.id('Q:birth', 'occurrence') },
      ];
    else if (variant !== 'sentinel-transfer') {
      (action as { allocations: ActionEnvelope['allocations'] }).allocations =
        action.allocations.map((entry) =>
          entry.type === 'run'
            ? {
                ...entry,
                skeleton:
                  variant === 'overlap'
                    ? [entry.skeleton[0], ...entry.skeleton]
                    : entry.skeleton.slice(1),
              }
            : entry,
        );
    }
    rejected(f, action);
  },
);

it('certifies only the author closure while independent common-genesis stores merge concurrent source text and empty cuts', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'SA', null)]);
  f.author('A2', (f) => [f.split('SA', 'TA', null, 'right', 'root', 'P:birth')], ['A1'], 2n);
  f.author('B1', (f) => [f.split('P', 'SB', null)]);
  f.author('B2', (f) => [f.split('SB', 'TB', null, 'right', 'root', 'P:birth')], ['B1'], 2n);
  f.author('B3', (f) => f.insert('text', '😀', 'P:home-end'), ['B2'], 3n);
  const a = store(f);
  const b = store(f);
  const c = store(f);
  for (const name of ['A1', 'A2']) a.append(f.envelope(name));
  for (const name of ['B1', 'B2', 'B3']) b.append(f.envelope(name));
  expect(a.snapshot().ready).toHaveLength(2);
  expect(b.snapshot().ready).toHaveLength(3);
  const aBefore = a.encodeUpdate();
  // A→B only: B's concurrent source text must not poison A's empty-basis certification.
  b.applyUpdate(a.encodeUpdate());
  expect(a.encodeUpdate()).toEqual(aBefore);
  expect(b.snapshot().ready).toHaveLength(5);
  expect(a.snapshot().ready).toHaveLength(2);
  c.applyUpdate(b.encodeUpdate());
  a.applyUpdate(b.encodeUpdate());
  const observations = [a, b, c].map((peer) => {
    const snapshot = peer.snapshot();
    expect(snapshot.ready).toHaveLength(5);
    expect(snapshot.actions.every((entry) => entry.readiness.state === 'ready')).toBe(true);
    const native = new NativeTapeCache();
    cleanup.push(() => native.destroy());
    native.apply('G', f.bodies.get('G')!);
    for (const action of snapshot.ready)
      native.apply(`${action.id.actor}/${action.id.sequence}`, action);
    const activity = reduceActivity(snapshot.ready);
    const allocations = [
      ...f.genesis.allocations,
      ...snapshot.ready.flatMap((action) => action.allocations),
    ];
    const snapshots = allocations
      .filter((entry) => entry.type === 'tape')
      .map((entry) => native.snapshot(entry.id));
    const result = reduceOwnership({
      genesis: f.genesis,
      actions: snapshot.ready.map((action) => ({ action, births: births(action) })),
      snapshots,
      isActive: (order) => activity.isActive(order.action.id),
    });
    expect(result.children(f.id('root', 'node')).map((node) => f.alias(node))).toEqual([
      'P',
      'TB',
      'TA',
      'SA',
      'SB',
      'Q',
    ]);
    expect(f.text(result, 'fP')).toBe('😀');
    expect(['fSA', 'fSB', 'fTA', 'fTB'].map((flow) => f.text(result, flow))).toEqual([
      '',
      '',
      '',
      '',
    ]);
    return {
      assignments: result.assignments,
      homes: result.homeBindings,
      buckets: result.buckets,
      raw: result.flowPlacements.map((flow) => result.raw(flow.flow)),
      snapshots,
    };
  });
  expect(observations[1]).toEqual(observations[0]);
  expect(observations[2]).toEqual(observations[0]);
});
it('defers missing semantic dependencies before certifying or exposing their home allocations', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'S', null)]);
  f.author('A2', (f) => [f.split('S', 'T', null)], ['A1'], 2n);
  const peer = store(f);
  peer.append(f.envelope('A2'));
  expect(peer.snapshot().ready).toHaveLength(0);
  expect(peer.snapshot().actions[0].readiness.state).toBe('pending');
  peer.append(f.envelope('A1'));
  expect(peer.snapshot().ready).toHaveLength(2);
  expect(sameId(effect(f.envelope('A2')).cut.run, f.id('rS', 'run'))).toBe(true);
  expect(resourceKey(effect(f.envelope('A2')).cut.run)).not.toBe(resourceKey(f.id('rP', 'run')));
});

function project(f: NativeFixture, peer: ActionStore) {
  const ready = peer.snapshot().ready;
  const native = new NativeTapeCache();
  cleanup.push(() => native.destroy());
  native.apply('G', f.bodies.get('G')!);
  for (const action of ready) native.apply(`${action.id.actor}/${action.id.sequence}`, action);
  const allocations = [...f.genesis.allocations, ...ready.flatMap((action) => action.allocations)];
  const snapshots = allocations
    .filter((entry) => entry.type === 'tape')
    .map((entry) => native.snapshot(entry.id));
  const activity = reduceActivity(ready);
  const result = reduceOwnership({
    genesis: f.genesis,
    actions: ready.map((action) => ({ action, births: births(action) })),
    snapshots,
    isActive: (order) => activity.isActive(order.action.id),
  });
  return { ready, native, snapshots, activity, result };
}
/** These traces have one unambiguous author-causal component per split. Their
 * retained root skeletons are the exact birth coverage; this is not a general
 * MW-06 birth-coverage builder for concurrent, component-restricted splits.
 */
function visibility(f: NativeFixture, projection: ReturnType<typeof project>) {
  const { result, activity, ready } = projection;
  const tokens: TextToken[] = [
    { body: f.bodies.get('G')!, birth: null },
    ...ready.map((action) => ({ body: action, birth: action.id })),
  ].flatMap(({ body, birth }) =>
    body.nativeManifest.flatMap((entry) =>
      entry.type === 'text'
        ? Array.from({ length: entry.native.length }, (_, offset) => ({
            tape: entry.tape,
            native: { client: entry.native.client, clock: entry.native.clock + offset },
            birth,
          }))
        : [],
    ),
  );
  return reduceVisibility(
    activity,
    {
      nodes: result.nodeAllocations,
      parent: (node) => result.blockPlacement(node)?.slot.parent ?? null,
      owner: (token) => {
        const assignment = result.owner(token);
        return result.flowBlock(
          result.runLayouts.find((run) => sameId(run.run, assignment.run))!.flow,
        );
      },
      requirements: (node) =>
        result.destinationRequirements
          .filter((entry) => entry.nodes.some((id) => sameId(id, node)))
          .map((entry) => ({ action: entry.order.action.id, ordinal: entry.order.ordinal })),
      contains: (range, token) => result.contains(range, token),
      containsBirthContent: (node, token) => {
        const allocation = result.nodeAllocations.find((entry) => sameId(entry.id, node))!;
        const home = result.homeBindings.find((binding) =>
          result.runLayouts.some(
            (run) =>
              sameId(run.run, binding.run) &&
              allocation.flow !== null &&
              sameId(run.flow, allocation.flow),
          ),
        );
        return (
          home !== undefined &&
          result.runLayouts
            .find((run) => sameId(run.run, home.run))!
            .skeleton.some((range) => result.contains(range, token))
        );
      },
    },
    tokens,
  );
}
it('replays actual owner group controls without moving peer home text, dropping retained identities, or allocating on redo', () => {
  const f = fixture([
    { id: 'P0', text: 'a' },
    { id: 'P1', text: 'b' },
  ]);
  f.author('A1', (f) => [f.split('P', 'L', 'P0')]);
  f.deliver('A', 'B', ['A1']);
  f.author('B1', (f) => f.insert('captured', 'c', 'L:start'), ['A1'], 2n);
  f.bindInserted('captured', 'B1');
  f.author('B2', (f) => f.insert('home', '😀', 'L:home-end'), ['B1'], 3n);
  f.bindInserted('home', 'B2');
  f.deliver('B', 'A', ['B1', 'B2']);
  const group = f.envelope('A1').groupId;
  f.author(
    'A2',
    () => [
      {
        type: 'SetGroupActive',
        group,
        actions: [f.envelope('A1').id],
        active: false,
        previousControl: null,
      },
    ],
    ['A1', 'B2'],
    4n,
  );
  f.author(
    'A3',
    () => [
      {
        type: 'SetGroupActive',
        group,
        actions: [f.envelope('A1').id],
        active: true,
        previousControl: f.envelope('A2').id,
      },
    ],
    ['A2'],
    5n,
  );
  const a = store(f);
  const b = store(f);
  for (const name of ['A1', 'B1', 'B2']) a.append(f.envelope(name));
  b.applyUpdate(a.encodeUpdate());
  const before = project(f, b);
  expect(f.text(before.result, 'fP')).toBe('a');
  expect(f.text(before.result, 'fL')).toBe('cb😀');
  a.append(f.envelope('A2'));
  b.applyUpdate(a.encodeUpdate(b.encodeStateVector()));
  const undone = project(f, b);
  expect(undone.activity.isActive(f.envelope('A1').id)).toBe(false);
  expect(f.text(undone.result, 'fP')).toBe('acb');
  expect(f.text(undone.result, 'fL')).toBe('😀');
  expect(undone.result.inlineOwner(f.aliases.get('home')!)).toEqual([f.id('L', 'node')]);
  expect(
    visibility(f, undone).nodes.find((node) => sameId(node.node, f.id('L', 'node'))),
  ).toMatchObject({ available: true, scaffold: true, suppressed: false });
  expect(undone.result.inlineOwner(f.aliases.get('captured')!)).toEqual([f.id('P', 'node')]);
  expect(undone.snapshots).toEqual(before.snapshots);
  expect(undone.result.homeBindings).toEqual(before.result.homeBindings);
  expect(undone.result.runLayouts).toEqual(before.result.runLayouts);
  a.append(f.envelope('A3'));
  b.applyUpdate(a.encodeUpdate(b.encodeStateVector()));
  const redone = project(f, b);
  expect(redone.result.assignments).toEqual(before.result.assignments);
  expect(redone.result.flowPlacements).toEqual(before.result.flowPlacements);
  expect(redone.result.runLayouts).toEqual(before.result.runLayouts);
  expect(redone.snapshots).toEqual(before.snapshots);
  const reopened = store(f);
  reopened.applyUpdate(b.encodeUpdate());
  expect(project(f, reopened).result.assignments).toEqual(before.result.assignments);
  expect(reopened.encodeUpdate()).toEqual(b.encodeUpdate());
  expect(f.bodies.get('A2')!.nativeInsertUpdates).toHaveLength(0);
  expect(f.bodies.get('A3')!.nativeInsertUpdates).toHaveLength(0);
});

it('rejects two same-gap split roots sharing one birth occurrence', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'L', null), f.split('P', 'R', null)]);
  const action = f.envelope('A1');
  (action.effects[1] as { occurrence: ReturnType<typeof effect>['occurrence'] }).occurrence =
    effect(action).occurrence;
  rejected(f, action);
});

it('retains 501 text groups, reopens complete native facts, and accepts a writer still at the old home checkpoint', () => {
  const f = fixture();
  const peer = store(f);
  f.author('A1', (f) => f.insert('first', 'x', 'P:home-end'));
  f.bindInserted('first', 'A1');
  f.deliver('A', 'B', ['A1']);
  peer.append(f.envelope('A1'));
  const oldCheckpoint = peer.encodeUpdate();
  const contentEnd = f.bodies
    .get('A1')!
    .allocations.filter((entry) => entry.type === 'marker')[1].id;
  f.slots.set('content:end', {
    run: f.id('rP', 'run'),
    boundary: contentEnd,
    side: 'left',
    predecessor: null,
  });
  for (let i = 2; i <= 501; i++) {
    const previous = `A${i - 1}`;
    f.author(`A${i}`, (f) => f.insert(`text-${i}`, 'x', 'content:end'), [previous], BigInt(i));
    peer.append(f.envelope(`A${i}`));
  }
  expect(peer.snapshot().ready).toHaveLength(501);
  const full = project(f, peer);
  expect(f.text(full.result, 'fP')).toBe('x'.repeat(501));
  const checkpoint = peer.encodeUpdate();
  const reopened = store(f);
  reopened.applyUpdate(checkpoint);
  const restored = project(f, reopened);
  expect(restored.snapshots).toEqual(full.snapshots);
  expect(restored.result.assignments).toEqual(full.result.assignments);
  expect(restored.result.homeBindings).toEqual(full.result.homeBindings);
  // This writer never received groups 2..501 and uses the retained old sentinel.
  f.author('B1', (f) => f.insert('offline', '😀', 'P:home-end'), ['A1'], 2n);
  f.bindInserted('offline', 'B1');
  const old = store(f);
  old.applyUpdate(oldCheckpoint);
  old.append(f.envelope('B1'));
  expect(old.snapshot().ready).toHaveLength(2);
  reopened.applyUpdate(old.encodeUpdate());
  old.applyUpdate(reopened.encodeUpdate());
  expect(reopened.snapshot().ready).toHaveLength(502);
  const merged = project(f, reopened);
  const other = project(f, old);
  expect(merged.result.assignments).toEqual(other.result.assignments);
  expect(merged.snapshots).toEqual(other.snapshots);
  expect(merged.result.homeBindings).toEqual(full.result.homeBindings);
  expect(merged.result.inlineOwner(f.aliases.get('offline')!)).toEqual([f.id('P', 'node')]);
  expect(merged.result.inlineOwner(f.aliases.get('first')!)).toEqual([f.id('P', 'node')]);
  expect(f.text(merged.result, 'fP').replace('😀', '')).toBe('x'.repeat(501));
  expect(reopened.encodeUpdate()).toEqual(old.encodeUpdate());
}, 180_000);

it('keeps deletion-wins over typed home content transferred out of a concurrently deleted split destination', () => {
  const f = fixture([
    { id: 'P0', text: 'a' },
    { id: 'P1', text: 'b' },
  ]);
  f.author('A1', (f) => [f.split('P', 'L', 'P0')]);
  f.deliver('A', 'B', ['A1']);
  const splitRun = f.reduce('A').runLayouts.find((run) => sameId(run.run, f.id('rL', 'run')))!;
  f.author('A2', (f) => [f.deleteSubtree('L', splitRun.skeleton, ['A1'])], ['A1'], 2n);
  f.author('B1', (f) => f.insert('home', '😀', 'L:home-end'), ['A1'], 2n);
  f.bindInserted('home', 'B1');
  const brackets = f.bodies.get('B1')!.allocations.filter((entry) => entry.type === 'marker');
  const range = { tape: f.id('tL', 'tape'), start: brackets[0].id, end: brackets[1].id };
  f.author('B2', (f) => [f.transferRanges([range], f.slots.get('Q:end')!, 'rT')], ['B1'], 3n);
  const a = store(f);
  const b = store(f);
  for (const name of ['A1', 'A2']) a.append(f.envelope(name));
  for (const name of ['A1', 'B1', 'B2']) b.append(f.envelope(name));
  a.applyUpdate(b.encodeUpdate());
  b.applyUpdate(a.encodeUpdate());
  const merged = project(f, a);
  const state = visibility(f, merged);
  expect(merged.result.inlineOwner(f.aliases.get('home')!)).toEqual([f.id('Q', 'node')]);
  expect(f.text(merged.result, 'fQ')).toBe('😀');
  expect(state.nodes.find((node) => sameId(node.node, f.id('L', 'node')))).toMatchObject({
    deleted: true,
    available: false,
  });
  const homeToken = f.aliases.get('home')!;
  const homeVisibility = state.text.filter(
    (entry) =>
      entry.token.native.client === homeToken.client &&
      entry.token.native.clock >= homeToken.clock &&
      entry.token.native.clock < homeToken.clock + homeToken.length,
  );
  expect(homeVisibility).toHaveLength(2);
  for (const entry of homeVisibility)
    expect(entry).toMatchObject({
      visible: false,
      deletedDestination: false,
      tags: [f.id('delete:A2:L', 'deletion')],
    });
  expect(visibility(f, project(f, b))).toEqual(state);
  f.deliver('B', 'A', ['B1', 'B2']);
  f.author(
    'A3',
    () => [
      {
        type: 'SetGroupActive',
        group: f.envelope('A2').groupId,
        actions: [f.envelope('A2').id],
        active: false,
        previousControl: null,
      },
    ],
    ['A2', 'B2'],
    4n,
  );
  a.append(f.envelope('A3'));
  b.applyUpdate(a.encodeUpdate());
  const restored = project(f, b);
  expect(restored.snapshots).toEqual(merged.snapshots);
  expect(restored.result.assignments).toEqual(merged.result.assignments);
  expect(visibility(f, restored).text.every((entry) => entry.visible)).toBe(true);
});

it('certifies a dependent split of content on an earlier split home in the same atomic action', () => {
  const f = fixture();
  const action = f.author('A1', (f) => {
    const first = f.split('P', 'S', null);
    const tape = f.id('tS', 'tape');
    const start = f.allocate('S:content-start', 'marker');
    const end = f.allocate('S:content-end', 'marker');
    const cut = f.allocate('cut:T', 'marker');
    f.native([
      { type: 'marker', tape, index: 1, marker: start, affinity: 'left' },
      { type: 'text', tape, index: 2, text: 'xy' },
      { type: 'marker', tape, index: 4, marker: end, affinity: 'right' },
      { type: 'marker', tape, index: 3, marker: cut, affinity: 'right' },
    ]);
    f.createBlock(
      { id: 'T', parent: 'root', role: 'inline', flow: 'fT', run: 'rT', tape: 'tT', cells: [] },
      'S:birth',
    );
    return [
      first,
      {
        type: 'SplitFlow',
        basis: {
          ranges: [{ range: { tape, start, end }, occurrence: f.id('S:birth', 'occurrence') }],
        },
        cut: { run: f.id('rS', 'run'), boundary: cut, side: 'right', predecessor: null },
        retainedSide: 'left',
        newNode: f.id('T', 'node'),
        newFlow: f.id('fT', 'flow'),
        newRun: f.id('rT', 'run'),
        occurrence: f.id('T:birth', 'occurrence'),
        outerSlot: { parent: f.id('root', 'node'), predecessor: f.id('S:birth', 'occurrence') },
      },
    ];
  });
  // Complete the immutable semantic draft before encoding/publication. Native
  // identities came from one real prepare(), including both home allocations.
  (action.action as { allocations: ActionEnvelope['allocations'] }).allocations =
    action.action.allocations.map((entry) =>
      entry.type === 'run' && sameId(entry.id, f.id('rT', 'run'))
        ? {
            ...entry,
            skeleton: [
              {
                tape: f.id('tS', 'tape'),
                start: f.id('cut:T', 'marker'),
                end: f.id('S:content-end', 'marker'),
              },
              ...entry.skeleton,
            ],
          }
        : entry,
    );
  const peer = store(f);
  peer.append(f.envelope('A1'));
  expect(peer.snapshot().ready).toHaveLength(1);
  const actual = project(f, peer);
  expect(f.text(actual.result, 'fS')).toBe('x');
  expect(f.text(actual.result, 'fT')).toBe('y');
  expect(actual.result.homeBindings).toHaveLength(4);
  expect(
    actual.result.runLayouts.find((run) => sameId(run.run, f.id('rT', 'run')))!.skeleton,
  ).toHaveLength(2);
});
