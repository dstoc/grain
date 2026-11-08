import { expect, test } from 'vitest';
import type { OccurrenceId } from '../contracts.js';
import { slotSequence } from '../layout/occurrences.js';
import type { OrderedOccurrence } from '../layout/occurrences.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { reduceActivity } from '../visibility/activity.js';
import { MaterializedCells } from './cells.js';
import { MaterializedLayout } from './layout.js';
import { OwnershipResources } from './resources.js';
import { replayOwnershipSuffix } from './ownership.js';

type CachedLayoutState = {
  readonly sequences: { get(sequence: string): { readonly previous?: object } | undefined };
  readonly occurrenceOrders: WeakMap<object, readonly OrderedOccurrence[]>;
};

function cachedOrderLengths(layout: MaterializedLayout, slot: Parameters<typeof slotSequence>[0]) {
  const state = layout as unknown as CachedLayoutState;
  const lengths: number[] = [];
  for (
    let head = state.sequences.get(slotSequence(slot));
    head;
    head = head.previous as typeof head
  ) {
    const cached = state.occurrenceOrders.get(head);
    if (cached) lengths.push(cached.length);
  }
  return lengths;
}

function appendJoin(layout: MaterializedLayout, fixture: NativeFixture, sequence: number) {
  const name = `A${sequence}`;
  const input = fixture.author(
    name,
    (fixture) => [fixture.join(`f${sequence}`, 'P0:end')],
    [`A${sequence - 1}`],
    BigInt(sequence),
  );
  layout.beginAction(input, () => true);
  layout.step(0, true);
}

test('cold replay evicts superseded sibling orders while held readers and forks stay isolated', () => {
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

    const layout = (result.value as unknown as { layout: MaterializedLayout }).layout;
    const slot = fixture.slots.get('P0:end')!;
    const heldOrder = layout.occurrenceOrder(slot);
    const heldIds = heldOrder.map(({ id }) => id);
    expect(heldOrder).toHaveLength(depth);
    expect(cachedOrderLengths(layout, slot)).toEqual([depth]);

    appendJoin(layout, fixture, depth + 1);
    const appendedOrder = layout.occurrenceOrder(slot);
    expect(appendedOrder).toHaveLength(depth + 1);
    expect(cachedOrderLengths(layout, slot)).toEqual([depth + 1]);
    expect(heldOrder.map(({ id }) => id)).toEqual(heldIds);

    const fork = layout.fork();
    expect(cachedOrderLengths(fork, slot)).toEqual([]);
    const forkHeldOrder = fork.occurrenceOrder(slot);
    expect(forkHeldOrder).toEqual(appendedOrder);
    appendJoin(fork, fixture, depth + 2);
    expect(fork.occurrenceOrder(slot)).toHaveLength(depth + 2);
    expect(cachedOrderLengths(fork, slot)).toEqual([depth + 2]);
    expect(layout.occurrenceOrder(slot)).toBe(appendedOrder);
    expect(forkHeldOrder).toEqual(appendedOrder);

    const cohortRoots: OccurrenceId[] = [appendedOrder.at(-1)!.id, appendedOrder.at(-2)!.id];
    const cohortOrder = layout.occurrenceOrder(slot, [{ roots: cohortRoots }]);
    expect(cohortOrder).not.toBe(appendedOrder);
    expect(cohortOrder.findIndex(({ id }) => id === cohortRoots[0])).toBeLessThan(
      cohortOrder.findIndex(({ id }) => id === cohortRoots[1]),
    );
    expect(layout.occurrenceOrder(slot)).toBe(appendedOrder);
  } finally {
    fixture.destroy();
  }
});
