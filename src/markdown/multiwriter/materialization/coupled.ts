import { OwnershipResult } from '../ownership/ownership.js';
import { isTextRefinement, textControlTargets } from '../ownership/text-validation.js';
import { cellKey } from '../ownership/cells.js';
import { PersistentMap, get, set } from './map.js';
import type { MapRoot } from './map.js';
import type { TapeSnapshot } from '../text/types.js';
import type { TapeId, MarkerId } from '../contracts.js';
import type { NativeView } from '../ingest/publication.js';
import { changedNativeTapes } from './native.js';
import type { ProjectionInput } from '../projection/project.js';
import type { Activity } from '../visibility/activity.js';
import { selectInterpretations } from '../projection/interpretation.js';
import { actionKey } from '../actions/references.js';
import { compareBytes } from '../actions/cbor.js';
import { resourceKey } from '../layout/index.js';
import type { OwnershipCheckpoint } from './ownership.js';
import { MaterializedCells } from './cells.js';
import { OwnershipResources } from './resources.js';
import { isPropertyRefinement, propertyControlTargets } from './properties.js';
import type { ResourceWork } from './resources.js';
import type { ActionSequence, PayloadIndex } from './activity.js';
import { replayOwnershipSuffix, orderedOwners } from './ownership.js';
import { readySource } from '../authoring/ready-source.js';
import type { ReadySource } from '../authoring/ready-source.js';

function markerSignature(snapshot: TapeSnapshot): string {
  return snapshot.parts
    .flatMap((part) =>
      part.type === 'marker' ? [JSON.stringify([resourceKey(part.marker), part.native])] : [],
    )
    .join('|');
}
/** A reusable prefix permits subdivision only: retained marker identities, native
 * identities and their order must survive. Withdrawal/rebuilds fail closed. */
function markerRefinement(before: TapeSnapshot, after: TapeSnapshot): boolean {
  const retained = before.parts.filter((part) => part.type === 'marker');
  let next = 0;
  for (const part of after.parts) {
    if (part.type !== 'marker' || next === retained.length) continue;
    const old = retained[next];
    if (resourceKey(old.marker) !== resourceKey(part.marker)) continue;
    if (old.native.client !== part.native.client || old.native.clock !== part.native.clock)
      return false;
    next++;
  }
  return next === retained.length;
}
/** Refine each prefix's own assignments. A later prefix can have transferred or
 * split cells that an older checkpoint still assigns to their private home. */
function refineCheckpoint(
  prior: OwnershipCheckpoint,
  snapshots: readonly TapeSnapshot[],
  index = prior.index.refine(snapshots),
): OwnershipCheckpoint {
  if (!snapshots.length) return prior;
  const owners = prior.owners.fork();
  for (const snapshot of snapshots) {
    if (!prior.installedTapes.has(resourceKey(snapshot.tape))) continue;
    for (const cell of prior.index.tape(snapshot.tape)) {
      const key = cellKey(cell.range),
        owner = owners.get(key);
      if (!owner) throw new Error('Refined native cell has no prior owner');
      const refined = index.range(cell.range);
      if (refined.length === 1 && cellKey(refined[0].range) === key) continue;
      owners.delete(key);
      for (const next of refined) owners.set(cellKey(next.range), { ...owner, cell: next.range });
    }
  }
  return { ...prior, index, owners };
}
interface Payload {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly decisions: string;
}
export interface CoupledWork extends ResourceWork {
  actionsReplayed: number;
  effectsReplayed: number;
  checkpointRestores: number;
  coldReplays: number;
  nativeMarkerFallbacks: number;
  nativeMarkerRefinements: number;
  nativeReaderInvalidations: number;
  nativeIntervalSkips: number;
  nativeIntervalNodesVisited: number;
  payloadsCompared: number;
  readyIndexNodesVisited: number;
  nativeTapeReads: number;
  cellTapesIndexed: number;
  lastReplayFrom: number;
  lastReplayLength: number;
}
/** The structural checkpoint holds placement and ownership at the same effect prefix.
 * Marker subdivision preserves assignments before the first reader of each tape.
 * Split adjacency reads record a tape-local replay frontier. Marker withdrawal or
 * reordering conservatively invalidates from genesis.
 */
