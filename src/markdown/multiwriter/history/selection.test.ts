import { expect, test, vi } from 'vitest';
import {
  insertText,
  insertParagraph,
  joinWithPrevious,
  deleteBlocks,
  indent,
  outdent,
} from '../authoring/index.js';
import { replica, selection, type } from '../../../../test/multiwriter/history.js';
import type { Affinity } from '../contracts.js';
import { capturePoint, resolveSelection } from './selection.js';
import type { StableSelection } from './selection.js';
import { compareBytes } from '../actions/cbor.js';
import { resourceKey } from '../layout/index.js';
import { resolveAddress } from '../projection/addresses.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';

function publication(p: CommandReplica) {
  return p.document.publication.status().publication!;
}
function capture(
  p: CommandReplica,
  index: number,
  at: number,
  affinity: Affinity = 'right',
  host = p.view().root,
): StableSelection {
  const point = capturePoint(publication(p), p.nodes()[index], at, affinity, host);
  return { anchor: point, focus: point };
}
function resolved(p: CommandReplica, saved: StableSelection) {
  const bytes = p.document.store.encodeUpdate(),
    native = publication(p).native.encodeState();
  const result = resolveSelection(publication(p), saved);
  expect(compareBytes(p.document.store.encodeUpdate(), bytes)).toBe(0);
  expect(compareBytes(publication(p).native.encodeState(), native)).toBe(0);
  if (result.state !== 'exact' && result.state !== 'fallback')
    throw new Error(`No caret: ${result.state}`);
  return result;
}
for (const at of [0, 1, 3, 4])
  test(`caller affinities straddle concurrent insertion at scalar-safe offset ${at}, including cold replay`, () => {
    const a = replica('a😀b'),
      b = replica('', a.genesis);
    const left = capture(a, 0, at, 'left'),
      right = capture(a, 0, at, 'right');
    expect(left.anchor.gap).toEqual(right.anchor.gap);
    type(b, 'Ω', at);
    a.receive(b.document.store.encodeUpdate());
    const cold = replica('', a.genesis, a.document.store.encodeUpdate());
    for (const p of [a, cold]) {
      expect(resolved(p, left)).toMatchObject({
        state: 'exact',
        focus: { offset: at, affinity: 'left' },
      });
      expect(resolved(p, right)).toMatchObject({
        state: 'exact',
        focus: { offset: at + 1, affinity: 'right' },
      });
    }
  });
for (const hidden of ['left', 'right', 'both'])
  test(`hidden ${hidden} gap neighbors retain a visible scalar boundary`, () => {
    const a = replica('abcd'),
      left = capture(a, 0, 2, 'left'),
      right = capture(a, 0, 2, 'right');
    a.editor.session('peer').edit(insertText, {
      nodeId: a.handle(a.nodes()[0]),
      from: hidden === 'right' ? 2 : 1,
      to: hidden === 'left' ? 2 : 3,
      text: '',
    });
    expect(resolved(a, left).focus.offset).toBe(hidden === 'right' ? 2 : 1);
    expect(resolved(a, right).focus.offset).toBe(hidden === 'right' ? 2 : 1);
  });

test('empty cells distinguish both affinities around peer typing', () => {
  const a = replica(''),
    b = replica('', a.genesis);
  const left = capture(a, 0, 0, 'left'),
    right = capture(a, 0, 0, 'right');
  type(b, '😀', 0);
  a.receive(b.document.store.encodeUpdate());
  expect(resolved(a, left).focus.offset).toBe(0);
  expect(resolved(a, right).focus.offset).toBe(2);
});

test('split/transfer seams choose the surviving affinity side and preserve original scalar identities', () => {
  const a = replica('a😀b'),
    left = capture(a, 0, 3, 'left'),
    right = capture(a, 0, 3, 'right');
  a.editor.session().edit(insertParagraph, { nodeId: a.handle(a.nodes()[0]), from: 3 });
  expect(resolved(a, left).focus).toMatchObject({ origin: a.nodes()[0].origin, offset: 3 });
  expect(resolved(a, right).focus).toMatchObject({ origin: a.nodes()[1].origin, offset: 0 });
  a.editor.session().undo();
  a.editor.session().edit(
    ({ draft }, [source, destination]) => {
      draft.transferInlineRange({ source, from: 1, to: 3, destination, at: 1, affinity: 'right' });
      return { status: 'handled' };
    },
    (() => {
      // Create a second independent tape, then transfer the emoji into it.
      a.editor.session('setup').edit(({ draft, scopeRoot }) => {
        const id = draft.create({ type: 'paragraph', content: 'XY' });
        draft.place(id, scopeRoot, null);
        return { status: 'handled' };
      }, undefined);
      return [a.handle(a.nodes()[0]), a.handle(a.nodes()[1])];
    })(),
  );
  expect(resolved(a, left).focus).toMatchObject({ origin: a.nodes()[1].origin, offset: 3 });
  expect(resolved(a, right).focus).toMatchObject({ origin: a.nodes()[0].origin, offset: 1 });
});

