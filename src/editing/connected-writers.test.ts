import { afterEach, expect, test } from 'vitest';

import { CanonicalDocument } from '../markdown/canonical/document.js';
import { CanonicalWriter } from '../markdown/canonical/writer.js';
import type { ActionRequest } from '../markdown/canonical/action-types.js';
import { TwoClientExperiment } from './two-client-experiment.js';

let authority: CanonicalDocument | undefined;
let authorityWriter: CanonicalWriter | undefined;
let experiment: TwoClientExperiment | undefined;

afterEach(() => {
  experiment?.close();
  authorityWriter?.close();
  authority?.close();
  experiment = undefined;
  authorityWriter = undefined;
  authority = undefined;
});

function setup(markdown: string) {
  authority = CanonicalDocument.fromMarkdown(markdown);
  authorityWriter = new CanonicalWriter(authority);
  experiment = new TwoClientExperiment(authority, undefined, authorityWriter);
  return {
    authority,
    authorityWriter,
    experiment,
    submit(index: 0 | 1, request: ActionRequest) {
      const client = experiment!.clients[index]!;
      const writer = client.writer!;
      const transport = experiment!.sessionTransport(client.sessionId)!;
      writer.trackPreparedAction(request);
      const context = {
        sessionId: client.sessionId,
        authorityEpoch: request.authorityEpoch,
        sessionSequence: request.sessionSequence,
      };
      const result = transport.apply(writer, request, context);
      if (result.status === 'pending') return transport.publish(writer, request, result.pending);
      if (result.status === 'rejected') writer.releasePreparedAction(request);
      return result;
    },
    expectConvergence() {
      const checkpoint = authority!.checkpoint();
      for (const client of experiment!.clients) {
        expect(client.document.validate()).toEqual({ valid: true, errors: [] });
        expect(client.document.acceptedRevision).toBe(authority!.acceptedRevision);
        expect(client.document.canonicalSnapshot()).toEqual(authority!.canonicalSnapshot());
        expect(client.document.checkpoint().update).toEqual(checkpoint.update);
      }
    },
  };
}

test('separate pane writers submit text and structure through authority history with identical Yjs state', () => {
  const f = setup('alpha\n\nbeta');
  try {
    const [clientA, clientB] = f.experiment.clients;
    expect(clientA.writer).toBeDefined();
    expect(clientB.writer).toBeDefined();
    expect(clientA.writer).not.toBe(clientB.writer);

    const alphaA = clientA.document.root.children[0]!;
    const paneBeforePrepare = clientA.document.checkpoint().update;
    const first = clientA.writer!.prepareTextInput(
      alphaA.sharedId,
      { from: 5, to: 5, insert: '!' },
      { actionId: 'a-text-1', sessionId: clientA.sessionId },
    );
    expect(clientA.document.checkpoint().update).toEqual(paneBeforePrepare);
    f.submit(0, first);
    const second = clientA.writer!.prepareTextInput(
      alphaA.sharedId,
      { from: 6, to: 6, insert: '?' },
      { actionId: 'a-text-2', sessionId: clientA.sessionId },
    );
    f.submit(0, second);
    f.expectConvergence();

    const rootB = clientB.document.root;
    let tailId = '';
    const createTail = clientB.writer!.prepareCommand(
      { actionId: 'b-create', sessionId: clientB.sessionId },
      (draft) => {
        tailId = draft.create({ type: 'paragraph', content: 'tail' });
        draft.place(tailId, rootB.sharedId, null);
      },
    );
    f.submit(1, createTail);
    const tail = clientB.document.node(tailId)!;
    const tailInput = clientB.writer!.prepareTextInput(
      tailId,
      { from: tail.content!.length, to: tail.content!.length, insert: '!' },
      { actionId: 'b-tail-text', sessionId: clientB.sessionId },
    );
    f.submit(1, tailInput);
    f.expectConvergence();

    const transportB = f.experiment.sessionTransport(clientB.sessionId)!;
    expect(transportB.canUndo(clientB.sessionId)).toBe(true);
    expect(clientB.writer!.canUndo(clientB.sessionId)).toBe(false);
    expect(transportB.undo(clientB.sessionId).status).toBe('applied');
    expect(transportB.undo(clientB.sessionId).status).toBe('applied');
    f.expectConvergence();
    expect(clientB.document.root.children.map((node) => node.content)).toEqual(['alpha!?', 'beta']);
    expect(transportB.redo(clientB.sessionId).status).toBe('applied');
    expect(transportB.redo(clientB.sessionId).status).toBe('applied');
    f.expectConvergence();
    expect(authority!.root.children.map((node) => node.content)).toEqual([
      'alpha!?',
      'beta',
      'tail!',
    ]);

    const transportA = f.experiment.sessionTransport(clientA.sessionId)!;
    expect(transportA.undo(clientA.sessionId).status).toBe('applied');
    expect(transportA.undo(clientA.sessionId).status).toBe('applied');
    f.expectConvergence();
    expect(transportA.redo(clientA.sessionId).status).toBe('applied');
    expect(transportA.redo(clientA.sessionId).status).toBe('applied');
    f.expectConvergence();
  } finally {
    f.experiment.close();
  }
});

