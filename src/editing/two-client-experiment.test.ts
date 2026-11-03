import { afterEach, expect, test } from 'vitest';

import { CanonicalDocument } from '../markdown/canonical/document.js';
import { CanonicalWriter } from '../markdown/canonical/writer.js';
import { TwoClientExperiment } from './two-client-experiment.js';

let authority: CanonicalDocument | undefined;
let writer: CanonicalWriter | undefined;
let experiment: TwoClientExperiment | undefined;

afterEach(() => {
  experiment?.close();
  writer?.close();
  authority?.close();
  experiment = undefined;
  writer = undefined;
  authority = undefined;
});

function expectNativeConvergence() {
  const authorityState = authority!.checkpoint();
  for (const client of experiment!.clients) {
    expect(client.document.canonicalSnapshot()).toEqual(authority!.canonicalSnapshot());
    expect([...client.document.checkpoint().update]).toEqual([...authorityState.update]);
  }
  expect(experiment!.clients[0].document.checkpoint().update).toEqual(
    experiment!.clients[1].document.checkpoint().update,
  );
}

function deliverAction(result: ReturnType<CanonicalWriter['edit']>) {
  if (!('update' in result)) throw new Error(`expected accepted action, got ${result.status}`);
  expect(
    experiment!.receiveAccepted(
      { revision: result.revision, update: result.update },
      result.callbackErrors,
    ),
  ).toBe(true);
  expectNativeConvergence();
}

function deliverHistory(result: ReturnType<CanonicalWriter['undo']>) {
  expect(result.status).toBe('applied');
  if (result.status !== 'applied' || result.revision === undefined || !result.update)
    throw new Error('expected an accepted history update');
  expect(
    experiment!.receiveAccepted(
      { revision: result.revision, update: result.update },
      result.callbackErrors,
    ),
  ).toBe(true);
  expectNativeConvergence();
}

test('delivers two-way text, structural history, and shared native identity', () => {
  authority = CanonicalDocument.fromMarkdown('alpha');
  writer = new CanonicalWriter(authority);
  experiment = new TwoClientExperiment(authority);

  expect(experiment.clients[0].document).not.toBe(experiment.clients[1].document);
  expectNativeConvergence();

  const paragraph = authority.root.children[0]!;
  deliverAction(
    writer.edit({ actionId: 'client-a-text', sessionId: 'client-a' }, (draft) => {
      draft.spliceText(paragraph.sharedId, { from: 5, to: 5, insert: ' A' });
    }),
  );
  deliverAction(
    writer.edit({ actionId: 'client-b-text', sessionId: 'client-b' }, (draft) => {
      draft.spliceText(paragraph.sharedId, { from: 0, to: 0, insert: 'B ' });
    }),
  );

  let createdId = '';
  deliverAction(
    writer.edit({ actionId: 'client-a-structure', sessionId: 'client-a' }, (draft) => {
      createdId = draft.create({ type: 'paragraph', content: 'new block' });
      draft.place(createdId, authority!.root.sharedId, null);
    }),
  );
  deliverHistory(writer.undo('client-a'));
  expect(authority.root.children).toHaveLength(1);
  deliverHistory(writer.redo('client-a'));
  expect(authority.root.children).toHaveLength(2);

  const created = authority.node(createdId);
  deliverAction(
    writer.edit({ actionId: 'client-b-created-text', sessionId: 'client-b' }, (draft) => {
      draft.spliceText(createdId, {
        from: created.content!.length,
        to: created.content!.length,
        insert: ' B',
      });
    }),
  );
  deliverHistory(writer.undo('client-b'));
  deliverHistory(writer.redo('client-b'));

  expect(experiment.state).toEqual({ status: 'ready', revision: authority.acceptedRevision });
});

test('does not advance replicas for an authority rejection', () => {
  authority = CanonicalDocument.fromMarkdown('authority');
  writer = new CanonicalWriter(authority);
  experiment = new TwoClientExperiment(authority);
  const other = CanonicalDocument.fromMarkdown('other');
  const otherWriter = new CanonicalWriter(other);
  otherWriter.admitSession('client-a');
  const request = otherWriter.prepareTextInput(
    other.root.children[0]!.sharedId,
    { from: 5, to: 5, insert: '!' },
    { actionId: 'foreign-action', sessionId: 'client-a' },
  );
  const result = writer.apply(request, {
    sessionId: 'client-a',
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  });

  expect(result).toEqual({ status: 'rejected', reason: 'wrong-document' });
  expectNativeConvergence();
  expect(experiment.state).toEqual({ status: 'ready', revision: 0 });
  otherWriter.close();
  other.close();
});

test('stops after a revision gap and does not claim synchronization', () => {
  authority = CanonicalDocument.fromMarkdown('alpha');
  writer = new CanonicalWriter(authority);
  experiment = new TwoClientExperiment(authority);
  const paragraph = authority.root.children[0]!;
  const result = writer.edit({ actionId: 'gap-source', sessionId: 'client-a' }, (draft) => {
    draft.spliceText(paragraph.sharedId, { from: 5, to: 5, insert: '!' });
  });
  if (!('update' in result)) throw new Error('expected accepted authority update');

  expect(experiment.receiveAccepted({ revision: result.revision + 1, update: result.update })).toBe(
    false,
  );
  expect(experiment.state.status).toBe('failed');
  expect(experiment.state.error).toContain('Expected accepted revision');
  expect(experiment.clients.map(({ document }) => document.acceptedRevision)).toEqual([0, 0]);
  expect(experiment.receiveAccepted({ revision: result.revision, update: result.update })).toBe(
    false,
  );
});

test('stops on malformed delivery and surfaces authority projection callback errors', () => {
  authority = CanonicalDocument.fromMarkdown('alpha');
  writer = new CanonicalWriter(authority);
  experiment = new TwoClientExperiment(authority);
  const paragraph = authority.root.children[0]!;
  const result = writer.edit({ actionId: 'bad-payload-source', sessionId: 'client-a' }, (draft) => {
    draft.spliceText(paragraph.sharedId, { from: 5, to: 5, insert: '!' });
  });
  if (!('update' in result)) throw new Error('expected accepted authority update');

  expect(
    experiment.receiveAccepted({ revision: result.revision, update: new Uint8Array([0]) }),
  ).toBe(false);
  expect(experiment.state.status).toBe('failed');
  expect(experiment.clients.map(({ document }) => document.acceptedRevision)).toEqual([0, 0]);

  const otherAuthority = CanonicalDocument.fromMarkdown('beta');
  const otherWriter = new CanonicalWriter(otherAuthority);
  const otherExperiment = new TwoClientExperiment(otherAuthority);
  const otherParagraph = otherAuthority.root.children[0]!;
  const accepted = otherWriter.edit({ actionId: 'callback-error-source' }, (draft) => {
    draft.spliceText(otherParagraph.sharedId, { from: 4, to: 4, insert: '!' });
  });
  if (!('update' in accepted)) throw new Error('expected accepted authority update');
  expect(
    otherExperiment.receiveAccepted({ revision: accepted.revision, update: accepted.update }, [
      new Error('injected projection failure'),
    ]),
  ).toBe(false);
  expect(otherExperiment.state.error).toContain('injected projection failure');
  expect(otherExperiment.clients.map(({ document }) => document.acceptedRevision)).toEqual([0, 0]);
  otherExperiment.close();
  otherWriter.close();
  otherAuthority.close();
});
