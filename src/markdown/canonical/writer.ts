import * as Y from 'yjs';

import { CanonicalIndexes } from './indexes.js';
import { deepCopy, stableJson } from './util.js';
import {
  metaMap,
  nodeCell,
  nodeMap,
  readCell,
  revisionMap,
  sessionWatermarkMap,
  tapeMap,
} from './state-access.js';
import type { RecordMap } from './state-access.js';
import {
  MAX_CACHED_RESPONSES,
  MAX_CACHED_RESPONSE_BYTES,
  acceptedResponseBytes,
  actionIdentity,
  copyAcceptedAction,
  copyActionFocus,
  copyRequest,
  requestHash,
  sessionWatermarkKey,
} from './protocol.js';
import type { CachedActionResponse } from './protocol.js';
import { MutableTreeDraft } from './plan/draft.js';
import type { LowLevelPlan } from './plan/draft.js';
import {
  structuralPatchBetween,
  structuralPatchError,
  structuralPatchWithLiveIdentities,
} from './history/structural-patches.js';
import {
  applyMappedTextEdit,
  applyPlan,
  applyStructuralPatch,
  assertResolvedUpdate,
  boundarySignature,
  cloneDocument,
  trackNativeMutations,
} from './native-execution.js';
import type { NativeMutationEvidence } from './native-execution.js';
import { CanonicalReplicas } from './replicas.js';
import {
  historyFocus,
  historyFocusAnchor,
  historySelectionAnchors,
  updateRevisionsAfterHistory,
} from './history.js';
import type {
  ActionFocusAnchors,
  HistoryEntry,
  HistoryReservation,
  PendingHistoryRecord,
} from './history.js';
import { CanonicalHistoryCoordinator } from './history/coordinator.js';
import {
  RoutedNativeTextHistoryCapture,
  type NativeTextHistoryCapture,
} from '../canonical-history-capture.js';

import { CanonicalDocument, canonicalWriterAccess } from './document.js';
import { validateCanonicalState } from './validation.js';
import { assertRetainedResources, assertTapeRevisions } from './accepted-update.js';
import type { Span, TapeId } from './types.js';
import type { NodeId, NodeKind, TextEdit } from '../semantic/types.js';
import type {
  ActionOptions,
  ActionReceipt,
  ActionRequest,
  AcceptedAction,
  AdmittedContext,
  ApplyResult,
  Bookmark,
  CellField,
  DraftCommand,
  HistoryPreparationResult,
  HistoryResult,
  PendingCommit,
  PendingHistoryCommit,
  ReadPrecondition,
  RejectionReason,
  StructuralPatch,
  WriterEvent,
  WriterListener,
  WriterOperationCounts,
  WriterOptions,
} from './action-types.js';
import { indexNativeTape } from '../canonical-text.js';
import type { NativeTapeIndex } from '../canonical-text.js';
import { normalizeSemanticTree as normalizeCanonicalDraft } from '../semantic/normalize.js';
import { classifyInlineInput, parseBlocks } from '../block-parser/api.js';
import type { ParserConversionPlan } from '../block-parser/api.js';
import { applyParserConversion } from '../canonical-promotion.js';
import { createCanonicalTextAnchorFromIndexes } from '../canonical-selection.js';

const INLINE_KINDS = new Set<NodeKind>(['paragraph', 'section', 'code-block']);

const EMPTY_PLAN: LowLevelPlan = Object.freeze({
  allocations: Object.freeze([]),
  newTapes: Object.freeze([]),
  boundaries: Object.freeze([]),
  deletions: Object.freeze([]),
  insertions: Object.freeze([]),
  writes: Object.freeze([]),
  touchedNodes: Object.freeze([]),
  touchedTapes: Object.freeze([]),
  textTapes: Object.freeze([]),
});

const EMPTY_STRUCTURAL_PATCH: StructuralPatch = Object.freeze({
  cells: Object.freeze([]),
  childLists: Object.freeze([]),
  births: Object.freeze([]),
  visibility: Object.freeze([]),
  bornTapes: Object.freeze([]),
  bornMarkers: Object.freeze([]),
});

interface PreparedActionBase {
  readonly request: ActionRequest;
  readonly context: AdmittedContext;
  readonly requestHash: string;
  readonly revision: number;
  readonly nextRevision: number;
  readonly plan: LowLevelPlan;
  readonly structuralPatch: StructuralPatch;
  readonly changedTapeIds: ReadonlySet<TapeId>;
  readonly historyTapeIds: readonly TapeId[];
  readonly structuralEffect: boolean;
  readonly receipt: ActionReceipt;
  readonly reservation: HistoryReservation;
}

interface TaskMarkerCompletion {
  readonly paragraphId: NodeId;
  readonly itemId: NodeId;
  readonly checked: boolean;
}

type PreparedAction = PreparedActionBase &
  (
    | {
        readonly kind: 'literal';
        readonly boundarySnapshots: ReadonlyMap<TapeId, string>;
        readonly snapshot: TouchedResourceSnapshot;
      }
    | {
        readonly kind: 'candidate';
        readonly candidate: Y.Doc;
        readonly candidateMutations: NativeMutationEvidence;
        readonly snapshot: TouchedResourceSnapshot;
      }
  );

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Reconstructible lookups over canonical resources; text indexes are revision scoped. */
function assertTextMutationOnly(
  evidence: NativeMutationEvidence,
  state: Y.Doc,
  changedTapeIds: ReadonlySet<TapeId>,
  boundarySnapshots: ReadonlyMap<TapeId, string>,
  indexes: CanonicalIndexes,
): void {
  assert(evidence.changedOtherTypes.size === 0, 'text update changed an unsupported shared type');
  assert(evidence.changedNodeCells.size === 0, 'text update changed node metadata');
  assert(evidence.changedNodeIds.size === 0, 'text update changed the node registry');
  assert(evidence.changedTapeRegistryIds.size === 0, 'text update changed the tape registry');
  assert(evidence.changedRevisionIds.size === 0, 'text update changed tape revisions');
  assert(evidence.changedMetaKeys.size === 0, 'text update changed canonical metadata');
  assert(evidence.changedWatermarkKeys.size === 0, 'text update changed session watermarks');
  assert(
    evidence.changedTapeIds.size === changedTapeIds.size &&
      [...evidence.changedTapeIds].every((id) => changedTapeIds.has(id)),
    'text update changed an unexpected tape',
  );
  const tapes = tapeMap(state);
  for (const tapeId of changedTapeIds) {
    const tape = tapes.get(tapeId);
    assert(tape, `text update references missing tape ${tapeId}`);
    const index = indexes.tape(tapeId);
    assertCanonicalTapeShape(index);
    assert(
      boundarySnapshots.get(tapeId) === markerIdentitySignature(index),
      `text update changed permanent marker identity or order on ${tapeId}`,
    );
    for (const part of index.parts) {
      assert(
        typeof part.insert === 'string' || boundaryIdFromInsert(part.insert) !== undefined,
        `text update added an unsupported embed to tape ${tapeId}`,
      );
    }
    assert(!index.hasFormatting, `text update added formatting to tape ${tapeId}`);
  }
}

interface TouchedResourceSnapshot {
  readonly nodeRecords: ReadonlyMap<NodeId, RecordMap | undefined>;
  readonly tapeRecords: ReadonlyMap<TapeId, Y.Text | undefined>;
}

function captureTouchedResources(
  state: Y.Doc,
  plan: LowLevelPlan,
  tapeIds: ReadonlySet<TapeId>,
): TouchedResourceSnapshot {
  const nodeIds = new Set([
    ...plan.writes.map(({ nodeId }) => nodeId),
    ...plan.allocations.map(({ id }) => id),
  ]);
  const nodes = nodeMap(state);
  const tapes = tapeMap(state);
  return {
    nodeRecords: new Map([...nodeIds].map((id) => [id, nodes.get(id)])),
    tapeRecords: new Map([...tapeIds].map((id) => [id, tapes.get(id)])),
  };
}

function captureHistoryTouchedResources(
  state: Y.Doc,
  entry: HistoryEntry,
): TouchedResourceSnapshot {
  const nodeIds = new Set([
    ...entry.structuralPatch.cells.map(({ nodeId }) => nodeId),
    ...entry.structuralPatch.childLists.map(({ nodeId }) => nodeId),
    ...entry.structuralPatch.births.map(({ nodeId }) => nodeId),
  ]);
  const tapeIds = new Set([
    ...entry.touchedTapeIds,
    ...entry.structuralPatch.bornTapes.map(({ tapeId }) => tapeId),
  ]);
  const nodes = nodeMap(state);
  const tapes = tapeMap(state);
  return {
    nodeRecords: new Map([...nodeIds].map((id) => [id, nodes.get(id)])),
    tapeRecords: new Map([...tapeIds].map((id) => [id, tapes.get(id)])),
  };
}

