import * as Y from 'yjs';

import type { NodeId } from '../semantic/types.js';

export const META = 'meta';
export const NODES = 'nodes';
export const TAPES = 'tapes';
export const TAPE_REVISIONS = 'tapeRevisions';
export const SESSION_WATERMARKS = 'sessionWatermarks';
export const NODE_FIELDS = ['kind', 'spans', 'marker', 'checked', 'info'] as const;

export type NodeDataField = (typeof NODE_FIELDS)[number];
export type CanonicalRecord = Y.Map<unknown>;
export type CanonicalNodeMap = Y.Map<CanonicalRecord>;

export interface SchemaCell<T> {
  readonly token: string;
  readonly value: T;
}

export function schemaMap<T>(document: Y.Doc, name: string): Y.Map<T> {
  return document.getMap<T>(name);
}

export function readNodeCell<T>(record: CanonicalRecord, field: NodeDataField): SchemaCell<T> {
  const value = record.get(field);
  assert(value !== null && typeof value === 'object', `node field ${field} is not a cell`);
  const cell = value as SchemaCell<T>;
  assert(
    typeof cell.token === 'string' && cell.token.length > 0,
    `node field ${field} has an invalid token`,
  );
  assert(Object.hasOwn(cell, 'value'), `node field ${field} has no value`);
  return cell;
}

export function readChildren(record: CanonicalRecord): readonly NodeId[] {
  const shared = record.get('children');
  const value =
    shared instanceof Y.Array
      ? shared.toArray()
      : (shared as SchemaCell<unknown> | undefined)?.value;
  assert(
    Array.isArray(value) && value.every((id) => typeof id === 'string'),
    'children array must contain node IDs',
  );
  return value as readonly NodeId[];
}

export function readChildrenToken(record: CanonicalRecord): string {
  const children = record.get('children');
  if (children instanceof Y.Array) {
    const token = record.get('childrenToken');
    assert(typeof token === 'string' && token.length > 0, 'children token is invalid');
    return token;
  }
  const legacy = children as SchemaCell<unknown> | undefined;
  assert(
    legacy !== null && typeof legacy === 'object' && typeof legacy.token === 'string',
    'children cell is missing',
  );
  return legacy.token;
}

export function readSchemaCell<T>(
  record: CanonicalRecord,
  field: NodeDataField | 'children',
): SchemaCell<T> {
  if (field !== 'children') return readNodeCell<T>(record, field);
  const children = record.get('children');
  if (children instanceof Y.Array) {
    return Object.freeze({
      token: readChildrenToken(record),
      value: readChildren(record),
    }) as SchemaCell<T>;
  }
  const cell = children as SchemaCell<T> | undefined;
  assert(cell !== null && typeof cell === 'object', 'node cell children is missing');
  assert(
    typeof cell.token === 'string' && Object.hasOwn(cell, 'value'),
    'node cell children is invalid',
  );
  return cell;
}

export function readSchemaField<T>(record: CanonicalRecord, field: NodeDataField | 'children'): T {
  return readSchemaCell<T>(record, field).value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
