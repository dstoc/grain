import { OwnershipValidationError } from '../ownership/errors.js';
import { countWork } from '../diagnostics.js';
import type { Allocation, FlowId, RunId, SemanticEffect } from '../contracts.js';
import type { LayoutActionInput, LayoutGenesis } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { assignmentKey, cellKey, sameId } from '../ownership/cells.js';
import { deriveHomes } from '../ownership/homes.js';
import type { HomeBinding } from '../ownership/homes.js';
import type { TapeSnapshot } from '../text/types.js';
import { MaterializedCells } from './cells.js';
import { PersistentMap } from './map.js';
import { MaterializedHomes } from './homes.js';

export interface ResourceWork {
  allocationsIndexed: number;
  homesDerived: number;
  snapshotMarkersValidated: number;
  skeletonCellsValidated: number;
  resourceRebuilds: number;
  homeTapesValidated: number;
}

/** Retained resource checks are independent of activity and placement replay.
 * Reuse requires exact retained payloads and a continuous, subdividing native
 * branch. The caller establishes those conditions before extending this root.
 * This root stores declared resources, never the preparation's action/activity
 * callbacks or its previous root wrapper.
 */
export class OwnershipResources {
  private allocations = new PersistentMap<Allocation>();
  private tapes = new PersistentMap<Extract<Allocation, { type: 'tape' }>>();
  private markers = new PersistentMap<Extract<Allocation, { type: 'marker' }>>();
  private snapshotMarkers = new PersistentMap<number>();
  private markerCount = 0;
  private homeEntries = new PersistentMap<HomeBinding>();
  private flowHomes = new PersistentMap<HomeBinding>();
  private homeExport: { value?: readonly HomeBinding[] } = {};
  private homeIndex = new MaterializedHomes();
  get homes(): readonly HomeBinding[] {
    if (!this.homeExport.value) {
      countWork('resources.homesExported', this.homeEntries.size);
      this.homeExport.value = [...this.homeEntries.values()];
    }
    return this.homeExport.value;
  }
  homeForFlow(flow: FlowId): HomeBinding | undefined {
    return this.flowHomes.get(resourceKey(flow));
  }
  homeForTape(tape: TapeSnapshot['tape']): HomeBinding | undefined {
    return this.homeEntries.get(resourceKey(tape));
  }
  snapshots(cache: PersistentMap<TapeSnapshot>): readonly TapeSnapshot[] {
    return [...this.tapes.values()].map((tape) => {
      countWork('resources.tapesEnumerated');
      const snapshot = cache.get(resourceKey(tape.id));
      if (!snapshot) throw new OwnershipValidationError('Missing retained tape snapshot');
      return snapshot;
    });
  }
  get homeDomain(): MaterializedHomes {
    return this.homeIndex;
  }
  get tapeCount(): number {
    return this.tapes.size;
  }
  batchHomes(allocations: readonly Allocation[]): readonly HomeBinding[] {
    return allocations.flatMap((allocation) =>
      allocation.type === 'tape' ? [this.homeIndex.binding(allocation.id)] : [],
    );
  }
  static create(
    genesis: LayoutGenesis,
    actions: readonly LayoutActionInput[],
    snapshots: readonly TapeSnapshot[],
    index: MaterializedCells,
    work: ResourceWork,
  ): OwnershipResources {
    countWork('resources.fullRebuilds');
    countWork('resources.actionsMaterialized', actions.length);
    work.resourceRebuilds++;
    return new OwnershipResources().extend(
      [
        { batch: genesis, effects: [] },
        ...actions.map(({ action, births }) => ({
          batch: { allocations: action.allocations, births },
          effects: action.effects,
        })),
      ],
      snapshots,
      index,
      work,
    );
  }
  append(
    actions: readonly LayoutActionInput[],
    snapshots: readonly TapeSnapshot[],
    index: MaterializedCells,
    work: ResourceWork,
  ): OwnershipResources {
    return this.extend(
      actions.map(({ action, births }) => ({
        batch: { allocations: action.allocations, births },
        effects: action.effects,
      })),
      snapshots,
      index,
      work,
    );
  }
  private extend(
    batches: readonly {
      readonly batch: LayoutGenesis;
      readonly effects: readonly SemanticEffect[];
    }[],
    snapshots: readonly TapeSnapshot[],
    index: MaterializedCells,
    work: ResourceWork,
  ): OwnershipResources {
    countWork('resources.indexesConstructed', 5);
    const next = new OwnershipResources();
    next.allocations = this.allocations.fork();
    next.tapes = this.tapes.fork();
    next.markers = this.markers.fork();
    next.snapshotMarkers = this.snapshotMarkers.fork();
    next.markerCount = this.markerCount;
    next.homeEntries = this.homeEntries.fork();
    next.flowHomes = this.flowHomes.fork();
    next.homeExport = this.homeExport;
    const homes = batches.flatMap(({ batch, effects }) => {
      const derived = deriveHomes(batch, effects);
      work.homesDerived += derived.length;
      return derived;
    });
    if (homes.length) next.homeExport = {};
    const markerTapes = new Set<string>();
    for (const { batch } of batches)
      for (const allocation of batch.allocations) {
        const key = resourceKey(allocation.id);
        if (next.allocations.has(key))
          throw new OwnershipValidationError('Duplicate retained resource');
        next.allocations.set(key, allocation);
        if (allocation.type === 'tape') next.tapes.set(key, allocation);
        if (allocation.type === 'marker') {
          next.markers.set(key, allocation);
          markerTapes.add(resourceKey(allocation.tape));
        }
        countWork('resources.allocationsIndexed');
        work.allocationsIndexed++;
      }
    for (const home of homes) {
      next.homeEntries.set(resourceKey(home.cell.tape), home);
      next.flowHomes.set(resourceKey(next.run(home.run).flow), home);
    }
    const seenTapes = new Set<string>();
    for (const snapshot of snapshots) {
      const key = resourceKey(snapshot.tape),
        tape = next.tapes.get(key);
      if (seenTapes.has(key)) throw new OwnershipValidationError('Repeated native tape snapshot');
      seenTapes.add(key);
      // The caller established a continuous native branch and retained payload
      // prefix. Without a new marker allocation, permanent bindings cannot
      // change. Withdrawal/reordering and late earlier payloads use create().
      if (this.snapshotMarkers.has(key) && !markerTapes.has(key)) continue;
      const markers = snapshot.parts.filter((part) => part.type === 'marker');
      if (
        !tape ||
        !markers.length ||
        !sameId(markers[0].marker, tape.start) ||
        !sameId(markers.at(-1)!.marker, tape.end)
      )
        throw new OwnershipValidationError('Snapshot does not match retained tape endpoints');
      for (const marker of markers) {
        const allocation = next.markers.get(resourceKey(marker.marker));
        if (
          !allocation ||
          !sameId(allocation.tape, snapshot.tape) ||
          allocation.native.client !== marker.native.client ||
          allocation.native.clock !== marker.native.clock
        )
          throw new OwnershipValidationError('Snapshot marker does not match retained allocation');
        countWork('resources.markerBindingsValidated');
        work.snapshotMarkersValidated++;
      }
      next.markerCount += markers.length - (next.snapshotMarkers.get(key) ?? 0);
      next.snapshotMarkers.set(key, markers.length);
    }
    if (next.snapshotMarkers.size !== next.tapes.size)
      throw new OwnershipValidationError('Native snapshots must cover exactly the ready tapes');
    if (next.markerCount !== next.markers.size)
      throw new OwnershipValidationError('Native snapshots must cover exactly the ready markers');
    next.homeIndex = this.homeIndex.refine(
      homes,
      snapshots.map((snapshot) => snapshot.tape),
      index,
    );
    work.homeTapesValidated += new Set([
      ...homes.map((home) => resourceKey(home.cell.tape)),
      ...snapshots.map((snapshot) => resourceKey(snapshot.tape)),
    ]).size;
    for (const { batch } of batches)
      for (const allocation of batch.allocations) {
        if (allocation.type !== 'run') continue;
        const captures = next.homeIndex.has(allocation.id)
          ? allocation.skeleton.slice(0, -1)
          : allocation.skeleton;
        const seen = new Set<string>();
        for (const range of allocation.skeleton)
          for (const cell of index.range(range)) {
            const key = cellKey(cell.range);
            if (seen.has(key))
              throw new OwnershipValidationError('Overlapping retained run skeleton');
            seen.add(key);
            countWork('resources.skeletonCellsVisited');
            work.skeletonCellsValidated++;
          }
        for (const range of captures) next.homeDomain.assertCapture(range);
      }
    for (const { effects } of batches)
      for (const effect of effects) {
        countWork('resources.effectsInspected');
        if (effect.type === 'SplitFlow') {
          for (const member of effect.basis.ranges) next.homeDomain.assertCapture(member.range);
          const newHome = next.homeDomain.home(effect.newRun);
          if (!sameId(newHome.occurrence, effect.occurrence))
            throw new OwnershipValidationError('Split root occurrence differs from retained home');
          if (!effect.basis.ranges.length) {
            const home = next.homeDomain.home(effect.cut.run);
            if (
              !sameId(effect.cut.boundary, home.cell.end) ||
              effect.cut.side !== 'left' ||
              effect.cut.predecessor !== null
            )
              throw new OwnershipValidationError(
                'Empty split needs the canonical trailing home cut',
              );
            if (next.run(effect.newRun).skeleton.length !== 1)
              throw new OwnershipValidationError('Empty split must capture no source content');
          }
        } else if (effect.type === 'TransferRange')
          for (const range of effect.ranges) next.homeDomain.assertCapture(range);
      }
    return next;
  }
  run(id: RunId): Extract<Allocation, { type: 'run' }> {
    const allocation = this.allocations.get(resourceKey(id));
    if (!allocation || allocation.type !== 'run')
      throw new OwnershipValidationError('Missing retained run');
    return allocation;
  }
  flowHome(id: FlowId) {
    const allocation = this.allocations.get(resourceKey(id));
    if (!allocation || allocation.type !== 'flow')
      throw new OwnershipValidationError('Missing flow home');
    return allocation.home;
  }
  assertHomes(supplied: readonly HomeBinding[]): void {
    const keys = (values: readonly HomeBinding[]) =>
      values.map((home) => `${cellKey(home.cell)}:${assignmentKey(home)}`).sort();
    const actual = keys(supplied);
    if (new Set(actual).size !== actual.length)
      throw new OwnershipValidationError('Conflicting home bindings');
    if (actual.length !== this.homes.length)
      throw new OwnershipValidationError('Incomplete home bindings');
    if (JSON.stringify(actual) !== JSON.stringify(keys(this.homes)))
      throw new OwnershipValidationError('Home endpoints or binding differ from retained births');
  }
}
