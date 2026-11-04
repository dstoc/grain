import { expect, test, vi } from 'vitest';
import {
  insertText,
  insertParagraph,
  indent,
  outdent,
  insertMarkdown,
  cycleTaskState,
  interpretMarkdown,
  RetainedEditError,
} from '../authoring/index.js';
import { CommandCompiler, ConversionDeclined } from '../authoring/compiler.js';
import { parseBlocks } from '../../block-parser/api.js';
import { replica, selection, type } from '../../../../test/multiwriter/history.js';
import { compareBytes } from '../actions/cbor.js';

test('sessions are instance-owned, admitted once, and isolated from low-level authors', () => {
  const a = replica(),
    b = replica('', a.genesis),
    one = a.editor.session(),
    two = a.editor.session('two');
  expect(a.editor.session()).toBe(one);
  type(a, 'A');
  type(a, 'B', 0, {}, 'two');
  expect(one.status()).toMatchObject({ undo: 1, redo: 0, reset: false });
  expect(two.status()).toMatchObject({ undo: 1, redo: 0 });
  b.receive(a.document.store.encodeUpdate());
  expect(b.editor.session().status()).toMatchObject({ undo: 0, reset: true });
  expect(() =>
    a.editor.edit({ local: 'default', group: 20n }, insertText, {
      nodeId: a.handle(a.nodes()[0]),
      from: 0,
      text: 'bad',
    }),
  ).toThrow(/managed/);
  expect(one.undo().state).toBe('applied');
  expect(a.markdown()).toBe('Babcdef\n');
  expect(two.status().undo).toBe(1);
  type(a, 'C', 0, {}, 'two');
  expect(one.status().redo).toBe(1);
  one.redo();
  expect(a.markdown()).toBe('CBabcdefA\n');
  a.editor.edit({ local: 'raw', group: 1n }, insertText, {
    nodeId: a.handle(a.nodes()[0]),
    from: 0,
    text: 'raw',
  });
  expect(() => a.editor.session('raw')).toThrow(/low-level/);
});

test('typing coalesces only with a contiguous collapsed selection and a one-second clock', () => {
  const a = replica();
  let now = 0;
  const history = a.editor.session('default', { clock: () => now });
  type(a, '1', 6, { typing: true });
  now = 1000;
  type(a, '2', 7, { typing: true });
  expect(history.groups().undo[0].actions).toHaveLength(2);
  now = 2001;
  type(a, '3', 8, { typing: true });
  type(a, 'start', 0, { typing: true });
  history.sealGroup();
  type(a, '!', 5, { typing: true });
  expect(history.status().undo).toBe(4);
  for (let i = 0; i < 3; i++) history.undo();
  expect(a.markdown()).toBe('abcdef12\n');
  const undone = history.undo();
  expect(undone.state).toBe('applied');
  expect(a.markdown()).toBe('abcdef\n');
  const controls = a.document.store
    .snapshot()
    .ready.filter((a) => a.effects[0]?.type === 'SetGroupActive');
  expect(controls.at(-1)?.effects[0]).toMatchObject({ actions: expect.any(Array), active: false });
  const last = controls.at(-1)?.effects[0];
  if (last?.type === 'SetGroupActive') expect(last.actions).toHaveLength(2);
});

for (const prefix of ['# ', '- ', '- [x] ', '```js\n'])
  test(`literal input and ${JSON.stringify(prefix)} promotion undo together and retain native IDs`, () => {
    const a = replica(),
      h = a.editor.session();
    const before = a.observe().identities,
      nodeId = a.handle(a.nodes()[0]);
    h.edit(
      insertText,
      { nodeId, from: 0, text: prefix },
      { promote: nodeId, typing: true, selectionBefore: selection(a, 0, 0) },
    );
    const after = a.observe().identities;
    expect(h.groups().undo).toHaveLength(1);
    expect(a.document.store.snapshot().ready).toHaveLength(1);
    expect(h.undo().state).toBe('applied');
    expect(a.markdown()).toBe('abcdef\n');
    expect(a.observe().identities).toEqual(before);
    expect(h.redo().state).toBe('applied');
    expect(a.observe().identities).toEqual(after);
    const controls = a.document.store.snapshot().ready.slice(1);
    expect(controls[1].effects[0]).toMatchObject({ active: true, previousControl: controls[0].id });
    expect(
      controls.every((c) => c.allocations.length === 0 && c.nativeInsertUpdates.length === 0),
    ).toBe(true);
  });

