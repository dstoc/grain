import * as Y from 'yjs';

import { deepCopy, deepFreeze } from './util.js';
import type { CanonicalIndexes } from './indexes.js';
import type { ResourceToken, Span } from './types.js';
import {
  META,
  NODES,
  SESSION_WATERMARKS,
  TAPES,
  TAPE_REVISIONS,
  readSchemaCell,
  schemaMap,
} from './schema.js';
import type { NodeId } from '../semantic/types.js';
import { spanTextFromIndex } from '../canonical-text.js';
import type { CellField } from './action-types.js';
import { textBetweenBoundaries } from './span-text.js';

export type RecordMap = Y.Map<unknown>;
export type CellValue<T> = { readonly token: ResourceToken; readonly value: T };

export function immutableCell<T>(token: string, value: T): CellValue<T> {
  return Object.freeze({ token, value: deepFreeze(deepCopy(value)) });
}

export function readCell<T>(record: RecordMap, field: CellField): CellValue<T> {
  const cell = readSchemaCell<T>(record, field);
  return immutableCell(cell.token, cell.value);
}

export function nodeMap(state: Y.Doc): Y.Map<RecordMap> {
  return schemaMap<RecordMap>(state, NODES);
}

export function tapeMap(state: Y.Doc): Y.Map<Y.Text> {
  return schemaMap<Y.Text>(state, TAPES);
}

export function revisionMap(state: Y.Doc): Y.Map<number> {
  return schemaMap<number>(state, TAPE_REVISIONS);
}

export function metaMap(state: Y.Doc): Y.Map<unknown> {
  return schemaMap<unknown>(state, META);
}

export function sessionWatermarkMap(state: Y.Doc): Y.Map<number> {
  return schemaMap<number>(state, SESSION_WATERMARKS);
}

export function nodeCell(state: Y.Doc, id: NodeId, field: CellField): CellValue<unknown> {
  const record = nodeMap(state).get(id);
  if (!record) throw new Error(`unknown node ${id}`);
  return readCell(record, field);
}

export function currentActive(state: Y.Doc, id: NodeId): boolean {
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

export function spanText(state: Y.Doc, span: Span, indexes?: CanonicalIndexes): string {
  if (indexes) return spanTextFromIndex(span, indexes.tape(span.tapeId));
  const tape = tapeMap(state).get(span.tapeId);
  if (!tape) throw new Error(`missing tape ${span.tapeId}`);
  return textBetweenBoundaries(tape, span);
}
