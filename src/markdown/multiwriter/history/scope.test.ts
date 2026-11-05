import { expect, test } from 'vitest';
import {
  insertText,
  insertParagraph,
  joinWithPrevious,
  deleteBlocks,
  indent,
  outdent,
} from '../authoring/index.js';
import { replica, selection, type } from '../../../../test/multiwriter/history.js';
import { compareBytes } from '../actions/cbor.js';
import { NativeFixture } from '../ownership/test-fixtures.js';

function unchanged(a: ReturnType<typeof replica>, run: () => unknown) {
  const groups = a.editor.session().groups(),
    bytes = a.document.store.encodeUpdate(),
    native = a.observe().native;
  const result = run();
  expect(a.editor.session().groups()).toEqual(groups);
  expect(compareBytes(a.document.store.encodeUpdate(), bytes)).toBe(0);
  expect(compareBytes(a.observe().native, native)).toBe(0);
  return result;
}

test('scoped navigation skips outside groups in both directions without changing their order', () => {
  const a = replica('one\n\ntwo'),
    h = a.editor.session();
  type(a, 'A', 0);
  h.edit(insertText, { nodeId: a.handle(a.nodes()[1]), from: 0, text: 'B' });
  const scope = a.nodes()[0].origin;
  expect(h.undo({ scope }).state).toBe('applied');
  expect(a.markdown()).toBe('one\n\nBtwo\n');
  expect(h.status()).toMatchObject({ undo: 1, redo: 1 });
  expect(h.redo({ scope }).state).toBe('applied');
  expect(a.markdown()).toBe('Aone\n\nBtwo\n');
  h.undo(); // first block group was most recently redone
  h.undo(); // second block group
  expect(h.redo({ scope }).state).toBe('applied');
  expect(a.markdown()).toBe('Aone\n\ntwo\n');
  expect(h.status()).toMatchObject({ undo: 1, redo: 1 });
});

test('ranges of the same native tape classify by current owner after a real split', () => {
  const a = replica('abcdef'),
    h = a.editor.session();
  type(a, 'L', 1);
  type(a, 'R', 6);
  a.editor.session('peer').edit(insertParagraph, { nodeId: a.handle(a.nodes()[0]), from: 4 });
  const left = a.nodes()[0].origin,
    right = a.nodes()[1].origin;
  expect(h.undo({ scope: left }).state).toBe('applied');
  expect(a.nodes().map((n) => n.content)).toEqual(['abc', 'deRf']);
  expect(h.status()).toMatchObject({ undo: 1, redo: 1 });
  expect(h.undo({ scope: right }).state).toBe('applied');
  expect(a.nodes().map((n) => n.content)).toEqual(['abc', 'def']);
  expect(h.redo({ scope: left }).state).toBe('applied');
  expect(a.nodes()[0].content).toBe('aLbc');
});

test('a single inserted range partitioned across scopes blocks instead of splitting or scanning older groups', () => {
  const a = replica('ab'),
    h = a.editor.session();
  type(a, 'older', 0);
  type(a, 'WXYZ', 6);
  a.editor.session('peer').edit(insertParagraph, { nodeId: a.handle(a.nodes()[0]), from: 8 });
  expect(unchanged(a, () => h.undo({ scope: a.nodes()[0].origin }))).toMatchObject({
    state: 'blocked',
    reason: 'mixed-footprint',
  });
  expect(h.status().undo).toBe(2);
});

for (const direction of ['undo', 'redo'] as const)
  test(`hidden deletion footprints remain inside for scoped ${direction}`, () => {
    const a = replica('> first\n>\n> second\n\noutside'),
      h = a.editor.session(),
      quote = a.view().root.children[0].origin;
    h.edit(
      deleteBlocks,
      { nodeIds: [a.handle(a.nodes()[0])] },
      { selectionBefore: selection(a, 0, 0) },
    );
    if (direction === 'redo') h.undo({ scope: quote });
    expect(h[direction]({ scope: quote }).state).toBe('applied');
    expect(a.markdown()).toBe(
      direction === 'undo' ? '> first\n> \n> second\n\noutside\n' : '> second\n\noutside\n',
    );
  });

test('cross-scope transfer includes its retained source endpoint after ownership has moved', () => {
  const a = replica('> source\n\ndestination'),
    h = a.editor.session(),
    scope = a.view().root.children[0].origin;
  h.edit(
    ({ draft }, [source, destination]) => {
      draft.transferInlineRange({ source, from: 0, to: 3, destination, at: 0, affinity: 'right' });
      return { status: 'handled' };
    },
    a.nodes().map((n) => a.handle(n)),
  );
  expect(a.nodes().map((n) => n.content)).toEqual(['rce', 'soudestination']);
  expect(unchanged(a, () => h.undo({ scope }))).toMatchObject({
    state: 'blocked',
    reason: 'mixed-footprint',
  });
});

test('cross-scope move retains its source edge and cannot be skipped after moving outside', () => {
  const a = replica('> first\n>\n> moving\n\noutside'),
    h = a.editor.session(),
    scope = a.view().root.children[0].origin;
  h.edit(({ draft, scopeRoot }, id) => {
    draft.place(id, scopeRoot, null);
    return { status: 'handled' };
  }, a.handle(a.nodes()[1]));
  expect(unchanged(a, () => h.undo({ scope }))).toMatchObject({
    state: 'blocked',
    reason: 'mixed-footprint',
  });
});

test('cross-scope join includes source and destination even when the source header is absorbed', () => {
  const a = replica('one\n\ntwo'),
    h = a.editor.session(),
    scope = a.nodes()[0].origin;
  h.edit(joinWithPrevious, { nodeId: a.handle(a.nodes()[1]) });
  expect(unchanged(a, () => h.undo({ scope }))).toMatchObject({
    state: 'blocked',
    reason: 'mixed-footprint',
  });
});