test('only tracked command requests block the next action while inspection preparation stays free', () => {
  const f = setup('alpha');
  try {
    const client = f.experiment.clients[0]!;
    const writer = client.writer!;
    const inspectedOne = writer.prepareCommand(
      { actionId: 'inspect-one', sessionId: client.sessionId },
      () => {},
    );
    const inspectedTwo = writer.prepareCommand(
      { actionId: 'inspect-two', sessionId: client.sessionId },
      () => {},
    );
    expect(inspectedOne.operations).toEqual([]);
    expect(inspectedTwo.operations).toEqual([]);

    const node = client.document.root.children[0]!;
    const tracked = writer.prepareCommand(
      { actionId: 'tracked-command', sessionId: client.sessionId },
      (draft) => draft.spliceText(node.sharedId, { from: 5, to: 5, insert: '!' }),
    );
    writer.trackPreparedAction(tracked);
    expect(() =>
      writer.prepareCommand(
        { actionId: 'overlapping-command', sessionId: client.sessionId },
        () => {},
      ),
    ).toThrow('already has an outstanding action');
    expect(writer.releasePreparedAction(tracked)).toBe(true);
    expect(
      writer.prepareCommand({ actionId: 'after-release', sessionId: client.sessionId }, () => {}),
    ).toBeDefined();
  } finally {
    f.experiment.close();
  }
});

test('prepared acknowledgement requires the matching response after revision delivery', () => {
  const f = setup('alpha');
  try {
    const client = f.experiment.clients[0]!;
    const writer = client.writer!;
    const transport = f.experiment.sessionTransport(client.sessionId)!;
    const node = client.document.root.children[0]!;
    const request = writer.prepareTextInput(
      node.sharedId,
      { from: 5, to: 5, insert: '!' },
      { actionId: 'ack-required', sessionId: client.sessionId },
    );
    writer.trackPreparedAction(request);
    const result = transport.apply(writer, request, {
      sessionId: client.sessionId,
      authorityEpoch: request.authorityEpoch,
      sessionSequence: request.sessionSequence,
    });
    if (result.status !== 'pending')
      throw new Error(`expected pending action, got ${result.status}`);
    const accepted = f.authorityWriter.publish(result.pending);

    expect(() => writer.acknowledgePreparedAction(request, accepted)).toThrow(
      'accepted document revision has not arrived',
    );
    expect(f.experiment.receiveAccepted(accepted, accepted.callbackErrors)).toBe(true);
    expect(() =>
      writer.acknowledgePreparedAction(request, { ...accepted, actionId: 'wrong-action' }),
    ).toThrow('does not match the prepared action');
    expect(() =>
      writer.prepareTextInput(
        node.sharedId,
        { from: 5, to: 5, insert: '?' },
        { actionId: 'too-early', sessionId: client.sessionId },
      ),
    ).toThrow('already has an outstanding action');

    writer.acknowledgePreparedAction(request, accepted);
    f.expectConvergence();
  } finally {
    f.experiment.close();
  }
});

test('stale command rejection releases the pane action without advancing its sequence', () => {
  const f = setup('- [x] task');
  try {
    const [clientA, clientB] = f.experiment.clients;
    const itemA = clientA.document.root.children[0]!.children![0]!;
    const itemB = clientB.document.root.children[0]!.children[0]!;
    const stale = clientA.writer!.prepareCommand(
      { actionId: 'a-stale-command', sessionId: clientA.sessionId },
      (draft) => draft.setChecked(itemA.sharedId, false),
    );

    const peerChange = clientB.writer!.prepareCommand(
      { actionId: 'b-check-task', sessionId: clientB.sessionId },
      (draft) => draft.setChecked(itemB.sharedId, false),
    );
    f.submit(1, peerChange);
    const beforeRejection = authority!.checkpoint().update;

    const writerA = clientA.writer!;
    const transportA = f.experiment.sessionTransport(clientA.sessionId)!;
    writerA.trackPreparedAction(stale);
    const rejected = transportA.apply(writerA, stale, {
      sessionId: clientA.sessionId,
      authorityEpoch: stale.authorityEpoch,
      sessionSequence: stale.sessionSequence,
    });
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'stale-precondition' });
    if (rejected.status === 'rejected') writerA.releasePreparedAction(stale);
    expect(authority!.checkpoint().update).toEqual(beforeRejection);

    const paragraph = clientA.document.root.children[0]!.children![0]!.children![0]!;
    const retry = writerA.prepareTextInput(
      paragraph.sharedId,
      { from: 4, to: 4, insert: '!' },
      { actionId: 'a-after-rejection', sessionId: clientA.sessionId },
    );
    expect(retry.sessionSequence).toBe(stale.sessionSequence);
    f.submit(0, retry);
    f.expectConvergence();
    expect(authority!.root.children[0]!.children![0]!.children![0]!.content).toBe('task!');
  } finally {
    f.experiment.close();
  }
});
