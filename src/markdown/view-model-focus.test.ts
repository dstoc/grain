import { expect, test } from 'vitest';
import { MarkdownTree } from './view-model.js';
import { viewModel } from './view-model-node.js';
import { findNextEditable } from './view-model-util.js';

test('resolves focus after normalization and records it for redo', () => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [{ type: 'paragraph', content: 'hello' }],
  });
  const original = findNextEditable(tree.root, tree.root, true)!;
  let resolved = original;
  tree.edit(
    () => {
      original[viewModel].remove();
      return { startFocus: { node: original, offset: 2 } };
    },
    true,
    undefined,
    (focus, hasOperations) => {
      expect(focus).toBeUndefined();
      expect(hasOperations).toBe(true);
      resolved = findNextEditable(tree.root, tree.root, true)!;
      expect(resolved.content).toBe('');
      return { node: resolved, offset: 0 };
    },
  );
  expect(tree.undo(tree.root)).toEqual({ node: original, offset: 2 });
  expect(tree.redo(tree.root)).toEqual({ node: resolved, offset: 0 });
});

test('edits without a resolver preserve their focus and history behavior', () => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [{ type: 'paragraph', content: 'hello' }],
  });
  const original = findNextEditable(tree.root, tree.root, true)!;
  tree.edit(() => {
    original[viewModel].remove();
    return { startFocus: { node: original, offset: 1 } };
  });
  expect(tree.undo(tree.root)).toEqual({ node: original, offset: 1 });
  expect(tree.redo(tree.root)).toBeUndefined();
});
