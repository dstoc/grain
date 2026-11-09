import { expect, test } from 'vitest';
import type { OccurrenceId } from '../contracts.js';
import { slotSequence } from '../layout/occurrences.js';
import { orderOccurrences, resourceKey } from '../layout/occurrences.js';
import type { OrderedOccurrence } from '../layout/occurrences.js';
import { resource } from '../actions/test-fixtures.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { captureDiagnostics } from '../diagnostics.js';
import { reduceActivity } from '../visibility/activity.js';
import { MaterializedCells } from './cells.js';
import { MaterializedLayout } from './layout.js';
import { OwnershipResources } from './resources.js';
import { replayOwnershipSuffix } from './ownership.js';

type CachedLayoutState = {
  readonly sequences: { get(sequence: string): object | undefined };
  readonly occurrenceOrders: {
    get(sequence: string):
      | {
          readonly head?: object;
          readonly ordered: readonly OrderedOccurrence[];
        }
      | undefined;
    readonly size: number;
  };
};

function cachedOrder(layout: MaterializedLayout, slot: Parameters<typeof slotSequence>[0]) {
  const state = layout as unknown as CachedLayoutState;
  return state.occurrenceOrders.get(slotSequence(slot));
}

function cachedOrderLengths(layout: MaterializedLayout, slot: Parameters<typeof slotSequence>[0]) {
  const state = layout as unknown as CachedLayoutState;
  const entry = state.occurrenceOrders.get(slotSequence(slot));
  return entry && entry.head === state.sequences.get(slotSequence(slot))
    ? [entry.ordered.length]
    : [];
}

function sequenceEntries(layout: MaterializedLayout, slot: Parameters<typeof slotSequence>[0]) {
  const state = layout as unknown as CachedLayoutState;
  const entries: OrderedOccurrence[] = [];
  for (
    let link = state.sequences.get(slotSequence(slot)) as
      | { readonly occurrence: OrderedOccurrence; readonly previous?: object }
      | undefined;
    link;
    link = link.previous as typeof link
  )
    entries.push(link.occurrence);
  return entries.reverse();
}

function expectMatchesFullOrder(
  layout: MaterializedLayout,
  slot: Parameters<typeof slotSequence>[0],
  actual: readonly OrderedOccurrence[],
) {
  const expected = orderOccurrences(sequenceEntries(layout, slot));
  expect(actual).not.toBe(expected);
  expect(actual.map(({ id }) => resourceKey(id))).toEqual(
    expected.map(({ id }) => resourceKey(id)),
  );
  expect(new Set(actual.map(({ id }) => resourceKey(id))).size).toBe(actual.length);
  expect(actual).toEqual(expected);
}

function withOccurrencePredecessor(
  input: ReturnType<NativeFixture['author']>,
  occurrence: OccurrenceId,
  predecessor: OccurrenceId | null,
) {
  const allocation = input.action.allocations.find(
    (entry) => entry.type === 'occurrence' && resourceKey(entry.id) === resourceKey(occurrence),
  );
  if (!allocation || allocation.type !== 'occurrence') throw new Error('Missing occurrence');
  if (!('run' in allocation.slot)) throw new Error('Expected an inline occurrence slot');
  const slot = { ...allocation.slot, predecessor };
  return {
    action: {
      ...input.action,
      allocations: input.action.allocations.map((entry) =>
        entry.type === 'occurrence' && resourceKey(entry.id) === resourceKey(occurrence)
          ? { ...entry, slot }
          : entry,
      ),
      effects: input.action.effects.map((effect) =>
        effect.type === 'JoinFlow' && resourceKey(effect.occurrence) === resourceKey(occurrence)
          ? { ...effect, destination: slot }
          : effect,
      ),
    },
    births: input.births,
  };
}

function withPredecessor(
  input: ReturnType<NativeFixture['author']>,
  predecessor: OccurrenceId | null,
) {
  const allocation = input.action.allocations.find((entry) => entry.type === 'occurrence');
  if (!allocation || allocation.type !== 'occurrence') throw new Error('Missing occurrence');
  return withOccurrencePredecessor(input, allocation.id, predecessor);
}

