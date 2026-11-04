import type { ParserConversionPlan } from '../../block-parser/types.js';
import { parseBlocks } from '../../block-parser/api.js';
import { afterEach, expect, test } from 'vitest';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { openReferenceDocument } from '../reference/document.js';
import { serializeProjection } from '../projection/project.js';
import { LocalEditor } from './editor.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { indent } from '../../../editing/commands/indent.js';
import { outdent } from '../../../editing/commands/outdent.js';
import { insertMarkdown } from '../../../editing/commands/insert-markdown.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';
import type { ViewNode } from '../projection/types.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function open() {
  const fixture = new NativeFixture();
  const genesis = {
    documentId: 'D',
    genesisId: 'G',
    layout: fixture.genesis,
    body: { ...fixture.bodies.get('G')!, allocations: fixture.genesis.allocations },
  };
  const document = openReferenceDocument(genesis);
  document.publication.refresh();
  const editor = new LocalEditor(document, genesis);
  cleanups.push(() => {
    editor.destroy();
    document.destroy();
    fixture.destroy();
  });
  const view = () => document.publication.status().publication!.value.view;
  const nodes = () => {
    const all: ViewNode[] = [];
    const visit = (n: ViewNode) => {
      if (['paragraph', 'section', 'code-block'].includes(n.type)) all.push(n);
      n.children.forEach(visit);
    };
    visit(view().root);
    return all;
  };
  const handle = (n: ViewNode) => editor.handle(n.origin.representative);
  const text = () => serializeProjection(view());
  return { fixture, genesis, document, editor, view, nodes, handle, text };
}
const session = { local: 'test', group: 1n };
test('literal input preserves identity and publishes before the next call', () => {
  const h = open(),
    before = h
      .nodes()[0]!
      .fragments.filter((f) => f.visible)
      .map((f) => f.range);
  for (const text of '123') {
    const n = h.nodes()[0]!;
    expect(
      h.editor.edit(session, insertText, { nodeId: h.handle(n), from: n.content.length, text })
        .status,
    ).toBe('applied');
  }
  expect(h.text()).toBe('abcdef123\n');
  expect(
    h
      .nodes()[0]!
      .fragments.filter((f) => f.visible)
      .slice(0, before.length)
      .map((f) => f.range),
  ).toEqual(before);
});
test.each([0, 3, 6])(
  'Enter at %s is an explicit partition with retained text identities',
  (from) => {
    const h = open(),
      original = h.nodes()[0]!.origin.representative;
    const result = h.editor.edit(session, insertParagraph, {
      nodeId: h.handle(h.nodes()[0]!),
      from,
    });
    expect(result.status).toBe('applied');
    if (result.status === 'applied')
      expect(result.envelope.effects.some((e) => e.type === 'SplitFlow')).toBe(true);
    expect(h.nodes().map((n) => n.content)).toEqual([
      'abcdef'.slice(0, from),
      'abcdef'.slice(from),
    ]);
    expect(h.nodes()[from === 0 ? 1 : 0]!.origin.representative).toEqual(original);
  },
);
test('Backspace join is not a subtree delete and keeps its source tape', () => {
  const h = open();
  h.editor.edit(session, insertParagraph, { nodeId: h.handle(h.nodes()[0]!), from: 3 });
  const tapes = h
    .nodes()
    .flatMap((n) => n.fragments.filter((f) => f.visible).map((f) => f.range.tape));
  const result = h.editor.edit(session, joinWithPrevious, { nodeId: h.handle(h.nodes()[1]!) });
  expect(h.text()).toBe('abcdef\n');
  if (result.status !== 'applied') throw new Error('Expected join');
  expect(result.envelope.effects.map((e) => e.type)).toContain('JoinFlow');
  expect(result.envelope.effects.map((e) => e.type)).not.toContain('DeleteSubtree');
  expect(
    h
      .nodes()[0]!
      .fragments.filter((f) => f.visible)
      .map((f) => f.range.tape),
  ).toEqual(tapes);
});
test('indent and outdent use moves and lifting', () => {
  const h = open();
  h.editor.edit(session, indent, { nodeId: h.handle(h.nodes()[0]!) });
  expect(h.text()).toBe('* abcdef\n');
  h.editor.edit(session, outdent, { nodeId: h.handle(h.nodes()[0]!) });
  expect(h.text()).toBe('abcdef\n');
});
test('Markdown paste copies content and selected deletion is destructive', () => {
  const h = open();
  h.editor.edit(session, insertMarkdown, {
    contextId: h.handle(h.nodes()[0]!),
    markdown: 'one\n\ntwo',
  });
  expect(h.nodes().map((n) => n.content)).toEqual(['abcdef', 'one', 'two']);
  const result = h.editor.edit(session, deleteBlocks, { nodeIds: [h.handle(h.nodes()[1]!)] });
  expect(h.nodes().map((n) => n.content)).toEqual(['abcdef', 'two']);
  if (result.status !== 'applied') throw new Error('Expected deletion');
  expect(result.envelope.effects.map((e) => e.type)).toContain('DeleteSubtree');
});
test('type, split and type in one draft use unpublished origins without string reconstruction', () => {
  const h = open(),
    nodeId = h.handle(h.nodes()[0]!);
  const result = h.editor.edit(
    session,
    (context, { nodeId }) => {
      insertText(context, { nodeId, from: 2, text: 'XYZ' });
      const split = insertParagraph(context, { nodeId, from: 4 });
      if (split.status !== 'handled' || !split.focus) throw new Error('No split focus');
      return insertText(context, { nodeId: split.focus.nodeId, from: 1, text: '!' });
    },
    { nodeId },
  );
  expect(result.status).toBe('applied');
  expect(h.nodes().map((n) => n.content)).toEqual(['abXY', 'Z!cdef']);
});
test('successive splits through previously refined native cells use exact native offsets', () => {
  const h = open();
  h.editor.edit(session, insertParagraph, { nodeId: h.handle(h.nodes()[0]!), from: 3 });
  h.editor.edit(session, joinWithPrevious, { nodeId: h.handle(h.nodes()[1]!) });
  h.editor.edit(session, insertParagraph, { nodeId: h.handle(h.nodes()[0]!), from: 5 });
  expect(h.nodes().map((n) => n.content)).toEqual(['abcde', 'f']);
});
test('literal replacement and surrogate pairs retain exact identities', () => {
  const h = open();
  h.editor.edit(session, insertText, {
    nodeId: h.handle(h.nodes()[0]!),
    from: 2,
    to: 4,
    text: '😀é',
  });
  expect(h.text()).toBe('ab😀éef\n');
  h.editor.edit(session, insertParagraph, { nodeId: h.handle(h.nodes()[0]!), from: 4 });
  expect(h.nodes().map((n) => n.content)).toEqual(['ab😀', 'éef']);
});
test('same-node fragment transfer uses pre-transfer coordinates and keeps native IDs', () => {
  const h = open();
  h.editor.edit(
    session,
    (context, { nodeId }) => {
      context.draft.transferInlineRange({
        source: nodeId,
        from: 1,
        to: 3,
        destination: nodeId,
        at: 5,
        affinity: 'right',
      });
      return { status: 'handled' };
    },
    { nodeId: h.handle(h.nodes()[0]!) },
  );
  expect(h.text()).toBe('adebcf\n');
});
test.each(['# repeated repeated', '- [x] task', '> quote', '```js\ncode\n```'])(
  'parser promotion binds exact native source: %j',
  (markdown) => {
    const h = open(),
      nodeId = h.handle(h.nodes()[0]!);
    h.editor.edit(
      session,
      insertText,
      { nodeId, from: 0, to: 6, text: markdown },
      { promote: nodeId },
    );
    expect(h.nodes()[0]!.content).toBe(
      markdown.startsWith('#')
        ? 'repeated repeated'
        : markdown.startsWith('-')
          ? 'task'
          : markdown.startsWith('>')
            ? 'quote'
            : 'code',
    );
  },
);
test('insert-then-delete unpublished text creates no native facts or action', () => {
  const h = open(),
    before = h.document.store.encodeUpdate(),
    native = h.document.publication.status().publication!.native.encodeState();
  const result = h.editor.edit(
    session,
    (ctx, { nodeId }) => {
      insertText(ctx, { nodeId, from: 2, text: 'temporary' });
      insertText(ctx, { nodeId, from: 2, to: 11, text: '' });
      return { status: 'handled' };
    },
    { nodeId: h.handle(h.nodes()[0]!) },
  );
  expect(result.status).toBe('unchanged');
  expect(h.document.store.encodeUpdate()).toEqual(before);
  expect(h.document.publication.status().publication!.native.encodeState()).toEqual(native);
});
test('discarded literal buffers are absent while surviving input is allocated once', () => {
  const h = open();
  const result = h.editor.edit(
    session,
    (ctx, { nodeId }) => {
      insertText(ctx, { nodeId, from: 2, text: 'temporary' });
      insertText(ctx, { nodeId, from: 2, to: 11, text: 'kept' });
      return { status: 'handled' };
    },
    { nodeId: h.handle(h.nodes()[0]!) },
  );
  expect(h.text()).toBe('abkeptcdef\n');
  if (result.status !== 'applied') throw new Error('Expected text action');
  expect(
    result.envelope.nativeManifest
      .filter((m) => m.type === 'text')
      .map((m) => m.text)
      .join(''),
  ).toBe('kept');
});
test('explicit multi-inline parser conversion publishes all outputs atomically', () => {
  const h = open(),
    before = h.document.store.encodeUpdate(),
    nodeId = h.handle(h.nodes()[0]!);
  const source = 'one\n\ntwo';
  const plan = parseBlocks(source, { provenance: true }).provenance;
  const result = h.editor.edit(
    session,
    insertText,
    { nodeId, from: 0, to: 6, text: source },
    { conversion: { nodeId, plan } },
  );
  expect(result).toMatchObject({
    status: 'applied',
    applied: true,
  });
  expect(h.document.store.encodeUpdate()).not.toEqual(before);
  expect(h.text()).toBe('one\n\ntwo\n');
});
test.each(['# ', '> ', '- [x] ', '```js\n'])(
  'promotion maps a caret after consumed prefix %j to the first retained character',
  (prefix) => {
    const h = open(),
      nodeId = h.handle(h.nodes()[0]!);
    const result = h.editor.edit(
      session,
      insertText,
      { nodeId, from: 0, text: prefix },
      { promote: nodeId },
    );
    if (result.status !== 'applied') throw new Error('Expected promotion');
    const first = h.nodes()[0]!.fragments.find((f) => f.visible)!;
    expect(result.focus?.native).toEqual({ client: first.range.client, clock: first.range.clock });
    expect(result.focus?.side).toBe('left');
  },
);

