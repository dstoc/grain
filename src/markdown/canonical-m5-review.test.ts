import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CanonicalDocument, type CanonicalCheckpoint } from './canonical-model.js';
import { CanonicalWriter, type ActionRequest } from './canonical-actions.js';

function setup() {
  const document = CanonicalDocument.fromMarkdown('a', {
    documentId: 'm5-review',
    actionId: 'import',
    authorityEpoch: 'epoch',
  });
  return {
    document,
    writer: new CanonicalWriter(document),
    nodeId: document.root.children[0]!.sharedId,
  };
}

function apply(writer: CanonicalWriter, request: ActionRequest, sessionId = 'A') {
  writer.admitSession(sessionId);
  return writer.apply(request, {
    sessionId,
    sessionSequence: request.sessionSequence,
    authorityEpoch: request.authorityEpoch,
  });
}

function accept(writer: CanonicalWriter, request: ActionRequest, sessionId = 'A') {
  const result = apply(writer, request, sessionId);
  if (result.status !== 'pending') throw new Error(JSON.stringify(result));
  return writer.publish(result.pending);
}

function bufferedCheckpoint(checkpoint: CanonicalCheckpoint, kind: 'struct' | 'delete') {
  const author = new Y.Doc({ gc: false });
  const bootstrap = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(author, checkpoint.update);
    const tape = [...author.getMap<Y.Text>('tapes').values()][0]!;
    const beforeX = Y.encodeStateVector(author);
    tape.insert(2, 'x');
    const prerequisite = Y.encodeStateAsUpdate(author, beforeX);
    const afterX = Y.encodeStateVector(author);
    if (kind === 'struct') tape.insert(3, 'y');
    else tape.delete(2, 1);
    const dependent = Y.encodeStateAsUpdate(author, afterX);
    Y.applyUpdate(bootstrap, checkpoint.update);
    Y.applyUpdate(bootstrap, dependent);
    if (kind === 'struct') expect(bootstrap.store.pendingStructs).not.toBeNull();
    else expect(bootstrap.store.pendingDs).not.toBeNull();
    return {
      checkpoint: { ...checkpoint, update: Y.encodeStateAsUpdate(bootstrap) },
      prerequisite,
      dependent,
      rejectedClientId: author.clientID,
    };
  } finally {
    author.destroy();
    bootstrap.destroy();
  }
}

describe('M5 independent review boundaries', () => {
  it('opens complete checkpoints and restores them into a writable new epoch', () => {
    const { document, writer, nodeId } = setup();
    accept(
      writer,
      writer.prepareTextInput(
        nodeId,
        { from: 1, to: 1, insert: 'x' },
        {
          actionId: 'complete-checkpoint',
          sessionId: 'A',
        },
      ),
    );
    const checkpoint = document.checkpoint();
    const opened = CanonicalDocument.open(checkpoint);
    expect(opened.canonicalSnapshot()).toEqual(document.canonicalSnapshot());
    const restored = CanonicalDocument.restore(checkpoint, 'new-epoch');
    const recovered = new CanonicalWriter(restored);
    expect(recovered.undo('A').status).toBe('history-reset');
    expect(restored.acceptedRevision).toBe(0);
    accept(
      recovered,
      recovered.prepareTextInput(
        nodeId,
        { from: 2, to: 2, insert: '!' },
        {
          actionId: 'after-restoration',
          sessionId: 'A',
        },
      ),
    );
    expect(restored.node(nodeId).content).toBe('ax!');
    const reconstructed = CanonicalDocument.open(restored.checkpoint());
    expect(reconstructed.canonicalSnapshot()).toEqual(restored.canonicalSnapshot());
    reconstructed.close();
    recovered.close();
    restored.close();
    opened.close();
    writer.close();
    document.close();
  });

  it('rejects an unresolved authored update and can reauthor from accepted state with a fresh native ID', () => {
    const { document, writer, nodeId } = setup();
    const checkpoint = document.checkpoint();
    const buffered = bufferedCheckpoint(checkpoint, 'struct');
    const sourceRequest = writer.prepareTextInput(
      nodeId,
      { from: 1, to: 1, insert: 'z' },
      {
        actionId: 'rejected-dependent',
        sessionId: 'A',
      },
    );
    const rejected = apply(writer, { ...sourceRequest, textUpdate: buffered.dependent });
    expect(rejected).toEqual({ status: 'rejected', reason: 'invalid-text-update' });
    expect(document.checkpoint().update).toEqual(checkpoint.update);
    expect(writer.canUndo('A')).toBe(false);
    const branch = CanonicalDocument.open(document.checkpoint());
    const author = new CanonicalWriter(branch);
    const fresh = author.prepareTextInput(
      nodeId,
      { from: 1, to: 1, insert: 'z' },
      {
        actionId: 'fresh-reauthored',
        sessionId: 'A',
      },
    );
    const clients = Y.decodeUpdate(fresh.textUpdate!).structs.map((item) => item.id.client);
    expect(clients.length).toBeGreaterThan(0);
    expect(clients).not.toContain(buffered.rejectedClientId);
    accept(writer, fresh);
    expect(document.node(nodeId).content).toBe('az');
    expect(writer.undo('A').status).toBe('applied');
    expect(document.node(nodeId).content).toBe('a');
    author.close();
    branch.close();
    writer.close();
    document.close();
  });

  it.each(['struct', 'delete'] as const)(
    'rejects checkpoints with a buffered native %s dependency on open and restore',
    (kind) => {
      const { document, writer } = setup();
      const buffered = bufferedCheckpoint(document.checkpoint(), kind);
      expect(() => CanonicalDocument.open(buffered.checkpoint)).toThrow('unresolved');
      expect(() => CanonicalDocument.restore(buffered.checkpoint, 'new-epoch')).toThrow(
        'unresolved',
      );
      writer.close();
      document.close();
    },
  );

  it.each(['no-effect', 'changed'] as const)(
    'queues reentrant edits from %s history callbacks',
    async (kind) => {
      const { document, writer, nodeId } = setup();
      accept(
        writer,
        writer.prepareCommand({ actionId: 'history-seed', sessionId: 'A' }, (draft) => {
          if (kind === 'changed') draft.spliceText(nodeId, { from: 1, to: 1, insert: '!' });
        }),
      );
      let nested: unknown;
      let reacted = false;
      const observations: string[] = [];
      writer.subscribe((event) => {
        if (event.type === 'history' && !reacted) {
          reacted = true;
          nested = writer.edit({ actionId: 'reentrant', sessionId: 'A' }, (draft) => {
            draft.spliceText(nodeId, { from: 1, to: 1, insert: 'x' });
          });
        }
      });
      writer.subscribe((event) =>
        observations.push(`${event.type}:${document.node(nodeId).content}`),
      );
      const undo = writer.undo('A');
      expect(undo.status).toBe(kind === 'changed' ? 'applied' : 'no-effect');
      expect.soft(nested).toMatchObject({ status: 'queued' });
      expect.soft(observations).toEqual(['history:a']);
      await Promise.resolve();
      expect.soft(observations).toEqual(['history:a', 'commit:ax']);
      expect(document.node(nodeId).content).toBe('ax');
      writer.close();
      document.close();
    },
  );
});
