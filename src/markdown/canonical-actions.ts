import * as Y from 'yjs';
import {
  RoutedNativeTextHistoryCapture,
  type NativeTextHistoryCapture,
} from './canonical-history-capture.js';

import {
  CanonicalDocument,
  assertRetainedResources,
  assertTapeRevisions,
  canonicalWriterAccess,
  validateCanonicalState,
} from './canonical-model.js';
import type {
  BoundaryEmbed,
  NodeId,
  NodeKind,
  ResourceToken,
  Span,
  TapeId,
} from './canonical-model.js';
import {
  indexNativeTape,
  indexProjectedSpans,
  mapProjectedTextEdit,
  mapTextEdit,
  mapTextEditIndexed,
  spanTextFromIndex,
} from './canonical-text.js';
import type {
  NativeTapeIndex,
  NativeTextRun,
  ProjectedTextIndex,
  TextAffinity,
  TextEdit,
} from './canonical-text.js';
import { normalizeCanonicalDraft } from './canonical-normalize.js';
import type { SemanticNormalizationDraft } from './semantic-normalize.js';
import { classifyInlineInput, parseBlocks } from './block-parser/api.js';
import type { ParserConversionPlan } from './block-parser/api.js';
import { applyParserConversion } from './canonical-promotion.js';
import {
  createCanonicalTextAnchorFromIndexes,
  type CanonicalTextAnchor,
} from './canonical-selection.js';

const META = 'meta';
const NODES = 'nodes';
const TAPES = 'tapes';
const TAPE_REVISIONS = 'tapeRevisions';
const SESSION_WATERMARKS = 'sessionWatermarks';
const MAX_CACHED_RESPONSES = 256;
const MAX_CACHED_RESPONSE_BYTES = 4 * 1024 * 1024;
const INLINE_KINDS = new Set<NodeKind>(['paragraph', 'section', 'code-block']);
const CONTAINER_KINDS = new Set<NodeKind>(['document', 'section', 'list-item', 'block-quote']);
const BLOCK_KINDS = new Set<NodeKind>([
  'paragraph',
  'section',
  'code-block',
  'list',
  'block-quote',
]);

type RecordMap = Y.Map<unknown>;
type CellValue<T> = { readonly token: ResourceToken; readonly value: T };
export type CellField = 'kind' | 'children' | 'spans' | 'marker' | 'checked' | 'info';

export interface NodeSpec {
  readonly type: NodeKind;
  readonly content?: string;
  readonly children?: readonly NodeId[];
  readonly marker?: string;
  readonly checked?: boolean | null;
  readonly info?: string | null;
}

export interface DraftNode {
  readonly id: NodeId;
  readonly type: NodeKind;
  readonly children: readonly NodeId[];
  readonly spans: readonly Span[];
  readonly content?: string;
  readonly marker: string | null;
  readonly checked: boolean | null;
  readonly info: string | null;
}

export interface Transfer {
  readonly source: NodeId;
  readonly from: number;
  readonly to: number;
  readonly destination: NodeId;
  readonly at: number;
  readonly affinity: TextAffinity;
}

/** A move-only handle to text and insertion gaps removed from a draft inline. */
export interface InlineFragment {
  readonly text: string;
}

export interface ConversionPlan {
  readonly type: 'paragraph' | 'section' | 'code-block';
  readonly marker?: string;
  readonly info?: string | null;
  readonly content?:
    | { readonly mode: 'preserve' }
    | { readonly mode: 'replace'; readonly text: string };
}

export interface Bookmark {
  readonly nodeId: NodeId;
  readonly offset: number;
  readonly affinity: TextAffinity;
  readonly spanIndex?: number;
}

export interface ActionFocus {
  readonly start?: Bookmark;
  readonly end?: Bookmark;
  readonly selection?: {
    readonly anchor: Bookmark;
    readonly focus: Bookmark;
    /** Restore this identity-preserving structural selection after redo as well. */
    readonly restoreOnRedo?: boolean;
  };
}

export type DraftCommand = (draft: TreeDraft) => void | ActionFocus;

export interface TreeDraft extends SemanticNormalizationDraft {
  node(id: NodeId): DraftNode;
  parentOf(id: NodeId): NodeId | undefined;
  previousSiblingOf(id: NodeId): NodeId | undefined;
  nextSiblingOf(id: NodeId): NodeId | undefined;
  create(spec: NodeSpec): NodeId;
  place(id: NodeId, parent: NodeId, before: NodeId | null): void;
  detach(id: NodeId): void;
  spliceText(id: NodeId, edit: TextEdit): void;
  cutInline(id: NodeId, from: number, to: number): InlineFragment;
  insertFragment(
    destination: NodeId,
    at: number,
    affinity: TextAffinity,
    fragment: InlineFragment,
  ): void;
  transferInlineRange(transfer: Transfer): void;
  convertInline(id: NodeId, plan: ConversionPlan): void;
  setMarker(id: NodeId, marker: string | null): void;
  setChecked(id: NodeId, checked: boolean | null): void;
  setInfo(id: NodeId, info: string | null): void;
  bookmark(id: NodeId, offset: number, affinity: TextAffinity, spanIndex?: number): Bookmark;
}

export interface DraftTextPiece {
  /** Half-open UTF-16 coordinates in the current draft string. */
  readonly from: number;
  readonly to: number;
  readonly kind: 'existing' | 'inserted';
}

/** Parser conversion reads the draft's own source mapping before changing ownership. */
export interface ParserTreeDraft extends TreeDraft {
  sourcePieces(id: NodeId): readonly DraftTextPiece[];
}

export type ReadPrecondition =
  | {
      readonly kind: 'cell';
      readonly nodeId: NodeId;
      readonly field: CellField;
      readonly token: string;
    }
  | { readonly kind: 'tape'; readonly tapeId: TapeId; readonly revision: number };

export type SemanticOperation =
  | { readonly type: 'create'; readonly id: NodeId; readonly spec: NodeSpec; readonly span?: Span }
  | {
      readonly type: 'place';
      readonly id: NodeId;
      readonly parent: NodeId;
      readonly before: NodeId | null;
    }
  | { readonly type: 'detach'; readonly id: NodeId }
  | { readonly type: 'spliceText'; readonly id: NodeId; readonly edit: TextEdit }
  | {
      readonly type: 'cutInline';
      readonly id: NodeId;
      readonly from: number;
      readonly to: number;
      readonly fragmentId: string;
    }
  | {
      readonly type: 'insertFragment';
      readonly destination: NodeId;
      readonly at: number;
      readonly affinity: TextAffinity;
      readonly fragmentId: string;
    }
  | { readonly type: 'transferInlineRange'; readonly transfer: Transfer }
  | { readonly type: 'convertInline'; readonly id: NodeId; readonly plan: ConversionPlan }
  | { readonly type: 'setMarker'; readonly id: NodeId; readonly marker: string | null }
  | { readonly type: 'setChecked'; readonly id: NodeId; readonly checked: boolean | null }
  | { readonly type: 'setInfo'; readonly id: NodeId; readonly info: string | null };

export interface ActionRequest {
  readonly mode: 'text-input' | 'command';
  readonly documentId: string;
  readonly authorityEpoch: string;
  readonly sessionId: string;
  readonly sessionSequence: number;
  readonly actionId: string;
  readonly baseRevision: number;
  readonly historyGroupId: string;
  readonly preconditions: readonly ReadPrecondition[];
  /** Internal trusted Grain-engine input; not an arbitrary-update security filter. */
  readonly textUpdate?: Uint8Array;
  readonly operations: readonly SemanticOperation[];
  readonly focus?: ActionFocus;
  readonly promotionTarget?: {
    readonly nodeId: NodeId;
    readonly kindToken: ResourceToken;
    readonly spansToken: ResourceToken;
  };
}

export interface ActionOptions {
  readonly sessionId?: string;
  /** Unique across the lifetime of the canonical document's authority. */
  readonly actionId: string;
  readonly historyGroupId?: string;
  readonly sessionSequence?: number;
  readonly focus?: ActionFocus;
}

export interface AdmittedContext {
  readonly sessionId: string;
  readonly authorityEpoch: string;
  readonly sessionSequence: number;
}

export interface AcceptedAction {
  readonly actionId: string;
  readonly sessionId: string;
  readonly authorityEpoch: string;
  readonly revision: number;
  readonly update: Uint8Array;
  readonly receipt: ActionReceipt;
  readonly callbackErrors: readonly unknown[];
}

export interface ActionReceipt {
  readonly requestId: string;
  readonly historyGroupId: string;
  readonly touchedNodeIds: readonly NodeId[];
  readonly touchedTapeIds: readonly TapeId[];
  readonly structuralPatch: StructuralPatch;
  readonly focus?: ActionFocus;
  readonly noEffect: boolean;
  readonly promotionSkipped?: 'ownershipChanged';
}

export interface StructuralCellValue {
  readonly token: ResourceToken;
  readonly value: unknown;
}

export interface StructuralCellPatch {
  readonly nodeId: NodeId;
  readonly field: CellField;
  readonly before: StructuralCellValue;
  readonly after: StructuralCellValue;
}

export interface StructuralChildSplice {
  /** Index in the child list immediately before this splice. */
  readonly index: number;
  readonly removedIds: readonly NodeId[];
  readonly insertedIds: readonly NodeId[];
}

export interface StructuralChildListPatch {
  readonly nodeId: NodeId;
  readonly beforeToken: ResourceToken;
  readonly afterToken: ResourceToken;
  readonly splices: readonly StructuralChildSplice[];
}

export interface StructuralBirth {
  readonly nodeId: NodeId;
  readonly cells: Readonly<Record<CellField, StructuralCellValue>>;
}

export interface StructuralVisibility {
  readonly nodeId: NodeId;
  readonly before: boolean;
  readonly after: boolean;
}

export interface StructuralPatch {
  readonly cells: readonly StructuralCellPatch[];
  readonly childLists: readonly StructuralChildListPatch[];
  readonly births: readonly StructuralBirth[];
  readonly visibility: readonly StructuralVisibility[];
  readonly bornTapes: readonly { readonly tapeId: TapeId; readonly sharedTypeId: string }[];
  readonly bornMarkers: readonly {
    readonly tapeId: TapeId;
    readonly boundaryId: string;
    readonly itemId: string;
  }[];
}

export interface PendingCommit {
  readonly actionId: string;
  readonly revision: number;
  readonly update: Uint8Array;
  readonly receipt: ActionReceipt;
}

export type ApplyResult =
  | { readonly status: 'pending'; readonly pending: PendingCommit }
  | { readonly status: 'rejected'; readonly reason: RejectionReason }
  | { readonly status: 'duplicate'; readonly accepted: AcceptedAction }
  | { readonly status: 'queued'; readonly actionId: string };

export type RejectionReason =
  | 'pending-commit'
  | 'poisoned-writer'
  | 'closed-writer'
  | 'wrong-document'
  | 'wrong-authority-epoch'
  | 'wrong-session'
  | 'wrong-sequence'
  | 'future-base-revision'
  | 'stale-precondition'
  | 'duplicate-action-id'
  | 'retry-payload-conflict'
  | 'receipt-expired/resync-required'
  | 'invalid-request'
  | 'invalid-operation'
  | 'invalid-text-update'
  | 'publication-order';

export interface WriterOptions {
  readonly maxHistoryGroups?: number;
  /** Full-document before/after validation retained as an opt-in test reference. */
  readonly verifyWithFullClone?: boolean;
}

export interface WriterOperationCounts {
  readonly fullStateClones: number;
  readonly authorReplicaCreations: number;
  readonly validationReplicaCreations: number;
  readonly literalTextInputs: number;
}

interface InternalCell {
  readonly token: string;
  readonly value: unknown;
}

interface InsertionSlot {
  readonly tapeId: TapeId;
  readonly index: number;
  readonly spanIndex: number;
  readonly affinity: TextAffinity;
  readonly order: number;
}

type InsertionSlotTarget = Omit<InsertionSlot, 'order'> & {
  /** Preserve the source buffer gap when an edit follows a transfer. */
  readonly parentBufferId?: string;
  readonly parentBufferOffset?: number;
};

interface ExistingPiece {
  readonly kind: 'existing';
  readonly source: NodeId;
  readonly tapeId: TapeId;
  readonly sourceSpanIndex: number;
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

interface InsertedPiece {
  readonly kind: 'inserted';
  readonly bufferId: string;
  readonly from: number;
  readonly to: number;
  readonly anchor: InsertionSlot;
  readonly text: string;
}

interface DraftTextBuffer {
  readonly text: string;
  readonly anchor: InsertionSlot;
  readonly parentBufferId?: string;
  readonly parentBufferOffset?: number;
}

type DraftPiece = ExistingPiece | InsertedPiece;

interface DraftSpan {
  span: Span;
  pieces: DraftPiece[];
  readonly sourceSpanIndex?: number;
  readonly created?: boolean;
  /** Insertion target retained when a cut leaves this span empty. */
  readonly insertionSlot?: InsertionSlotTarget;
}

interface DraftNodeState {
  readonly id: NodeId;
  type: NodeKind;
  children: NodeId[];
  spans: DraftSpan[];
  marker: string | null;
  checked: boolean | null;
  info: string | null;
  readonly baseCells: Map<CellField, InternalCell>;
  readonly created: boolean;
  textEdited: boolean;
}

interface DraftFragment {
  readonly spans: readonly DraftSpan[];
  readonly text: string;
}

const fragmentIds = new WeakMap<object, string>();

interface PlanBoundary {
  readonly tapeId: TapeId;
  readonly index: number;
  readonly boundaryId: string;
  /** Position inside action-local text inserted at this native index. */
  readonly insertionOffset: number;
  readonly side: 'start' | 'end';
  readonly order: number;
  /** Action-local buffer that defines this transfer boundary's slot. */
  readonly sourceBufferId?: string;
  /** UTF-16 offset in the immutable action-local buffer. */
  readonly sourceBufferOffset?: number;
}

interface PlanTextInsert {
  readonly tapeId: TapeId;
  readonly index: number;
  readonly slotOrder: number;
  readonly text: string;
}

interface PlanNodeAllocation {
  readonly id: NodeId;
  readonly type: NodeKind;
  readonly marker: string | null;
  readonly checked: boolean | null;
  readonly info: string | null;
  readonly spans: readonly Span[];
  readonly cells: Readonly<Record<CellField, CellValue<unknown>>>;
}

interface LowLevelPlan {
  readonly allocations: readonly PlanNodeAllocation[];
  readonly newTapes: readonly { readonly id: TapeId; readonly span: Span }[];
  readonly boundaries: readonly PlanBoundary[];
  readonly deletions: readonly NativeTextRun[];
  readonly insertions: readonly PlanTextInsert[];
  readonly writes: readonly {
    readonly nodeId: NodeId;
    readonly field: CellField;
    readonly value: unknown;
    readonly token: string;
  }[];
  readonly touchedNodes: readonly NodeId[];
  readonly touchedTapes: readonly TapeId[];
  readonly textTapes: readonly TapeId[];
}

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

interface NativeItem {
  readonly id: { readonly client: number; readonly clock: number };
  readonly right: NativeItem | null;
  readonly deleted: boolean;
  readonly content: unknown;
}

interface NativeSharedType {
  readonly _item: NativeItem | null;
  readonly _start: NativeItem | null;
}

function nativeItemId(item: NativeItem): string {
  return `${item.id.client}:${item.id.clock}`;
}

function sharedTypeId(type: Y.Map<unknown> | Y.Text): string {
  const item = (type as unknown as NativeSharedType)._item;
  assert(item, 'canonical shared type is not integrated');
  return nativeItemId(item);
}

function markerItems(state: Y.Doc): Map<string, { tapeId: TapeId; itemId: string }> {
  const result = new Map<string, { tapeId: TapeId; itemId: string }>();
  for (const [tapeId, tape] of tapeMap(state)) {
    let item = (tape as unknown as NativeSharedType)._start;
    while (item) {
      const content = item.content;
      const embed =
        content && typeof content === 'object' && 'embed' in content
          ? (content as { embed: unknown }).embed
          : undefined;
      const boundaryId =
        embed && typeof embed === 'object' && 'grainBoundary' in embed
          ? (embed as { grainBoundary: unknown }).grainBoundary
          : undefined;
      if (!item.deleted && typeof boundaryId === 'string') {
        result.set(boundaryId, { tapeId, itemId: nativeItemId(item) });
      }
      item = item.right;
    }
  }
  return result;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepCopy(item)]),
    ) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function copyActionFocus(value: unknown): ActionFocus | undefined {
  if (value === undefined) return undefined;
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'focus must be an object',
  );
  const focus = value as ActionFocus;
  const copyBookmark = (bookmark: Bookmark | undefined): Bookmark | undefined => {
    if (bookmark === undefined) return undefined;
    assert(
      typeof bookmark.nodeId === 'string' && bookmark.nodeId.length > 0,
      'focus node ID is invalid',
    );
    assert(Number.isInteger(bookmark.offset) && bookmark.offset >= 0, 'focus offset is invalid');
    assert(
      bookmark.affinity === 'left' || bookmark.affinity === 'right',
      'focus affinity is invalid',
    );
    if (bookmark.spanIndex !== undefined)
      assert(
        Number.isInteger(bookmark.spanIndex) && bookmark.spanIndex >= 0,
        'focus span index is invalid',
      );
    return Object.freeze({ ...bookmark });
  };
  assert(
    Object.keys(focus).every((key) => key === 'start' || key === 'end' || key === 'selection'),
    'focus contains an unsupported field',
  );
  const start = copyBookmark(focus.start);
  const end = copyBookmark(focus.end);
  let selection: ActionFocus['selection'];
  if (focus.selection !== undefined) {
    assert(
      Object.keys(focus.selection).every(
        (key) => key === 'anchor' || key === 'focus' || key === 'restoreOnRedo',
      ),
      'focus selection contains an unsupported field',
    );
    const anchor = copyBookmark(focus.selection.anchor);
    const selectionFocus = copyBookmark(focus.selection.focus);
    assert(anchor && selectionFocus, 'focus selection endpoints are required');
    assert(
      focus.selection.restoreOnRedo === undefined ||
        typeof focus.selection.restoreOnRedo === 'boolean',
      'focus selection redo flag is invalid',
    );
    selection = Object.freeze({
      anchor,
      focus: selectionFocus,
      ...(focus.selection.restoreOnRedo ? { restoreOnRedo: true } : {}),
    });
  }
  return Object.freeze({
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(selection ? { selection } : {}),
  });
}

function immutableCell<T>(token: string, value: T): CellValue<T> {
  return Object.freeze({ token, value: deepFreeze(deepCopy(value)) });
}

function readCell<T>(record: RecordMap, field: CellField): CellValue<T> {
  if (field === 'children') {
    const children = record.get('children');
    if (children instanceof Y.Array) {
      const token = record.get('childrenToken');
      assert(typeof token === 'string' && token.length > 0, 'node children token is invalid');
      return immutableCell(token, children.toArray()) as CellValue<T>;
    }
  }
  const value = record.get(field);
  assert(value !== null && typeof value === 'object', `node cell ${field} is missing`);
  const cell = value as InternalCell;
  assert(
    typeof cell.token === 'string' && Object.hasOwn(cell, 'value'),
    `node cell ${field} is invalid`,
  );
  return cell as CellValue<T>;
}

