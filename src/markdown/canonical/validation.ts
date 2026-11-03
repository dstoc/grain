import * as Y from 'yjs';

import {
  INLINE_KINDS,
  META,
  NODE_FIELDS,
  NODES,
  SCHEMA_VERSION,
  TAPES,
  TAPE_REVISIONS,
  isAllowedChild,
  nodeCell,
  nodeKind,
  readChildren,
  readChildrenToken,
  readNodeCell,
  readSpans,
} from './schema.js';
import type { BoundaryEmbed, BoundaryId, Cell, Span, TapeId } from './types.js';
import type { NodeKind } from '../semantic/types.js';

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

type RecordMap = Y.Map<unknown>;

interface TapePositions {
  readonly deltas: readonly {
    readonly insert: unknown;
    readonly attributes?: Record<string, unknown>;
  }[];
  readonly boundaries: ReadonlyMap<BoundaryId, number>;
  readonly boundaryOrder: readonly { id: BoundaryId; index: number }[];
  readonly duplicateBoundaries: ReadonlySet<BoundaryId>;
  readonly length: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ymap<T>(document: Y.Doc, name: string): Y.Map<T> {
  return document.getMap<T>(name);
}

function cellValue<T>(record: RecordMap, field: (typeof NODE_FIELDS)[number]): Cell<T> {
  return readNodeCell<T>(record, field) as Cell<T>;
}

function childrenToken(record: RecordMap): string {
  return readChildrenToken(record);
}

function tapePositions(tape: Y.Text): TapePositions {
  const deltas = tape.toDelta();
  const boundaries = new Map<BoundaryId, number>();
  const boundaryOrder: { id: BoundaryId; index: number }[] = [];
  const duplicateBoundaries = new Set<BoundaryId>();
  let index = 0;
  for (const delta of deltas) {
    const insert = delta.insert;
    if (typeof insert === 'string') {
      index += insert.length;
    } else {
      if (
        insert !== null &&
        typeof insert === 'object' &&
        'grainBoundary' in insert &&
        typeof (insert as BoundaryEmbed).grainBoundary === 'string'
      ) {
        const id = (insert as BoundaryEmbed).grainBoundary;
        if (!boundaries.has(id)) {
          boundaries.set(id, index);
          boundaryOrder.push({ id, index });
        } else {
          duplicateBoundaries.add(id);
        }
      }
      index++;
    }
  }
  return { deltas, boundaries, boundaryOrder, duplicateBoundaries, length: index };
}

function metaValue<T>(meta: Y.Map<unknown>, key: string): T {
  return meta.get(key) as T;
}

export function validateRetainedForestState(backing: Y.Doc): ValidationResult {
  const errors: string[] = [];
  const nodes = ymap<RecordMap>(backing, NODES);
  const meta = ymap<unknown>(backing, META);
  const rootId = metaValue<string>(meta, 'rootId');
  const schemaVersion = metaValue<number>(meta, 'schemaVersion');

  if (typeof rootId !== 'string' || !nodes.has(rootId)) errors.push('fixed root node is missing');
  if (schemaVersion !== 1 && schemaVersion !== SCHEMA_VERSION) {
    errors.push(`unsupported canonical schema version ${schemaVersion}`);
  }
  const parents = new Map<string, string[]>();
  const kinds = new Map<string, NodeKind>();
  const edges = new Map<string, readonly string[]>();
  const tokens = new Map<string, string>();

  for (const [id, record] of nodes.entries()) {
    for (const field of NODE_FIELDS) {
      try {
        const item = cellValue<unknown>(record, field);
        const previous = tokens.get(item.token);
        if (previous)
          errors.push(`cell token ${item.token} is shared by ${previous} and ${id}.${field}`);
        else tokens.set(item.token, `${id}.${field}`);
        if (item.value && typeof item.value === 'object') {
          // Cell payloads are JSON values, not mutable or cyclic shared objects.
          assert(!ArrayBuffer.isView(item.value), `node ${id} field ${field} is not JSON`);
        }
      } catch (error) {
        errors.push(`node ${id} has invalid ${field} cell: ${String(error)}`);
      }
    }
    try {
      const childValue = record.get('children');
      if (childValue instanceof Y.Array) {
        assert(schemaVersion === SCHEMA_VERSION, 'children array is not valid in schema 1');
        const token = childrenToken(record);
        const previous = tokens.get(token);
        if (previous)
          errors.push(`cell token ${token} is shared by ${previous} and ${id}.children`);
        else tokens.set(token, `${id}.children`);
        if (childValue.toArray().some((item) => typeof item !== 'string')) {
          errors.push(`node ${id} children array must contain node IDs`);
        }
      } else {
        // Schema 1 is readable only by the explicit migration path.
        assert(schemaVersion === 1, 'schema 2 requires permanent children arrays');
        const legacy = childValue as Cell<unknown> | undefined;
        assert(
          legacy !== null && typeof legacy === 'object' && typeof legacy.token === 'string',
          'legacy children cell is invalid',
        );
        const previous = tokens.get(legacy.token);
        if (previous)
          errors.push(`cell token ${legacy.token} is shared by ${previous} and ${id}.children`);
        else tokens.set(legacy.token, `${id}.children`);
      }
    } catch (error) {
      errors.push(`node ${id} has invalid children storage: ${String(error)}`);
    }
    try {
      const kind = nodeKind(record);
      kinds.set(id, kind);
      const childIds = readChildren(record);
      edges.set(id, childIds);
      if (new Set(childIds).size !== childIds.length)
        errors.push(`node ${id} contains duplicate child IDs`);
      for (const childId of childIds) {
        if (!nodes.has(childId)) {
          errors.push(`node ${id} refers to missing child ${childId}`);
          continue;
        }
        const seenBy = parents.get(childId) ?? [];
        seenBy.push(id);
        parents.set(childId, seenBy);
      }
      const spans = readSpans(record);
      if (!Array.isArray(spans)) errors.push(`node ${id} spans are invalid`);
      if (!INLINE_KINDS.has(kind) && spans.length !== 0)
        errors.push(`non-inline node ${id} owns text spans`);
      const marker = nodeCell<unknown>(record, 'marker');
      const checked = nodeCell<unknown>(record, 'checked');
      const info = nodeCell<unknown>(record, 'info');
      if (marker !== null && typeof marker !== 'string')
        errors.push(`node ${id} marker is invalid`);
      if (checked !== null && typeof checked !== 'boolean')
        errors.push(`node ${id} checked state is invalid`);
      if (info !== null && typeof info !== 'string') errors.push(`node ${id} code info is invalid`);
      if (!['section', 'list-item', 'block-quote'].includes(kind) && marker !== null) {
        errors.push(`node ${id} has an inapplicable marker`);
      }
      if (kind !== 'list-item' && checked !== null)
        errors.push(`node ${id} has an inapplicable checked state`);
      if (kind !== 'code-block' && info !== null)
        errors.push(`node ${id} has inapplicable code info`);
    } catch (error) {
      errors.push(`node ${id} has invalid structural fields: ${String(error)}`);
    }
  }

  if (nodes.has(rootId)) {
    if (kinds.get(rootId) !== 'document') errors.push('fixed root node must have document kind');
  }
  for (const [id, kind] of kinds) {
    if (kind === 'document' && id !== rootId)
      errors.push(`non-root node ${id} cannot have document kind`);
  }
  for (const [childId, parentIds] of parents) {
    if (parentIds.length > 1)
      errors.push(`node ${childId} has multiple parents: ${parentIds.join(', ')}`);
    if (childId === rootId) errors.push('fixed root node cannot have a parent');
  }
  for (const [parentId, childIds] of edges) {
    const parentKind = kinds.get(parentId);
    if (!parentKind) continue;
    for (const childId of childIds) {
      const childKind = kinds.get(childId);
      if (childKind && !isAllowedChild(parentKind, childKind)) {
        errors.push(
          `node ${parentId} of kind ${parentKind} cannot contain ${childId} of kind ${childKind}`,
        );
      }
    }
  }

  const color = new Map<string, 0 | 1 | 2>();
  const visit = (id: string) => {
    const state = color.get(id) ?? 0;
    if (state === 1) {
      errors.push(`retained node graph contains a cycle at ${id}`);
      return;
    }
    if (state === 2) return;
    color.set(id, 1);
    for (const child of edges.get(id) ?? []) if (nodes.has(child)) visit(child);
    color.set(id, 2);
  };
  for (const id of nodes.keys()) visit(id);

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function validateActiveSpansState(backing: Y.Doc): ValidationResult {
  const errors: string[] = [];
  const nodes = ymap<RecordMap>(backing, NODES);
  const tapes = ymap<Y.Text>(backing, TAPES);
  const revisions = ymap<number>(backing, TAPE_REVISIONS);
  const rootId = metaValue(ymap<unknown>(backing, META), 'rootId') as string;
  const documentId = metaValue<string>(ymap<unknown>(backing, META), 'documentId');
  const active = new Set<string>();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop()!;
    if (active.has(id)) continue;
    active.add(id);
    const record = nodes.get(id);
    if (record) {
      try {
        pending.push(...readChildren(record));
      } catch {
        // The retained-forest validator reports malformed child cells independently.
      }
    }
  }

  const indexedTapes = new Map<string, TapePositions>();
  const activeIntervals = new Map<TapeId, { start: number; end: number; nodeId: string }[]>();
  const allBoundaryIds = new Map<BoundaryId, string>();
  const permanentIds = new Set<string>([documentId]);
  const acceptedRevision = metaValue<number>(ymap<unknown>(backing, META), 'acceptedRevision');
  for (const [sessionId, watermark] of ymap<number>(backing, 'sessionWatermarks')) {
    if (!sessionId || !Number.isSafeInteger(watermark) || watermark < 1) {
      errors.push(`session ${sessionId} has an invalid committed watermark`);
    }
  }
  if (!Number.isSafeInteger(acceptedRevision) || acceptedRevision < 0) {
    errors.push('accepted revision is invalid');
  }
  if (!documentId) errors.push('document ID cannot be empty');
  for (const id of nodes.keys()) {
    if (!id) errors.push('node ID cannot be empty');
    if (permanentIds.has(id)) errors.push(`duplicate document ID ${id}`);
    permanentIds.add(id);
  }
  for (const [tapeId, tape] of tapes.entries()) {
    if (!tapeId) errors.push('tape ID cannot be empty');
    if (permanentIds.has(tapeId)) errors.push(`duplicate document ID ${tapeId}`);
    permanentIds.add(tapeId);
    if (!(tape instanceof Y.Text)) {
      errors.push(`registered tape ${tapeId} is not a Y.Text`);
      continue;
    }
    const index = tapePositions(tape);
    indexedTapes.set(tapeId, index);
    const revision = revisions.get(tapeId);
    if (!Number.isSafeInteger(revision) || (revision ?? -1) < 0) {
      errors.push(`tape ${tapeId} has an invalid revision`);
    } else if (revision! > acceptedRevision) {
      errors.push(`tape ${tapeId} revision is ahead of accepted state`);
    }
    for (const boundaryId of index.duplicateBoundaries) {
      errors.push(`boundary ${boundaryId} occurs more than once on tape ${tapeId}`);
    }
    if (index.boundaryOrder.length < 2) errors.push(`tape ${tapeId} is missing retained sentinels`);
    const first = index.deltas[0]?.insert;
    const last = index.deltas.at(-1)?.insert;
    if (
      first === undefined ||
      typeof first === 'string' ||
      last === undefined ||
      typeof last === 'string'
    )
      errors.push(`tape ${tapeId} must begin and end with boundary embeds`);
    if (
      index.boundaryOrder.length >= 2 &&
      index.boundaryOrder[0]?.id === index.boundaryOrder.at(-1)?.id
    ) {
      errors.push(`tape ${tapeId} sentinel identities must be distinct`);
    }
    for (const boundary of index.boundaryOrder) {
      if (!boundary.id) errors.push(`tape ${tapeId} has an empty boundary ID`);
      const previousTape = allBoundaryIds.get(boundary.id);
      if (previousTape !== undefined)
        errors.push(`boundary ${boundary.id} appears on multiple tapes`);
      else allBoundaryIds.set(boundary.id, tapeId);
      if (permanentIds.has(boundary.id)) errors.push(`duplicate document ID ${boundary.id}`);
      permanentIds.add(boundary.id);
    }
    for (const delta of index.deltas) {
      if (typeof delta.insert !== 'string') {
        const embed = delta.insert as unknown;
        if (
          embed === null ||
          typeof embed !== 'object' ||
          Object.keys(embed).length !== 1 ||
          !('grainBoundary' in embed) ||
          typeof (embed as BoundaryEmbed).grainBoundary !== 'string'
        )
          errors.push(`tape ${tapeId} contains an illegal embed`);
      }
      if (delta.attributes && Object.keys(delta.attributes).length) {
        errors.push(`tape ${tapeId} contains formatting attributes`);
      }
    }
  }
  for (const tapeId of tapes.keys()) {
    if (!revisions.has(tapeId)) errors.push(`tape ${tapeId} has no revision entry`);
  }
  for (const tapeId of revisions.keys()) {
    if (!tapes.has(tapeId)) errors.push(`revision entry refers to missing tape ${tapeId}`);
  }

  for (const [id, record] of nodes.entries()) {
    const isActive = active.has(id);
    let kind: NodeKind;
    let spans: readonly Span[];
    try {
      kind = nodeKind(record);
      spans = readSpans(record);
    } catch {
      continue;
    }
    if (isActive && INLINE_KINDS.has(kind) && spans.length === 0) {
      errors.push(`visible inline node ${id} has no insertion span`);
    }
    for (const span of spans) {
      if (
        !span ||
        typeof span.tapeId !== 'string' ||
        typeof span.startBoundaryId !== 'string' ||
        typeof span.endBoundaryId !== 'string'
      ) {
        errors.push(`node ${id} has a malformed span`);
        continue;
      }
      const tape = tapes.get(span.tapeId);
      const index = indexedTapes.get(span.tapeId);
      if (!tape || !index) {
        errors.push(`node ${id} refers to missing tape ${span.tapeId}`);
        continue;
      }
      if (span.startBoundaryId === span.endBoundaryId) {
        errors.push(`node ${id} span uses one boundary as both endpoints`);
        continue;
      }
      const start = index.boundaries.get(span.startBoundaryId);
      const end = index.boundaries.get(span.endBoundaryId);
      if (start === undefined || end === undefined) {
        errors.push(`node ${id} span boundary is not on tape ${span.tapeId}`);
        continue;
      }
      if (
        allBoundaryIds.get(span.startBoundaryId) !== span.tapeId ||
        allBoundaryIds.get(span.endBoundaryId) !== span.tapeId
      ) {
        errors.push(`node ${id} span boundary belongs to another tape`);
        continue;
      }
      if (start >= end) {
        errors.push(`node ${id} span boundaries are not in increasing order`);
        continue;
      }
      if (isActive) {
        const intervals = activeIntervals.get(span.tapeId) ?? [];
        intervals.push({ start, end, nodeId: id });
        activeIntervals.set(span.tapeId, intervals);
      }
    }
  }

  for (const [tapeId, intervals] of activeIntervals) {
    intervals.sort((left, right) => left.start - right.start || left.end - right.end);
    let furthestEnd = -1;
    for (const interval of intervals) {
      if (interval.start < furthestEnd) {
        errors.push(`node ${interval.nodeId} has overlapping active ownership on tape ${tapeId}`);
      }
      furthestEnd = Math.max(furthestEnd, interval.end);
    }
  }

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

/** Validate a disposable candidate directly from its schema-2 Yjs state. */
export function validateCanonicalState(state: Y.Doc): ValidationResult {
  const forest = validateRetainedForestState(state);
  const spans = validateActiveSpansState(state);
  const errors = [...forest.errors, ...spans.errors];
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
