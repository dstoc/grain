import * as Y from 'yjs';

import {
  META,
  NODES,
  NODE_FIELDS,
  TAPES,
  TAPE_REVISIONS,
  readChildren,
  readChildrenToken,
  readNodeCell,
  readSchemaField,
  schemaMap,
} from './schema.js';
import type { NodeId, NodeKind } from '../semantic/types.js';
export type { NodeId, NodeKind } from '../semantic/types.js';
import type { DocumentNode, MarkdownNode } from '../node.js';
import type { Caches } from '../view-model-node.js';
import { MarkdownTree } from '../view-model.js';
import { parseBlocks } from '../block-parser/api.js';
import { batch } from '../../signals.js';
import { CanonicalNode } from './node-projection.js';
import type { CanonicalNodeProjectionOwner } from './node-projection.js';

export { CanonicalNode } from './node-projection.js';

export type TapeId = string;
export type BoundaryId = string;
export type ResourceToken = string;

export interface Cell<T> {
  readonly token: ResourceToken;
  readonly value: T;
}

export interface Span {
  readonly tapeId: TapeId;
  readonly startBoundaryId: BoundaryId;
  readonly endBoundaryId: BoundaryId;
}

export interface BoundaryEmbed {
  readonly grainBoundary: BoundaryId;
}

export interface CanonicalNodeFields {
  readonly kind: Cell<NodeKind>;
  readonly children: Y.Array<NodeId>;
  readonly childrenToken: ResourceToken;
  readonly spans: Cell<readonly Span[]>;
  readonly marker: Cell<string | null>;
  readonly checked: Cell<boolean | null>;
  readonly info: Cell<string | null>;
}

export interface CanonicalCheckpoint {
  readonly documentId: string;
  readonly schemaVersion: number;
  readonly normalizationVersion: number;
  readonly authorityEpoch: string;
  readonly acceptedRevision: number;
  readonly update: Uint8Array;
}

export interface CanonicalDocumentOptions {
  readonly documentId?: string;
  readonly authorityEpoch?: string;
  readonly normalizationVersion?: number;
  readonly actionId?: string;
  readonly makeId?: (role: string, ordinal: number) => string;
}

export interface CanonicalOpenOptions {
  readonly normalizationVersion?: number;
}

export interface AcceptedUpdate {
  readonly revision: number;
  readonly update: Uint8Array;
}

export interface CanonicalMaintenanceReset {
  readonly oldSchemaVersion: number;
  readonly schemaVersion: number;
  readonly oldAuthorityEpoch: string;
  readonly authorityEpoch: string;
  readonly documentId: string;
  readonly rootId: NodeId;
  readonly preservedNodeIds: readonly NodeId[];
  readonly invalidated: readonly [
    'nativeIdentities',
    'history',
    'pendingActions',
    'sessionWatermarks',
    'receipts',
    'selectionAnchors',
  ];
}