function nodeMap(state: Y.Doc): Y.Map<RecordMap> {
  return state.getMap<RecordMap>(NODES);
}

function tapeMap(state: Y.Doc): Y.Map<Y.Text> {
  return state.getMap<Y.Text>(TAPES);
}

function revisionMap(state: Y.Doc): Y.Map<number> {
  return state.getMap<number>(TAPE_REVISIONS);
}

function metaMap(state: Y.Doc): Y.Map<unknown> {
  return state.getMap<unknown>(META);
}

function sessionWatermarkMap(state: Y.Doc): Y.Map<number> {
  return state.getMap<number>(SESSION_WATERMARKS);
}

function sessionWatermarkKey(epoch: string, sessionId: string): string {
  return stableJson([epoch, sessionId]);
}

function actionIdentity(
  documentId: string,
  epoch: string,
  sessionId: string,
  sequence: number,
): string {
  return stableJson([documentId, epoch, sessionId, sequence]);
}

function nodeCell(state: Y.Doc, id: NodeId, field: CellField): CellValue<unknown> {
  const record = nodeMap(state).get(id);
  assert(record, `unknown node ${id}`);
  return readCell(record, field);
}

function spanText(state: Y.Doc, span: Span, indexes?: CanonicalIndexes): string {
  if (indexes) return spanTextFromIndex(span, indexes.tape(span.tapeId));
  const tape = tapeMap(state).get(span.tapeId);
  assert(tape, `missing tape ${span.tapeId}`);
  let inSpan = false;
  let result = '';
  for (const part of tape.toDelta()) {
    if (typeof part.insert === 'string') {
      if (inSpan) result += part.insert;
    } else {
      const marker = (part.insert as Partial<BoundaryEmbed>)?.grainBoundary;
      if (marker === span.startBoundaryId) inSpan = true;
      else if (marker === span.endBoundaryId) break;
    }
  }
  return result;
}

/** Reconstructible lookups over canonical resources; text indexes are revision scoped. */
class CanonicalIndexes {
  readonly nodeIds = new Set<NodeId>();
  readonly tapeIds = new Set<TapeId>();
  readonly boundaryIds = new Set<string>();
  readonly parentByChild = new Map<NodeId, NodeId>();
  readonly activeNodes = new Set<NodeId>();
  readonly visibleInlineNodeIds: NodeId[] = [];
  private readonly visibleInlinePosition = new Map<NodeId, number>();
  readonly activeTapeOwners = new Map<TapeId, Set<NodeId>>();
  readonly tapeOwners = new Map<TapeId, Set<NodeId>>();
  readonly boundaryLocations = new Map<
    string,
    { readonly tapeId: TapeId; readonly index: number }
  >();
  readonly boundaryIdsByTape = new Map<TapeId, Set<string>>();
  readonly textIndexes = new Map<TapeId, NativeTapeIndex>();
  private readonly projectedByNode = new Map<
    NodeId,
    { readonly signature: string; readonly index: ProjectedTextIndex }
  >();

  constructor(private readonly state: Y.Doc) {
    this.rebuild();
  }

  rebuild(): void {
    this.nodeIds.clear();
    this.tapeIds.clear();
    this.boundaryIds.clear();
    this.parentByChild.clear();
    this.activeNodes.clear();
    this.visibleInlineNodeIds.length = 0;
    this.visibleInlinePosition.clear();
    this.activeTapeOwners.clear();
    this.tapeOwners.clear();
    this.boundaryLocations.clear();
    this.boundaryIdsByTape.clear();
    this.textIndexes.clear();
    this.projectedByNode.clear();

    const nodes = nodeMap(this.state);
    for (const [id, record] of nodes) {
      this.nodeIds.add(id);
      for (const child of readCell<readonly NodeId[]>(record, 'children').value) {
        this.parentByChild.set(child, id);
      }
    }
    const rootId = metaMap(this.state).get('rootId') as NodeId;
    const pending = [rootId];
    while (pending.length) {
      const id = pending.pop()!;
      if (this.activeNodes.has(id)) continue;
      this.activeNodes.add(id);
      const record = nodes.get(id);
      if (record) {
        if (INLINE_KINDS.has(readCell<NodeKind>(record, 'kind').value)) {
          this.visibleInlinePosition.set(id, this.visibleInlineNodeIds.length);
          this.visibleInlineNodeIds.push(id);
        }
        const children = readCell<readonly NodeId[]>(record, 'children').value;
        for (let index = children.length - 1; index >= 0; index--) {
          pending.push(children[index]!);
        }
      }
    }

    for (const [id, record] of nodes) {
      const ownerActive = this.activeNodes.has(id);
      for (const span of readCell<readonly Span[]>(record, 'spans').value) {
        const owners = this.tapeOwners.get(span.tapeId) ?? new Set<NodeId>();
        owners.add(id);
        this.tapeOwners.set(span.tapeId, owners);
        if (ownerActive) {
          const activeOwners = this.activeTapeOwners.get(span.tapeId) ?? new Set<NodeId>();
          activeOwners.add(id);
          this.activeTapeOwners.set(span.tapeId, activeOwners);
        }
      }
    }

    for (const [tapeId, tape] of tapeMap(this.state)) {
      this.tapeIds.add(tapeId);
      const index = indexNativeTape(tapeId, tape);
      this.textIndexes.set(tapeId, index);
      for (const [boundaryId, indexPosition] of index.boundaries) {
        this.boundaryIds.add(boundaryId);
        this.boundaryLocations.set(boundaryId, { tapeId, index: indexPosition });
        const ids = this.boundaryIdsByTape.get(tapeId) ?? new Set<string>();
        ids.add(boundaryId);
        this.boundaryIdsByTape.set(tapeId, ids);
      }
    }
  }

  isActive(id: NodeId): boolean {
    return this.activeNodes.has(id);
  }

  parent(id: NodeId): NodeId | undefined {
    return this.parentByChild.get(id);
  }

  tape(tapeId: TapeId): NativeTapeIndex {
    const index = this.textIndexes.get(tapeId);
    assert(index, `missing tape index ${tapeId}`);
    return index;
  }

  content(nodeId: NodeId): string {
    return this.projected(nodeId).index.text;
  }

  projectedText(nodeId: NodeId): ProjectedTextIndex {
    return this.projected(nodeId).index;
  }

  visibleInlineNeighbors(nodeId: NodeId): {
    readonly previousNodeId?: NodeId;
    readonly nextNodeId?: NodeId;
  } {
    const index = this.visibleInlinePosition.get(nodeId);
    if (index === undefined) return {};
    return {
      ...(index > 0 ? { previousNodeId: this.visibleInlineNodeIds[index - 1]! } : {}),
      ...(index + 1 < this.visibleInlineNodeIds.length
        ? { nextNodeId: this.visibleInlineNodeIds[index + 1]! }
        : {}),
    };
  }

  mapTextEdit(nodeId: NodeId, spans: readonly Span[], edit: TextEdit) {
    const indexed = this.projected(nodeId, spans);
    return mapProjectedTextEdit(indexed.index, edit);
  }

  private projected(nodeId: NodeId, knownSpans?: readonly Span[]) {
    const record = nodeMap(this.state).get(nodeId);
    assert(record, `unknown node ${nodeId}`);
    const spansCell = readCell<readonly Span[]>(record, 'spans');
    const spans = knownSpans ?? spansCell.value;
    const signature = stableJson([
      spansCell.token,
      ...spans.map((span) => [span.tapeId, revisionMap(this.state).get(span.tapeId)]),
    ]);
    const cached = this.projectedByNode.get(nodeId);
    if (cached?.signature === signature) return cached;
    const index = indexProjectedSpans(spans, this.textIndexes);
    const result = { signature, index };
    this.projectedByNode.set(nodeId, result);
    return result;
  }

  refreshText(tapeIds: Iterable<TapeId>): void {
    const tapes = tapeMap(this.state);
    for (const tapeId of tapeIds) {
      const tape = tapes.get(tapeId);
      if (!tape) continue;
      const index = indexNativeTape(tapeId, tape);
      this.textIndexes.set(tapeId, index);
      for (const boundaryId of this.boundaryIdsByTape.get(tapeId) ?? []) {
        this.boundaryLocations.delete(boundaryId);
        this.boundaryIds.delete(boundaryId);
      }
      const boundaryIds = new Set<string>();
      for (const [boundaryId, indexPosition] of index.boundaries) {
        this.boundaryIds.add(boundaryId);
        boundaryIds.add(boundaryId);
        this.boundaryLocations.set(boundaryId, { tapeId, index: indexPosition });
      }
      this.boundaryIdsByTape.set(tapeId, boundaryIds);
      for (const ownerId of this.tapeOwners.get(tapeId) ?? []) this.projectedByNode.delete(ownerId);
    }
  }
}

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

function inlineContent(node: DraftNodeState): string {
  return node.spans.flatMap((span) => span.pieces.map((piece) => piece.text)).join('');
}

function draftSpanCopy(
  owner: NodeId,
  span: Span,
  text: string,
  sourceSpanIndex: number,
): DraftSpan {
  return {
    span: Object.freeze({ ...span }),
    sourceSpanIndex,
    pieces: text
      ? [
          {
            kind: 'existing',
            source: owner,
            tapeId: span.tapeId,
            sourceSpanIndex,
            from: 0,
            to: text.length,
            text,
          },
        ]
      : [],
  };
}

function nodeStateFromRecord(state: Y.Doc, id: NodeId, indexes: CanonicalIndexes): DraftNodeState {
  const record = nodeMap(state).get(id);
  assert(record, `unknown node ${id}`);
  const kind = readCell<NodeKind>(record, 'kind');
  const children = readCell<readonly NodeId[]>(record, 'children');
  const spans = readCell<readonly Span[]>(record, 'spans');
  const marker = readCell<string | null>(record, 'marker');
  const checked = readCell<boolean | null>(record, 'checked');
  const info = readCell<string | null>(record, 'info');
  return {
    id,
    type: kind.value,
    children: [...children.value],
    spans: INLINE_KINDS.has(kind.value)
      ? spans.value.map((span, index) =>
          draftSpanCopy(id, span, spanText(state, span, indexes), index),
        )
      : [],
    marker: marker.value,
    checked: checked.value,
    info: info.value,
    baseCells: new Map<CellField, InternalCell>([
      ['kind', kind],
      ['children', children],
      ['spans', spans],
      ['marker', marker],
      ['checked', checked],
      ['info', info],
    ]),
    created: false,
    textEdited: false,
  };
}

function allowedChild(parent: NodeKind, child: NodeKind): boolean {
  if (parent === 'list') return child === 'list-item';
  return CONTAINER_KINDS.has(parent) && BLOCK_KINDS.has(child);
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

/** LCS for unique child IDs via an LIS over the destination positions. */
function diffChildSplices(
  before: readonly NodeId[],
  after: readonly NodeId[],
): readonly StructuralChildSplice[] {
  const destination = new Map(after.map((id, index) => [id, index]));
  const candidates: { readonly beforeIndex: number; readonly afterIndex: number }[] = [];
  before.forEach((id, beforeIndex) => {
    const afterIndex = destination.get(id);
    if (afterIndex !== undefined) candidates.push({ beforeIndex, afterIndex });
  });

  const tails: number[] = [];
  const tailsAt: number[] = [];
  const previous = Array.from({ length: candidates.length }, () => -1);
  for (let index = 0; index < candidates.length; index++) {
    const value = candidates[index]!.afterIndex;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tails[middle]! < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tailsAt[low - 1]!;
    tails[low] = value;
    tailsAt[low] = index;
  }

  const matches: { readonly beforeIndex: number; readonly afterIndex: number }[] = [];
  let cursor = tailsAt.at(-1) ?? -1;
  while (cursor >= 0) {
    matches.push(candidates[cursor]!);
    cursor = previous[cursor]!;
  }
  matches.reverse();

  const splices: StructuralChildSplice[] = [];
  let beforeCursor = 0;
  let afterCursor = 0;
  let liveIndex = 0;
  for (const match of matches) {
    const removedIds = before.slice(beforeCursor, match.beforeIndex);
    const insertedIds = after.slice(afterCursor, match.afterIndex);
    if (removedIds.length || insertedIds.length) {
      splices.push(
        Object.freeze({
          index: liveIndex,
          removedIds: Object.freeze([...removedIds]),
          insertedIds: Object.freeze([...insertedIds]),
        }),
      );
      liveIndex += insertedIds.length;
    }
    liveIndex++;
    beforeCursor = match.beforeIndex + 1;
    afterCursor = match.afterIndex + 1;
  }
  const removedIds = before.slice(beforeCursor);
  const insertedIds = after.slice(afterCursor);
  if (removedIds.length || insertedIds.length) {
    splices.push(
      Object.freeze({
        index: liveIndex,
        removedIds: Object.freeze([...removedIds]),
        insertedIds: Object.freeze([...insertedIds]),
      }),
    );
  }
  return Object.freeze(splices);
}

function slicePiece(piece: DraftPiece, from: number, to: number): DraftPiece | undefined {
  if (from >= to) return undefined;
  if (piece.kind === 'existing') {
    return {
      ...piece,
      from: piece.from + from,
      to: piece.from + to,
      text: piece.text.slice(from, to),
    };
  }
  if (piece.kind === 'inserted') {
    return {
      ...piece,
      from: piece.from + from,
      to: piece.from + to,
      text: piece.text.slice(from, to),
    };
  }
  return undefined;
}

function slicePieces(pieces: readonly DraftPiece[], from: number, to: number): DraftPiece[] {
  const result: DraftPiece[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    const next = cursor + piece.text.length;
    const left = Math.max(from, cursor);
    const right = Math.min(to, next);
    if (left < right) {
      const selected = slicePiece(piece, left - cursor, right - cursor);
      if (selected) result.push(selected);
    }
    cursor = next;
  }
  return result;
}

function splitSurrogateBoundary(value: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < value.length &&
    value.charCodeAt(offset - 1) >= 0xd800 &&
    value.charCodeAt(offset - 1) <= 0xdbff &&
    value.charCodeAt(offset) >= 0xdc00 &&
    value.charCodeAt(offset) <= 0xdfff
  );
}

