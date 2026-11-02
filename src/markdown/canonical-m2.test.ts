import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';

import { CanonicalWriter } from './canonical-actions.js';
import { canonicalWriterAccess, CanonicalDocument } from './canonical-model.js';
import type { ActionRequest, AdmittedContext } from './canonical-actions.js';
import type { Span } from './canonical-model.js';

function context(request: ActionRequest): AdmittedContext {
  return {
    sessionId: request.sessionId,
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  };
}

function accept(writer: CanonicalWriter, request: ActionRequest) {
  writer.admitSession(request.sessionId);
  const result = writer.apply(request, context(request));
  expect(result.status).toBe('pending');
  if (result.status !== 'pending') throw new Error(`expected pending commit, got ${result.status}`);
  return writer.publish(result.pending);
}

function makeDocument(markdown: string) {
  return CanonicalDocument.fromMarkdown(markdown, {
    documentId: `m2-${markdown.length}`,
    authorityEpoch: 'm2-epoch',
    actionId: `m2-import-${markdown.length}`,
  });
}

describe('Yjs M2 incremental input', () => {
  it('reuses its author and validation replicas without full-state export or registry walks', () => {
    const markdown = Array.from({ length: 80 }, (_, index) => `paragraph ${index}`).join('\n\n');
    const document = makeDocument(markdown);
    const writer = new CanonicalWriter(document);
    try {
      const target = document.root.children[40]!;
      accept(
        writer,
        writer.prepareTextInput(
          target.sharedId,
          { from: target.content!.length, to: target.content!.length, insert: '!' },
          { actionId: 'm2-author-initialize', sessionId: 'steady-author' },
        ),
      );

      const state = canonicalWriterAccess(document).state;
      const nodeMap = state.getMap('nodes');
      const tapeMap = state.getMap('tapes');
      const tapeId = document.canonicalSnapshot().nodes.find((node) => node.id === target.sharedId)!
        .spans[0]!.tapeId;
      const tape = tapeMap.get(tapeId);
      const nodeEntries = vi.spyOn(nodeMap, 'entries');
      const tapeEntries = vi.spyOn(tapeMap, 'entries');
      const beforeReuse = writer.operationCounts;

      accept(
        writer,
        writer.prepareTextInput(
          target.sharedId,
          { from: target.content!.length, to: target.content!.length, insert: '?' },
          { actionId: 'm2-author-reuse', sessionId: 'steady-author' },
        ),
      );

      expect(writer.operationCounts).toEqual({
        ...beforeReuse,
        literalTextInputs: beforeReuse.literalTextInputs + 1,
      });
      expect(nodeEntries).not.toHaveBeenCalled();
      expect(tapeEntries).not.toHaveBeenCalled();
      expect(target.content).toBe('paragraph 40!?');
      expect(tape).toBe(tapeMap.get(tapeId));
      nodeEntries.mockRestore();
      tapeEntries.mockRestore();
      expect(document.validate()).toEqual({ valid: true, errors: [] });
    } finally {
      writer.close();
      document.close();
    }
  });

  it('rejects marker changes before publication and rebuilds a contaminated replica on retry', () => {
    const document = makeDocument('seed');
    const writer = new CanonicalWriter(document);
    writer.admitSession('remote-author');
    try {
      const target = document.root.children[0]!;
      const valid = writer.prepareTextInput(
        target.sharedId,
        { from: 4, to: 4, insert: '!' },
        { actionId: 'm2-rejected-author', sessionId: 'remote-author' },
      );
      const replica = new Y.Doc({ gc: false });
      Y.applyUpdate(replica, document.checkpoint().update);
      const beforeMutation = Y.encodeStateVector(replica);
      const node = replica.getMap<Y.Map<unknown>>('nodes').get(target.sharedId)!;
      const spanCell = node.get('spans') as { readonly value: readonly Span[] };
      const span = spanCell.value[0]!;
      replica.getMap<Y.Text>('tapes').get(span.tapeId)!.delete(0, 1);
      const markerDeletion = Y.encodeStateAsUpdate(replica, beforeMutation);
      const before = document.checkpoint().update;
      const beforeRejectedCounts = writer.operationCounts;

      const rejected = writer.apply(
        { ...valid, textUpdate: Y.mergeUpdates([valid.textUpdate!, markerDeletion]) },
        context(valid),
      );
      expect(rejected).toEqual({ status: 'rejected', reason: 'invalid-text-update' });
      expect(document.checkpoint().update).toEqual(before);
      expect(target.content).toBe('seed');
      replica.destroy();

      const retry = writer.prepareTextInput(
        target.sharedId,
        { from: 4, to: 4, insert: '?' },
        { actionId: 'm2-valid-after-rejection', sessionId: 'remote-author' },
      );
      accept(writer, retry);
      expect(target.content).toBe('seed?');
      expect(writer.operationCounts).toMatchObject({
        authorReplicaCreations: beforeRejectedCounts.authorReplicaCreations + 1,
        validationReplicaCreations: beforeRejectedCounts.validationReplicaCreations + 1,
      });
      expect(document.validate()).toEqual({ valid: true, errors: [] });
    } finally {
      writer.close();
      document.close();
    }
  });
});
