import { reconstructBirths, reconstructBirthContent } from '../reference/provenance.js';
import type { ReadySequence } from '../authoring/ready-source.js';
import { countWork } from '../diagnostics.js';
import { measure } from '../diagnostics.js';
import { OwnershipResult } from '../ownership/ownership.js';
import { isTextRefinement, textControlTargets } from '../ownership/text-validation.js';
import { cellKey, assignmentKey } from '../ownership/cells.js';
import { PersistentMap, get, set } from './map.js';
import type { MapRoot } from './map.js';
import type { TapeSnapshot } from '../text/types.js';
import type { ActionId, TapeId, MarkerId } from '../contracts.js';
import { compareActions } from '../contracts.js';
import type { NativeView } from '../ingest/publication.js';
import { changedNativeTapes, hasIndexedNative } from './native.js';
import type { ProjectionInput } from '../projection/project.js';
import type { Activity } from '../visibility/activity.js';
import { selectInterpretations } from '../projection/interpretation.js';
import type { Interpretations } from '../projection/interpretation.js';
import { actionKey } from '../actions/references.js';
import { compareBytes } from '../actions/cbor.js';
import { encodeEnvelope } from '../actions/codec.js';
import { resourceKey } from '../layout/index.js';
import type { OwnershipCheckpoint } from './ownership.js';
import { MaterializedCells } from './cells.js';
import { OwnershipResources } from './resources.js';
import { isPropertyRefinement, propertyControlTargets } from './properties.js';
import type { ResourceWork } from './resources.js';
import type { ActionSequence, PayloadIndex } from './activity.js';
import { replayOwnershipSuffix, orderedOwners, orderedLayoutInputs } from './ownership.js';
import { readySource } from '../authoring/ready-source.js';
import type { ReadySource } from '../authoring/ready-source.js';

import { subdivideCells } from './subdivision.js';
import type { StructuralChanges } from './subdivision.js';
import { structuralReads } from './structural.js';
import type {
  AuthorProofRequest,
  AuthorProofResult,
  AuthorPublicationBinding,
} from '../ownership/author-proof.js';
import { completeAuthorProof, AuthorProofUnavailable } from '../ownership/author-proof.js';

function markerSignature(snapshot: TapeSnapshot): string {
  return snapshot.parts
    .flatMap((part) =>
      part.type === 'marker' ? [JSON.stringify([resourceKey(part.marker), part.native])] : [],
    )
    .join('|');
}
/** Marker-stable text updates need only tape identity for resource checks. Keep
 * a detached full export available for a later structural/snapshot consumer.
 * This helper owns no preparation or previous publication context.
 */
