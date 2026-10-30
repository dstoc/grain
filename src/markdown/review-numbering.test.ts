import { expect, test } from 'vitest';
import { MarkdownTree } from './view-model.js';
import { editInlineIndent } from '../editing/edits/indent-inline.js';
import { editBlockSelectionIndent } from '../editing/edits/indent-block-selection.js';
import { insertParagraph } from '../editing/edits/insert-paragraph.js';
import type { EditContext } from '../editing/editor.js';
import { serializeToString } from './block-serializer.js';

const item = (marker: string, content: string) => ({
  type: 'list-item' as const,
  marker,
  children: [{ type: 'paragraph' as const, content }],
});
const text = (tree: MarkdownTree) => serializeToString(tree.serialize());
function checkHistory(tree: MarkdownTree, before: string, after: string) {
  expect(text(tree)).toBe(after);
  tree.undo(tree.root);
  expect(text(tree)).toBe(before);
  tree.redo(tree.root);
  expect(text(tree)).toBe(after);
}

test('inline indent wraps a paragraph into an existing ordered run', () => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      { type: 'list', children: [item('5. ', 'a')] },
      { type: 'paragraph', content: 'b' },
    ],
  });
  const context = {
    node: tree.root.children![1],
    root: tree.root,
    startEditing() {},
    keepFocus() {},
  } as unknown as EditContext;
  const before = text(tree);
  tree.edit(() => {
    editInlineIndent(context, 'indent');
    return {};
  });
  checkHistory(tree, before, '5. a\n6. b\n');
});

test('indent selected paragraphs as a batch into an ordered run', () => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      { type: 'list', children: [item('5. ', 'a')] },
      { type: 'paragraph', content: 'b' },
      { type: 'paragraph', content: 'c' },
    ],
  });
  const context = {
    selection: tree.root.children!.slice(1),
    root: tree.root,
    startEditing() {},
    keepFocus() {},
  } as unknown as EditContext;
  const before = text(tree);
  tree.edit(() => {
    editBlockSelectionIndent(context, 'indent');
    return {};
  });
  checkHistory(tree, before, '5. a\n6. b\n7. c\n');
});

test('Enter in a bullet run retains a bullet marker through undo and redo', () => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [{ type: 'list', children: [item('5. ', 'a'), item('* ', 'b'), item('* ', 'c')] }],
  });
  const node = tree.root.children![0].children![2].children![0];
  const context = {
    node,
    root: tree.root,
    startEditing() {},
    focus() {},
  } as unknown as EditContext;
  const before = text(tree);
  tree.edit(() => {
    insertParagraph(context, 1);
    return {};
  });
  checkHistory(tree, before, '5. a\n* b\n* c\n* <!-- -->\n');
});
