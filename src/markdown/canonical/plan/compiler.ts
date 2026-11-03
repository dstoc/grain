import { immutableCell } from '../state-access.js';
import type { CellValue } from '../state-access.js';
import { deepCopy, deepFreeze, stableJson } from '../util.js';
import { mapTextEditIndexed } from '../../canonical-text.js';
import type { NativeTextRun } from '../../canonical-text.js';
import type { Span, TapeId } from '../types.js';
import type { CellField } from '../action-types.js';
import type {
  DraftCompilationSnapshot,
  DraftTextBuffer,
  InsertedPiece,
  LowLevelPlan,
  PlanBoundary,
  PlanNodeAllocation,
  PlanTextInsert,
} from './types.js';
import type { NodeId } from '../../semantic/types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export function compilePlan(snapshot: DraftCompilationSnapshot): LowLevelPlan {
  const allocations: PlanNodeAllocation[] = [];
  const newTapes: { id: TapeId; span: Span }[] = [];
  const deletions: NativeTextRun[] = [];
  const writes: { nodeId: NodeId; field: CellField; value: unknown; token: string }[] = [];
  const touchedNodes = new Set<NodeId>();
  const touchedTapes = new Set<TapeId>();
  const textTapes = new Set<TapeId>();
  const finalTapeIds = new Set<TapeId>();
  for (const candidate of snapshot.nodes) {
    for (const span of candidate.spans) finalTapeIds.add(span.span.tapeId);
  }
  for (const node of snapshot.nodes) {
    if (node.created) {
      const spans = node.spans.map((span) => deepFreeze(deepCopy(span.span)));
      const cells: Record<CellField, CellValue<unknown>> = {
        kind: immutableCell(snapshot.allocateCellToken(), node.type),
        children: immutableCell(snapshot.allocateCellToken(), []),
        spans: immutableCell(snapshot.allocateCellToken(), spans),
        marker: immutableCell(snapshot.allocateCellToken(), node.marker),
        checked: immutableCell(snapshot.allocateCellToken(), node.checked),
        info: immutableCell(snapshot.allocateCellToken(), node.info),
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
      const createdSpan = snapshot.newTapeSpans.get(node.id);
      if (createdSpan && finalTapeIds.has(createdSpan.tapeId)) {
        newTapes.push({ id: createdSpan.tapeId, span: createdSpan });
        touchedTapes.add(createdSpan.tapeId);
      }
    }

    if (node.textEdited && !node.created) {
      const baseSpans = node.baseCells.get('spans')!.value as readonly Span[];
      const baseStarts: number[] = [];
      let baseLength = 0;
      const baseTexts = snapshot.baseTextByNode.get(node.id);
      assert(baseTexts, `missing immutable base text for ${node.id}`);
      for (const text of baseTexts) {
        baseStarts.push(baseLength);
        baseLength += text.length;
      }
      for (let spanIndex = 0; spanIndex < baseSpans.length; spanIndex++) {
        const baseText = baseTexts[spanIndex]!;
        const retained = [...snapshot.nodes]
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
            const mapped = mapTextEditIndexed(baseSpans, snapshot.textIndexes, {
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
          const mapped = mapTextEditIndexed(baseSpans, snapshot.textIndexes, {
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
            token: snapshot.allocateCellToken(),
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
          token: snapshot.allocateCellToken(),
        });
        touchedNodes.add(node.id);
        for (const span of node.spans) touchedTapes.add(span.span.tapeId);
      }
    }
  }

  for (const node of snapshot.nodes) {
    for (const span of node.spans) {
      for (const piece of span.pieces) {
        if (piece.kind !== 'inserted' || !piece.text) continue;
        touchedTapes.add(piece.anchor.tapeId);
        textTapes.add(piece.anchor.tapeId);
      }
    }
  }

  const textProjection = compileTextProjection(snapshot);
  const insertions = textProjection.insertions;
  for (const boundary of snapshot.transferBoundaries) touchedTapes.add(boundary.tapeId);
  const operationNodeIds = snapshot.operations.flatMap((operation) => {
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
  const plan: LowLevelPlan = Object.freeze({
    allocations: Object.freeze(allocations),
    newTapes: Object.freeze(newTapes),
    boundaries: Object.freeze(
      finalTransferBoundaries(snapshot, textProjection.boundaryOffsets).map((item) =>
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
  return plan;
}

function compileTextProjection(snapshot: DraftCompilationSnapshot): {
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
  const pathForNode = (id: NodeId): readonly number[] | undefined => snapshot.semanticPaths.get(id);

  const referencedBoundaries = new Set<string>();
  for (const node of snapshot.nodes) {
    for (const span of node.spans) {
      referencedBoundaries.add(span.span.startBoundaryId);
      referencedBoundaries.add(span.span.endBoundaryId);
    }
  }
  const boundaryPlans = new Map(
    snapshot.transferBoundaries
      .filter((boundary) => referencedBoundaries.has(boundary.boundaryId))
      .map((boundary) => [boundary.boundaryId, boundary]),
  );
  const splitOffsets = new Map<string, Set<number>>();
  const addSplitOffset = (bufferId: string, offset: number): void => {
    const offsets = splitOffsets.get(bufferId) ?? new Set<number>();
    offsets.add(offset);
    splitOffsets.set(bufferId, offsets);
  };
  for (const [bufferId, buffer] of snapshot.textBuffers) {
    if (buffer.parentBufferId !== undefined) {
      const parent = snapshot.textBuffers.get(buffer.parentBufferId);
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
    let current = snapshot.textBuffers.get(currentId);
    assert(current, `missing action-local text buffer ${currentId}`);
    while (current) {
      chain.push(current);
      if (current.parentBufferId === undefined) break;
      currentId = current.parentBufferId;
      current = snapshot.textBuffers.get(currentId);
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
    const buffer = snapshot.textBuffers.get(piece.bufferId);
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

  for (const node of snapshot.nodes) {
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
      const buffer = snapshot.textBuffers.get(event.bufferId!)!;
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

function finalTransferBoundaries(
  snapshot: DraftCompilationSnapshot,
  boundaryOffsets: ReadonlyMap<string, number>,
): PlanBoundary[] {
  const referenced = new Set<string>();
  for (const node of snapshot.nodes) {
    for (const span of node.spans) {
      referenced.add(span.span.startBoundaryId);
      referenced.add(span.span.endBoundaryId);
    }
  }

  return snapshot.transferBoundaries.flatMap((boundary) => {
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