test('cross-tape join maps a saved point through the effective flow ancestry', () => {
  const a = replica('first\n\nsecond'),
    saved = capture(a, 1, 3);
  a.editor.session().edit(joinWithPrevious, { nodeId: a.handle(a.nodes()[1]) });
  expect(resolved(a, saved).focus).toMatchObject({ origin: a.nodes()[0].origin, offset: 8 });
  a.editor.session().undo();
  expect(resolved(a, saved).focus.offset).toBe(3);
});

test('masked syntax maps saved gaps without restoring hidden characters', () => {
  const a = replica('#title'),
    saved = capture(a, 0, 1, 'left');
  type(a, ' ', 1, { promote: a.handle(a.nodes()[0]) });
  expect(a.markdown()).toBe('# title\n');
  expect(resolved(a, saved).focus.offset).toBe(0);
});

for (const point of ['success', 'observer', 'refresh'])
  test(`command focus preserves its caller affinity through ${point} and remote edge typing`, () => {
    const a = replica('abcd'),
      h = a.editor.session();
    let restore = () => {};
    if (point !== 'success') {
      const append = a.document.store.append.bind(a.document.store);
      const spy =
        point === 'observer'
          ? vi.spyOn(a.document.store, 'append').mockImplementationOnce((e) => {
              append(e);
              throw new Error('observer');
            })
          : vi.spyOn(a.document.publication, 'refresh').mockImplementationOnce(() => {
              throw new Error('refresh');
            });
      restore = () => spy.mockRestore();
    }
    const edit = () =>
      h.edit(
        ({ draft }, id) => {
          draft.spliceText(id, { from: 2, to: 2, insert: '!' });
          return { status: 'handled', focus: draft.bookmark(id, 5, 'left') };
        },
        a.handle(a.nodes()[0]),
        { selectionBefore: selection(a, 0, 0, 0, 'left') },
      );
    if (point === 'success') edit();
    else {
      expect(edit).toThrow();
      restore();
      a.editor.refresh();
    }
    // Recovery must finish the after-selection before navigating. No command replay.
    h.undo();
    h.redo();
    const saved = h.groups().undo[0].selectionAfter!;
    expect(saved.focus.affinity).toBe('left');
    type(a, 'peer', 5, {}, 'peer');
    expect(resolved(a, saved).focus.offset).toBe(5);
  });

for (const deletedIndex of [0, 1, 2])
  test(`deleted focus ${deletedIndex} uses nearest current visible inline, preferring predecessor ties`, () => {
    const a = replica('first\n\nsecond\n\nthird'),
      b = replica('', a.genesis);
    const saved = capture(a, deletedIndex, 2);
    b.editor.session().edit(deleteBlocks, { nodeIds: [b.handle(b.nodes()[deletedIndex])] });
    a.receive(b.document.store.encodeUpdate());
    const result = resolved(a, saved);
    expect(result.state).toBe('fallback');
    expect(result.focus).toMatchObject(
      deletedIndex === 0
        ? { origin: a.nodes()[0].origin, offset: 0, affinity: 'right' }
        : {
            origin: a.nodes()[deletedIndex - 1].origin,
            offset: a.nodes()[deletedIndex - 1].content.length,
            affinity: 'left',
          },
    );
    expect(
      resolveAddress(
        saved.focus.address,
        publication(a).value.ownership,
        publication(a).value.visibility,
      ).state,
    ).toBe('unavailable');
  });

test('no-effect managed undo returns fallback after a real peer block deletion', () => {
  const a = replica('first\n\nsecond'),
    b = replica('', a.genesis),
    h = a.editor.session();
  type(a, '!', 1);
  b.receive(a.document.store.encodeUpdate());
  b.editor.session().edit(deleteBlocks, { nodeIds: [b.handle(b.nodes()[0])] });
  a.receive(b.document.store.encodeUpdate());
  const before = a.markdown(),
    result = h.undo();
  expect(result).toMatchObject({
    state: 'applied',
    restoration: {
      state: 'fallback',
      focus: { origin: a.nodes()[0].origin, offset: 0, affinity: 'right' },
    },
  });
  expect(a.markdown()).toBe(before);
});

