import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import {
  CanonicalDocument,
  canonicalWriterAccess,
  type CanonicalCheckpoint,
} from './canonical-model.js';
import {
  CanonicalWriter,
  type AcceptedAction,
  type ActionRequest,
  type AdmittedContext,
  type DraftCommand,
} from './canonical-actions.js';
import type { TextEdit } from './canonical-text.js';

function makeDocument(text = 'base'): CanonicalDocument {
  return CanonicalDocument.fromMarkdown(text, {
    documentId: `collaboration-${text.length}-${text.replaceAll(/[^a-z]/g, '')}`,
    actionId: `collaboration-import-${text.length}`,
    authorityEpoch: 'collaboration-epoch',
  });
}

function admitted(request: ActionRequest, sessionId: string): AdmittedContext {
  return {
    sessionId,
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  };
}

function accept(
  writer: CanonicalWriter,
  request: ActionRequest,
  sessionId: string,
): AcceptedAction {
  writer.admitSession(sessionId);
  const result = writer.apply(request, admitted(request, sessionId));
  expect(result.status).toBe('pending');
  if (result.status !== 'pending') throw new Error(`expected pending action, got ${result.status}`);
  return writer.publish(result.pending);
}

function authorText(
  checkpoint: CanonicalCheckpoint,
  nodeId: string,
  edit: TextEdit,
  options: { readonly actionId: string; readonly sessionId: string; readonly sequence?: number },
): ActionRequest {
  const document = CanonicalDocument.open(checkpoint);
  const writer = new CanonicalWriter(document);
  try {
    return writer.prepareTextInput(nodeId, edit, {
      actionId: options.actionId,
      sessionId: options.sessionId,
      ...(options.sequence === undefined ? {} : { sessionSequence: options.sequence }),
    });
  } finally {
    writer.close();
    document.close();
  }
}

function authorCommand(
  checkpoint: CanonicalCheckpoint,
  options: { readonly actionId: string; readonly sessionId: string; readonly sequence?: number },
  callback: DraftCommand,
): ActionRequest {
  const document = CanonicalDocument.open(checkpoint);
  const writer = new CanonicalWriter(document);
  try {
    return writer.prepareCommand(
      {
        actionId: options.actionId,
        sessionId: options.sessionId,
        ...(options.sequence === undefined ? {} : { sessionSequence: options.sequence }),
      },
      callback,
    );
  } finally {
    writer.close();
    document.close();
  }
}

function envelopeFingerprint(envelope: AcceptedAction): string {
  return JSON.stringify({
    actionId: envelope.actionId,
    sessionId: envelope.sessionId,
    authorityEpoch: envelope.authorityEpoch,
    revision: envelope.revision,
    update: Array.from(envelope.update),
  });
}

type Delivery = 'applied' | 'held' | 'duplicate';

/** Test transport: retain gaps outside Y.Doc and admit only complete prefixes. */
class TestReplica {
  readonly document: CanonicalDocument;
  private readonly accepted = new Map<number, string>();
  private readonly waiting = new Map<number, AcceptedAction>();

  constructor(
    checkpoint: CanonicalCheckpoint,
    history: readonly AcceptedAction[] = [],
    private readonly expectedSnapshots: ReadonlyMap<number, unknown> = new Map(),
  ) {
    this.document = CanonicalDocument.open(checkpoint);
    for (const envelope of history) {
      if (envelope.revision <= checkpoint.acceptedRevision)
        this.accepted.set(envelope.revision, envelopeFingerprint(envelope));
    }
  }

  deliver(envelope: AcceptedAction): Delivery {
    const fingerprint = envelopeFingerprint(envelope);
    if (envelope.revision <= this.document.acceptedRevision) {
      expect(this.accepted.get(envelope.revision)).toBe(fingerprint);
      return 'duplicate';
    }
    if (envelope.revision > this.document.acceptedRevision + 1) {
      const prior = this.waiting.get(envelope.revision);
      if (prior) expect(envelopeFingerprint(prior)).toBe(fingerprint);
      else this.waiting.set(envelope.revision, envelope);
      return 'held';
    }

    this.applyNext(envelope);
    while (true) {
      const next = this.document.acceptedRevision + 1;
      const queued = this.waiting.get(next);
      if (!queued) break;
      this.waiting.delete(next);
      this.applyNext(queued);
    }
    return 'applied';
  }

