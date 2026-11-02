import { afterEach, describe, expect, it } from 'vitest';

import {
  deleteContentBackwards,
  editIndent,
  insertLineBreak,
  insertParagraph,
  replaceSelectedBlocks,
  wrapInline,
} from './canonical-edits.js';
import { CanonicalWriter } from '../markdown/canonical-actions.js';
import { CanonicalDocument } from '../markdown/canonical-model.js';
import type { CanonicalNode } from '../markdown/canonical-model.js';

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

function commit(
  writer: CanonicalWriter,
  actionId: string,
  callback: Parameters<CanonicalWriter['edit']>[1],
) {
  const result = writer.edit({ actionId }, callback);
  if (!('receipt' in result)) throw new Error(`edit was not accepted: ${JSON.stringify(result)}`);
  return result;
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

    commit(writer, 'split-interior', (draft) =>
      insertParagraph(draft, document.root.sharedId, original!.sharedId, 2),
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

    commit(writer, 'split-at-zero', (draft) =>
      insertParagraph(draft, document.root.sharedId, paragraphs[0]!.sharedId, 0),
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
    commit(writer, 'line-break-selection', (draft) =>
      insertLineBreak(draft, document.root.sharedId, paragraph!.sharedId, 1, 3),
    );
    expect(inlineNodes(document, 'paragraph').map((node) => node.content)).toEqual(['a', 'bcd']);

    const codeDoc = create('```ts\nabcdef\n```\n');
    const [code] = inlineNodes(codeDoc.document, 'code-block');
    commit(codeDoc.writer, 'code-line-break', (draft) =>
      insertLineBreak(draft, codeDoc.document.root.sharedId, code!.sharedId, 2, 4),
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
    commit(writer, 'list-enter', (draft) =>
      insertParagraph(draft, document.root.sharedId, first!.sharedId, 2),
    );
    expect(inlineNodes(document, 'paragraph').map((node) => node.content)).toEqual([
      'al',
      'pha',
      'beta',
    ]);

    const [alpha, alphaTail] = inlineNodes(document, 'paragraph');
    commit(writer, 'list-enter-zero', (draft) =>
      insertParagraph(draft, document.root.sharedId, alpha!.sharedId, 0),
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
    commit(quote.writer, 'quote-empty-enter', (draft) =>
      insertParagraph(draft, quote.document.root.sharedId, quoteParagraph.sharedId, 0),
    );
    expect(inlineNodes(quote.document, 'paragraph').map((node) => node.content)).toEqual([
      'first',
      '',
      'tail',
    ]);
    expect(quote.document.validate().valid).toBe(true);

    const list = create('* first\n* \n* tail\n');
    const emptyParagraph = inlineNodes(list.document, 'paragraph')[1]!;
    commit(list.writer, 'list-empty-enter', (draft) =>
      insertParagraph(draft, list.document.root.sharedId, emptyParagraph.sharedId, 0),
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
    commit(sectionDoc.writer, 'section-enter-zero', (draft) =>
      insertParagraph(draft, sectionDoc.document.root.sharedId, sectionId, 0),
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
    commit(quoteDoc.writer, 'quote-backspace-join', (draft) =>
      deleteContentBackwards(draft, quoteDoc.document.root.sharedId, quoteParagraphs[1]!.sharedId),
    );
    expect(inlineNodes(quoteDoc.document, 'paragraph').map((node) => node.content)).toEqual([
      'onetwo',
    ]);
    quoteParagraphs = inlineNodes(quoteDoc.document, 'paragraph');
    commit(quoteDoc.writer, 'quote-backspace-unwrap', (draft) =>
      deleteContentBackwards(draft, quoteDoc.document.root.sharedId, quoteParagraphs[0]!.sharedId),
    );
    expect(quoteDoc.document.exportMarkdownTree().children?.map((node) => node.type)).toEqual([
      'paragraph',
    ]);
    expect(quoteDoc.document.validate().valid).toBe(true);

    const listDoc = create('* first\n* second\n');
    const first = inlineNodes(listDoc.document, 'paragraph')[0]!;
    commit(listDoc.writer, 'root-first-list-backspace', (draft) =>
      deleteContentBackwards(draft, listDoc.document.root.sharedId, first.sharedId),
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
    commit(sectionDoc.writer, 'demote-section', (draft) =>
      deleteContentBackwards(draft, sectionDoc.document.root.sharedId, sectionId),
    );
    expect(sectionDoc.document.node(sectionId).type).toBe('paragraph');
    expect(sectionDoc.document.node(sectionId).content).toBe('title');
    expect(inlineNodes(sectionDoc.document, 'paragraph').map((node) => node.content)).toEqual([
      'title',
      'body',
    ]);

    const joinDoc = create('left\n\nright\n');
    const [left, right] = inlineNodes(joinDoc.document, 'paragraph');
    const joined = commit(joinDoc.writer, 'join-backspace', (draft) =>
      deleteContentBackwards(draft, joinDoc.document.root.sharedId, right!.sharedId),
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
    commit(codeDoc.writer, 'demote-code', (draft) =>
      deleteContentBackwards(draft, codeDoc.document.root.sharedId, codeId),
    );
    expect(codeDoc.document.node(codeId).type).toBe('paragraph');
    expect(codeDoc.document.node(codeId).content).toBe('body');

    const wrapDoc = create('body\n');
    const [body] = inlineNodes(wrapDoc.document, 'paragraph');
    commit(wrapDoc.writer, 'wrap-quote', (draft) =>
      wrapInline(draft, wrapDoc.document.root.sharedId, body!.sharedId, 'block-quote'),
    );
    expect(inlineNodes(wrapDoc.document, 'paragraph')[0]!.sharedId).toBe(body!.sharedId);
    expect(wrapDoc.document.exportMarkdownTree().children?.[0]?.type).toBe('block-quote');
    const listWrapDoc = create('listed\n');
    const [listed] = inlineNodes(listWrapDoc.document, 'paragraph');
    commit(listWrapDoc.writer, 'wrap-list', (draft) =>
      wrapInline(draft, listWrapDoc.document.root.sharedId, listed!.sharedId, 'list-item'),
    );
    expect(listWrapDoc.document.exportMarkdownTree().children?.[0]?.type).toBe('list');
    expect(inlineNodes(listWrapDoc.document, 'paragraph')[0]!.sharedId).toBe(listed!.sharedId);
    expect(wrapDoc.document.validate().valid).toBe(true);
    expect(listWrapDoc.document.validate().valid).toBe(true);
  });

  it('indents, unindents, and replaces selected blocks through draft operations', () => {
    const indentDoc = create('one\n\ntwo\n');
    const [one, two] = inlineNodes(indentDoc.document, 'paragraph');
    commit(indentDoc.writer, 'indent', (draft) =>
      editIndent(draft, indentDoc.document.root.sharedId, two!.sharedId, 'indent'),
    );
    expect(indentDoc.document.exportMarkdownTree().children?.map((node) => node.type)).toEqual([
      'paragraph',
      'list',
    ]);
    expect(inlineNodes(indentDoc.document, 'paragraph')[1]!.sharedId).toBe(two!.sharedId);
    commit(indentDoc.writer, 'unindent', (draft) =>
      editIndent(draft, indentDoc.document.root.sharedId, two!.sharedId, 'unindent'),
    );
    expect(inlineNodes(indentDoc.document, 'paragraph').map((node) => node.content)).toEqual([
      'one',
      'two',
    ]);
    expect(inlineNodes(indentDoc.document, 'paragraph')[0]!.sharedId).toBe(one!.sharedId);
    expect(inlineNodes(indentDoc.document, 'paragraph')[1]!.sharedId).toBe(two!.sharedId);

    const replaceDoc = create('first\n\nsecond\n');
    const [first, second] = inlineNodes(replaceDoc.document, 'paragraph');
    commit(replaceDoc.writer, 'replace-selection', (draft) =>
      replaceSelectedBlocks(
        draft,
        replaceDoc.document.root.sharedId,
        [second!.sharedId, first!.sharedId],
        'new',
      ),
    );
    expect(inlineNodes(replaceDoc.document, 'paragraph').map((node) => node.content)).toEqual([
      'new',
    ]);
    expect(inlineNodes(replaceDoc.document, 'paragraph')[0]!.sharedId).toBe(first!.sharedId);
    expect(replaceDoc.document.node(second!.sharedId).connected).toBe(false);
    expect(replaceDoc.document.validate().valid).toBe(true);
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

    const split = writer.prepareCommand(
      { actionId: 'later-split', sessionId: 'author-b' },
      (draft) => insertParagraph(draft, document.root.sharedId, paragraph!.sharedId, 2),
    );
    writer.admitSession('author-b');
    const splitResult = writer.apply(split, {
      sessionId: 'author-b',
      authorityEpoch: split.authorityEpoch,
      sessionSequence: split.sessionSequence,
    });
    expect(splitResult.status).toBe('pending');
    if (splitResult.status !== 'pending')
      throw new Error(`split did not stage: ${splitResult.status}`);
    writer.publish(splitResult.pending);

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

    const join = writer.prepareCommand({ actionId: 'later-join', sessionId: 'author-b' }, (draft) =>
      deleteContentBackwards(draft, document.root.sharedId, right!.sharedId),
    );
    writer.admitSession('author-b');
    const joined = writer.apply(join, {
      sessionId: 'author-b',
      authorityEpoch: join.authorityEpoch,
      sessionSequence: join.sessionSequence,
    });
    if (joined.status !== 'pending') throw new Error(`join did not stage: ${joined.status}`);
    writer.publish(joined.pending);

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

    const split = writer.prepareCommand({ actionId: 'scope-split', sessionId: 'B' }, (draft) =>
      insertParagraph(draft, document.root.sharedId, right!.sharedId, 1),
    );
    writer.admitSession('B');
    const splitResult = writer.apply(split, {
      sessionId: 'B',
      authorityEpoch: split.authorityEpoch,
      sessionSequence: split.sessionSequence,
    });
    if (splitResult.status !== 'pending')
      throw new Error(`split did not stage: ${splitResult.status}`);
    writer.publish(splitResult.pending);
    // The remaining A entry belongs to the right tape, now split across both blocks.
    expect(writer.undo('A', right!.sharedId)).toMatchObject({
      status: 'blocked',
      reason: 'mixed-scope',
    });
    expect(document.validate().valid).toBe(true);
  });
});