export interface CanonicalMaintenanceResult {
  readonly checkpoint: CanonicalCheckpoint;
  readonly reset: CanonicalMaintenanceReset;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const SCHEMA_VERSION = 2;
const NORMALIZATION_VERSION = 1;
const NODE_KINDS = new Set<NodeKind>([
  'document',
  'paragraph',
  'section',
  'code-block',
  'list',
  'list-item',
  'block-quote',
]);
const INLINE_KINDS = new Set<NodeKind>(['paragraph', 'section', 'code-block']);
const CONTAINER_KINDS = new Set<NodeKind>(['document', 'section', 'list-item', 'block-quote']);
const BLOCK_KINDS = new Set<NodeKind>([
  'paragraph',
  'section',
  'code-block',
  'list',
  'block-quote',
]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type RecordMap = Y.Map<unknown>;
type NodeMap = Y.Map<RecordMap>;

interface YjsItemLike {
  readonly id: { readonly client: number; readonly clock: number };
  readonly right: YjsItemLike | null;
  readonly length: number;
  readonly deleted: boolean;
  readonly content: unknown;
}

interface YjsSharedTypeInternals {
  readonly _item: YjsItemLike | null;
  readonly _start: YjsItemLike | null;
}

const backingDocuments = new WeakMap<CanonicalDocument, Y.Doc>();
const closedDocuments = new WeakSet<CanonicalDocument>();
const writerAccesses = new WeakMap<CanonicalDocument, CanonicalWriterAccess>();

/** @internal Access for the synchronous canonical action coordinator only. */
export interface CanonicalWriterAccess {
  readonly state: Y.Doc;
  historyWasReset(): boolean;
  beginPending(): void;
  publish(affectedNodeIds: readonly NodeId[]): readonly unknown[];
  observeAcceptedUpdates(
    listener: (
      update: Uint8Array,
      changedTapeIds: readonly TapeId[],
      structuralEffect: boolean,
    ) => void,
  ): () => void;
  poison(): void;
}

interface MutableSemanticNode {
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

interface TapePositions {
  readonly deltas: readonly DeltaLike[];
  readonly boundaries: ReadonlyMap<BoundaryId, number>;
  readonly boundaryOrder: readonly { id: BoundaryId; index: number }[];
  readonly duplicateBoundaries: ReadonlySet<BoundaryId>;
  readonly length: number;
}

interface DeltaLike {
  readonly insert: unknown;
  readonly attributes?: Record<string, unknown>;
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

function cellValue<T>(record: RecordMap, field: (typeof NODE_FIELDS)[number]): Cell<T> {
  return readNodeCell<T>(record, field) as Cell<T>;
}

function childrenToken(record: RecordMap): ResourceToken {
  return readChildrenToken(record);
}

function ymap<T>(document: Y.Doc, name: string): Y.Map<T> {
  return schemaMap<T>(document, name);
}

function yjsItemId(item: YjsItemLike): string {
  return `${item.id.client}:${item.id.clock}`;
}

function sharedTypeId(type: { readonly _item: YjsItemLike | null }): string {
  const item = (type as unknown as YjsSharedTypeInternals)._item;
  assert(item, 'canonical shared type is not integrated');
  return yjsItemId(item);
}

function retainedMarkers(
  tape: Y.Text,
): readonly { readonly itemId: string; readonly boundaryId: string }[] {
  const markers: { itemId: string; boundaryId: string }[] = [];
  let item = (tape as unknown as YjsSharedTypeInternals)._start;
  while (item) {
    const content = item.content;
    const embed =
      content !== null && typeof content === 'object' && 'embed' in content
        ? (content as { readonly embed: unknown }).embed
        : undefined;
    if (
      !item.deleted &&
      embed !== null &&
      typeof embed === 'object' &&
      'grainBoundary' in embed &&
      typeof (embed as BoundaryEmbed).grainBoundary === 'string'
    ) {
      markers.push({ itemId: yjsItemId(item), boundaryId: (embed as BoundaryEmbed).grainBoundary });
    }
    item = item.right;
  }
  return markers;
}

export function tapeItemSignature(tape: Y.Text): string {
  const items: [string, number, boolean][] = [];
  let item = (tape as unknown as YjsSharedTypeInternals)._start;
  while (item) {
    items.push([yjsItemId(item), item.length, item.deleted]);
    item = item.right;
  }
  return JSON.stringify(items);
}

/** @internal Verify that accepted writes retain every integrated permanent Yjs type. */
export function assertRetainedResources(previous: Y.Doc, candidate: Y.Doc): void {
  const previousMeta = ymap<unknown>(previous, META);
  const candidateMeta = ymap<unknown>(candidate, META);
  const rootId = metaValue<string>(previousMeta, 'rootId');
  assert(
    metaValue<string>(candidateMeta, 'rootId') === rootId,
    'accepted update changed the fixed root ID',
  );

  const previousNodes = ymap<RecordMap>(previous, NODES);
  const candidateNodes = ymap<RecordMap>(candidate, NODES);
  for (const [id, record] of previousNodes.entries()) {
    const next = candidateNodes.get(id);
    assert(next instanceof Y.Map, `accepted update removed permanent node ${id}`);
    assert(
      sharedTypeId(next) === sharedTypeId(record),
      `accepted update replaced the native record for node ${id}`,
    );
    const previousChildren = record.get('children');
    const candidateChildren = next.get('children');
    if (previousChildren instanceof Y.Array) {
      assert(candidateChildren instanceof Y.Array, `accepted update replaced children array ${id}`);
      assert(
        sharedTypeId(candidateChildren) === sharedTypeId(previousChildren),
        `accepted update replaced the native children array for node ${id}`,
      );
    }
  }

  const previousTapes = ymap<Y.Text>(previous, TAPES);
  const candidateTapes = ymap<Y.Text>(candidate, TAPES);
  for (const [id, tape] of previousTapes.entries()) {
    const next = candidateTapes.get(id);
    assert(next instanceof Y.Text, `accepted update removed permanent tape ${id}`);
    assert(
      sharedTypeId(next) === sharedTypeId(tape),
      `accepted update replaced the native tape for ${id}`,
    );

    const nextMarkers = retainedMarkers(next);
    let markerIndex = 0;
    for (const marker of retainedMarkers(tape)) {
      const nextIndex = nextMarkers.findIndex(
        (candidateMarker, index) =>
          index >= markerIndex &&
          candidateMarker.itemId === marker.itemId &&
          candidateMarker.boundaryId === marker.boundaryId,
      );
      assert(
        nextIndex >= markerIndex,
        `accepted update deleted, replaced, or reordered retained boundary ${marker.boundaryId}`,
      );
      markerIndex = nextIndex + 1;
    }
  }

  const previousRevisions = ymap<number>(previous, TAPE_REVISIONS);
  const candidateRevisions = ymap<number>(candidate, TAPE_REVISIONS);
  for (const tapeId of previousRevisions.keys()) {
    assert(
      candidateRevisions.has(tapeId),
      `accepted update removed permanent tape revision ${tapeId}`,
    );
  }
}

export function assertTapeRevisions(previous: Y.Doc, candidate: Y.Doc, revision: number): void {
  const previousTapes = ymap<Y.Text>(previous, TAPES);
  const candidateTapes = ymap<Y.Text>(candidate, TAPES);
  const previousRevisions = ymap<number>(previous, TAPE_REVISIONS);
  const candidateRevisions = ymap<number>(candidate, TAPE_REVISIONS);

  for (const [tapeId, tape] of candidateTapes.entries()) {
    const currentRevision = candidateRevisions.get(tapeId);
    assert(
      Number.isSafeInteger(currentRevision) && currentRevision! >= 0,
      `tape ${tapeId} has an invalid revision`,
    );
    const previousTape = previousTapes.get(tapeId);
    const changed =
      previousTape === undefined || tapeItemSignature(previousTape) !== tapeItemSignature(tape);
    if (changed) {
      assert(
        currentRevision === revision,
        `tape ${tapeId} changed without recording accepted revision ${revision}`,
      );
    } else {
      assert(
        currentRevision === previousRevisions.get(tapeId),
        `tape ${tapeId} revision changed without modifying the tape`,
      );
    }
    assert(currentRevision! <= revision, `tape ${tapeId} revision is ahead of accepted state`);
  }
}

function assertSessionWatermarkProgress(previous: Y.Doc, candidate: Y.Doc): void {
  const before = ymap<number>(previous, 'sessionWatermarks');
  const after = ymap<number>(candidate, 'sessionWatermarks');
  const changed: string[] = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const oldValue = before.get(key) ?? 0;
    const newValue = after.get(key) ?? 0;
    assert(
      Number.isSafeInteger(oldValue) &&
        oldValue >= 0 &&
        Number.isSafeInteger(newValue) &&
        newValue >= 0,
      `session watermark ${key} is invalid`,
    );
    assert(newValue >= oldValue, `session watermark ${key} moved backwards`);
    if (newValue !== oldValue) {
      assert(newValue === oldValue + 1, `session watermark ${key} skipped a sequence`);
      changed.push(key);
    }
  }
  assert(changed.length <= 1, 'accepted update advanced multiple session watermarks');
}

function semanticChildren(node: MutableSemanticNode): MutableSemanticNode[] {
  return node.children ?? [];
}

function cloneSemanticTree(input: unknown): MutableSemanticNode {
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

function isAllowedChild(parent: NodeKind, child: NodeKind): boolean {
  if (parent === 'list') return child === 'list-item';
  if (CONTAINER_KINDS.has(parent)) return BLOCK_KINDS.has(child);
  return false;
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

function nodeCell<T = unknown>(
  record: RecordMap,
  field: (typeof NODE_FIELDS)[number] | 'children',
): T {
  return readSchemaField<T>(record, field);
}

function addChildIds(target: Set<NodeId>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const id of value) if (typeof id === 'string') target.add(id);
  }
}

function changedProjectionResources(before: Y.Doc, after: Y.Doc) {
  const affectedNodeIds = new Set<NodeId>();
  const touchedTapeIds = new Set<TapeId>();
  let structuralEffect = false;
  const beforeNodes = ymap<RecordMap>(before, NODES);
  const afterNodes = ymap<RecordMap>(after, NODES);
  for (const id of new Set([...beforeNodes.keys(), ...afterNodes.keys()])) {
    const oldRecord = beforeNodes.get(id);
    const newRecord = afterNodes.get(id);
    if (!oldRecord || !newRecord) {
      structuralEffect = true;
      affectedNodeIds.add(id);
      addChildIds(affectedNodeIds, oldRecord && readChildren(oldRecord));
      addChildIds(affectedNodeIds, newRecord && readChildren(newRecord));
      continue;
    }
    for (const field of NODE_FIELDS) {
      const oldCell = cellValue(oldRecord, field);
      const newCell = cellValue(newRecord, field);
      if (oldCell.token === newCell.token) continue;
      structuralEffect = true;
      affectedNodeIds.add(id);
    }
    const oldChildren = readChildren(oldRecord);
    const newChildren = readChildren(newRecord);
    if (
      childrenToken(oldRecord) !== childrenToken(newRecord) ||
      JSON.stringify(oldChildren) !== JSON.stringify(newChildren)
    ) {
      structuralEffect = true;
      affectedNodeIds.add(id);
      addChildIds(affectedNodeIds, oldChildren);
      addChildIds(affectedNodeIds, newChildren);
    }
  }

  const beforeRevisions = ymap<number>(before, TAPE_REVISIONS);
  const afterRevisions = ymap<number>(after, TAPE_REVISIONS);
  for (const id of new Set([...beforeRevisions.keys(), ...afterRevisions.keys()])) {
    if (beforeRevisions.get(id) !== afterRevisions.get(id)) touchedTapeIds.add(id);
  }
  const beforeTapes = ymap<Y.Text>(before, TAPES);
  const afterTapes = ymap<Y.Text>(after, TAPES);
  for (const id of new Set([...beforeTapes.keys(), ...afterTapes.keys()])) {
    if (beforeTapes.has(id) === afterTapes.has(id)) continue;
    touchedTapeIds.add(id);
    structuralEffect = true;
  }
  if (touchedTapeIds.size) {
    const rootId = metaValue<string>(ymap<unknown>(after, META), 'rootId');
    const pending = [rootId];
    const visited = new Set<NodeId>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const record = afterNodes.get(id);
      if (!record) continue;
      if (
        INLINE_KINDS.has(nodeKind(record)) &&
        readSpans(record).some((span) => touchedTapeIds.has(span.tapeId))
      ) {
        affectedNodeIds.add(id);
      }
      pending.push(...readChildren(record));
    }
  }
  return {
    affectedNodeIds: [...affectedNodeIds],
    touchedTapeIds: [...touchedTapeIds],
    structuralEffect,
  };
}

function readSpans(record: RecordMap): readonly Span[] {
  const value = nodeCell(record, 'spans');
  assert(Array.isArray(value), 'spans cell must contain an array');
  return value as readonly Span[];
}

function nodeKind(record: RecordMap): NodeKind {
  const kind = nodeCell(record, 'kind');
  assert(typeof kind === 'string' && NODE_KINDS.has(kind as NodeKind), 'node kind is illegal');
  return kind as NodeKind;
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

function spanText(tape: Y.Text, span: Span): string {
  let within = false;
  let output = '';
  for (const delta of tape.toDelta()) {
    const insert = delta.insert;
    if (typeof insert === 'string') {
      if (within) output += insert;
      continue;
    }
    const boundary =
      insert !== null && typeof insert === 'object' && 'grainBoundary' in insert
        ? (insert as BoundaryEmbed).grainBoundary
        : undefined;
    if (boundary === span.startBoundaryId) {
      within = true;
    } else if (boundary === span.endBoundaryId) {
      break;
    }
  }
  return output;
}

function metaValue<T>(meta: Y.Map<unknown>, key: string): T {
  return meta.get(key) as T;
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
  return semanticChildren(node);
}

/**
 * Native Yjs canonical storage and its stable read-only semantic projection.
 * The Y.Doc and its shared types are deliberately not exposed.
 */
export class CanonicalDocument implements CanonicalNodeProjectionOwner {
  private readonly facades = new Map<NodeId, CanonicalNode>();
  private readonly localCaches = new Map<NodeId, Caches>();
  private readonly nodeVersions = new Map<NodeId, number>();
  private readonly projectionListeners = new Set<(version: number) => void>();
  private disposed = false;
  private publicationPending = false;
  private revisionVersion = 0;
  private acceptedUpdateObserver?: (
    update: Uint8Array,
    changedTapeIds: readonly TapeId[],
    structuralEffect: boolean,
  ) => void;

  private constructor(
    private readonly document: Y.Doc,
    private readonly historyWasReset = false,
  ) {
    backingDocuments.set(this, document);
    writerAccesses.set(this, {
      state: document,
      historyWasReset: () => this.historyWasReset,
      beginPending: () => {
        this.assertLive();
        assert(!this.publicationPending, 'canonical document already has a pending commit');
        this.publicationPending = true;
      },
      publish: (affectedNodeIds) => {
        assert(this.publicationPending, 'canonical document has no pending commit');
        this.publicationPending = false;
        return this.advanceProjection(affectedNodeIds);
      },
      observeAcceptedUpdates: (listener) => {
        assert(
          !this.acceptedUpdateObserver,
          'canonical document already has an accepted-update observer',
        );
        this.acceptedUpdateObserver = listener;
        return () => {
          if (this.acceptedUpdateObserver === listener) this.acceptedUpdateObserver = undefined;
        };
      },
      poison: () => {
        this.publicationPending = true;
      },
    });
  }

  static fromMarkdown(markdown: string, options: CanonicalDocumentOptions = {}): CanonicalDocument {
    const parsed = parseBlocks(markdown, { provenance: true });
    return CanonicalDocument.fromParsed(parsed.provenance.output, options);
  }

  /** Imports a parser result as-is. This path does not run normalization. */
  static fromParsed(tree: DocumentNode, options: CanonicalDocumentOptions = {}): CanonicalDocument {
    return CanonicalDocument.importTree(cloneSemanticTree(tree), options);
  }

  /** Imports a semantic tree after the existing one-pass construction normalization. */
  static fromTree(tree: DocumentNode, options: CanonicalDocumentOptions = {}): CanonicalDocument {
    const input = cloneSemanticTree(tree) as DocumentNode;
    const normalized = new MarkdownTree(input).serialize() as DocumentNode;
    return CanonicalDocument.importTree(cloneSemanticTree(normalized), options);
  }

  /** @internal Validate an already-disposable staging document. */
  static validateState(state: Y.Doc): ValidationResult {
    const document = new CanonicalDocument(state);
    try {
      return document.validate();
    } finally {
      closedDocuments.add(document);
    }
  }

  /** Reconstructs accepted Yjs state without normalization or user-history capture. */
  static open(
    checkpoint: CanonicalCheckpoint,
    options: CanonicalOpenOptions = {},
  ): CanonicalDocument {
    assert(
      checkpoint.schemaVersion === SCHEMA_VERSION,
      `unsupported schema version ${checkpoint.schemaVersion}`,
    );
    const expectedNormalization = options.normalizationVersion ?? NORMALIZATION_VERSION;
    assert(
      expectedNormalization === NORMALIZATION_VERSION,
      `unsupported normalization version ${expectedNormalization}`,
    );
    assert(
      checkpoint.normalizationVersion === expectedNormalization,
      `unsupported normalization version ${checkpoint.normalizationVersion}`,
    );
    const document = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(document, Uint8Array.from(checkpoint.update));
      assert(
        !document.store.pendingStructs && !document.store.pendingDs,
        'checkpoint has unresolved native dependencies',
      );
      const meta = ymap<unknown>(document, META);
      assert(
        metaValue<number>(meta, 'schemaVersion') === SCHEMA_VERSION,
        'checkpoint has an unsupported schema version',
      );
      assert(
        metaValue<number>(meta, 'normalizationVersion') === expectedNormalization,
        'checkpoint has an unsupported normalization version',
      );
      assert(
        metaValue<string>(meta, 'documentId') === checkpoint.documentId,
        'checkpoint document ID does not match its state',
      );
      assert(
        metaValue<string>(meta, 'authorityEpoch') === checkpoint.authorityEpoch,
        'checkpoint authority epoch does not match its state',
      );
      assert(
        metaValue<number>(meta, 'acceptedRevision') === checkpoint.acceptedRevision,
        'checkpoint revision does not match its state',
      );
      const result = new CanonicalDocument(document, true);
      const validation = result.validate();
      assert(validation.valid, `checkpoint failed validation: ${validation.errors.join('; ')}`);
      return result;
    } catch (error) {
      document.destroy();
      throw error;
    }
  }

  /** Rebuilds a validated schema-2 checkpoint under a new epoch. */
  static rebuild(
    checkpoint: CanonicalCheckpoint,
    authorityEpoch: string,
  ): CanonicalMaintenanceResult {
    return CanonicalDocument.rebuildAcceptedCheckpoint(checkpoint, SCHEMA_VERSION, authorityEpoch);
  }

  /** Explicitly migrates a complete schema-1 checkpoint to schema 2. */
  static migrateSchema1(
    checkpoint: CanonicalCheckpoint,
    authorityEpoch: string,
  ): CanonicalMaintenanceResult {
    return CanonicalDocument.rebuildAcceptedCheckpoint(checkpoint, 1, authorityEpoch);
  }

  private static rebuildAcceptedCheckpoint(
    checkpoint: CanonicalCheckpoint,
    expectedSchemaVersion: number,
    authorityEpoch: string,
  ): CanonicalMaintenanceResult {
    assert(
      typeof authorityEpoch === 'string' && authorityEpoch.length > 0,
      'authority epoch cannot be empty',
    );
    assert(
      authorityEpoch !== checkpoint.authorityEpoch,
      'maintenance authority epoch must differ from the checkpoint epoch',
    );
    const source = CanonicalDocument.openForMaintenance(checkpoint, expectedSchemaVersion);
    try {
      const rootId = metaValue<string>(ymap<unknown>(source.document, META), 'rootId');
      const preservedNodeIds: NodeId[] = [];
      const copyNode = (id: NodeId): MutableSemanticNode => {
        const node = source.node(id);
        const semantic: MutableSemanticNode = { type: node.type };
        preservedNodeIds.push(id);
        if (INLINE_KINDS.has(node.type)) semantic.content = node.content ?? '';
        if (node.type === 'section' || node.type === 'list-item' || node.type === 'block-quote') {
          semantic.marker = node.marker ?? '';
        }
        if (node.type === 'list-item' && node.checked !== undefined)
          semantic.checked = node.checked;
        if (node.type === 'code-block') semantic.info = node.info ?? null;
        if (CONTAINER_KINDS.has(node.type) || node.type === 'list') {
          semantic.children = node.children.map((child) => copyNode(child.sharedId));
        }
        return semantic;
      };
      const tree = copyNode(rootId);
      const reserved = new Set<string>([checkpoint.documentId, ...preservedNodeIds]);
      let nodeOrdinal = 0;
      let freshOrdinal = 0;
      const rebuilt = CanonicalDocument.importTree(tree, {
        documentId: checkpoint.documentId,
        authorityEpoch,
        normalizationVersion: checkpoint.normalizationVersion,
        actionId: `maintenance:${authorityEpoch}`,
        makeId(role) {
          if (role === 'node') {
            const id = preservedNodeIds[nodeOrdinal++];
            assert(id, 'maintenance rebuild allocated more nodes than it preserved');
            return id;
          }
          let id: string;
          do {
            id = `maintenance:${authorityEpoch}:${role}:${freshOrdinal++}`;
          } while (reserved.has(id));
          reserved.add(id);
          return id;
        },
      });
      try {
        assert(
          nodeOrdinal === preservedNodeIds.length,
          'maintenance rebuild omitted a preserved node',
        );
        const rebuiltCheckpoint = rebuilt.checkpoint();
        assert(
          rebuiltCheckpoint.schemaVersion === SCHEMA_VERSION,
          'maintenance rebuild emitted the wrong schema',
        );
        return Object.freeze({
          checkpoint: rebuiltCheckpoint,
          reset: Object.freeze({
            oldSchemaVersion: checkpoint.schemaVersion,
            schemaVersion: rebuiltCheckpoint.schemaVersion,
            oldAuthorityEpoch: checkpoint.authorityEpoch,
            authorityEpoch,
            documentId: checkpoint.documentId,
            rootId,
            preservedNodeIds: Object.freeze([...preservedNodeIds]),
            invalidated: Object.freeze([
              'nativeIdentities',
              'history',
              'pendingActions',
              'sessionWatermarks',
              'receipts',
              'selectionAnchors',
            ] as const),
          }),
        });
      } finally {
        rebuilt.close();
      }
    } finally {
      source.close();
    }
  }

  private static openForMaintenance(
    checkpoint: CanonicalCheckpoint,
    schemaVersion: number,
  ): CanonicalDocument {
    assert(
      checkpoint.schemaVersion === schemaVersion,
      `unsupported maintenance schema ${checkpoint.schemaVersion}`,
    );
    assert(
      checkpoint.normalizationVersion === NORMALIZATION_VERSION,
      'unsupported normalization version',
    );
    const document = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(document, Uint8Array.from(checkpoint.update));
      assert(
        !document.store.pendingStructs && !document.store.pendingDs,
        'checkpoint has unresolved native dependencies',
      );
      const meta = ymap<unknown>(document, META);
      assert(
        metaValue<number>(meta, 'schemaVersion') === schemaVersion,
        'checkpoint schema does not match its state',
      );
      assert(
        metaValue<number>(meta, 'normalizationVersion') === checkpoint.normalizationVersion,
        'checkpoint normalization does not match its state',
      );
      assert(
        metaValue<string>(meta, 'documentId') === checkpoint.documentId,
        'checkpoint document ID does not match its state',
      );
      assert(
        metaValue<string>(meta, 'authorityEpoch') === checkpoint.authorityEpoch,
        'checkpoint authority epoch does not match its state',
      );
      assert(
        metaValue<number>(meta, 'acceptedRevision') === checkpoint.acceptedRevision,
        'checkpoint revision does not match its state',
      );
      for (const record of ymap<RecordMap>(document, NODES).values()) {
        const children = record.get('children');
        assert(
          schemaVersion === SCHEMA_VERSION
            ? children instanceof Y.Array
            : !(children instanceof Y.Array),
          `checkpoint has children storage incompatible with schema ${schemaVersion}`,
        );
      }
      const result = new CanonicalDocument(document, true);
      const validation = result.validate();
      assert(validation.valid, `checkpoint failed validation: ${validation.errors.join('; ')}`);
      return result;
    } catch (error) {
      document.destroy();
      throw error;
    }
  }

  /**
   * Restores a durable checkpoint for a new authority epoch. Native history
   * and tape revision guards are epoch-local, so both start at revision zero.
   */
  static restore(checkpoint: CanonicalCheckpoint, authorityEpoch: string): CanonicalDocument {
    assert(authorityEpoch.length > 0, 'authority epoch cannot be empty');
    assert(
      authorityEpoch !== checkpoint.authorityEpoch,
      'restored authority epoch must differ from the checkpoint epoch',
    );
    const restored = CanonicalDocument.open(checkpoint);
    try {
      const meta = ymap<unknown>(restored.document, META);
      const revisions = ymap<number>(restored.document, TAPE_REVISIONS);
      const sessionWatermarks = ymap<number>(restored.document, 'sessionWatermarks');
      restored.document.transact(() => {
        meta.set('authorityEpoch', authorityEpoch);
        meta.set('acceptedRevision', 0);
        for (const tapeId of revisions.keys()) revisions.set(tapeId, 0);
        for (const sessionId of sessionWatermarks.keys()) sessionWatermarks.delete(sessionId);
      }, 'grain:epoch-restore');
      const validation = restored.validate();
      assert(
        validation.valid,
        `restored checkpoint failed validation: ${validation.errors.join('; ')}`,
      );
      return restored;
    } catch (error) {
      restored.close();
      throw error;
    }
  }

  private static importTree(
    tree: MutableSemanticNode,
    options: CanonicalDocumentOptions,
  ): CanonicalDocument {
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

    const result = new CanonicalDocument(ydoc);
    const validation = result.validate();
    assert(validation.valid, `import failed validation: ${validation.errors.join('; ')}`);
    return result;
  }

  get root(): CanonicalNode {
    this.assertLive();
    return this.node(metaValue(ymap<unknown>(this.document, META), 'rootId'));
  }

  get documentId(): string {
    this.assertLive();
    return metaValue(ymap<unknown>(this.document, META), 'documentId');
  }

  get acceptedRevision(): number {
    this.assertLive();
    return metaValue(ymap<unknown>(this.document, META), 'acceptedRevision');
  }

  get projectionVersion(): number {
    this.assertLive();
    return this.revisionVersion;
  }

  /** Subscribe to coherent local or accepted-remote projection changes. */
  subscribeProjection(listener: (version: number) => void): () => void {
    this.assertLive();
    this.projectionListeners.add(listener);
    return () => this.projectionListeners.delete(listener);
  }

  /** @internal Read-only scalar projection for CanonicalNode. */
  nodeKind(id: NodeId): NodeKind {
    this.assertLive();
    return nodeKind(this.requireRecord(id));
  }

  /** @internal Read-only structural projection for CanonicalNode. */
  childIds(id: NodeId): readonly NodeId[] {
    this.assertLive();
    return Object.freeze([...readChildren(this.requireRecord(id))]);
  }

  /** @internal Read-only scalar projection for CanonicalNode. */
  scalar(id: NodeId, field: 'marker' | 'checked' | 'info'): unknown {
    this.assertLive();
    return nodeCell(this.requireRecord(id), field);
  }

  /** @internal Read-only text projection for CanonicalNode. */
  nodeContent(id: NodeId): string {
    this.assertLive();
    const spans = readSpans(this.requireRecord(id));
    const tapes = ymap<Y.Text>(this.document, TAPES);
    return spans
      .map((span) => {
        const tape = tapes.get(span.tapeId);
        assert(tape, `node ${id} refers to missing tape ${span.tapeId}`);
        return spanText(tape, span);
      })
      .join('');
  }

  node(id: NodeId): CanonicalNode {
    this.assertLive();
    assert(ymap<RecordMap>(this.document, NODES).has(id), `unknown node ID ${id}`);
    let facade = this.facades.get(id);
    if (!facade) {
      facade = new CanonicalNode(id, this);
      this.facades.set(id, facade);
    }
    return facade;
  }

  /** A semantic DTO. Shared IDs, cells, spans, markers and Yjs objects are omitted. */
  exportMarkdownTree(): DocumentNode {
    this.assertLive();
    const build = (id: NodeId): MarkdownNode => {
      const record = this.requireRecord(id);
      const type = nodeKind(record);
      const children = readChildren(record).map(build);
      const content = INLINE_KINDS.has(type) ? (this.node(id).content ?? '') : undefined;
      const marker = nodeCell<string | null>(record, 'marker');
      const checked = nodeCell<boolean | null>(record, 'checked');
      const info = nodeCell<string | null>(record, 'info');
      switch (type) {
        case 'document':
          return { type, children };
        case 'paragraph':
          return { type, content: content ?? '' };
        case 'section':
          return { type, marker: marker ?? '', content: content ?? '', children };
        case 'code-block':
          return { type, info, content: content ?? '' };
        case 'list':
          return { type, children };
        case 'list-item':
          return { type, marker: marker ?? '', ...(checked === null ? {} : { checked }), children };
        case 'block-quote':
          return { type, marker: marker ?? '', children };
      }
    };
    return build(this.root.sharedId) as DocumentNode;
  }

  checkpoint(): CanonicalCheckpoint {
    this.assertLive();
    return Object.freeze({
      documentId: this.documentId,
      schemaVersion: metaValue<number>(ymap<unknown>(this.document, META), 'schemaVersion'),
      normalizationVersion: metaValue<number>(
        ymap<unknown>(this.document, META),
        'normalizationVersion',
      ),
      authorityEpoch: metaValue<string>(ymap<unknown>(this.document, META), 'authorityEpoch'),
      acceptedRevision: this.acceptedRevision,
      update: Uint8Array.from(Y.encodeStateAsUpdate(this.document)),
    });
  }

  /**
   * Applies the next authority-accepted update after validating it on a fresh
   * candidate replica. This path only materializes accepted shared state.
   */
  applyAccepted(envelope: AcceptedUpdate): readonly unknown[] {
    this.assertLive();
    assert(
      envelope.revision === this.acceptedRevision + 1,
      'accepted revisions must be contiguous',
    );
    const candidate = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
      Y.applyUpdate(candidate, Uint8Array.from(envelope.update));
      assert(
        !candidate.store.pendingStructs && !candidate.store.pendingDs,
        'accepted update has unresolved native dependencies',
      );
      const candidateMeta = ymap<unknown>(candidate, META);
      assert(
        metaValue(candidateMeta, 'documentId') === this.documentId,
        'accepted update belongs to another document',
      );
      assert(
        metaValue<string>(candidateMeta, 'authorityEpoch') ===
          metaValue<string>(ymap<unknown>(this.document, META), 'authorityEpoch'),
        'accepted update belongs to another authority epoch',
      );
      assert(
        metaValue<number>(candidateMeta, 'schemaVersion') === SCHEMA_VERSION,
        'accepted update has an unsupported schema version',
      );
      assert(
        metaValue<number>(candidateMeta, 'normalizationVersion') ===
          metaValue<number>(ymap<unknown>(this.document, META), 'normalizationVersion'),
        'accepted update has an unsupported normalization version',
      );
      assert(
        metaValue<number>(candidateMeta, 'acceptedRevision') === envelope.revision,
        'accepted update has the wrong revision',
      );
      assertRetainedResources(this.document, candidate);
      const staged = new CanonicalDocument(candidate);
      const validation = staged.validate();
      assert(
        validation.valid,
        `accepted update failed validation: ${validation.errors.join('; ')}`,
      );
      assertTapeRevisions(this.document, candidate, envelope.revision);
      assertSessionWatermarkProgress(this.document, candidate);
      const changed = changedProjectionResources(this.document, candidate);
      Y.applyUpdate(this.document, Uint8Array.from(envelope.update));
      try {
        this.acceptedUpdateObserver?.(
          Uint8Array.from(envelope.update),
          changed.touchedTapeIds,
          changed.structuralEffect,
        );
      } catch (error) {
        this.publicationPending = true;
        throw error;
      }
      return this.advanceProjection(changed.affectedNodeIds);
    } finally {
      candidate.destroy();
    }
  }

