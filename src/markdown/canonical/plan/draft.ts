import * as Y from 'yjs';

import { CanonicalIndexes } from '../indexes.js';
import { INLINE_KINDS, isAllowedChild } from '../schema.js';
import { deepCopy, deepFreeze, stableJson } from '../util.js';
import { metaMap, nodeMap, readCell, revisionMap, spanText, tapeMap } from '../state-access.js';
import type { Span, TapeId } from '../types.js';
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
import { mapTextEdit } from '../../canonical-text.js';
import type { NativeTapeIndex } from '../../canonical-text.js';
import { compilePlan } from './compiler.js';
import { DraftFragments } from './fragments.js';
import type {
  DraftCompilationSnapshot,
  DraftNodeState,
  DraftPiece,
  DraftSpan,
  InsertedPiece,
  InternalCell,
  LowLevelPlan,
} from './types.js';
export type { LowLevelPlan } from './types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  private readonly fragments: DraftFragments;
  private idOrdinal = 0;
  private compiledPlan?: LowLevelPlan;

  constructor(
    private readonly state: Y.Doc,
    private readonly actionId: string,
    private readonly indexes: CanonicalIndexes,
    operations?: readonly SemanticOperation[],
  ) {
    this.fragments = new DraftFragments({
      allNodes: () => this.nodes.values(),
      requireNode: (id) => this.requireNode(id),
      ensureVisibleOrCreated: (node) => this.ensureVisibleOrCreated(node),
      readText: (node) => this.readText(node),
      baseSpans: (id) => this.baseSpans(id),
      sourceText: (span) => spanText(this.state, span, this.indexes),
      mapInsertion: (spans, offset, affinity) =>
        mapTextEdit(spans, this.tapesFor(spans), {
          from: offset,
          to: offset,
          insert: '',
          affinity,
        }).insertion,
      allocateId: (role) => this.allocateId(role),
    });
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
    this.fragments.dropUnusedCreatedInsertionSpans(this.newTapeSpans);
    this.fragments.assertAllConsumed();
    this.fragments.assertPieceSources();
    this.compiledPlan = compilePlan(this.compilationSnapshot());
    return this.compiledPlan;
  }

  private compilationSnapshot(): DraftCompilationSnapshot {
    const textIndexes = new Map<TapeId, NativeTapeIndex>();

    const semanticPaths = new Map<NodeId, readonly number[] | undefined>();
    const pathForNode = (id: NodeId): readonly number[] | undefined => {
      if (semanticPaths.has(id)) return semanticPaths.get(id);
      const path: number[] = [];
      let current = id;
      const root = this.rootId();
      while (current !== root) {
        const parentId = this.parentId(current);
        if (!parentId) {
          semanticPaths.set(id, undefined);
          return undefined;
        }
        const parent = this.requireNode(parentId);
        const index = parent.children.indexOf(current);
        if (index < 0) {
          semanticPaths.set(id, undefined);
          return undefined;
        }
        path.push(index);
        current = parentId;
      }
      path.reverse();
      const frozen = Object.freeze(path);
      semanticPaths.set(id, frozen);
      return frozen;
    };
    for (const node of this.nodes.values()) pathForNode(node.id);

    const baseTextByNode = new Map<NodeId, readonly string[]>();
    for (const node of this.nodes.values()) {
      if (!node.textEdited || node.created) continue;
      const spans = node.baseCells.get('spans')!.value as readonly Span[];
      for (const span of spans) {
        const index = this.indexes.textIndexes.get(span.tapeId);
        assert(index, `missing native text index for ${span.tapeId}`);
        textIndexes.set(span.tapeId, index);
      }
      baseTextByNode.set(
        node.id,
        Object.freeze(spans.map((span) => spanText(this.state, span, this.indexes))),
      );
    }

    const nodes = Object.freeze(
      [...this.nodes.values()].map((node) => {
        const baseCells = new Map(
          [...node.baseCells].map(([field, cell]) => [
            field,
            Object.freeze({ token: cell.token, value: cell.value }),
          ]),
        );
        const spans = Object.freeze(
          node.spans.map((span) =>
            Object.freeze({
              span: Object.freeze({ ...span.span }),
              pieces: Object.freeze(
                span.pieces.map((piece) =>
                  Object.freeze({
                    ...piece,
                    ...(piece.kind === 'inserted'
                      ? { anchor: Object.freeze({ ...piece.anchor }) }
                      : {}),
                  }),
                ),
              ),
            }),
          ),
        );
        return Object.freeze({
          id: node.id,
          type: node.type,
          children: Object.freeze([...node.children]),
          spans,
          marker: node.marker,
          checked: node.checked,
          info: node.info,
          baseCells,
          created: node.created,
          textEdited: node.textEdited,
        });
      }),
    );
    const textBuffers = new Map(this.fragments.textBufferSnapshot());
    return Object.freeze({
      nodes,
      operations: Object.freeze(
        this.operations_.map((operation) => deepFreeze(deepCopy(operation))),
      ),
      newTapeSpans: new Map(this.newTapeSpans),
      transferBoundaries: Object.freeze(
        this.fragments.boundaryPlans.map((boundary) => Object.freeze({ ...boundary })),
      ),
      textBuffers,
      textIndexes,
      baseTextByNode,
      semanticPaths,
      allocateCellToken: () => this.allocateId('cell'),
    });
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
    return this.fragments.handleFor(fragmentId);
  }

  insertFragment(
    destination: NodeId,
    at: number,
    affinity: TextAffinity,
    fragment: InlineFragment,
  ): void {
    const fragmentId = this.fragments.fragmentIdFor(fragment);
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
        this.fragments.applyCut(operation.id, operation.from, operation.to, operation.fragmentId);
        break;
      case 'insertFragment':
        this.fragments.applyInsert(
          operation.destination,
          operation.at,
          operation.affinity,
          operation.fragmentId,
        );
        break;
      case 'transferInlineRange':
        this.fragments.transferInlineRange(operation.transfer);
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
                    this.fragments.createInsertedPiece(
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
      isAllowedChild(parent.type, node.type),
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
    const target = this.fragments.insertionTarget(node, edit.from, affinity);

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
        ...this.fragments.createInsertedPiece(target.anchor, edit.insert),
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