function appendJoin(
  layout: MaterializedLayout,
  fixture: NativeFixture,
  sequence: number,
  predecessor: OccurrenceId | null,
) {
  const name = `A${sequence}`;
  const input = withPredecessor(
    fixture.author(
      name,
      (fixture) => [fixture.join('f1', 'P0:end')],
      sequence > 1 ? [`A${sequence - 1}`] : [],
      BigInt(sequence),
    ),
    predecessor,
  );
  const allocation = input.action.allocations.find((entry) => entry.type === 'occurrence');
  if (!allocation || allocation.type !== 'occurrence') throw new Error('Missing occurrence');
  layout.beginAction(input, () => true);
  layout.step(0, false);
  return allocation.id;
}

test('cold replay retains only the current order while held readers and checkpoint forks stay isolated', () => {
  const depth = 32;
  const fixture = new NativeFixture([
    { id: 'root', role: 'root', parent: null },
    ...Array.from({ length: depth + 3 }, (_, i) => ({
      id: `P${i}`,
      role: 'inline' as const,
      parent: 'root',
      flow: `f${i}`,
      run: `r${i}`,
      tape: `t${i}`,
      cells: [{ id: `c${i}`, text: 'x' }],
    })),
  ]);
  try {
    const actions = Array.from({ length: depth }, (_, i) =>
      fixture.author(
        `A${i + 1}`,
        (fixture) => [fixture.join(`f${i + 1}`, 'P0:end')],
        i ? [`A${i}`] : [],
        BigInt(i + 1),
      ),
    );
    const envelopes = Array.from({ length: depth }, (_, i) => fixture.envelope(`A${i + 1}`));
    const snapshots = fixture.genesis.allocations.flatMap((allocation) =>
      allocation.type === 'tape' ? [fixture.peers.get('A')!.snapshot(allocation.id)] : [],
    );
    const index = new MaterializedCells(snapshots);
    const work = {
      allocationsIndexed: 0,
      homesDerived: 0,
      snapshotMarkersValidated: 0,
      skeletonCellsValidated: 0,
      resourceRebuilds: 0,
      homeTapesValidated: 0,
      coverageFlowsTraversed: 0,
      coverageCellsVisited: 0,
    };
    const resources = OwnershipResources.create(fixture.genesis, actions, snapshots, index, work);
    const activity = reduceActivity(envelopes);
    const result = replayOwnershipSuffix(
      { genesis: fixture.genesis, actions, snapshots, isActive: () => true },
      activity,
      undefined,
      () => {},
      index,
      resources,
      work,
    );
    const reference = fixture.reduce('A');
    expect(fixture.text(result.value, 'f0')).toBe(fixture.text(reference, 'f0'));

    // The completed reader and accepted checkpoint share the same final layout.
    const layout = (result.value as unknown as { layout: MaterializedLayout }).layout;
    expect(layout).toBe(result.state.layout);
    const slot = fixture.slots.get('P0:end')!;
    const heldOrder = layout.occurrenceOrder(slot);
    const heldIds = heldOrder.map(({ id }) => resourceKey(id));
    expect(heldOrder).toHaveLength(depth);
    expect(cachedOrderLengths(layout, slot)).toEqual([depth]);

    const candidate = layout.fork();
    const { value: nextId, report } = captureDiagnostics(() =>
      appendJoin(candidate, fixture, depth + 1, null),
    );
    const appendedOrder = candidate.occurrenceOrder(slot);
    expect(appendedOrder).toHaveLength(depth + 1);
    expect(appendedOrder[0].id).toEqual(nextId);
    expect(cachedOrderLengths(candidate, slot)).toEqual([depth + 1]);
    expect(Object.keys(cachedOrder(candidate, slot)!).sort()).toEqual([
      'head',
      'latestOrder',
      'ordered',
    ]);
    expect(report.work['driver/layout.sequenceOrderCacheFastPathHits']).toBe(1);
    expect(report.work['driver/layout.sequenceOrderCacheArrayEntriesCopied']).toBe(depth);
    expect(report.work['driver/layout.sequenceOrderCacheArrayEntriesAllocated']).toBe(depth + 1);
    expectMatchesFullOrder(candidate, slot, appendedOrder);
    expect(layout.occurrenceOrder(slot)).toBe(heldOrder);
    expect(heldOrder.map(({ id }) => resourceKey(id))).toEqual(heldIds);

    // Repeated accepted appends replace the branch's current cache root while
    // held readers and superseded arrays remain unchanged.
    const { value: repeatedId, report: repeatedReport } = captureDiagnostics(() =>
      appendJoin(candidate, fixture, depth + 2, null),
    );
    const repeatedOrder = candidate.occurrenceOrder(slot);
    expect(repeatedOrder).toHaveLength(depth + 2);
    expect(repeatedOrder[0].id).toEqual(repeatedId);
    expect(cachedOrderLengths(candidate, slot)).toEqual([depth + 2]);
    expect(repeatedReport.work['driver/layout.sequenceOrderCacheFastPathHits']).toBe(1);
    expect(repeatedReport.work['driver/layout.sequenceOrderCacheArrayEntriesCopied']).toBe(
      depth + 1,
    );
    expect(repeatedReport.work['driver/layout.sequenceOrderCacheArrayEntriesAllocated']).toBe(
      depth + 2,
    );
    expect(candidate.occurrenceOrder(slot)).toBe(repeatedOrder);
    expect(appendedOrder).toHaveLength(depth + 1);
    expect(appendedOrder[0].id).toEqual(nextId);
    expectMatchesFullOrder(candidate, slot, repeatedOrder);

    // A checkpoint branch inherits immutable cache values but updates only its own root.
    const checkpoint = candidate.fork();
    expect(cachedOrderLengths(checkpoint, slot)).toEqual([depth + 2]);
    const checkpointOrder = checkpoint.occurrenceOrder(slot);
    expect(checkpointOrder).toBe(repeatedOrder);
    const { value: checkpointId } = captureDiagnostics(() =>
      appendJoin(checkpoint, fixture, depth + 3, null),
    );
    const branchOrder = checkpoint.occurrenceOrder(slot);
    expect(branchOrder[0].id).toEqual(checkpointId);
    expect(branchOrder).not.toBe(repeatedOrder);
    expect(cachedOrderLengths(checkpoint, slot)).toEqual([depth + 3]);
    expect(candidate.occurrenceOrder(slot)).toBe(repeatedOrder);
    expect(checkpointOrder.map(({ id }) => resourceKey(id))).toEqual(
      repeatedOrder.map(({ id }) => resourceKey(id)),
    );

    const cohortRoots: OccurrenceId[] = [repeatedOrder.at(-1)!.id, repeatedOrder.at(-2)!.id];
    const cohortOrder = candidate.occurrenceOrder(slot, [{ roots: cohortRoots }]);
    expect(cohortOrder).not.toBe(repeatedOrder);
    expect(
      cohortOrder.findIndex(({ id }) => resourceKey(id) === resourceKey(cohortRoots[0])),
    ).toBeLessThan(
      cohortOrder.findIndex(({ id }) => resourceKey(id) === resourceKey(cohortRoots[1])),
    );
    expect(candidate.occurrenceOrder(slot)).toBe(repeatedOrder);
    expect(candidate.occurrenceOrder(slot, [{ roots: cohortRoots }])).toEqual(cohortOrder);
    expect(candidate.occurrenceOrder(slot)).toBe(repeatedOrder);
    expectMatchesFullOrder(candidate, slot, repeatedOrder);
  } finally {
    fixture.destroy();
  }
});