test('unsupported retained-piece reordering declines the entire explicit conversion', () => {
  const h = open(),
    nodeId = h.handle(h.nodes()[0]!),
    bytes = h.document.store.encodeUpdate();
  const plan: ParserConversionPlan = {
    output: { type: 'document', children: [{ type: 'paragraph', content: 'cdabef!' }] },
    inlinePieces: {
      '0': [
        { kind: 'retain', sourceFrom: 2, sourceTo: 4 },
        { kind: 'retain', sourceFrom: 0, sourceTo: 2 },
        { kind: 'retain', sourceFrom: 4, sourceTo: 7 },
      ],
    },
    consumed: [],
  };
  const result = h.editor.edit(
    session,
    insertText,
    { nodeId, from: 6, text: '!' },
    { conversion: { nodeId, plan } },
  );
  expect(result).toMatchObject({ status: 'declined', reason: 'unsupported-conversion' });
  expect(h.document.store.encodeUpdate()).toEqual(bytes);
  expect(h.text()).toBe('abcdef\n');
});

test('a discarded buffer split across nodes emits no native text facts', () => {
  const h = open(),
    nodeId = h.handle(h.nodes()[0]);
  const result = h.editor.edit(
    session,
    (ctx) => {
      insertText(ctx, { nodeId, from: 2, text: 'temporary' });
      const split = insertParagraph(ctx, { nodeId, from: 6 });
      if (split.status !== 'handled' || !split.focus) throw new Error();
      insertText(ctx, { nodeId, from: 2, to: 6, text: '' });
      insertText(ctx, { nodeId: split.focus.nodeId, from: 0, to: 5, text: '' });
      return { status: 'handled' };
    },
    undefined,
  );
  expect(h.nodes().map((n) => n.content)).toEqual(['ab', 'cdef']);
  if (result.status !== 'applied') throw new Error();
  expect(result.envelope.nativeManifest.filter((m) => m.type === 'text')).toEqual([]);
});

