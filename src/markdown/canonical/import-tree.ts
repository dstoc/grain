import * as Y from 'yjs';

import {
  CONTAINER_KINDS,
  INLINE_KINDS,
  META,
  NODES,
  NODE_KINDS,
  SCHEMA_VERSION,
  TAPES,
  TAPE_REVISIONS,
  isAllowedChild,
  schemaMap,
} from './schema.js';
import { validateCanonicalState } from './validation.js';
import type { CanonicalDocumentOptions } from './document-types.js';
import type { NodeId, NodeKind } from '../semantic/types.js';
import type { Cell, ResourceToken, Span } from './types.js';

const NORMALIZATION_VERSION = 1;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type RecordMap = Y.Map<unknown>;

export interface MutableSemanticNode {
  type: NodeKind;
  children?: MutableSemanticNode[];
  content?: string;
  marker?: string;
  checked?: boolean;
  info?: string | null;
}

interface AllocatedNode {
  readonly id: NodeId;
  readonly semantic: MutableSemanticNode;
  readonly record: RecordMap;
  readonly children: NodeId[];
  readonly spans: Span[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function randomId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    ) as T;
  }
  return value;
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJson(item as JsonValue);
    Object.freeze(value);
  }
  return value;
}

function cell<T extends JsonValue>(token: ResourceToken, value: T): Cell<T> {
  return Object.freeze({ token, value: freezeJson(cloneJson(value)) });
}

function ymap<T>(document: Y.Doc, name: string): Y.Map<T> {
  return schemaMap<T>(document, name);
}

function makeIdAllocator(options: CanonicalDocumentOptions, documentId: string) {
  const actionId = options.actionId ?? randomId();
  let ordinal = 0;
  const used = new Set<string>([documentId]);
  return (role: string) => {
    const next = ordinal++;
    const id = options.makeId?.(role, next) ?? `${role}:${actionId}:${next}`;
    assert(id.length > 0, `generated ${role} ID is empty`);
    assert(!used.has(id), `generated duplicate document ID ${id}`);
    used.add(id);
    return id;
  };
}

function orderedChildren(node: MutableSemanticNode): MutableSemanticNode[] {
  return node.children ?? [];
}

export function cloneSemanticTree(input: unknown): MutableSemanticNode {
  const active = new Set<object>();
  const seen = new Set<object>();

  function clone(value: unknown, path: string): MutableSemanticNode {
    assert(value !== null && typeof value === 'object', `${path} must be a node object`);
    const source = value as Record<string, unknown>;
    assert(!active.has(source), `${path} contains a cycle`);
    assert(!seen.has(source), `${path} reuses a node object`);
    active.add(source);
    seen.add(source);
    assert(
      typeof source.type === 'string' && NODE_KINDS.has(source.type as NodeKind),
      `${path} has an illegal kind`,
    );
    const type = source.type as NodeKind;
    const result: MutableSemanticNode = { type };

    if (INLINE_KINDS.has(type)) {
      assert(typeof source.content === 'string', `${path}.content must be a string`);
      assert(isWellFormed(source.content), `${path}.content contains an unpaired surrogate`);
      result.content = source.content;
    }
    if (type === 'section' || type === 'list-item' || type === 'block-quote') {
      assert(
        source.marker === undefined || typeof source.marker === 'string',
        `${path}.marker must be a string`,
      );
      result.marker = typeof source.marker === 'string' ? source.marker : '';
    }
    if (type === 'list-item') {
      assert(
        source.checked === undefined ||
          source.checked === null ||
          typeof source.checked === 'boolean',
        `${path}.checked must be a boolean or null`,
      );
      if (source.checked !== undefined && source.checked !== null) result.checked = source.checked;
    }
    if (type === 'code-block') {
      assert(
        source.info === undefined || source.info === null || typeof source.info === 'string',
        `${path}.info must be a string or null`,
      );
      result.info = source.info === undefined ? null : source.info;
    }

    if (CONTAINER_KINDS.has(type) || type === 'list') {
      assert(
        source.children === undefined || Array.isArray(source.children),
        `${path}.children must be an array`,
      );
      result.children =
        (source.children as unknown[] | undefined)?.map((child, index) =>
          clone(child, `${path}.children[${index}]`),
        ) ?? [];
      for (const [index, child] of result.children.entries()) {
        assert(
          isAllowedChild(type, child.type),
          `${path}.children[${index}] has illegal parent/child kinds`,
        );
      }
    } else {
      assert(
        source.children === undefined ||
          (Array.isArray(source.children) && source.children.length === 0),
        `${path} cannot contain child blocks`,
      );
    }

    active.delete(source);
    return result;
  }

  const root = clone(input, 'root');
  assert(root.type === 'document', 'root must have document kind');
  return root;
}

