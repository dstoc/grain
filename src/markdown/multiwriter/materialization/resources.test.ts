import { expect, test } from 'vitest';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { reduceOwnership } from '../ownership/ownership.js';
import { resourceKey } from '../layout/index.js';
import type { LayoutGenesis } from '../layout/index.js';
import type { TapeSnapshot } from '../text/types.js';
import { MaterializedCells } from './cells.js';
import { OwnershipResources } from './resources.js';
import type { ResourceWork } from './resources.js';
import { PersistentMap } from './map.js';

const work = (): ResourceWork => ({
  allocationsIndexed: 0,
  homesDerived: 0,
  snapshotMarkersValidated: 0,
  skeletonCellsValidated: 0,
  resourceRebuilds: 0,
  homeTapesValidated: 0,
});
function snapshots(f: NativeFixture, peer = 'A') {
  return f.genesis.allocations.flatMap((a) =>
    a.type === 'tape' ? [f.peers.get(peer)!.snapshot(a.id)] : [],
  );
}
function create(f: NativeFixture, counts = work()) {
  const input = snapshots(f),
    index = new MaterializedCells(input);
  return {
    value: OwnershipResources.create(f.genesis, [], input, index, counts),
    index,
    input,
    counts,
  };
}

test('resource roots reuse retained validation through native refinement and unchanged controls', () => {
  const f = new NativeFixture();
  try {
    const before = create(f),
      saved = structuredClone(before.value.homes);
    const action = f.author('A1', (f) => f.insert('edge', '😀', 'P:end'));
    const updated = snapshots(f),
      index = before.index.refine(updated);
    const counts = work();
    const after = before.value.append([action], updated, index, counts);
    expect(after.homes).toBe(before.value.homes);
    expect(after.homes).toEqual(saved);
    expect(counts).toMatchObject({
      allocationsIndexed: 2,
      homesDerived: 0,
      skeletonCellsValidated: 0,
      resourceRebuilds: 0,
      homeTapesValidated: 1,
    });
    const reference = reduceOwnership({
      genesis: f.genesis,
      actions: [action],
      snapshots: updated,
      isActive: () => true,
    });
    expect(after.homes).toEqual(reference.homeBindings);
    const domain = after.homeDomain.home(f.id('rP', 'run'));
    const unchanged = after.append([], [], index, counts);
    expect(unchanged.homeDomain.home(f.id('rP', 'run'))).toEqual(domain);
    expect(before.value.homeDomain.home(f.id('rP', 'run'))).toEqual(saved[0]);
    expect(counts.snapshotMarkersValidated).toBe(
      updated[0].parts.filter((p) => p.type === 'marker').length,
    );
  } finally {
    f.destroy();
  }
});

for (const malformed of [
  'endpoint',
  'marker-native',
  'missing-marker',
  'missing-tape',
  'duplicate-tape',
  'overlap',
] as const)
  test(`cold resource validation and full replay both reject ${malformed}`, () => {
    const f = new NativeFixture();
    try {
      const input = snapshots(f),
        genesis = structuredClone(f.genesis);
      const bad = structuredClone(input);
      if (malformed === 'missing-tape') bad.length = 0;
      else if (malformed === 'duplicate-tape') bad.push(bad[0]);
      else if (malformed === 'missing-marker') {
        (bad[0].parts as unknown[]).splice(1, 1);
      } else if (malformed === 'overlap') {
        const run = genesis.allocations.find((a) => a.type === 'run')!;
        if (run.type !== 'run') throw new Error();
        (run.skeleton as unknown[]).unshift(run.skeleton[0]);
      } else {
        const marker = bad[0].parts[0];
        if (marker.type !== 'marker') throw new Error();
        if (malformed === 'endpoint')
          (marker as { marker: typeof marker.marker }).marker = f.id('P:end', 'marker');
        else (marker.native as { clock: number }).clock += 10000;
      }
      // The index is built independently from the valid native state. Resource
      // validation must reject inconsistent supplied descriptors on its own.
      expect(() =>
        OwnershipResources.create(genesis, [], bad, new MaterializedCells(input), work()),
      ).toThrow();
      expect(() =>
        reduceOwnership({ genesis, actions: [], snapshots: bad, isActive: () => true }),
      ).toThrow();
    } finally {
      f.destroy();
    }
  });

