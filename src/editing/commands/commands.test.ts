import { afterEach, describe, expect, it } from 'vitest';

import { CanonicalWriter } from '../../markdown/canonical-actions.js';
import { CanonicalDocument } from '../../markdown/canonical-model.js';
import type { CanonicalNode } from '../../markdown/canonical-model.js';
import { deleteBackwardAtStart } from './delete-backward.js';
import { indent } from './indent.js';
import { insertLineBreak } from './insert-line-break.js';
import { insertMarkdown } from './insert-markdown.js';
import { insertParagraph } from './insert-paragraph.js';
import { joinWithPrevious } from './join-with-previous.js';
import { outdent } from './outdent.js';
import { replaceBlocks } from './replace-blocks.js';
import { wrap } from './wrap.js';
import type { EditSelection } from '../../markdown/semantic/selection.js';
import type { Edit } from '../outcomes.js';
import { runCommand } from '../test/run-command.js';

let documentOrdinal = 0;
const documents: CanonicalDocument[] = [];
const writers: CanonicalWriter[] = [];

function create(markdown: string) {
  const id = ++documentOrdinal;
  const document = CanonicalDocument.fromMarkdown(markdown, {
    documentId: `canonical-edit-${id}`,
    actionId: `canonical-edit-import-${id}`,
    authorityEpoch: 'canonical-edit-epoch',
  });
  const writer = new CanonicalWriter(document);
  documents.push(document);
  writers.push(writer);
  return { document, writer };
}

function walk(node: CanonicalNode): CanonicalNode[] {
  return [node, ...node.children.flatMap(walk)];
}

function inlineNodes(document: CanonicalDocument, type?: CanonicalNode['type']) {
  return walk(document.root).filter(
    (node) =>
      ['paragraph', 'section', 'code-block'].includes(node.type) &&
      (type === undefined || node.type === type),
  );
}

function commitEdit<Input>(
  writer: CanonicalWriter,
  document: CanonicalDocument,
  actionId: string,
  command: Edit<Input>,
  input: Input,
  selectionBefore?: EditSelection,
  sessionId?: string,
) {
  const result = runCommand(
    writer,
    { actionId, ...(sessionId ? { sessionId } : {}) },
    document.root.sharedId,
    selectionBefore,
    command,
    input,
  );
  if (!result) throw new Error('edit command was not applicable');
  return result;
}

function textSelection(nodeId: string, anchor: number, focus = anchor): EditSelection {
  return {
    anchor: { nodeId, offset: anchor, affinity: anchor <= focus ? 'left' : 'right' },
    focus: { nodeId, offset: focus, affinity: focus >= anchor ? 'right' : 'left' },
  };
}

afterEach(() => {
  for (const writer of writers.splice(0)) writer.close();
  for (const document of documents.splice(0)) document.close();
});