function assertHistoryMutationEvidence(
  state: Y.Doc,
  entry: HistoryEntry,
  snapshot: TouchedResourceSnapshot,
  mutations: NativeMutationEvidence,
  previousRevision: number,
  revision: number,
  changedTapeIds: readonly TapeId[],
): void {
  const equalSet = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean =>
    left.size === right.size && [...left].every((value) => right.has(value));
  const expectedCells = new Map<NodeId, Set<CellField>>();
  for (const patch of entry.structuralPatch.cells) {
    const fields = expectedCells.get(patch.nodeId) ?? new Set<CellField>();
    fields.add(patch.field);
    expectedCells.set(patch.nodeId, fields);
  }
  for (const patch of entry.structuralPatch.childLists) {
    const fields = expectedCells.get(patch.nodeId) ?? new Set<CellField>();
    fields.add('children');
    expectedCells.set(patch.nodeId, fields);
  }
  assert(
    equalSet(new Set(mutations.changedNodeCells.keys()), new Set(expectedCells.keys())),
    'history changed unexpected node cells',
  );
  for (const [id, fields] of expectedCells) {
    assert(
      equalSet(mutations.changedNodeCells.get(id) ?? new Set<CellField>(), fields),
      `history changed unexpected fields on node ${id}`,
    );
  }
  assert(mutations.changedNodeIds.size === 0, 'history changed the node registry');
  assert(mutations.changedTapeRegistryIds.size === 0, 'history changed the tape registry');
  assert(
    [...mutations.changedTapeIds].every((id) => entry.touchedTapeIds.includes(id)),
    'history changed a tape outside its touched-resource receipt',
  );
  assert(
    equalSet(mutations.changedRevisionIds, new Set(changedTapeIds)),
    'history wrote revisions outside its native text mutations',
  );
  const expectedMetaKeys = new Set(revision > previousRevision ? ['acceptedRevision'] : []);
  assert(
    equalSet(mutations.changedMetaKeys, expectedMetaKeys),
    'history changed unexpected canonical metadata',
  );
  assert(mutations.changedWatermarkKeys.size === 0, 'history changed session watermarks');
  for (const [id, prior] of snapshot.nodeRecords) {
    assert(prior && nodeMap(state).get(id) === prior, `history replaced node resource ${id}`);
  }
  for (const [id, prior] of snapshot.tapeRecords) {
    assert(prior && tapeMap(state).get(id) === prior, `history replaced tape resource ${id}`);
  }
}

function assertTouchedResourcesMatch(
  expected: Y.Doc,
  actual: Y.Doc,
  plan: LowLevelPlan,
  changedTapeIds: ReadonlySet<TapeId>,
  expectedMutations: NativeMutationEvidence,
  actualMutations: NativeMutationEvidence,
  snapshot: TouchedResourceSnapshot,
  epoch: string,
  sessionId: string,
  sequence: number,
): void {
  const equalSet = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean =>
    left.size === right.size && [...left].every((value) => right.has(value));
  const newNodeIds = new Set(plan.allocations.map(({ id }) => id));
  const newTapeIds = new Set(plan.newTapes.map(({ id }) => id));
  const writeFields = new Map<NodeId, Set<CellField>>();
  for (const write of plan.writes) {
    const fields = writeFields.get(write.nodeId) ?? new Set<CellField>();
    fields.add(write.field);
    writeFields.set(write.nodeId, fields);
  }
  const allChangedCellIds = new Set([
    ...expectedMutations.changedNodeCells.keys(),
    ...writeFields.keys(),
  ]);
  for (const id of allChangedCellIds) {
    if (newNodeIds.has(id)) continue;
    assert(
      equalSet(
        expectedMutations.changedNodeCells.get(id) ?? new Set<CellField>(),
        writeFields.get(id) ?? new Set<CellField>(),
      ),
      `staged action changed unexpected cells on node ${id}`,
    );
  }
  assert(
    equalSet(expectedMutations.changedTapeIds, actualMutations.changedTapeIds),
    'live native text mutations differ from the staged action',
  );
  assert(
    equalSet(expectedMutations.changedNodeIds, actualMutations.changedNodeIds) &&
      equalSet(expectedMutations.changedTapeRegistryIds, actualMutations.changedTapeRegistryIds),
    'live resource registry mutations differ from the staged action',
  );
  assert(
    equalSet(expectedMutations.changedRevisionIds, actualMutations.changedRevisionIds),
    'live tape revision writes differ from the staged action',
  );
  assert(
    equalSet(expectedMutations.changedMetaKeys, actualMutations.changedMetaKeys) &&
      equalSet(expectedMutations.changedWatermarkKeys, actualMutations.changedWatermarkKeys),
    'live protocol metadata writes differ from the staged action',
  );
  assert(
    equalSet(actualMutations.changedNodeIds, newNodeIds),
    'action changed an unexpected node key',
  );
  assert(
    equalSet(actualMutations.changedTapeRegistryIds, newTapeIds),
    'action changed an unexpected tape key',
  );
  assert(
    equalSet(actualMutations.changedRevisionIds, new Set(changedTapeIds)),
    'action assigned an unchanged tape revision or omitted a changed tape revision',
  );
  assert(
    actualMutations.changedMetaKeys.size === 1 &&
      actualMutations.changedMetaKeys.has('acceptedRevision'),
    'action changed unexpected canonical metadata',
  );
  const expectedWatermarkKey = sessionWatermarkKey(epoch, sessionId);
  assert(
    actualMutations.changedWatermarkKeys.size === 1 &&
      actualMutations.changedWatermarkKeys.has(expectedWatermarkKey),
    'action did not commit exactly its session watermark',
  );

  const expectedNodes = nodeMap(expected);
  const actualNodes = nodeMap(actual);
  for (const [id, prior] of snapshot.nodeRecords) {
    const live = actualNodes.get(id);
    assert(
      newNodeIds.has(id) ? prior === undefined && !!live : live === prior,
      `live action replaced or unexpectedly created node resource ${id}`,
    );
    const staged = expectedNodes.get(id);
    assert(staged && live, `action is missing touched node ${id}`);
    if (newNodeIds.has(id)) {
      assert(
        stableJson(staged.toJSON()) === stableJson(live.toJSON()),
        `new node ${id} differs from staged result`,
      );
      continue;
    }
    const stagedFields = expectedMutations.changedNodeCells.get(id) ?? new Set<CellField>();
    const liveFields = actualMutations.changedNodeCells.get(id) ?? new Set<CellField>();
    assert(
      equalSet(stagedFields, liveFields),
      `node ${id} cell mutations differ from staged result`,
    );
    for (const field of writeFields.get(id) ?? []) {
      const stagedCell = readCell(staged, field);
      const liveCell = readCell(live, field);
      assert(
        stableJson(stagedCell) === stableJson(liveCell),
        `node ${id} field ${field} differs from staged result`,
      );
    }
  }

  const expectedTapes = tapeMap(expected);
  const actualTapes = tapeMap(actual);
  for (const [id, prior] of snapshot.tapeRecords) {
    const staged = expectedTapes.get(id);
    const live = actualTapes.get(id);
    assert(
      newTapeIds.has(id) ? prior === undefined && !!live : live === prior,
      `live action replaced or unexpectedly created tape resource ${id}`,
    );
    assert(staged && live, `action is missing touched tape ${id}`);
    assert(
      stableJson(staged.toDelta()) === stableJson(live.toDelta()),
      `tape ${id} differs from staged text and boundary output`,
    );
    assert(
      revisionMap(actual).get(id) === revisionMap(expected).get(id),
      `tape ${id} revision differs from staged result`,
    );
  }
  for (const id of changedTapeIds) {
    assert(
      revisionMap(actual).get(id) === (metaMap(actual).get('acceptedRevision') as number),
      `changed tape ${id} does not carry the accepted revision`,
    );
  }
  const watermarkKey = sessionWatermarkKey(epoch, sessionId);
  assert(
    sessionWatermarkMap(actual).get(watermarkKey) === sequence &&
      sessionWatermarkMap(expected).get(watermarkKey) === sequence,
    'session watermark differs from the accepted sequence',
  );
}

function boundaryIdFromInsert(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('grainBoundary' in value)) return undefined;
  const boundaryId = (value as { readonly grainBoundary: unknown }).grainBoundary;
  return typeof boundaryId === 'string' ? boundaryId : undefined;
}

function markerIdentitySignature(index: NativeTapeIndex): string {
  return stableJson(index.boundaryItems.map(({ boundaryId, itemId }) => ({ boundaryId, itemId })));
}

function assertCanonicalTapeShape(index: NativeTapeIndex): void {
  const first = index.parts[0];
  const last = index.parts.at(-1);
  assert(
    first && boundaryIdFromInsert(first.insert),
    `tape ${index.tapeId} lacks a leading boundary`,
  );
  assert(
    last && boundaryIdFromInsert(last.insert),
    `tape ${index.tapeId} lacks a trailing boundary`,
  );
  assert(first.nativeFrom === 0, `tape ${index.tapeId} has text before its first boundary`);
  assert(last.nativeTo === index.length, `tape ${index.tapeId} has text after its last boundary`);
  const markerParts = index.parts.flatMap((part) => {
    const boundaryId = boundaryIdFromInsert(part.insert);
    return boundaryId === undefined ? [] : [{ boundaryId, index: part.nativeFrom }];
  });
  assert(
    stableJson(markerParts) ===
      stableJson(
        index.boundaryItems.map(({ boundaryId, index: position }) => ({
          boundaryId,
          index: position,
        })),
      ),
    `tape ${index.tapeId} has unresolved native boundary identities`,
  );
  assert(
    new Set(index.boundaryItems.map(({ boundaryId }) => boundaryId)).size ===
      index.boundaryItems.length,
    `tape ${index.tapeId} has duplicate boundary IDs`,
  );
  assert(
    new Set(index.boundaryItems.map(({ itemId }) => itemId)).size === index.boundaryItems.length,
    `tape ${index.tapeId} has duplicate native boundary items`,
  );
}

