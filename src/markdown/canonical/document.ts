import * as Y from 'yjs';

import {
  META,
  NODES,
  NODE_FIELDS,
  INLINE_KINDS,
  SCHEMA_VERSION,
  TAPES,
  TAPE_REVISIONS,
  nodeCell,
  nodeKind,
  readChildren,
  readChildrenToken,
  readNodeCell,
  readSpans,
  schemaMap,
} from './schema.js';
import type { NodeId, NodeKind } from '../semantic/types.js';
export type { NodeId, NodeKind } from '../semantic/types.js';
import type { DocumentNode, MarkdownNode } from '../node.js';
import { parseBlocks } from '../block-parser/api.js';
import { batch } from '../../signals.js';
import { cloneSemanticTree, importCanonicalTree } from './import-tree.js';
import {
  encodeCanonicalCheckpoint,
  openCanonicalCheckpoint,
  restoreCanonicalCheckpoint,
} from './checkpoint.js';
import { rebuildCanonicalCheckpoint } from './maintenance.js';
import { textBetweenBoundaries } from './span-text.js';
import { assertAcceptedUpdate } from './accepted-update.js';
export {
  assertRetainedResources,
  assertTapeRevisions,
  tapeItemSignature,
} from './accepted-update.js';
import type {
  AcceptedUpdate,
  CanonicalCheckpoint,
  CanonicalDocumentOptions,
  CanonicalMaintenanceResult,
  CanonicalOpenOptions,
} from './document-types.js';
export type {
  AcceptedUpdate,
  CanonicalCheckpoint,
  CanonicalDocumentOptions,
  CanonicalMaintenanceResult,
  CanonicalMaintenanceReset,
  CanonicalOpenOptions,
} from './document-types.js';
import { CanonicalNode } from './node-projection.js';
import { ConstructionTree } from '../semantic/construction-tree.js';
import type { CanonicalNodeProjectionOwner } from './node-projection.js';
import {
  validateActiveSpansState,
  validateCanonicalState,
  validateRetainedForestState,
} from './validation.js';
import type { ValidationResult } from './validation.js';
export type { ValidationResult } from './validation.js';
import type { BoundaryEmbed, Cell, ResourceToken, Span, TapeId } from './types.js';

export { CanonicalNode } from './node-projection.js';
export type {
  BoundaryEmbed,
  BoundaryId,
  CanonicalNodeFields,
  Cell,
  ResourceToken,
  Span,
  TapeId,
} from './types.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type RecordMap = Y.Map<unknown>;

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

function cellValue<T>(record: RecordMap, field: (typeof NODE_FIELDS)[number]): Cell<T> {
  return readNodeCell<T>(record, field) as Cell<T>;
}

function childrenToken(record: RecordMap): ResourceToken {
  return readChildrenToken(record);
}

function ymap<T>(document: Y.Doc, name: string): Y.Map<T> {
  return schemaMap<T>(document, name);
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

function metaValue<T>(meta: Y.Map<unknown>, key: string): T {
  return meta.get(key) as T;
}

/**
 * Native Yjs canonical storage and its stable read-only semantic projection.
 * The Y.Doc and its shared types are deliberately not exposed.
 */
export class CanonicalDocument implements CanonicalNodeProjectionOwner {
  private readonly facades = new Map<NodeId, CanonicalNode>();
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
    return new CanonicalDocument(importCanonicalTree(cloneSemanticTree(tree), options));
  }

  /** Imports a semantic tree after the existing one-pass construction normalization. */
  static fromTree(tree: DocumentNode, options: CanonicalDocumentOptions = {}): CanonicalDocument {
    const input = cloneSemanticTree(tree) as DocumentNode;
    const construction = new ConstructionTree(input);
    construction.normalize();
    const normalized = construction.serialize() as DocumentNode;
    return new CanonicalDocument(importCanonicalTree(cloneSemanticTree(normalized), options));
  }

  /** @internal Validate an already-disposable staging document. */
  static validateState(state: Y.Doc): ValidationResult {
    return validateCanonicalState(state);
  }

  /** Reconstructs accepted Yjs state without normalization or user-history capture. */
  static open(
    checkpoint: CanonicalCheckpoint,
    options: CanonicalOpenOptions = {},
  ): CanonicalDocument {
    return new CanonicalDocument(openCanonicalCheckpoint(checkpoint, options), true);
  }

  /** Rebuilds a validated schema-2 checkpoint under a new epoch. */
  static rebuild(
    checkpoint: CanonicalCheckpoint,
    authorityEpoch: string,
  ): CanonicalMaintenanceResult {
    return rebuildCanonicalCheckpoint(checkpoint, SCHEMA_VERSION, authorityEpoch);
  }

  /** Explicitly migrates a complete schema-1 checkpoint to schema 2. */
  static migrateSchema1(
    checkpoint: CanonicalCheckpoint,
    authorityEpoch: string,
  ): CanonicalMaintenanceResult {
    return rebuildCanonicalCheckpoint(checkpoint, 1, authorityEpoch);
  }

  /** Restores durable state with a new authority epoch and empty native history. */
  static restore(checkpoint: CanonicalCheckpoint, authorityEpoch: string): CanonicalDocument {
    return new CanonicalDocument(restoreCanonicalCheckpoint(checkpoint, authorityEpoch), true);
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
        return textBetweenBoundaries(tape, span);
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
    return encodeCanonicalCheckpoint(this.document);
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
      assertAcceptedUpdate(this.document, candidate, envelope.revision);
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
  try {
    document.assertReadable();
    const backing = closedDocuments.has(document) ? undefined : backingDocuments.get(document);
    assert(backing, 'canonical document is closed');
    return validateRetainedForestState(backing);
  } catch (error) {
    return Object.freeze({ valid: false, errors: Object.freeze([String(error)]) });
  }
}

export function validateActiveSpans(document: CanonicalDocument): ValidationResult {
  try {
    document.assertReadable();
    const backing = closedDocuments.has(document) ? undefined : backingDocuments.get(document);
    assert(backing, 'canonical document is closed');
    return validateActiveSpansState(backing);
  } catch (error) {
    return Object.freeze({ valid: false, errors: Object.freeze([String(error)]) });
  }
}

export { validateCanonicalState } from './validation.js';
