import { describe, expect, it } from 'vitest';

import { CanonicalDocument } from './canonical-model.js';
import { CanonicalWriter } from './canonical-actions.js';
import type { ActionRequest, AdmittedContext } from './canonical-actions.js';

function context(request: ActionRequest, sessionId = 'local'): AdmittedContext {
  return {
    sessionId,
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  };
}

function accept(writer: CanonicalWriter, request: ActionRequest, sessionId = 'local') {
  const result = writer.apply(request, context(request, sessionId));
  expect(result.status).toBe('pending');
  if (result.status !== 'pending') throw new Error(`expected pending action, got ${result.status}`);
  return writer.publish(result.pending);
}

function textDocument(text = 'base') {
  return CanonicalDocument.fromMarkdown(text, {
    documentId: `action-doc-${text.length}-${text.replaceAll(/[^a-z]/g, '')}`,
    actionId: `action-import-${text.length}`,
    authorityEpoch: 'action-epoch',
  });
}

describe('CanonicalWriter', () => {
  it('prepares serializable guarded commands and rejects stale drafts without live changes', () => {
    const document = textDocument('hello');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    const stale = writer.prepareCommand(
      { actionId: 'stale-command', sessionSequence: 2 },
      (draft) => {
        expect(draft.node(paragraph.sharedId).content).toBe('hello');
        draft.spliceText(paragraph.sharedId, { from: 0, to: 0, insert: 'prefix ' });
      },
    );

    expect(stale).not.toHaveProperty('callback');
    expect(stale.operations).toEqual([
      { type: 'spliceText', id: paragraph.sharedId, edit: { from: 0, to: 0, insert: 'prefix ' } },
    ]);
    expect(stale.preconditions.some((item) => item.kind === 'tape')).toBe(true);

    writer.edit({ actionId: 'accepted-command' }, (draft) => {
      draft.spliceText(paragraph.sharedId, { from: 5, to: 5, insert: '!' });
    });
    const beforeRejectedApply = document.checkpoint().update;
    const historyBefore = writer.canUndo();
    const result = writer.apply(stale, context(stale));

    expect(result).toEqual({ status: 'rejected', reason: 'stale-precondition' });
    expect(document.checkpoint().update).toEqual(beforeRejectedApply);
    expect(writer.canUndo()).toBe(historyBefore);
    expect(paragraph.content).toBe('hello!');
    writer.close();
    document.close();
  });

  it('rejects invalid plans without changing canonical state or history', () => {
    const document = textDocument('unchanged');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    const prepared = writer.prepareCommand({ actionId: 'invalid-plan' }, (draft) => {
      draft.spliceText(paragraph.sharedId, { from: 0, to: 0, insert: 'valid' });
    });
    const invalid: ActionRequest = {
      ...prepared,
      operations: [
        {
          type: 'spliceText',
          id: paragraph.sharedId,
          edit: { from: -1, to: 0, insert: 'invalid' },
        },
      ],
    };
    const before = document.checkpoint().update;

    expect(writer.apply(invalid, context(invalid))).toEqual({
      status: 'rejected',
      reason: 'invalid-operation',
    });
    expect(document.checkpoint().update).toEqual(before);
    expect(paragraph.content).toBe('unchanged');
    expect(writer.canUndo()).toBe(false);
    writer.close();
    document.close();
  });

  it('authors ordinary text as native deltas that merge across stale numeric positions', () => {
    const document = textDocument('abcd');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    const left = writer.prepareTextInput(
      paragraph.sharedId,
      { from: 2, to: 2, insert: 'X' },
      { actionId: 'left-insert', sessionId: 'left-session', historyGroupId: 'left-typing' },
    );
    const right = writer.prepareTextInput(
      paragraph.sharedId,
      { from: 2, to: 2, insert: 'Y' },
      { actionId: 'right-insert', sessionId: 'right-session', historyGroupId: 'right-typing' },
    );

    expect(left.operations).toEqual([]);
    expect(left.preconditions).toEqual([]);
    expect(left.textUpdate).toBeInstanceOf(Uint8Array);
    expect(left).not.toHaveProperty('from');
    accept(writer, left, 'left-session');
    accept(writer, right, 'right-session');

    expect(paragraph.content).toHaveLength(6);
    expect(paragraph.content).toContain('X');
    expect(paragraph.content).toContain('Y');
    expect(paragraph.content?.replace('X', '').replace('Y', '')).toBe('abcd');
    writer.close();
    document.close();
  });

  it('reserves action IDs across sessions and one active writer per document', () => {
    const document = textDocument('a');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    expect(() => new CanonicalWriter(document)).toThrow(
      'canonical document already has an active writer',
    );

    const first = writer.prepareTextInput(
      paragraph.sharedId,
      { from: 1, to: 1, insert: 'x' },
      { actionId: 'authority-unique-id', sessionId: 'session-one' },
    );
    accept(writer, first, 'session-one');
    const before = document.checkpoint().update;
    const duplicate = writer.prepareTextInput(
      paragraph.sharedId,
      { from: 1, to: 1, insert: 'y' },
      { actionId: 'authority-unique-id', sessionId: 'session-two' },
    );

    expect(writer.apply(duplicate, context(duplicate, 'session-two'))).toEqual({
      status: 'rejected',
      reason: 'duplicate-action-id',
    });
    expect(document.checkpoint().update).toEqual(before);
    expect(paragraph.content).toBe('ax');
    expect(writer.canUndo('session-two')).toBe(false);
    writer.close();
    document.close();
  });

  it('keeps accepted state unreadable until publish and emits one complete publication', () => {
    const document = textDocument('safe');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    const observed: string[] = [];
    writer.subscribe(() => observed.push(paragraph.content ?? ''));
    const request = writer.prepareCommand({ actionId: 'barrier' }, (draft) => {
      draft.spliceText(paragraph.sharedId, { from: 4, to: 4, insert: '!' });
    });
    const pendingResult = writer.apply(request, context(request));

    expect(pendingResult.status).toBe('pending');
    expect(() => paragraph.content).toThrow('unpublished commit');
    expect(writer.apply(request, context(request))).toEqual({
      status: 'rejected',
      reason: 'pending-commit',
    });
    if (pendingResult.status !== 'pending') throw new Error('missing pending result');
    const accepted = writer.publish(pendingResult.pending);

    expect(accepted.revision).toBe(1);
    expect(accepted.update.length).toBeGreaterThan(0);
    expect(paragraph.content).toBe('safe!');
    expect(observed).toEqual(['safe!']);
    writer.close();
    document.close();
  });

  it('keeps publication callback errors separate from an accepted commit', () => {
    const document = textDocument('committed');
    const writer = new CanonicalWriter(document);
    writer.subscribe(() => {
      throw new Error('observer failed');
    });
    const result = writer.edit({ actionId: 'callback-error' }, (draft) => {
      const id = document.root.children[0]!.sharedId;
      draft.spliceText(id, { from: 9, to: 9, insert: '!' });
    });

    expect(result).toHaveProperty('receipt');
    if ('receipt' in result) expect(result.callbackErrors).toHaveLength(1);
    expect(document.root.children[0]?.content).toBe('committed!');
    expect(writer.poisonedWriter).toBe(false);
    writer.close();
    document.close();
  });

  it('groups native text phases in one logical history and clears redo on new input', () => {
    const document = textDocument('a');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    const first = writer.prepareTextInput(
      paragraph.sharedId,
      { from: 1, to: 1, insert: 'b' },
      {
        actionId: 'group-first',
        historyGroupId: 'typing-1',
      },
    );
    accept(writer, first);
    const second = writer.prepareTextInput(
      paragraph.sharedId,
      { from: 2, to: 2, insert: 'c' },
      {
        actionId: 'group-second',
        historyGroupId: 'typing-1',
      },
    );
    accept(writer, second);

    expect(paragraph.content).toBe('abc');
    expect(writer.undo().status).toBe('applied');
    expect(paragraph.content).toBe('a');
    expect(writer.canRedo()).toBe(true);
    expect(writer.redo().status).toBe('applied');
    expect(paragraph.content).toBe('abc');
    expect(writer.undo().status).toBe('applied');
    expect(paragraph.content).toBe('a');
    const third = writer.prepareTextInput(
      paragraph.sharedId,
      { from: 1, to: 1, insert: 'z' },
      {
        actionId: 'new-after-undo',
        historyGroupId: 'typing-2',
      },
    );
    accept(writer, third);
    expect(writer.canRedo()).toBe(false);
    expect(paragraph.content).toBe('az');
    writer.close();
    document.close();
  });

  it('consumes an accepted no-effect boundary without undoing the older text entry', () => {
    const document = textDocument('a');
    const writer = new CanonicalWriter(document);
    const paragraph = document.root.children[0]!;
    accept(
      writer,
      writer.prepareTextInput(
        paragraph.sharedId,
        { from: 1, to: 1, insert: 'x' },
        {
          actionId: 'older-change',
          historyGroupId: 'older-group',
        },
      ),
    );
    const noop = writer.prepareTextInput(
      paragraph.sharedId,
      { from: 2, to: 2, insert: '' },
      {
        actionId: 'no-effect',
        historyGroupId: 'no-effect-group',
      },
    );
    const acceptedNoop = accept(writer, noop);

    expect(acceptedNoop.receipt.noEffect).toBe(true);
    expect(paragraph.content).toBe('ax');
    expect(writer.undo()).toMatchObject({ status: 'no-effect' });
    expect(paragraph.content).toBe('ax');
    expect(writer.undo().status).toBe('applied');
    expect(paragraph.content).toBe('a');
    writer.close();
    document.close();
  });

  it('disposes history beyond the configured logical group bound', () => {
    const document = textDocument('');
    const writer = new CanonicalWriter(document, { maxHistoryGroups: 2 });
    const paragraph = document.root.children[0]!;
    for (const [index, text] of ['a', 'b', 'c'].entries()) {
      const request = writer.prepareTextInput(
        paragraph.sharedId,
        {
          from: paragraph.content!.length,
          to: paragraph.content!.length,
          insert: text,
        },
        { actionId: `bounded-${index}`, historyGroupId: `bounded-group-${index}` },
      );
      accept(writer, request);
    }

    expect(paragraph.content).toBe('abc');
    expect(writer.undo().status).toBe('applied');
    expect(paragraph.content).toBe('ab');
    expect(writer.undo().status).toBe('applied');
    expect(paragraph.content).toBe('a');
    expect(writer.undo().status).toBe('empty');
    writer.close();
    document.close();
  });

  it('creates and activates nodes through ordered allocation and cell writes', () => {
    const document = textDocument('root');
    const writer = new CanonicalWriter(document);
    const root = document.root;
    let createdId = '';
    const result = writer.edit({ actionId: 'create-paragraph' }, (draft) => {
      createdId = draft.create({ type: 'paragraph', content: 'new text' });
      draft.place(createdId, root.sharedId, null);
    });

    expect(result).toHaveProperty('receipt');
    expect(document.root.children.map((node) => node.content)).toEqual(['root', 'new text']);
    expect(document.node(createdId).connected).toBe(true);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('transfers existing characters by span ownership and preserves an empty source lineage', () => {
    const document = CanonicalDocument.fromMarkdown('source\n\ntarget', {
      documentId: 'transfer-document',
      actionId: 'transfer-import',
      authorityEpoch: 'action-epoch',
    });
    const writer = new CanonicalWriter(document);
    const [source, destination] = document.root.children;
    if (!source || !destination) throw new Error('missing transfer nodes');
    writer.edit({ actionId: 'move-range' }, (draft) => {
      draft.transferInlineRange({
        source: source.sharedId,
        from: 0,
        to: source.content!.length,
        destination: destination.sharedId,
        at: 2,
        affinity: 'right',
      });
    });

    expect(source.content).toBe('');
    expect(destination.content).toBe('tasourcerget');
    expect(document.node(source.sharedId).connected).toBe(true);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    const markerIds = document
      .canonicalSnapshot()
      .tapes.flatMap((tape) => tape.delta.filter((part) => typeof part !== 'string'));
    writer.edit({ actionId: 'delete-across-marker-spans' }, (draft) => {
      draft.spliceText(destination.sharedId, { from: 1, to: 9, insert: '' });
    });
    expect(destination.content).toBe('tget');
    expect(
      document
        .canonicalSnapshot()
        .tapes.flatMap((tape) => tape.delta.filter((part) => typeof part !== 'string')),
    ).toEqual(markerIds);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.edit({ actionId: 'type-into-empty-line' }, (draft) => {
      draft.spliceText(source.sharedId, { from: 0, to: 0, insert: 'again ' });
    });
    expect(source.content).toBe('again ');
    expect(destination.content).toBe('tget');
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('moves same-node ranges against pre-transfer offsets and keeps boundary moves as no-ops', () => {
    for (const [from, to, at, expected] of [
      [1, 3, 5, 'adebcf'],
      [4, 6, 1, 'aefbcd'],
      [1, 3, 1, 'abcdef'],
      [1, 3, 3, 'abcdef'],
    ] as const) {
      const document = CanonicalDocument.fromMarkdown('abcdef', {
        documentId: `same-node-transfer-${from}-${to}-${at}`,
        actionId: `same-node-import-${from}-${to}-${at}`,
        authorityEpoch: 'action-epoch',
      });
      const writer = new CanonicalWriter(document);
      const paragraph = document.root.children[0]!;
      writer.edit({ actionId: 'same-node-move' }, (draft) => {
        draft.transferInlineRange({
          source: paragraph.sharedId,
          from,
          to,
          destination: paragraph.sharedId,
          at,
          affinity: 'right',
        });
      });

      expect(paragraph.content).toBe(expected);
      expect(document.validate()).toEqual({ valid: true, errors: [] });
      writer.close();
      document.close();
    }
  });
});