test('failed resource extension leaves the retained root available for a correct retry', () => {
  const f = new NativeFixture();
  try {
    const before = create(f),
      homes = before.value.homes;
    const action = f.author('A1', (f) => f.insert('edge', 'z', 'P:end'));
    const updated = snapshots(f),
      index = before.index.refine(updated);
    expect(() => before.value.append([action], [], index, work())).toThrow(/ready markers/);
    const bad = structuredClone(updated),
      marker = bad[0].parts.find((p) => p.type === 'marker')!;
    if (marker.type !== 'marker') throw new Error();
    (marker.native as { clock: number }).clock += 1000;
    expect(() => before.value.append([action], bad, index, work())).toThrow(/retained allocation/);
    const after = before.value.append([action], updated, index, work());
    expect(before.value.homes).toBe(homes);
    expect(after.homes).toEqual(homes);
    expect(before.value.homeDomain.home(f.id('rP', 'run'))).toEqual(homes[0]);
  } finally {
    f.destroy();
  }
});

test('resource snapshot exports follow retained tape births, independent of cache insertion order', () => {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    ...['P', 'Q'].map((id) => ({
      id,
      parent: 'root',
      role: 'inline' as const,
      flow: `f${id}`,
      run: `r${id}`,
      tape: `t${id}`,
      cells: [{ id: `${id}:text`, text: id }],
    })),
  ]);
  try {
    const { value, input } = create(f),
      cache = new PersistentMap<TapeSnapshot>();
    for (const snapshot of [...input].reverse()) cache.set(resourceKey(snapshot.tape), snapshot);
    expect(value.snapshots(cache)).toEqual(input);
    expect(() => value.snapshots(new PersistentMap())).toThrow(/Missing/);
  } finally {
    f.destroy();
  }
});

test('cached retained run checks survive new subdivisions without revalidating old skeletons', () => {
  const f = new NativeFixture();
  try {
    const before = create(f);
    const split = f.author('A1', (f) => [f.split('P', 'Q', 'P2')]);
    const cache = f.peers.get('A')!;
    const updated = [...f.genesis.allocations, ...split.action.allocations].flatMap((a) =>
      a.type === 'tape' ? [cache.snapshot(a.id)] : [],
    );
    const counts = work(),
      index = before.index.refine(updated);
    const after = before.value.append([split], updated, index, counts);
    const coldCounts = work();
    const cold = OwnershipResources.create(f.genesis, [split], updated, index, coldCounts);
    expect(after.homes).toEqual(cold.homes);
    expect(counts.skeletonCellsValidated).toBeLessThan(coldCounts.skeletonCellsValidated);
    expect(counts.homesDerived).toBe(1);
    // A changed retained descriptor must take cold validation; it cannot reuse
    // the original allocation certificate merely because its resource ID agrees.
    const changed: LayoutGenesis = structuredClone(f.genesis);
    const run = changed.allocations.find((a) => a.type === 'run')!;
    if (run.type !== 'run') throw new Error();
    (run.skeleton as unknown[]).unshift(run.skeleton[0]);
    expect(() => OwnershipResources.create(changed, [split], updated, index, work())).toThrow(
      /Overlapping/,
    );
  } finally {
    f.destroy();
  }
});

test('interior text reuses marker certificates and validates only the touched home edges', () => {
  const f = new NativeFixture();
  try {
    const before = create(f);
    const action = f.author('A1', (f) => f.insert('interior', 'x', 'P:after-a'));
    const updated = snapshots(f),
      counts = work(),
      index = before.index.refine(updated);
    const after = before.value.append([action], updated, index, counts);
    expect(counts).toEqual({
      allocationsIndexed: 0,
      homesDerived: 0,
      snapshotMarkersValidated: 0,
      skeletonCellsValidated: 0,
      resourceRebuilds: 0,
      homeTapesValidated: 1,
    });
    for (const cell of index.tape(updated[0].tape))
      expect(after.homeDomain.isReserved(cell.range)).toBe(
        before.value.homeDomain.isReserved(cell.range),
      );
    expect(after.homes).toBe(before.value.homes);
  } finally {
    f.destroy();
  }
});