test('incremental ordering handles roots and leaf/non-leaf predecessors in semantic priority order', () => {
  const fixture = new NativeFixture([
    { id: 'root', role: 'root', parent: null },
    {
      id: 'P0',
      role: 'inline',
      parent: 'root',
      flow: 'f0',
      run: 'r0',
      tape: 't0',
      cells: [{ id: 'c0', text: 'x' }],
    },
    {
      id: 'P1',
      role: 'inline',
      parent: 'root',
      flow: 'f1',
      run: 'r1',
      tape: 't1',
      cells: [{ id: 'c1', text: 'x' }],
    },
  ]);
  try {
    const layout = new MaterializedLayout(fixture.genesis);
    const slot = fixture.slots.get('P0:end')!;
    layout.occurrenceOrder(slot); // Cache the empty sequence on this branch.
    const { value: observed, report } = captureDiagnostics(() => {
      const first = appendJoin(layout, fixture, 1, null);
      const leaf = appendJoin(layout, fixture, 2, first);
      expect(layout.occurrenceOrder(slot).map(({ id }) => resourceKey(id))).toEqual([
        resourceKey(first),
        resourceKey(leaf),
      ]);
      const nonLeafFollower = appendJoin(layout, fixture, 3, first);
      const afterNonLeaf = layout.occurrenceOrder(slot);
      expect(afterNonLeaf.map(({ id }) => resourceKey(id))).toEqual([
        resourceKey(first),
        resourceKey(nonLeafFollower),
        resourceKey(leaf),
      ]);
      const newRoot = appendJoin(layout, fixture, 4, null);
      const afterRoot = layout.occurrenceOrder(slot);
      expect(afterRoot.map(({ id }) => resourceKey(id))).toEqual([
        resourceKey(newRoot),
        resourceKey(first),
        resourceKey(nonLeafFollower),
        resourceKey(leaf),
      ]);
      expectMatchesFullOrder(layout, slot, afterRoot);
      return { first, leaf, nonLeafFollower, newRoot };
    });
    expect(observed.newRoot).toBeDefined();
    expect(report.work['driver/layout.sequenceOrderCacheFastPathHits']).toBe(4);
    expect(report.work['driver/layout.sequenceOrderCachePredecessorEntries']).toBe(2);
    expect(report.work['driver/layout.sequenceOrderCacheArrayEntriesCopied']).toBe(6);
    expect(report.work['driver/index.nodesAllocated']).toBeGreaterThan(0);
  } finally {
    fixture.destroy();
  }
});