  /** Revision numbers are not part of the semantic Markdown export. */
  tapeRevision(tapeId: TapeId): number {
    this.assertLive();
    const revision = ymap<number>(this.document, TAPE_REVISIONS).get(tapeId);
    assert(typeof revision === 'number', `unknown tape ${tapeId}`);
    return revision;
  }

  /** @internal Local-only cache data for the node projection. */
  nodeCaches(id: NodeId): Readonly<Caches> | undefined {
    this.assertLive();
    return this.localCaches.get(id);
  }

  nodeVersion(id: NodeId): number {
    this.assertLive();
    return this.nodeVersions.get(id) ?? 0;
  }

  /** Snapshot the canonical fields for reconstruction comparison and diagnostics. */
  canonicalSnapshot(): {
    readonly rootId: NodeId;
    readonly nodes: readonly {
      readonly id: NodeId;
      readonly kind: NodeKind;
      readonly children: readonly NodeId[];
      readonly spans: readonly Span[];
      readonly marker: string | null;
      readonly checked: boolean | null;
      readonly info: string | null;
      readonly content: string | null;
    }[];
    readonly tapes: readonly {
      readonly id: TapeId;
      readonly delta: readonly (string | BoundaryEmbed)[];
      readonly revision: number;
    }[];
  } {
    this.assertLive();
    const nodeSnapshots = [...ymap<RecordMap>(this.document, NODES).entries()]
      .map(([id, record]) => {
        const kind = nodeKind(record);
        return Object.freeze({
          id,
          kind,
          children: Object.freeze([...readChildren(record)]),
          spans: freezeJson(
            cloneJson(readSpans(record) as unknown as JsonValue),
          ) as unknown as readonly Span[],
          marker: nodeCell<string | null>(record, 'marker'),
          checked: nodeCell<boolean | null>(record, 'checked'),
          info: nodeCell<string | null>(record, 'info'),
          content: INLINE_KINDS.has(kind) ? (this.node(id).content ?? '') : null,
        });
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const tapeSnapshots = [...ymap<Y.Text>(this.document, TAPES).entries()]
      .map(([id, tape]) =>
        Object.freeze({
          id,
          delta: Object.freeze(
            tape.toDelta().map((part: { insert: unknown }) => {
              if (typeof part.insert === 'string') return part.insert;
              return freezeJson(
                cloneJson(part.insert as unknown as JsonValue),
              ) as unknown as BoundaryEmbed;
            }),
          ),
          revision: this.tapeRevision(id),
        }),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    return Object.freeze({
      rootId: metaValue<string>(ymap<unknown>(this.document, META), 'rootId'),
      nodes: Object.freeze(nodeSnapshots),
      tapes: Object.freeze(tapeSnapshots),
    });
  }

  validateRetainedForest(): ValidationResult {
    return validateRetainedForest(this);
  }

  validateActiveSpans(): ValidationResult {
    return validateActiveSpans(this);
  }

  validate(): ValidationResult {
    const forest = this.validateRetainedForest();
    const spans = this.validateActiveSpans();
    const errors = [...forest.errors, ...spans.errors];
    return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    closedDocuments.add(this);
    this.projectionListeners.clear();
    this.revisionVersion++;
    for (const facade of this.facades.values()) facade.renderSignal.value++;
  }

  parentId(id: NodeId): NodeId | undefined {
    this.assertLive();
    for (const [parentId, record] of ymap<RecordMap>(this.document, NODES).entries()) {
      if (readChildren(record).includes(id)) return parentId;
    }
    return undefined;
  }

  sibling(id: NodeId, direction: -1 | 1): CanonicalNode | undefined {
    const parentId = this.parentId(id);
    if (!parentId) return undefined;
    const siblings = readChildren(this.requireRecord(parentId));
    const index = siblings.indexOf(id);
    const siblingId = siblings[index + direction];
    return siblingId ? this.node(siblingId) : undefined;
  }

  isConnected(id: NodeId): boolean {
    this.assertLive();
    const rootId = metaValue(ymap<unknown>(this.document, META), 'rootId') as string;
    const pending = [rootId];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === id) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const record = ymap<RecordMap>(this.document, NODES).get(current);
      if (record) pending.push(...readChildren(record));
    }
    return false;
  }

  private assertLive(): void {
    assert(!this.disposed, 'canonical document is closed');
    assert(!this.publicationPending, 'canonical document has an unpublished commit');
  }

  /** @internal Read guard for exported validation helpers. */
  assertReadable(): void {
    this.assertLive();
  }

  private advanceProjection(affectedNodeIds: readonly NodeId[]): readonly unknown[] {
    this.revisionVersion++;
    const errors: unknown[] = [];
    try {
      batch(() => {
        for (const id of new Set(affectedNodeIds)) {
          this.nodeVersions.set(id, (this.nodeVersions.get(id) ?? 0) + 1);
          this.localCaches.delete(id);
          const facade = this.facades.get(id);
          if (facade) facade.renderSignal.value++;
        }
      });
    } catch (error) {
      errors.push(error);
    }
    for (const listener of this.projectionListeners) {
      try {
        listener(this.revisionVersion);
      } catch (error) {
        errors.push(error);
      }
    }
    return Object.freeze(errors);
  }

  private requireRecord(id: NodeId): RecordMap {
    const record = ymap<RecordMap>(this.document, NODES).get(id);
    assert(record, `unknown node ID ${id}`);
    return record;
  }
}

/** @internal Keep raw Yjs state behind the canonical writer boundary. */
export function canonicalWriterAccess(document: CanonicalDocument): CanonicalWriterAccess {
  const access = writerAccesses.get(document);
  assert(access, 'canonical document is closed');
  return access;
}

export function validateRetainedForest(document: CanonicalDocument): ValidationResult {
  const errors: string[] = [];
  let nodes: NodeMap;
  let rootId: string;
  let schemaVersion: number;
  try {
    document.assertReadable();
    const backing = closedDocuments.has(document) ? undefined : backingDocuments.get(document);
    assert(backing, 'canonical document is closed');
    nodes = ymap<RecordMap>(backing, NODES);
    const meta = ymap<unknown>(backing, META);
    rootId = metaValue<string>(meta, 'rootId');
    schemaVersion = metaValue<number>(meta, 'schemaVersion');
  } catch (error) {
    return Object.freeze({ valid: false, errors: Object.freeze([String(error)]) });
  }

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

export function validateActiveSpans(document: CanonicalDocument): ValidationResult {
  const errors: string[] = [];
  try {
    document.assertReadable();
  } catch (error) {
    return Object.freeze({ valid: false, errors: Object.freeze([String(error)]) });
  }
  const backing = closedDocuments.has(document) ? undefined : backingDocuments.get(document);
  if (!backing)
    return Object.freeze({ valid: false, errors: Object.freeze(['canonical document is closed']) });
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

/** @internal Validate a disposable staging document without constructing a checkpoint copy. */
export function validateCanonicalState(state: Y.Doc): ValidationResult {
  return CanonicalDocument.validateState(state);
}