test('promotion seals typing and explicit parser composition is one group', () => {
  const a = replica(),
    h = a.editor.session();
  type(a, '#', 0, { typing: true });
  const nodeId = a.handle(a.nodes()[0]);
  type(a, ' ', 1, { typing: true, promote: nodeId });
  expect(h.groups().undo[0].actions).toHaveLength(2);
  type(a, 'next', 0, { typing: true });
  expect(h.status().undo).toBe(2);
  h.undo();
  h.undo();
  expect(a.markdown()).toBe('abcdef\n');
  const target = a.handle(a.nodes()[0]);
  h.edit((context) => {
    insertText(context, { nodeId: target, from: 0, to: 6, text: '# title' });
    interpretMarkdown(context, target, parseBlocks('# title', { provenance: true }).provenance);
    return { status: 'handled' };
  }, undefined);
  expect(a.markdown()).toBe('# title\n');
  h.undo();
  expect(a.markdown()).toBe('abcdef\n');
});

test('no-ops and declined conversion preserve redo; optional declined promotion retains literal input', () => {
  const a = replica(),
    h = a.editor.session();
  type(a, 'x');
  h.undo();
  const before = a.document.store.encodeUpdate();
  expect(h.edit(() => ({ status: 'handled' }), undefined).status).toBe('unchanged');
  expect(h.edit(() => ({ status: 'not-applicable' }), undefined).status).toBe('not-applicable');
  const nodeId = a.handle(a.nodes()[0]);
  const spy = vi.spyOn(CommandCompiler.prototype, 'interpret').mockImplementation(() => {
    throw new ConversionDeclined('invalid-conversion', 'test');
  });
  try {
    expect(
      h.edit(
        insertText,
        { nodeId, from: 0, text: '# ' },
        { conversion: { nodeId, plan: parseBlocks('# abcdef', { provenance: true }).provenance } },
      ).status,
    ).toBe('declined');
    expect(h.status().redo).toBe(1);
    expect(compareBytes(a.document.store.encodeUpdate(), before)).toBe(0);
    expect(() => h.edit(insertText, { nodeId, from: 999, text: '?' })).toThrow();
    expect(h.status().redo).toBe(1);
    type(a, '# ', 0, { promote: nodeId });
    expect(a.markdown()).toBe('# abcdef\n');
    expect(h.status().redo).toBe(0);
    h.undo();
    expect(a.markdown()).toBe('abcdef\n');
  } finally {
    spy.mockRestore();
  }
});

test('newest hidden group consumes one no-effect undo and remote input never clears redo', () => {
  const a = replica('first\n\nsecond'),
    b = replica('', a.genesis),
    h = a.editor.session();
  type(a, 'old', 0);
  type(a, 'hidden', 1);
  b.receive(a.document.store.encodeUpdate());
  b.editor.session().edit(({ draft }, id) => {
    draft.deleteSubtree(id);
    return { status: 'handled' };
  }, b.handle(b.nodes()[0]));
  a.receive(b.document.store.encodeUpdate());
  const before = a.markdown();
  const result = h.undo();
  expect(result.state).toBe('applied');
  expect(a.markdown()).toBe(before);
  expect(h.status()).toMatchObject({ undo: 1, redo: 1 });
  type(b, 'remote');
  a.receive(b.document.store.encodeUpdate());
  expect(h.status()).toMatchObject({ undo: 1, redo: 1 });
  h.redo();
  expect(a.markdown()).toBe('secondremote\n');
});

test('limits bound both stacks, reset is local, and evictions emit no canonical writes', () => {
  const a = replica(),
    h = a.editor.session('default', { limit: 3 });
  for (const c of '1234') type(a, c);
  expect(h.status().undo).toBe(3);
  h.undo();
  h.undo();
  const bytes = a.document.store.encodeUpdate(),
    native = a.observe().native;
  type(a, 'other', 0, {}, 'other');
  const other = a.editor.session('other');
  const current = a.document.store.encodeUpdate();
  h.setLimit(1);
  expect(h.status()).toMatchObject({ undo: 0, redo: 1 });
  expect(compareBytes(a.document.store.encodeUpdate(), current)).toBe(0);
  h.reset();
  expect(h.status()).toMatchObject({ undo: 0, redo: 0, reset: true });
  expect(other.status().undo).toBe(1);
  expect(compareBytes(a.document.store.encodeUpdate(), current)).toBe(0);
  h.setLimit(0);
  type(a, 'zero');
  expect(h.status()).toMatchObject({ undo: 0, redo: 0 });
  expect(bytes.length).toBeGreaterThan(0);
  expect(native.length).toBeGreaterThan(0);
  expect(() => h.setLimit(-1)).toThrow();
  expect(() => h.setLimit(1.5)).toThrow();
});

