import { expect, test } from 'vitest';
import { MarkdownTree, type InlineEdit } from './view-model.js';
import { viewModel } from './view-model-node.js';
import { findNextEditable } from './view-model-util.js';

const cases: {
  name: string;
  source: string;
  edit: InlineEdit;
  expected: string;
}[] = [
  {
    name: 'insert at the start',
    source: 'abcd',
    edit: { startIndex: 0, oldEndIndex: 0, newEndIndex: 1, newText: 'X' },
    expected: 'Xabcd',
  },
  {
    name: 'insert in the middle',
    source: 'abcd',
    edit: { startIndex: 2, oldEndIndex: 2, newEndIndex: 3, newText: 'X' },
    expected: 'abXcd',
  },
  {
    name: 'insert at the end',
    source: 'abcd',
    edit: { startIndex: 4, oldEndIndex: 4, newEndIndex: 5, newText: 'X' },
    expected: 'abcdX',
  },
  {
    name: 'delete at the start',
    source: 'abcd',
    edit: { startIndex: 0, oldEndIndex: 1, newEndIndex: 0, newText: '' },
    expected: 'bcd',
  },
  {
    name: 'delete in the middle',
    source: 'abcd',
    edit: { startIndex: 1, oldEndIndex: 3, newEndIndex: 1, newText: '' },
    expected: 'ad',
  },
  {
    name: 'delete at the end',
    source: 'abcd',
    edit: { startIndex: 3, oldEndIndex: 4, newEndIndex: 3, newText: '' },
    expected: 'abc',
  },
  {
    name: 'replace in the middle',
    source: 'abcd',
    edit: { startIndex: 1, oldEndIndex: 3, newEndIndex: 3, newText: 'XY' },
    expected: 'aXYd',
  },
  {
    name: 'insert a newline',
    source: 'abcd',
    edit: { startIndex: 2, oldEndIndex: 2, newEndIndex: 3, newText: '\n' },
    expected: 'ab\ncd',
  },
  {
    name: 'replace across lines',
    source: 'ab\ncd',
    edit: { startIndex: 1, oldEndIndex: 4, newEndIndex: 4, newText: 'X\nY' },
    expected: 'aX\nYd',
  },
  {
    name: 'replace a supplementary Unicode character',
    source: 'A😀B',
    edit: { startIndex: 1, oldEndIndex: 3, newEndIndex: 4, newText: '猫😄' },
    expected: 'A猫😄B',
  },
  {
    name: 'delete a supplementary Unicode character',
    source: 'A😀B',
    edit: { startIndex: 1, oldEndIndex: 3, newEndIndex: 1, newText: '' },
    expected: 'AB',
  },
];

test.each(cases)(
  '$name preserves content, identity, focus, and history',
  ({ source, edit, expected }) => {
    const tree = new MarkdownTree({
      type: 'document',
      children: [{ type: 'paragraph', content: source }],
    });
    const inline = findNextEditable(tree.root, tree.root, true)!;

    tree.edit(() => {
      inline[viewModel].edit(edit, false);
      return {
        startFocus: { node: inline, offset: edit.startIndex },
        endFocus: { node: inline, offset: edit.newEndIndex },
      };
    });

    expect(inline.content).toBe(expected);
    expect(findNextEditable(tree.root, tree.root, true)).toBe(inline);
    expect(tree.undo(tree.root)).toEqual({ focus: { node: inline, offset: edit.startIndex } });
    expect(inline.content).toBe(source);
    expect(tree.redo(tree.root)).toEqual({ focus: { node: inline, offset: edit.newEndIndex } });
    expect(inline.content).toBe(expected);
  },
);