test('several hidden neighbors count in retained distance and a newly inserted neighbor participates', () => {
  const a = replica('a\n\nb\n\nc\n\nd\n\ne'),
    saved = capture(a, 2, 1);
  a.editor.session().edit(deleteBlocks, { nodeIds: [1, 2, 3].map((i) => a.handle(a.nodes()[i])) });
  expect(resolved(a, saved).focus).toMatchObject({ origin: a.nodes()[0].origin, offset: 1 });
  a.editor.session('peer').edit(({ draft }, id) => {
    const parent = draft.parentOf(id)!;
    const fresh = draft.create({ type: 'paragraph', content: 'new' });
    draft.place(fresh, parent, id);
    return { status: 'handled' };
  }, a.handle(a.nodes()[1]));
  // Placement follows the retained predecessor a; the new occurrence is a closer predecessor of hidden c.
  expect(resolved(a, saved).focus).toMatchObject({
    origin: a.nodes()[1].origin,
    offset: 3,
    affinity: 'left',
  });
});

test('a moved focus outside its host resolves from its retained ghost occurrence', () => {
  const a = replica('> first\n>\n> focus\n>\n> last\n\noutside');
  const quote = a.view().root.children[0],
    saved = capture(a, 1, 2, 'right', quote),
    focus = a.nodes()[1].origin.representative;
  a.editor.session().edit(({ draft, scopeRoot }, id) => {
    draft.place(id, scopeRoot, null);
    return { status: 'handled' };
  }, a.handle(a.nodes()[1]));
  const p = publication(a),
    bytes = a.document.store.encodeUpdate();
  const result = resolveSelection(p, saved, quote.origin);
  expect(result).toMatchObject({
    state: 'fallback',
    focus: { origin: a.nodes()[0].origin, offset: 5, affinity: 'left' },
  });
  expect(resourceKey(focus)).not.toBe(resourceKey(a.nodes()[0].origin.representative));
  expect(compareBytes(a.document.store.encodeUpdate(), bytes)).toBe(0);
  expect(resolveSelection(p, saved)).toEqual({ state: 'unavailable' });
});

test('backward block ranges retain directional endpoints; partial deletion collapses to focus', () => {
  const a = replica('one\n\ntwo\n\nthree');
  const anchor = capture(a, 2, 4, 'left').anchor,
    focus = capture(a, 0, 1, 'right').focus;
  const saved: StableSelection = { anchor, focus, blocks: a.nodes().map((n) => n.origin) };
  expect(resolved(a, saved)).toMatchObject({
    state: 'exact',
    anchor: { origin: a.nodes()[2].origin, offset: 4 },
    focus: { origin: a.nodes()[0].origin, offset: 1 },
    blocks: saved.blocks,
  });
  a.editor.session().edit(deleteBlocks, { nodeIds: [a.handle(a.nodes()[1])] });
  expect(resolved(a, saved)).toMatchObject({
    state: 'fallback',
    anchor: { origin: a.nodes()[0].origin, offset: 1 },
    focus: { origin: a.nodes()[0].origin, offset: 1 },
  });
});

test('preserved block selection keeps both endpoint affinities through real indent and undo/redo', () => {
  const a = replica('one\n\ntwo'),
    h = a.editor.session();
  const anchor = { nodeId: a.handle(a.nodes()[1]), offset: 3, affinity: 'left' as const },
    focus = { nodeId: a.handle(a.nodes()[0]), offset: 0, affinity: 'right' as const };
  h.edit(
    indent,
    { nodeId: anchor.nodeId },
    { selectionBefore: { anchor, focus, nodeIds: [focus.nodeId, anchor.nodeId] } },
  );
  const undo = h.undo(),
    redo = h.redo();
  expect(undo).toMatchObject({
    state: 'applied',
    restoration: { state: 'exact', anchor: { affinity: 'left' }, focus: { affinity: 'right' } },
  });
  expect(redo).toMatchObject({
    state: 'applied',
    restoration: { state: 'exact', anchor: { affinity: 'left' }, focus: { affinity: 'right' } },
  });
});

test('empty root restoration never allocates; explicit empty-root input restores the view after undo', () => {
  const a = replica('gone'),
    saved = capture(a, 0, 2);
  a.editor.session('deletion').edit(({ draft }, id) => {
    draft.deleteSubtree(id);
    return { status: 'handled' };
  }, a.handle(a.nodes()[0]));
  const bytes = a.document.store.encodeUpdate();
  expect(resolveSelection(publication(a), saved)).toMatchObject({ state: 'empty-root' });
  expect(compareBytes(a.document.store.encodeUpdate(), bytes)).toBe(0);
  const h = a.editor.session();
  h.editEmptyRoot('new');
  expect(h.undo()).toMatchObject({ state: 'applied', restoration: { state: 'empty-root' } });
  h.redo();
  expect(a.markdown()).toBe('new\n');
  expect(resolveSelection(publication(a), undefined, a.view().root.origin, true)).toMatchObject({
    state: 'fallback',
    focus: { offset: 0 },
  });
});