test('multiple fresh followers fall back to full ordering and keep effect order distinct from allocation order', () => {
  const fixture = new NativeFixture([
    { id: 'root', role: 'root', parent: null },
    ...[0, 1].map((i) => ({
      id: `P${i}`,
      role: 'inline' as const,
      parent: 'root',
      flow: `f${i}`,
      run: `r${i}`,
      tape: `t${i}`,
      cells: [{ id: `c${i}`, text: 'x' }],
    })),
  ]);
  try {
    const layout = new MaterializedLayout(fixture.genesis);
    const slot = fixture.slots.get('P0:end')!;
    layout.occurrenceOrder(slot);
    const input = fixture.author(
      'A1',
      (fixture) => [fixture.join('f0', 'P0:end'), fixture.join('f1', 'P0:end')],
      [],
      1n,
    );
    const allocated = input.action.allocations.filter((entry) => entry.type === 'occurrence');
    expect(allocated).toHaveLength(2);
    const { value: ordered, report } = captureDiagnostics(() => {
      layout.beginAction(input, () => true);
      layout.step(0, false);
      layout.step(1, false);
      return layout.occurrenceOrder(slot);
    });
    expect(ordered.map(({ id }) => resourceKey(id))).toEqual([
      resourceKey(allocated[1].id),
      resourceKey(allocated[0].id),
    ]);
    expect(report.work['driver/layout.sequenceOrderCacheFastPathHits'] ?? 0).toBe(0);
    expect(report.work['driver/layout.sequenceAuditEntries']).toBe(2);
    expect(report.work['driver/layout.sequenceOrderCacheEntriesBuilt']).toBe(1);
    expectMatchesFullOrder(layout, slot, ordered);

    const chainedInput = fixture.author(
      'A2',
      (fixture) => [fixture.join('f0', 'P0:end'), fixture.join('f1', 'P0:end')],
      ['A1'],
      2n,
    );
    const chainedOccurrences = chainedInput.action.allocations.filter(
      (entry) => entry.type === 'occurrence',
    );
    expect(chainedOccurrences).toHaveLength(2);
    const chained = withOccurrencePredecessor(
      chainedInput,
      chainedOccurrences[1].id,
      chainedOccurrences[0].id,
    );
    const { value: chainedOrder, report: chainedReport } = captureDiagnostics(() => {
      layout.beginAction(chained, () => true);
      layout.step(0, false);
      layout.step(1, false);
      return layout.occurrenceOrder(slot);
    });
    expect(chainedOrder.map(({ id }) => resourceKey(id))).toEqual([
      resourceKey(chainedOccurrences[0].id),
      resourceKey(chainedOccurrences[1].id),
      resourceKey(allocated[1].id),
      resourceKey(allocated[0].id),
    ]);
    expect(chainedReport.work['driver/layout.sequenceOrderCacheFastPathHits'] ?? 0).toBe(0);
    expect(chainedReport.work['driver/layout.sequenceAuditEntries']).toBe(4);
    expectMatchesFullOrder(layout, slot, chainedOrder);
  } finally {
    fixture.destroy();
  }
});

