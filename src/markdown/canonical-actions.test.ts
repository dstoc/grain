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
  writer.admitSession(sessionId);
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

  it('scopes action identity to document, epoch, session, and sequence', () => {
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
    expect(document.checkpoint().update).toEqual(before);
    const second = accept(writer, duplicate, 'session-two');
    expect(second.actionId).toBe('authority-unique-id');
    expect(paragraph.content).toBe('ayx');
    expect(writer.canUndo('session-two')).toBe(true);
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

  it('does not group ordinary typing across different inline nodes', () => {
    const document = textDocument('a\n\nb');
    const writer = new CanonicalWriter(document);
    const [first, second] = document.root.children;
    if (!first || !second) throw new Error('missing text nodes');
    accept(
      writer,
      writer.prepareTextInput(
        first.sharedId,
        { from: 1, to: 1, insert: 'x' },
        { actionId: 'first-node-typing', historyGroupId: 'same-group' },
      ),
    );
    accept(
      writer,
      writer.prepareTextInput(
        second.sharedId,
        { from: 1, to: 1, insert: 'y' },
        { actionId: 'second-node-typing', historyGroupId: 'same-group' },
      ),
    );

    expect(first.content).toBe('ax');
    expect(second.content).toBe('by');
    expect(writer.undo().status).toBe('applied');
    expect(first.content).toBe('ax');
    expect(second.content).toBe('b');
    expect(writer.undo().status).toBe('applied');
    expect(first.content).toBe('a');
    expect(second.content).toBe('b');
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

  it('composes edit, transfer and edit in one serializable action', () => {
    const document = CanonicalDocument.fromMarkdown('abcd\n\nXY', {
      documentId: 'composed-fragment-document',
      actionId: 'composed-fragment-import',
      authorityEpoch: 'action-epoch',
    });
    const writer = new CanonicalWriter(document);
    const [source, destination] = document.root.children;
    if (!source || !destination) throw new Error('missing fragment nodes');

    const request = writer.prepareCommand({ actionId: 'edit-transfer-edit' }, (draft) => {
      draft.spliceText(source.sharedId, { from: 2, to: 2, insert: 'NEW' });
      const fragment = draft.cutInline(source.sharedId, 1, 6);
      draft.insertFragment(destination.sharedId, 1, 'right', fragment);
      draft.spliceText(destination.sharedId, { from: 2, to: 5, insert: 'EDIT' });
      expect(() => draft.insertFragment(destination.sharedId, 1, 'right', fragment)).toThrow(
        'fragment has already been inserted',
      );
    });

    expect(request.operations.map((operation) => operation.type)).toEqual([
      'spliceText',
      'cutInline',
      'insertFragment',
      'spliceText',
    ]);
    expect(accept(writer, request).receipt.noEffect).toBe(false);
    expect(source.content).toBe('ad');
    expect(destination.content).toBe('XbEDITcY');
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    expect(writer.undo().status).toBe('applied');
    expect(source.content).toBe('abcd');
    expect(destination.content).toBe('XY');
    expect(writer.redo().status).toBe('applied');
    expect(source.content).toBe('ad');
    expect(destination.content).toBe('XbEDITcY');
    writer.close();
    document.close();
  });

  it('moves action-local text through repeated cuts without copying it into the source', () => {
    const document = CanonicalDocument.fromMarkdown('ab\n\nXY\n\nend', {
      documentId: 'new-text-fragment-document',
      actionId: 'new-text-fragment-import',
      authorityEpoch: 'action-epoch',
    });
    const writer = new CanonicalWriter(document);
    const [source, middle, destination] = document.root.children;
    if (!source || !middle || !destination) throw new Error('missing fragment nodes');

    const result = writer.edit({ actionId: 'new-text-repeated-transfer' }, (draft) => {
      draft.spliceText(source.sharedId, { from: 1, to: 1, insert: 'NEW' });
      draft.transferInlineRange({
        source: source.sharedId,
        from: 1,
        to: 4,
        destination: middle.sharedId,
        at: 1,
        affinity: 'right',
      });
      draft.transferInlineRange({
        source: middle.sharedId,
        from: 1,
        to: 4,
        destination: destination.sharedId,
        at: 1,
        affinity: 'right',
      });
    });

    expect(result).toHaveProperty('receipt');
    expect(source.content).toBe('ab');
    expect(middle.content).toBe('XY');
    expect(destination.content).toBe('eNEWnd');
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    expect(writer.undo().status).toBe('applied');
    expect(source.content).toBe('ab');
    expect(middle.content).toBe('XY');
    expect(destination.content).toBe('end');
    writer.close();
    document.close();
  });

  it.each([
    ['grow', 'LONGER'],
    ['shrink', 'Q'],
    ['delete', ''],
  ] as const)('edits a transferred action-local fragment after %s', (label, replacement) => {
    const document = CanonicalDocument.fromMarkdown('ab\n\nXY', {
      documentId: `new-fragment-edit-${label}`,
      actionId: `new-fragment-edit-import-${label}`,
      authorityEpoch: 'action-epoch',
    });
    const writer = new CanonicalWriter(document);
    const [source, destination] = document.root.children;
    if (!source || !destination) throw new Error('missing fragment nodes');

    const result = writer.edit({ actionId: `new-fragment-edit-${label}` }, (draft) => {
      draft.spliceText(source.sharedId, { from: 1, to: 1, insert: 'NEW' });
      const fragment = draft.cutInline(source.sharedId, 1, 4);
      draft.insertFragment(destination.sharedId, 1, 'right', fragment);
      draft.spliceText(destination.sharedId, { from: 1, to: 4, insert: replacement });
    });

    expect(result, JSON.stringify(result)).toHaveProperty('receipt');
    expect(source.content).toBe('ab');
    expect(destination.content).toBe(`X${replacement}Y`);
    expect(document.validate()).toEqual({ valid: true, errors: [] });

    expect(writer.undo().status).toBe('applied');
    expect(source.content).toBe('ab');
    expect(destination.content).toBe('XY');
    expect(writer.redo().status).toBe('applied');
    expect(source.content).toBe('ab');
    expect(destination.content).toBe(`X${replacement}Y`);
    expect(document.validate()).toEqual({ valid: true, errors: [] });

    const reopened = CanonicalDocument.open(document.checkpoint());
    expect(reopened.root.children.map((node) => node.content)).toEqual(['ab', `X${replacement}Y`]);
    expect(reopened.validate()).toEqual({ valid: true, errors: [] });
    reopened.close();
    writer.close();
    document.close();
  });

  it('keeps insertion seam affinity when a fragment is cut and inserted again', () => {
    const run = (affinity: 'left' | 'right') => {
      const document = CanonicalDocument.fromMarkdown('source\n\ntarget\n\nend', {
        documentId: `fragment-seam-${affinity}`,
        actionId: `fragment-seam-import-${affinity}`,
        authorityEpoch: 'action-epoch',
      });
      const writer = new CanonicalWriter(document);
      const [source, target, end] = document.root.children;
      if (!source || !target || !end) throw new Error('missing fragment seam nodes');
      const initial = document.canonicalSnapshot();
      const tapeFor = (id: string) => {
        const node = initial.nodes.find((candidate) => candidate.id === id);
        if (!node) throw new Error(`missing node ${id}`);
        return node.spans[0]!.tapeId;
      };
      const sourceTape = tapeFor(source.sharedId);
      const targetTape = tapeFor(target.sharedId);

      writer.edit({ actionId: `seed-seam-${affinity}` }, (draft) => {
        draft.transferInlineRange({
          source: source.sharedId,
          from: 0,
          to: source.content!.length,
          destination: target.sharedId,
          at: 2,
          affinity: 'right',
        });
      });
      writer.edit({ actionId: `insert-at-seam-${affinity}` }, (draft) => {
        draft.spliceText(target.sharedId, { from: 2, to: 2, insert: 'X', affinity });
      });
      writer.edit({ actionId: `move-seam-character-${affinity}` }, (draft) => {
        draft.transferInlineRange({
          source: target.sharedId,
          from: 2,
          to: 3,
          destination: end.sharedId,
          at: 0,
          affinity: 'right',
        });
      });

      const snapshot = document.canonicalSnapshot();
      const endNode = snapshot.nodes.find((candidate) => candidate.id === end.sharedId)!;
      expect(endNode.content).toBe('Xend');
      expect(document.validate()).toEqual({ valid: true, errors: [] });
      const xTape = endNode.spans[0]!.tapeId;
      writer.close();
      document.close();
      return { xTape, sourceTape, targetTape };
    };

    const left = run('left');
    const right = run('right');
    expect(left.xTape).toBe(left.targetTape);
    expect(right.xTape).toBe(right.sourceTape);
    expect(left.xTape).not.toBe(right.xTape);
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

  it('records normalized cells and replays their inverse without running normalization again', () => {
    const document = CanonicalDocument.fromParsed({
      type: 'document',
      children: [
        { type: 'paragraph', content: 'before' },
        { type: 'section', marker: '#', content: 'heading', children: [] },
        { type: 'paragraph', content: 'trailing' },
      ],
    });
    const writer = new CanonicalWriter(document);
    const [before, section, trailing] = document.root.children;
    if (!before || !section || !trailing) throw new Error('missing normalization fixture');

    const accepted = writer.edit({ actionId: 'normalize-section-boundary' }, (draft) => {
      draft.setMarker(section.sharedId, '#');
    });
    expect(accepted).toHaveProperty('receipt.structuralPatch');
    expect(document.root.children.map((node) => node.sharedId)).toEqual([
      before.sharedId,
      section.sharedId,
    ]);
    expect(section.children.map((node) => node.sharedId)).toEqual([trailing.sharedId]);
    expect(document.validate()).toEqual({ valid: true, errors: [] });

    expect(writer.undo().status).toBe('applied');
    expect(document.root.children.map((node) => node.sharedId)).toEqual([
      before.sharedId,
      section.sharedId,
      trailing.sharedId,
    ]);
    expect(section.children).toHaveLength(0);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    expect(writer.redo().status).toBe('applied');
    expect(document.root.children.map((node) => node.sharedId)).toEqual([
      before.sharedId,
      section.sharedId,
    ]);
    writer.close();
    document.close();
  });

  it('guards structural undo by resource token even after a same-value overwrite', () => {
    const document = CanonicalDocument.fromParsed({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '1. ',
              children: [{ type: 'paragraph', content: 'item' }],
            },
          ],
        },
      ],
    });
    const writer = new CanonicalWriter(document);
    const item = document.root.children[0]!.children[0]!;
    writer.edit({ actionId: 'set-marker', sessionId: 'A' }, (draft) => {
      draft.setMarker(item.sharedId, '2. ');
    });
    writer.edit({ actionId: 'marker-away', sessionId: 'B' }, (draft) => {
      draft.setMarker(item.sharedId, '3. ');
    });
    writer.edit({ actionId: 'marker-back', sessionId: 'B' }, (draft) => {
      draft.setMarker(item.sharedId, '2. ');
    });

    expect(item.marker).toBe('2. ');
    expect(writer.undo('A')).toMatchObject({ status: 'blocked', reason: 'resource-conflict' });
    expect(item.marker).toBe('2. ');
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('blocks an inverse that would create a detached cycle', () => {
    const document = CanonicalDocument.fromParsed({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
          children: [
            { type: 'paragraph', content: 'keep parent visible' },
            { type: 'section', marker: '##', content: 'moved', children: [] },
          ],
        },
        { type: 'section', marker: '#', content: 'destination', children: [] },
      ],
    });
    const writer = new CanonicalWriter(document);
    const [parent, destination] = document.root.children;
    const moved = parent?.children.find((node) => node.type === 'section');
    if (!parent || !destination || !moved) throw new Error('missing cycle fixture');
    writer.edit({ actionId: 'move-section', sessionId: 'A' }, (draft) => {
      draft.place(moved.sharedId, destination.sharedId, null);
    });
    writer.edit({ actionId: 'nest-old-parent', sessionId: 'B' }, (draft) => {
      draft.place(parent.sharedId, moved.sharedId, null);
    });
    const before = document.checkpoint().update;

    expect(writer.undo('A')).toMatchObject({ status: 'blocked', reason: 'invalid-inverse' });
    expect(document.checkpoint().update).toEqual(before);
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });

  it('keeps text typed in both sides of a full-range transfer when the transfer is undone', () => {
    const document = CanonicalDocument.fromMarkdown('source\n\ntarget', {
      documentId: 'transfer-undo-document',
      actionId: 'transfer-undo-import',
      authorityEpoch: 'action-epoch',
    });
    const writer = new CanonicalWriter(document);
    const [source, destination] = document.root.children;
    if (!source || !destination) throw new Error('missing transfer nodes');
    writer.edit({ actionId: 'full-transfer', sessionId: 'A' }, (draft) => {
      draft.transferInlineRange({
        source: source.sharedId,
        from: 0,
        to: source.content!.length,
        destination: destination.sharedId,
        at: 2,
        affinity: 'right',
      });
    });
    writer.edit({ actionId: 'type-source-residual', sessionId: 'B' }, (draft) => {
      draft.spliceText(source.sharedId, { from: 0, to: 0, insert: 'S' });
    });
    writer.edit({ actionId: 'type-transferred-span', sessionId: 'B' }, (draft) => {
      draft.spliceText(destination.sharedId, { from: 2, to: 2, insert: 'X' });
    });
    expect(source.content).toBe('S');
    expect(destination.content).toBe('taXsource rget'.replace(' ', ''));

    expect(writer.undo('A').status).toBe('applied');
    expect(source.content).toBe('SXsource');
    expect(destination.content).toBe('target');
    expect(document.validate()).toEqual({ valid: true, errors: [] });
    writer.close();
    document.close();
  });
});
