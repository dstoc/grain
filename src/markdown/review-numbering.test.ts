import { expect, test } from 'vitest';
import { MarkdownTree } from './view-model.js';
import { viewModel } from './view-model-node.js';
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

test('Enter in a normalized ordered list retains numbering through undo and redo', () => {
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
  checkHistory(tree, before, '5. a\n6. b\n7. c\n8. <!-- -->\n');
});

test.each([
  ['2. ', '* ', '2. a\n3. b\n'],
  ['* ', '9) ', '* a\n* b\n'],
  ['5) ', '20. ', '5) a\n6) b\n'],
])('merging lists uses the first list marker (%s, %s)', (first, second, after) => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      { type: 'list', children: [item(first, 'a')] },
      { type: 'paragraph', content: 'separator' },
      { type: 'list', children: [item(second, 'b')] },
    ],
  });
  const before = text(tree);
  tree.edit(() => {
    tree.root.children![1][viewModel].remove();
    return {};
  });
  checkHistory(tree, before, after);
});