function stableJson(value: unknown): string {
  if (value instanceof Uint8Array) return JSON.stringify(Array.from(value));
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

class MutableTreeDraft implements ParserTreeDraft {
  private active = true;
  private readonly nodes = new Map<NodeId, DraftNodeState>();
  /** Only changed edges are copied; untouched parent lookups stay on the accepted index. */
  private readonly parentOverlay = new Map<NodeId, NodeId | null>();
  private readonly preconditions = new Map<string, ReadPrecondition>();
  private readonly operations_: SemanticOperation[] = [];
  private readonly generatedIds = new Set<string>();
  private readonly newTapeSpans = new Map<NodeId, Span>();
  private readonly transferBoundaries: PlanBoundary[] = [];
  private readonly transferBoundarySlots = new Map<string, InsertionSlotTarget>();
  private readonly textBuffers = new Map<string, DraftTextBuffer>();
  private readonly fragments = new Map<string, DraftFragment>();
  private readonly consumedFragments = new Set<string>();
  private idOrdinal = 0;
  private insertionSlotOrder = 0;
  private compiledPlan?: LowLevelPlan;

  constructor(
    private readonly state: Y.Doc,
    private readonly actionId: string,
    private readonly indexes: CanonicalIndexes,
    operations?: readonly SemanticOperation[],
  ) {
    if (operations) {
      for (const operation of operations) this.apply(operation, false);
    }
  }

  close(): void {
    this.active = false;
  }

  get operationList(): readonly SemanticOperation[] {
    return Object.freeze(this.operations_.map((operation) => deepFreeze(deepCopy(operation))));
  }

  get readSet(): readonly ReadPrecondition[] {
    return Object.freeze(
      [...this.preconditions.values()].map((item) => Object.freeze({ ...item })),
    );
  }

  compilePlan(): LowLevelPlan {
    this.assertActive();
    if (this.compiledPlan) return this.compiledPlan;
    this.dropUnusedCreatedInsertionSpans();
    assert(
      [...this.fragments.keys()].every((id) => this.consumedFragments.has(id)),
      'every cut fragment must be inserted before the action is compiled',
    );
    const allocations: PlanNodeAllocation[] = [];
    const newTapes: { id: TapeId; span: Span }[] = [];
    const deletions: NativeTextRun[] = [];
    const writes: { nodeId: NodeId; field: CellField; value: unknown; token: string }[] = [];
    const touchedNodes = new Set<NodeId>();
    const touchedTapes = new Set<TapeId>();
    const textTapes = new Set<TapeId>();
    const finalTapeIds = new Set<TapeId>();
    for (const candidate of this.nodes.values()) {
      for (const span of candidate.spans) finalTapeIds.add(span.span.tapeId);
    }
    for (const node of this.nodes.values()) {
      for (const span of node.spans) {
        for (const piece of span.pieces) this.assertPieceSource(piece);
      }
      if (node.created) {
        const spans = node.spans.map((span) => deepFreeze(deepCopy(span.span)));
        const cells: Record<CellField, CellValue<unknown>> = {
          kind: immutableCell(this.allocateId('cell'), node.type),
          children: immutableCell(this.allocateId('cell'), []),
          spans: immutableCell(this.allocateId('cell'), spans),
          marker: immutableCell(this.allocateId('cell'), node.marker),
          checked: immutableCell(this.allocateId('cell'), node.checked),
          info: immutableCell(this.allocateId('cell'), node.info),
        };
        allocations.push({
          id: node.id,
          type: node.type,
          marker: node.marker,
          checked: node.checked,
          info: node.info,
          spans,
          cells,
        });
        touchedNodes.add(node.id);
        const createdSpan = this.newTapeSpans.get(node.id);
        if (createdSpan && finalTapeIds.has(createdSpan.tapeId)) {
          newTapes.push({ id: createdSpan.tapeId, span: createdSpan });
          touchedTapes.add(createdSpan.tapeId);
        }
      }

      if (node.textEdited && !node.created) {
        const baseSpans = node.baseCells.get('spans')!.value as readonly Span[];
        const baseStarts: number[] = [];
        let baseLength = 0;
        for (const span of baseSpans) {
          baseStarts.push(baseLength);
          baseLength += spanText(this.state, span, this.indexes).length;
        }
        for (let spanIndex = 0; spanIndex < baseSpans.length; spanIndex++) {
          const baseSpan = baseSpans[spanIndex]!;
          const baseText = spanText(this.state, baseSpan, this.indexes);
          for (const ownerId of this.indexes.tapeOwners.get(baseSpan.tapeId) ?? []) {
            this.requireNode(ownerId);
          }
          const retained = [...this.nodes.values()]
            .flatMap((candidate) =>
              candidate.spans.flatMap((span) =>
                span.pieces.filter(
                  (piece) =>
                    piece.kind === 'existing' &&
                    piece.source === node.id &&
                    piece.sourceSpanIndex === spanIndex,
                ),
              ),
            )
            .map((piece) => [piece.from, piece.to] as const)
            .sort((a, b) => a[0] - b[0]);
          const merged: [number, number][] = [];
          for (const [from, to] of retained) {
            const previous = merged.at(-1);
            if (previous && from <= previous[1]) previous[1] = Math.max(previous[1], to);
            else merged.push([from, to]);
          }
          let cursor = 0;
          for (const [from, to] of merged) {
            if (cursor < from) {
              const mapped = mapTextEditIndexed(baseSpans, this.indexes.textIndexes, {
                from: baseStarts[spanIndex]! + cursor,
                to: baseStarts[spanIndex]! + from,
                insert: '',
              });
              deletions.push(...mapped.deletions);
              for (const deletion of mapped.deletions) {
                touchedTapes.add(deletion.tapeId);
                textTapes.add(deletion.tapeId);
              }
            }
            cursor = Math.max(cursor, to);
          }
          if (cursor < baseText.length) {
            const mapped = mapTextEditIndexed(baseSpans, this.indexes.textIndexes, {
              from: baseStarts[spanIndex]! + cursor,
              to: baseStarts[spanIndex]! + baseText.length,
              insert: '',
            });
            deletions.push(...mapped.deletions);
            for (const deletion of mapped.deletions) {
              touchedTapes.add(deletion.tapeId);
              textTapes.add(deletion.tapeId);
            }
          }
        }
        touchedNodes.add(node.id);
      }

      const fields: readonly [CellField, unknown][] = [
        ['kind', node.type],
        ['children', node.children],
        ['spans', node.spans.map((span) => span.span)],
        ['marker', node.marker],
        ['checked', node.checked],
        ['info', node.info],
      ];
      for (const [field, value] of fields) {
        if (node.created) {
          if (field === 'children' && node.children.length) {
            writes.push({
              nodeId: node.id,
              field,
              value: [...node.children],
              token: this.allocateId('cell'),
            });
            touchedNodes.add(node.id);
          }
          continue;
        }
        const previous = node.baseCells.get(field)?.value;
        if (!sameValue(previous, value)) {
          writes.push({
            nodeId: node.id,
            field,
            value: deepFreeze(deepCopy(value)),
            token: this.allocateId('cell'),
          });
          touchedNodes.add(node.id);
          for (const span of node.spans) touchedTapes.add(span.span.tapeId);
        }
      }
    }

    for (const node of this.nodes.values()) {
      for (const span of node.spans) {
        for (const piece of span.pieces) {
          if (piece.kind !== 'inserted' || !piece.text) continue;
          touchedTapes.add(piece.anchor.tapeId);
          textTapes.add(piece.anchor.tapeId);
        }
      }
    }

    const textProjection = this.compileTextProjection();
    const insertions = textProjection.insertions;
    for (const boundary of this.transferBoundaries) touchedTapes.add(boundary.tapeId);
    const operationNodeIds = this.operations_.flatMap((operation) => {
      switch (operation.type) {
        case 'transferInlineRange':
          return [operation.transfer.source, operation.transfer.destination];
        case 'insertFragment':
          return [operation.destination];
        default:
          return 'id' in operation ? [operation.id] : [];
      }
    });
    for (const id of operationNodeIds) touchedNodes.add(id);
    this.compiledPlan = Object.freeze({
      allocations: Object.freeze(allocations),
      newTapes: Object.freeze(newTapes),
      boundaries: Object.freeze(
        this.finalTransferBoundaries(textProjection.boundaryOffsets).map((item) =>
          Object.freeze(item),
        ),
      ),
      deletions: Object.freeze(deletions.map((item) => Object.freeze({ ...item }))),
      insertions: Object.freeze(insertions.map((item) => Object.freeze({ ...item }))),
      writes: Object.freeze(writes.map((item) => Object.freeze({ ...item }))),
      touchedNodes: Object.freeze([...touchedNodes]),
      touchedTapes: Object.freeze([...touchedTapes]),
      textTapes: Object.freeze([...textTapes]),
    });
    return this.compiledPlan;
  }

  assertMatches(state: Y.Doc): void {
    this.assertActive();
    const records = nodeMap(state);
    for (const [id, expected] of this.nodes) {
      const record = records.get(id);
      assert(record, `compiled action omitted draft node ${id}`);
      assert(
        readCell<NodeKind>(record, 'kind').value === expected.type,
        `compiled action changed the draft kind for ${id}`,
      );
      assert(
        stableJson(readCell<readonly NodeId[]>(record, 'children').value) ===
          stableJson(expected.children),
        `compiled action changed the draft children for ${id}`,
      );
      const actualSpans = readCell<readonly Span[]>(record, 'spans').value;
      const expectedSpans = expected.spans.map((span) => span.span);
      assert(
        stableJson(actualSpans) === stableJson(expectedSpans),
        `compiled action changed the draft spans for ${id}`,
      );
      assert(
        sameValue(readCell<string | null>(record, 'marker').value, expected.marker) &&
          sameValue(readCell<boolean | null>(record, 'checked').value, expected.checked) &&
          sameValue(readCell<string | null>(record, 'info').value, expected.info),
        `compiled action changed the draft properties for ${id}`,
      );
      if (INLINE_KINDS.has(expected.type)) {
        const actualText = actualSpans.map((span) => spanText(state, span)).join('');
        assert(
          actualText === inlineContent(expected),
          `compiled action text differs from draft intent for ${id}: expected ${JSON.stringify(
            inlineContent(expected),
          )}, got ${JSON.stringify(actualText)}`,
        );
      }
    }
  }

  node(id: NodeId): DraftNode {
    this.assertActive();
    const state = this.requireNode(id);
    const read = <T>(field: CellField, value: () => T): T => {
      this.readField(state, field);
      return value();
    };
    const draft = Object.defineProperties(
      { id },
      {
        type: {
          enumerable: true,
          get: () => read('kind', () => state.type),
        },
        children: {
          enumerable: true,
          get: () => read('children', () => Object.freeze([...state.children])),
        },
        spans: {
          enumerable: true,
          get: () =>
            read('spans', () => {
              if (INLINE_KINDS.has(state.type)) this.readText(state);
              return Object.freeze(state.spans.map((part) => Object.freeze({ ...part.span })));
            }),
        },
        content: {
          enumerable: true,
          get: () => {
            if (!INLINE_KINDS.has(state.type)) return undefined;
            this.readText(state);
            return inlineContent(state);
          },
        },
        marker: {
          enumerable: true,
          get: () => read('marker', () => state.marker),
        },
        checked: {
          enumerable: true,
          get: () => read('checked', () => state.checked),
        },
        info: {
          enumerable: true,
          get: () => read('info', () => state.info),
        },
      },
    ) as DraftNode;
    return Object.freeze(draft);
  }

  parentOf(id: NodeId): NodeId | undefined {
    this.assertActive();
    const node = this.requireNode(id);
    const parentId = this.parentId(node.id);
    if (!parentId) return undefined;
    const parent = this.requireNode(parentId);
    this.readField(parent, 'children');
    assert(parent.children.includes(id), `parent index disagrees about ${id}`);
    return parentId;
  }

  previousSiblingOf(id: NodeId): NodeId | undefined {
    const parentId = this.parentOf(id);
    if (!parentId) return undefined;
    const children = this.node(parentId).children;
    const index = children.indexOf(id);
    assert(index >= 0, `parent index disagrees about ${id}`);
    return index > 0 ? children[index - 1] : undefined;
  }

  nextSiblingOf(id: NodeId): NodeId | undefined {
    const parentId = this.parentOf(id);
    if (!parentId) return undefined;
    const children = this.node(parentId).children;
    const index = children.indexOf(id);
    assert(index >= 0, `parent index disagrees about ${id}`);
    return children[index + 1];
  }

  create(spec: NodeSpec): NodeId {
    this.assertActive();
    const id = this.allocateId('node');
    const operation: SemanticOperation = this.makeCreateOperation(id, spec);
    this.apply(operation, true);
    return id;
  }

  place(id: NodeId, parent: NodeId, before: NodeId | null): void {
    this.apply({ type: 'place', id, parent, before }, true);
  }

  detach(id: NodeId): void {
    this.apply({ type: 'detach', id }, true);
  }

  spliceText(id: NodeId, edit: TextEdit): void {
    this.apply({ type: 'spliceText', id, edit: deepFreeze(deepCopy(edit)) }, true);
  }

  cutInline(id: NodeId, from: number, to: number): InlineFragment {
    const fragmentId = this.allocateId('fragment');
    this.apply({ type: 'cutInline', id, from, to, fragmentId }, true);
    const fragment = this.fragments.get(fragmentId);
    assert(fragment, 'cut did not create a fragment');
    const handle = Object.freeze({ text: fragment.text });
    fragmentIds.set(handle, fragmentId);
    return handle;
  }

  insertFragment(
    destination: NodeId,
    at: number,
    affinity: TextAffinity,
    fragment: InlineFragment,
  ): void {
    const fragmentId = fragmentIds.get(fragment);
    assert(fragmentId, 'fragment was not created by this draft');
    assert(this.fragments.has(fragmentId), 'fragment does not belong to this draft');
    assert(!this.consumedFragments.has(fragmentId), 'fragment has already been inserted');
    this.apply({ type: 'insertFragment', destination, at, affinity, fragmentId }, true);
  }

  transferInlineRange(transfer: Transfer): void {
    if (transfer.source === transfer.destination) {
      this.apply({ type: 'transferInlineRange', transfer: deepFreeze(deepCopy(transfer)) }, true);
      return;
    }
    const fragment = this.cutInline(transfer.source, transfer.from, transfer.to);
    this.insertFragment(transfer.destination, transfer.at, transfer.affinity, fragment);
  }

  convertInline(id: NodeId, plan: ConversionPlan): void {
    this.apply({ type: 'convertInline', id, plan: deepFreeze(deepCopy(plan)) }, true);
  }

  setMarker(id: NodeId, marker: string | null): void {
    this.apply({ type: 'setMarker', id, marker }, true);
  }

  setChecked(id: NodeId, checked: boolean | null): void {
    this.apply({ type: 'setChecked', id, checked }, true);
  }

  setInfo(id: NodeId, info: string | null): void {
    this.apply({ type: 'setInfo', id, info }, true);
  }

  bookmark(id: NodeId, offset: number, affinity: TextAffinity, spanIndex?: number): Bookmark {
    this.assertActive();
    const node = this.requireNode(id);
    assert(INLINE_KINDS.has(node.type), `${node.type} nodes do not have text bookmarks`);
    this.readText(node);
    const content = inlineContent(node);
    assert(
      Number.isInteger(offset) && offset >= 0 && offset <= content.length,
      'bookmark offset is out of bounds',
    );
    assert(!splitSurrogateBoundary(content, offset), 'bookmark splits a surrogate pair');
    if (spanIndex !== undefined) {
      assert(
        spanIndex >= 0 && spanIndex < node.spans.length,
        'bookmark span index is out of range',
      );
    }
    return Object.freeze({
      nodeId: id,
      offset,
      affinity,
      ...(spanIndex === undefined ? {} : { spanIndex }),
    });
  }

  sourcePieces(id: NodeId): readonly DraftTextPiece[] {
    this.assertActive();
    const node = this.requireNode(id);
    assert(INLINE_KINDS.has(node.type), `${node.type} nodes do not have inline text`);
    this.readText(node);
    let from = 0;
    const pieces: DraftTextPiece[] = [];
    for (const span of node.spans) {
      for (const piece of span.pieces) {
        const to = from + piece.text.length;
        if (to > from) pieces.push(Object.freeze({ from, to, kind: piece.kind }));
        from = to;
      }
    }
    return Object.freeze(pieces);
  }

  private apply(operation: SemanticOperation, record: boolean): void {
    this.assertActive();
    switch (operation.type) {
      case 'create':
        this.createWithId(operation);
        break;
      case 'place':
        this.placeInternal(operation.id, operation.parent, operation.before);
        break;
      case 'detach':
        this.detachInternal(operation.id);
        break;
      case 'spliceText':
        this.spliceInternal(operation.id, operation.edit);
        break;
      case 'cutInline':
        this.cutFragmentInternal(operation.id, operation.from, operation.to, operation.fragmentId);
        break;
      case 'insertFragment':
        this.insertFragmentInternal(
          operation.destination,
          operation.at,
          operation.affinity,
          operation.fragmentId,
        );
        break;
      case 'transferInlineRange':
        this.transferInternal(operation.transfer);
        break;
      case 'convertInline':
        this.convertInternal(operation.id, operation.plan);
        break;
      case 'setMarker':
        this.setMarkerInternal(operation.id, operation.marker);
        break;
      case 'setChecked':
        this.setCheckedInternal(operation.id, operation.checked);
        break;
      case 'setInfo':
        this.setInfoInternal(operation.id, operation.info);
        break;
    }
    if (record) this.operations_.push(deepFreeze(deepCopy(operation)));
  }

  private makeCreateOperation(id: NodeId, spec: NodeSpec): SemanticOperation {
    const copied = deepFreeze(deepCopy(spec));
    const span = INLINE_KINDS.has(spec.type)
      ? Object.freeze({
          tapeId: this.allocateId('tape'),
          startBoundaryId: this.allocateId('boundary'),
          endBoundaryId: this.allocateId('boundary'),
        })
      : undefined;
    return deepFreeze({ type: 'create', id, spec: copied, ...(span ? { span } : {}) });
  }

  private createWithId(operation: Extract<SemanticOperation, { type: 'create' }>): void {
    const { id, spec, span } = operation;
    assert(!this.indexes.nodeIds.has(id) && !this.nodes.has(id), `node ID ${id} already exists`);
    this.reserveId(id);
    this.generatedIds.add(id);
    assert(spec.type !== 'document', 'a draft cannot create another document root');
    assert(
      !spec.children?.length,
      'create nodes without children, then place each child explicitly',
    );
    if (INLINE_KINDS.has(spec.type)) assert(span, 'inline node creation requires tape markers');
    else assert(!span, 'non-inline node cannot allocate an inline tape');
    const content = spec.content ?? '';
    assert(
      INLINE_KINDS.has(spec.type) || spec.content === undefined,
      'non-inline nodes cannot have content',
    );
    assert(typeof content === 'string', 'inline content must be text');
    if (span) {
      assert(!this.indexes.tapeIds.has(span.tapeId), `tape ID ${span.tapeId} already exists`);
      this.reserveId(span.tapeId);
      this.reserveId(span.startBoundaryId);
      this.reserveId(span.endBoundaryId);
      this.generatedIds.add(span.tapeId);
      this.newTapeSpans.set(id, span);
    }
    const marker =
      spec.marker ??
      (spec.type === 'section'
        ? '#'
        : spec.type === 'list-item'
          ? '- '
          : spec.type === 'block-quote'
            ? '> '
            : null);
    const state: DraftNodeState = {
      id,
      type: spec.type,
      children: [...(spec.children ?? [])],
      spans: span
        ? [
            {
              span,
              created: true,
              insertionSlot: {
                tapeId: span.tapeId,
                index: 1,
                spanIndex: 0,
                affinity: 'right',
              },
              pieces: content
                ? [
                    this.makeInsertedPiece(
                      {
                        tapeId: span.tapeId,
                        index: 1,
                        spanIndex: 0,
                        affinity: 'right',
                      },
                      content,
                    ),
                  ]
                : [],
            },
          ]
        : [],
      marker,
      checked: spec.checked ?? null,
      info: spec.type === 'code-block' ? (spec.info ?? null) : null,
      baseCells: new Map(),
      created: true,
      textEdited: false,
    };
    this.validateDraftEdit('', { from: 0, to: 0, insert: content });
    this.nodes.set(id, state);
  }

  private makeInsertedPiece(anchor: InsertionSlotTarget, text: string): InsertedPiece {
    const { parentBufferId, parentBufferOffset, ...slot } = anchor;
    const bufferId = this.allocateId('buffer');
    const insertionAnchor: InsertionSlot = { ...slot, order: this.insertionSlotOrder++ };
    assert(
      (parentBufferId === undefined) === (parentBufferOffset === undefined),
      'buffer insertion requires a complete parent slot',
    );
    if (parentBufferId !== undefined && parentBufferOffset !== undefined) {
      const parent = this.textBuffers.get(parentBufferId);
      assert(parent, `missing parent action-local text buffer ${parentBufferId}`);
      assert(
        Number.isInteger(parentBufferOffset) &&
          parentBufferOffset >= 0 &&
          parentBufferOffset <= parent.text.length,
        `insertion is outside parent action-local text buffer ${parentBufferId}`,
      );
    }
    this.textBuffers.set(bufferId, {
      text,
      anchor: insertionAnchor,
      ...(parentBufferId === undefined ? {} : { parentBufferId }),
      ...(parentBufferOffset === undefined ? {} : { parentBufferOffset }),
    });
    return {
      kind: 'inserted',
      bufferId,
      from: 0,
      to: text.length,
      anchor: insertionAnchor,
      text,
    };
  }

  private assertPieceSource(piece: DraftPiece): void {
    if (piece.kind === 'inserted') {
      const buffer = this.textBuffers.get(piece.bufferId);
      assert(buffer !== undefined, `missing action-local text buffer ${piece.bufferId}`);
      assert(
        Number.isInteger(piece.from) &&
          Number.isInteger(piece.to) &&
          piece.from >= 0 &&
          piece.to >= piece.from &&
          piece.to <= buffer.text.length,
        `action-local text slice is outside ${piece.bufferId}`,
      );
      assert(
        piece.text === buffer.text.slice(piece.from, piece.to),
        `action-local text slice diverged from ${piece.bufferId}`,
      );
      return;
    }

    const sourceSpan = this.baseSpans(piece.source)[piece.sourceSpanIndex];
    assert(sourceSpan, `missing source span ${piece.sourceSpanIndex} on ${piece.source}`);
    assert(sourceSpan.tapeId === piece.tapeId, `source tape changed for ${piece.source}`);
    const sourceText = spanText(this.state, sourceSpan, this.indexes);
    assert(
      Number.isInteger(piece.from) &&
        Number.isInteger(piece.to) &&
        piece.from >= 0 &&
        piece.to >= piece.from &&
        piece.to <= sourceText.length,
      `existing text slice is outside ${piece.source}`,
    );
    assert(
      piece.text === sourceText.slice(piece.from, piece.to),
      `existing text slice diverged from ${piece.source}`,
    );
  }

  private placeInternal(id: NodeId, parentId: NodeId, before: NodeId | null): void {
    assert(id !== this.rootId(), 'the document root cannot be placed');
    const node = this.requireNode(id);
    const parent = this.requireNode(parentId);
    this.ensureVisibleOrCreated(node);
    this.ensureVisibleOrCreated(parent);
    this.readField(node, 'kind');
    this.readField(parent, 'kind');
    this.readField(parent, 'children');
    assert(
      allowedChild(parent.type, node.type),
      `${node.type} cannot be a child of ${parent.type}`,
    );
    const oldParentId = this.parentId(id);
    if (oldParentId) this.readField(this.requireNode(oldParentId), 'children');
    if (before !== null) {
      if (before === id) {
        assert(oldParentId === parentId, 'before must be a child of the destination');
        return;
      }
      assert(
        parent.children.includes(before),
        `before node ${before} is not a child of ${parentId}`,
      );
      this.ensureVisibleOrCreated(this.requireNode(before));
    }
    if (oldParentId === parentId && before === id) return;
    if (oldParentId) {
      const oldParent = this.requireNode(oldParentId);
      oldParent.children = oldParent.children.filter((child) => child !== id);
    }
    const target = this.requireNode(parentId);
    const index = before === null ? target.children.length : target.children.indexOf(before);
    assert(index >= 0, `before node ${before} is not a child of ${parentId}`);
    target.children.splice(index, 0, id);
    this.parentOverlay.set(id, parentId);
  }

  private detachInternal(id: NodeId): void {
    assert(id !== this.rootId(), 'the document root cannot be detached');
    const node = this.requireNode(id);
    const parentId = this.parentId(id);
    assert(parentId, `node ${id} is already detached`);
    this.ensureVisibleOrCreated(node);
    const parent = this.requireNode(parentId);
    this.readField(parent, 'children');
    parent.children = parent.children.filter((child) => child !== id);
    this.parentOverlay.set(id, null);
  }

  private spliceInternal(id: NodeId, edit: TextEdit): void {
    const node = this.requireNode(id);
    this.ensureVisibleOrCreated(node);
    assert(INLINE_KINDS.has(node.type), `${node.type} nodes do not have inline text`);
    this.readText(node);
    const content = inlineContent(node);
    this.validateDraftEdit(content, edit);
    if (content.slice(0, edit.from) + edit.insert + content.slice(edit.to) === content) return;
    const affinity = edit.affinity ?? (edit.from === content.length ? 'left' : 'right');
    const target = this.insertionTarget(node, edit.from, affinity);

    let start = 0;
    for (let spanIndex = 0; spanIndex < node.spans.length; spanIndex++) {
      const span = node.spans[spanIndex]!;
      const length = span.pieces.reduce((total, piece) => total + piece.text.length, 0);
      const removeFrom = Math.max(0, edit.from - start);
      const removeTo = Math.min(length, edit.to - start);
      if (removeFrom < removeTo) {
        for (const piece of slicePieces(span.pieces, removeFrom, removeTo)) {
          if (piece.kind === 'existing') {
            const source = this.requireNode(piece.source);
            this.readText(source);
            source.textEdited = true;
          }
        }
        span.pieces = [
          ...slicePieces(span.pieces, 0, removeFrom),
          ...slicePieces(span.pieces, removeTo, length),
        ];
      }
      start += length;
    }

    if (edit.insert) {
      const targetSpan = node.spans[target.spanIndex];
      assert(targetSpan, 'text insertion span disappeared');
      const local = Math.min(
        target.localOffset,
        targetSpan.pieces.reduce((total, piece) => total + piece.text.length, 0),
      );
      const pieces = targetSpan.pieces;
      const inserted: InsertedPiece = {
        ...this.makeInsertedPiece(target.anchor, edit.insert),
      };
      targetSpan.pieces = [
        ...slicePieces(pieces, 0, local),
        inserted,
        ...slicePieces(pieces, local, Number.MAX_SAFE_INTEGER),
      ];
    }
    node.textEdited ||= content !== inlineContent(node);
  }

  private validateDraftEdit(content: string, edit: TextEdit): void {
    assert(
      Number.isInteger(edit.from) && Number.isInteger(edit.to),
      'text range offsets must be integers',
    );
    assert(
      edit.from >= 0 && edit.to >= edit.from && edit.to <= content.length,
      'text range is out of bounds',
    );
    assert(
      !splitSurrogateBoundary(content, edit.from) && !splitSurrogateBoundary(content, edit.to),
      'text range splits a surrogate pair',
    );
    for (let index = 0; index < edit.insert.length; index++) {
      const unit = edit.insert.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = edit.insert.charCodeAt(index + 1);
        assert(
          next >= 0xdc00 && next <= 0xdfff,
          'inserted text contains an unpaired high surrogate',
        );
        index++;
      } else {
        assert(
          !(unit >= 0xdc00 && unit <= 0xdfff),
          'inserted text contains an unpaired low surrogate',
        );
      }
    }
  }

  private insertionTarget(
    node: DraftNodeState,
    offset: number,
    affinity: TextAffinity,
  ): { spanIndex: number; localOffset: number; anchor: InsertionSlotTarget } {
    let global = 0;
    const spans = node.spans.map((span, index) => {
      const length = span.pieces.reduce((total, piece) => total + piece.text.length, 0);
      const result = { span, index, start: global, end: global + length, length };
      global += length;
      return result;
    });
    const touching = spans.filter((span) => span.start <= offset && offset <= span.end);
    assert(touching.length > 0, 'no insertion span contains the offset');
    const target = affinity === 'left' ? touching[0]! : touching.at(-1)!;
    const localOffset = offset - target.start;
    if (!target.span.pieces.length) {
      const insertionSlot = target.span.insertionSlot;
      if (insertionSlot) {
        return {
          spanIndex: target.index,
          localOffset,
          anchor: { ...insertionSlot, affinity },
        };
      }
      if (target.span.created) {
        return {
          spanIndex: target.index,
          localOffset,
          anchor: {
            tapeId: target.span.span.tapeId,
            index: 1,
            spanIndex: target.index,
            affinity,
          },
        };
      }
    }

    let pieceStart = 0;
    let chosen: { piece: DraftPiece; local: number } | undefined;
    for (const piece of target.span.pieces) {
      const end = pieceStart + piece.text.length;
      if (pieceStart < localOffset && localOffset < end) {
        chosen = { piece, local: localOffset - pieceStart };
        break;
      }
      if (localOffset === pieceStart && affinity === 'right') {
        chosen = { piece, local: 0 };
        break;
      }
      if (localOffset === end && affinity === 'left') chosen = { piece, local: piece.text.length };
      pieceStart = end;
    }
    if (!chosen) {
      const candidate = affinity === 'left' ? target.span.pieces.at(-1) : target.span.pieces[0];
      if (candidate) {
        chosen = {
          piece: candidate,
          local: affinity === 'left' ? candidate.text.length : 0,
        };
      }
    }
    if (chosen?.piece.kind === 'inserted') {
      return {
        spanIndex: target.index,
        localOffset,
        anchor: {
          ...chosen.piece.anchor,
          affinity,
          parentBufferId: chosen.piece.bufferId,
          parentBufferOffset: chosen.piece.from + chosen.local,
        },
      };
    }
    const source = chosen?.piece;
    if (source?.kind === 'existing') {
      const sourceSpan = this.baseSpans(source.source)[source.sourceSpanIndex];
      assert(sourceSpan, 'existing source span is missing');
      const sourceOffset = source.from + chosen!.local;
      const map = mapTextEdit([sourceSpan], this.tapesFor([sourceSpan]), {
        from: sourceOffset,
        to: sourceOffset,
        insert: '',
        affinity,
      });
      return { spanIndex: target.index, localOffset, anchor: map.insertion };
    }
    const map = mapTextEdit([target.span.span], this.tapesFor([target.span.span]), {
      from: localOffset,
      to: localOffset,
      insert: '',
      affinity,
    });
    return { spanIndex: target.index, localOffset, anchor: map.insertion };
  }

  private transferInternal(transfer: Transfer): void {
    const source = this.requireNode(transfer.source);
    const destination = this.requireNode(transfer.destination);
    this.ensureVisibleOrCreated(source);
    this.ensureVisibleOrCreated(destination);
    assert(
      INLINE_KINDS.has(source.type) && INLINE_KINDS.has(destination.type),
      'transfers require inline nodes',
    );
    this.readText(source);
    if (source.id === destination.id) {
      this.reorderInlineRange(source, transfer);
      return;
    }
    this.readText(destination);
    const destinationContent = inlineContent(destination);
    assert(
      Number.isInteger(transfer.at) && transfer.at >= 0 && transfer.at <= destinationContent.length,
      'transfer destination is out of bounds',
    );
    assert(
      !splitSurrogateBoundary(destinationContent, transfer.at),
      'transfer destination splits a surrogate pair',
    );
    const fragmentId = this.allocateId('fragment');
    this.cutFragmentInternal(source.id, transfer.from, transfer.to, fragmentId);
    this.insertFragmentInternal(destination.id, transfer.at, transfer.affinity, fragmentId);
  }

  private cutFragmentInternal(id: NodeId, from: number, to: number, fragmentId: string): void {
    assert(!this.fragments.has(fragmentId), `fragment ${fragmentId} already exists`);
    const node = this.requireNode(id);
    this.ensureVisibleOrCreated(node);
    assert(INLINE_KINDS.has(node.type), `${node.type} nodes do not have inline text`);
    this.readText(node);
    const content = inlineContent(node);
    assert(Number.isInteger(from) && Number.isInteger(to), 'cut offsets must be integers');
    assert(from >= 0 && to > from && to <= content.length, 'cut range is out of bounds');
    assert(
      !splitSurrogateBoundary(content, from) && !splitSurrogateBoundary(content, to),
      'cut range splits a surrogate pair',
    );
    const cut = this.cutSourceRange(node, from, to);
    node.spans = cut.remaining;
    this.fragments.set(fragmentId, {
      spans: cut.moved,
      text: cut.moved.flatMap((span) => span.pieces.map((piece) => piece.text)).join(''),
    });
  }

  private insertFragmentInternal(
    destinationId: NodeId,
    at: number,
    affinity: TextAffinity,
    fragmentId: string,
  ): void {
    const fragment = this.fragments.get(fragmentId);
    assert(fragment, `unknown fragment ${fragmentId}`);
    assert(!this.consumedFragments.has(fragmentId), `fragment ${fragmentId} was already used`);
    const destination = this.requireNode(destinationId);
    this.ensureVisibleOrCreated(destination);
    assert(INLINE_KINDS.has(destination.type), 'fragments require an inline destination');
    this.readText(destination);
    const content = inlineContent(destination);
    assert(
      Number.isInteger(at) && at >= 0 && at <= content.length,
      'fragment target is out of bounds',
    );
    assert(!splitSurrogateBoundary(content, at), 'fragment target splits a surrogate pair');
    destination.spans = this.insertTransferAt(destination, at, affinity, fragment.spans);
    this.consumedFragments.add(fragmentId);
  }

  private cutSourceRange(
    node: DraftNodeState,
    from: number,
    to: number,
  ): { remaining: DraftSpan[]; moved: DraftSpan[] } {
    const remaining: DraftSpan[] = [];
    const moved: DraftSpan[] = [];
    let global = 0;
    for (let index = 0; index < node.spans.length; index++) {
      const current = node.spans[index]!;
      const text = current.pieces.map((piece) => piece.text).join('');
      const spanStart = global;
      const spanEnd = global + text.length;
      global = spanEnd;
      const localFrom = Math.max(0, from - spanStart);
      const localTo = Math.min(text.length, to - spanStart);
      if (localFrom >= localTo) {
        remaining.push(current);
        continue;
      }
      const span = current.span;
      const fullSpan = localFrom === 0 && localTo === text.length;
      if (
        fullSpan &&
        node.spans.length > 1 &&
        current.pieces.every((piece) => piece.kind === 'inserted')
      ) {
        moved.push(current);
        continue;
      }
      const startBoundary =
        localFrom === 0 && !fullSpan
          ? span.startBoundaryId
          : this.cutBoundary(node, current, localFrom, 'start');
      const endBoundary =
        localTo === text.length && !fullSpan
          ? span.endBoundaryId
          : this.cutBoundary(node, current, localTo, 'end');
      if (localFrom > 0 || fullSpan) {
        const left = { ...span, endBoundaryId: startBoundary };
        const insertionSlot =
          this.transferBoundarySlots.get(startBoundary) ?? current.insertionSlot;
        remaining.push({
          span: left,
          sourceSpanIndex: current.sourceSpanIndex,
          pieces: slicePieces(current.pieces, 0, localFrom),
          created: current.created,
          ...(insertionSlot ? { insertionSlot } : {}),
        });
      }
      const insertionSlot = this.transferBoundarySlots.get(startBoundary) ?? current.insertionSlot;
      moved.push({
        span: { ...span, startBoundaryId: startBoundary, endBoundaryId: endBoundary },
        sourceSpanIndex: current.sourceSpanIndex,
        pieces: slicePieces(current.pieces, localFrom, localTo),
        created: current.created,
        ...(insertionSlot ? { insertionSlot } : {}),
      });
      if (localTo < text.length || fullSpan) {
        const right = { ...span, startBoundaryId: endBoundary };
        const rightInsertionSlot =
          this.transferBoundarySlots.get(endBoundary) ?? current.insertionSlot;
        remaining.push({
          span: right,
          sourceSpanIndex: current.sourceSpanIndex,
          pieces: slicePieces(current.pieces, localTo, text.length),
          created: current.created,
          ...(rightInsertionSlot ? { insertionSlot: rightInsertionSlot } : {}),
        });
      }
    }
    assert(moved.length > 0, 'cut range has no source span');
    return { remaining, moved };
  }

  private reorderInlineRange(node: DraftNodeState, transfer: Transfer): void {
    const content = inlineContent(node);
    assert(
      Number.isInteger(transfer.from) &&
        Number.isInteger(transfer.to) &&
        transfer.from >= 0 &&
        transfer.to > transfer.from &&
        transfer.to <= content.length,
      'transfer range is out of bounds',
    );
    assert(
      !splitSurrogateBoundary(content, transfer.from) &&
        !splitSurrogateBoundary(content, transfer.to),
      'transfer splits a surrogate pair',
    );
    assert(
      Number.isInteger(transfer.at) && transfer.at >= 0 && transfer.at <= content.length,
      'transfer destination is out of bounds',
    );
    assert(
      !splitSurrogateBoundary(content, transfer.at),
      'transfer destination splits a surrogate pair',
    );
    if (transfer.at === transfer.from || transfer.at === transfer.to) return;
    assert(
      !(transfer.from < transfer.at && transfer.at < transfer.to),
      'same-node destination cannot be inside the transferred range',
    );

    const segments: { readonly draft: DraftSpan; readonly from: number; readonly to: number }[] =
      [];
    let globalStart = 0;
    for (let spanIndex = 0; spanIndex < node.spans.length; spanIndex++) {
      const current = node.spans[spanIndex]!;
      const spanContent = current.pieces.map((piece) => piece.text).join('');
      const localCuts = [transfer.from, transfer.to, transfer.at]
        .map((cut) => cut - globalStart)
        .filter((cut) => cut > 0 && cut < spanContent.length)
        .sort((a, b) => a - b);
      const boundaries = new Map<number, string>([
        [0, current.span.startBoundaryId],
        [spanContent.length, current.span.endBoundaryId],
      ]);
      for (const local of localCuts) {
        const absolute = globalStart + local;
        const affinity =
          absolute === transfer.at
            ? transfer.affinity
            : absolute === transfer.from
              ? 'right'
              : 'left';
        boundaries.set(
          local,
          this.cutBoundary(
            node,
            current,
            local,
            absolute === transfer.to ? 'end' : 'start',
            affinity,
          ),
        );
      }
      const positions = [...new Set([0, ...localCuts, spanContent.length])].sort((a, b) => a - b);
      for (let index = 0; index < positions.length - 1; index++) {
        const from = positions[index]!;
        const to = positions[index + 1]!;
        const insertionSlot =
          this.transferBoundarySlots.get(boundaries.get(from)!) ?? current.insertionSlot;
        segments.push({
          draft: {
            span: {
              ...current.span,
              startBoundaryId: boundaries.get(from)!,
              endBoundaryId: boundaries.get(to)!,
            },
            sourceSpanIndex: current.sourceSpanIndex,
            pieces: slicePieces(current.pieces, from, to),
            created: current.created,
            ...(insertionSlot ? { insertionSlot } : {}),
          },
          from: globalStart + from,
          to: globalStart + to,
        });
      }
      globalStart += spanContent.length;
    }

    const moved = segments.filter(
      (segment) =>
        segment.to > segment.from && segment.from >= transfer.from && segment.to <= transfer.to,
    );
    assert(moved.length > 0, 'transfer range has no source span');
    const movedSet = new Set(moved);
    const remaining = segments.filter((segment) => !movedSet.has(segment));
    const adjustedAt =
      transfer.at < transfer.from ? transfer.at : transfer.at - (transfer.to - transfer.from);
    let accumulated = 0;
    let insertionIndex = remaining.length;
    for (let index = 0; index < remaining.length; index++) {
      const segment = remaining[index]!;
      const length = segment.to - segment.from;
      if (adjustedAt < accumulated + length) {
        insertionIndex = index;
        break;
      }
      accumulated += length;
      if (adjustedAt === accumulated) {
        insertionIndex = index + 1;
        break;
      }
    }
    node.spans = [
      ...remaining.slice(0, insertionIndex).map((segment) => segment.draft),
      ...moved.map((segment) => segment.draft),
      ...remaining.slice(insertionIndex).map((segment) => segment.draft),
    ];
  }

  private cutBoundary(
    node: DraftNodeState,
    current: DraftSpan,
    offset: number,
    role: 'start' | 'end',
    affinity?: TextAffinity,
  ): string {
    const content = current.pieces.map((piece) => piece.text).join('');
    assert(offset >= 0 && offset <= content.length, 'transfer boundary is outside its source span');
    const resolvedAffinity = affinity ?? (role === 'start' ? 'right' : 'left');
    let cursor = 0;
    let chosen: { piece: DraftPiece; local: number } | undefined;
    for (const piece of current.pieces) {
      const end = cursor + piece.text.length;
      if (cursor < offset && offset < end) {
        chosen = { piece, local: offset - cursor };
        break;
      }
      if (offset === cursor && resolvedAffinity === 'right') {
        chosen = { piece, local: 0 };
        break;
      }
      if (offset === end && resolvedAffinity === 'left') {
        chosen = { piece, local: piece.text.length };
      }
      cursor = end;
    }

    let mapped: ReturnType<typeof mapTextEdit>['insertion'];
    if (chosen?.piece.kind === 'inserted') {
      mapped = {
        tapeId: chosen.piece.anchor.tapeId,
        index: chosen.piece.anchor.index,
        spanIndex: chosen.piece.anchor.spanIndex,
        affinity: resolvedAffinity,
      };
    } else if (chosen?.piece.kind === 'existing') {
      const sourceSpan = this.baseSpans(chosen.piece.source)[chosen.piece.sourceSpanIndex];
      assert(sourceSpan, 'existing transfer source span is missing');
      mapped = mapTextEdit([sourceSpan], this.tapesFor([sourceSpan]), {
        from: chosen.piece.from + chosen.local,
        to: chosen.piece.from + chosen.local,
        insert: '',
        affinity: resolvedAffinity,
      }).insertion;
    } else {
      mapped = mapTextEdit([current.span], this.tapesFor([current.span]), {
        from: offset,
        to: offset,
        insert: '',
        affinity: resolvedAffinity,
      }).insertion;
    }
    let insertionOffset = 0;
    let foundBoundaryPiece = false;
    for (const span of node.spans) {
      for (const piece of span.pieces) {
        if (chosen && span === current && piece === chosen.piece) {
          if (piece.kind === 'inserted') insertionOffset += chosen.local;
          foundBoundaryPiece = true;
          break;
        }
        if (
          piece.kind === 'inserted' &&
          piece.anchor.tapeId === mapped.tapeId &&
          piece.anchor.index === mapped.index
        ) {
          insertionOffset += piece.text.length;
        }
      }
      if (foundBoundaryPiece) break;
    }
    const boundaryId = this.allocateId('boundary');
    const insertionSlot: InsertionSlotTarget = {
      tapeId: mapped.tapeId,
      index: mapped.index,
      spanIndex: mapped.spanIndex,
      affinity: resolvedAffinity,
      ...(chosen?.piece.kind === 'inserted'
        ? {
            parentBufferId: chosen.piece.bufferId,
            parentBufferOffset: chosen.piece.from + chosen.local,
          }
        : {}),
    };
    this.transferBoundarySlots.set(boundaryId, insertionSlot);
    this.transferBoundaries.push({
      tapeId: mapped.tapeId,
      index: mapped.index,
      boundaryId,
      insertionOffset,
      side: role,
      order: this.transferBoundaries.length,
      ...(chosen?.piece.kind === 'inserted'
        ? {
            sourceBufferId: chosen.piece.bufferId,
            sourceBufferOffset: chosen.piece.from + chosen.local,
          }
        : {}),
    });
    return boundaryId;
  }

  private compileTextProjection(): {
    readonly insertions: readonly PlanTextInsert[];
    readonly boundaryOffsets: ReadonlyMap<string, number>;
  } {
    interface SemanticPosition {
      readonly path: readonly number[];
      readonly spanIndex: number;
      readonly pieceIndex: number;
      readonly subIndex: number;
    }
    interface ProjectionEvent {
      readonly id: string;
      readonly groupKey: string;
      readonly sequence: number;
      readonly kind: 'text' | 'boundary';
      readonly text?: string;
      readonly bufferId?: string;
      readonly from?: number;
      readonly slotKey?: readonly number[];
      readonly boundary?: PlanBoundary;
      position?: SemanticPosition;
    }

    const groupKey = (tapeId: TapeId, index: number): string => JSON.stringify([tapeId, index]);
    const comparePositions = (left: SemanticPosition, right: SemanticPosition): number => {
      const commonLength = Math.min(left.path.length, right.path.length);
      for (let index = 0; index < commonLength; index++) {
        const difference = left.path[index]! - right.path[index]!;
        if (difference) return difference;
      }
      return (
        left.path.length - right.path.length ||
        left.spanIndex - right.spanIndex ||
        left.pieceIndex - right.pieceIndex ||
        left.subIndex - right.subIndex
      );
    };
    const pathByNode = new Map<NodeId, readonly number[] | undefined>();
    const pathForNode = (id: NodeId): readonly number[] | undefined => {
      if (pathByNode.has(id)) return pathByNode.get(id);
      const path: number[] = [];
      let current = id;
      const root = this.rootId();
      while (current !== root) {
        const parentId = this.parentId(current);
        if (!parentId) {
          pathByNode.set(id, undefined);
          return undefined;
        }
        const parent = this.requireNode(parentId);
        const index = parent.children.indexOf(current);
        if (index < 0) {
          pathByNode.set(id, undefined);
          return undefined;
        }
        path.push(index);
        current = parentId;
      }
      path.reverse();
      pathByNode.set(id, path);
      return path;
    };

    const referencedBoundaries = new Set<string>();
    for (const node of this.nodes.values()) {
      for (const span of node.spans) {
        referencedBoundaries.add(span.span.startBoundaryId);
        referencedBoundaries.add(span.span.endBoundaryId);
      }
    }
    const boundaryPlans = new Map(
      this.transferBoundaries
        .filter((boundary) => referencedBoundaries.has(boundary.boundaryId))
        .map((boundary) => [boundary.boundaryId, boundary]),
    );
    const splitOffsets = new Map<string, Set<number>>();
    const addSplitOffset = (bufferId: string, offset: number): void => {
      const offsets = splitOffsets.get(bufferId) ?? new Set<number>();
      offsets.add(offset);
      splitOffsets.set(bufferId, offsets);
    };
    for (const [bufferId, buffer] of this.textBuffers) {
      if (buffer.parentBufferId !== undefined) {
        const parent = this.textBuffers.get(buffer.parentBufferId);
        assert(parent, `missing parent action-local text buffer ${buffer.parentBufferId}`);
        assert(
          buffer.parentBufferOffset !== undefined &&
            Number.isInteger(buffer.parentBufferOffset) &&
            buffer.parentBufferOffset >= 0 &&
            buffer.parentBufferOffset <= parent.text.length,
          `invalid parent offset for action-local text buffer ${bufferId}`,
        );
        addSplitOffset(buffer.parentBufferId, buffer.parentBufferOffset);
      }
    }
    for (const boundary of boundaryPlans.values()) {
      if (boundary.sourceBufferId && boundary.sourceBufferOffset !== undefined) {
        addSplitOffset(boundary.sourceBufferId, boundary.sourceBufferOffset);
      }
    }

    const liveRanges = new Map<string, [number, number][]>();
    const eventsByGroup = new Map<string, Map<string, ProjectionEvent>>();
    const eventsById = new Map<string, ProjectionEvent>();
    const boundaryEventIds = new Map<string, string>();
    const constraints = new Map<string, Map<string, Set<string>>>();
    let eventSequence = 0;
    let eventId = 0;

    const addEvent = (event: ProjectionEvent): void => {
      const events = eventsByGroup.get(event.groupKey) ?? new Map<string, ProjectionEvent>();
      assert(!events.has(event.id), `duplicate projection event ${event.id}`);
      events.set(event.id, event);
      eventsById.set(event.id, event);
      eventsByGroup.set(event.groupKey, events);
    };
    const slotKeyForBufferOffset = (id: string, offset: number): readonly number[] => {
      const chain: DraftTextBuffer[] = [];
      let currentId = id;
      let current = this.textBuffers.get(currentId);
      assert(current, `missing action-local text buffer ${currentId}`);
      while (current) {
        chain.push(current);
        if (current.parentBufferId === undefined) break;
        currentId = current.parentBufferId;
        current = this.textBuffers.get(currentId);
        assert(current, `missing parent action-local text buffer ${currentId}`);
      }
      chain.reverse();
      const root = chain[0]!;
      const key = [Number(root.anchor.affinity === 'right'), root.anchor.order];
      for (const buffer of chain.slice(1)) {
        key.push(
          buffer.parentBufferOffset!,
          0,
          Number(buffer.anchor.affinity === 'right'),
          buffer.anchor.order,
        );
      }
      key.push(offset, 1);
      return Object.freeze(key);
    };
    const boundaryEvent = (
      boundaryId: string,
      position: SemanticPosition | undefined,
    ): ProjectionEvent | undefined => {
      const boundary = boundaryPlans.get(boundaryId);
      if (!boundary) return undefined;
      const existingId = boundaryEventIds.get(boundaryId);
      if (existingId) {
        const existing = eventsById.get(existingId);
        assert(existing, `missing projection boundary event ${existingId}`);
        if (position && (!existing.position || comparePositions(position, existing.position) < 0)) {
          existing.position = position;
        }
        return existing;
      }
      const event: ProjectionEvent = {
        id: `boundary:${boundaryId}`,
        groupKey: groupKey(boundary.tapeId, boundary.index),
        sequence: eventSequence++,
        kind: 'boundary',
        boundary,
        ...(position ? { position } : {}),
      };
      boundaryEventIds.set(boundaryId, event.id);
      addEvent(event);
      return event;
    };
    const addTextPiece = (
      piece: InsertedPiece,
      spanIndex: number,
      pieceIndex: number,
      path: readonly number[] | undefined,
      spanSequence: Map<string, string[]>,
    ): void => {
      const ranges = liveRanges.get(piece.bufferId) ?? [];
      ranges.push([piece.from, piece.to]);
      liveRanges.set(piece.bufferId, ranges);
      const buffer = this.textBuffers.get(piece.bufferId);
      assert(buffer, `missing action-local text buffer ${piece.bufferId}`);
      const key = groupKey(buffer.anchor.tapeId, buffer.anchor.index);
      const offsets = [...(splitOffsets.get(piece.bufferId) ?? [])]
        .filter((offset) => piece.from < offset && offset < piece.to)
        .sort((a, b) => a - b);
      const starts = [piece.from, ...offsets];
      const ends = [...offsets, piece.to];
      for (let chunkIndex = 0; chunkIndex < starts.length; chunkIndex++) {
        const from = starts[chunkIndex]!;
        const to = ends[chunkIndex]!;
        if (from >= to) continue;
        const event: ProjectionEvent = {
          id: `text:${eventId++}`,
          groupKey: key,
          sequence: eventSequence++,
          kind: 'text',
          text: buffer.text.slice(from, to),
          bufferId: piece.bufferId,
          from,
          slotKey: slotKeyForBufferOffset(piece.bufferId, from),
          ...(path ? { position: { path, spanIndex, pieceIndex, subIndex: chunkIndex } } : {}),
        };
        addEvent(event);
        const sequence = spanSequence.get(key) ?? [];
        sequence.push(event.id);
        spanSequence.set(key, sequence);
      }
      assert(piece.text === buffer.text.slice(piece.from, piece.to), 'text piece changed in draft');
    };

    for (const node of this.nodes.values()) {
      const path = pathForNode(node.id);
      for (const [spanIndex, span] of node.spans.entries()) {
        const spanSequence = new Map<string, string[]>();
        const startPlan = boundaryPlans.get(span.span.startBoundaryId);
        if (startPlan) {
          const event = boundaryEvent(
            span.span.startBoundaryId,
            path
              ? {
                  path,
                  spanIndex,
                  pieceIndex: -1,
                  subIndex: 0,
                }
              : undefined,
          );
          if (event) {
            const sequence = spanSequence.get(event.groupKey) ?? [];
            sequence.push(event.id);
            spanSequence.set(event.groupKey, sequence);
          }
        }
        for (const [pieceIndex, piece] of span.pieces.entries()) {
          if (piece.kind === 'inserted' && piece.text) {
            addTextPiece(piece, spanIndex, pieceIndex, path, spanSequence);
          }
        }
        const endPlan = boundaryPlans.get(span.span.endBoundaryId);
        if (endPlan) {
          const event = boundaryEvent(
            span.span.endBoundaryId,
            path
              ? {
                  path,
                  spanIndex,
                  pieceIndex: span.pieces.length,
                  subIndex: 0,
                }
              : undefined,
          );
          if (event) {
            const sequence = spanSequence.get(event.groupKey) ?? [];
            sequence.push(event.id);
            spanSequence.set(event.groupKey, sequence);
          }
        }
        for (const [key, sequence] of spanSequence) {
          const edges = constraints.get(key) ?? new Map<string, Set<string>>();
          let previous: string | undefined;
          for (const current of sequence) {
            if (current === previous) continue;
            if (previous) {
              const successors = edges.get(previous) ?? new Set<string>();
              successors.add(current);
              edges.set(previous, successors);
            }
            previous = current;
          }
          constraints.set(key, edges);
        }
      }
    }

    for (const ranges of liveRanges.values()) {
      ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let end = -1;
      for (const [from, to] of ranges) {
        assert(from >= end, 'action-local text buffer has overlapping final ownership');
        end = Math.max(end, to);
      }
    }

    const compareEvents = (left: ProjectionEvent, right: ProjectionEvent): number => {
      if (left.position && right.position) {
        const positionOrder = comparePositions(left.position, right.position);
        if (positionOrder) return positionOrder;
      } else if (left.position) return -1;
      else if (right.position) return 1;

      const tiePriority = (event: ProjectionEvent): number => {
        if (event.kind === 'text') return 1;
        return event.boundary?.side === 'end' ? 0 : 2;
      };
      const priorityOrder = tiePriority(left) - tiePriority(right);
      if (priorityOrder) return priorityOrder;

      if (left.kind === 'text' && right.kind === 'text') {
        const leftKey = left.slotKey!;
        const rightKey = right.slotKey!;
        const pathLength = Math.min(leftKey.length, rightKey.length);
        for (let index = 0; index < pathLength; index++) {
          const difference = leftKey[index]! - rightKey[index]!;
          if (difference) return difference;
        }
        if (leftKey.length !== rightKey.length) return leftKey.length - rightKey.length;
      } else if (left.kind === 'boundary' && right.kind === 'boundary') {
        const boundaryOrder = (left.boundary?.order ?? 0) - (right.boundary?.order ?? 0);
        if (boundaryOrder) return boundaryOrder;
      }
      return left.sequence - right.sequence || left.id.localeCompare(right.id);
    };

    const boundaryOffsets = new Map<string, number>();
    const insertions: PlanTextInsert[] = [];
    for (const [key, events] of eventsByGroup) {
      const graph = constraints.get(key);
      const indegree = new Map([...events.keys()].map((id) => [id, 0]));
      for (const [from, successors] of graph ?? []) {
        if (!indegree.has(from)) continue;
        for (const to of successors) {
          if (indegree.has(to)) indegree.set(to, indegree.get(to)! + 1);
        }
      }

      const remaining = new Set(events.keys());
      const ordered: ProjectionEvent[] = [];
      while (remaining.size) {
        const ready = [...remaining]
          .filter((id) => indegree.get(id) === 0)
          .map((id) => events.get(id)!)
          .sort(compareEvents);
        assert(ready.length > 0, 'shared-gap fragment ordering contains a cycle');
        const next = ready[0]!;
        remaining.delete(next.id);
        ordered.push(next);
        for (const successor of graph?.get(next.id) ?? []) {
          if (indegree.has(successor)) indegree.set(successor, indegree.get(successor)! - 1);
        }
      }

      const chunks: string[] = [];
      let laneLength = 0;
      let slotOrder = Number.MAX_SAFE_INTEGER;
      let tapeId: TapeId | undefined;
      let index: number | undefined;
      for (const event of ordered) {
        if (event.kind === 'boundary') {
          boundaryOffsets.set(event.boundary!.boundaryId, laneLength);
          tapeId = event.boundary!.tapeId;
          index = event.boundary!.index;
          continue;
        }
        chunks.push(event.text!);
        laneLength += event.text!.length;
        const buffer = this.textBuffers.get(event.bufferId!)!;
        tapeId = buffer.anchor.tapeId;
        index = buffer.anchor.index;
        slotOrder = Math.min(slotOrder, buffer.anchor.order);
      }
      const text = chunks.join('');
      if (text) {
        assert(tapeId !== undefined && index !== undefined, 'text lane has no insertion target');
        insertions.push({ tapeId, index, slotOrder, text });
      }
    }

    return { insertions, boundaryOffsets };
  }

  private finalTransferBoundaries(boundaryOffsets: ReadonlyMap<string, number>): PlanBoundary[] {
    const referenced = new Set<string>();
    for (const node of this.nodes.values()) {
      for (const span of node.spans) {
        referenced.add(span.span.startBoundaryId);
        referenced.add(span.span.endBoundaryId);
      }
    }

    return this.transferBoundaries.flatMap((boundary) => {
      if (!referenced.has(boundary.boundaryId)) {
        return boundary.sourceBufferId ? [] : [{ ...boundary }];
      }
      const insertionOffset = boundaryOffsets.get(boundary.boundaryId);
      assert(
        insertionOffset !== undefined,
        `missing final position for transfer boundary ${boundary.boundaryId}`,
      );
      return [{ ...boundary, insertionOffset }];
    });
  }

  private insertTransferAt(
    node: DraftNodeState,
    offset: number,
    affinity: TextAffinity,
    moved: readonly DraftSpan[],
  ): DraftSpan[] {
    let global = 0;
    const location = node.spans.map((span, index) => {
      const length = span.pieces.reduce((total, piece) => total + piece.text.length, 0);
      const value = { span, index, start: global, end: global + length, length };
      global += length;
      return value;
    });
    const touching = location.filter((span) => span.start <= offset && offset <= span.end);
    assert(touching.length > 0, 'transfer destination has no insertion span');
    const target = affinity === 'left' ? touching[0]! : touching.at(-1)!;
    const local = offset - target.start;
    const result: DraftSpan[] = [];
    for (let index = 0; index < node.spans.length; index++) {
      if (index !== target.index) {
        result.push(node.spans[index]!);
        continue;
      }
      const current = target.span;
      const content = current.pieces.map((piece) => piece.text).join('');
      if (local === 0 && (content.length > 0 || affinity === 'right')) {
        result.push(...moved, current);
      } else if (local === content.length && (content.length > 0 || affinity === 'left')) {
        result.push(current, ...moved);
      } else {
        const cutId = this.cutBoundary(node, current, local, affinity === 'left' ? 'end' : 'start');
        const leftSpan = { ...current.span, endBoundaryId: cutId };
        const rightSpan = { ...current.span, startBoundaryId: cutId };
        const insertionSlot = this.transferBoundarySlots.get(cutId) ?? current.insertionSlot;
        result.push(
          {
            span: leftSpan,
            sourceSpanIndex: current.sourceSpanIndex,
            pieces: slicePieces(current.pieces, 0, local),
            created: current.created,
            ...(insertionSlot ? { insertionSlot } : {}),
          },
          ...moved,
          {
            span: rightSpan,
            sourceSpanIndex: current.sourceSpanIndex,
            pieces: slicePieces(current.pieces, local, content.length),
            created: current.created,
            ...(insertionSlot ? { insertionSlot } : {}),
          },
        );
      }
    }
    return result;
  }

  private convertInternal(id: NodeId, plan: ConversionPlan): void {
    const node = this.requireNode(id);
    this.ensureVisibleOrCreated(node);
    this.readField(node, 'kind');
    this.readField(node, 'marker');
    this.readField(node, 'info');
    assert(INLINE_KINDS.has(node.type), 'only inline nodes can be converted');
    assert(INLINE_KINDS.has(plan.type), 'inline conversion target is invalid');
    if (node.type !== 'section' && plan.type !== 'section') {
      this.readField(node, 'children');
      assert(node.children.length === 0, 'only sections can own children after conversion');
    }
    this.readText(node);
    if (plan.content?.mode === 'replace') {
      this.spliceInternal(id, {
        from: 0,
        to: inlineContent(node).length,
        insert: plan.content.text,
      });
    }
    node.type = plan.type;
    if (plan.type === 'section') node.marker = plan.marker ?? '#';
    else node.marker = null;
    if (plan.type === 'code-block') node.info = plan.info ?? null;
    else node.info = null;
  }

  private setMarkerInternal(id: NodeId, marker: string | null): void {
    const node = this.requireNode(id);
    this.ensureVisibleOrCreated(node);
    this.readField(node, 'kind');
    this.readField(node, 'marker');
    assert(
      node.type === 'section' || node.type === 'list-item' || node.type === 'block-quote',
      `${node.type} has no marker`,
    );
    node.marker = marker;
  }

  private setCheckedInternal(id: NodeId, checked: boolean | null): void {
    const node = this.requireNode(id);
    this.ensureVisibleOrCreated(node);
    this.readField(node, 'kind');
    this.readField(node, 'checked');
    assert(node.type === 'list-item', `${node.type} has no checked state`);
    node.checked = checked;
  }

  private setInfoInternal(id: NodeId, info: string | null): void {
    const node = this.requireNode(id);
    this.ensureVisibleOrCreated(node);
    this.readField(node, 'kind');
    this.readField(node, 'info');
    assert(node.type === 'code-block', `${node.type} has no code info`);
    node.info = info;
  }

  private readField(node: DraftNodeState, field: CellField): void {
    this.assertActive();
    if (node.created) return;
    const cell = node.baseCells.get(field);
    assert(cell, `node ${node.id} is missing ${field}`);
    this.preconditions.set(`cell:${node.id}:${field}`, {
      kind: 'cell',
      nodeId: node.id,
      field,
      token: cell.token,
    });
  }

  private readText(node: DraftNodeState): void {
    this.assertActive();
    this.readField(node, 'kind');
    this.readField(node, 'spans');
    if (node.created) return;
    const original = node.baseCells.get('spans')?.value as readonly Span[];
    for (const span of original) {
      const revision = revisionMap(this.state).get(span.tapeId);
      assert(typeof revision === 'number', `missing tape revision for ${span.tapeId}`);
      this.preconditions.set(`tape:${span.tapeId}`, {
        kind: 'tape',
        tapeId: span.tapeId,
        revision,
      });
    }
  }

  private requireNode(id: NodeId): DraftNodeState {
    this.assertActive();
    let node = this.nodes.get(id);
    if (!node) {
      const record = nodeMap(this.state).get(id);
      if (record) {
        node = nodeStateFromRecord(this.state, id, this.indexes);
        this.nodes.set(id, node);
      }
    }
    assert(node, `unknown node ${id}`);
    return node;
  }

  private rootId(): string {
    return metaMap(this.state).get('rootId') as string;
  }

  private parentId(id: NodeId): NodeId | undefined {
    return this.parentOverlay.has(id)
      ? (this.parentOverlay.get(id) ?? undefined)
      : this.indexes.parentByChild.get(id);
  }

  private ensureVisibleOrCreated(node: DraftNodeState): void {
    if (node.created) return;
    let current = node.id;
    const visited = new Set<NodeId>();
    const root = this.rootId();
    while (current !== root) {
      if (visited.has(current)) break;
      visited.add(current);
      const parentId = this.parentId(current);
      if (!parentId) break;
      this.readField(this.requireNode(parentId), 'children');
      current = parentId;
    }
    if (current === root) return;
    throw new Error(`hidden target ${node.id}`);
  }

  private baseSpans(id: NodeId): readonly Span[] {
    const node = this.requireNode(id);
    if (node.created) return node.spans.map((span) => span.span);
    return node.baseCells.get('spans')!.value as readonly Span[];
  }

  private tapesFor(spans: readonly Span[]): Map<TapeId, Y.Text> {
    const result = new Map<TapeId, Y.Text>();
    const source = tapeMap(this.state);
    for (const span of spans) {
      if (result.has(span.tapeId)) continue;
      let tape = source.get(span.tapeId);
      if (!tape) {
        const created = [...this.newTapeSpans.values()].find(
          (candidate) => candidate.tapeId === span.tapeId,
        );
        if (!created) throw new Error(`missing tape ${span.tapeId}`);
        tape = new Y.Text();
        tape.insertEmbed(0, Object.freeze({ grainBoundary: created.startBoundaryId }));
        tape.insertEmbed(1, Object.freeze({ grainBoundary: created.endBoundaryId }));
      }
      result.set(span.tapeId, tape);
    }
    return result;
  }

  private dropUnusedCreatedInsertionSpans(): void {
    for (const node of this.nodes.values()) {
      if (!node.created || !INLINE_KINDS.has(node.type)) continue;
      const created = this.newTapeSpans.get(node.id);
      if (!created) continue;
      const hasOtherFinalSpan = node.spans.some((span) => span.span.tapeId !== created.tapeId);
      if (!hasOtherFinalSpan) continue;

      let hasFinalOwnerOutsideNode = false;
      let hasActionTextOnTape = false;
      for (const owner of this.nodes.values()) {
        for (const span of owner.spans) {
          if (span.span.tapeId === created.tapeId && owner.id !== node.id) {
            hasFinalOwnerOutsideNode = true;
          }
          for (const piece of span.pieces) {
            if (piece.kind !== 'inserted' || !piece.text) continue;
            const buffer = this.textBuffers.get(piece.bufferId);
            if (buffer?.anchor.tapeId === created.tapeId) hasActionTextOnTape = true;
          }
        }
      }
      if (hasFinalOwnerOutsideNode || hasActionTextOnTape) continue;
      node.spans = node.spans.filter(
        (span) => span.span.tapeId !== created.tapeId || !span.created,
      );
    }
  }

  private allocateId(role: string): string {
    this.assertActive();
    const id = `${role}:${this.actionId}:${this.idOrdinal++}`;
    const permanent = new Set<string>([
      ...this.indexes.nodeIds,
      ...this.indexes.tapeIds,
      ...this.indexes.boundaryIds,
    ]);
    assert(!permanent.has(id) && !this.generatedIds.has(id), `generated ID ${id} already exists`);
    this.generatedIds.add(id);
    return id;
  }

  private reserveId(id: string): void {
    const prefix = `:`;
    const suffix = id.slice(id.lastIndexOf(prefix) + 1);
    if (/^\d+$/.test(suffix)) this.idOrdinal = Math.max(this.idOrdinal, Number(suffix) + 1);
  }

  private assertActive(): void {
    assert(this.active, 'draft is no longer active');
  }
}

