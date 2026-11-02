import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';

import { CanonicalWriter } from './canonical-actions.js';
import type { ActionRequest } from './canonical-actions.js';
import { CanonicalDocument, canonicalWriterAccess } from './canonical-model.js';

function makeDocument() {
  return CanonicalDocument.fromMarkdown('alpha\n\nbeta', {
    documentId: 'm1-amplification-control',
    authorityEpoch: 'm1-amplification-epoch',
    actionId: 'm1-amplification-import',
  });
}

function applyAndPublish(writer: CanonicalWriter, request: ActionRequest) {
  const result = writer.apply(request, {
    sessionId: request.sessionId,
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  });
  if (result.status !== 'pending') throw new Error(`action was not staged: ${result.status}`);
  return writer.publish(result.pending);
}

describe('Yjs M1 amplification controls', () => {
  it('keys action allocations by document, epoch, session, sequence, and ordinal', () => {
    const document = makeDocument();
    const writer = new CanonicalWriter(document);
    try {
      const addTwoParagraphs = (sessionId: string) => {
        const result = writer.edit({ actionId: 'same-descriptive-action', sessionId }, (draft) => {
          const first = draft.create({ type: 'paragraph', content: `${sessionId}-one` });
          const second = draft.create({ type: 'paragraph', content: `${sessionId}-two` });
          draft.place(first, document.root.sharedId, null);
          draft.place(second, document.root.sharedId, null);
        });
        if (!('receipt' in result)) throw new Error(`action was not accepted: ${result.status}`);
        return result;
      };

      const firstSession = addTwoParagraphs('m1-session-a');
      const secondSession = addTwoParagraphs('m1-session-b');
      const authorityEpoch = document.checkpoint().authorityEpoch;
      expect(firstSession.receipt.requestId).toBe(
        JSON.stringify([document.documentId, authorityEpoch, 'm1-session-a', 1]),
      );
      expect(secondSession.receipt.requestId).toBe(
        JSON.stringify([document.documentId, authorityEpoch, 'm1-session-b', 1]),
      );
      const firstIds = firstSession.receipt.structuralPatch.births.map(({ nodeId }) => nodeId);
      const secondIds = secondSession.receipt.structuralPatch.births.map(({ nodeId }) => nodeId);
      expect(firstIds).toHaveLength(2);
      expect(new Set(firstIds).size).toBe(2);
      expect(secondIds).toHaveLength(2);
      expect(new Set(secondIds).size).toBe(2);
      expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
      expect(document.validate()).toEqual({ valid: true, errors: [] });
    } finally {
      writer.close();
      document.close();
    }
  });

  it('writes only natively changed tape revisions on forward, undo, redo, and replay', () => {
    const document = makeDocument();
    const replica = CanonicalDocument.open(document.checkpoint());
    const writer = new CanonicalWriter(document, { verifyWithFullClone: true });
    try {
      const [first, second] = document.root.children;
      const firstTape = document
        .canonicalSnapshot()
        .nodes.find((node) => node.id === first!.sharedId)!.spans[0]!.tapeId;
      const secondTape = document
        .canonicalSnapshot()
        .nodes.find((node) => node.id === second!.sharedId)!.spans[0]!.tapeId;
      const revisions = canonicalWriterAccess(document).state.getMap<number>('tapeRevisions');
      const setRevision = vi.spyOn(revisions, 'set');
      const replicaRevisions = canonicalWriterAccess(replica).state.getMap<number>('tapeRevisions');
      let replayedKeys: string[] = [];
      replicaRevisions.observe((event) => {
        replayedKeys = [...event.keysChanged];
      });

      const input = writer.prepareTextInput(
        first!.sharedId,
        { from: 1, to: 1, insert: 'X' },
        { actionId: 'm1-revision-forward' },
      );
      const accepted = applyAndPublish(writer, input);
      expect(setRevision.mock.calls.map(([key]) => key)).toEqual([firstTape]);
      expect(document.tapeRevision(secondTape)).toBe(0);

      replica.applyAccepted({ revision: accepted.revision, update: accepted.update });
      expect(replayedKeys).toEqual([firstTape]);
      expect(replica.tapeRevision(secondTape)).toBe(0);

      setRevision.mockClear();
      expect(writer.undo().status).toBe('applied');
      expect(setRevision.mock.calls.map(([key]) => key)).toEqual([firstTape]);

      setRevision.mockClear();
      expect(writer.redo().status).toBe('applied');
      expect(setRevision.mock.calls.map(([key]) => key)).toEqual([firstTape]);
    } finally {
      writer.close();
      replica.close();
      document.close();
    }
  });

  it('captures only the authored update events, excluding an earlier unrelated delete set', () => {
    const document = makeDocument();
    const writer = new CanonicalWriter(document);
    try {
      const [first, second] = document.root.children;
      applyAndPublish(
        writer,
        writer.prepareTextInput(
          first!.sharedId,
          { from: 1, to: 2, insert: '' },
          { actionId: 'm1-prior-delete' },
        ),
      );

      const later = writer.prepareTextInput(
        second!.sharedId,
        { from: 0, to: 0, insert: 'X' },
        { actionId: 'm1-later-insert' },
      );
      const decoded = Y.decodeUpdate(later.textUpdate!);
      expect(decoded.ds.clients.size).toBe(0);
      expect(later.textUpdate!.byteLength).toBeLessThan(64);
    } finally {
      writer.close();
      document.close();
    }
  });

  it('requires host admission and handles identity retries without reexecution', () => {
    const document = makeDocument();
    const writer = new CanonicalWriter(document);
    try {
      const request = writer.prepareCommand(
        { actionId: 'm1-session-action', sessionId: 'remote-session' },
        () => undefined,
      );
      const before = document.checkpoint().update;
      expect(
        writer.apply(request, {
          sessionId: request.sessionId,
          authorityEpoch: request.authorityEpoch,
          sessionSequence: request.sessionSequence,
        }),
      ).toEqual({ status: 'rejected', reason: 'wrong-session' });
      expect(document.checkpoint().update).toEqual(before);

      writer.admitSession('remote-session');
      const accepted = applyAndPublish(writer, request);
      const retry = writer.apply(request, {
        sessionId: request.sessionId,
        authorityEpoch: request.authorityEpoch,
        sessionSequence: request.sessionSequence,
      });
      expect(retry.status).toBe('duplicate');
      if (retry.status !== 'duplicate') throw new Error('accepted response was not cached');
      retry.accepted.update[0] = 0;

      expect(
        writer.apply(
          { ...request, historyGroupId: 'changed retry payload' },
          {
            sessionId: request.sessionId,
            authorityEpoch: request.authorityEpoch,
            sessionSequence: request.sessionSequence,
          },
        ),
      ).toEqual({ status: 'rejected', reason: 'retry-payload-conflict' });
      expect(document.acceptedRevision).toBe(accepted.revision);

      for (let index = 0; index < 256; index++) {
        const next = writer.prepareCommand({ actionId: `m1-cache-${index}` }, () => undefined);
        applyAndPublish(writer, next);
      }
      expect(
        writer.apply(request, {
          sessionId: request.sessionId,
          authorityEpoch: request.authorityEpoch,
          sessionSequence: request.sessionSequence,
        }),
      ).toEqual({ status: 'rejected', reason: 'receipt-expired/resync-required' });
      expect(document.acceptedRevision).toBe(accepted.revision + 256);
    } finally {
      writer.close();
      document.close();
    }
  });

  it('does not cache a response larger than the byte budget', () => {
    const document = makeDocument();
    const writer = new CanonicalWriter(document);
    try {
      const actionId = 'm1-oversized-label'.repeat(300_000);
      const request = writer.prepareCommand(
        { actionId, sessionId: 'large-session' },
        () => undefined,
      );
      writer.admitSession('large-session');
      applyAndPublish(writer, request);
      expect(
        writer.apply(request, {
          sessionId: request.sessionId,
          authorityEpoch: request.authorityEpoch,
          sessionSequence: request.sessionSequence,
        }),
      ).toEqual({ status: 'rejected', reason: 'receipt-expired/resync-required' });
    } finally {
      writer.close();
      document.close();
    }
  });
});