test('a terminal multi-inline promotion maps the raw caret into its retained output', () => {
  const h = open(),
    nodeId = h.handle(h.nodes()[0]),
    source = 'first\n\n# second';
  const result = h.editor.edit(
    session,
    insertText,
    { nodeId, from: 0, to: 6, text: source },
    { promote: nodeId },
  );
  if (result.status !== 'applied') throw new Error();
  const last = h
    .nodes()[1]
    .fragments.filter((f) => f.visible)
    .at(-1)!;
  expect(result.focus?.native).toEqual({
    client: last.range.client,
    clock: last.range.clock + last.range.length - 1,
  });
  expect(result.focus?.side).toBe('right');
});
test('successive conversions retain observed syntax masks without reconstructing text', () => {
  const h = open();
  let nodeId = h.handle(h.nodes()[0]);
  h.editor.edit(session, insertText, { nodeId, from: 0, text: '# ' }, { promote: nodeId });
  nodeId = h.handle(h.nodes()[0]);
  h.editor.edit(session, insertText, { nodeId, from: 0, to: 6, text: 'new' }, { promote: nodeId });
  expect(h.nodes().map((n) => n.content)).toEqual(['new']);
  nodeId = h.handle(h.nodes()[0]);
  h.editor.edit(session, insertText, { nodeId, from: 0, text: '> ' }, { promote: nodeId });
  expect(h.nodes().map((n) => n.content)).toEqual(['new']);
  expect(h.text()).toBe('> new\n');
});
