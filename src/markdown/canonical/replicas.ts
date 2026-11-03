import * as Y from 'yjs';

import { CanonicalIndexes } from './indexes.js';
import { metaMap } from './state-access.js';
import { assertResolvedUpdate } from './native-execution.js';
import type { TapeId } from './types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Owns the writer's isolated author and validation views of one canonical document. */
export class CanonicalReplicas {
  private validationState?: Y.Doc;
  private validationIndexes?: CanonicalIndexes;
  private readonly authors = new Map<string, Y.Doc>();
  private readonly pendingAuthors = new Map<string, string>();
  private authorCreations = 0;
  private validationCreations = 0;

  constructor(
    private readonly state: Y.Doc,
    private readonly liveIndexes: CanonicalIndexes,
    private readonly cloneState: () => Y.Doc,
  ) {
    this.ensureValidation();
  }

  get authorReplicaCreations(): number {
    return this.authorCreations;
  }

  get validationReplicaCreations(): number {
    return this.validationCreations;
  }

  hasPendingAuthor(sessionId: string): boolean {
    return this.pendingAuthors.has(sessionId);
  }

  markAuthorPending(sessionId: string, actionId: string): void {
    this.pendingAuthors.set(sessionId, actionId);
  }

  authorReplica(sessionId: string): Y.Doc {
    let replica = this.authors.get(sessionId);
    if (!replica) {
      replica = this.cloneState();
      this.authorCreations++;
      this.authors.set(sessionId, replica);
    }
    return replica;
  }

  discardAuthorReplica(sessionId: string): void {
    this.authors.get(sessionId)?.destroy();
    this.authors.delete(sessionId);
    this.pendingAuthors.delete(sessionId);
  }

  rejectPreparedAuthor(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const request = value as { readonly sessionId?: unknown; readonly actionId?: unknown };
    if (
      typeof request.sessionId === 'string' &&
      typeof request.actionId === 'string' &&
      this.pendingAuthors.get(request.sessionId) === request.actionId
    ) {
      this.discardAuthorReplica(request.sessionId);
    }
  }

  discardValidationReplica(): void {
    this.validationState?.destroy();
    this.validationState = undefined;
    this.validationIndexes = undefined;
  }

  ensureValidation(): { readonly state: Y.Doc; readonly indexes: CanonicalIndexes } {
    if (!this.validationState) {
      this.validationState = this.cloneState();
      this.validationIndexes = new CanonicalIndexes(this.validationState);
      this.validationCreations++;
    }
    assert(this.validationIndexes, 'validation replica is missing its indexes');
    return { state: this.validationState, indexes: this.validationIndexes };
  }

  syncAcceptedValidation(
    update: Uint8Array,
    changedTapeIds: ReadonlySet<TapeId>,
    structuralEffect: boolean,
    revision: number,
    textIndexFresh = false,
  ): void {
    const validation = this.ensureValidation();
    Y.applyUpdate(validation.state, Uint8Array.from(update));
    assertResolvedUpdate(validation.state);
    assert(
      metaMap(validation.state).get('documentId') === metaMap(this.state).get('documentId') &&
        metaMap(validation.state).get('authorityEpoch') ===
          metaMap(this.state).get('authorityEpoch') &&
        metaMap(validation.state).get('acceptedRevision') === revision,
      'validation replica did not receive the accepted document prefix',
    );
    if (structuralEffect) validation.indexes.rebuild();
    else if (!textIndexFresh) validation.indexes.refreshText(changedTapeIds);
  }

  applyAcceptedUpdate(
    update: Uint8Array,
    completedAction?: { readonly sessionId: string; readonly actionId: string },
  ): void {
    for (const [sessionId, replica] of this.authors) {
      try {
        Y.applyUpdate(replica, Uint8Array.from(update));
        assertResolvedUpdate(replica);
        assert(
          metaMap(replica).get('documentId') === metaMap(this.state).get('documentId') &&
            metaMap(replica).get('authorityEpoch') === metaMap(this.state).get('authorityEpoch') &&
            metaMap(replica).get('acceptedRevision') ===
              (metaMap(this.state).get('acceptedRevision') as number),
          'author replica did not receive the accepted document prefix',
        );
      } catch {
        this.discardAuthorReplica(sessionId);
      }
    }
    if (
      completedAction &&
      this.pendingAuthors.get(completedAction.sessionId) === completedAction.actionId
    ) {
      this.pendingAuthors.delete(completedAction.sessionId);
    }
  }

  onExternallyAcceptedUpdate(
    update: Uint8Array,
    changedTapeIds: readonly TapeId[],
    structuralEffect: boolean,
  ): void {
    const revision = metaMap(this.state).get('acceptedRevision') as number;
    const changed = new Set(changedTapeIds);
    this.syncAcceptedValidation(update, changed, structuralEffect, revision);
    this.applyAcceptedUpdate(update);
    if (structuralEffect) this.liveIndexes.rebuild();
    else this.liveIndexes.refreshText(changed);
  }

  close(): void {
    for (const replica of this.authors.values()) replica.destroy();
    this.authors.clear();
    this.pendingAuthors.clear();
    this.discardValidationReplica();
  }
}