describe('canonical editing commands', () => {
  it('splits a paragraph by transferring its tail and swaps identity at offset zero', () => {
    const { document, writer } = create('abcd\n');
    const [original] = inlineNodes(document, 'paragraph');
    expect(original).toBeDefined();
    const originalTapeIds = document
      .canonicalSnapshot()
      .nodes.find((node) => node.id === original!.sharedId)!
      .spans.map((span) => span.tapeId);

    commitEdit(
      writer,
      document,
      'split-interior',
      insertParagraph,
      {
        nodeId: original!.sharedId,
        from: 2,
      },
      textSelection(original!.sharedId, 2),
    );
    let paragraphs = inlineNodes(document, 'paragraph');
    expect(paragraphs.map((node) => node.content)).toEqual(['ab', 'cd']);
    expect(paragraphs[0]!.sharedId).toBe(original!.sharedId);
    const tail = paragraphs[1]!;
    expect(
      document
        .canonicalSnapshot()
        .nodes.find((node) => node.id === tail.sharedId)!
        .spans.some((span) => originalTapeIds.includes(span.tapeId)),
    ).toBe(true);

    commitEdit(
      writer,
      document,
      'split-at-zero',
      insertParagraph,
      {
        nodeId: paragraphs[0]!.sharedId,
        from: 0,
      },
      textSelection(paragraphs[0]!.sharedId, 0),
    );
    paragraphs = inlineNodes(document, 'paragraph');
    expect(paragraphs.map((node) => node.content)).toEqual(['', 'ab', 'cd']);
    expect(paragraphs[1]!.sharedId).toBe(original!.sharedId);
    expect(paragraphs[2]!.sharedId).toBe(tail.sharedId);
    expect(document.validate().valid).toBe(true);
  });

  it('keeps Shift+Enter selection behavior and extracts an interior code line', () => {
    const { document, writer } = create('abcd\n');
    const [paragraph] = inlineNodes(document, 'paragraph');
    commitEdit(
      writer,
      document,
      'line-break-selection',
      insertLineBreak,
      {
        nodeId: paragraph!.sharedId,
        from: 1,
        to: 3,
      },
      textSelection(paragraph!.sharedId, 1, 3),
    );
    expect(inlineNodes(document, 'paragraph').map((node) => node.content)).toEqual(['a', 'bcd']);

    const codeDoc = create('```ts\nabcdef\n```\n');
    const [code] = inlineNodes(codeDoc.document, 'code-block');
    commitEdit(
      codeDoc.writer,
      codeDoc.document,
      'code-line-break',
      insertLineBreak,
      {
        nodeId: code!.sharedId,
        from: 2,
        to: 4,
      },
      textSelection(code!.sharedId, 2, 4),
    );
    const output = inlineNodes(codeDoc.document);
    expect(output.map(({ type, content, info }) => [type, content, info])).toEqual([
      ['code-block', 'ab', 'ts'],
      ['paragraph', '', undefined],
      ['code-block', 'ef', 'ts'],
    ]);
    expect(codeDoc.document.validate().valid).toBe(true);
  });

  it('creates list items on Enter and preserves the right item ID at split zero', () => {
    const { document, writer } = create('* alpha\n* beta\n');
    const [first, second] = inlineNodes(document, 'paragraph');
    const originalId = first!.sharedId;
    commitEdit(
      writer,
      document,
      'list-enter',
      insertParagraph,
      {
        nodeId: first!.sharedId,
        from: 2,
      },
      textSelection(first!.sharedId, 2),
    );
    expect(inlineNodes(document, 'paragraph').map((node) => node.content)).toEqual([
      'al',
      'pha',
      'beta',
    ]);

    const [alpha, alphaTail] = inlineNodes(document, 'paragraph');
    commitEdit(
      writer,
      document,
      'list-enter-zero',
      insertParagraph,
      {
        nodeId: alpha!.sharedId,
        from: 0,
      },
      textSelection(alpha!.sharedId, 0),
    );
    const paragraphs = inlineNodes(document, 'paragraph');
    expect(paragraphs.map((node) => node.content)).toEqual(['', 'al', 'pha', 'beta']);
    expect(paragraphs[1]!.sharedId).toBe(originalId);
    expect(paragraphs[2]!.sharedId).toBe(alphaTail!.sharedId);
    expect(paragraphs[3]!.sharedId).toBe(second!.sharedId);
    expect(document.validate().valid).toBe(true);
  });

  it('splits empty quote and list-item containers while preserving trailing blocks', () => {
    const quote = create('> first\n> \n> tail\n');
    const quoteParagraph = inlineNodes(quote.document, 'paragraph')[1]!;
    commitEdit(
      quote.writer,
      quote.document,
      'quote-empty-enter',
      insertParagraph,
      {
        nodeId: quoteParagraph.sharedId,
        from: 0,
      },
      textSelection(quoteParagraph.sharedId, 0),
    );
    expect(inlineNodes(quote.document, 'paragraph').map((node) => node.content)).toEqual([
      'first',
      '',
      'tail',
    ]);
    expect(quote.document.validate().valid).toBe(true);

    const list = create('* first\n* \n* tail\n');
    const emptyParagraph = inlineNodes(list.document, 'paragraph')[1]!;
    commitEdit(
      list.writer,
      list.document,
      'list-empty-enter',
      insertParagraph,
      {
        nodeId: emptyParagraph.sharedId,
        from: 0,
      },
      textSelection(emptyParagraph.sharedId, 0),
    );
    expect(inlineNodes(list.document, 'paragraph').map((node) => node.content)).toEqual([
      'first',
      '',
      'tail',
    ]);
    expect(list.document.validate().valid).toBe(true);
  });

  it('splits sections and performs quote-local and root-list Backspace operations', () => {
    const sectionDoc = create('# heading\nbody\n');
    const [section] = inlineNodes(sectionDoc.document, 'section');
    const sectionId = section!.sharedId;
    commitEdit(
      sectionDoc.writer,
      sectionDoc.document,
      'section-enter-zero',
      insertParagraph,
      {
        nodeId: sectionId,
        from: 0,
      },
      textSelection(sectionId, 0),
    );
    expect(sectionDoc.document.root.children.map((node) => [node.type, node.content])).toEqual([
      ['paragraph', ''],
      ['section', 'heading'],
    ]);
    expect(sectionDoc.document.node(sectionId).children.map((node) => node.content)).toEqual([
      'body',
    ]);

    const quoteDoc = create('> one\n>\n> two\n');
    let quoteParagraphs = inlineNodes(quoteDoc.document, 'paragraph');
    commitEdit(
      quoteDoc.writer,
      quoteDoc.document,
      'quote-backspace-join',
      deleteBackwardAtStart,
      {
        nodeId: quoteParagraphs[1]!.sharedId,
      },
      textSelection(quoteParagraphs[1]!.sharedId, 0),
    );
    expect(inlineNodes(quoteDoc.document, 'paragraph').map((node) => node.content)).toEqual([
      'onetwo',
    ]);
    quoteParagraphs = inlineNodes(quoteDoc.document, 'paragraph');
    commitEdit(
      quoteDoc.writer,
      quoteDoc.document,
      'quote-backspace-unwrap',
      deleteBackwardAtStart,
      {
        nodeId: quoteParagraphs[0]!.sharedId,
      },
      textSelection(quoteParagraphs[0]!.sharedId, 0),
    );
    expect(quoteDoc.document.exportMarkdownTree().children?.map((node) => node.type)).toEqual([
      'paragraph',
    ]);
    expect(quoteDoc.document.validate().valid).toBe(true);

    const listDoc = create('* first\n* second\n');
    const first = inlineNodes(listDoc.document, 'paragraph')[0]!;
    commitEdit(
      listDoc.writer,
      listDoc.document,
      'root-first-list-backspace',
      deleteBackwardAtStart,
      {
        nodeId: first.sharedId,
      },
      textSelection(first.sharedId, 0),
    );
    expect(listDoc.document.exportMarkdownTree().children?.map((node) => node.type)).toEqual([
      'paragraph',
      'list',
    ]);
    expect(inlineNodes(listDoc.document, 'paragraph')[0]!.sharedId).toBe(first.sharedId);
    expect(listDoc.document.validate().valid).toBe(true);
  });

  it('demotes a section in place and joins a previous block at the text seam', () => {
    const sectionDoc = create('# title\nbody\n');
    const [section] = inlineNodes(sectionDoc.document, 'section');
    const sectionId = section!.sharedId;
    commitEdit(
      sectionDoc.writer,
      sectionDoc.document,
      'demote-section',
      deleteBackwardAtStart,
      {
        nodeId: sectionId,
      },
      textSelection(sectionId, 0),
    );
    expect(sectionDoc.document.node(sectionId).type).toBe('paragraph');
    expect(sectionDoc.document.node(sectionId).content).toBe('title');
    expect(inlineNodes(sectionDoc.document, 'paragraph').map((node) => node.content)).toEqual([
      'title',
      'body',
    ]);

    const joinDoc = create('left\n\nright\n');
    const [left, right] = inlineNodes(joinDoc.document, 'paragraph');
    const joined = commitEdit(
      joinDoc.writer,
      joinDoc.document,
      'join-backspace',
      deleteBackwardAtStart,
      {
        nodeId: right!.sharedId,
      },
      textSelection(right!.sharedId, 0),
    );
    expect(inlineNodes(joinDoc.document, 'paragraph').map((node) => node.content)).toEqual([
      'leftright',
    ]);
    expect(inlineNodes(joinDoc.document, 'paragraph')[0]!.sharedId).toBe(left!.sharedId);
    expect(joined.receipt.focus?.end).toMatchObject({ nodeId: left!.sharedId, offset: 4 });
    expect(joinDoc.document.validate().valid).toBe(true);
  });

  it('demotes code in place and preserves list and quote wrapping identity', () => {
    const codeDoc = create('```js\nbody\n```\n');
    const [code] = inlineNodes(codeDoc.document, 'code-block');
    const codeId = code!.sharedId;
    commitEdit(
      codeDoc.writer,
      codeDoc.document,
      'demote-code',
      deleteBackwardAtStart,
      {
        nodeId: codeId,
      },
      textSelection(codeId, 0),
    );
    expect(codeDoc.document.node(codeId).type).toBe('paragraph');
    expect(codeDoc.document.node(codeId).content).toBe('body');

    const wrapDoc = create('body\n');
    const [body] = inlineNodes(wrapDoc.document, 'paragraph');
    commitEdit(
      wrapDoc.writer,
      wrapDoc.document,
      'wrap-quote',
      wrap,
      {
        nodeId: body!.sharedId,
        wrapper: 'block-quote',
      },
      textSelection(body!.sharedId, 0),
    );
    expect(inlineNodes(wrapDoc.document, 'paragraph')[0]!.sharedId).toBe(body!.sharedId);
    expect(wrapDoc.document.exportMarkdownTree().children?.[0]?.type).toBe('block-quote');
    const listWrapDoc = create('listed\n');
    const [listed] = inlineNodes(listWrapDoc.document, 'paragraph');
    commitEdit(
      listWrapDoc.writer,
      listWrapDoc.document,
      'wrap-list',
      wrap,
      {
        nodeId: listed!.sharedId,
        wrapper: 'list-item',
      },
      textSelection(listed!.sharedId, 0),
    );
    expect(listWrapDoc.document.exportMarkdownTree().children?.[0]?.type).toBe('list');
    expect(inlineNodes(listWrapDoc.document, 'paragraph')[0]!.sharedId).toBe(listed!.sharedId);
    expect(wrapDoc.document.validate().valid).toBe(true);
    expect(listWrapDoc.document.validate().valid).toBe(true);
  });

  it('indents, unindents, and replaces selected blocks through draft operations', () => {
    const indentDoc = create('one\n\ntwo\n');
    const [one, two] = inlineNodes(indentDoc.document, 'paragraph');
    commitEdit(
      indentDoc.writer,
      indentDoc.document,
      'indent',
      indent,
      {
        nodeId: two!.sharedId,
      },
      textSelection(two!.sharedId, 0),
    );
    expect(indentDoc.document.exportMarkdownTree().children?.map((node) => node.type)).toEqual([
      'paragraph',
      'list',
    ]);
    expect(inlineNodes(indentDoc.document, 'paragraph')[1]!.sharedId).toBe(two!.sharedId);
    commitEdit(
      indentDoc.writer,
      indentDoc.document,
      'unindent',
      outdent,
      {
        nodeId: two!.sharedId,
      },
      textSelection(two!.sharedId, 0),
    );
    expect(inlineNodes(indentDoc.document, 'paragraph').map((node) => node.content)).toEqual([
      'one',
      'two',
    ]);
    expect(inlineNodes(indentDoc.document, 'paragraph')[0]!.sharedId).toBe(one!.sharedId);
    expect(inlineNodes(indentDoc.document, 'paragraph')[1]!.sharedId).toBe(two!.sharedId);

    const replaceDoc = create('first\n\nsecond\n');
    const [first, second] = inlineNodes(replaceDoc.document, 'paragraph');
    commitEdit(replaceDoc.writer, replaceDoc.document, 'replace-selection', replaceBlocks, {
      nodeIds: [second!.sharedId, first!.sharedId],
      text: 'new',
    });
    expect(inlineNodes(replaceDoc.document, 'paragraph').map((node) => node.content)).toEqual([
      'new',
    ]);
    expect(inlineNodes(replaceDoc.document, 'paragraph')[0]!.sharedId).toBe(first!.sharedId);
    expect(replaceDoc.document.node(second!.sharedId).connected).toBe(false);
    expect(replaceDoc.document.validate().valid).toBe(true);
  });

  it('splits a checked task with its marker and an unchecked continuation', () => {
    const { document, writer } = create('- [x] task\n- next\n');
    const list = document.root.children[0]!;
    const firstItem = list.children[0]!;
    const originalParagraph = firstItem.children[0]!;
    commitEdit(
      writer,
      document,
      'split-task',
      insertParagraph,
      {
        nodeId: originalParagraph.sharedId,
        from: 2,
      },
      textSelection(originalParagraph.sharedId, 2),
    );

    expect(
      list.children.map((item) => [item.marker, item.checked, item.children[0]!.content]),
    ).toEqual([
      ['- ', true, 'ta'],
      ['- ', false, 'sk'],
      ['- ', undefined, 'next'],
    ]);
    expect(document.validate().valid).toBe(true);
    expect(writer.undo().status).toBe('applied');
    expect(list.children.map((item) => [item.checked, item.children[0]!.content])).toEqual([
      [true, 'task'],
      [undefined, 'next'],
    ]);
    expect(writer.redo().status).toBe('applied');
    expect(document.validate().valid).toBe(true);
  });

  it('copies pasted Markdown into new nodes and joins literal text without reparsing', () => {
    const pasted = create('anchor\n');
    const anchor = pasted.document.root.children[0]!;
    const oldTapeIds = new Set(
      pasted.document
        .canonicalSnapshot()
        .nodes.flatMap((node) => node.spans.map((span) => span.tapeId)),
    );
    const inserted = commitEdit(
      pasted.writer,
      pasted.document,
      'paste-markdown',
      insertMarkdown,
      {
        contextId: anchor.sharedId,
        markdown: 'pasted\n\n* list item',
      },
      textSelection(anchor.sharedId, anchor.content!.length),
    );
    const newNodes = pasted.document
      .canonicalSnapshot()
      .nodes.filter((node) =>
        ['pasted', 'list item'].includes(pasted.document.node(node.id).content ?? ''),
      );
    expect(newNodes.length).toBe(2);
    expect(newNodes.every((node) => node.spans.every((span) => !oldTapeIds.has(span.tapeId)))).toBe(
      true,
    );
    expect(inserted.receipt.focus?.end?.offset).toBe('list item'.length);
    expect(pasted.document.root.children.map((node) => node.type)).toEqual([
      'paragraph',
      'paragraph',
      'list',
    ]);

    const literal = create('left\n');
    const left = literal.document.root.children[0]!;
    let literalId = '';
    const created = literal.writer.edit({ actionId: 'create-literal-paragraph' }, (draft) => {
      literalId = draft.create({ type: 'paragraph', content: '# heading' });
      draft.place(literalId, literal.document.root.sharedId, null);
    });
    expect('receipt' in created).toBe(true);
    commitEdit(
      literal.writer,
      literal.document,
      'join-literal',
      joinWithPrevious,
      { nodeId: literalId },
      textSelection(literalId, 0),
    );
    expect(left.type).toBe('paragraph');
    expect(left.content).toBe('left# heading');
    expect(literal.document.validate().valid).toBe(true);
  });

  it('undoes and redoes typing after a later split without losing transferred text', () => {
    const { document, writer } = create('ab\n');
    const [paragraph] = inlineNodes(document, 'paragraph');
    const typing = writer.prepareTextInput(
      paragraph!.sharedId,
      { from: 1, to: 1, insert: 'XY' },
      { actionId: 'older-typing', sessionId: 'author-a', historyGroupId: 'typing' },
    );
    writer.admitSession('author-a');
    const applied = writer.apply(typing, {
      sessionId: 'author-a',
      authorityEpoch: typing.authorityEpoch,
      sessionSequence: typing.sessionSequence,
    });
    expect(applied.status).toBe('pending');
    if (applied.status !== 'pending') throw new Error(`typing did not stage: ${applied.status}`);
    writer.publish(applied.pending);
    writer.sealTextGroup('author-a');

    commitEdit(
      writer,
      document,
      'later-split',
      insertParagraph,
      { nodeId: paragraph!.sharedId, from: 2 },
      textSelection(paragraph!.sharedId, 2),
      'author-b',
    );

    expect(inlineNodes(document, 'paragraph').map((node) => node.content)).toEqual(['aX', 'Yb']);
    expect(writer.undo('author-a').status).toBe('applied');
    expect(inlineNodes(document, 'paragraph').map((node) => node.content)).toEqual(['a', 'b']);
    expect(writer.redo('author-a').status).toBe('applied');
    expect(inlineNodes(document, 'paragraph').map((node) => node.content)).toEqual(['aX', 'Yb']);
    expect(document.validate().valid).toBe(true);
  });

  it('undoes and redoes typing after its block joins a different tape', () => {
    const { document, writer } = create('left\n\nright\n');
    const [left, right] = inlineNodes(document, 'paragraph');
    const typing = writer.prepareTextInput(
      right!.sharedId,
      { from: 1, to: 1, insert: 'X' },
      { actionId: 'typing-before-join', sessionId: 'author-a', historyGroupId: 'typing' },
    );
    writer.admitSession('author-a');
    const typed = writer.apply(typing, {
      sessionId: 'author-a',
      authorityEpoch: typing.authorityEpoch,
      sessionSequence: typing.sessionSequence,
    });
    if (typed.status !== 'pending') throw new Error(`typing did not stage: ${typed.status}`);
    writer.publish(typed.pending);
    writer.sealTextGroup('author-a');

    commitEdit(
      writer,
      document,
      'later-join',
      deleteBackwardAtStart,
      { nodeId: right!.sharedId },
      textSelection(right!.sharedId, 0),
      'author-b',
    );

    expect(inlineNodes(document, 'paragraph').map((node) => node.content)).toEqual(['leftrXight']);
    expect(inlineNodes(document, 'paragraph')[0]!.sharedId).toBe(left!.sharedId);
    expect(writer.undo('author-a').status).toBe('applied');
    expect(inlineNodes(document, 'paragraph').map((node) => node.content)).toEqual(['leftright']);
    expect(writer.redo('author-a').status).toBe('applied');
    expect(inlineNodes(document, 'paragraph').map((node) => node.content)).toEqual(['leftrXight']);
    expect(document.validate().valid).toBe(true);
  });

  it('applies scoped undo to its own block and blocks when a split makes the tape mixed', () => {
    const { document, writer } = create('left\n\nright\n');
    const [left, right] = inlineNodes(document, 'paragraph');
    const leftInput = writer.prepareTextInput(
      left!.sharedId,
      { from: 4, to: 4, insert: 'X' },
      { actionId: 'scoped-left-edit', sessionId: 'A', historyGroupId: 'left' },
    );
    writer.admitSession('A');
    const leftResult = writer.apply(leftInput, {
      sessionId: 'A',
      authorityEpoch: leftInput.authorityEpoch,
      sessionSequence: leftInput.sessionSequence,
    });
    if (leftResult.status !== 'pending')
      throw new Error(`left edit did not stage: ${leftResult.status}`);
    writer.publish(leftResult.pending);
    writer.sealTextGroup('A');
    const rightInput = writer.prepareTextInput(
      right!.sharedId,
      { from: 0, to: 0, insert: 'Y' },
      { actionId: 'scoped-right-edit', sessionId: 'A', historyGroupId: 'right' },
    );
    writer.admitSession('A');
    const rightResult = writer.apply(rightInput, {
      sessionId: 'A',
      authorityEpoch: rightInput.authorityEpoch,
      sessionSequence: rightInput.sessionSequence,
    });
    if (rightResult.status !== 'pending')
      throw new Error(`right edit did not stage: ${rightResult.status}`);
    writer.publish(rightResult.pending);

    expect(writer.undo('A', left!.sharedId).status).toBe('applied');
    expect(left!.content).toBe('left');
    expect(right!.content).toBe('Yright');
    expect(writer.undo('A', left!.sharedId).status).toBe('empty');

    commitEdit(
      writer,
      document,
      'scope-split',
      insertParagraph,
      { nodeId: right!.sharedId, from: 1 },
      textSelection(right!.sharedId, 1),
      'B',
    );
    // The remaining A entry belongs to the right tape, now split across both blocks.
    expect(writer.undo('A', right!.sharedId)).toMatchObject({
      status: 'blocked',
      reason: 'mixed-scope',
    });
    expect(document.validate().valid).toBe(true);
  });
});