function deferredSnapshot(
  native: NativeView,
  tape: TapeId,
  work: Pick<CoupledWork, 'deferredTapeReads'>,
): TapeSnapshot {
  let snapshot: TapeSnapshot | undefined;
  const read = () => {
    if (!snapshot) {
      snapshot = native.snapshot(tape);
      work.deferredTapeReads++;
    }
    return snapshot;
  };
  return {
    tape,
    get length() {
      return read().length;
    },
    get parts() {
      return read().parts;
    },
  };
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
export function refineCheckpoint(
  prior: OwnershipCheckpoint,
  snapshots: readonly TapeSnapshot[],
  index = prior.index.refine(snapshots),
): OwnershipCheckpoint {
  return measure('coupled-replay', () => refineCheckpointMeasured(prior, snapshots, index));
}
function refineCheckpointMeasured(
  prior: OwnershipCheckpoint,
  snapshots: readonly TapeSnapshot[],
  index = prior.index.refine(snapshots),
): OwnershipCheckpoint {
  if (!snapshots.length) return prior;
  countWork('refinement.checkpoints');
  const owners = prior.owners.fork();
  const coverage = prior.coverage.fork();
  const assignmentCounts = prior.assignmentCounts.fork();
  const structural = prior.structural.fork();
  structural.changedTapes(snapshots.map((snapshot) => snapshot.tape));
  const replacements = new Map<string, readonly string[]>();
  for (const snapshot of snapshots) {
    if (!prior.installedTapes.has(resourceKey(snapshot.tape))) continue;
    for (const cell of prior.index.tape(snapshot.tape)) {
      countWork('refinement.oldCells');
      const key = cellKey(cell.range),
        owner = owners.get(key);
      if (!owner) throw new Error('Refined native cell has no prior owner');
      const refined = index.range(cell.range);
      if (refined.length === 1 && cellKey(refined[0].range) === key) continue;
      owners.delete(key);
      const assignment = assignmentKey(owner);
      assignmentCounts.set(assignment, assignmentCounts.get(assignment)! + refined.length - 1);
      for (const next of refined) {
        countWork('refinement.assignmentsCloned');
        owners.set(cellKey(next.range), { ...owner, cell: next.range });
      }
      replacements.set(
        key,
        refined.map((cell) => cellKey(cell.range)),
      );
    }
  }
  coverage.refine(replacements);
  return { ...prior, index, owners, coverage, assignmentCounts, structural };
}
interface Payload {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly decisions: string;
  readonly entry: ProjectionInput['actions'][number];
}
function decisionKey(
  activity: Activity,
  selection: Pick<Interpretations, 'eligible' | 'effectEligible'>,
  ref: Parameters<Activity['isEffectActive']>[0],
): string {
  return `${Number(activity.isEffectActive(ref))}${Number(selection.effectEligible(ref))}${Number(selection.eligible(ref))}`;
}
/** A suffix without controls or packets cannot change retained eligibility.
 * Read its exact per-effect certificate instead of retaining another selector.
 */
function retainedSelection(
  order: MapRoot<Payload> | undefined,
  positions: MapRoot<number> | undefined,
): Pick<Interpretations, 'eligible' | 'effectEligible'> {
  const decisions = (ref: Parameters<Activity['isEffectActive']>[0]) => {
    const at = get(positions, actionKey(ref.action));
    return at === undefined ? undefined : get(order, String(at))!.decisions;
  };
  return {
    effectEligible: (ref) => decisions(ref)?.[ref.ordinal * 3 + 1] !== '0',
    eligible: (ref) => decisions(ref)?.[ref.ordinal * 3 + 2] === '1',
  };
}
/** Certified publication input. Retained ordered payloads own the old layout
 * entries; production callers provide no duplicate full provenance inventory. */
export interface StructuralReadyInput {
  readonly genesis: ProjectionInput['genesis'];
  readonly genesisManifest: ProjectionInput['genesisManifest'];
  readonly initialProperties: ProjectionInput['initialProperties'];
  readonly native: NativeView;
  readonly actions: ReadySequence;
}
interface LayoutSequence {
  readonly length: number;
  at(index: number): ProjectionInput['actions'][number] | undefined;
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
  interpretationSelections: number;
  nativeTapeReads: number;
  deferredTapeReads: number;
  cellTapesIndexed: number;
  coverageFlowsTraversed: number;
  coverageCellsVisited: number;
  lastReplayFrom: number;
  lastReplayLength: number;
  lastReplayReason: StructuralChanges['reason'];
}
/** The structural checkpoint holds placement and ownership at the same effect prefix.
 * Ordered content subdivision preserves each checkpoint's own assignments.
 * Reserved-to-ordinary changes keep the tape-local split-reader frontier.
 * Marker withdrawal, reordering or a new native branch invalidate from genesis.
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
  private genesis?: ProjectionInput['genesis'];
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
    interpretationSelections: 0,
    nativeTapeReads: 0,
    deferredTapeReads: 0,
    cellTapesIndexed: 0,
    coverageFlowsTraversed: 0,
    coverageCellsVisited: 0,
    lastReplayFrom: 0,
    lastReplayLength: 0,
    lastReplayReason: 'cold',
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
    copy.genesis = this.genesis;
    copy.checkpoints = this.checkpoints;
    copy.markers = this.markers;
    copy.snapshots = this.snapshots;
    return copy;
  }
  /** Exact committed roots only. The guard owns no candidate and is never a proof. */
  authorBase(base: {
    readonly genesis: object;
    readonly native?: object;
    readonly ready?: object;
    readonly checkpoint?: object;
  }) {
    if (
      !this.state ||
      this.genesis !== base.genesis ||
      this.native !== base.native ||
      this.source !== base.ready ||
      this.state !== base.checkpoint
    )
      return undefined;
    const state = this.state,
      generation = this.generation;
    return {
      branch: this.fork()!,
      revision: generation,
      assertCurrent: () => {
        if (this.state !== state || this.generation !== generation)
          throw new Error('Author ownership base was invalidated');
      },
    };
  }
  *prepareAuthor(
    input: ProjectionInput,
    activity: Activity,
    variants: PayloadIndex,
    tapes: readonly TapeId[],
    sequence: ActionSequence,
    request: AuthorProofRequest,
    bindings: AuthorPublicationBinding,
  ): Generator<void, AuthorProofResult, void> {
    const count = this.state?.count ?? 0,
      order = this.order;
    const candidate = input.actions.at(-1)!;
    const indexed: LayoutSequence = {
      length: sequence.length,
      at: (i) => (i < count ? get(order, String(i))?.entry : i === count ? candidate : undefined),
    };
    try {
      const prepared = yield* this.prepareInput(
        input,
        activity,
        variants,
        tapes,
        sequence,
        indexed,
        undefined,
        candidate.action.id,
      );
      prepared.assertCurrent();
      const changes = prepared.value.changes;
      if (changes.replayFrom !== count || changes.replayTo !== count + 1)
        throw new Error('Author proof replayed outside its single candidate suffix');
      countWork('authorProof.suffixActions', changes.replayTo - changes.replayFrom);
      countWork('authorProof.oldActionsReplayed', count - changes.replayFrom);
      return {
        state: 'proved',
        proof: completeAuthorProof(request, bindings, {
          ordinals: candidate.action.effects.length,
          replayFrom: changes.replayFrom,
          replayTo: changes.replayTo,
          refinement: changes.subdivisions,
        }),
      };
    } catch (error) {
      if (!(error instanceof AuthorProofUnavailable)) throw error;
      return { state: 'unavailable', reason: error.reason };
    }
  }
  *prepareReady(
    input: StructuralReadyInput,
    activity: Activity,
    variants: PayloadIndex,
    touched?: readonly TapeId[],
  ) {
    return yield* this.prepareIndexed(input, activity, variants, touched);
  }
  /** Private compiler revisions share indexed input without masquerading as
   * final publication preparation. They never install a partial action. */
  *prepareCommand(
    input: StructuralReadyInput,
    activity: Activity,
    variants: PayloadIndex,
    touched: readonly TapeId[],
  ) {
    return yield* this.prepareIndexed(input, activity, variants, touched);
  }
  private *prepareIndexed(
    input: StructuralReadyInput,
    activity: Activity,
    variants: PayloadIndex,
    touched?: readonly TapeId[],
  ) {
    const source = readySource(input.actions);
    const additions = source && this.source && source.additions(this.source);
    const count = this.state?.count ?? 0;
    const append = !!(
      additions &&
      this.state &&
      this.genesis === input.genesis &&
      input.actions.length === count + additions.actions.length &&
      (!count ||
        !additions.actions.length ||
        compareActions(input.actions.at(count - 1)!, additions.actions[0]) < 0)
    );
    const fresh =
      additions && this.genesis === input.genesis ? additions.actions : [...input.actions];
    const freshEntries = fresh.map((action) => ({ action, births: reconstructBirths(action) }));
    const entries = append
      ? []
      : [...input.actions].map((action) => ({
          action,
          births: reconstructBirths(action),
        }));
    if (!append) countWork('coupled.readyAuditEntries', entries.length);
    const order = this.order;
    const indexed: LayoutSequence | undefined = append
      ? {
          length: input.actions.length,
          at: (i) => (i < count ? get(order, String(i))?.entry : freshEntries[i - count]),
        }
      : undefined;
    const birthContent = freshEntries.flatMap(({ action, births }) =>
      reconstructBirthContent({ ...action, births }),
    );
    const prepared = yield* this.prepareInput(
      { ...input, actions: entries, birthContent: [] },
      activity,
      variants,
      touched,
      input.actions,
      indexed,
      { source, additions },
    );
    return {
      ...prepared,
      value: {
        ownership: prepared.value.ownership,
        changes: prepared.value.changes,
        birthContent,
        get snapshots() {
          return prepared.value.snapshots;
        },
      },
    };
  }
  *prepare(
    input: ProjectionInput,
    activity: Activity,
    variants: PayloadIndex,
    stagedTapes?: readonly TapeId[],
    sequence?: ActionSequence,
  ) {
    return yield* this.prepareInput(input, activity, variants, stagedTapes, sequence);
  }
  private *prepareInput(
    input: ProjectionInput,
    activity: Activity,
    variants: PayloadIndex,
    /** Exact changes in a private author draft based on this committed prefix. */
    stagedTapes?: readonly TapeId[],
    sequence?: ActionSequence,
    indexed?: LayoutSequence,
    ready?: {
      readonly source: ReadySource | undefined;
      readonly additions: ReturnType<ReadySource['additions']>;
    },
    author?: ActionId,
  ) {
    let length = indexed?.length ?? input.actions.length;
    const generation = ++this.generation,
      count = this.state?.count ?? 0;
    const source = ready ? ready.source : sequence && readySource(sequence),
      additions = ready ? ready.additions : source && this.source && source.additions(this.source);
    this.counts.readyIndexNodesVisited += additions?.nodesVisited ?? 0;
    // The ordered ready root certifies exact retained payloads. An appended
    // control names its affected prior actions; packet selection still uses the
    // full audit path because it can change other packets' eligibility.
    const exactAppend = !!(
      additions &&
      this.state &&
      this.genesis === input.genesis &&
      length === count + additions.actions.length &&
      (!count ||
        !additions.actions.length ||
        compareActions(sequence!.at(count - 1)!, additions.actions[0]) < 0)
    );
    if (author && (!exactAppend || additions!.actions.length !== 1 || length !== count + 1))
      throw new AuthorProofUnavailable('not-exact-single-append');
    // Unknown/earlier inventories take the complete ordering audit. All tables
    // and replay then use that same order, including callers without ready metadata.
    if (!exactAppend) {
      input = { ...input, actions: orderedLayoutInputs(input.actions) };
      length = input.actions.length;
    }
    const controls = exactAppend
      ? additions!.actions.flatMap((action) =>
          action.effects.flatMap((effect) =>
            effect.type === 'SetGroupActive' ? effect.actions : [],
          ),
        )
      : [];
    const targets = controls.map((id) => source!.get(actionKey(id))!);
    const indexedSelection =
      exactAppend &&
      [...additions!.actions, ...targets].every(
        (action) => action && action.effects.every((effect) => effect.type !== 'Interpret'),
      );
    const interpretations = indexedSelection
      ? retainedSelection(this.order, this.positions)
      : selectInterpretations(activity, input.initialProperties);
    if (!indexedSelection) this.counts.interpretationSelections++;
    let frontier = this.genesis === input.genesis ? Math.min(count, length) : 0;
    let order: MapRoot<Payload> | undefined = indexedSelection ? this.order : undefined;
    let positions: MapRoot<number> | undefined = indexedSelection ? this.positions : undefined;
    let retainedPrefix = this.genesis === input.genesis && length >= count;
    const indices = indexedSelection
      ? [
          ...new Set([
            ...controls.flatMap((id) => {
              const at = get(this.positions, actionKey(id));
              return at === undefined ? [] : [at];
            }),
            ...additions!.actions.map((_, i) => count + i),
          ]),
        ]
      : Array.from({ length: length }, (_, i) => i);
    const payloadChanges: StructuralChanges['payloads'][number][] = [];
    const changedActions: StructuralChanges['actions'][number][] = [];
    for (const i of indices) {
      yield;
      if (generation !== this.generation) throw new Error('Coupled candidate is no longer current');
      countWork('coupled.actionsCompared');
      const entry =
        exactAppend && i < count
          ? get(this.order, String(i))!.entry
          : (indexed?.at(i) ?? input.actions[i]);
      const action = entry.action,
        key = actionKey(action.id),
        bytes = variants.get(key);
      if (!bytes) throw new Error('Coupled replay requires exact ready payloads');
      if (source && !source.has(key)) throw new Error('Coupled action is outside its ready root');
      if (source?.get(key) !== action) {
        const encoded = encodeEnvelope(action);
        countWork('coupled.payloadBytesEncoded', encoded.length);
        if (compareBytes(encoded, bytes) !== 0)
          throw new Error('Coupled action differs from its exact ready payload');
      }
      if (exactAppend && action !== sequence!.at(i)) {
        const expected = sequence!.at(i)!;
        if (key !== actionKey(expected.id))
          throw new Error('Coupled suffix differs from its exact ready payload');
      }
      const decisions = action.effects
        .map((_, ordinal) => {
          const ref = { action: action.id, ordinal };
          return decisionKey(activity, interpretations, ref);
        })
        .join('');
      const previous = get(this.order, String(i));
      positions = set(positions, key, i);
      this.counts.payloadsCompared++;
      const samePayload = previous?.key === key && compareBytes(previous.bytes, bytes) === 0;
      if (previous && !samePayload) retainedPrefix = false;
      if (samePayload && previous.decisions === decisions) order = set(order, String(i), previous);
      else {
        payloadChanges.push({ position: i, before: previous, after: { key, bytes, decisions } });
        changedActions.push(action);
        // Text/properties change projection activity, not the raw coupled graph.
        // Marker and allocation births still enter through the actual suffix.
        const structural = action.effects.some((effect) =>
          [
            'TransferRange',
            'SplitFlow',
            'JoinFlow',
            'MoveBlock',
            'LiftChildren',
            'Interpret',
          ].includes(effect.type),
        );
        if (!samePayload || structural) frontier = Math.min(frontier, i);
        order = set(order, String(i), { key, bytes, decisions, entry });
      }
    }
    for (let i = length; i < count; i++)
      payloadChanges.push({ position: i, before: get(this.order, String(i)) });
    const touched = stagedTapes ?? (this.native && changedNativeTapes(this.native, input.native));
    const continuous =
      touched !== undefined && this.state !== undefined && this.genesis === input.genesis;
    let auditEntries: ProjectionInput['actions'] | undefined;
    const fullEntries = () => {
      if (!indexed) return input.actions;
      if (!auditEntries) {
        auditEntries = Array.from({ length }, (_, i) => indexed.at(i)!);
        countWork('coupled.readyAuditEntries', length);
      }
      return auditEntries;
    };
    const snapshotCache = continuous ? this.snapshots.fork() : new PersistentMap<TapeSnapshot>();
    const markers = continuous ? this.markers.fork() : new PersistentMap<string>();
    const updated: TapeSnapshot[] = [];
    const tapes = continuous
      ? touched
      : [
          ...input.genesis.allocations,
          ...fullEntries().flatMap(({ action }) => action.allocations),
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
      ? this.state!.index.refine(updated, input.native)
      : new MaterializedCells(coldSnapshots!, undefined, input.native);
    this.counts.cellTapesIndexed += continuous ? updated.length : coldSnapshots!.length;
    const changed = updated.filter((snapshot) => {
      const signature = this.markers.get(resourceKey(snapshot.tape));
      return signature !== undefined && signature !== markers.get(resourceKey(snapshot.tape));
    });
    const withdrawn = !continuous && [...this.markers.keys()].some((key) => !markers.has(key));
    const compatible =
      (!this.state || continuous) &&
      !withdrawn &&
      changed.every((snapshot) =>
        markerRefinement(this.snapshots.get(resourceKey(snapshot.tape))!, snapshot),
      );
    const subdivisions =
      compatible && this.resources && this.state
        ? subdivideCells(this.state.index, index, this.resources.retained.homeDomain, changed)
        : [];
    let reason: StructuralChanges['reason'] = !this.state
      ? 'cold'
      : frontier === count && exactAppend
        ? 'append'
        : 'changed-order-or-activity';
    if (!compatible) {
      frontier = 0;
      this.counts.nativeMarkerFallbacks++;
      reason = 'native-withdrawal-or-reorder';
    } else if (changed.length) {
      let readerFrontier = count;
      for (const snapshot of changed) {
        const previous = new Set(
          this.snapshots
            .get(resourceKey(snapshot.tape))
            ?.parts.flatMap((part) => (part.type === 'marker' ? [resourceKey(part.marker)] : [])),
        );
        const unsafe = subdivisions.filter(
          (change) =>
            resourceKey(change.before.tape) === resourceKey(snapshot.tape) &&
            change.reservedBefore &&
            change.reservedAfter.some((reserved) => !reserved),
        );
        const added = snapshot.parts.flatMap((part) =>
          part.type === 'marker' &&
          !previous.has(resourceKey(part.marker)) &&
          unsafe.some((change) => index.containsBoundary(change.before, part.marker))
            ? [part.marker]
            : [],
        );
        const reader = this.markerReaderFrontier(snapshot.tape, added, input.native);
        if (reader !== undefined) readerFrontier = Math.min(readerFrontier, reader);
      }
      if (readerFrontier < count) this.counts.nativeReaderInvalidations++;
      frontier = Math.min(frontier, readerFrontier);
      this.counts.nativeMarkerRefinements++;
      if (readerFrontier < count) reason = 'reserved-content-reader';
      else if (exactAppend && frontier === count) reason = 'content-subdivision';
    }
    // Decline BEFORE resource reconstruction, checkpoint selection or old replay.
    if (author && (!continuous || !compatible || !retainedPrefix || frontier !== count))
      throw new AuthorProofUnavailable(!continuous ? 'native-continuity' : reason);
    const retained =
      continuous && compatible && retainedPrefix && this.resources
        ? this.resources.retained.append(
            indexed
              ? Array.from({ length: length - count }, (_, i) => indexed.at(count + i)!)
              : input.actions.slice(count),
            updated,
            index,
            this.counts,
          )
        : OwnershipResources.create(
            input.genesis,
            fullEntries(),
            coldSnapshots ?? [...snapshotCache.values()],
            index,
            this.counts,
          );
    let exportedSnapshots: readonly TapeSnapshot[] | undefined;
    const snapshots = () => (exportedSnapshots ??= retained.snapshots(snapshotCache));
    let checkpoints = this.checkpoints
      .filter((checkpoint) => compatible && checkpoint.count <= frontier)
      .map((checkpoint) => refineCheckpoint(checkpoint, changed, index));
    const resume =
      compatible && frontier === count && this.state
        ? refineCheckpoint(this.state, changed, index)
        : checkpoints.at(-1);
    if (resume && resume.count !== this.state?.count) this.counts.checkpointRestores++;
    if (!resume) this.counts.coldReplays++;
    yield;
    if (generation !== this.generation) throw new Error('Coupled candidate is no longer current');
    const from = resume?.count ?? 0;
    countWork('coupled.candidatesPrepared');
    const result = replayOwnershipSuffix(
      {
        genesis: input.genesis,
        actions: input.actions,
        snapshots: [], // The supplied cell/resource indexes own replay's native reads.
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
      this.counts,
      exactAppend ? { length: length, at: (i) => get(order, String(i))!.entry } : input.actions,
      author,
    );
    this.counts.actionsReplayed += length - from;
    for (let i = from; i < length; i++)
      this.counts.effectsReplayed += get(order, String(i))!.entry.action.effects.length;
    checkpoints = checkpoints.slice(-8);
    let committed = false;
    const assertCurrent = () => {
      if (committed || generation !== this.generation)
        throw new Error('Coupled candidate is no longer current');
    };
    const installedNative = input.native,
      installedGenesis = input.genesis;
    const installedResources = {
      homes: result.homes,
      cohorts: result.cohorts,
      requirements: result.requirements,
      retained: result.retained,
    };
    return {
      assertCurrent,
      value: {
        ownership: result.value,
        get snapshots() {
          return snapshots();
        },
        changes: {
          base: {
            native: this.native,
            ready: this.source,
            genesis: this.genesis ?? input.genesis,
            checkpoint: this.state,
          },
          candidate: {
            genesis: input.genesis,
            native: input.native,
            ready: source,
            revision: generation,
            checkpoint: result.state,
          },
          payloads: payloadChanges,
          actions: changedActions,
          assignments: [
            ...result.state.owners.changes(this.state?.owners ?? new PersistentMap(), () =>
              countWork('ownership.changeIndexNodes'),
            ),
          ],
          layout: result.state.layout.changes(this.state?.layout),
          derived: result.state.structural.changes(this.state?.structural),
          attachments: [
            ...result.state.attachments.changes(
              this.state?.attachments ?? new PersistentMap(),
              () => countWork('ownership.changeIndexNodes'),
            ),
          ],
          roots: [
            ...result.state.roots.changes(this.state?.roots ?? new PersistentMap(), () =>
              countWork('ownership.changeIndexNodes'),
            ),
          ],
          subdivisions,
          tapes,
          replayFrom: from,
          replayTo: length,
          reason,
        } satisfies StructuralChanges,
      },
      commit: (acceptedSource?: ReadySource) => {
        assertCurrent();
        committed = true;
        this.state = result.state;
        this.resources = installedResources;
        this.native = installedNative;
        this.order = order;
        this.source = acceptedSource ?? source;
        this.positions = positions;
        this.genesis = installedGenesis;
        this.markers = markers;
        this.snapshots = snapshotCache;
        this.checkpoints = checkpoints;
        countWork('coupled.committedActionsReplayed', length - from);
        countWork('coupled.candidatesCommitted');
        this.counts.lastReplayFrom = from;
        this.counts.lastReplayLength = length - from;
        this.counts.lastReplayReason = reason;
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
    return measure('coupled-replay', () => {
      return this.prepareRefinement('text', actions, native, activity, variants, stagedTapes);
    });
  }
  prepareProperties(
    actions: ActionSequence,
    native: NativeView,
    activity: Activity,
    variants: PayloadIndex,
    stagedTapes?: readonly TapeId[],
  ) {
    return measure('coupled-replay', () => {
      return this.prepareRefinement('properties', actions, native, activity, variants, stagedTapes);
    });
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
    const markerSnapshots = hasMarkers ? touched.map((tape) => native.snapshot(tape)) : [];
    this.counts.nativeTapeReads += markerSnapshots.length;
    if (
      hasMarkers &&
      !markerSnapshots.every((snapshot) =>
        markerRefinement(this.snapshots.get(resourceKey(snapshot.tape))!, snapshot),
      )
    )
      return undefined;
    const refinedIndex = hasMarkers ? prior.index.refine(markerSnapshots, native) : undefined;
    this.counts.cellTapesIndexed += markerSnapshots.length;
    const subdivisions = refinedIndex
      ? subdivideCells(prior.index, refinedIndex, resources.retained.homeDomain, markerSnapshots)
      : [];
    if (
      hasMarkers &&
      touched.some((tape) => {
        const added = action.allocations.flatMap((allocation) =>
          allocation.type === 'marker' && resourceKey(allocation.tape) === resourceKey(tape)
            ? [allocation.id]
            : [],
        );
        const unsafe = subdivisions.filter(
          (change) =>
            resourceKey(change.before.tape) === resourceKey(tape) &&
            change.reservedBefore &&
            change.reservedAfter.some((reserved) => !reserved),
        );
        return (
          this.markerReaderFrontier(
            tape,
            added.filter((marker) =>
              unsafe.some((change) => refinedIndex!.containsBoundary(change.before, marker)),
            ),
            native,
          ) !== undefined
        );
      })
    )
      return undefined;
    const generation = ++this.generation;
    const localCells = !hasMarkers && hasIndexedNative(native);
    const snapshots = hasMarkers
      ? markerSnapshots
      : touched.map((tape) =>
          localCells ? deferredSnapshot(native, tape, this.counts) : native.snapshot(tape),
        );
    const index = localCells
      ? prior.index.withNative(native, touched)
      : (refinedIndex ?? prior.index.refine(snapshots, native));
    const retained = resources.retained.append(
      [{ action, births: [] }],
      snapshots,
      index,
      this.counts,
    );
    this.counts.nativeTapeReads += localCells || hasMarkers ? 0 : snapshots.length;
    this.counts.cellTapesIndexed += localCells || hasMarkers ? 0 : snapshots.length;
    const refined = hasMarkers ? refineCheckpoint(prior, snapshots, index) : prior;
    const { owners, coverage } = refined;
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
    const state: OwnershipCheckpoint = {
      ...refined,
      count: actions.length,
      layout,
      index,
      owners,
      coverage,
    };
    const structural = refined.structural.fork();
    structural.refresh(layout, index, retained, refined.assignmentCounts, refined.flowIntentions);
    const finalState = { ...state, structural };
    const { cohorts, requirements, homes, homeLookup, cohortLookup } = structuralReads(
      structural,
      retained,
    );
    const value = new OwnershipResult(
      layout,
      index,
      orderedOwners(index, owners, homes),
      prior.roots,
      prior.attachments,
      cohorts,
      requirements,
      homes,
      homeLookup,
      cohortLookup,
    );
    const decisions = action.effects
      .map((_, ordinal) => `${Number(activity.isEffectActive({ action: action.id, ordinal }))}10`)
      .join('');
    const payload: Payload = {
      key: actionKey(action.id),
      bytes: variants.get(actionKey(action.id))!,
      decisions,
      entry: { action, births: [] },
    };
    let candidateOrder = this.order;
    const payloadChanges: StructuralChanges['payloads'][number][] = [];
    if (controlTargets)
      for (const key of controlTargets) {
        countWork('coupled.controlTargets');
        const i = get(this.positions, key)!,
          previous = get(this.order, String(i))!;
        const target = append ? source!.get(previous.key)! : actions.at(i)!;
        const decisions = target.effects
          .map(
            (_, ordinal) => `${Number(activity.isEffectActive({ action: target.id, ordinal }))}10`,
          )
          .join('');
        if (decisions !== previous.decisions) {
          const next = { ...previous, decisions };
          candidateOrder = set(candidateOrder, String(i), next);
          payloadChanges.push({ position: i, before: previous, after: next });
        }
      }
    candidateOrder = set(candidateOrder, String(prior.count), payload);
    payloadChanges.push({ position: prior.count, after: payload });
    const structuralChanges: StructuralChanges = {
      base: { genesis: this.genesis!, native: this.native, ready: this.source, checkpoint: prior },
      candidate: {
        genesis: this.genesis!,
        native,
        ready: source,
        revision: generation,
        checkpoint: finalState,
      },
      subdivisions,
      tapes: touched,
      payloads: payloadChanges,
      actions: directAction ? [action] : [...changes, action],
      assignments: [...owners.changes(prior.owners, () => countWork('ownership.changeIndexNodes'))],
      layout: layout.changes(prior.layout),
      derived: structural.changes(prior.structural),
      roots: [],
      attachments: [],
      replayFrom: prior.count,
      replayTo: actions.length,
      reason: hasMarkers ? 'content-subdivision' : 'append',
    };
    const length = actions.length;
    const positions = set(this.positions, payload.key, prior.count);
    let checkpoints = hasMarkers
      ? this.checkpoints.map((checkpoint) => refineCheckpoint(checkpoint, snapshots, index))
      : this.checkpoints;
    if (state.count % 128 === 0) checkpoints = [...checkpoints, finalState].slice(-8);
    const installedResources = { ...resources, retained, cohorts, requirements, homes };
    let committed = false;
    const assertCurrent = () => {
      if (committed || generation !== this.generation)
        throw new Error('Coupled refinement candidate is no longer current');
    };
    countWork('coupled.candidatesPrepared');
    this.counts.actionsReplayed++;
    this.counts.effectsReplayed += action.effects.length;
    return {
      assertCurrent,
      value,
      touched,
      changes,
      structuralChanges,
      control: !directAction,
      commit: (acceptedSource?: ReadySource) => {
        assertCurrent();
        committed = true;
        this.state = finalState;
        this.resources = installedResources;
        this.markers = markers;
        this.snapshots = snapshotCache;
        this.native = native;
        this.positions = positions;
        this.order = candidateOrder;
        this.source = acceptedSource ?? source;
        this.checkpoints = checkpoints;
        countWork('coupled.committedActionsReplayed');
        countWork('coupled.candidatesCommitted');
        this.counts.lastReplayFrom = length - 1;
        this.counts.lastReplayLength = 1;
        this.counts.lastReplayReason = hasMarkers ? 'content-subdivision' : 'append';
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
    this.genesis = undefined;
    this.checkpoints = [];
    this.markers = new PersistentMap();
    this.snapshots = new PersistentMap();
  }
}