test('incremental priority compares Lamport, actor, sequence, and effect ordinal semantics', () => {
  const fixture = new NativeFixture([
    { id: 'root', role: 'root', parent: null },
    ...[0, 1].map((i) => ({
      id: `P${i}`,
      role: 'inline' as const,
      parent: 'root',
      flow: `f${i}`,
      run: `r${i}`,
      tape: `t${i}`,
      cells: [{ id: `c${i}`, text: 'x' }],
    })),
  ]);
  try {
    const layout = new MaterializedLayout(fixture.genesis);
    const slot = fixture.slots.get('P0:end')!;
    const sameAction = fixture.author(
      'A1',
      (fixture) => [fixture.join('f0', 'P0:end'), fixture.join('f1', 'P0:end')],
      [],
      1n,
    );
    layout.beginAction(sameAction, () => true);
    layout.step(0, false);
    layout.step(1, false);
    const cached = layout.occurrenceOrder(slot);
    const allocated = sameAction.action.allocations.filter((entry) => entry.type === 'occurrence');
    expect(cached.map(({ id }) => resourceKey(id))).toEqual([
      resourceKey(allocated[1].id),
      resourceKey(allocated[0].id),
    ]);

    const ghostInput = (name: string, sequence: number) => {
      const action = fixture.author(name, () => [], [], 1n);
      const id = resource('occurrence', 50, action.action.id);
      return {
        input: {
          action: {
            ...action.action,
            allocations: [{ type: 'occurrence' as const, id, slot }],
          },
          births: [],
        },
        id,
        sequence,
      };
    };
    const actorLater = ghostInput('B1', 1);
    const sequenceLater = ghostInput('A2', 2);
    const actorBranch = layout.fork();
    const sequenceBranch = layout.fork();
    const { report } = captureDiagnostics(() => {
      actorBranch.beginAction(actorLater.input, () => true);
      const actorOrder = actorBranch.occurrenceOrder(slot);
      expect(actorOrder[0].id).toEqual(actorLater.id);
      expectMatchesFullOrder(actorBranch, slot, actorOrder);
      sequenceBranch.beginAction(sequenceLater.input, () => true);
      const sequenceOrder = sequenceBranch.occurrenceOrder(slot);
      expect(sequenceOrder[0].id).toEqual(sequenceLater.id);
      expectMatchesFullOrder(sequenceBranch, slot, sequenceOrder);
    });
    expect(report.work['driver/layout.sequenceOrderCacheFastPathHits']).toBe(2);
    expect(layout.occurrenceOrder(slot)).toBe(cached);
  } finally {
    fixture.destroy();
  }
});

test('a null predecessor enters before the retained genesis chain in its own checkpoint branch', () => {
  const fixture = new NativeFixture([
    { id: 'root', role: 'root', parent: null },
    ...[0, 1].map((i) => ({
      id: `P${i}`,
      role: 'inline' as const,
      parent: 'root',
      flow: `f${i}`,
      run: `r${i}`,
      tape: `t${i}`,
      cells: [{ id: `c${i}`, text: 'x' }],
    })),
  ]);
  try {
    const layout = new MaterializedLayout(fixture.genesis);
    const seedAction = fixture.author('A1', () => [], [], 1n);
    layout.beginAction(seedAction, () => true);
    const slot = { parent: layout.root, predecessor: null };
    const genesisOrder = layout.occurrenceOrder(slot);
    expect(genesisOrder).toHaveLength(2);
    const candidate = layout.fork();
    const action = fixture.author('B1', () => [], [], 2n);
    const id = resource('occurrence', 50, action.action.id);
    const input = {
      action: {
        ...action.action,
        allocations: [{ type: 'occurrence' as const, id, slot }],
      },
      births: [],
    };
    const { value: ordered, report } = captureDiagnostics(() => {
      candidate.beginAction(input, () => true);
      return candidate.occurrenceOrder(slot);
    });
    expect(ordered.map(({ id: current }) => resourceKey(current))).toEqual([
      resourceKey(id),
      ...genesisOrder.map(({ id: current }) => resourceKey(current)),
    ]);
    expect(report.work['driver/layout.sequenceOrderCacheFastPathHits']).toBe(1);
    expect(report.work['driver/layout.sequenceOrderCacheArrayEntriesCopied']).toBe(2);
    expect(report.work['driver/layout.sequenceAuditEntries'] ?? 0).toBe(0);
    expect(layout.occurrenceOrder(slot)).toBe(genesisOrder);
    expectMatchesFullOrder(candidate, slot, ordered);
  } finally {
    fixture.destroy();
  }
});