export class MaterializedOwnership {
  private state?: OwnershipCheckpoint;
  private resources?: Pick<
    ReturnType<typeof replayOwnershipSuffix>,
    'homes' | 'cohorts' | 'requirements' | 'retained'
  >;
  private native?: NativeView;
  private order?: MapRoot<Payload>;
  private source?: ReadySource;
  private positions?: MapRoot<number>;
  private checkpoints: readonly OwnershipCheckpoint[] = [];
  private markers = new PersistentMap<string>();
  private snapshots = new PersistentMap<TapeSnapshot>();
  private generation = 0;
  private readonly counts: CoupledWork = {
    allocationsIndexed: 0,
    homesDerived: 0,
    snapshotMarkersValidated: 0,
    skeletonCellsValidated: 0,
    resourceRebuilds: 0,
    homeTapesValidated: 0,
    actionsReplayed: 0,
    effectsReplayed: 0,
    checkpointRestores: 0,
    coldReplays: 0,
    nativeMarkerFallbacks: 0,
    nativeMarkerRefinements: 0,
    nativeReaderInvalidations: 0,
    nativeIntervalSkips: 0,
    nativeIntervalNodesVisited: 0,
    payloadsCompared: 0,
    readyIndexNodesVisited: 0,
    nativeTapeReads: 0,
    cellTapesIndexed: 0,
    lastReplayFrom: 0,
    lastReplayLength: 0,
  };
  diagnostics() {
    return { ...this.counts, retainedCheckpoints: this.checkpoints.length };
  }
  private markerReaderFrontier(
    tape: TapeId,
    markers: readonly MarkerId[],
    native: NativeView,
  ): number | undefined {
    const key = resourceKey(tape),
      first = this.state?.nativeReaders.get(key);
    if (first === undefined || !markers.length) return undefined;
    const reads = this.state?.nativeIntervals.get(key);
    if (!reads) return first;
    let frontier: number | undefined;
    for (const marker of markers) {
      const count = reads.first(
        native.marker(marker).index,
        (marker) => native.marker(marker).index,
        () => this.counts.nativeIntervalNodesVisited++,
      );
      if (count !== undefined) frontier = Math.min(frontier ?? count, count);
    }
    if (frontier === undefined) this.counts.nativeIntervalSkips++;
    return frontier;
  }
  /** An unpublished command branch owns its generation and counters. It shares
   * immutable roots, never the reader's mutable candidate or commit lifecycle.
   */
  fork(): MaterializedOwnership | undefined {
    if (!this.state || !this.resources || !this.native) return undefined;
    const copy = new MaterializedOwnership();
    copy.state = this.state;
    copy.resources = this.resources;
    copy.native = this.native;
    copy.order = this.order;
    copy.source = this.source;
    copy.positions = this.positions;
    copy.checkpoints = this.checkpoints;
    copy.markers = this.markers;
    copy.snapshots = this.snapshots;
    return copy;
  }
  *prepare(
    input: ProjectionInput,
    activity: Activity,
    variants: PayloadIndex,
    /** Exact changes in a private author draft based on this committed prefix. */
    stagedTapes?: readonly TapeId[],
    sequence?: ActionSequence,
  ) {
    const generation = ++this.generation,
      count = this.state?.count ?? 0;
    const interpretations = selectInterpretations(activity, input.initialProperties);
    let frontier = Math.min(count, input.actions.length);
    let order: MapRoot<Payload> | undefined;
    let positions: MapRoot<number> | undefined;
    let retainedPrefix = input.actions.length >= count;
    for (let i = 0; i < input.actions.length; i++) {
      yield;
      const action = input.actions[i].action,
        key = actionKey(action.id),
        bytes = variants.get(key);
      if (!bytes) throw new Error('Coupled replay requires exact ready payloads');
      const decisions = action.effects
        .map((_, ordinal) => {
          const ref = { action: action.id, ordinal };
          return `${Number(activity.isEffectActive(ref) && interpretations.effectEligible(ref))}${Number(interpretations.eligible(ref))}`;
        })
        .join('');
      const previous = get(this.order, String(i));
      positions = set(positions, key, i);
      this.counts.payloadsCompared++;
      const samePayload = previous?.key === key && compareBytes(previous.bytes, bytes) === 0;
      if (previous && !samePayload) retainedPrefix = false;
      if (samePayload && previous.decisions === decisions) order = set(order, String(i), previous);
      else {
        frontier = Math.min(frontier, i);
        order = set(order, String(i), { key, bytes, decisions });
      }
    }
    const touched = stagedTapes ?? (this.native && changedNativeTapes(this.native, input.native));
    const continuous = touched !== undefined && this.state !== undefined;
    const snapshotCache = continuous ? this.snapshots.fork() : new PersistentMap<TapeSnapshot>();
    const markers = continuous ? this.markers.fork() : new PersistentMap<string>();
    const updated: TapeSnapshot[] = [];
    const tapes = continuous
      ? touched
      : [
          ...input.genesis.allocations,
          ...input.actions.flatMap(({ action }) => action.allocations),
        ].flatMap((allocation) => (allocation.type === 'tape' ? [allocation.id] : []));
    for (const tape of tapes) {
      const snapshot = input.native.snapshot(tape),
        key = resourceKey(tape);
      snapshotCache.set(key, snapshot);
      markers.set(key, markerSignature(snapshot));
      updated.push(snapshot);
      this.counts.nativeTapeReads++;
    }
    const coldSnapshots = continuous ? undefined : [...snapshotCache.values()];
    const index = continuous
      ? this.state!.index.refine(updated)
      : new MaterializedCells(coldSnapshots!);
    this.counts.cellTapesIndexed += continuous ? updated.length : coldSnapshots!.length;
    const changed = updated.filter((snapshot) => {
      const signature = this.markers.get(resourceKey(snapshot.tape));
      return signature !== undefined && signature !== markers.get(resourceKey(snapshot.tape));
    });
    const withdrawn = !continuous && [...this.markers.keys()].some((key) => !markers.has(key));
    const compatible =
      !withdrawn &&
      changed.every(
        (snapshot) =>
          this.native && markerRefinement(this.native.snapshot(snapshot.tape), snapshot),
      );
    if (!compatible) {
      frontier = 0;
      this.counts.nativeMarkerFallbacks++;
    } else if (changed.length) {
      let readerFrontier = count;
      for (const snapshot of changed) {
        const previous = new Set(
          this.snapshots
            .get(resourceKey(snapshot.tape))
            ?.parts.flatMap((part) => (part.type === 'marker' ? [resourceKey(part.marker)] : [])),
        );
        const added = snapshot.parts.flatMap((part) =>
          part.type === 'marker' && !previous.has(resourceKey(part.marker)) ? [part.marker] : [],
        );
        const reader = this.markerReaderFrontier(snapshot.tape, added, input.native);
        if (reader !== undefined) readerFrontier = Math.min(readerFrontier, reader);
      }
      if (readerFrontier < count) this.counts.nativeReaderInvalidations++;
      frontier = Math.min(frontier, readerFrontier);
      this.counts.nativeMarkerRefinements++;
    }
    const retained =
      continuous && compatible && retainedPrefix && this.resources
        ? this.resources.retained.append(input.actions.slice(count), updated, index, this.counts)
        : OwnershipResources.create(
            input.genesis,
            input.actions,
            coldSnapshots ?? [...snapshotCache.values()],
            index,
            this.counts,
          );
    const snapshots = retained.snapshots(snapshotCache);
    let checkpoints = this.checkpoints
      .filter((checkpoint) => checkpoint.count <= frontier)
      .map((checkpoint) => refineCheckpoint(checkpoint, changed, index));
    const resume =
      compatible && frontier === count && this.state
        ? refineCheckpoint(this.state, changed, index)
        : checkpoints.at(-1);
    if (resume && resume.count !== this.state?.count) this.counts.checkpointRestores++;
    if (!resume) this.counts.coldReplays++;
    yield;
    const from = resume?.count ?? 0;
    const result = replayOwnershipSuffix(
      {
        genesis: input.genesis,
        actions: input.actions,
        snapshots,
        isActive: (order) =>
          activity.isEffectActive({ action: order.action.id, ordinal: order.ordinal }) &&
          interpretations.effectEligible({ action: order.action.id, ordinal: order.ordinal }),
        interpretationEligible: (order) =>
          interpretations.eligible({ action: order.action.id, ordinal: order.ordinal }),
      },
      activity,
      resume,
      (checkpoint) => checkpoints.push(checkpoint),
      index,
      retained,
    );
    this.counts.actionsReplayed += input.actions.length - from;
    this.counts.effectsReplayed += input.actions
      .slice(from)
      .reduce((sum, { action }) => sum + action.effects.length, 0);
    checkpoints = checkpoints.slice(-8);
    let committed = false;
    return {
      value: { ownership: result.value, snapshots },
      commit: () => {
        if (committed || generation !== this.generation)
          throw new Error('Coupled candidate is no longer current');
        committed = true;
        this.state = result.state;
        this.resources = {
          homes: result.homes,
          cohorts: result.cohorts,
          requirements: result.requirements,
          retained: result.retained,
        };
        this.native = input.native;
        this.order = order;
        this.source = sequence && readySource(sequence);
        this.positions = positions;
        this.markers = markers;
        this.snapshots = snapshotCache;
        this.checkpoints = checkpoints;
        this.counts.lastReplayFrom = from;
        this.counts.lastReplayLength = input.actions.length - from;
      },
    };
  }
  prepareText(
    actions: ActionSequence,
    native: NativeView,
    activity: Activity,
    variants: PayloadIndex,
    stagedTapes?: readonly TapeId[],
  ) {
    return this.prepareRefinement('text', actions, native, activity, variants, stagedTapes);
  }
  prepareProperties(
    actions: ActionSequence,
    native: NativeView,
    activity: Activity,
    variants: PayloadIndex,
    stagedTapes?: readonly TapeId[],
  ) {
    return this.prepareRefinement('properties', actions, native, activity, variants, stagedTapes);
  }
  private prepareRefinement(
    kind: 'text' | 'properties',
    actions: ActionSequence,
    native: NativeView,
    activity: Activity,
    variants: PayloadIndex,
    stagedTapes?: readonly TapeId[],
  ) {
    const action = actions.at(-1),
      prior = this.state,
      resources = this.resources;
    if (!prior || !resources || !this.native || !action || actions.length !== prior.count + 1)
      return undefined;
    const directAction = kind === 'text' ? isTextRefinement(action) : isPropertyRefinement(action);
    if (!directAction && action.effects[0]?.type !== 'SetGroupActive') return undefined;
    const source = readySource(actions),
      additions = source && this.source && source.additions(this.source);
    this.counts.readyIndexNodesVisited += additions?.nodesVisited ?? 0;
    const append = additions?.actions.length === 1 && additions.actions[0] === action;
    const byId = directAction || append ? undefined : new Map<string, typeof action>();
    for (let i = 0; !append && i < prior.count; i++) {
      const payload = get(this.order, String(i))!,
        retained = actions.at(i)!;
      this.counts.payloadsCompared++;
      if (payload.key !== actionKey(retained.id) || variants.get(payload.key) !== payload.bytes)
        return undefined;
      byId?.set(payload.key, retained);
    }
    const changes = directAction
      ? [action]
      : (kind === 'text' ? textControlTargets : propertyControlTargets)(action, (id) =>
          append ? source!.get(actionKey(id)) : byId!.get(actionKey(id)),
        );
    if (!changes) return undefined;
    const controlTargets = directAction
      ? undefined
      : new Set(changes.map((target) => actionKey(target.id)));
    const touched = stagedTapes ?? changedNativeTapes(this.native, native);
    if (!touched || (kind === 'properties' && touched.length)) return undefined;
    const hasMarkers = action.allocations.some((allocation) => allocation.type === 'marker');
    if (
      hasMarkers &&
      touched.some((tape) => {
        const added = action.allocations.flatMap((allocation) =>
          allocation.type === 'marker' && resourceKey(allocation.tape) === resourceKey(tape)
            ? [allocation.id]
            : [],
        );
        return this.markerReaderFrontier(tape, added, native) !== undefined;
      })
    )
      return undefined;
    const generation = ++this.generation;
    const snapshots = touched.map((tape) => native.snapshot(tape));
    const index = prior.index.refine(snapshots);
    const retained = resources.retained.append(
      [{ action, births: [] }],
      snapshots,
      index,
      this.counts,
    );
    this.counts.nativeTapeReads += snapshots.length;
    this.counts.cellTapesIndexed += snapshots.length;
    const { owners } = hasMarkers ? refineCheckpoint(prior, snapshots, index) : prior;
    const snapshotCache = this.snapshots.fork();
    for (const snapshot of snapshots) snapshotCache.set(resourceKey(snapshot.tape), snapshot);
    const markers = this.markers.fork();
    if (hasMarkers) {
      for (const snapshot of snapshots)
        markers.set(resourceKey(snapshot.tape), markerSignature(snapshot));
      this.counts.nativeMarkerRefinements++;
    }
    const layout = prior.layout.fork();
    layout.beginAction({ action, births: [] }, (id) => activity.observes(action.id, id));
    for (let ordinal = 0; ordinal < action.effects.length; ordinal++)
      layout.step(ordinal, activity.isEffectActive({ action: action.id, ordinal }));
    const state: OwnershipCheckpoint = { ...prior, count: actions.length, layout, index, owners };
    const value = new OwnershipResult(
      layout,
      index,
      orderedOwners(index, owners, resources.homes),
      prior.roots,
      prior.attachments,
      resources.cohorts,
      resources.requirements,
      resources.homes,
    );
    const decisions = action.effects
      .map((_, ordinal) => `${Number(activity.isEffectActive({ action: action.id, ordinal }))}0`)
      .join('');
    const payload: Payload = {
      key: actionKey(action.id),
      bytes: variants.get(actionKey(action.id))!,
      decisions,
    };
    let committed = false;
    this.counts.actionsReplayed++;
    this.counts.effectsReplayed += action.effects.length;
    return {
      value,
      touched,
      changes,
      control: !directAction,
      commit: () => {
        if (committed || generation !== this.generation)
          throw new Error('Coupled refinement candidate is no longer current');
        committed = true;
        this.state = state;
        this.resources = { ...resources, retained };
        this.markers = markers;
        this.snapshots = snapshotCache;
        this.native = native;
        let order = this.order;
        if (controlTargets)
          for (const key of controlTargets) {
            const i = get(this.positions, key)!;
            const prior = get(this.order, String(i))!;
            const target = append ? source!.get(prior.key)! : actions.at(i)!;
            const decisions = target.effects
              .map(
                (_, ordinal) =>
                  `${Number(activity.isEffectActive({ action: target.id, ordinal }))}0`,
              )
              .join('');
            if (decisions !== prior.decisions)
              order = set(order, String(i), { ...prior, decisions });
          }
        order = set(order, String(prior.count), payload);
        this.positions = set(this.positions, payload.key, prior.count);
        this.order = order;
        this.source = source;
        if (hasMarkers)
          this.checkpoints = this.checkpoints.map((checkpoint) =>
            refineCheckpoint(checkpoint, snapshots, index),
          );
        if (state.count % 128 === 0) this.checkpoints = [...this.checkpoints, state].slice(-8);
        this.counts.lastReplayFrom = actions.length - 1;
        this.counts.lastReplayLength = 1;
      },
    };
  }
  cancel(): void {
    this.generation++;
  }
  evict(): void {
    this.cancel();
    this.state = undefined;
    this.resources = undefined;
    this.native = undefined;
    this.order = undefined;
    this.source = undefined;
    this.positions = undefined;
    this.checkpoints = [];
    this.markers = new PersistentMap();
    this.snapshots = new PersistentMap();
  }
}
