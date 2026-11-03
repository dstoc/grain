import * as Y from 'yjs';

import { CanonicalIndexes } from '../indexes.js';
import { deepCopy, deepFreeze, stableJson } from '../util.js';
import {
  immutableCell,
  metaMap,
  nodeMap,
  readCell,
  revisionMap,
  spanText,
  tapeMap,
} from '../state-access.js';
import type { CellValue } from '../state-access.js';
import type { Span, TapeId } from '../../canonical-model.js';
import type { NodeId, NodeKind, TextAffinity } from '../../semantic/types.js';
import { assertTextEdit, splitsSurrogatePair } from '../../semantic/types.js';
import type {
  Bookmark,
  CanonicalTextEdit,
  CellField,
  NodeSpec,
  ReadPrecondition,
  SemanticOperation,
} from '../action-types.js';
import type {
  ConversionPlan,
  DraftNode,
  DraftTextPiece,
  InlineFragment,
  ParserTreeDraft,
  Transfer,
} from '../../semantic/draft.js';
import { mapTextEdit, mapTextEditIndexed } from '../../canonical-text.js';
import type { NativeTextRun } from '../../canonical-text.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const INLINE_KINDS = new Set<NodeKind>(['paragraph', 'section', 'code-block']);
const CONTAINER_KINDS = new Set<NodeKind>(['document', 'section', 'list-item', 'block-quote']);
const BLOCK_KINDS = new Set<NodeKind>([
  'paragraph',
  'section',
  'code-block',
  'list',
  'block-quote',
]);

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

export interface LowLevelPlan {
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

export class MutableTreeDraft implements ParserTreeDraft {
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

  spliceText(id: NodeId, edit: CanonicalTextEdit): void {
    this.apply({ type: 'spliceText', id, edit: deepFreeze(deepCopy(edit)) }, true);
  }

  cutInline(id: NodeId, from: number, to: number): InlineFragment {
    const fragmentId = this.allocateId('fragment');
    this.apply({ type: 'cutInline', id, from, to, fragmentId }, true);
    const fragment = this.fragments.get(fragmentId);
    assert(fragment, 'cut did not create a fragment');
    const handle = Object.freeze({ text: fragment.text }) as InlineFragment;
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
    assert(!splitsSurrogatePair(content, offset), 'bookmark splits a surrogate pair');
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
    const untypedSpec = spec as unknown as {
      readonly type: NodeKind;
      readonly children?: readonly NodeId[];
    };
    assert(!this.indexes.nodeIds.has(id) && !this.nodes.has(id), `node ID ${id} already exists`);
    this.reserveId(id);
    this.generatedIds.add(id);
    assert(untypedSpec.type !== 'document', 'a draft cannot create another document root');
    assert(
      !untypedSpec.children?.length,
      'create nodes without children, then place each child explicitly',
    );
    if (INLINE_KINDS.has(spec.type)) assert(span, 'inline node creation requires tape markers');
    else assert(!span, 'non-inline node cannot allocate an inline tape');
    const content = ('content' in spec ? spec.content : undefined) ?? '';
    assert(
      INLINE_KINDS.has(spec.type) || !('content' in spec) || spec.content === undefined,
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
      ('marker' in spec ? spec.marker : undefined) ??
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
      children: [],
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
      checked: ('checked' in spec ? spec.checked : undefined) ?? null,
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

  private spliceInternal(id: NodeId, edit: CanonicalTextEdit): void {
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

  private validateDraftEdit(content: string, edit: CanonicalTextEdit): void {
    assertTextEdit(content, edit);
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
      !splitsSurrogatePair(destinationContent, transfer.at),
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
      !splitsSurrogatePair(content, from) && !splitsSurrogatePair(content, to),
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
    assert(!splitsSurrogatePair(content, at), 'fragment target splits a surrogate pair');
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
      !splitsSurrogatePair(content, transfer.from) && !splitsSurrogatePair(content, transfer.to),
      'transfer splits a surrogate pair',
    );
    assert(
      Number.isInteger(transfer.at) && transfer.at >= 0 && transfer.at <= content.length,
      'transfer destination is out of bounds',
    );
    assert(
      !splitsSurrogatePair(content, transfer.at),
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