  private applyNext(envelope: AcceptedAction): void {
    expect(envelope.revision).toBe(this.document.acceptedRevision + 1);
    this.document.applyAccepted(envelope);
    this.accepted.set(envelope.revision, envelopeFingerprint(envelope));
    expect(this.document.validate()).toEqual({ valid: true, errors: [] });
    expect(this.document.canonicalSnapshot()).toEqual(
      this.expectedSnapshots.get(envelope.revision),
    );
    assertFreshReconstruction(this.document);
  }
}

function assertFreshReconstruction(document: CanonicalDocument): void {
  const fresh = CanonicalDocument.open(document.checkpoint());
  try {
    expect(fresh.canonicalSnapshot()).toEqual(document.canonicalSnapshot());
    expect(fresh.validate()).toEqual({ valid: true, errors: [] });
  } finally {
    fresh.close();
  }
}

describe('headless collaboration protocol', () => {
  it('admits three concurrent authors in accepted order and reconstructs every checkpoint', () => {
    const authority = makeDocument('abcd');
    const writer = new CanonicalWriter(authority);
    const initial = authority.checkpoint();
    const nodeId = authority.root.children[0]!.sharedId;
    const requests = ['A', 'B', 'C'].map((insert, index) =>
      authorText(
        initial,
        nodeId,
        { from: 2, to: 2, insert },
        { actionId: `concurrent-${insert}`, sessionId: `author-${index}` },
      ),
    );
    const envelopes: AcceptedAction[] = [];
    const expectedSnapshots = new Map<number, unknown>();
    for (const [index, request] of requests.entries()) {
      const envelope = accept(writer, request, `author-${index}`);
      envelopes.push(envelope);
      expectedSnapshots.set(envelope.revision, authority.canonicalSnapshot());
      assertFreshReconstruction(authority);
    }
    const ordered = new TestReplica(initial, [], expectedSnapshots);
    const reordered = new TestReplica(initial, [], expectedSnapshots);

    expect(reordered.deliver(envelopes[2]!)).toBe('held');
    expect(reordered.deliver(envelopes[1]!)).toBe('held');
    expect(reordered.document.acceptedRevision).toBe(0);
    expect(reordered.deliver(envelopes[0]!)).toBe('applied');
    for (const envelope of envelopes) expect(ordered.deliver(envelope)).toBe('applied');

    for (const replica of [ordered, reordered]) {
      expect(replica.document.acceptedRevision).toBe(3);
      expect(replica.document.canonicalSnapshot()).toEqual(authority.canonicalSnapshot());
      expect(replica.document.root.children[0]?.content).toHaveLength(7);
      expect(replica.document.root.children[0]?.content).toContain('A');
      expect(replica.document.root.children[0]?.content).toContain('B');
      expect(replica.document.root.children[0]?.content).toContain('C');
      expect(replica.document.validate()).toEqual({ valid: true, errors: [] });
    }

    const beforeDuplicate = reordered.document.canonicalSnapshot();
    expect(reordered.deliver(envelopes[1]!)).toBe('duplicate');
    expect(reordered.document.canonicalSnapshot()).toEqual(beforeDuplicate);
    const conflictingDuplicate = {
      ...envelopes[1]!,
      update: Uint8Array.from([...envelopes[1]!.update, 0]),
    };
    expect(() => reordered.deliver(conflictingDuplicate)).toThrow();

    const reconnected = new TestReplica(authority.checkpoint(), envelopes, expectedSnapshots);
    expect(reconnected.document.canonicalSnapshot()).toEqual(authority.canonicalSnapshot());
    expect(reconnected.deliver(envelopes[0]!)).toBe('duplicate');
    const reconnectWriter = new CanonicalWriter(reconnected.document);
    expect(reconnectWriter.undo('author-0').status).toBe('history-reset');
    expect(reconnectWriter.undo('author-0').status).toBe('empty');
    reconnectWriter.close();

    ordered.document.close();
    reordered.document.close();
    reconnected.document.close();
    writer.close();
    authority.close();
  });

  it('enforces one outstanding action per session and returns identical retries', () => {
    const document = makeDocument('a');
    const writer = new CanonicalWriter(document);
    const initial = document.checkpoint();
    const nodeId = document.root.children[0]!.sharedId;
    const first = authorText(
      initial,
      nodeId,
      { from: 1, to: 1, insert: 'x' },
      {
        actionId: 'session-first',
        sessionId: 'same-session',
      },
    );
    const prematureSecond = authorText(
      initial,
      nodeId,
      { from: 1, to: 1, insert: 'y' },
      {
        actionId: 'session-second',
        sessionId: 'same-session',
        sequence: 2,
      },
    );
    writer.admitSession('same-session');
    expect(writer.apply(prematureSecond, admitted(prematureSecond, 'same-session'))).toEqual({
      status: 'rejected',
      reason: 'wrong-sequence',
    });

    const accepted = accept(writer, first, 'same-session');
    const retry = writer.apply(first, admitted(first, 'same-session'));
    expect(retry).toMatchObject({ status: 'duplicate', accepted });
    if (retry.status !== 'duplicate') throw new Error('retry did not return accepted action');
    expect(retry.accepted).toEqual(accepted);
    expect(
      writer.apply(first, {
        ...admitted(first, 'same-session'),
        authorityEpoch: 'stale-epoch',
      }),
    ).toEqual({ status: 'rejected', reason: 'wrong-authority-epoch' });
    expect(
      writer.apply(first, {
        ...admitted(first, 'same-session'),
        sessionSequence: first.sessionSequence + 1,
      }),
    ).toEqual({ status: 'rejected', reason: 'wrong-sequence' });
    const changedContent = {
      ...first,
      textUpdate: Uint8Array.from([...first.textUpdate!, 0]),
    };
    expect(writer.apply(changedContent, admitted(changedContent, 'same-session'))).toEqual({
      status: 'rejected',
      reason: 'retry-payload-conflict',
    });

    const next = authorText(
      document.checkpoint(),
      nodeId,
      { from: 2, to: 2, insert: 'y' },
      {
        actionId: 'session-second',
        sessionId: 'same-session',
        sequence: 2,
      },
    );
    accept(writer, next, 'same-session');
    expect(document.root.children[0]?.content).toBe('axy');
    writer.close();
    document.close();
  });

  it('rejects a malformed authored update before changing state or history', () => {
    const document = makeDocument('unchanged');
    const writer = new CanonicalWriter(document);
    const before = document.checkpoint().update;
    const nodeId = document.root.children[0]!.sharedId;
    const valid = writer.prepareTextInput(
      nodeId,
      { from: 0, to: 0, insert: 'x' },
      { actionId: 'malformed-native-update', sessionId: 'author' },
    );
    const malformed: ActionRequest = { ...valid, textUpdate: Uint8Array.of(0) };
    const events: unknown[] = [];
    writer.subscribe((event) => events.push(event));

    writer.admitSession('author');
    expect(writer.apply(malformed, admitted(malformed, 'author'))).toEqual({
      status: 'rejected',
      reason: 'invalid-text-update',
    });
    expect(document.checkpoint().update).toEqual(before);
    expect(document.root.children[0]?.content).toBe('unchanged');
    expect(writer.canUndo('author')).toBe(false);
    expect(events).toEqual([]);
    writer.close();
    document.close();
  });

  it('keeps authority history across a transient reconnect and expires it on epoch reset', () => {
    const document = makeDocument('local');
    const writer = new CanonicalWriter(document);
    const nodeId = document.root.children[0]!.sharedId;
    const request = writer.prepareTextInput(
      nodeId,
      { from: 5, to: 5, insert: '!' },
      { actionId: 'reconnect-history', sessionId: 'reconnecting-session' },
    );
    const accepted = accept(writer, request, 'reconnecting-session');
    const transientClient = new TestReplica(document.checkpoint(), [accepted]);
    expect(transientClient.document.root.children[0]?.content).toBe('local!');
    transientClient.document.close();
    expect(writer.canUndo('reconnecting-session')).toBe(true);
    expect(writer.undo('reconnecting-session').status).toBe('applied');
    expect(document.root.children[0]?.content).toBe('local');

    const durable = document.checkpoint();
    writer.close();
    document.close();
    const restored = CanonicalDocument.restore(durable, 'collaboration-epoch-5');
    const newAuthority = new CanonicalWriter(restored);
    expect(newAuthority.undo('reconnecting-session').status).toBe('history-reset');
    expect(newAuthority.canUndo('reconnecting-session')).toBe(false);
    newAuthority.close();
    restored.close();
  });

  it('rejects stale compound text and conversion as one action', () => {
    const document = makeDocument('word');
    const writer = new CanonicalWriter(document);
    const initial = document.checkpoint();
    const nodeId = document.root.children[0]!.sharedId;
    const compoundText = authorText(
      initial,
      nodeId,
      { from: 4, to: 4, insert: '!' },
      {
        actionId: 'compound-text-source',
        sessionId: 'compound',
      },
    );
    const command = authorCommand(
      initial,
      { actionId: 'stale-compound', sessionId: 'compound' },
      (draft) => draft.convertInline(nodeId, { type: 'section', marker: '#' }),
    );
    const compound: ActionRequest = {
      ...command,
      textUpdate: compoundText.textUpdate,
    };
    const concurrent = authorText(
      initial,
      nodeId,
      { from: 0, to: 0, insert: 'remote-' },
      {
        actionId: 'compound-conflict',
        sessionId: 'other-session',
      },
    );
    writer.admitSession('compound');
    accept(writer, concurrent, 'other-session');
    const before = document.checkpoint().update;

    expect(writer.apply(compound, admitted(compound, 'compound'))).toEqual({
      status: 'rejected',
      reason: 'stale-precondition',
    });
    expect(document.checkpoint().update).toEqual(before);
    expect(document.root.children[0]?.type).toBe('paragraph');
    expect(document.root.children[0]?.content).toBe('remote-word');
    writer.close();
    document.close();
  });

  it('skips automatic promotion after ownership changes but retains delayed detached text', () => {
    const document = makeDocument('draft');
    const writer = new CanonicalWriter(document);
    const initial = document.checkpoint();
    const paragraph = document.root.children[0]!;
    const promoteText = authorText(
      initial,
      paragraph.sharedId,
      {
        from: 0,
        to: 0,
        insert: '# ',
      },
      { actionId: 'promote-late', sessionId: 'typing' },
    );
    const convert = writer.prepareCommand(
      { actionId: 'change-kind', sessionId: 'command' },
      (draft) => draft.convertInline(paragraph.sharedId, { type: 'code-block', info: 'ts' }),
    );
    accept(writer, convert, 'command');
    const promoted = accept(writer, promoteText, 'typing');
    expect(promoted.receipt.promotionSkipped).toBe('ownershipChanged');
    expect(document.root.children[0]?.type).toBe('code-block');
    expect(document.root.children[0]?.content).toBe('# draft');

    const detachedCheckpoint = document.checkpoint();
    const delayed = authorText(
      detachedCheckpoint,
      paragraph.sharedId,
      { from: 7, to: 7, insert: ' hidden' },
      { actionId: 'detached-late-text', sessionId: 'late-author' },
    );
    const detach = writer.prepareCommand(
      { actionId: 'detach-retained', sessionId: 'structure' },
      (draft) => draft.detach(paragraph.sharedId),
    );
    accept(writer, detach, 'structure');
    const hidden = accept(writer, delayed, 'late-author');
    expect(hidden.receipt.promotionSkipped).toBe('ownershipChanged');
    expect(document.node(paragraph.sharedId).connected).toBe(false);
    expect(document.node(paragraph.sharedId).content).toBe('# draft hidden');
    expect(JSON.stringify(document.exportMarkdownTree())).not.toContain('draft');
    expect(
      document.canonicalSnapshot().nodes.find((node) => node.id === paragraph.sharedId)?.content,
    ).toBe('# draft hidden');
    assertFreshReconstruction(document);
    writer.close();
    document.close();
  });

  it('assigns an insertion unseen by a concurrent split from marker order', () => {
    const document = makeDocument('abcd');
    const writer = new CanonicalWriter(document);
    const initial = document.checkpoint();
    const rootId = document.root.sharedId;
    const sourceId = document.root.children[0]!.sharedId;
    let destinationId = '';
    const split = authorCommand(
      initial,
      { actionId: 'split-at-two', sessionId: 'splitter' },
      (draft) => {
        destinationId = draft.create({ type: 'paragraph' });
        draft.place(destinationId, rootId, null);
        draft.transferInlineRange({
          source: sourceId,
          from: 2,
          to: 4,
          destination: destinationId,
          at: 0,
          affinity: 'right',
        });
      },
    );
    const unseenInsertion = authorText(
      initial,
      sourceId,
      { from: 2, to: 2, insert: 'X' },
      { actionId: 'unseen-marker-insert', sessionId: 'racer' },
    );
    accept(writer, split, 'splitter');
    accept(writer, unseenInsertion, 'racer');

    const source = document.node(sourceId);
    const destination = document.node(destinationId);
    expect(`${source.content}${destination.content}`).toBe('abXcd');
    expect(source.content === 'abX' || destination.content === 'Xcd').toBe(true);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    assertFreshReconstruction(document);
    writer.close();
    document.close();
  });

  it('poisons after a post-write phase fault and restores only durable state in a new epoch', () => {
    const document = makeDocument('base');
    const durable = document.checkpoint();
    const writer = new CanonicalWriter(document);
    const events: unknown[] = [];
    writer.subscribe((event) => events.push(event));
    const rootId = document.root.sharedId;
    const request = writer.prepareCommand({ actionId: 'fault-between-phases' }, (draft) => {
      const created = draft.create({ type: 'paragraph', content: 'unpublished' });
      draft.place(created, rootId, null);
    });

    const state = canonicalWriterAccess(document).state;
    const patchable = state as unknown as { transact: (...args: unknown[]) => unknown };
    const originalTransact = state.transact.bind(state);
    let transactionCount = 0;
    patchable.transact = (...args: unknown[]) => {
      const result = Reflect.apply(originalTransact, state, args);
      transactionCount++;
      if (transactionCount === 1) throw new Error('injected phase fault');
      return result;
    };
    try {
      expect(() => writer.apply(request, admitted(request, 'local'))).toThrow('writer is poisoned');
    } finally {
      patchable.transact = originalTransact as unknown as (...args: unknown[]) => unknown;
    }

    expect(transactionCount).toBe(1);
    expect(writer.poisonedWriter).toBe(true);
    expect(writer.apply(request, admitted(request, 'local'))).toEqual({
      status: 'rejected',
      reason: 'poisoned-writer',
    });
    expect(events).toEqual([]);
    expect(() => document.root.children).toThrow('unpublished commit');

    writer.close();
    document.close();
    const restored = CanonicalDocument.restore(durable, 'collaboration-epoch-2');
    expect(restored.acceptedRevision).toBe(0);
    expect(restored.root.children.map((node) => node.content)).toEqual(['base']);
    const recoveredWriter = new CanonicalWriter(restored);
    expect(recoveredWriter.undo().status).toBe('history-reset');
    expect(recoveredWriter.canUndo()).toBe(false);
    recoveredWriter.close();
    restored.close();
  });

  it('poisons after persistence fails and keeps accepted state hidden until new-epoch restore', () => {
    const document = makeDocument('durable');
    const durable = document.checkpoint();
    const writer = new CanonicalWriter(document);
    const nodeId = document.root.children[0]!.sharedId;
    const request = writer.prepareTextInput(
      nodeId,
      { from: 7, to: 7, insert: '!' },
      { actionId: 'persistence-failure', sessionId: 'writer-session' },
    );
    const events: unknown[] = [];
    writer.subscribe((event) => events.push(event));
    writer.admitSession('writer-session');
    const result = writer.apply(request, admitted(request, 'writer-session'));
    expect(result.status).toBe('pending');
    if (result.status !== 'pending') throw new Error('missing pending action');

    expect(() => document.node(nodeId).content).toThrow('unpublished commit');
    const appendAndPublish = () => {
      try {
        const persist = () => {
          throw new Error('durable append failed');
        };
        persist();
        writer.publish(result.pending);
      } catch (error) {
        writer.failPendingCommit(result.pending);
        throw error;
      }
    };
    expect(appendAndPublish).toThrow('durable append failed');
    expect(writer.poisonedWriter).toBe(true);
    expect(events).toEqual([]);
    expect(writer.apply(request, admitted(request, 'writer-session'))).toEqual({
      status: 'rejected',
      reason: 'poisoned-writer',
    });

    writer.close();
    document.close();
    const restored = CanonicalDocument.restore(durable, 'collaboration-epoch-3');
    const recoveredWriter = new CanonicalWriter(restored);
    expect(recoveredWriter.undo('writer-session').status).toBe('history-reset');
    expect(restored.root.children[0]?.content).toBe('durable');
    expect(recoveredWriter.apply(request, admitted(request, 'writer-session'))).toEqual({
      status: 'rejected',
      reason: 'wrong-authority-epoch',
    });
    recoveredWriter.close();
    restored.close();
  });

  it('does not publish a staged history inversion when its durable append fails', () => {
    const document = makeDocument('history');
    const writer = new CanonicalWriter(document);
    const nodeId = document.root.children[0]!.sharedId;
    const request = writer.prepareTextInput(
      nodeId,
      { from: 7, to: 7, insert: '!' },
      { actionId: 'history-durable-entry', sessionId: 'durable-history' },
    );
    accept(writer, request, 'durable-history');
    const durable = document.checkpoint();
    const events: unknown[] = [];
    writer.subscribe((event) => events.push(event));
    const undo = writer.prepareUndo('durable-history');
    expect(undo.status).toBe('pending');
    if (undo.status !== 'pending') throw new Error('missing staged history inversion');
    expect(() => document.node(nodeId).content).toThrow('unpublished commit');
    const appendAndPublish = () => {
      try {
        const persist = () => {
          throw new Error('history append failed');
        };
        persist();
        writer.publishHistory(undo.pending);
      } catch (error) {
        writer.failPendingCommit(undo.pending);
        throw error;
      }
    };
    expect(appendAndPublish).toThrow('history append failed');

    expect(writer.poisonedWriter).toBe(true);
    expect(events).toEqual([]);
    writer.close();
    document.close();
    const restored = CanonicalDocument.restore(durable, 'collaboration-epoch-6');
    const recoveredWriter = new CanonicalWriter(restored);
    expect(recoveredWriter.undo('durable-history').status).toBe('history-reset');
    expect(restored.root.children[0]?.content).toBe('history!');
    recoveredWriter.close();
    restored.close();
  });

  it('poisons if native text inversion throws and exposes an explicit history reset', () => {
    const document = makeDocument('text');
    const writer = new CanonicalWriter(document);
    const nodeId = document.root.children[0]!.sharedId;
    const request = writer.prepareTextInput(
      nodeId,
      { from: 4, to: 4, insert: '!' },
      { actionId: 'history-entry', sessionId: 'history-session' },
    );
    accept(writer, request, 'history-session');
    const durable = document.checkpoint();
    const events: unknown[] = [];
    writer.subscribe((event) => events.push(event));
    const undo = vi.spyOn(Y.UndoManager.prototype, 'undo').mockImplementation(() => {
      throw new Error('injected native inversion fault');
    });
    try {
      expect(() => writer.undo('history-session')).toThrow('writer is poisoned');
    } finally {
      undo.mockRestore();
    }

    expect(writer.poisonedWriter).toBe(true);
    expect(events).toEqual([]);
    expect(() => document.root.children).toThrow('unpublished commit');
    writer.close();
    document.close();

    const restored = CanonicalDocument.restore(durable, 'collaboration-epoch-4');
    const recoveredWriter = new CanonicalWriter(restored);
    expect(recoveredWriter.undo('history-session').status).toBe('history-reset');
    expect(restored.root.children[0]?.content).toBe('text!');
    recoveredWriter.close();
    restored.close();
  });
});