for (const point of ['certify', 'append', 'observer', 'refresh'] as const)
  test(`${point} failure moves edit/control cursors only at exact retention`, () => {
    const a = replica(),
      h = a.editor.session();
    const inject = () =>
      point === 'certify'
        ? vi.spyOn(a.document, 'certifyLocal').mockImplementationOnce(() => {
            throw new Error('injected');
          })
        : point === 'append'
          ? vi.spyOn(a.document.store, 'append').mockImplementationOnce(() => {
              throw new Error('injected');
            })
          : point === 'refresh'
            ? vi.spyOn(a.document.publication, 'refresh').mockImplementationOnce(() => {
                throw new Error('injected');
              })
            : (() => {
                const append = a.document.store.append.bind(a.document.store);
                return vi.spyOn(a.document.store, 'append').mockImplementationOnce((e) => {
                  append(e);
                  throw new Error('injected');
                });
              })();
    const retained = point === 'observer' || point === 'refresh';
    let spy = inject();
    expect(() => type(a, 'x')).toThrow(retained ? RetainedEditError : Error);
    spy.mockRestore();
    expect(h.status().undo).toBe(retained ? 1 : 0);
    if (retained) {
      expect(() => h.undo()).toThrow(/stale/);
      a.editor.refresh();
    } else type(a, 'x');
    const before = a.document.store.snapshot().ready.length;
    spy = inject();
    expect(() => h.undo()).toThrow(retained ? RetainedEditError : Error);
    spy.mockRestore();
    expect(h.status()).toMatchObject({ undo: retained ? 0 : 1, redo: retained ? 1 : 0 });
    if (retained) {
      a.editor.refresh();
      expect(h.undo().state).toBe('empty');
    } else h.undo();
    expect(a.document.store.snapshot().ready.length).toBe(before + 1);
    expect(a.markdown()).toBe('abcdef\n');
    h.redo();
    expect(a.markdown()).toBe('abcdefx\n');
  });

test('real replacement, paste, split, join, indent/outdent, task and deletion round trip through managed controls', async () => {
  const { joinWithPrevious, deleteBlocks } = await import('../authoring/index.js');
  const a = replica(),
    h = a.editor.session();
  const roundTrip = (run: () => void) => {
    const before = a.markdown();
    run();
    const after = a.markdown(),
      ids = a.observe().identities;
    expect(after).not.toBe(before);
    h.undo();
    expect(a.markdown()).toBe(before);
    h.redo();
    expect(a.markdown()).toBe(after);
    expect(a.observe().identities).toEqual(ids);
  };
  roundTrip(() =>
    h.edit(
      insertText,
      { nodeId: a.handle(a.nodes()[0]), from: 1, to: 4, text: 'XY' },
      { selectionBefore: selection(a, 0, 4, 1) },
    ),
  );
  roundTrip(() =>
    h.edit(insertMarkdown, { contextId: a.handle(a.nodes()[0]), markdown: 'one\n\ntwo' }),
  );
  roundTrip(() =>
    h.edit(
      insertParagraph,
      { nodeId: a.handle(a.nodes()[0]), from: 2 },
      { selectionBefore: selection(a, 0, 2) },
    ),
  );
  roundTrip(() => h.edit(joinWithPrevious, { nodeId: a.handle(a.nodes()[1]) }));
  roundTrip(() => h.edit(indent, { nodeId: a.handle(a.nodes()[0]) }));
  roundTrip(() =>
    h.edit(cycleTaskState, { nodeId: a.handle(a.view().root.children[0].children[0]) }),
  );
  roundTrip(() => h.edit(outdent, { nodeId: a.handle(a.nodes()[0]) }));
  roundTrip(() => h.edit(deleteBlocks, { nodeIds: [a.handle(a.nodes()[1])] }));
});