function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Allocate canonical schema-2 cells, tapes, sentinels, and imported text. */
export function importCanonicalTree(
  tree: MutableSemanticNode,
  options: CanonicalDocumentOptions = {},
): Y.Doc {
  const documentId = options.documentId ?? randomId();
  const normalizationVersion = options.normalizationVersion ?? NORMALIZATION_VERSION;
  assert(documentId.length > 0, 'document ID cannot be empty');
  assert(
    normalizationVersion === NORMALIZATION_VERSION,
    `unsupported normalization version ${normalizationVersion}`,
  );
  const allocateId = makeIdAllocator(options, documentId);
  const rootId = allocateId('node');
  const ydoc = new Y.Doc({ gc: false });
  const meta = ymap<unknown>(ydoc, META);
  const nodes = ymap<RecordMap>(ydoc, NODES);
  const tapes = ymap<Y.Text>(ydoc, TAPES);
  const tapeRevisions = ymap<number>(ydoc, TAPE_REVISIONS);
  const allocated = new Map<MutableSemanticNode, AllocatedNode>();
  const allIds = new Set<NodeId>();

  function allocateNode(semantic: MutableSemanticNode, isRoot = false): AllocatedNode {
    const id = isRoot ? rootId : allocateId('node');
    assert(!allIds.has(id), `duplicate node ID ${id}`);
    allIds.add(id);
    const record = new Y.Map<unknown>() as RecordMap;
    const result: AllocatedNode = { id, semantic, record, children: [], spans: [] };
    allocated.set(semantic, result);
    for (const child of orderedChildren(semantic)) {
      result.children.push(allocateNode(child).id);
    }
    if (INLINE_KINDS.has(semantic.type)) {
      const tapeId = allocateId('tape');
      const startBoundaryId = allocateId('boundary');
      const endBoundaryId = allocateId('boundary');
      const tape = new Y.Text();
      tapes.set(tapeId, tape);
      tape.insertEmbed(0, freezeJson({ grainBoundary: startBoundaryId }));
      tape.insertEmbed(1, freezeJson({ grainBoundary: endBoundaryId }));
      tapeRevisions.set(tapeId, 0);
      result.spans.push({ tapeId, startBoundaryId, endBoundaryId });
    }
    nodes.set(id, record);
    const getToken = () => allocateId('cell');
    record.set('kind', cell(getToken(), semantic.type));
    // All new records start detached. The later activation transaction
    // installs the complete imported hierarchy after every record exists.
    record.set('children', new Y.Array<NodeId>());
    record.set('childrenToken', getToken());
    record.set('spans', cell(getToken(), result.spans as unknown as JsonValue));
    record.set('marker', cell(getToken(), semantic.marker ?? null));
    record.set('checked', cell(getToken(), semantic.checked ?? null));
    record.set(
      'info',
      cell(getToken(), semantic.type === 'code-block' ? (semantic.info ?? null) : null),
    );
    return result;
  }

  ydoc.transact(() => {
    meta.set('schemaVersion', SCHEMA_VERSION);
    meta.set('documentId', documentId);
    meta.set('rootId', rootId);
    meta.set('normalizationVersion', normalizationVersion);
    meta.set('authorityEpoch', options.authorityEpoch ?? randomId());
    meta.set('acceptedRevision', 0);
    allocateNode(tree, true);
  }, 'grain:allocate');

  // Imported content is part of baseline revision 0, not a later accepted edit.
  // New strings are inserted only after empty tapes and permanent sentinels exist.
  ydoc.transact(() => {
    for (const { semantic, spans } of allocated.values()) {
      if (!INLINE_KINDS.has(semantic.type)) continue;
      const content = semantic.content ?? '';
      if (!content) continue;
      const span = spans[0];
      assert(span, 'inline node has no initial span');
      const tape = tapes.get(span.tapeId);
      assert(tape, 'allocated tape is missing');
      tape.insert(1, content);
    }
  }, 'grain:import-text');

  ydoc.transact(() => {
    for (const { record, children } of allocated.values()) {
      const array = record.get('children');
      assert(array instanceof Y.Array, 'allocated children array is missing');
      if (children.length) array.insert(0, children);
      record.set('childrenToken', allocateId('cell'));
    }
  }, 'grain:activate-import');

  const validation = validateCanonicalState(ydoc);
  assert(validation.valid, `import failed validation: ${validation.errors.join('; ')}`);
  return ydoc;
}