interface NativeMutationEvidence {
  readonly changedTapeIds: Set<TapeId>;
  readonly changedOtherTypes: Set<unknown>;
  readonly changedNodeCells: Map<NodeId, Set<CellField>>;
  readonly changedNodeIds: Set<NodeId>;
  readonly changedTapeRegistryIds: Set<TapeId>;
  readonly changedRevisionIds: Set<TapeId>;
  readonly changedMetaKeys: Set<string>;
  readonly changedWatermarkKeys: Set<string>;
  registerNode(id: NodeId, record: RecordMap): void;
  registerTape(id: TapeId, tape: Y.Text): void;
  close(): void;
}

/** Collect native Yjs mutation evidence without scanning tapes after each action. */
function trackNativeMutations(
  state: Y.Doc,
  knownResources?: {
    readonly tapeIds?: ReadonlySet<TapeId>;
    readonly nodeIds?: ReadonlySet<NodeId>;
  },
): NativeMutationEvidence {
  const nodes = nodeMap(state);
  const tapes = tapeMap(state);
  const revisions = revisionMap(state);
  const meta = metaMap(state);
  const watermarks = sessionWatermarkMap(state);
  const nodeIds = new WeakMap<Y.Map<unknown>, NodeId>();
  const childArrayIds = new WeakMap<Y.Array<NodeId>, NodeId>();
  const tapeIds = new WeakMap<Y.Text, TapeId>();
  const changedTapeIds = new Set<TapeId>();
  const changedOtherTypes = new Set<unknown>();
  const changedNodeCells = new Map<NodeId, Set<CellField>>();
  const changedNodeIds = new Set<NodeId>();
  const changedTapeRegistryIds = new Set<TapeId>();
  const changedRevisionIds = new Set<TapeId>();
  const changedMetaKeys = new Set<string>();
  const changedWatermarkKeys = new Set<string>();
  if (!knownResources) {
    for (const [id, record] of nodes.entries()) {
      nodeIds.set(record, id);
      const children = record.get('children');
      if (children instanceof Y.Array) childArrayIds.set(children, id);
    }
    for (const [id, tape] of tapes.entries()) tapeIds.set(tape, id);
  } else {
    for (const id of knownResources.nodeIds ?? []) {
      const record = nodes.get(id);
      if (record) {
        nodeIds.set(record, id);
        const children = record.get('children');
        if (children instanceof Y.Array) childArrayIds.set(children, id);
      }
    }
    for (const id of knownResources.tapeIds ?? []) {
      const tape = tapes.get(id);
      if (tape) tapeIds.set(tape, id);
    }
  }

  const onAfterTransaction = (transaction: Y.Transaction) => {
    for (const [type, keys] of transaction.changed) {
      const sharedType: unknown = type;
      let known = false;
      if (type instanceof Y.Text) {
        const id = tapeIds.get(type);
        if (id) {
          changedTapeIds.add(id);
          known = true;
        }
      }
      if (sharedType === nodes) {
        known = true;
        for (const key of keys) if (key !== null) changedNodeIds.add(key);
      }
      if (sharedType === tapes) {
        known = true;
        for (const key of keys) if (key !== null) changedTapeRegistryIds.add(key);
      }
      if (sharedType === revisions) {
        known = true;
        for (const key of keys) if (key !== null) changedRevisionIds.add(key);
      }
      if (sharedType === meta) {
        known = true;
        for (const key of keys) if (key !== null) changedMetaKeys.add(key);
      }
      if (sharedType === watermarks) {
        known = true;
        for (const key of keys) if (key !== null) changedWatermarkKeys.add(key);
      }
      const nodeId = nodeIds.get(sharedType as Y.Map<unknown>);
      if (nodeId) {
        known = true;
        const fields = changedNodeCells.get(nodeId) ?? new Set<CellField>();
        for (const key of keys) {
          if (
            key === 'kind' ||
            key === 'spans' ||
            key === 'marker' ||
            key === 'checked' ||
            key === 'info' ||
            key === 'childrenToken'
          ) {
            fields.add(key === 'childrenToken' ? 'children' : key);
          }
        }
        changedNodeCells.set(nodeId, fields);
      }
      if (type instanceof Y.Array) {
        const childNodeId = childArrayIds.get(type as Y.Array<NodeId>);
        if (childNodeId) {
          const fields = changedNodeCells.get(childNodeId) ?? new Set<CellField>();
          fields.add('children');
          changedNodeCells.set(childNodeId, fields);
          known = true;
        }
      }
      if (!known) changedOtherTypes.add(type);
    }
  };
  state.on('afterTransaction', onAfterTransaction);
  return {
    changedTapeIds,
    changedOtherTypes,
    changedNodeCells,
    changedNodeIds,
    changedTapeRegistryIds,
    changedRevisionIds,
    changedMetaKeys,
    changedWatermarkKeys,
    registerNode(id, record) {
      nodeIds.set(record, id);
      const children = record.get('children');
      if (children instanceof Y.Array) childArrayIds.set(children, id);
    },
    registerTape(id, tape) {
      tapeIds.set(tape, id);
    },
    close() {
      state.off('afterTransaction', onAfterTransaction);
    },
  };
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

function boundarySignature(tape: Y.Text): string {
  return stableJson(
    tape
      .toDelta()
      .flatMap((part: { readonly insert: unknown }) =>
        typeof part.insert === 'string' ? [] : [part.insert],
      ),
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

function mergeRuns(runs: readonly NativeTextRun[]): NativeTextRun[] {
  const sorted = [...runs].sort((a, b) => a.tapeId.localeCompare(b.tapeId) || a.from - b.from);
  const merged: NativeTextRun[] = [];
  for (const run of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.tapeId === run.tapeId && run.from <= previous.to) {
      merged[merged.length - 1] = { ...previous, to: Math.max(previous.to, run.to) };
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function indexAfterDeletes(
  index: number,
  deletions: readonly NativeTextRun[],
  tapeId: TapeId,
): number {
  let removed = 0;
  for (const run of deletions
    .filter((item) => item.tapeId === tapeId)
    .sort((a, b) => a.from - b.from)) {
    if (index <= run.from) break;
    if (index < run.to) return run.from - removed;
    removed += run.to - run.from;
  }
  return index - removed;
}

function applyPlan(
  state: Y.Doc,
  plan: LowLevelPlan,
  textOrigin: object,
  nextRevision: number,
  mutations: NativeMutationEvidence,
  afterAllocations?: () => void,
): void {
  if (plan.allocations.length || plan.newTapes.length) {
    state.transact(() => {
      for (const { id, span } of plan.newTapes) {
        const tape = new Y.Text();
        tape.insertEmbed(
          0,
          Object.freeze({ grainBoundary: span.startBoundaryId }) satisfies BoundaryEmbed,
        );
        tape.insertEmbed(
          1,
          Object.freeze({ grainBoundary: span.endBoundaryId }) satisfies BoundaryEmbed,
        );
        mutations.registerTape(id, tape);
        tapeMap(state).set(id, tape);
        revisionMap(state).set(id, 0);
      }
      for (const allocation of plan.allocations) {
        const record = new Y.Map<unknown>();
        record.set('children', new Y.Array<NodeId>());
        record.set('childrenToken', allocation.cells.children.token);
        for (const field of ['kind', 'spans', 'marker', 'checked', 'info'] as const) {
          record.set(field, allocation.cells[field]);
        }
        mutations.registerNode(allocation.id, record);
        nodeMap(state).set(allocation.id, record);
      }
    }, 'grain:allocate');
  }
  afterAllocations?.();

  const deletions = mergeRuns(plan.deletions);
  if (deletions.length) {
    state.transact(() => {
      for (const deletion of [...deletions].sort(
        (a, b) => a.tapeId.localeCompare(b.tapeId) || b.from - a.from,
      )) {
        const tape = tapeMap(state).get(deletion.tapeId);
        assert(tape, `missing text tape ${deletion.tapeId}`);
        tape.delete(deletion.from, deletion.to - deletion.from);
      }
    }, textOrigin);
  }

  if (plan.insertions.length) {
    state.transact(() => {
      const sorted = plan.insertions
        .map((insertion) => ({
          ...insertion,
          originalIndex: insertion.index,
          index: indexAfterDeletes(insertion.index, deletions, insertion.tapeId),
        }))
        // Same-index Y.Text inserts prepend, so apply later native gaps first.
        .sort(
          (a, b) =>
            a.tapeId.localeCompare(b.tapeId) ||
            b.index - a.index ||
            b.originalIndex - a.originalIndex ||
            b.slotOrder - a.slotOrder,
        );
      for (const insertion of sorted) {
        const tape = tapeMap(state).get(insertion.tapeId);
        assert(tape, `missing text tape ${insertion.tapeId}`);
        if (insertion.text) tape.insert(insertion.index, insertion.text);
      }
    }, textOrigin);
  }

  if (plan.boundaries.length) {
    state.transact(() => {
      const sorted = plan.boundaries
        .map((boundary) => {
          const index = indexAfterDeletes(boundary.index, deletions, boundary.tapeId);
          const priorInsertions = plan.insertions
            .filter((insertion) => insertion.tapeId === boundary.tapeId)
            .map((insertion) => ({ index: insertion.index, length: insertion.text.length }));
          // Deleted ranges can collapse distinct native gaps to the same index.
          // Compare their original positions to keep insertion-before-boundary order.
          const before = priorInsertions
            .filter((insertion) => insertion.index < boundary.index)
            .reduce((total, insertion) => total + insertion.length, 0);
          return {
            ...boundary,
            index: index + before + boundary.insertionOffset,
          };
        })
        .sort((a, b) => {
          const tapeOrder = a.tapeId.localeCompare(b.tapeId);
          if (tapeOrder) return tapeOrder;
          const indexOrder = b.index - a.index;
          if (indexOrder) return indexOrder;
          if (a.side !== b.side) return a.side === 'end' ? -1 : 1;
          return a.side === 'start' ? b.order - a.order : a.order - b.order;
        });
      for (const boundary of sorted) {
        const tape = tapeMap(state).get(boundary.tapeId);
        assert(tape, `missing boundary tape ${boundary.tapeId}`);
        tape.insertEmbed(
          boundary.index,
          Object.freeze({ grainBoundary: boundary.boundaryId }) satisfies BoundaryEmbed,
        );
      }
    }, 'grain:allocate-boundaries');
  }

  if (plan.writes.length) {
    state.transact(() => {
      for (const write of plan.writes) {
        const record = nodeMap(state).get(write.nodeId);
        assert(record, `missing node ${write.nodeId} for cell write`);
        if (write.field === 'children') {
          const children = record.get('children');
          assert(
            children instanceof Y.Array,
            `node ${write.nodeId} has no permanent children array`,
          );
          for (const splice of diffChildSplices(
            children.toArray(),
            write.value as readonly NodeId[],
          )) {
            if (splice.removedIds.length) children.delete(splice.index, splice.removedIds.length);
            if (splice.insertedIds.length) children.insert(splice.index, [...splice.insertedIds]);
          }
          record.set('childrenToken', write.token);
        } else {
          record.set(write.field, immutableCell(write.token, write.value));
        }
      }
    }, 'grain:structure');
  }

  state.transact(() => {
    const revisions = revisionMap(state);
    const changedTapeIds = new Set([
      ...mutations.changedTapeIds,
      ...plan.newTapes.map(({ id }) => id),
    ]);
    for (const id of changedTapeIds) revisions.set(id, nextRevision);
    metaMap(state).set('acceptedRevision', nextRevision);
  }, 'grain:revision');
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

function currentActive(state: Y.Doc, id: NodeId): boolean {
  const rootId = metaMap(state).get('rootId') as NodeId;
  const pending = [rootId];
  const seen = new Set<NodeId>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === id) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const record = nodeMap(state).get(current);
    if (record) pending.push(...(readCell<readonly NodeId[]>(record, 'children').value ?? []));
  }
  return false;
}

const CELL_FIELDS: readonly CellField[] = [
  'kind',
  'children',
  'spans',
  'marker',
  'checked',
  'info',
];

function snapshotCell(record: RecordMap, field: CellField): StructuralCellValue {
  const cell = readCell<unknown>(record, field);
  return Object.freeze({ token: cell.token, value: deepFreeze(deepCopy(cell.value)) });
}

function structuralPatchBetween(before: Y.Doc, after: Y.Doc, plan: LowLevelPlan): StructuralPatch {
  const beforeNodes = nodeMap(before);
  const afterNodes = nodeMap(after);
  const changedCells: StructuralCellPatch[] = [];
  const childLists: StructuralChildListPatch[] = [];
  const births: StructuralBirth[] = [];
  const visibility: StructuralVisibility[] = [];
  const touched = new Set(plan.touchedNodes);
  const allocations = new Map(plan.allocations.map((item) => [item.id, item]));

  const recordChange = (
    nodeId: NodeId,
    field: CellField,
    oldCell: StructuralCellValue,
    newCell: StructuralCellValue,
  ) => {
    if (field === 'children') {
      if (oldCell.token === newCell.token && sameValue(oldCell.value, newCell.value)) return;
      childLists.push(
        Object.freeze({
          nodeId,
          beforeToken: oldCell.token,
          afterToken: newCell.token,
          splices: diffChildSplices(
            oldCell.value as readonly NodeId[],
            newCell.value as readonly NodeId[],
          ),
        }),
      );
      return;
    }
    if (oldCell.token !== newCell.token || !sameValue(oldCell.value, newCell.value)) {
      changedCells.push(Object.freeze({ nodeId, field, before: oldCell, after: newCell }));
    }
  };

  for (const nodeId of touched) {
    const oldRecord = beforeNodes.get(nodeId);
    const newRecord = afterNodes.get(nodeId);
    assert(newRecord, `structural plan omitted touched node ${nodeId}`);
    if (!oldRecord) {
      const allocation = allocations.get(nodeId);
      assert(allocation, `structural plan omitted allocation for ${nodeId}`);
      const cells = Object.fromEntries(
        CELL_FIELDS.map((field) => [field, allocation.cells[field]]),
      ) as Record<CellField, StructuralCellValue>;
      births.push(Object.freeze({ nodeId, cells: Object.freeze(cells) }));
      // Allocations begin with an empty child list. Edges added to a born
      // wrapper still need an inverse when they point at existing nodes;
      // otherwise undo leaves the same child listed by both detached and
      // active parents in the retained forest.
      for (const field of CELL_FIELDS) {
        const oldCell = allocation.cells[field];
        const newCell = snapshotCell(newRecord, field);
        recordChange(nodeId, field, oldCell, newCell);
      }
    } else {
      for (const field of CELL_FIELDS) {
        const oldCell = snapshotCell(oldRecord, field);
        const newCell = snapshotCell(newRecord, field);
        recordChange(nodeId, field, oldCell, newCell);
      }
    }
    visibility.push(
      Object.freeze({
        nodeId,
        before: oldRecord ? currentActive(before, nodeId) : false,
        after: currentActive(after, nodeId),
      }),
    );
  }

  const bornTapes = plan.newTapes.map(({ id }) => {
    const tape = tapeMap(after).get(id);
    assert(tape, `structural plan omitted born tape ${id}`);
    return Object.freeze({ tapeId: id, sharedTypeId: sharedTypeId(tape) });
  });
  const createdMarkers = new Set<string>([
    ...plan.newTapes.flatMap(({ span }) => [span.startBoundaryId, span.endBoundaryId]),
    ...plan.boundaries.map((boundary) => boundary.boundaryId),
  ]);
  const allMarkers = markerItems(after);
  const bornMarkers = [...createdMarkers].map((boundaryId) => {
    const marker = allMarkers.get(boundaryId);
    assert(marker, `structural plan omitted born marker ${boundaryId}`);
    return Object.freeze({ ...marker, boundaryId });
  });
  const hasStructure = changedCells.length > 0 || childLists.length > 0 || births.length > 0;
  return Object.freeze({
    cells: Object.freeze(changedCells),
    childLists: Object.freeze(childLists),
    births: Object.freeze(births),
    visibility: Object.freeze(hasStructure ? visibility : []),
    bornTapes: Object.freeze(bornTapes),
    bornMarkers: Object.freeze(bornMarkers),
  });
}

function structuralPatchWithLiveIdentities(patch: StructuralPatch, state: Y.Doc): StructuralPatch {
  const markers = patch.bornMarkers.length ? markerItems(state) : undefined;
  return Object.freeze({
    ...patch,
    bornTapes: Object.freeze(
      patch.bornTapes.map(({ tapeId }) => {
        const tape = tapeMap(state).get(tapeId);
        assert(tape, `missing born tape ${tapeId} after live apply`);
        return Object.freeze({ tapeId, sharedTypeId: sharedTypeId(tape) });
      }),
    ),
    bornMarkers: Object.freeze(
      patch.bornMarkers.map(({ boundaryId }) => {
        const marker = markers?.get(boundaryId);
        assert(marker, `missing born marker ${boundaryId} after live apply`);
        return Object.freeze({ ...marker, boundaryId });
      }),
    ),
  });
}

function structuralPatchError(
  state: Y.Doc,
  patch: StructuralPatch,
  direction: 'undo' | 'redo',
): 'resource-conflict' | 'visibility-conflict' | undefined {
  const nodes = nodeMap(state);
  for (const cellPatch of patch.cells) {
    const record = nodes.get(cellPatch.nodeId);
    if (!record) return 'resource-conflict';
    const expected = direction === 'undo' ? cellPatch.after : cellPatch.before;
    const actual = snapshotCell(record, cellPatch.field);
    if (actual.token !== expected.token || !sameValue(actual.value, expected.value)) {
      return 'resource-conflict';
    }
  }
  const patchedBirthFields = new Map<NodeId, Set<CellField>>();
  for (const cellPatch of patch.cells) {
    const fields = patchedBirthFields.get(cellPatch.nodeId) ?? new Set<CellField>();
    fields.add(cellPatch.field);
    patchedBirthFields.set(cellPatch.nodeId, fields);
  }
  for (const childList of patch.childLists) {
    const fields = patchedBirthFields.get(childList.nodeId) ?? new Set<CellField>();
    fields.add('children');
    patchedBirthFields.set(childList.nodeId, fields);
    const record = nodes.get(childList.nodeId);
    if (!record) return 'resource-conflict';
    const expectedToken = direction === 'undo' ? childList.afterToken : childList.beforeToken;
    if (readCell<readonly NodeId[]>(record, 'children').token !== expectedToken) {
      return 'resource-conflict';
    }
    const candidate = [...readCell<readonly NodeId[]>(record, 'children').value];
    const ordered = direction === 'undo' ? [...childList.splices].reverse() : childList.splices;
    for (const splice of ordered) {
      const expectedIds = direction === 'undo' ? splice.insertedIds : splice.removedIds;
      const replacementIds = direction === 'undo' ? splice.removedIds : splice.insertedIds;
      if (
        !sameValue(candidate.slice(splice.index, splice.index + expectedIds.length), expectedIds)
      ) {
        return 'resource-conflict';
      }
      candidate.splice(splice.index, expectedIds.length, ...replacementIds);
    }
  }
  for (const birth of patch.births) {
    const record = nodes.get(birth.nodeId);
    if (!record) return 'resource-conflict';
    const patchedFields = patchedBirthFields.get(birth.nodeId);
    for (const field of CELL_FIELDS) {
      if (patchedFields?.has(field)) continue;
      const actual = snapshotCell(record, field);
      const expected = birth.cells[field];
      if (actual.token !== expected.token || !sameValue(actual.value, expected.value)) {
        return 'resource-conflict';
      }
    }
  }
  for (const visibility of patch.visibility) {
    const expected = direction === 'undo' ? visibility.after : visibility.before;
    if (currentActive(state, visibility.nodeId) !== expected) return 'visibility-conflict';
  }
  for (const resource of patch.bornTapes) {
    const tape = tapeMap(state).get(resource.tapeId);
    if (!tape || sharedTypeId(tape) !== resource.sharedTypeId) return 'resource-conflict';
  }
  const liveMarkers = markerItems(state);
  for (const resource of patch.bornMarkers) {
    const marker = liveMarkers.get(resource.boundaryId);
    if (marker?.tapeId !== resource.tapeId || marker.itemId !== resource.itemId)
      return 'resource-conflict';
  }
  return undefined;
}

function applyStructuralPatch(
  state: Y.Doc,
  patch: StructuralPatch,
  direction: 'undo' | 'redo',
): void {
  const cells = [...patch.cells].reverse();
  state.transact(
    () => {
      const childLists = direction === 'undo' ? [...patch.childLists].reverse() : patch.childLists;
      for (const childList of childLists) {
        const record = nodeMap(state).get(childList.nodeId);
        assert(record, `missing structural node ${childList.nodeId}`);
        const children = record.get('children');
        assert(children instanceof Y.Array, `missing permanent children array ${childList.nodeId}`);
        const splices = direction === 'undo' ? [...childList.splices].reverse() : childList.splices;
        for (const splice of splices) {
          const removedIds = direction === 'undo' ? splice.insertedIds : splice.removedIds;
          const insertedIds = direction === 'undo' ? splice.removedIds : splice.insertedIds;
          if (removedIds.length) children.delete(splice.index, removedIds.length);
          if (insertedIds.length) children.insert(splice.index, [...insertedIds]);
        }
        record.set(
          'childrenToken',
          direction === 'undo' ? childList.beforeToken : childList.afterToken,
        );
      }
      for (const item of cells) {
        const record = nodeMap(state).get(item.nodeId);
        assert(record, `missing structural node ${item.nodeId}`);
        const value = direction === 'undo' ? item.before : item.after;
        record.set(item.field, immutableCell(value.token, value.value));
      }
    },
    direction === 'undo' ? 'grain:structural-undo' : 'grain:structural-redo',
  );
}

function applyMappedTextEdit(
  state: Y.Doc,
  mapped: ReturnType<typeof mapTextEdit>,
  insert: string,
  origin: object,
): void {
  const deletions = mergeRuns(mapped.deletions);
  const tapes = tapeMap(state);
  if (deletions.length) {
    state.transact(() => {
      for (const run of [...deletions].sort(
        (a, b) => a.tapeId.localeCompare(b.tapeId) || b.from - a.from,
      )) {
        const tape = tapes.get(run.tapeId);
        assert(tape, `missing tape ${run.tapeId}`);
        tape.delete(run.from, run.to - run.from);
      }
    }, origin);
  }
  if (insert) {
    const index = indexAfterDeletes(mapped.insertion.index, deletions, mapped.insertion.tapeId);
    const tape = tapes.get(mapped.insertion.tapeId);
    assert(tape, `missing tape ${mapped.insertion.tapeId}`);
    state.transact(() => tape.insert(index, insert), origin);
  }
}

function requestHash(request: ActionRequest): string {
  return stableJson({
    ...request,
    textUpdate: request.textUpdate ? Array.from(request.textUpdate) : undefined,
  });
}

interface CachedActionResponse {
  readonly hash: string;
  readonly accepted: AcceptedAction;
  readonly bytes: number;
}

function copyAcceptedAction(accepted: AcceptedAction): AcceptedAction {
  return Object.freeze({ ...accepted, update: Uint8Array.from(accepted.update) });
}

function acceptedResponseBytes(accepted: AcceptedAction): number {
  const envelope = stableJson({
    actionId: accepted.actionId,
    sessionId: accepted.sessionId,
    authorityEpoch: accepted.authorityEpoch,
    revision: accepted.revision,
    receipt: accepted.receipt,
  });
  return accepted.update.byteLength + new TextEncoder().encode(envelope).byteLength;
}

function copyRequest(request: ActionRequest): ActionRequest {
  return Object.freeze({
    ...request,
    ...(request.focus ? { focus: copyActionFocus(request.focus) } : {}),
    preconditions: Object.freeze(
      request.preconditions.map((item) => Object.freeze(deepCopy(item))),
    ),
    operations: Object.freeze(request.operations.map((item) => deepFreeze(deepCopy(item)))),
    ...(request.textUpdate ? { textUpdate: Uint8Array.from(request.textUpdate) } : {}),
  });
}

function cloneDocument(state: Y.Doc): Y.Doc {
  const clone = new Y.Doc({ gc: false });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(state));
  return clone;
}

function assertResolvedUpdate(state: Y.Doc): void {
  assert(!state.store.pendingStructs, 'text update has unresolved struct dependencies');
  assert(!state.store.pendingDs, 'text update has unresolved delete dependencies');
}

export interface HistoryResult {
  readonly status: 'applied' | 'no-effect' | 'blocked' | 'empty' | 'history-reset' | 'queued';
  readonly revision?: number;
  readonly update?: Uint8Array;
  readonly textChanged?: boolean;
  readonly focus?: Bookmark;
  readonly focusAnchor?: CanonicalTextAnchor;
  readonly selectionAnchors?: {
    readonly anchor: CanonicalTextAnchor;
    readonly focus: CanonicalTextAnchor;
  };
  readonly reason?:
    | 'structural-history-pending'
    | 'resource-conflict'
    | 'visibility-conflict'
    | 'invalid-inverse'
    | 'mixed-scope'
    | 'invalid-scope';
  readonly callbackErrors?: readonly unknown[];
}

export interface PendingHistoryCommit {
  readonly sessionId: string;
  readonly direction: 'undo' | 'redo';
  readonly revision: number;
  readonly textChanged: boolean;
  readonly focus?: Bookmark;
  readonly focusAnchor?: CanonicalTextAnchor;
  readonly selectionAnchors?: {
    readonly anchor: CanonicalTextAnchor;
    readonly focus: CanonicalTextAnchor;
  };
  /** Returns a defensive copy for persistence before publication. */
  readonly update: Uint8Array;
}

export type HistoryPreparationResult =
  | { readonly status: 'pending'; readonly pending: PendingHistoryCommit }
  | HistoryResult;

export interface WriterEvent {
  readonly type: 'commit' | 'history';
  readonly actionId?: string;
  readonly revision?: number;
}

export type WriterListener = (event: WriterEvent) => void;

const activeWriters = new WeakMap<CanonicalDocument, CanonicalWriter>();

interface HistoryEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly groupId: string;
  readonly createdSequence: number;
  readonly origin: object;
  readonly textTapes: Set<TapeId>;
  readonly touchedNodeIds: readonly NodeId[];
  readonly touchedTapeIds: readonly TapeId[];
  structuralPatch: StructuralPatch;
  focus?: ActionFocus;
  focusAnchors?: ActionFocusAnchors;
  selectionAnchors?: { readonly anchor: CanonicalTextAnchor; readonly focus: CanonicalTextAnchor };
  manager?: Y.UndoManager;
  sealed: boolean;
  noEffect: boolean;
  structuralEffect: boolean;
  actionCount: number;
}

interface ActionFocusAnchors {
  readonly start?: CanonicalTextAnchor;
  readonly end?: CanonicalTextAnchor;
}

function historyFocus(entry: HistoryEntry, direction: 'undo' | 'redo'): Bookmark | undefined {
  return direction === 'undo' ? entry.focus?.start : entry.focus?.end;
}

function historyFocusAnchor(
  entry: HistoryEntry,
  direction: 'undo' | 'redo',
): CanonicalTextAnchor | undefined {
  return direction === 'undo' ? entry.focusAnchors?.start : entry.focusAnchors?.end;
}

function historySelectionAnchors(entry: HistoryEntry, direction: 'undo' | 'redo') {
  return direction === 'undo' || entry.focus?.selection?.restoreOnRedo
    ? entry.selectionAnchors
    : undefined;
}

type HistoryScope = 'inside' | 'outside' | 'mixed';

function historyScope(state: Y.Doc, entry: HistoryEntry, scopeRoot: NodeId): HistoryScope {
  const scopeNodes = new Set<NodeId>();
  const pending = [scopeRoot];
  while (pending.length) {
    const id = pending.pop()!;
    if (scopeNodes.has(id)) continue;
    scopeNodes.add(id);
    const record = nodeMap(state).get(id);
    if (record) pending.push(...readCell<readonly NodeId[]>(record, 'children').value);
  }

  let inside = false;
  let outside = false;
  const add = (id: NodeId) => {
    if (scopeNodes.has(id)) inside = true;
    else outside = true;
  };
  // Node IDs describe structural participants, but a text-only edit's original
  // node may since have been detached by a join. Scope its text through the
  // current active owners of the tape instead.
  if (entry.structuralEffect) {
    for (const id of entry.touchedNodeIds) add(id);
  }

  const touchedTapes = new Set(entry.touchedTapeIds);
  if (touchedTapes.size) {
    for (const [id, record] of nodeMap(state)) {
      if (!currentActive(state, id)) continue;
      const spans = readCell<readonly Span[]>(record, 'spans').value;
      if (spans.some((span) => touchedTapes.has(span.tapeId))) add(id);
    }
  }
  if (!inside && !outside) return 'inside';
  return inside && outside ? 'mixed' : inside ? 'inside' : 'outside';
}

interface SessionHistory {
  sequence: number;
  readonly undo: HistoryEntry[];
  readonly redo: HistoryEntry[];
  readonly all: Set<HistoryEntry>;
  current?: HistoryEntry;
}

interface HistoryReservation {
  readonly sessionId: string;
  readonly entry: HistoryEntry;
  readonly isNew: boolean;
  readonly managerExisted: boolean;
  readonly nextCurrent: boolean;
  readonly noEffect: boolean;
  readonly structuralEffect: boolean;
  readonly textTapes: readonly TapeId[];
  readonly structuralPatch: StructuralPatch;
  readonly focus?: ActionFocus;
  readonly focusAnchors?: ActionFocusAnchors;
  readonly selectionAnchors?: {
    readonly anchor: CanonicalTextAnchor;
    readonly focus: CanonicalTextAnchor;
  };
}

interface PendingRecord {
  readonly publicValue: PendingCommit;
  readonly context: AdmittedContext;
  readonly request: ActionRequest;
  readonly requestHash: string;
  readonly reservation: HistoryReservation;
}

interface PendingHistoryRecord {
  readonly publicValue: PendingHistoryCommit;
  readonly sessionId: string;
  readonly direction: 'undo' | 'redo';
  readonly entry: HistoryEntry;
  readonly sourceIndex: number;
  readonly revision: number;
  readonly textChanged: boolean;
  readonly focus?: Bookmark;
  readonly focusAnchor?: CanonicalTextAnchor;
  readonly selectionAnchors?: {
    readonly anchor: CanonicalTextAnchor;
    readonly focus: CanonicalTextAnchor;
  };
  readonly update: Uint8Array;
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
  readonly options: ActionOptions;
  readonly callback: DraftCommand;
}

function makeTextHistoryManager(
  state: Y.Doc,
  entry: HistoryEntry,
  tapeIds: readonly TapeId[],
  historyCapture: NativeTextHistoryCapture,
): Y.UndoManager {
  const tapes = tapeMap(state);
  const scope = tapeIds.flatMap((id) => {
    const tape = tapes.get(id);
    return tape ? [tape] : [];
  });
  return historyCapture.create(scope, entry.origin);
}

function addHistoryTapesToScope(
  state: Y.Doc,
  entry: HistoryEntry,
  tapeIds: readonly TapeId[],
): void {
  if (!entry.manager) return;
  const tapes = tapeMap(state);
  const scope = tapeIds.flatMap((id) => {
    const tape = tapes.get(id);
    return tape ? [tape] : [];
  });
  if (scope.length) entry.manager.addToScope(scope);
}

function closeHistoryEntry(entry: HistoryEntry): void {
  entry.sealed = true;
  entry.manager?.stopCapturing();
}

function destroyHistoryEntry(entry: HistoryEntry, historyCapture: NativeTextHistoryCapture): void {
  if (!entry.manager) return;
  historyCapture.dispose(entry.manager, entry.origin);
  delete entry.manager;
}

function updateRevisionsAfterHistory(
  state: Y.Doc,
  mutations: NativeMutationEvidence,
  structuralEffect = false,
): { revision: number; changed: TapeId[] } {
  const changed = [...mutations.changedTapeIds];
  if (!changed.length && !structuralEffect)
    return { revision: metaMap(state).get('acceptedRevision') as number, changed };
  const revision = (metaMap(state).get('acceptedRevision') as number) + 1;
  state.transact(() => {
    for (const id of changed) revisionMap(state).set(id, revision);
    metaMap(state).set('acceptedRevision', revision);
  }, 'grain:history-revision');
  return { revision, changed };
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
  private validationReplica?: Y.Doc;
  private validationIndexes?: CanonicalIndexes;
  private readonly authorReplicas = new Map<string, Y.Doc>();
  private readonly authorPending = new Map<string, string>();
  private readonly sessions = new Map<string, SessionHistory>();
  private readonly acceptedRequests = new Map<string, CachedActionResponse>();
  private readonly listeners = new Set<WriterListener>();
  private readonly localQueue: QueuedLocalEdit[] = [];
  private readonly maxHistoryGroups: number;
  private readonly verifyWithFullClone: boolean;
  private fullStateCloneCount = 0;
  private authorReplicaCreationCount = 0;
  private validationReplicaCreationCount = 0;
  private literalTextInputCount = 0;
  private acceptedResponseBytes = 0;
  private historyResetPending: boolean;
  private preparing = false;
  private publishing = false;
  private poisoned = false;
  private closed = false;
  private pending?: PendingRecord;
  private pendingHistory?: PendingHistoryRecord;
  private sequenceOrdinal = 0;

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
    this.validationReplica = this.cloneState();
    this.validationIndexes = new CanonicalIndexes(this.validationReplica);
    this.validationReplicaCreationCount++;
    this.maxHistoryGroups = options.maxHistoryGroups ?? 500;
    this.verifyWithFullClone = options.verifyWithFullClone ?? false;
    assert(
      Number.isSafeInteger(this.maxHistoryGroups) && this.maxHistoryGroups > 0,
      'history limit must be a positive integer',
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
      authorReplicaCreations: this.authorReplicaCreationCount,
      validationReplicaCreations: this.validationReplicaCreationCount,
      literalTextInputs: this.literalTextInputCount,
    });
  }

  private cloneState(): Y.Doc {
    this.fullStateCloneCount++;
    return cloneDocument(this.state);
  }

  private authorReplica(sessionId: string): Y.Doc {
    let replica = this.authorReplicas.get(sessionId);
    if (!replica) {
      replica = this.cloneState();
      this.authorReplicaCreationCount++;
      this.authorReplicas.set(sessionId, replica);
    }
    return replica;
  }

  private discardAuthorReplica(sessionId: string): void {
    this.authorReplicas.get(sessionId)?.destroy();
    this.authorReplicas.delete(sessionId);
    this.authorPending.delete(sessionId);
  }

  private rejectPreparedAuthor(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const request = value as Partial<ActionRequest>;
    if (
      typeof request.sessionId === 'string' &&
      typeof request.actionId === 'string' &&
      this.authorPending.get(request.sessionId) === request.actionId
    ) {
      this.discardAuthorReplica(request.sessionId);
    }
  }

  private discardValidationReplica(): void {
    this.validationReplica?.destroy();
    this.validationReplica = undefined;
    this.validationIndexes = undefined;
  }

  private ensureValidationReplica(): { readonly state: Y.Doc; readonly indexes: CanonicalIndexes } {
    if (!this.validationReplica) {
      this.validationReplica = this.cloneState();
      this.validationIndexes = new CanonicalIndexes(this.validationReplica);
      this.validationReplicaCreationCount++;
    }
    assert(this.validationIndexes, 'validation replica is missing its indexes');
    return { state: this.validationReplica, indexes: this.validationIndexes };
  }

  private syncAcceptedValidation(
    update: Uint8Array,
    changedTapeIds: ReadonlySet<TapeId>,
    structuralEffect: boolean,
    revision: number,
    textIndexFresh = false,
  ): void {
    const validation = this.ensureValidationReplica();
    Y.applyUpdate(validation.state, Uint8Array.from(update));
    assertResolvedUpdate(validation.state);
    assert(
      metaMap(validation.state).get('documentId') === metaMap(this.state).get('documentId') &&
        metaMap(validation.state).get('authorityEpoch') ===
          metaMap(this.state).get('authorityEpoch') &&
        metaMap(validation.state).get('acceptedRevision') === revision,
      'validation replica did not receive the accepted document prefix',
    );
    if (structuralEffect) validation.indexes.rebuild();
    else if (!textIndexFresh) validation.indexes.refreshText(changedTapeIds);
  }

  private onExternallyAcceptedUpdate(
    update: Uint8Array,
    changedTapeIds: readonly TapeId[],
    structuralEffect: boolean,
  ): void {
    try {
      const revision = metaMap(this.state).get('acceptedRevision') as number;
      const changed = new Set(changedTapeIds);
      this.syncAcceptedValidation(update, changed, structuralEffect, revision);
      for (const [sessionId, replica] of this.authorReplicas) {
        try {
          Y.applyUpdate(replica, Uint8Array.from(update));
          assertResolvedUpdate(replica);
          assert(
            metaMap(replica).get('documentId') === metaMap(this.state).get('documentId') &&
              metaMap(replica).get('authorityEpoch') ===
                metaMap(this.state).get('authorityEpoch') &&
              metaMap(replica).get('acceptedRevision') === revision,
            'author replica did not receive the accepted document prefix',
          );
        } catch {
          this.discardAuthorReplica(sessionId);
        }
      }
      if (structuralEffect) this.indexes.rebuild();
      else this.indexes.refreshText(changed);
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
    for (const session of this.sessions.values()) {
      for (const entry of session.all) destroyHistoryEntry(entry, this.historyCapture);
      session.all.clear();
      session.undo.length = 0;
      session.redo.length = 0;
      session.current = undefined;
    }
    this.sessions.clear();
    for (const replica of this.authorReplicas.values()) replica.destroy();
    this.authorReplicas.clear();
    this.authorPending.clear();
    this.validationReplica?.destroy();
    this.validationReplica = undefined;
    this.validationIndexes = undefined;
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

  /** Host admission is explicit for requests received from another session. */
  admitSession(sessionId: string): void {
    assert(!this.closed, 'canonical writer is closed');
    assert(sessionId.length > 0, 'session ID cannot be empty');
    if (this.sessions.has(sessionId)) return;
    const epoch = metaMap(this.state).get('authorityEpoch') as string;
    const watermark =
      sessionWatermarkMap(this.state).get(sessionWatermarkKey(epoch, sessionId)) ?? 0;
    assert(
      Number.isSafeInteger(watermark) && watermark >= 0,
      'stored session watermark is invalid',
    );
    this.sessions.set(sessionId, { sequence: watermark, undo: [], redo: [], all: new Set() });
  }

  prepareCommand(options: ActionOptions, callback: DraftCommand): ActionRequest {
    this.assertCanPrepare();
    assert(options.actionId.length > 0, 'action ID cannot be empty');
    const sessionId = options.sessionId ?? 'local';
    assert(
      !this.authorPending.has(sessionId),
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
      !this.authorPending.has(sessionId),
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
    const branch = this.authorReplica(sessionId);
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
      this.authorPending.set(sessionId, options.actionId);
      return copyRequest(request);
    } catch (error) {
      this.discardAuthorReplica(sessionId);
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
    | { readonly kind: 'slow' } {
    const validation = this.ensureValidationReplica();
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
          const classification = classifyInlineInput(validation.indexes.content(target!.nodeId));
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
      this.discardValidationReplica();
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
    this.activateHistoryReservation(reservation);
    this.access.beginPending();
    this.state.on('update', collect);
    try {
      if (request.textUpdate?.length) {
        Y.applyUpdate(this.state, Uint8Array.from(request.textUpdate), reservation.entry.origin);
      }
      applyPlan(this.state, plan, reservation.entry.origin, nextRevision, liveMutations, () =>
        addHistoryTapesToScope(this.state, reservation.entry, prepared.historyTapeIds),
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
        const validation = this.ensureValidationReplica();
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
      this.syncAcceptedValidation(update, changedTapeIds, structuralEffect, nextRevision, literal);
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
      this.discardValidationReplica();
      this.discardAuthorReplica(request.sessionId);
      this.cancelHistoryReservation(reservation);
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
    const validation = this.ensureValidationReplica();
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
        })
      : undefined;
    const snapshot = captureTouchedResources(this.state, EMPTY_PLAN, changedTapeIds);
    const reservation = this.reserveHistory(
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
      this.rejectPreparedAuthor(requestInput);
      return { status: 'rejected', reason: 'closed-writer' };
    }
    if (this.poisoned) {
      this.rejectPreparedAuthor(requestInput);
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
      this.rejectPreparedAuthor(requestInput);
      return { status: 'rejected', reason: 'invalid-request' };
    }
    const reject = (reason: RejectionReason): ApplyResult => {
      this.rejectPreparedAuthor(request);
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
    const session = this.sessions.get(sessionId);
    if (!session) return reject('wrong-session');
    if (request.sessionSequence <= session.sequence) {
      const prior = this.acceptedRequests.get(key);
      if (!prior) return reject('receipt-expired/resync-required');
      return prior.hash === hash
        ? { status: 'duplicate', accepted: copyAcceptedAction(prior.accepted) }
        : reject('retry-payload-conflict');
    }
    if (request.sessionSequence !== session.sequence + 1) return reject('wrong-sequence');
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
        this.discardValidationReplica();
        return reject('invalid-text-update');
      }

      const candidateIndexes = new CanonicalIndexes(candidate);
      let draft: MutableTreeDraft | undefined;
      let plan: LowLevelPlan;
      let receiptFocus = request.focus;
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
        this.discardValidationReplica();
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
          })
        : undefined;
      const snapshot = captureTouchedResources(this.state, plan, finalChangedTapes);
      const actionReservation = this.reserveHistory(
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
      if (reservation) this.cancelHistoryReservation(reservation);
      this.discardValidationReplica();
      this.rejectPreparedAuthor(request);
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
    this.finishHistory(record.reservation);
    this.sessions.get(record.context.sessionId)!.sequence = record.context.sessionSequence;
    for (const [sessionId, replica] of this.authorReplicas) {
      try {
        Y.applyUpdate(replica, Uint8Array.from(pending.update));
      } catch {
        this.discardAuthorReplica(sessionId);
      }
    }
    if (this.authorPending.get(record.context.sessionId) === record.request.actionId) {
      this.authorPending.delete(record.context.sessionId);
    }
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
      this.localQueue.push({ options: deepCopy(options), callback });
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
    return this.historySelection(sessionId, 'undo', scopeRoot).index !== undefined;
  }

  canRedo(sessionId = 'local', scopeRoot?: NodeId): boolean {
    return this.historySelection(sessionId, 'redo', scopeRoot).index !== undefined;
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
    const session = this.sessions.get(record.sessionId);
    assert(session, `missing history session ${record.sessionId}`);
    const source = record.direction === 'undo' ? session.undo : session.redo;
    const destination = record.direction === 'undo' ? session.redo : session.undo;
    assert(
      source[record.sourceIndex] === record.entry,
      'pending history entry is no longer current',
    );
    source.splice(record.sourceIndex, 1);
    destination.push(record.entry);
    if (session.current === record.entry) session.current = undefined;
    for (const [authorSession, replica] of this.authorReplicas) {
      try {
        Y.applyUpdate(replica, Uint8Array.from(record.publicValue.update));
      } catch {
        this.discardAuthorReplica(authorSession);
      }
    }
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
    const session = this.sessions.get(sessionId);
    if (!session?.current) return;
    closeHistoryEntry(session.current);
    session.current = undefined;
  }

  private reserveHistory(
    sessionId: string,
    groupId: string,
    noEffect: boolean,
    structuralEffect: boolean,
    textTapes: readonly TapeId[],
    receipt: ActionReceipt,
    structuralPatch: StructuralPatch,
    focusAnchors?: ActionFocusAnchors,
    selectionAnchors?: {
      readonly anchor: CanonicalTextAnchor;
      readonly focus: CanonicalTextAnchor;
    },
  ): HistoryReservation {
    const session = this.getSession(sessionId);
    const current = session.current;
    const sameTextTarget =
      current?.touchedNodeIds.length === 1 &&
      receipt.touchedNodeIds.length === 1 &&
      current.touchedNodeIds[0] === receipt.touchedNodeIds[0];
    const canJoin =
      !noEffect &&
      !structuralEffect &&
      textTapes.length > 0 &&
      current?.groupId === groupId &&
      !current.sealed &&
      sameTextTarget;
    if (canJoin) {
      const entry = session.current!;
      return {
        sessionId,
        entry,
        isNew: false,
        managerExisted: !!entry.manager,
        nextCurrent: true,
        noEffect,
        structuralEffect,
        textTapes,
        structuralPatch,
        ...(receipt.focus ? { focus: receipt.focus } : {}),
        ...(focusAnchors ? { focusAnchors } : {}),
        ...(selectionAnchors ? { selectionAnchors } : {}),
      };
    }
    const entryId = noEffect
      ? `${groupId}:noop:${receipt.requestId}`
      : `${groupId}:${receipt.requestId}`;
    const base = {
      id: entryId,
      sessionId,
      groupId,
      createdSequence: this.sequenceOrdinal,
      origin: Object.freeze({ entryId }),
      textTapes: new Set(textTapes),
      touchedNodeIds: receipt.touchedNodeIds,
      touchedTapeIds: receipt.touchedTapeIds,
      structuralPatch,
      ...(receipt.focus ? { focus: receipt.focus } : {}),
      ...(focusAnchors ? { focusAnchors } : {}),
      ...(selectionAnchors ? { selectionAnchors } : {}),
      sealed: noEffect || structuralEffect,
      noEffect,
      structuralEffect,
      actionCount: 0,
    };
    const entry: HistoryEntry = { ...base };
    return {
      sessionId,
      entry,
      isNew: true,
      managerExisted: false,
      nextCurrent: !noEffect && !structuralEffect && textTapes.length > 0,
      noEffect,
      structuralEffect,
      textTapes,
      structuralPatch,
      ...(receipt.focus ? { focus: receipt.focus } : {}),
      ...(focusAnchors ? { focusAnchors } : {}),
      ...(selectionAnchors ? { selectionAnchors } : {}),
    };
  }

  private activateHistoryReservation(reservation: HistoryReservation): void {
    const entry = reservation.entry;
    if (!reservation.textTapes.length) return;
    if (!entry.manager) {
      const tapeIds = [...new Set([...entry.textTapes, ...reservation.textTapes])];
      entry.manager = makeTextHistoryManager(this.state, entry, tapeIds, this.historyCapture);
    } else if (!reservation.isNew) {
      addHistoryTapesToScope(this.state, entry, reservation.textTapes);
    }
  }

  private cancelHistoryReservation(reservation: HistoryReservation): void {
    if (reservation.isNew || !reservation.managerExisted) {
      destroyHistoryEntry(reservation.entry, this.historyCapture);
    }
  }

  private finishHistory(reservation: HistoryReservation): void {
    const session = this.getSession(reservation.sessionId);
    for (const redo of session.redo.splice(0)) {
      session.all.delete(redo);
      destroyHistoryEntry(redo, this.historyCapture);
    }
    const entry = reservation.entry;
    if (reservation.isNew) {
      if (session.current && session.current !== entry) closeHistoryEntry(session.current);
      if (session.current !== entry) session.current = undefined;
      this.sequenceOrdinal++;
      session.undo.push(entry);
      session.all.add(entry);
    }
    if (!reservation.isNew && reservation.focus) {
      entry.focus = Object.freeze({
        ...((entry.focus?.start ?? reservation.focus.start)
          ? { start: entry.focus?.start ?? reservation.focus.start }
          : {}),
        ...(reservation.focus.end ? { end: reservation.focus.end } : {}),
      });
    }
    if (!reservation.isNew && reservation.focusAnchors) {
      entry.focusAnchors = Object.freeze({
        ...((entry.focusAnchors?.start ?? reservation.focusAnchors.start)
          ? { start: entry.focusAnchors?.start ?? reservation.focusAnchors.start }
          : {}),
        ...(reservation.focusAnchors.end ? { end: reservation.focusAnchors.end } : {}),
      });
    }
    if (reservation.selectionAnchors) entry.selectionAnchors = reservation.selectionAnchors;
    for (const tapeId of reservation.textTapes) entry.textTapes.add(tapeId);
    entry.noEffect &&= reservation.noEffect;
    entry.structuralEffect ||= reservation.structuralEffect;
    entry.actionCount++;
    if (reservation.nextCurrent) session.current = entry;
    else {
      if (session.current === entry) session.current = undefined;
      closeHistoryEntry(entry);
    }
    for (const [otherSessionId, other] of this.sessions.entries()) {
      if (otherSessionId !== reservation.sessionId && other.current) {
        closeHistoryEntry(other.current);
        other.current = undefined;
      }
    }
    this.trimHistory(session);
  }

  private historySelection(
    sessionId: string,
    direction: 'undo' | 'redo',
    scopeRoot?: NodeId,
  ): { readonly index?: number; readonly reason?: 'invalid-scope' | 'mixed-scope' } {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    const source = direction === 'undo' ? session.undo : session.redo;
    if (scopeRoot !== undefined && !currentActive(this.state, scopeRoot)) {
      return { reason: 'invalid-scope' };
    }
    for (let index = source.length - 1; index >= 0; index--) {
      if (scopeRoot === undefined) return { index };
      const scope = historyScope(this.state, source[index]!, scopeRoot);
      if (scope === 'outside') continue;
      if (scope === 'mixed') return { reason: 'mixed-scope' };
      return { index };
    }
    return {};
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
    const session = this.sessions.get(sessionId);
    if (!session) return this.consumeHistoryReset();
    const source = direction === 'undo' ? session.undo : session.redo;
    const destination = direction === 'undo' ? session.redo : session.undo;
    const selection = this.historySelection(sessionId, direction, scopeRoot);
    if (selection.reason) return { status: 'blocked', reason: selection.reason };
    const sourceIndex = selection.index;
    if (sourceIndex === undefined) return this.consumeHistoryReset();
    const entry = source[sourceIndex]!;
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
      source.splice(sourceIndex, 1);
      destination.push(entry);
      if (session.current === entry) session.current = undefined;
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
        source.splice(sourceIndex, 1);
        destination.push(entry);
        if (session.current === entry) session.current = undefined;
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
      this.syncAcceptedValidation(
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

  private trimHistory(session: SessionHistory): void {
    while (session.all.size > this.maxHistoryGroups) {
      const oldest = [...session.all].sort((a, b) => a.createdSequence - b.createdSequence)[0];
      if (!oldest) return;
      session.all.delete(oldest);
      session.undo.splice(session.undo.indexOf(oldest), session.undo.includes(oldest) ? 1 : 0);
      session.redo.splice(session.redo.indexOf(oldest), session.redo.includes(oldest) ? 1 : 0);
      if (session.current === oldest) session.current = undefined;
      destroyHistoryEntry(oldest, this.historyCapture);
    }
  }

  private getSession(sessionId: string): SessionHistory {
    const session = this.sessions.get(sessionId);
    assert(session, `session ${sessionId} has not been admitted by the host`);
    return session;
  }

  private nextSequence(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (session) return session.sequence + 1;
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
    for (const item of queued) queueMicrotask(() => this.edit(item.options, item.callback));
  }
}
