import * as Y from 'yjs';
import { computed, effect } from '@preact/signals-core';
import { describe, expect, it } from 'vitest';
import { CanonicalDocument } from './canonical-model.js';
import { CanonicalWriter, type ActionRequest } from './canonical-actions.js';

function setup(source = 'a') {
  const doc = CanonicalDocument.fromMarkdown(source, {
    documentId: 'review-doc',
    actionId: 'import',
    authorityEpoch: 'epoch',
  });
  const writer = new CanonicalWriter(doc);
  return { doc, writer, node: doc.root.children[0]! };
}
function accept(writer: CanonicalWriter, request: ActionRequest, sessionId = 'local') {
  writer.admitSession(sessionId);
  const result = writer.apply(request, {
    sessionId,
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  });
  expect(result.status).toBe('pending');
  if (result.status !== 'pending') throw new Error(JSON.stringify(result));
  return writer.publish(result.pending);
}
describe('M2 review probes', () => {
  it('does not expose the unpublished accepted revision or connected state', () => {
    const { doc, writer, node } = setup();
    const request = writer.prepareCommand({ actionId: 'detach' }, (d) => d.detach(node.sharedId));
    const result = writer.apply(request, {
      sessionId: 'local',
      authorityEpoch: 'epoch',
      sessionSequence: 1,
    });
    expect(result.status).toBe('pending');
    expect.soft(() => doc.acceptedRevision).toThrow('unpublished commit');
    expect.soft(() => node.connected).toThrow('unpublished commit');
    if (result.status === 'pending') writer.publish(result.pending);
    writer.close();
    doc.close();
  });

  it('reports projection signal callback errors without losing the accepted outcome', () => {
    const { doc, writer, node } = setup();
    const dispose = effect(() => {
      if (node.renderSignal.value > 0) throw new Error('projection observer failed');
    });
    let result: unknown;
    expect
      .soft(() => {
        result = writer.edit({ actionId: 'signal-error' }, (d) => {
          d.spliceText(node.sharedId, { from: 1, to: 1, insert: 'x' });
        });
      })
      .not.toThrow();
    expect.soft(result).toHaveProperty('receipt');
    expect.soft((result as { callbackErrors?: readonly unknown[] }).callbackErrors).toHaveLength(1);
    expect(node.content).toBe('ax');
    dispose();
    const next = writer.prepareCommand({ actionId: 'after-signal-error' }, () => {});
    const applied = writer.apply(next, {
      sessionId: 'local',
      authorityEpoch: 'epoch',
      sessionSequence: next.sessionSequence,
    });
    expect.soft(applied.status).toBe('pending');
    if (applied.status === 'pending') writer.publish(applied.pending);
    writer.close();
    doc.close();
  });

  it('publishes one coherent signal notification for a multi-node action', () => {
    const { doc, writer } = setup('a\n\nb');
    const [a, b] = doc.root.children;
    const observed: string[] = [];
    const aText = computed(() => {
      a!.renderSignal.value;
      return a!.content;
    });
    const bText = computed(() => {
      b!.renderSignal.value;
      return b!.content;
    });
    const dispose = effect(() => {
      observed.push(`${aText.value}/${bText.value}`);
    });
    writer.edit({ actionId: 'both' }, (d) => {
      d.spliceText(a!.sharedId, { from: 1, to: 1, insert: 'x' });
      d.spliceText(b!.sharedId, { from: 1, to: 1, insert: 'y' });
    });
    expect.soft(observed).toEqual(['a/b', 'ax/by']);
    dispose();
    writer.close();
    doc.close();
  });

  it('rejects unresolved native dependencies before accepting or capturing them', () => {
    const { doc, writer, node } = setup();
    const branch = new Y.Doc({ gc: false });
    Y.applyUpdate(branch, doc.checkpoint().update);
    const tape = [...branch.getMap<Y.Text>('tapes').values()][0]!;
    tape.insert(2, 'x');
    const afterX = Y.encodeStateVector(branch);
    tape.insert(3, 'y');
    // This trusted-engine-shaped delta depends on x, which the authority lacks.
    const missingDependencyDelta = Y.encodeStateAsUpdate(branch, afterX);
    const base = writer.prepareTextInput(
      node.sharedId,
      { from: 1, to: 1, insert: 'z' },
      {
        actionId: 'missing-dependency',
        sessionId: 'remote',
      },
    );
    const before = doc.checkpoint().update;
    writer.admitSession('remote');
    const result = writer.apply(
      { ...base, textUpdate: missingDependencyDelta },
      {
        sessionId: 'remote',
        authorityEpoch: 'epoch',
        sessionSequence: 1,
      },
    );
    expect.soft(result).toEqual({ status: 'rejected', reason: 'invalid-text-update' });
    if (result.status === 'pending') writer.publish(result.pending);
    expect.soft(doc.checkpoint().update).toEqual(before);
    expect.soft(writer.canUndo('remote')).toBe(false);
    branch.destroy();
    writer.close();
    doc.close();
  });

  it('rejects accepted envelopes with unresolved native dependencies', () => {
    const doc = CanonicalDocument.fromMarkdown('a', {
      documentId: 'accepted-dependency-doc',
      actionId: 'import',
      authorityEpoch: 'epoch',
    });
    const branch = new Y.Doc({ gc: false });
    Y.applyUpdate(branch, doc.checkpoint().update);
    const tape = [...branch.getMap<Y.Text>('tapes').values()][0]!;
    tape.insert(2, 'x');
    const afterX = Y.encodeStateVector(branch);
    tape.insert(3, 'y');
    branch.getMap('meta').set('acceptedRevision', 1);
    const incompleteAcceptedUpdate = Y.encodeStateAsUpdate(branch, afterX);

    expect(() => doc.applyAccepted({ revision: 1, update: incompleteAcceptedUpdate })).toThrow(
      'unresolved native dependencies',
    );
    expect(doc.acceptedRevision).toBe(0);
    expect(doc.root.children[0]!.content).toBe('a');
    branch.destroy();
    doc.close();
  });

  it('keeps a genuinely superseded native entry above an older changing entry isolated', () => {
    const { doc, writer, node } = setup();
    accept(
      writer,
      writer.prepareTextInput(
        node.sharedId,
        { from: 1, to: 1, insert: 'o' },
        {
          actionId: 'older',
          sessionId: 'A',
          historyGroupId: 'older',
        },
      ),
      'A',
    );
    accept(
      writer,
      writer.prepareTextInput(
        node.sharedId,
        { from: 2, to: 2, insert: 'x' },
        {
          actionId: 'newer',
          sessionId: 'A',
          historyGroupId: 'newer',
        },
      ),
      'A',
    );
    accept(
      writer,
      writer.prepareTextInput(
        node.sharedId,
        { from: 2, to: 3, insert: '' },
        {
          actionId: 'supersede',
          sessionId: 'B',
        },
      ),
      'B',
    );
    expect(writer.undo('A').status).toBe('no-effect');
    expect(node.content).toBe('ao');
    expect(writer.undo('A').status).toBe('applied');
    expect(node.content).toBe('a');
    writer.close();
    doc.close();
  });

  it('keeps source-piece draft output equal to accepted output after multiple splices', () => {
    const edits = [
      [
        { from: 1, to: 1, insert: 'XY' },
        { from: 2, to: 2, insert: 'z' },
      ],
      [
        { from: 0, to: 2, insert: '' },
        { from: 0, to: 0, insert: 'x' },
      ],
      [
        { from: 1, to: 2, insert: 'X' },
        { from: 2, to: 3, insert: 'Y' },
      ],
      [
        { from: 0, to: 0, insert: 'X' },
        { from: 0, to: 2, insert: 'Y' },
      ],
    ];
    for (const [i, sequence] of edits.entries()) {
      const { doc, writer, node } = setup('abcd');
      let expected: string | undefined;
      const result = writer.edit({ actionId: `multi-${i}` }, (d) => {
        for (const edit of sequence) d.spliceText(node.sharedId, edit);
        expected = d.node(node.sharedId).content;
      });
      expect(result).toHaveProperty('receipt');
      expect.soft(node.content, `sequence ${i}`).toBe(expected);
      writer.close();
      doc.close();
    }
  });

  it('undoes and redoes same-anchor splices in draft order', () => {
    const { doc, writer, node } = setup('abcd');
    const result = writer.edit({ actionId: 'multi-splice-history' }, (draft) => {
      draft.spliceText(node.sharedId, { from: 1, to: 2, insert: 'X' });
      draft.spliceText(node.sharedId, { from: 2, to: 3, insert: 'Y' });
    });
    expect(result).toHaveProperty('receipt');
    expect(node.content).toBe('aXYd');
    expect(writer.undo().status).toBe('applied');
    expect(node.content).toBe('abcd');
    expect(writer.redo().status).toBe('applied');
    expect(node.content).toBe('aXYd');
    writer.close();
    doc.close();
  });

  it('seals a logical text group explicitly before typing in another node', () => {
    const { doc, writer } = setup('a\n\nb');
    const [a, b] = doc.root.children;
    accept(
      writer,
      writer.prepareTextInput(
        a!.sharedId,
        { from: 1, to: 1, insert: 'x' },
        {
          actionId: 'first-node',
          historyGroupId: 'typing',
        },
      ),
    );
    writer.sealTextGroup();
    accept(
      writer,
      writer.prepareTextInput(
        b!.sharedId,
        { from: 1, to: 1, insert: 'y' },
        {
          actionId: 'second-node',
          historyGroupId: 'typing',
        },
      ),
    );
    expect(writer.undo().status).toBe('applied');
    expect.soft(a!.content).toBe('ax');
    expect.soft(b!.content).toBe('b');
    writer.close();
    doc.close();
  });

  it('reports history projection observer errors without poisoning accepted replay', () => {
    const { doc, writer, node } = setup();
    accept(
      writer,
      writer.prepareTextInput(
        node.sharedId,
        { from: 1, to: 1, insert: 'x' },
        {
          actionId: 'before-undo-signal-error',
        },
      ),
    );
    const signalBefore = node.renderSignal.value;
    const dispose = effect(() => {
      if (node.renderSignal.value > signalBefore) throw new Error('undo observer failed');
    });
    expect.soft(() => writer.undo()).not.toThrow();
    expect.soft(writer.poisonedWriter).toBe(false);
    dispose();
    writer.close();
    doc.close();
  });

  it('exposes a pending durability boundary for text undo before notifying observers', () => {
    const { doc, writer, node } = setup();
    accept(
      writer,
      writer.prepareTextInput(
        node.sharedId,
        { from: 1, to: 1, insert: 'x' },
        {
          actionId: 'before-durable-undo',
        },
      ),
    );
    const next = writer.prepareCommand({ actionId: 'after-durable-undo' }, () => {});
    let publications = 0;
    writer.subscribe(() => publications++);
    const undo = writer.prepareUndo();
    expect.soft(undo.status).toBe('pending');
    if (undo.status !== 'pending') throw new Error('history update was not staged');
    expect.soft(publications).toBe(0);
    // A host has not received/persisted the update yet.
    expect.soft(() => node.content).toThrow('unpublished commit');
    expect
      .soft(
        writer.apply(next, {
          sessionId: 'local',
          authorityEpoch: 'epoch',
          sessionSequence: next.sessionSequence,
        }),
      )
      .toEqual({ status: 'rejected', reason: 'pending-commit' });
    const published = writer.publishHistory(undo.pending);
    expect(published.status).toBe('applied');
    expect(publications).toBe(1);
    expect(node.content).toBe('a');
    writer.close();
    doc.close();
  });
});
