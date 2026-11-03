import * as Y from 'yjs';

import type { NodeId, NodeKind } from '../semantic/types.js';
import type { Span, TapeId } from '../canonical-model.js';
import type { CanonicalTextEdit } from './action-types.js';
import { META, NODES, TAPES, TAPE_REVISIONS, readSchemaCell, schemaMap } from './schema.js';
import { indexNativeTape, indexProjectedSpans, mapProjectedTextEdit } from '../canonical-text.js';
import type { NativeTapeIndex, ProjectedTextIndex } from '../canonical-text.js';
import { stableJson } from './util.js';

type RecordMap = Y.Map<unknown>;
const INLINE_KINDS = new Set<NodeKind>(['paragraph', 'section', 'code-block']);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export class CanonicalIndexes {
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

    const nodes = schemaMap<RecordMap>(this.state, NODES);
    for (const [id, record] of nodes) {
      this.nodeIds.add(id);
      for (const child of readSchemaCell<readonly NodeId[]>(record, 'children').value) {
        this.parentByChild.set(child, id);
      }
    }
    const rootId = schemaMap<unknown>(this.state, META).get('rootId') as NodeId;
    const pending = [rootId];
    while (pending.length) {
      const id = pending.pop()!;
      if (this.activeNodes.has(id)) continue;
      this.activeNodes.add(id);
      const record = nodes.get(id);
      if (record) {
        if (INLINE_KINDS.has(readSchemaCell<NodeKind>(record, 'kind').value)) {
          this.visibleInlinePosition.set(id, this.visibleInlineNodeIds.length);
          this.visibleInlineNodeIds.push(id);
        }
        const children = readSchemaCell<readonly NodeId[]>(record, 'children').value;
        for (let index = children.length - 1; index >= 0; index--) {
          pending.push(children[index]!);
        }
      }
    }

    for (const [id, record] of nodes) {
      const ownerActive = this.activeNodes.has(id);
      for (const span of readSchemaCell<readonly Span[]>(record, 'spans').value) {
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

    for (const [tapeId, tape] of schemaMap<Y.Text>(this.state, TAPES)) {
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

  mapTextEdit(nodeId: NodeId, spans: readonly Span[], edit: CanonicalTextEdit) {
    const indexed = this.projected(nodeId, spans);
    return mapProjectedTextEdit(indexed.index, edit);
  }

  private projected(nodeId: NodeId, knownSpans?: readonly Span[]) {
    const record = schemaMap<RecordMap>(this.state, NODES).get(nodeId);
    assert(record, `unknown node ${nodeId}`);
    const spansCell = readSchemaCell<readonly Span[]>(record, 'spans');
    const spans = knownSpans ?? spansCell.value;
    const signature = stableJson([
      spansCell.token,
      ...spans.map((span) => [
        span.tapeId,
        schemaMap<number>(this.state, TAPE_REVISIONS).get(span.tapeId),
      ]),
    ]);
    const cached = this.projectedByNode.get(nodeId);
    if (cached?.signature === signature) return cached;
    const index = indexProjectedSpans(spans, this.textIndexes);
    const result = { signature, index };
    this.projectedByNode.set(nodeId, result);
    return result;
  }

  refreshText(tapeIds: Iterable<TapeId>): void {
    const tapes = schemaMap<Y.Text>(this.state, TAPES);
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