test('deleted or empty nested hosts refuse restoration and never climb to a parent', () => {
  const a = replica('> nested\n\noutside'),
    quote = a.view().root.children[0],
    saved = capture(a, 0, 1, 'right', quote);
  a.editor.session().edit(({ draft }, id) => {
    draft.deleteSubtree(id);
    return { status: 'handled' };
  }, a.handle(a.nodes()[0]));
  expect(resolveSelection(publication(a), saved, quote.origin)).toEqual({ state: 'unavailable' });
  expect(resolveSelection(publication(a), undefined, quote.origin, true)).toEqual({
    state: 'unavailable',
  });
  a.editor.session().edit(({ draft }, id) => {
    draft.deleteSubtree(id);
    return { status: 'handled' };
  }, a.handle(a.view().root.children[0]));
  expect(resolveSelection(publication(a), saved, quote.origin)).toEqual({ state: 'unavailable' });
});

test('normalization and lifting preserve caret origins without relying on rendered parents', () => {
  const fixture = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [{ id: 'p', text: 'parent' }],
    },
    {
      id: 'Q',
      parent: 'P',
      role: 'inline',
      flow: 'fQ',
      run: 'rQ',
      tape: 'tQ',
      cells: [{ id: 'q', text: 'child' }],
    },
  ]);
  try {
    const a = replica('', {
      documentId: 'D',
      genesisId: 'G',
      layout: fixture.genesis,
      body: { ...fixture.bodies.get('G')!, allocations: fixture.genesis.allocations },
    });
    const saved = capture(a, 1, 2);
    a.editor.session().edit(indent, { nodeId: a.handle(a.nodes()[1]) });
    expect(resolved(a, saved).focus.offset).toBe(2);
    a.editor.session().edit(outdent, { nodeId: a.handle(a.nodes()[1]) });
    expect(resolved(a, saved).focus.offset).toBe(2);
  } finally {
    fixture.destroy();
  }
});

for (const at of [0, 6])
  test(`joined multi-tape ${at === 0 ? 'start' : 'end'} preserves both edge affinities`, () => {
    const a = replica('abc\n\ndef');
    a.editor.session('setup').edit(joinWithPrevious, { nodeId: a.handle(a.nodes()[1]) });
    const left = capture(a, 0, at, 'left'),
      right = capture(a, 0, at, 'right');
    type(a, 'peer', at, {}, 'peer');
    expect(resolved(a, left).focus.offset).toBe(at);
    expect(resolved(a, right).focus.offset).toBe(at + 4);
  });

test('empty split-cell selection stays scalar-safe across peer typing and cold replay', () => {
  const a = replica('abc');
  a.editor.session().edit(insertParagraph, { nodeId: a.handle(a.nodes()[0]), from: 0 });
  const left = capture(a, 0, 0, 'left'),
    right = capture(a, 0, 0, 'right');
  type(a, '😀', 0, {}, 'peer');
  const cold = replica('', a.genesis, a.document.store.encodeUpdate());
  for (const p of [a, cold]) {
    expect(resolved(p, left).focus).toMatchObject({ origin: p.nodes()[0].origin, offset: 0 });
    expect(resolved(p, right).focus).toMatchObject({ origin: p.nodes()[0].origin, offset: 2 });
  }
});

test('a hidden transferred neighbor restores the empty transferred cell between other tapes', () => {
  const a = replica('a😀b\n\nXY'),
    saved = capture(a, 0, 3, 'left');
  a.editor.session().edit(
    ({ draft }, [source, destination]) => {
      draft.transferInlineRange({ source, from: 1, to: 3, destination, at: 1, affinity: 'right' });
      return { status: 'handled' };
    },
    a.nodes().map((n) => a.handle(n)),
  );
  a.editor
    .session('peer')
    .edit(insertText, { nodeId: a.handle(a.nodes()[1]), from: 1, to: 3, text: '' });
  expect(a.nodes().map((n) => n.content)).toEqual(['ab', 'XY']);
  expect(resolved(a, saved)).toMatchObject({
    state: 'exact',
    focus: { origin: a.nodes()[1].origin, offset: 1, affinity: 'left' },
  });
});