function assertTextOnlyUpdate(previous: Y.Doc, candidate: Y.Doc): void {
  assertRetainedResources(previous, candidate);
  assert(
    stableJson(metaMap(previous).toJSON()) === stableJson(metaMap(candidate).toJSON()),
    'text update changed canonical metadata',
  );
  assert(
    stableJson(revisionMap(previous).toJSON()) === stableJson(revisionMap(candidate).toJSON()),
    'text update changed tape revisions',
  );
  assert(
    stableJson(sessionWatermarkMap(previous).toJSON()) ===
      stableJson(sessionWatermarkMap(candidate).toJSON()),
    'text update changed committed session watermarks',
  );
  const previousNodes = nodeMap(previous);
  const candidateNodes = nodeMap(candidate);
  assert(
    stableJson([...previousNodes.keys()].sort()) === stableJson([...candidateNodes.keys()].sort()),
    'text update allocated or removed a node record',
  );
  for (const [id, record] of previousNodes.entries()) {
    const next = candidateNodes.get(id);
    assert(next, `text update removed node ${id}`);
    assert(
      stableJson(record.toJSON()) === stableJson(next.toJSON()),
      `text update changed node ${id}`,
    );
  }
  const previousTapes = tapeMap(previous);
  const candidateTapes = tapeMap(candidate);
  assert(
    stableJson([...previousTapes.keys()].sort()) === stableJson([...candidateTapes.keys()].sort()),
    'text update allocated or removed a tape',
  );
  for (const [id, tape] of previousTapes.entries()) {
    const next = candidateTapes.get(id);
    assert(next, `text update removed tape ${id}`);
    const previousIndex = indexNativeTape(id, tape);
    const nextIndex = indexNativeTape(id, next);
    assertCanonicalTapeShape(previousIndex);
    assertCanonicalTapeShape(nextIndex);
    assert(
      markerIdentitySignature(previousIndex) === markerIdentitySignature(nextIndex),
      `text update changed boundary marker identity or order on ${id}`,
    );
    for (const part of nextIndex.parts) {
      assert(
        typeof part.insert === 'string' || boundaryIdFromInsert(part.insert) !== undefined,
        `text update added an unsupported embed to tape ${id}`,
      );
    }
    assert(!nextIndex.hasFormatting, `text update added formatting to tape ${id}`);
  }
}

function validateCandidate(previous: Y.Doc, candidate: Y.Doc, revision: number): void {
  assertRetainedResources(previous, candidate);
  assertTapeRevisions(previous, candidate, revision);
  const validation = validateCanonicalState(candidate);
  assert(
    validation.valid,
    `action plan failed canonical validation: ${validation.errors.join('; ')}`,
  );
}

function currentPrecondition(state: Y.Doc, precondition: ReadPrecondition): boolean {
  if (precondition.kind === 'tape') {
    return revisionMap(state).get(precondition.tapeId) === precondition.revision;
  }
  const record = nodeMap(state).get(precondition.nodeId);
  if (!record) return false;
  try {
    return readCell(record, precondition.field).token === precondition.token;
  } catch {
    return false;
  }
}

const activeWriters = new WeakMap<CanonicalDocument, CanonicalWriter>();

interface PendingRecord {
  readonly publicValue: PendingCommit;
  readonly context: AdmittedContext;
  readonly request: ActionRequest;
  readonly requestHash: string;
  readonly reservation: HistoryReservation;
}

function projectionNodeIds(
  indexes: CanonicalIndexes,
  touchedNodeIds: readonly NodeId[],
  touchedTapeIds: readonly TapeId[],
  patch: StructuralPatch,
): NodeId[] {
  const affected = new Set(touchedNodeIds);
  for (const tapeId of touchedTapeIds) {
    for (const nodeId of indexes.activeTapeOwners.get(tapeId) ?? []) affected.add(nodeId);
  }
  const addChildren = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const id of value) if (typeof id === 'string') affected.add(id);
    }
  };
  for (const cell of patch.cells) {
    affected.add(cell.nodeId);
    if (cell.field === 'children') {
      addChildren(cell.before.value);
      addChildren(cell.after.value);
    }
  }
  for (const childList of patch.childLists) {
    affected.add(childList.nodeId);
    for (const splice of childList.splices) {
      addChildren(splice.removedIds);
      addChildren(splice.insertedIds);
    }
  }
  for (const birth of patch.births) {
    affected.add(birth.nodeId);
    addChildren(birth.cells.children.value);
  }
  return [...affected];
}

interface QueuedLocalEdit {
  readonly callback: () => void;
}

function markerSummary(state: Y.Doc): Map<TapeId, string> {
  return new Map([...tapeMap(state).entries()].map(([id, tape]) => [id, boundarySignature(tape)]));
}

/**
 * Synchronous action planner and per-session text-history coordinator for one
 * canonical document. Command closures are consumed only while preparing; an
 * ActionRequest contains semantic operations and read guards, never a closure.
 */
export class CanonicalWriter {
  private readonly state: Y.Doc;
  private readonly access: ReturnType<typeof canonicalWriterAccess>;
  private readonly unsubscribeAcceptedUpdates: () => void;
  private readonly indexes: CanonicalIndexes;
  private readonly historyCapture: NativeTextHistoryCapture;
  private readonly history: CanonicalHistoryCoordinator;
  private readonly replicas: CanonicalReplicas;
  private readonly sessionSequences = new Map<string, number>();
  private readonly acceptedRequests = new Map<string, CachedActionResponse>();
  private readonly listeners = new Set<WriterListener>();
  private readonly localQueue: QueuedLocalEdit[] = [];
  private readonly verifyWithFullClone: boolean;
  private fullStateCloneCount = 0;
  private literalTextInputCount = 0;
  private acceptedResponseBytes = 0;
  private historyResetPending: boolean;
  private preparing = false;
  private publishing = false;
  private poisoned = false;
  private closed = false;
  private pending?: PendingRecord;
  private pendingHistory?: PendingHistoryRecord;

  constructor(
    private readonly document: CanonicalDocument,
    options: WriterOptions = {},
  ) {
    this.access = canonicalWriterAccess(document);
    this.historyResetPending = this.access.historyWasReset();
    assert(!activeWriters.has(document), 'canonical document already has an active writer');
    this.state = this.access.state;
    this.indexes = new CanonicalIndexes(this.state);
    this.historyCapture = new RoutedNativeTextHistoryCapture(this.state);
    this.replicas = new CanonicalReplicas(this.state, this.indexes, () => this.cloneState());
    const maxHistoryGroups = options.maxHistoryGroups ?? 500;
    this.verifyWithFullClone = options.verifyWithFullClone ?? false;
    assert(
      Number.isSafeInteger(maxHistoryGroups) && maxHistoryGroups > 0,
      'history limit must be a positive integer',
    );
    this.history = new CanonicalHistoryCoordinator(
      this.state,
      this.historyCapture,
      maxHistoryGroups,
    );
    activeWriters.set(document, this);
    this.unsubscribeAcceptedUpdates = this.access.observeAcceptedUpdates(
      (update, changedTapeIds, structuralEffect) =>
        this.onExternallyAcceptedUpdate(update, changedTapeIds, structuralEffect),
    );
    this.admitSession('local');
  }

  get poisonedWriter(): boolean {
    return this.poisoned;
  }

  /** @internal Operation counts used by deterministic M2 locality controls. */
  get operationCounts(): WriterOperationCounts {
    return Object.freeze({
      fullStateClones: this.fullStateCloneCount,
      authorReplicaCreations: this.replicas.authorReplicaCreations,
      validationReplicaCreations: this.replicas.validationReplicaCreations,
      literalTextInputs: this.literalTextInputCount,
    });
  }

  private cloneState(): Y.Doc {
    this.fullStateCloneCount++;
    return cloneDocument(this.state);
  }

  private onExternallyAcceptedUpdate(
    update: Uint8Array,
    changedTapeIds: readonly TapeId[],
    structuralEffect: boolean,
  ): void {
    try {
      this.replicas.onExternallyAcceptedUpdate(update, changedTapeIds, structuralEffect);
    } catch (error) {
      this.poisoned = true;
      this.access.poison();
      throw error;
    }
  }

  close(): void {
    assert(
      !this.pending && !this.pendingHistory,
      'cannot close a writer with an unpublished commit',
    );
    if (this.closed) return;
    this.unsubscribeAcceptedUpdates();
    this.history.close();
    this.sessionSequences.clear();
    this.replicas.close();
    this.acceptedRequests.clear();
    this.acceptedResponseBytes = 0;
    this.listeners.clear();
    this.localQueue.length = 0;
    this.historyCapture.close();
    this.closed = true;
    activeWriters.delete(this.document);
  }

