import * as Y from 'yjs';

import {
  CanonicalDocument,
  assertRetainedResources,
  assertTapeRevisions,
  canonicalWriterAccess,
  tapeItemSignature,
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
import { mapTextEdit } from './canonical-text.js';
import type { NativeTextRun, TextAffinity, TextEdit } from './canonical-text.js';

const META = 'meta';
const NODES = 'nodes';
const TAPES = 'tapes';
const TAPE_REVISIONS = 'tapeRevisions';
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
type CellField = 'kind' | 'children' | 'spans' | 'marker' | 'checked' | 'info';

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

export interface TreeDraft {
  node(id: NodeId): DraftNode;
  create(spec: NodeSpec): NodeId;
  place(id: NodeId, parent: NodeId, before: NodeId | null): void;
  detach(id: NodeId): void;
  spliceText(id: NodeId, edit: TextEdit): void;
  transferInlineRange(transfer: Transfer): void;
  convertInline(id: NodeId, plan: ConversionPlan): void;
  setMarker(id: NodeId, marker: string | null): void;
  setChecked(id: NodeId, checked: boolean | null): void;
  setInfo(id: NodeId, info: string | null): void;
  bookmark(id: NodeId, offset: number, affinity: TextAffinity, spanIndex?: number): Bookmark;
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
  | { readonly type: 'transferInlineRange'; readonly transfer: Transfer }
  | { readonly type: 'convertInline'; readonly id: NodeId; readonly plan: ConversionPlan }
  | { readonly type: 'setMarker'; readonly id: NodeId; readonly marker: string | null }
  | { readonly type: 'setChecked'; readonly id: NodeId; readonly checked: boolean | null }
  | { readonly type: 'setInfo'; readonly id: NodeId; readonly info: string | null };

export interface ActionRequest {
  readonly mode: 'text-input' | 'command';
  readonly documentId: string;
  readonly authorityEpoch: string;
  readonly sessionSequence: number;
  readonly actionId: string;
  readonly baseRevision: number;
  readonly historyGroupId: string;
  readonly preconditions: readonly ReadPrecondition[];
  readonly textUpdate?: Uint8Array;
  readonly operations: readonly SemanticOperation[];
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
  readonly noEffect: boolean;
  readonly promotionSkipped?: 'ownershipChanged';
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
  | 'invalid-request'
  | 'invalid-operation'
  | 'invalid-text-update'
  | 'publication-order';

export interface WriterOptions {
  readonly maxHistoryGroups?: number;
}

interface InternalCell {
  readonly token: string;
  readonly value: unknown;
}

interface DraftAnchor {
  readonly tapeId: TapeId;
  readonly index: number;
  readonly spanIndex: number;
  readonly affinity: TextAffinity;
}

interface RetainedPiece {
  readonly kind: 'retained';
  readonly sourceFrom: number;
  readonly sourceTo: number;
  readonly text: string;
}

interface InsertedPiece {
  readonly kind: 'inserted';
  readonly anchor: DraftAnchor;
  readonly text: string;
}

interface TransferredPiece {
  readonly kind: 'transferred';
  readonly text: string;
  readonly source: NodeId;
  readonly tapeId: TapeId;
}

type DraftPiece = RetainedPiece | InsertedPiece | TransferredPiece;

interface DraftSpan {
  span: Span;
  pieces: DraftPiece[];
  readonly sourceSpanIndex?: number;
  readonly created?: boolean;
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
  transferred: boolean;
}

interface PlanBoundary {
  readonly tapeId: TapeId;
  readonly index: number;
  readonly boundaryId: string;
}

interface PlanTextInsert {
  readonly tapeId: TapeId;
  readonly index: number;
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

function immutableCell<T>(token: string, value: T): CellValue<T> {
  return Object.freeze({ token, value: deepFreeze(deepCopy(value)) });
}

function readCell<T>(record: RecordMap, field: CellField): CellValue<T> {
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

function nodeCell(state: Y.Doc, id: NodeId, field: CellField): CellValue<unknown> {
  const record = nodeMap(state).get(id);
  assert(record, `unknown node ${id}`);
  return readCell(record, field);
}

function spanText(state: Y.Doc, span: Span): string {
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

function inlineContent(node: DraftNodeState): string {
  return node.spans.flatMap((span) => span.pieces.map((piece) => piece.text)).join('');
}

function draftSpanCopy(span: Span, text: string, sourceSpanIndex: number): DraftSpan {
  return {
    span: Object.freeze({ ...span }),
    sourceSpanIndex,
    pieces: text ? [{ kind: 'retained', sourceFrom: 0, sourceTo: text.length, text }] : [],
  };
}

function nodeStateFromRecord(state: Y.Doc, id: NodeId): DraftNodeState {
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
      ? spans.value.map((span, index) => draftSpanCopy(span, spanText(state, span), index))
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
    transferred: false,
  };
}

function allowedChild(parent: NodeKind, child: NodeKind): boolean {
  if (parent === 'list') return child === 'list-item';
  return CONTAINER_KINDS.has(parent) && BLOCK_KINDS.has(child);
}

function parentOf(nodes: ReadonlyMap<NodeId, DraftNodeState>, childId: NodeId): NodeId | undefined {
  for (const candidate of nodes.values())
    if (candidate.children.includes(childId)) return candidate.id;
  return undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function slicePiece(piece: DraftPiece, from: number, to: number): DraftPiece | undefined {
  if (from >= to) return undefined;
  if (piece.kind === 'retained') {
    return {
      ...piece,
      sourceFrom: piece.sourceFrom + from,
      sourceTo: piece.sourceFrom + to,
      text: piece.text.slice(from, to),
    };
  }
  return { ...piece, text: piece.text.slice(from, to) };
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

function actionKey(actionId: string): string {
  return actionId;
}

class MutableTreeDraft implements TreeDraft {
  private active = true;
  private readonly nodes = new Map<NodeId, DraftNodeState>();
  private readonly preconditions = new Map<string, ReadPrecondition>();
  private readonly operations_: SemanticOperation[] = [];
  private readonly generatedIds = new Set<string>();
  private readonly newTapeSpans = new Map<NodeId, Span>();
  private readonly transferBoundaries: PlanBoundary[] = [];
  private readonly transferredNodes = new Set<NodeId>();
  private idOrdinal = 0;
  private compiledPlan?: LowLevelPlan;

  constructor(
    private readonly state: Y.Doc,
    private readonly actionId: string,
    operations?: readonly SemanticOperation[],
  ) {
    for (const [id] of nodeMap(state).entries()) this.nodes.set(id, nodeStateFromRecord(state, id));
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
    const allocations: PlanNodeAllocation[] = [];
    const newTapes: { id: TapeId; span: Span }[] = [];
    const deletions: NativeTextRun[] = [];
    const insertions: PlanTextInsert[] = [];
    const writes: { nodeId: NodeId; field: CellField; value: unknown; token: string }[] = [];
    const touchedNodes = new Set<NodeId>();
    const touchedTapes = new Set<TapeId>();
    const textTapes = new Set<TapeId>();
    const tapes = new Map<TapeId, Y.Text>(tapeMap(this.state).entries());

    for (const node of this.nodes.values()) {
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
        for (const span of spans) {
          newTapes.push({ id: span.tapeId, span });
          touchedTapes.add(span.tapeId);
          if (inlineContent(node)) {
            insertions.push({ tapeId: span.tapeId, index: 1, text: inlineContent(node) });
            textTapes.add(span.tapeId);
          }
        }
      }

      if (node.textEdited && !node.created) {
        assert(!node.transferred, 'a node cannot combine text edits and ownership transfer');
        const baseSpans = node.baseCells.get('spans')!.value as readonly Span[];
        const baseStarts: number[] = [];
        let baseLength = 0;
        for (const span of baseSpans) {
          baseStarts.push(baseLength);
          baseLength += spanText(this.state, span).length;
        }
        const bySource = new Map<number, DraftSpan>();
        for (const span of node.spans) {
          if (span.sourceSpanIndex !== undefined) bySource.set(span.sourceSpanIndex, span);
        }
        for (let spanIndex = 0; spanIndex < baseSpans.length; spanIndex++) {
          const baseSpan = baseSpans[spanIndex]!;
          const baseText = spanText(this.state, baseSpan);
          const currentSpan = bySource.get(spanIndex);
          assert(currentSpan, `text span ${spanIndex} disappeared during a splice`);
          const retained = currentSpan.pieces
            .filter((piece): piece is RetainedPiece => piece.kind === 'retained')
            .map((piece) => [piece.sourceFrom, piece.sourceTo] as const)
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
              const mapped = mapTextEdit(baseSpans, tapes, {
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
            const mapped = mapTextEdit(baseSpans, tapes, {
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
          let priorInsertion: PlanTextInsert | undefined;
          for (const piece of currentSpan.pieces) {
            if (piece.kind !== 'inserted' || !piece.text) {
              priorInsertion = undefined;
              continue;
            }
            touchedTapes.add(piece.anchor.tapeId);
            textTapes.add(piece.anchor.tapeId);
            if (
              priorInsertion &&
              priorInsertion.tapeId === piece.anchor.tapeId &&
              priorInsertion.index === piece.anchor.index
            ) {
              const index = insertions.indexOf(priorInsertion);
              const combined = { ...priorInsertion, text: priorInsertion.text + piece.text };
              insertions[index] = combined;
              priorInsertion = combined;
            } else {
              priorInsertion = {
                tapeId: piece.anchor.tapeId,
                index: piece.anchor.index,
                text: piece.text,
              };
              insertions.push(priorInsertion);
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

    for (const boundary of this.transferBoundaries) touchedTapes.add(boundary.tapeId);
    const boundaryTapes = new Set(this.transferBoundaries.map((boundary) => boundary.tapeId));
    assert(
      !deletions.some((deletion) => boundaryTapes.has(deletion.tapeId)) &&
        !insertions.some((insertion) => boundaryTapes.has(insertion.tapeId)),
      'text edits and boundary transfers cannot change the same tape in one action',
    );
    const operationNodeIds = this.operations_.flatMap((operation) => {
      switch (operation.type) {
        case 'transferInlineRange':
          return [operation.transfer.source, operation.transfer.destination];
        default:
          return 'id' in operation ? [operation.id] : [];
      }
    });
    for (const id of operationNodeIds) touchedNodes.add(id);
    this.compiledPlan = Object.freeze({
      allocations: Object.freeze(allocations),
      newTapes: Object.freeze(newTapes),
      boundaries: Object.freeze(this.transferBoundaries.map((item) => Object.freeze({ ...item }))),
      deletions: Object.freeze(deletions.map((item) => Object.freeze({ ...item }))),
      insertions: Object.freeze(insertions.map((item) => Object.freeze({ ...item }))),
      writes: Object.freeze(writes.map((item) => Object.freeze({ ...item }))),
      touchedNodes: Object.freeze([...touchedNodes]),
      touchedTapes: Object.freeze([...touchedTapes]),
      textTapes: Object.freeze([...textTapes]),
    });
    return this.compiledPlan;
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

  transferInlineRange(transfer: Transfer): void {
    this.apply({ type: 'transferInlineRange', transfer: deepFreeze(deepCopy(transfer)) }, true);
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
    assert(!this.nodes.has(id), `node ID ${id} already exists`);
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
      assert(!this.nodes.has(span.tapeId), `tape ID ${span.tapeId} already exists`);
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
              pieces: content
                ? [
                    {
                      kind: 'inserted',
                      anchor: { tapeId: span.tapeId, index: 1, spanIndex: 0, affinity: 'right' },
                      text: content,
                    },
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
      transferred: false,
    };
    this.validateDraftEdit('', { from: 0, to: 0, insert: content });
    this.nodes.set(id, state);
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
    const oldParentId = parentOf(this.nodes, id);
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
  }

  private detachInternal(id: NodeId): void {
    assert(id !== this.rootId(), 'the document root cannot be detached');
    const parentId = parentOf(this.nodes, id);
    assert(parentId, `node ${id} is already detached`);
    this.ensureVisibleOrCreated(this.requireNode(id));
    const parent = this.requireNode(parentId);
    this.readField(parent, 'children');
    parent.children = parent.children.filter((child) => child !== id);
  }

  private spliceInternal(id: NodeId, edit: TextEdit): void {
    const node = this.requireNode(id);
    this.ensureVisibleOrCreated(node);
    assert(INLINE_KINDS.has(node.type), `${node.type} nodes do not have inline text`);
    assert(
      !node.transferred,
      'text edits after an ownership transfer are not supported in this milestone',
    );
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
        kind: 'inserted',
        anchor: target.anchor,
        text: edit.insert,
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
  ): { spanIndex: number; localOffset: number; anchor: DraftAnchor } {
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
    if (target.span.created) {
      const inserted = target.span.pieces.find(
        (piece): piece is InsertedPiece => piece.kind === 'inserted',
      );
      if (inserted) {
        return { spanIndex: target.index, localOffset, anchor: inserted.anchor };
      }
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
      return { spanIndex: target.index, localOffset, anchor: chosen.piece.anchor };
    }
    const source = chosen?.piece;
    assert(!source || source.kind === 'retained', 'cannot edit at a transferred source seam');
    const retainedSource = source?.kind === 'retained' ? source : undefined;
    const sourceOffset = retainedSource
      ? retainedSource.sourceFrom + chosen!.local
      : affinity === 'left'
        ? 0
        : 0;
    const baseSpans = this.baseSpans(node.id);
    const baseStart = baseSpans
      .slice(0, target.index)
      .reduce((total, span) => total + spanText(this.state, span).length, 0);
    const map = mapTextEdit(baseSpans, this.allTapes(), {
      from: baseStart + sourceOffset,
      to: baseStart + sourceOffset,
      insert: '',
      affinity,
      spanIndex: target.index,
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
    assert(
      !source.textEdited && !destination.textEdited,
      'text edits and transfers cannot share a draft',
    );
    assert(
      !source.transferred && !destination.transferred,
      'only one transfer per affected node is supported',
    );
    assert(!source.created && !destination.created, 'transfers require retained canonical nodes');
    this.readText(source);
    if (source.id === destination.id) {
      this.reorderInlineRange(source, transfer);
      return;
    }
    this.readText(destination);
    const sourceContent = inlineContent(source);
    const destinationContent = inlineContent(destination);
    assert(
      Number.isInteger(transfer.from) && Number.isInteger(transfer.to),
      'transfer offsets must be integers',
    );
    assert(
      transfer.from >= 0 && transfer.to > transfer.from && transfer.to <= sourceContent.length,
      'transfer range is out of bounds',
    );
    assert(
      !splitSurrogateBoundary(sourceContent, transfer.from) &&
        !splitSurrogateBoundary(sourceContent, transfer.to),
      'transfer splits a surrogate pair',
    );
    assert(
      Number.isInteger(transfer.at) && transfer.at >= 0 && transfer.at <= destinationContent.length,
      'transfer destination is out of bounds',
    );
    assert(
      !splitSurrogateBoundary(destinationContent, transfer.at),
      'transfer destination splits a surrogate pair',
    );
    const sourceParts = this.cutSourceRange(source, transfer.from, transfer.to);
    const destinationSpans = this.insertTransferAt(
      destination,
      transfer.at,
      transfer.affinity,
      sourceParts.moved,
    );
    source.spans = sourceParts.remaining;
    destination.spans = destinationSpans;
    source.transferred = true;
    destination.transferred = true;
    this.transferredNodes.add(source.id);
    this.transferredNodes.add(destination.id);
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
      const startBoundary =
        localFrom === 0 && !fullSpan
          ? span.startBoundaryId
          : this.cutBoundary(node, index, localFrom, 'start');
      const endBoundary =
        localTo === text.length && !fullSpan
          ? span.endBoundaryId
          : this.cutBoundary(node, index, localTo, 'end');
      if (localFrom > 0 || fullSpan) {
        const left = { ...span, endBoundaryId: startBoundary };
        remaining.push({
          span: left,
          sourceSpanIndex: current.sourceSpanIndex,
          pieces: slicePieces(current.pieces, 0, localFrom),
        });
      }
      moved.push({
        span: { ...span, startBoundaryId: startBoundary, endBoundaryId: endBoundary },
        pieces: [
          {
            kind: 'transferred',
            text: text.slice(localFrom, localTo),
            source: node.id,
            tapeId: span.tapeId,
          },
        ],
      });
      if (localTo < text.length || fullSpan) {
        const right = { ...span, startBoundaryId: endBoundary };
        remaining.push({
          span: right,
          sourceSpanIndex: current.sourceSpanIndex,
          pieces: slicePieces(current.pieces, localTo, text.length),
        });
      }
    }
    assert(moved.length > 0, 'transfer range has no source span');
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
            spanIndex,
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
        segments.push({
          draft: {
            span: {
              ...current.span,
              startBoundaryId: boundaries.get(from)!,
              endBoundaryId: boundaries.get(to)!,
            },
            sourceSpanIndex: current.sourceSpanIndex,
            pieces: slicePieces(current.pieces, from, to),
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
    node.transferred = true;
    this.transferredNodes.add(node.id);
  }

  private cutBoundary(
    node: DraftNodeState,
    spanIndex: number,
    offset: number,
    role: 'start' | 'end',
    affinity?: TextAffinity,
  ): string {
    const span = node.spans[spanIndex]!;
    const baseSpans = this.baseSpans(node.id);
    const spanTextValue = spanText(this.state, span.span);
    const baseStart = baseSpans
      .slice(0, spanIndex)
      .reduce((total, item) => total + spanText(this.state, item).length, 0);
    const mapped = mapTextEdit(baseSpans, this.allTapes(), {
      from: baseStart + offset,
      to: baseStart + offset,
      insert: '',
      affinity: affinity ?? (role === 'start' ? 'right' : 'left'),
      spanIndex,
    });
    assert(offset <= spanTextValue.length, 'transfer boundary is outside its source span');
    const boundaryId = this.allocateId('boundary');
    this.transferBoundaries.push({
      tapeId: mapped.insertion.tapeId,
      index: mapped.insertion.index,
      boundaryId,
    });
    return boundaryId;
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
        const cutId = this.cutBoundary(node, index, local, affinity === 'left' ? 'end' : 'start');
        const leftSpan = { ...current.span, endBoundaryId: cutId };
        const rightSpan = { ...current.span, startBoundaryId: cutId };
        result.push(
          {
            span: leftSpan,
            sourceSpanIndex: current.sourceSpanIndex,
            pieces: slicePieces(current.pieces, 0, local),
          },
          ...moved,
          {
            span: rightSpan,
            sourceSpanIndex: current.sourceSpanIndex,
            pieces: slicePieces(current.pieces, local, content.length),
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
    const node = this.nodes.get(id);
    assert(node, `unknown node ${id}`);
    return node;
  }

  private rootId(): string {
    return metaMap(this.state).get('rootId') as string;
  }

  private ensureVisibleOrCreated(node: DraftNodeState): void {
    if (node.created) return;
    const pending = [this.rootId()];
    const visited = new Set<NodeId>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === node.id) return;
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(this.nodes.get(id)?.children ?? []));
    }
    throw new Error(`hidden target ${node.id}`);
  }

  private baseSpans(id: NodeId): readonly Span[] {
    const node = this.requireNode(id);
    if (node.created) return node.spans.map((span) => span.span);
    return node.baseCells.get('spans')!.value as readonly Span[];
  }

  private currentTapes(node: DraftNodeState): ReadonlyMap<TapeId, Y.Text> {
    const result = this.allTapes();
    for (const span of node.spans) {
      if (!result.has(span.span.tapeId)) {
        const created = this.newTapeSpans.get(node.id);
        if (created?.tapeId === span.span.tapeId) result.set(span.span.tapeId, new Y.Text());
      }
    }
    return result;
  }

  private allTapes(): Map<TapeId, Y.Text> {
    return new Map(tapeMap(this.state).entries());
  }

  private allocateId(role: string): string {
    this.assertActive();
    const id = `${role}:${this.actionId}:${this.idOrdinal++}`;
    const permanent = new Set<string>([
      ...nodeMap(this.state).keys(),
      ...tapeMap(this.state).keys(),
    ]);
    for (const tape of tapeMap(this.state).values()) {
      for (const part of tape.toDelta()) {
        if (typeof part.insert !== 'string') {
          const boundary = (part.insert as Partial<BoundaryEmbed>)?.grainBoundary;
          if (typeof boundary === 'string') permanent.add(boundary);
        }
      }
    }
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

interface TapeStateSummary {
  readonly signatures: ReadonlyMap<TapeId, string>;
  readonly revisions: ReadonlyMap<TapeId, number>;
}

function tapeStateSummary(state: Y.Doc): TapeStateSummary {
  const signatures = new Map<TapeId, string>();
  const revisions = new Map<TapeId, number>();
  const currentRevisions = revisionMap(state);
  for (const [id, tape] of tapeMap(state).entries()) {
    signatures.set(id, tapeItemSignature(tape));
    const revision = currentRevisions.get(id);
    assert(typeof revision === 'number', `tape ${id} has no revision`);
    revisions.set(id, revision);
  }
  return { signatures, revisions };
}

function changedTapeIds(before: TapeStateSummary, state: Y.Doc): TapeId[] {
  const changed: TapeId[] = [];
  for (const [id, tape] of tapeMap(state).entries()) {
    if (before.signatures.get(id) !== tapeItemSignature(tape)) changed.push(id);
  }
  return changed;
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
    assert(
      boundarySignature(tape) === boundarySignature(next),
      `text update changed boundary markers on ${id}`,
    );
    for (const part of next.toDelta()) {
      assert(
        !part.attributes || Object.keys(part.attributes).length === 0,
        `text update added formatting to tape ${id}`,
      );
    }
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
  before: TapeStateSummary,
  nextRevision: number,
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
        tapeMap(state).set(id, tape);
        revisionMap(state).set(id, 0);
      }
      for (const allocation of plan.allocations) {
        const record = new Y.Map<unknown>();
        for (const field of ['kind', 'children', 'spans', 'marker', 'checked', 'info'] as const) {
          record.set(field, allocation.cells[field]);
        }
        nodeMap(state).set(allocation.id, record);
      }
    }, 'grain:allocate');
  }

  if (plan.boundaries.length) {
    state.transact(() => {
      const sorted = [...plan.boundaries].sort(
        (a, b) => a.tapeId.localeCompare(b.tapeId) || b.index - a.index,
      );
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
          index: indexAfterDeletes(insertion.index, deletions, insertion.tapeId),
        }))
        .sort((a, b) => a.tapeId.localeCompare(b.tapeId) || b.index - a.index);
      for (const insertion of sorted) {
        const tape = tapeMap(state).get(insertion.tapeId);
        assert(tape, `missing text tape ${insertion.tapeId}`);
        if (insertion.text) tape.insert(insertion.index, insertion.text);
      }
    }, textOrigin);
  }

  if (plan.writes.length) {
    state.transact(() => {
      for (const write of plan.writes) {
        const record = nodeMap(state).get(write.nodeId);
        assert(record, `missing node ${write.nodeId} for cell write`);
        record.set(write.field, immutableCell(write.token, write.value));
      }
    }, 'grain:structure');
  }

  state.transact(() => {
    const revisions = revisionMap(state);
    for (const [id, tape] of tapeMap(state).entries()) {
      const changed = before.signatures.get(id) !== tapeItemSignature(tape);
      if (changed) revisions.set(id, nextRevision);
      else if (before.revisions.has(id)) revisions.set(id, before.revisions.get(id)!);
      else revisions.set(id, nextRevision);
    }
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

function copyRequest(request: ActionRequest): ActionRequest {
  return Object.freeze({
    ...request,
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

export interface HistoryResult {
  readonly status: 'applied' | 'no-effect' | 'blocked' | 'empty' | 'queued';
  readonly revision?: number;
  readonly update?: Uint8Array;
  readonly reason?: 'structural-history-pending';
  readonly callbackErrors?: readonly unknown[];
}

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
  readonly manager?: Y.UndoManager;
  sealed: boolean;
  noEffect: boolean;
  structuralEffect: boolean;
  actionCount: number;
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
  readonly nextCurrent: boolean;
  readonly noEffect: boolean;
  readonly structuralEffect: boolean;
  readonly textTapes: readonly TapeId[];
}

interface PendingRecord {
  readonly publicValue: PendingCommit;
  readonly context: AdmittedContext;
  readonly request: ActionRequest;
  readonly requestHash: string;
  readonly reservation: HistoryReservation;
}

interface QueuedLocalEdit {
  readonly options: ActionOptions;
  readonly callback: (draft: TreeDraft) => void;
}

function makeTextHistoryManager(state: Y.Doc, entry: HistoryEntry): Y.UndoManager {
  const tapes = tapeMap(state);
  let manager: Y.UndoManager;
  manager = new Y.UndoManager(tapes, {
    captureTimeout: Number.POSITIVE_INFINITY,
    trackedOrigins: new Set([entry.origin]),
    captureTransaction: (transaction) =>
      transaction.origin === entry.origin || transaction.origin === manager,
  });
  return manager;
}

function closeHistoryEntry(entry: HistoryEntry): void {
  entry.sealed = true;
  entry.manager?.stopCapturing();
}

function destroyHistoryEntry(entry: HistoryEntry): void {
  entry.manager?.destroy();
}

function updateRevisionsAfterHistory(
  state: Y.Doc,
  before: TapeStateSummary,
): { revision: number; changed: TapeId[] } {
  const changed = changedTapeIds(before, state);
  if (!changed.length)
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
  private readonly sessions = new Map<string, SessionHistory>();
  private readonly acceptedRequests = new Map<
    string,
    { readonly hash: string; readonly sessionId: string; readonly accepted: AcceptedAction }
  >();
  private readonly listeners = new Set<WriterListener>();
  private readonly localQueue: QueuedLocalEdit[] = [];
  private readonly maxHistoryGroups: number;
  private preparing = false;
  private publishing = false;
  private poisoned = false;
  private closed = false;
  private pending?: PendingRecord;
  private sequenceOrdinal = 0;

  constructor(
    private readonly document: CanonicalDocument,
    options: WriterOptions = {},
  ) {
    this.access = canonicalWriterAccess(document);
    assert(!activeWriters.has(document), 'canonical document already has an active writer');
    this.state = this.access.state;
    this.maxHistoryGroups = options.maxHistoryGroups ?? 500;
    assert(
      Number.isSafeInteger(this.maxHistoryGroups) && this.maxHistoryGroups > 0,
      'history limit must be a positive integer',
    );
    activeWriters.set(document, this);
  }

  get poisonedWriter(): boolean {
    return this.poisoned;
  }

  close(): void {
    assert(!this.pending, 'cannot close a writer with an unpublished commit');
    if (this.closed) return;
    for (const session of this.sessions.values()) {
      for (const entry of session.all) destroyHistoryEntry(entry);
      session.all.clear();
      session.undo.length = 0;
      session.redo.length = 0;
      session.current = undefined;
    }
    this.sessions.clear();
    this.acceptedRequests.clear();
    this.listeners.clear();
    this.localQueue.length = 0;
    this.closed = true;
    activeWriters.delete(this.document);
  }

  subscribe(listener: WriterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prepareCommand(options: ActionOptions, callback: (draft: TreeDraft) => void): ActionRequest {
    this.assertCanPrepare();
    assert(options.actionId.length > 0, 'action ID cannot be empty');
    const sessionId = options.sessionId ?? 'local';
    const historyGroupId = options.historyGroupId ?? options.actionId;
    assert(
      sessionId.length > 0 && historyGroupId.length > 0,
      'session and history group IDs cannot be empty',
    );
    const draft = new MutableTreeDraft(this.state, options.actionId);
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
      return copyRequest({
        mode: 'command',
        documentId: metaMap(this.state).get('documentId') as string,
        authorityEpoch: metaMap(this.state).get('authorityEpoch') as string,
        sessionSequence: options.sessionSequence ?? this.nextSequence(sessionId),
        actionId: options.actionId,
        baseRevision: metaMap(this.state).get('acceptedRevision') as number,
        historyGroupId,
        preconditions: draft.readSet,
        operations: draft.operationList,
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
    const record = nodeMap(this.state).get(nodeId);
    assert(record, `unknown node ${nodeId}`);
    const kind = readCell<NodeKind>(record, 'kind');
    assert(INLINE_KINDS.has(kind.value), `${kind.value} nodes do not accept text input`);
    assert(currentActive(this.state, nodeId), `hidden target ${nodeId}`);
    const spans = readCell<readonly Span[]>(record, 'spans');
    const tapes = new Map(tapeMap(this.state).entries());
    const mapped = mapTextEdit(spans.value, tapes, edit);
    const branch = cloneDocument(this.state);
    const stateVector = Y.encodeStateVector(branch);
    try {
      applyMappedTextEdit(
        branch,
        mapped,
        edit.insert,
        Object.freeze({ actionId: options.actionId }),
      );
      const textUpdate = Y.encodeStateAsUpdate(branch, stateVector);
      const request: ActionRequest = {
        mode: 'text-input',
        documentId: metaMap(this.state).get('documentId') as string,
        authorityEpoch: metaMap(this.state).get('authorityEpoch') as string,
        sessionSequence: options.sessionSequence ?? this.nextSequence(sessionId),
        actionId: options.actionId,
        baseRevision: metaMap(this.state).get('acceptedRevision') as number,
        historyGroupId,
        preconditions: [],
        textUpdate: Uint8Array.from(textUpdate),
        operations: [],
        promotionTarget: Object.freeze({ nodeId, kindToken: kind.token, spansToken: spans.token }),
      } as ActionRequest;
      return copyRequest(request);
    } finally {
      branch.destroy();
    }
  }

  apply(requestInput: ActionRequest, admittedContext: AdmittedContext): ApplyResult {
    if (this.closed) return { status: 'rejected', reason: 'closed-writer' };
    if (this.poisoned) return { status: 'rejected', reason: 'poisoned-writer' };
    if (this.pending) return { status: 'rejected', reason: 'pending-commit' };
    if (this.preparing || this.publishing)
      return { status: 'rejected', reason: 'publication-order' };
    let request: ActionRequest;
    try {
      request = copyRequest(requestInput);
      this.validateRequestShape(request);
    } catch {
      return { status: 'rejected', reason: 'invalid-request' };
    }
    const sessionId = admittedContext.sessionId;
    if (!sessionId) return { status: 'rejected', reason: 'wrong-session' };
    const key = actionKey(request.actionId);
    const hash = requestHash(request);
    const prior = this.acceptedRequests.get(key);
    if (prior) {
      return prior.hash === hash && prior.sessionId === sessionId
        ? { status: 'duplicate', accepted: prior.accepted }
        : { status: 'rejected', reason: 'duplicate-action-id' };
    }
    if (request.documentId !== (metaMap(this.state).get('documentId') as string)) {
      return { status: 'rejected', reason: 'wrong-document' };
    }
    const epoch = metaMap(this.state).get('authorityEpoch') as string;
    if (request.authorityEpoch !== epoch || admittedContext.authorityEpoch !== epoch) {
      return { status: 'rejected', reason: 'wrong-authority-epoch' };
    }
    if (admittedContext.sessionId !== sessionId)
      return { status: 'rejected', reason: 'wrong-session' };
    if (admittedContext.sessionSequence !== request.sessionSequence)
      return { status: 'rejected', reason: 'wrong-sequence' };
    if (request.sessionSequence !== this.nextSequence(sessionId))
      return { status: 'rejected', reason: 'wrong-sequence' };
    const revision = metaMap(this.state).get('acceptedRevision') as number;
    if (request.baseRevision > revision)
      return { status: 'rejected', reason: 'future-base-revision' };
    if (
      !request.preconditions.every((precondition) => currentPrecondition(this.state, precondition))
    ) {
      return { status: 'rejected', reason: 'stale-precondition' };
    }

    const previousSummary = tapeStateSummary(this.state);
    const candidate = cloneDocument(this.state);
    let inputChanged: TapeId[] = [];
    const nextRevision = revision + 1;
    try {
      if (request.textUpdate?.length) {
        Y.applyUpdate(candidate, Uint8Array.from(request.textUpdate));
        assertTextOnlyUpdate(this.state, candidate);
        inputChanged = changedTapeIds(previousSummary, candidate);
      }
    } catch {
      candidate.destroy();
      return { status: 'rejected', reason: 'invalid-text-update' };
    }

    let draft: MutableTreeDraft | undefined;
    let plan: LowLevelPlan;
    try {
      draft = new MutableTreeDraft(candidate, request.actionId, request.operations);
      plan = draft.compilePlan();
      draft.close();
      applyPlan(
        candidate,
        plan,
        Object.freeze({ stagedAction: request.actionId }),
        previousSummary,
        nextRevision,
      );
      validateCandidate(this.state, candidate, nextRevision);
    } catch (_error) {
      draft?.close();
      candidate.destroy();
      return { status: 'rejected', reason: 'invalid-operation' };
    }

    const finalChangedTapes = changedTapeIds(previousSummary, candidate);
    const textTapes = new Set([...inputChanged, ...plan.textTapes]);
    const structuralEffect =
      plan.allocations.length > 0 || plan.boundaries.length > 0 || plan.writes.length > 0;
    const noEffect =
      !finalChangedTapes.length &&
      !plan.allocations.length &&
      !plan.boundaries.length &&
      !plan.writes.length &&
      !plan.deletions.length &&
      !plan.insertions.length;
    const target = request.promotionTarget;
    const promotionSkipped =
      target &&
      (!currentActive(this.state, target.nodeId) ||
        nodeCell(this.state, target.nodeId, 'kind').token !== target.kindToken ||
        nodeCell(this.state, target.nodeId, 'spans').token !== target.spansToken)
        ? 'ownershipChanged'
        : undefined;
    const receipt: ActionReceipt = Object.freeze({
      requestId: `${sessionId}:${request.actionId}`,
      historyGroupId: request.historyGroupId,
      touchedNodeIds: Object.freeze([
        ...new Set([...plan.touchedNodes, ...(target ? [target.nodeId] : [])]),
      ]),
      touchedTapeIds: Object.freeze([...new Set([...plan.touchedTapes, ...finalChangedTapes])]),
      noEffect,
      ...(promotionSkipped ? { promotionSkipped } : {}),
    });
    const reservation = this.reserveHistory(
      sessionId,
      request.historyGroupId,
      noEffect,
      structuralEffect,
      [...textTapes],
      receipt,
    );
    const context = Object.freeze({ ...admittedContext });
    const publicPending: PendingCommit = Object.freeze({
      actionId: request.actionId,
      revision: nextRevision,
      update: new Uint8Array(),
      receipt,
    });

    const liveBefore = cloneDocument(this.state);
    const liveSummary = tapeStateSummary(this.state);
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(Uint8Array.from(update));
    this.access.beginPending();
    this.state.on('update', collect);
    try {
      if (request.textUpdate?.length) {
        Y.applyUpdate(this.state, Uint8Array.from(request.textUpdate), reservation.entry.origin);
      }
      applyPlan(this.state, plan, reservation.entry.origin, liveSummary, nextRevision);
      validateCandidate(liveBefore, this.state, nextRevision);
      this.state.off('update', collect);
      liveBefore.destroy();
      const update = Y.mergeUpdates(updates);
      const pending: PendingCommit = Object.freeze({ ...publicPending, update });
      this.pending = { publicValue: pending, context, request, requestHash: hash, reservation };
      candidate.destroy();
      return { status: 'pending', pending };
    } catch (error) {
      this.state.off('update', collect);
      liveBefore.destroy();
      candidate.destroy();
      this.poisoned = true;
      this.access.poison();
      throw new Error(
        `unexpected failure after canonical writes; writer is poisoned: ${String(error)}`,
      );
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
    this.pending = undefined;
    this.publishing = true;
    this.access.publish();
    const callbackErrors: unknown[] = [];
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
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        callbackErrors.push(error);
      }
    }
    Object.freeze(callbackErrors);
    const result = Object.freeze(accepted);
    this.acceptedRequests.set(actionKey(record.request.actionId), {
      hash: record.requestHash,
      sessionId: record.context.sessionId,
      accepted: result,
    });
    this.publishing = false;
    this.flushLocalQueue();
    return result;
  }

  edit(options: ActionOptions, callback: (draft: TreeDraft) => void): AcceptedAction | ApplyResult {
    if (this.publishing) {
      this.localQueue.push({ options: deepCopy(options), callback });
      return { status: 'queued', actionId: options.actionId };
    }
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

  canUndo(sessionId = 'local'): boolean {
    return (this.sessions.get(sessionId)?.undo.length ?? 0) > 0;
  }

  canRedo(sessionId = 'local'): boolean {
    return (this.sessions.get(sessionId)?.redo.length ?? 0) > 0;
  }

  undo(sessionId = 'local'): HistoryResult {
    return this.applyHistory(sessionId, 'undo');
  }

  redo(sessionId = 'local'): HistoryResult {
    return this.applyHistory(sessionId, 'redo');
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
  ): HistoryReservation {
    const session = this.getSession(sessionId);
    const canJoin =
      !noEffect &&
      !structuralEffect &&
      textTapes.length > 0 &&
      session.current?.groupId === groupId &&
      !session.current.sealed;
    if (canJoin) {
      const entry = session.current!;
      if (textTapes.length && !entry.manager) {
        Object.assign(entry, { manager: makeTextHistoryManager(this.state, entry) });
      }
      return {
        sessionId,
        entry,
        isNew: false,
        nextCurrent: true,
        noEffect,
        structuralEffect,
        textTapes,
      };
    }
    if (session.current) {
      closeHistoryEntry(session.current);
      session.current = undefined;
    }
    const entryId = noEffect
      ? `${groupId}:noop:${receipt.requestId}`
      : `${groupId}:${receipt.requestId}`;
    const base = {
      id: entryId,
      sessionId,
      groupId,
      createdSequence: this.sequenceOrdinal++,
      origin: Object.freeze({ entryId }),
      textTapes: new Set(textTapes),
      sealed: noEffect || structuralEffect,
      noEffect,
      structuralEffect,
      actionCount: 0,
    };
    const manager = textTapes.length
      ? makeTextHistoryManager(this.state, base as HistoryEntry)
      : undefined;
    const entry: HistoryEntry = { ...base, ...(manager ? { manager } : {}) };
    return {
      sessionId,
      entry,
      isNew: true,
      nextCurrent: !noEffect && !structuralEffect && textTapes.length > 0,
      noEffect,
      structuralEffect,
      textTapes,
    };
  }

  private finishHistory(reservation: HistoryReservation): void {
    const session = this.getSession(reservation.sessionId);
    for (const redo of session.redo.splice(0)) {
      session.all.delete(redo);
      destroyHistoryEntry(redo);
    }
    const entry = reservation.entry;
    if (reservation.isNew) {
      session.undo.push(entry);
      session.all.add(entry);
    }
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

  private applyHistory(sessionId: string, direction: 'undo' | 'redo'): HistoryResult {
    if (this.closed) return { status: 'blocked', reason: 'structural-history-pending' };
    if (this.poisoned) return { status: 'blocked', reason: 'structural-history-pending' };
    if (this.pending || this.preparing || this.publishing)
      return { status: 'blocked', reason: 'structural-history-pending' };
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'empty' };
    const source = direction === 'undo' ? session.undo : session.redo;
    const destination = direction === 'undo' ? session.redo : session.undo;
    const entry = source.at(-1);
    if (!entry) return { status: 'empty' };
    if (entry.structuralEffect) return { status: 'blocked', reason: 'structural-history-pending' };
    const manager = entry.manager;
    if (!manager || !(direction === 'undo' ? manager.undoStack.length : manager.redoStack.length)) {
      source.pop();
      destination.push(entry);
      if (session.current === entry) session.current = undefined;
      return { status: 'no-effect' };
    }

    const before = tapeStateSummary(this.state);
    const markersBefore = markerSummary(this.state);
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(Uint8Array.from(update));
    const liveBefore = cloneDocument(this.state);
    this.access.beginPending();
    this.state.on('update', collect);
    try {
      if (direction === 'undo') manager.undo();
      else manager.redo();
      for (const [id, tape] of tapeMap(this.state).entries()) {
        assert(
          markersBefore.get(id) === boundarySignature(tape),
          `native history changed markers on tape ${id}`,
        );
      }
      const updated = updateRevisionsAfterHistory(this.state, before);
      if (updated.changed.length) {
        validateCandidate(liveBefore, this.state, updated.revision);
      }
      this.state.off('update', collect);
      liveBefore.destroy();
      source.pop();
      destination.push(entry);
      if (session.current === entry) session.current = undefined;
      const update = updates.length ? Y.mergeUpdates(updates) : undefined;
      this.publishing = true;
      this.access.publish();
      const callbackErrors = this.notifyListeners({
        type: 'history',
        revision: updated.changed.length ? updated.revision : undefined,
      });
      this.publishing = false;
      this.flushLocalQueue();
      return {
        status: updated.changed.length ? 'applied' : 'no-effect',
        ...(updated.changed.length ? { revision: updated.revision } : {}),
        ...(update ? { update } : {}),
        callbackErrors,
      };
    } catch (error) {
      this.state.off('update', collect);
      liveBefore.destroy();
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

  private trimHistory(session: SessionHistory): void {
    while (session.all.size > this.maxHistoryGroups) {
      const oldest = [...session.all].sort((a, b) => a.createdSequence - b.createdSequence)[0];
      if (!oldest) return;
      session.all.delete(oldest);
      session.undo.splice(session.undo.indexOf(oldest), session.undo.includes(oldest) ? 1 : 0);
      session.redo.splice(session.redo.indexOf(oldest), session.redo.includes(oldest) ? 1 : 0);
      if (session.current === oldest) session.current = undefined;
      destroyHistoryEntry(oldest);
    }
  }

  private getSession(sessionId: string): SessionHistory {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { sequence: 0, undo: [], redo: [], all: new Set() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private nextSequence(sessionId: string): number {
    return (this.sessions.get(sessionId)?.sequence ?? 0) + 1;
  }

  private validateRequestShape(request: ActionRequest): void {
    assert(request.mode === 'command' || request.mode === 'text-input', 'unknown action mode');
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
    }
  }

  private assertCanPrepare(): void {
    assert(!this.closed, 'canonical writer is closed');
    assert(!this.poisoned, 'canonical writer is poisoned');
    assert(!this.pending, 'canonical writer has an unpublished commit');
    assert(!this.preparing, 'nested draft preparation is not allowed');
  }

  private flushLocalQueue(): void {
    if (!this.localQueue.length) return;
    const queued = this.localQueue.splice(0);
    for (const item of queued) queueMicrotask(() => this.edit(item.options, item.callback));
  }
}