test('divergent and discarded candidates share immutable orders without contaminating their checkpoint', () => {
  const fixture = new NativeFixture([
    { id: 'root', role: 'root', parent: null },
    {
      id: 'P0',
      role: 'inline',
      parent: 'root',
      flow: 'f0',
      run: 'r0',
      tape: 't0',
      cells: [{ id: 'c0', text: 'x' }],
    },
    {
      id: 'P1',
      role: 'inline',
      parent: 'root',
      flow: 'f1',
      run: 'r1',
      tape: 't1',
      cells: [{ id: 'c1', text: 'x' }],
    },
  ]);
  try {
    const checkpoint = new MaterializedLayout(fixture.genesis);
    const slot = fixture.slots.get('P0:end')!;
    const heldEmptyOrder = checkpoint.occurrenceOrder(slot);
    const left = checkpoint.fork();
    const right = checkpoint.fork();
    const leftInput = fixture.author('A1', (fixture) => [fixture.join('f1', 'P0:end')]);
    const rightInput = fixture.author('B1', (fixture) => [fixture.join('f1', 'P0:end')]);
    const { value: branchIds, report } = captureDiagnostics(() => {
      left.beginAction(leftInput, () => true);
      left.step(0, false);
      right.beginAction(rightInput, () => true);
      right.step(0, false);
      const leftId = leftInput.action.allocations.find((entry) => entry.type === 'occurrence');
      const rightId = rightInput.action.allocations.find((entry) => entry.type === 'occurrence');
      if (!leftId || leftId.type !== 'occurrence' || !rightId || rightId.type !== 'occurrence')
        throw new Error('Missing branch occurrence');
      return { left: leftId.id, right: rightId.id };
    });
    const leftOrder = left.occurrenceOrder(slot);
    const rightOrder = right.occurrenceOrder(slot);
    expect(leftOrder).not.toBe(rightOrder);
    expect(leftOrder[0].id).toEqual(branchIds.left);
    expect(rightOrder[0].id).toEqual(branchIds.right);
    expect(checkpoint.occurrenceOrder(slot)).toBe(heldEmptyOrder);
    expect(leftOrder).not.toBe(heldEmptyOrder);
    expect(rightOrder).not.toBe(heldEmptyOrder);
    expect(report.work['driver/layout.sequenceOrderCacheFastPathHits']).toBe(2);
    expect(cachedOrderLengths(checkpoint, slot)).toEqual([0]);
    expect(cachedOrderLengths(left, slot)).toEqual([1]);
    expect(cachedOrderLengths(right, slot)).toEqual([1]);
    expect(cachedOrder(left, slot)?.head).toBe(
      (left as unknown as CachedLayoutState).sequences.get(slotSequence(slot)),
    );
    expect(cachedOrder(right, slot)?.head).toBe(
      (right as unknown as CachedLayoutState).sequences.get(slotSequence(slot)),
    );
    expect(cachedOrder(checkpoint, slot)?.head).toBe(
      (checkpoint as unknown as CachedLayoutState).sequences.get(slotSequence(slot)),
    );
    expectMatchesFullOrder(left, slot, leftOrder);
    expectMatchesFullOrder(right, slot, rightOrder);
  } finally {
    fixture.destroy();
  }
});

test('failed predecessor, duplicate-priority, and cycle checks leave the checkpoint cache unchanged', () => {
  const fixture = new NativeFixture([
    { id: 'root', role: 'root', parent: null },
    {
      id: 'P0',
      role: 'inline',
      parent: 'root',
      flow: 'f0',
      run: 'r0',
      tape: 't0',
      cells: [{ id: 'c0', text: 'x' }],
    },
  ]);
  try {
    const checkpoint = new MaterializedLayout(fixture.genesis);
    const slot = fixture.slots.get('P0:end')!;
    const heldOrder = checkpoint.occurrenceOrder(slot);
    const base = fixture.author('A1', () => []);
    const allocation = (id: OccurrenceId, predecessor: OccurrenceId | null) => ({
      type: 'occurrence' as const,
      id,
      slot: { ...slot, predecessor },
    });
    const enter = (allocations: ReturnType<typeof allocation>[]) => {
      const candidate = checkpoint.fork();
      expect(() =>
        candidate.beginAction({ action: { ...base.action, allocations }, births: [] }, () => true),
      ).toThrow();
      expect(checkpoint.occurrenceOrder(slot)).toBe(heldOrder);
    };
    const missing = resource('occurrence', 99, base.action.id);
    const self = resource('occurrence', 1, base.action.id);
    enter([allocation(resource('occurrence', 0, base.action.id), missing)]);
    enter([
      allocation(resource('occurrence', 2, base.action.id), null),
      allocation(resource('occurrence', 3, base.action.id), null),
    ]);
    enter([allocation(self, self)]);
    expect(cachedOrderLengths(checkpoint, slot)).toEqual([0]);
  } finally {
    fixture.destroy();
  }
});