  subscribe(listener: WriterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Defers a local host edit until the current publication has finished. */
  deferLocalEdit(callback: () => void): boolean {
    if (!this.publishing) return false;
    this.localQueue.push({ callback });
    return true;
  }

  /** Host admission is explicit for requests received from another session. */
  admitSession(sessionId: string): void {
    assert(!this.closed, 'canonical writer is closed');
    assert(sessionId.length > 0, 'session ID cannot be empty');
    if (this.history.hasSession(sessionId)) return;
    const epoch = metaMap(this.state).get('authorityEpoch') as string;
    const watermark =
      sessionWatermarkMap(this.state).get(sessionWatermarkKey(epoch, sessionId)) ?? 0;
    assert(
      Number.isSafeInteger(watermark) && watermark >= 0,
      'stored session watermark is invalid',
    );
    this.sessionSequences.set(sessionId, watermark);
    this.history.admit(sessionId);
  }

  prepareCommand(options: ActionOptions, callback: DraftCommand): ActionRequest {
    this.assertCanPrepare();
    assert(options.actionId.length > 0, 'action ID cannot be empty');
    const sessionId = options.sessionId ?? 'local';
    assert(
      !this.replicas.hasPendingAuthor(sessionId),
      `session ${sessionId} already has an outstanding action`,
    );
    const historyGroupId = options.historyGroupId ?? options.actionId;
    assert(
      sessionId.length > 0 && historyGroupId.length > 0,
      'session and history group IDs cannot be empty',
    );
    const sessionSequence = options.sessionSequence ?? this.nextSequence(sessionId);
    const identity = actionIdentity(
      metaMap(this.state).get('documentId') as string,
      metaMap(this.state).get('authorityEpoch') as string,
      sessionId,
      sessionSequence,
    );
    const draft = new MutableTreeDraft(this.state, identity, this.indexes);
    this.preparing = true;
    try {
      const result = callback(draft);
      if (
        result !== undefined &&
        result !== null &&
        typeof (result as PromiseLike<unknown>).then === 'function'
      ) {
        draft.close();
        throw new TypeError('TreeDraft callbacks must be synchronous');
      }
      const focus = copyActionFocus(result);
      const operations = draft.operationList;
      if (
        operations.some(
          (operation) =>
            operation.type === 'create' ||
            operation.type === 'place' ||
            operation.type === 'detach' ||
            operation.type === 'cutInline' ||
            operation.type === 'insertFragment' ||
            operation.type === 'transferInlineRange' ||
            operation.type === 'convertInline' ||
            operation.type === 'setMarker' ||
            operation.type === 'setChecked',
        )
      ) {
        normalizeCanonicalDraft(draft, metaMap(this.state).get('rootId') as NodeId);
      }
      return copyRequest({
        mode: 'command',
        documentId: metaMap(this.state).get('documentId') as string,
        authorityEpoch: metaMap(this.state).get('authorityEpoch') as string,
        sessionId,
        sessionSequence,
        actionId: options.actionId,
        baseRevision: metaMap(this.state).get('acceptedRevision') as number,
        historyGroupId,
        preconditions: draft.readSet,
        operations: draft.operationList,
        ...(focus ? { focus } : {}),
      } as ActionRequest);
    } finally {
      draft.close();
      this.preparing = false;
    }
  }

  prepareTextInput(nodeId: NodeId, edit: TextEdit, options: ActionOptions): ActionRequest {
    this.assertCanPrepare();
    const sessionId = options.sessionId ?? 'local';
    const historyGroupId = options.historyGroupId ?? options.actionId;
    assert(
      options.actionId.length > 0 && sessionId.length > 0 && historyGroupId.length > 0,
      'action, session and history group IDs cannot be empty',
    );
    const sessionSequence = options.sessionSequence ?? this.nextSequence(sessionId);
    assert(
      !this.replicas.hasPendingAuthor(sessionId),
      `session ${sessionId} already has an outstanding action`,
    );
    const documentId = metaMap(this.state).get('documentId') as string;
    const authorityEpoch = metaMap(this.state).get('authorityEpoch') as string;
    const identity = actionIdentity(documentId, authorityEpoch, sessionId, sessionSequence);
    const record = nodeMap(this.state).get(nodeId);
    assert(record, `unknown node ${nodeId}`);
    const kind = readCell<NodeKind>(record, 'kind');
    assert(INLINE_KINDS.has(kind.value), `${kind.value} nodes do not accept text input`);
    assert(this.indexes.isActive(nodeId), `hidden target ${nodeId}`);
    const spans = readCell<readonly Span[]>(record, 'spans');
    const mapped = this.indexes.mapTextEdit(nodeId, spans.value, edit);
    const branch = this.replicas.authorReplica(sessionId);
    const authoredUpdates: Uint8Array[] = [];
    const captureAuthoredUpdate = (update: Uint8Array) =>
      authoredUpdates.push(Uint8Array.from(update));
    branch.on('update', captureAuthoredUpdate);
    try {
      applyMappedTextEdit(branch, mapped, edit.insert, Object.freeze({ actionIdentity: identity }));
      const textUpdate = authoredUpdates.length
        ? Y.mergeUpdates(authoredUpdates)
        : new Uint8Array();
      const request: ActionRequest = {
        mode: 'text-input',
        documentId,
        authorityEpoch,
        sessionId,
        sessionSequence,
        actionId: options.actionId,
        baseRevision: metaMap(this.state).get('acceptedRevision') as number,
        historyGroupId,
        preconditions: [],
        textUpdate: Uint8Array.from(textUpdate),
        operations: [],
        ...(options.focus ? { focus: copyActionFocus(options.focus) } : {}),
        promotionTarget: Object.freeze({ nodeId, kindToken: kind.token, spansToken: spans.token }),
      } as ActionRequest;
      this.replicas.markAuthorPending(sessionId, options.actionId);
      return copyRequest(request);
    } catch (error) {
      this.replicas.discardAuthorReplica(sessionId);
      throw error;
    } finally {
      branch.off('update', captureAuthoredUpdate);
    }
  }

  private stageTextInput(request: ActionRequest):
    | { readonly kind: 'invalid' }
    | {
        readonly kind: 'literal';
        readonly changedTapeIds: ReadonlySet<TapeId>;
        readonly boundarySnapshots: ReadonlyMap<TapeId, string>;
      }
    | { readonly kind: 'conversion'; readonly plan: ParserConversionPlan }
    | { readonly kind: 'task-marker'; readonly completion: TaskMarkerCompletion }
    | { readonly kind: 'slow' } {
    const validation = this.replicas.ensureValidation();
    const target = request.promotionTarget;
    const targetRecord = target ? nodeMap(this.state).get(target.nodeId) : undefined;
    const kindCell = targetRecord ? readCell<NodeKind>(targetRecord, 'kind') : undefined;
    const spansCell = targetRecord ? readCell<readonly Span[]>(targetRecord, 'spans') : undefined;
    const targetMatches =
      !!target &&
      !!kindCell &&
      !!spansCell &&
      kindCell.token === target.kindToken &&
      spansCell.token === target.spansToken;
    const allowedTapeIds = new Set((spansCell?.value ?? []).map((span) => span.tapeId));
    const boundarySnapshots = new Map<TapeId, string>();
    for (const tapeId of allowedTapeIds) {
      const liveIndex = this.indexes.tape(tapeId);
      const stagedIndex = validation.indexes.tape(tapeId);
      assertCanonicalTapeShape(liveIndex);
      assertCanonicalTapeShape(stagedIndex);
      const snapshot = markerIdentitySignature(liveIndex);
      assert(
        snapshot === markerIdentitySignature(stagedIndex),
        `validation replica has different boundary identities on ${tapeId}`,
      );
      boundarySnapshots.set(tapeId, snapshot);
    }

    const evidence = trackNativeMutations(
      validation.state,
      targetMatches ? { tapeIds: allowedTapeIds } : undefined,
    );
    try {
      if (request.textUpdate?.length) {
        Y.applyUpdate(validation.state, Uint8Array.from(request.textUpdate));
      }
      assertResolvedUpdate(validation.state);
      const changedTapeIds = new Set(evidence.changedTapeIds);
      if (targetMatches) {
        assert(
          [...changedTapeIds].every((tapeId) => allowedTapeIds.has(tapeId)),
          'text input updated a tape outside its target spans',
        );
        validation.indexes.refreshText(changedTapeIds);
        assertTextMutationOnly(
          evidence,
          validation.state,
          changedTapeIds,
          boundarySnapshots,
          validation.indexes,
        );
        if (
          request.textUpdate?.length &&
          this.indexes.isActive(target!.nodeId) &&
          kindCell!.value === 'paragraph'
        ) {
          const content = validation.indexes.content(target!.nodeId);
          const checked = content.startsWith('[ ] ')
            ? false
            : content.startsWith('[x] ')
              ? true
              : undefined;
          if (checked !== undefined) {
            const itemId = this.indexes.parent(target!.nodeId);
            const itemRecord = itemId ? nodeMap(this.state).get(itemId) : undefined;
            if (
              itemId &&
              itemRecord &&
              this.indexes.isActive(itemId) &&
              readCell<NodeKind>(itemRecord, 'kind').value === 'list-item' &&
              readCell<boolean | null>(itemRecord, 'checked').value === null &&
              readCell<readonly NodeId[]>(itemRecord, 'children').value[0] === target!.nodeId
            ) {
              evidence.close();
              return {
                kind: 'task-marker',
                completion: { paragraphId: target!.nodeId, itemId, checked },
              };
            }
          }
          const classification = classifyInlineInput(content);
          if (classification.kind === 'conversion') {
            evidence.close();
            return { kind: 'conversion', plan: classification.plan };
          }
        }
        evidence.close();
        return { kind: 'literal', changedTapeIds, boundarySnapshots };
      }
      evidence.close();
      return { kind: 'slow' };
    } catch {
      evidence.close();
      this.replicas.discardValidationReplica();
      return { kind: 'invalid' };
    }
  }

  /** Commit a fully admitted and prepared action through one publication boundary. */
  private commitPreparedAction(prepared: PreparedAction): ApplyResult {
    const {
      request,
      context,
      requestHash,
      nextRevision,
      plan,
      structuralPatch,
      changedTapeIds,
      structuralEffect,
      receipt,
      reservation,
    } = prepared;
    const literal = prepared.kind === 'literal';
    const liveBefore = this.verifyWithFullClone ? this.cloneState() : undefined;
    const liveMutations = trackNativeMutations(
      this.state,
      literal ? { tapeIds: changedTapeIds } : undefined,
    );
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(Uint8Array.from(update));
    this.history.activate(reservation);
    this.access.beginPending();
    this.state.on('update', collect);
    try {
      if (request.textUpdate?.length) {
        Y.applyUpdate(this.state, Uint8Array.from(request.textUpdate), reservation.entry.origin);
      }
      applyPlan(this.state, plan, reservation.entry.origin, nextRevision, liveMutations, () =>
        this.history.addTapesToScope(reservation.entry, prepared.historyTapeIds),
      );
      this.state.transact(
        () =>
          sessionWatermarkMap(this.state).set(
            sessionWatermarkKey(request.authorityEpoch, request.sessionId),
            request.sessionSequence,
          ),
        'grain:session-watermark',
      );

      if (literal) {
        const validation = this.replicas.ensureValidation();
        this.indexes.refreshText(changedTapeIds);
        assert(
          liveMutations.changedOtherTypes.size === 0,
          'literal input changed an unsupported shared type',
        );
        assert(liveMutations.changedNodeCells.size === 0, 'literal input changed node metadata');
        assert(liveMutations.changedNodeIds.size === 0, 'literal input changed the node registry');
        assert(
          liveMutations.changedTapeRegistryIds.size === 0,
          'literal input changed the tape registry',
        );
        assert(
          liveMutations.changedTapeIds.size === changedTapeIds.size &&
            [...liveMutations.changedTapeIds].every((tapeId) => changedTapeIds.has(tapeId)),
          'literal input changed an unexpected tape',
        );
        assert(
          liveMutations.changedRevisionIds.size === changedTapeIds.size &&
            [...liveMutations.changedRevisionIds].every((tapeId) => changedTapeIds.has(tapeId)),
          'literal input revised tapes outside its native text changes',
        );
        assert(
          liveMutations.changedMetaKeys.size === 1 &&
            liveMutations.changedMetaKeys.has('acceptedRevision'),
          'literal input changed unexpected canonical metadata',
        );
        assert(
          liveMutations.changedWatermarkKeys.size === 1 &&
            liveMutations.changedWatermarkKeys.has(
              sessionWatermarkKey(request.authorityEpoch, request.sessionId),
            ),
          'literal input changed unexpected session watermarks',
        );
        const liveTapes = tapeMap(this.state);
        const validationTapes = tapeMap(validation.state);
        for (const [tapeId, prior] of prepared.snapshot.tapeRecords) {
          const live = liveTapes.get(tapeId);
          const staged = validationTapes.get(tapeId);
          assert(live && staged, `literal input is missing tape ${tapeId}`);
          assert(live === prior, `literal input replaced tape resource ${tapeId}`);
          const liveIndex = this.indexes.tape(tapeId);
          const stagedIndex = validation.indexes.tape(tapeId);
          assertCanonicalTapeShape(liveIndex);
          assertCanonicalTapeShape(stagedIndex);
          assert(
            prepared.boundarySnapshots.get(tapeId) === markerIdentitySignature(liveIndex) &&
              prepared.boundarySnapshots.get(tapeId) === markerIdentitySignature(stagedIndex),
            `literal input changed permanent marker identity or order on tape ${tapeId}`,
          );
          assert(
            stableJson(liveIndex.parts) === stableJson(stagedIndex.parts),
            `literal input differs from its staged text on tape ${tapeId}: ` +
              `${stableJson(liveIndex.parts)} !== ${stableJson(stagedIndex.parts)}`,
          );
          assert(
            revisionMap(this.state).get(tapeId) ===
              (changedTapeIds.has(tapeId)
                ? nextRevision
                : revisionMap(validation.state).get(tapeId)),
            `literal input has an unexpected tape revision for ${tapeId}`,
          );
        }
        assert(
          metaMap(this.state).get('acceptedRevision') === nextRevision &&
            sessionWatermarkMap(this.state).get(
              sessionWatermarkKey(request.authorityEpoch, request.sessionId),
            ) === request.sessionSequence,
          'literal input did not commit its accepted revision and watermark',
        );
      } else {
        assertTouchedResourcesMatch(
          prepared.candidate,
          this.state,
          plan,
          changedTapeIds,
          prepared.candidateMutations,
          liveMutations,
          prepared.snapshot,
          request.authorityEpoch,
          request.sessionId,
          request.sessionSequence,
        );
        const liveValidation = validateCanonicalState(this.state);
        assert(
          liveValidation.valid,
          `live action failed canonical validation: ${liveValidation.errors.join('; ')}`,
        );
      }
      if (liveBefore) validateCandidate(liveBefore, this.state, nextRevision);

      const livePatch = structuralPatchWithLiveIdentities(structuralPatch, this.state);
      reservation.entry.structuralPatch = livePatch;
      const acceptedReceipt: ActionReceipt = Object.freeze({
        ...receipt,
        structuralPatch: livePatch,
      });
      this.state.off('update', collect);
      liveMutations.close();
      if (!literal) prepared.candidateMutations.close();
      liveBefore?.destroy();
      const update = Y.mergeUpdates(updates);
      this.replicas.syncAcceptedValidation(
        update,
        changedTapeIds,
        structuralEffect,
        nextRevision,
        literal,
      );
      if (structuralEffect) this.indexes.rebuild();
      else if (!literal) this.indexes.refreshText(changedTapeIds);
      const pending: PendingCommit = Object.freeze({
        actionId: request.actionId,
        revision: nextRevision,
        update,
        receipt: acceptedReceipt,
      });
      this.pending = { publicValue: pending, context, request, requestHash, reservation };
      if (!literal) prepared.candidate.destroy();
      return { status: 'pending', pending };
    } catch (error) {
      this.state.off('update', collect);
      liveMutations.close();
      if (!literal) {
        prepared.candidateMutations.close();
        prepared.candidate.destroy();
      }
      liveBefore?.destroy();
      this.replicas.discardValidationReplica();
      this.replicas.discardAuthorReplica(request.sessionId);
      this.history.cancel(reservation);
      this.poisoned = true;
      this.access.poison();
      throw new Error(
        `unexpected failure after canonical writes; writer is poisoned: ${String(error)}`,
      );
    } finally {
      this.state.off('update', collect);
    }
  }

  private prepareLiteralTextInput(
    request: ActionRequest,
    admittedContext: AdmittedContext,
    hash: string,
    changedTapeIds: ReadonlySet<TapeId>,
    boundarySnapshots: ReadonlyMap<TapeId, string>,
  ): PreparedAction {
    this.literalTextInputCount++;
    const revision = metaMap(this.state).get('acceptedRevision') as number;
    const nextRevision = revision + 1;
    const target = request.promotionTarget;
    const promotionSkipped =
      target &&
      (!this.indexes.isActive(target.nodeId) ||
        nodeCell(this.state, target.nodeId, 'kind').token !== target.kindToken ||
        nodeCell(this.state, target.nodeId, 'spans').token !== target.spansToken)
        ? 'ownershipChanged'
        : undefined;
    const noEffect = changedTapeIds.size === 0;
    const receipt: ActionReceipt = Object.freeze({
      requestId: actionIdentity(
        request.documentId,
        request.authorityEpoch,
        request.sessionId,
        request.sessionSequence,
      ),
      historyGroupId: request.historyGroupId,
      touchedNodeIds: Object.freeze(target ? [target.nodeId] : []),
      touchedTapeIds: Object.freeze([...changedTapeIds]),
      structuralPatch: EMPTY_STRUCTURAL_PATCH,
      ...(request.focus ? { focus: request.focus } : {}),
      noEffect,
      ...(promotionSkipped ? { promotionSkipped } : {}),
    });
    const validation = this.replicas.ensureValidation();
    const focusAnchors: ActionFocusAnchors | undefined = receipt.focus
      ? Object.freeze({
          ...(receipt.focus.start
            ? {
                start: createCanonicalTextAnchorFromIndexes(
                  this.state,
                  receipt.focus.start,
                  this.indexes,
                ),
              }
            : {}),
          ...(receipt.focus.end
            ? {
                end: createCanonicalTextAnchorFromIndexes(
                  validation.state,
                  receipt.focus.end,
                  validation.indexes,
                ),
              }
            : {}),
        })
      : undefined;
    const selectionAnchors = receipt.focus?.selection
      ? Object.freeze({
          anchor: createCanonicalTextAnchorFromIndexes(
            this.state,
            receipt.focus.selection.anchor,
            this.indexes,
          ),
          focus: createCanonicalTextAnchorFromIndexes(
            this.state,
            receipt.focus.selection.focus,
            this.indexes,
          ),
          ...(receipt.focus.selection.kind ? { kind: receipt.focus.selection.kind } : {}),
        })
      : undefined;
    const snapshot = captureTouchedResources(this.state, EMPTY_PLAN, changedTapeIds);
    const reservation = this.history.reserve(
      request.sessionId,
      request.historyGroupId,
      noEffect,
      false,
      [...changedTapeIds],
      receipt,
      EMPTY_STRUCTURAL_PATCH,
      focusAnchors,
      selectionAnchors,
    );
    return {
      kind: 'literal',
      request,
      context: Object.freeze({ ...admittedContext }),
      requestHash: hash,
      revision,
      nextRevision,
      plan: EMPTY_PLAN,
      structuralPatch: EMPTY_STRUCTURAL_PATCH,
      changedTapeIds,
      historyTapeIds: [...changedTapeIds],
      structuralEffect: false,
      receipt,
      reservation,
      boundarySnapshots,
      snapshot,
    };
  }

  apply(requestInput: ActionRequest, admittedContext: AdmittedContext): ApplyResult {
    if (this.closed) {
      this.replicas.rejectPreparedAuthor(requestInput);
      return { status: 'rejected', reason: 'closed-writer' };
    }
    if (this.poisoned) {
      this.replicas.rejectPreparedAuthor(requestInput);
      return { status: 'rejected', reason: 'poisoned-writer' };
    }
    if (this.pending || this.pendingHistory)
      return { status: 'rejected', reason: 'pending-commit' };
    if (this.preparing || this.publishing)
      return { status: 'rejected', reason: 'publication-order' };
    let request: ActionRequest;
    try {
      request = copyRequest(requestInput);
      this.validateRequestShape(request);
    } catch {
      this.replicas.rejectPreparedAuthor(requestInput);
      return { status: 'rejected', reason: 'invalid-request' };
    }
    const reject = (reason: RejectionReason): ApplyResult => {
      this.replicas.rejectPreparedAuthor(request);
      return { status: 'rejected', reason };
    };
    const sessionId = admittedContext.sessionId;
    if (!sessionId) return reject('wrong-session');
    if (request.sessionId !== sessionId) return reject('wrong-session');
    if (admittedContext.sessionSequence !== request.sessionSequence)
      return reject('wrong-sequence');
    if (request.documentId !== (metaMap(this.state).get('documentId') as string)) {
      return reject('wrong-document');
    }
    const epoch = metaMap(this.state).get('authorityEpoch') as string;
    if (request.authorityEpoch !== epoch || admittedContext.authorityEpoch !== epoch) {
      return reject('wrong-authority-epoch');
    }
    const key = actionIdentity(
      request.documentId,
      request.authorityEpoch,
      request.sessionId,
      request.sessionSequence,
    );
    const hash = requestHash(request);
    const sessionSequence = this.sessionSequences.get(sessionId);
    if (sessionSequence === undefined) return reject('wrong-session');
    if (request.sessionSequence <= sessionSequence) {
      const prior = this.acceptedRequests.get(key);
      if (!prior) return reject('receipt-expired/resync-required');
      return prior.hash === hash
        ? { status: 'duplicate', accepted: copyAcceptedAction(prior.accepted) }
        : reject('retry-payload-conflict');
    }
    if (request.sessionSequence !== sessionSequence + 1) return reject('wrong-sequence');
    const revision = metaMap(this.state).get('acceptedRevision') as number;
    if (request.baseRevision > revision) return reject('future-base-revision');
    if (
      !request.preconditions.every((precondition) => currentPrecondition(this.state, precondition))
    ) {
      return reject('stale-precondition');
    }

    let candidate: Y.Doc | undefined;
    let candidateMutations: NativeMutationEvidence | undefined;
    let reservation: HistoryReservation | undefined;
    try {
      let stagedPromotion: ParserConversionPlan | undefined;
      let stagedTaskMarkerCompletion: TaskMarkerCompletion | undefined;
      if (request.mode === 'text-input') {
        const staged = this.stageTextInput(request);
        if (staged.kind === 'invalid') return reject('invalid-text-update');
        if (staged.kind === 'literal') {
          const prepared = this.prepareLiteralTextInput(
            request,
            admittedContext,
            hash,
            staged.changedTapeIds,
            staged.boundarySnapshots,
          );
          reservation = prepared.reservation;
          return this.commitPreparedAction(prepared);
        }
        if (staged.kind === 'conversion') stagedPromotion = staged.plan;
        if (staged.kind === 'task-marker') stagedTaskMarkerCompletion = staged.completion;
      }

      candidate = this.cloneState();
      const candidateState = candidate;
      candidateMutations = trackNativeMutations(candidate);
      const inputChanged = candidateMutations.changedTapeIds;
      const nextRevision = revision + 1;
      try {
        if (request.textUpdate?.length) {
          Y.applyUpdate(candidate, Uint8Array.from(request.textUpdate));
          assertResolvedUpdate(candidate);
          assertTextOnlyUpdate(this.state, candidate);
        }
      } catch {
        candidateMutations.close();
        candidate.destroy();
        candidateMutations = undefined;
        candidate = undefined;
        this.replicas.discardValidationReplica();
        return reject('invalid-text-update');
      }

      const candidateIndexes = new CanonicalIndexes(candidate);
      let draft: MutableTreeDraft | undefined;
      let plan: LowLevelPlan;
      let receiptFocus = request.focus;
      const taskMarkerCompletion = stagedTaskMarkerCompletion;
      try {
        draft = new MutableTreeDraft(
          candidate,
          actionIdentity(
            request.documentId,
            request.authorityEpoch,
            sessionId,
            request.sessionSequence,
          ),
          candidateIndexes,
          request.operations,
        );
        const promotion = request.promotionTarget;
        if (
          request.mode === 'text-input' &&
          request.textUpdate?.length &&
          promotion &&
          this.indexes.isActive(promotion.nodeId) &&
          nodeCell(this.state, promotion.nodeId, 'kind').token === promotion.kindToken &&
          nodeCell(this.state, promotion.nodeId, 'spans').token === promotion.spansToken
        ) {
          const sourceNode = draft.node(promotion.nodeId);
          if (sourceNode.type === 'paragraph' && sourceNode.content !== undefined) {
            if (taskMarkerCompletion?.paragraphId === promotion.nodeId) {
              draft.setChecked(taskMarkerCompletion.itemId, taskMarkerCompletion.checked);
              draft.spliceText(promotion.nodeId, { from: 0, to: 4, insert: '' });
              const end = receiptFocus?.end;
              if (end?.nodeId === promotion.nodeId) {
                receiptFocus = copyActionFocus({
                  ...receiptFocus,
                  end: Object.freeze({
                    ...end,
                    offset: Math.max(0, end.offset - 4),
                  }),
                });
              }
              normalizeCanonicalDraft(draft, metaMap(candidate).get('rootId') as NodeId);
            } else {
              const parsed = stagedPromotion
                ? { provenance: stagedPromotion }
                : parseBlocks(sourceNode.content, { provenance: true });
              let mapSourceBookmark: ((bookmark: Bookmark) => Bookmark) | undefined;
              if (
                applyParserConversion(
                  draft,
                  metaMap(candidate).get('rootId') as NodeId,
                  promotion.nodeId,
                  sourceNode.content,
                  parsed.provenance,
                  (mapper) => {
                    mapSourceBookmark = mapper;
                  },
                )
              ) {
                const end = receiptFocus?.end;
                if (end?.nodeId === promotion.nodeId && mapSourceBookmark) {
                  receiptFocus = copyActionFocus({
                    ...receiptFocus,
                    end: mapSourceBookmark(end),
                  });
                }
                normalizeCanonicalDraft(draft, metaMap(candidate).get('rootId') as NodeId);
              }
            }
          }
        }
        plan = draft.compilePlan();
        applyPlan(
          candidate,
          plan,
          Object.freeze({ stagedAction: request.actionId }),
          nextRevision,
          candidateMutations,
        );
        candidate.transact(
          () =>
            sessionWatermarkMap(candidateState).set(
              sessionWatermarkKey(epoch, sessionId),
              request.sessionSequence,
            ),
          'grain:session-watermark',
        );
        draft.assertMatches(candidate);
        draft.close();
        validateCandidate(this.state, candidate, nextRevision);
        candidateIndexes.rebuild();
      } catch (_error) {
        draft?.close();
        candidateMutations.close();
        candidate.destroy();
        candidateMutations = undefined;
        candidate = undefined;
        this.replicas.discardValidationReplica();
        return reject('invalid-operation');
      }

      const structuralPatch = structuralPatchBetween(this.state, candidate, plan);
      const finalChangedTapes = new Set([
        ...candidateMutations.changedTapeIds,
        ...plan.newTapes.map(({ id }) => id),
      ]);
      const textTapes = new Set([...inputChanged, ...plan.textTapes]);
      const structuralEffect =
        structuralPatch.cells.length > 0 ||
        structuralPatch.childLists.length > 0 ||
        structuralPatch.births.length > 0;
      const noEffect =
        !finalChangedTapes.size &&
        !structuralEffect &&
        !plan.deletions.length &&
        !plan.insertions.length;
      const target = request.promotionTarget;
      const promotionSkipped =
        target &&
        (!this.indexes.isActive(target.nodeId) ||
          nodeCell(this.state, target.nodeId, 'kind').token !== target.kindToken ||
          nodeCell(this.state, target.nodeId, 'spans').token !== target.spansToken)
          ? 'ownershipChanged'
          : undefined;
      const receipt: ActionReceipt = Object.freeze({
        requestId: actionIdentity(
          request.documentId,
          request.authorityEpoch,
          request.sessionId,
          request.sessionSequence,
        ),
        historyGroupId: request.historyGroupId,
        touchedNodeIds: Object.freeze([
          ...new Set([
            ...plan.touchedNodes,
            ...structuralPatch.visibility.map((item) => item.nodeId),
            ...(target ? [target.nodeId] : []),
          ]),
        ]),
        touchedTapeIds: Object.freeze([...new Set([...plan.touchedTapes, ...finalChangedTapes])]),
        structuralPatch,
        ...(receiptFocus ? { focus: receiptFocus } : {}),
        noEffect,
        ...(promotionSkipped ? { promotionSkipped } : {}),
      });
      const focusAnchors: ActionFocusAnchors | undefined = receipt.focus
        ? Object.freeze({
            ...(receipt.focus.start
              ? {
                  start: createCanonicalTextAnchorFromIndexes(
                    this.state,
                    receipt.focus.start,
                    this.indexes,
                  ),
                }
              : {}),
            ...(receipt.focus.end
              ? {
                  end: createCanonicalTextAnchorFromIndexes(
                    candidate,
                    receipt.focus.end,
                    candidateIndexes,
                  ),
                }
              : {}),
          })
        : undefined;
      const selectionAnchors = receipt.focus?.selection
        ? Object.freeze({
            anchor: createCanonicalTextAnchorFromIndexes(
              this.state,
              receipt.focus.selection.anchor,
              this.indexes,
            ),
            focus: createCanonicalTextAnchorFromIndexes(
              this.state,
              receipt.focus.selection.focus,
              this.indexes,
            ),
            ...(receipt.focus.selection.kind ? { kind: receipt.focus.selection.kind } : {}),
          })
        : undefined;
      const snapshot = captureTouchedResources(this.state, plan, finalChangedTapes);
      const actionReservation = this.history.reserve(
        sessionId,
        request.historyGroupId,
        noEffect,
        structuralEffect,
        [...textTapes],
        receipt,
        structuralPatch,
        focusAnchors,
        selectionAnchors,
      );
      reservation = actionReservation;
      return this.commitPreparedAction({
        kind: 'candidate',
        request,
        context: Object.freeze({ ...admittedContext }),
        requestHash: hash,
        revision,
        nextRevision,
        plan,
        structuralPatch,
        changedTapeIds: finalChangedTapes,
        historyTapeIds: [...textTapes],
        structuralEffect,
        receipt,
        reservation: actionReservation,
        candidate,
        candidateMutations,
        snapshot,
      });
    } catch (error) {
      if (this.poisoned) throw error;
      candidateMutations?.close();
      candidate?.destroy();
      if (reservation) this.history.cancel(reservation);
      this.replicas.discardValidationReplica();
      this.replicas.rejectPreparedAuthor(request);
      return { status: 'rejected', reason: 'invalid-operation' };
    }
  }

  publish(pending: PendingCommit): AcceptedAction {
    assert(!this.poisoned, 'canonical writer is poisoned');
    const record = this.pending;
    assert(
      record && record.publicValue === pending,
      'pending commit does not belong to this writer',
    );
    this.history.finish(record.reservation);
    this.sessionSequences.set(record.context.sessionId, record.context.sessionSequence);
    this.replicas.applyAcceptedUpdate(pending.update, {
      sessionId: record.context.sessionId,
      actionId: record.request.actionId,
    });
    this.pending = undefined;
    this.publishing = true;
    const callbackErrors: unknown[] = [];
    try {
      callbackErrors.push(
        ...this.access.publish(
          projectionNodeIds(
            this.indexes,
            pending.receipt.touchedNodeIds,
            pending.receipt.touchedTapeIds,
            pending.receipt.structuralPatch,
          ),
        ),
      );
      const accepted = {
        actionId: record.request.actionId,
        sessionId: record.context.sessionId,
        authorityEpoch: record.context.authorityEpoch,
        revision: pending.revision,
        update: Uint8Array.from(pending.update),
        receipt: pending.receipt,
        callbackErrors,
      } as AcceptedAction;
      const event: WriterEvent = Object.freeze({
        type: 'commit',
        actionId: accepted.actionId,
        revision: accepted.revision,
      });
      callbackErrors.push(...this.notifyListeners(event));
      Object.freeze(callbackErrors);
      const result = Object.freeze(accepted);
      const key = actionIdentity(
        record.request.documentId,
        record.request.authorityEpoch,
        record.context.sessionId,
        record.context.sessionSequence,
      );
      const cached = copyAcceptedAction(result);
      const bytes = acceptedResponseBytes(cached);
      if (bytes <= MAX_CACHED_RESPONSE_BYTES) {
        this.acceptedRequests.set(key, { hash: record.requestHash, accepted: cached, bytes });
        this.acceptedResponseBytes += bytes;
        while (
          this.acceptedRequests.size > MAX_CACHED_RESPONSES ||
          this.acceptedResponseBytes > MAX_CACHED_RESPONSE_BYTES
        ) {
          const oldestKey = this.acceptedRequests.keys().next().value as string | undefined;
          if (oldestKey === undefined) break;
          const oldest = this.acceptedRequests.get(oldestKey);
          this.acceptedRequests.delete(oldestKey);
          if (oldest) this.acceptedResponseBytes -= oldest.bytes;
        }
      }
      return result;
    } finally {
      this.publishing = false;
      this.flushLocalQueue();
    }
  }

  edit(options: ActionOptions, callback: DraftCommand): AcceptedAction | ApplyResult {
    if (this.publishing) {
      const queuedOptions = deepCopy(options);
      this.deferLocalEdit(() => this.edit(queuedOptions, callback));
      return { status: 'queued', actionId: options.actionId };
    }
    // This in-process convenience is itself a host-originated admission. Network
    // requests must use admitSession() before they reach apply().
    this.admitSession(options.sessionId ?? 'local');
    const request = this.prepareCommand(options, callback);
    const context: AdmittedContext = Object.freeze({
      sessionId: options.sessionId ?? 'local',
      authorityEpoch: request.authorityEpoch,
      sessionSequence: request.sessionSequence,
    });
    const result = this.apply(request, context);
    if (result.status === 'pending') return this.publish(result.pending);
    return result;
  }

  canUndo(sessionId = 'local', scopeRoot?: NodeId): boolean {
    return this.history.select(sessionId, 'undo', scopeRoot).index !== undefined;
  }

  canRedo(sessionId = 'local', scopeRoot?: NodeId): boolean {
    return this.history.select(sessionId, 'redo', scopeRoot).index !== undefined;
  }

  undo(sessionId = 'local', scopeRoot?: NodeId): HistoryResult {
    const result = this.prepareUndo(sessionId, scopeRoot);
    return result.status === 'pending' ? this.publishHistory(result.pending) : result;
  }

  redo(sessionId = 'local', scopeRoot?: NodeId): HistoryResult {
    const result = this.prepareRedo(sessionId, scopeRoot);
    return result.status === 'pending' ? this.publishHistory(result.pending) : result;
  }

  /** Stages undo and holds the publication barrier until publishHistory is called. */
  prepareUndo(sessionId = 'local', scopeRoot?: NodeId): HistoryPreparationResult {
    return this.prepareHistory(sessionId, 'undo', scopeRoot);
  }

  /** Stages redo and holds the publication barrier until publishHistory is called. */
  prepareRedo(sessionId = 'local', scopeRoot?: NodeId): HistoryPreparationResult {
    return this.prepareHistory(sessionId, 'redo', scopeRoot);
  }

  /** Publishes a staged history update after the host's durability gate succeeds. */
  publishHistory(pending: PendingHistoryCommit): HistoryResult {
    assert(!this.closed, 'canonical writer is closed');
    assert(!this.poisoned, 'canonical writer is poisoned');
    const record = this.pendingHistory;
    assert(
      record && record.publicValue === pending,
      'pending history commit does not belong to this writer',
    );
    this.history.moveSelected(record.sessionId, record.direction, record.sourceIndex, record.entry);
    this.replicas.applyAcceptedUpdate(record.publicValue.update);
    this.pendingHistory = undefined;
    this.publishing = true;
    try {
      const callbackErrors = [
        ...this.access.publish(
          projectionNodeIds(
            this.indexes,
            record.entry.touchedNodeIds,
            record.entry.touchedTapeIds,
            record.entry.structuralPatch,
          ),
        ),
      ];
      callbackErrors.push(...this.notifyListeners({ type: 'history', revision: record.revision }));
      return Object.freeze({
        status: 'applied',
        revision: record.revision,
        textChanged: record.textChanged,
        ...(record.focus ? { focus: record.focus } : {}),
        ...(record.focusAnchor ? { focusAnchor: record.focusAnchor } : {}),
        ...(record.selectionAnchors ? { selectionAnchors: record.selectionAnchors } : {}),
        update: Uint8Array.from(record.update),
        callbackErrors: Object.freeze(callbackErrors),
      });
    } finally {
      this.publishing = false;
      this.flushLocalQueue();
    }
  }

  /**
   * Rejects publication after a host durability failure. Native writes already
   * applied to the in-memory Y.Doc cannot be rolled back safely, so the host
   * must restore its last durable checkpoint in a new epoch.
   */
  failPendingCommit(pending: PendingCommit | PendingHistoryCommit): void {
    assert(!this.closed, 'canonical writer is closed');
    const ownsAction = this.pending?.publicValue === pending;
    const ownsHistory = this.pendingHistory?.publicValue === pending;
    assert(ownsAction || ownsHistory, 'pending commit does not belong to this writer');
    this.pending = undefined;
    this.pendingHistory = undefined;
    this.poisoned = true;
    this.access.poison();
  }

  sealTextGroup(sessionId = 'local'): void {
    this.history.sealTextGroup(sessionId);
  }

  private prepareHistory(
    sessionId: string,
    direction: 'undo' | 'redo',
    scopeRoot?: NodeId,
  ): HistoryPreparationResult {
    if (this.closed || this.poisoned)
      return { status: 'blocked', reason: 'structural-history-pending' };
    if (this.pending || this.pendingHistory || this.preparing || this.publishing)
      return { status: 'blocked', reason: 'structural-history-pending' };
    const selection = this.history.select(sessionId, direction, scopeRoot);
    if (selection.reason) return { status: 'blocked', reason: selection.reason };
    const sourceIndex = selection.index;
    const entry = selection.entry;
    if (sourceIndex === undefined || !entry) return this.consumeHistoryReset();
    const patchError = structuralPatchError(this.state, entry.structuralPatch, direction);
    if (patchError) return { status: 'blocked', reason: patchError };

    const candidate = this.cloneState();
    try {
      applyStructuralPatch(candidate, entry.structuralPatch, direction);
      const validation = validateCanonicalState(candidate);
      if (!validation.valid) return { status: 'blocked', reason: 'invalid-inverse' };
      assertRetainedResources(this.state, candidate);
    } catch {
      return { status: 'blocked', reason: 'invalid-inverse' };
    } finally {
      candidate.destroy();
    }

    const manager = entry.manager;
    const canReplayText =
      !!manager &&
      (direction === 'undo' ? manager.undoStack.length > 0 : manager.redoStack.length > 0);
    const structuralEffect =
      entry.structuralPatch.cells.length > 0 ||
      entry.structuralPatch.childLists.length > 0 ||
      entry.structuralPatch.births.length > 0;
    if (!canReplayText && !structuralEffect) {
      this.history.moveSelected(sessionId, direction, sourceIndex, entry);
      this.publishing = true;
      let callbackErrors: readonly unknown[];
      try {
        callbackErrors = this.notifyListeners({ type: 'history' });
      } finally {
        this.publishing = false;
        this.flushLocalQueue();
      }
      return {
        status: 'no-effect',
        textChanged: false,
        ...(historyFocus(entry, direction) ? { focus: historyFocus(entry, direction) } : {}),
        ...(historyFocusAnchor(entry, direction)
          ? { focusAnchor: historyFocusAnchor(entry, direction) }
          : {}),
        ...(historySelectionAnchors(entry, direction)
          ? { selectionAnchors: historySelectionAnchors(entry, direction) }
          : {}),
        callbackErrors,
      };
    }

    const previousRevision = metaMap(this.state).get('acceptedRevision') as number;
    const markersBefore = markerSummary(this.state);
    const touchedSnapshot = captureHistoryTouchedResources(this.state, entry);
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(Uint8Array.from(update));
    const liveBefore = this.verifyWithFullClone ? this.cloneState() : undefined;
    const mutations = trackNativeMutations(this.state);
    this.access.beginPending();
    this.state.on('update', collect);
    try {
      if (canReplayText) {
        if (direction === 'undo') manager!.undo();
        else manager!.redo();
      }
      for (const [id, tape] of tapeMap(this.state).entries()) {
        assert(
          markersBefore.get(id) === boundarySignature(tape),
          `native history changed markers on tape ${id}`,
        );
      }
      applyStructuralPatch(this.state, entry.structuralPatch, direction);
      const updated = updateRevisionsAfterHistory(this.state, mutations, structuralEffect);
      assertHistoryMutationEvidence(
        this.state,
        entry,
        touchedSnapshot,
        mutations,
        previousRevision,
        updated.revision,
        updated.changed,
      );
      const validation = validateCanonicalState(this.state);
      assert(
        validation.valid,
        `history failed canonical validation: ${validation.errors.join('; ')}`,
      );
      if (liveBefore) validateCandidate(liveBefore, this.state, updated.revision);
      this.state.off('update', collect);
      mutations.close();
      liveBefore?.destroy();
      const update = updates.length ? Y.mergeUpdates(updates) : undefined;
      const textChanged = updated.changed.length > 0;
      if (!textChanged && !structuralEffect) {
        this.history.moveSelected(sessionId, direction, sourceIndex, entry);
        this.publishing = true;
        try {
          const callbackErrors = [...this.access.publish([])];
          callbackErrors.push(...this.notifyListeners({ type: 'history' }));
          return {
            status: 'no-effect',
            textChanged: false,
            ...(historyFocus(entry, direction) ? { focus: historyFocus(entry, direction) } : {}),
            ...(historyFocusAnchor(entry, direction)
              ? { focusAnchor: historyFocusAnchor(entry, direction) }
              : {}),
            ...(historySelectionAnchors(entry, direction)
              ? { selectionAnchors: historySelectionAnchors(entry, direction) }
              : {}),
            callbackErrors: Object.freeze(callbackErrors),
          };
        } finally {
          this.publishing = false;
          this.flushLocalQueue();
        }
      }
      assert(update, 'changed history did not produce an update');
      this.replicas.syncAcceptedValidation(
        update,
        new Set(updated.changed),
        structuralEffect,
        updated.revision,
      );
      if (structuralEffect) this.indexes.rebuild();
      else this.indexes.refreshText(updated.changed);
      const updateBytes = Uint8Array.from(update);
      const publicValue: PendingHistoryCommit = Object.freeze({
        sessionId,
        direction,
        revision: updated.revision,
        textChanged,
        ...(historyFocus(entry, direction) ? { focus: historyFocus(entry, direction) } : {}),
        ...(historyFocusAnchor(entry, direction)
          ? { focusAnchor: historyFocusAnchor(entry, direction) }
          : {}),
        ...(historySelectionAnchors(entry, direction)
          ? { selectionAnchors: historySelectionAnchors(entry, direction) }
          : {}),
        get update(): Uint8Array {
          return Uint8Array.from(updateBytes);
        },
      });
      this.pendingHistory = {
        publicValue,
        sessionId,
        direction,
        entry,
        sourceIndex,
        revision: updated.revision,
        textChanged,
        ...(historyFocus(entry, direction) ? { focus: historyFocus(entry, direction) } : {}),
        ...(historyFocusAnchor(entry, direction)
          ? { focusAnchor: historyFocusAnchor(entry, direction) }
          : {}),
        ...(historySelectionAnchors(entry, direction)
          ? { selectionAnchors: historySelectionAnchors(entry, direction) }
          : {}),
        update: updateBytes,
      };
      return { status: 'pending', pending: publicValue };
    } catch (error) {
      this.state.off('update', collect);
      mutations.close();
      liveBefore?.destroy();
      this.poisoned = true;
      this.access.poison();
      throw new Error(
        `unexpected failure during canonical history; writer is poisoned: ${String(error)}`,
      );
    }
  }

  private notifyListeners(event: WriterEvent): readonly unknown[] {
    const errors: unknown[] = [];
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        errors.push(error);
      }
    }
    return Object.freeze(errors);
  }

  private consumeHistoryReset(): HistoryResult {
    if (!this.historyResetPending) return { status: 'empty' };
    this.historyResetPending = false;
    return { status: 'history-reset' };
  }

  private nextSequence(sessionId: string): number {
    const sessionSequence = this.sessionSequences.get(sessionId);
    if (sessionSequence !== undefined) return sessionSequence + 1;
    const epoch = metaMap(this.state).get('authorityEpoch') as string;
    return (sessionWatermarkMap(this.state).get(sessionWatermarkKey(epoch, sessionId)) ?? 0) + 1;
  }

  private validateRequestShape(request: ActionRequest): void {
    assert(request.mode === 'command' || request.mode === 'text-input', 'unknown action mode');
    assert(
      typeof request.sessionId === 'string' && request.sessionId.length > 0,
      'request session ID is missing',
    );
    assert(
      typeof request.actionId === 'string' && request.actionId.length > 0,
      'request action ID is missing',
    );
    assert(
      typeof request.historyGroupId === 'string' && request.historyGroupId.length > 0,
      'request history group ID is missing',
    );
    assert(
      Number.isSafeInteger(request.sessionSequence) && request.sessionSequence > 0,
      'request session sequence is invalid',
    );
    assert(
      Number.isSafeInteger(request.baseRevision) && request.baseRevision >= 0,
      'request base revision is invalid',
    );
    assert(
      Array.isArray(request.preconditions) && Array.isArray(request.operations),
      'request operations are invalid',
    );
    if (request.mode === 'text-input') {
      assert(
        request.textUpdate instanceof Uint8Array,
        'text input requires an authored native update',
      );
      assert(
        request.operations.length === 0 && request.preconditions.length === 0,
        'text input cannot carry commands or read guards',
      );
      assert(
        request.promotionTarget !== undefined &&
          typeof request.promotionTarget.nodeId === 'string' &&
          request.promotionTarget.nodeId.length > 0 &&
          typeof request.promotionTarget.kindToken === 'string' &&
          typeof request.promotionTarget.spansToken === 'string',
        'text input requires parser promotion context',
      );
    }
  }

  private assertCanPrepare(): void {
    assert(!this.closed, 'canonical writer is closed');
    assert(!this.poisoned, 'canonical writer is poisoned');
    assert(!this.pending && !this.pendingHistory, 'canonical writer has an unpublished commit');
    assert(!this.preparing, 'nested draft preparation is not allowed');
  }

  private flushLocalQueue(): void {
    if (!this.localQueue.length) return;
    const queued = this.localQueue.splice(0);
    for (const item of queued) queueMicrotask(item.callback);
  }
}