test('empty split cells and their structural endpoints prevent a partial scoped control', () => {
  const a = replica(),
    h = a.editor.session(),
    scope = a.nodes()[0].origin;
  h.edit(insertParagraph, { nodeId: a.handle(a.nodes()[0]), from: 0 });
  expect(unchanged(a, () => h.undo({ scope }))).toMatchObject({
    state: 'blocked',
    reason: 'mixed-footprint',
  });
  h.undo();
  expect(a.markdown()).toBe('abcdef\n');
});

test('normalized wrapper scope includes every constituent and their current descendants', () => {
  const f = new NativeFixture([
    { id: 'root', role: 'root', parent: null },
    ...['A', 'B'].flatMap((id) => [
      { id, role: 'quote' as const, parent: 'root' },
      {
        id: `p${id}`,
        role: 'inline' as const,
        parent: id,
        flow: `f${id}`,
        run: `r${id}`,
        tape: `t${id}`,
        cells: [{ id: `${id}text`, text: id }],
      },
    ]),
  ]);
  try {
    const a = replica('', {
      documentId: 'D',
      genesisId: 'G',
      layout: f.genesis,
      body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
    });
    const h = a.editor.session(),
      quote = a.view().root.children[0].origin;
    expect(quote.constituents).toHaveLength(2);
    h.edit(insertText, { nodeId: a.handle(a.nodes()[1]), from: 0, text: 'inside' });
    expect(h.undo({ scope: quote }).state).toBe('applied');
    expect(a.nodes().map((n) => n.content)).toEqual(['A', 'B']);
    expect(h.redo({ scope: quote }).state).toBe('applied');
    expect(a.nodes()[1].content).toBe('insideB');
  } finally {
    f.destroy();
  }
});

test('invalid/deleted scope returns a typed result without changing cursors or bytes', () => {
  const a = replica('one\n\ntwo'),
    h = a.editor.session(),
    scope = a.nodes()[0].origin;
  type(a, 'x');
  a.editor.session('peer').edit(deleteBlocks, { nodeIds: [a.handle(a.nodes()[0])] });
  expect(unchanged(a, () => h.undo({ scope }))).toEqual({ state: 'invalid-scope' });
  expect(
    unchanged(a, () =>
      h.undo({
        scope: {
          type: 'empty-root',
          slot: { parent: a.view().root.origin.representative, predecessor: null },
        },
      }),
    ),
  ).toEqual({ state: 'invalid-scope' });
});

test('inside no-effect text undo still consumes the newest group under a surviving wrapper', () => {
  const a = replica('> first\n>\n> second'),
    h = a.editor.session(),
    scope = a.view().root.children[0].origin;
  type(a, 'older', 0);
  type(a, 'hidden', 0);
  a.editor.session('peer').edit(deleteBlocks, { nodeIds: [a.handle(a.nodes()[0])] });
  const before = a.markdown();
  expect(h.undo({ scope }).state).toBe('applied');
  expect(a.markdown()).toBe(before);
  expect(h.status()).toMatchObject({ undo: 1, redo: 1 });
});

test('in-scope indent/outdent groups include births, placements and retained hidden wrappers', () => {
  const a = replica('> first\n>\n> second'),
    h = a.editor.session(),
    scope = a.view().root.children[0].origin;
  h.edit(
    indent,
    { nodeId: a.handle(a.nodes()[0]) },
    { scopeRoot: a.handle(a.view().root.children[0]) },
  );
  expect(h.undo({ scope }).state).toBe('applied');
  h.redo({ scope });
  h.edit(
    outdent,
    { nodeId: a.handle(a.nodes()[0]) },
    { scopeRoot: a.handle(a.view().root.children[0]) },
  );
  expect(h.undo({ scope }).state).toBe('applied');
});

test('lifted raw children are outside a paragraph scope, including hidden redo footprints', () => {
  const f = new NativeFixture([
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
        layout: f.genesis,
        body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
      }),
      h = a.editor.session();
    const scope = a.nodes()[0].origin;
    h.edit(insertText, { nodeId: a.handle(a.nodes()[1]), from: 0, text: 'edit' });
    expect(unchanged(a, () => h.undo({ scope }))).toEqual({ state: 'empty' });
    h.undo();
    expect(unchanged(a, () => h.redo({ scope }))).toEqual({ state: 'empty' });
    h.redo();
    h.edit(deleteBlocks, { nodeIds: [a.handle(a.nodes()[1])] });
    expect(unchanged(a, () => h.undo({ scope }))).toEqual({ state: 'empty' });
  } finally {
    f.destroy();
  }
});

test('a fabricated normalized constituent set is not a valid current scope', () => {
  const a = replica('one\n\ntwo'),
    h = a.editor.session();
  type(a, 'x');
  const scope = {
    ...a.nodes()[0].origin,
    constituents: a.nodes().map((n) => n.origin.representative),
  };
  expect(unchanged(a, () => h.undo({ scope }))).toEqual({ state: 'invalid-scope' });
});

test('quarantined local target evidence blocks scoped navigation as unresolved', () => {
  const a = replica(),
    h = a.editor.session(),
    edit = type(a, 'x');
  if (!edit.applied) throw new Error();
  // A retained conflicting variant removes this target from the ready projection.
  a.document.store.append({
    ...edit.envelope,
    groupId: { ...edit.envelope.groupId, sequence: 999n },
  });
  a.editor.refresh();
  expect(unchanged(a, () => h.undo({ scope: a.view().root.origin }))).toMatchObject({
    state: 'blocked',
    reason: 'unresolved-footprint',
  });
});