test('retained failure stages focus before a peer prepend arrives during recovery', () => {
  const a = replica(),
    b = replica('', a.genesis),
    h = a.editor.session();
  const append = a.document.store.append.bind(a.document.store);
  const spy = vi.spyOn(a.document.store, 'append').mockImplementationOnce((e) => {
    append(e);
    throw new Error('observer');
  });
  expect(() => type(a, 'x', 3)).toThrow(RetainedEditError);
  spy.mockRestore();
  type(b, 'peer', 0);
  a.receive(b.document.store.encodeUpdate());
  const result = h.undo();
  expect(result).toMatchObject({
    state: 'applied',
    restoration: { state: 'exact', focus: { offset: 7 } },
  });
  expect(h.redo()).toMatchObject({
    state: 'applied',
    restoration: { state: 'exact', focus: { offset: 8 } },
  });
  expect(a.markdown()).toBe('peerabcxdef\n');
});

test('metadata returned to callers cannot alter complete group membership or selections', () => {
  const a = replica(),
    h = a.editor.session();
  const edit = type(a, 'x', 3);
  if (!edit.applied) throw new Error();
  const groups = h.groups();
  groups.undo[0].actions.splice(0);
  (groups.undo[0].selectionBefore!.focus.gap.left.native as { clock: number }).clock = 999;
  (edit.envelope.effects as unknown[]).splice(0);
  expect(h.groups().undo[0].actions).toHaveLength(1);
  expect(h.undo().state).toBe('applied');
  expect(a.markdown()).toBe('abcdef\n');
});

test('replacement of backward-selected blocks restores their complete direction on undo', async () => {
  const { replaceBlocks } = await import('../authoring/index.js');
  const a = replica('one\n\ntwo\n\nthree'),
    h = a.editor.session(),
    nodeIds = a.nodes().map((n) => a.handle(n));
  const before = {
    anchor: { nodeId: nodeIds[2], offset: 5, affinity: 'left' as const },
    focus: { nodeId: nodeIds[0], offset: 0, affinity: 'right' as const },
    nodeIds,
  };
  h.edit(replaceBlocks, { nodeIds, text: 'replacement' }, { selectionBefore: before });
  expect(a.markdown()).toBe('replacement\n');
  const undo = h.undo();
  expect(a.markdown()).toBe('one\n\ntwo\n\nthree\n');
  expect(undo).toMatchObject({
    state: 'applied',
    restoration: {
      state: 'exact',
      anchor: { origin: a.nodes()[2].origin, offset: 5, affinity: 'left' },
      focus: { origin: a.nodes()[0].origin, offset: 0, affinity: 'right' },
      blocks: expect.any(Array),
    },
  });
  expect(h.redo()).toMatchObject({
    state: 'applied',
    restoration: { state: 'exact', focus: { offset: 11 } },
  });
  expect(a.markdown()).toBe('replacement\n');
});

for (const name of ['code-enter', 'code-linebreak', 'paragraph-enter', 'backspace-join'] as const)
  test(`${name} has isolated managed history and restores its command focus`, async () => {
    const { enter, insertLineBreak, deleteBackwardAtStart } = await import('../authoring/index.js');
    const a = replica(name.startsWith('code') ? '```js\nabcd\n```' : 'one\n\ntwo'),
      h = a.editor.session();
    const index = name === 'backspace-join' ? 1 : 0,
      nodeId = a.handle(a.nodes()[index]),
      at = name === 'backspace-join' ? 0 : 2;
    const before = a.markdown();
    if (name === 'backspace-join')
      h.edit(deleteBackwardAtStart, { nodeId }, { selectionBefore: selection(a, index, at) });
    else
      h.edit(
        name === 'code-linebreak' ? insertLineBreak : enter,
        { nodeId, from: at },
        { selectionBefore: selection(a, index, at) },
      );
    const after = a.markdown(),
      ids = a.observe().identities;
    expect(after).not.toBe(before);
    expect(h.status().undo).toBe(1);
    expect(h.undo()).toMatchObject({
      state: 'applied',
      restoration: { state: 'exact', focus: { offset: at } },
    });
    expect(a.markdown()).toBe(before);
    expect(h.redo()).toMatchObject({ state: 'applied', restoration: { state: 'exact' } });
    expect(a.markdown()).toBe(after);
    expect(a.observe().identities).toEqual(ids);
  });

test('typing without a collapsed saved selection stays isolated', () => {
  const a = replica(),
    h = a.editor.session();
  h.edit(insertText, { nodeId: a.handle(a.nodes()[0]), from: 0, text: 'x' }, { typing: true });
  type(a, 'y', 1, { typing: true });
  h.edit(
    insertText,
    { nodeId: a.handle(a.nodes()[0]), from: 2, text: 'z' },
    { typing: true, selectionBefore: selection(a, 0, 1, 2) },
  );
  type(a, 'w', 3, { typing: true });
  expect(h.status().undo).toBe(4);
});
