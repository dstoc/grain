import { expect, test } from 'vitest';
import { MarkdownTree } from './view-model.js';
import { type InlineViewModelNode, viewModel } from './view-model-node.js';
import { findNextEditable } from './view-model-util.js';
import { classify } from './view-model-ops.js';

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
  expect(tree.undo(tree.root)).toEqual({ focus: { node: original, offset: 2 } });
  expect(tree.redo(tree.root)).toEqual({ focus: { node: resolved, offset: 0 } });
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
  expect(tree.undo(tree.root)).toEqual({ focus: { node: original, offset: 1 } });
  expect(tree.redo(tree.root)).toEqual({ focus: undefined });
});

test('empty isolated history belongs to its saved focus and survives sibling skips', () => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      { type: 'paragraph', content: 'owner' },
      { type: 'paragraph', content: 'sibling' },
    ],
  });
  const [owner, sibling] = tree.root.children! as InlineViewModelNode[];
  const startFocus = { node: owner, offset: 1, selection: [owner] };
  const endFocus = { node: owner, offset: 5 };

  tree.edit(() => ({ startFocus, endFocus }), true, undefined, undefined, 'isolated', true);

  expect(tree.undo(sibling)).toBeUndefined();
  expect(tree.undo(owner)).toEqual({ focus: startFocus });
  expect(tree.redo(sibling)).toBeUndefined();
  expect(tree.redo(owner)).toEqual({ focus: endFocus });

  expect(tree.undo(owner)).toEqual({ focus: startFocus });
  expect(tree.redo(tree.root)).toEqual({ focus: endFocus });
});

test('history availability mirrors root-scoped undo and redo without consuming batches', () => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      { type: 'paragraph', content: 'owner' },
      { type: 'paragraph', content: 'sibling' },
    ],
  });
  const [owner, sibling] = tree.root.children! as InlineViewModelNode[];

  expect(tree.canUndo(owner)).toBe(false);
  expect(tree.canRedo(owner)).toBe(false);
  tree.edit(() => {
    owner[viewModel].edit({ startIndex: 5, oldEndIndex: 5, newText: '!', newEndIndex: 6 }, false);
    return { startFocus: { node: owner, offset: 5 }, endFocus: { node: owner, offset: 6 } };
  });

  expect(tree.canUndo(owner)).toBe(true);
  expect(tree.canUndo(sibling)).toBe(false);
  expect(tree.canRedo(owner)).toBe(false);
  expect(tree.undo(owner)).toEqual({ focus: { node: owner, offset: 5 } });
  expect(tree.canUndo(owner)).toBe(false);
  expect(tree.canRedo(owner)).toBe(true);
  expect(tree.canRedo(sibling)).toBe(false);
  expect(tree.redo(owner)).toEqual({ focus: { node: owner, offset: 6 } });
  expect(tree.canUndo(owner)).toBe(true);
  expect(tree.canRedo(owner)).toBe(false);
});

test('default no-op history stays empty and operation batches keep node ownership', () => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      { type: 'paragraph', content: 'owner' },
      { type: 'paragraph', content: 'sibling' },
    ],
  });
  const [owner, sibling] = tree.root.children! as InlineViewModelNode[];

  tree.edit(
    () => ({ startFocus: { node: owner, offset: 0 } }),
    true,
    undefined,
    undefined,
    'isolated',
  );
  expect(tree.undo(owner)).toBeUndefined();

  tree.edit(() => {
    owner[viewModel].edit({ startIndex: 5, oldEndIndex: 5, newText: '!', newEndIndex: 6 }, false);
    return { startFocus: { node: owner, offset: 5 }, endFocus: { node: owner, offset: 6 } };
  });
  expect(tree.undo(sibling)).toBeUndefined();
  expect(tree.undo(owner)).toEqual({ focus: { node: owner, offset: 5 } });
  expect(owner.content).toBe('owner');
});

test('empty isolated history for a disconnected owner classifies outside', () => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      { type: 'paragraph', content: 'owner' },
      { type: 'paragraph', content: 'sibling' },
    ],
  });
  const [owner, sibling] = tree.root.children! as InlineViewModelNode[];
  const batch = {
    ops: [],
    timestamp: Date.now(),
    isolated: true,
    startFocus: { node: owner, offset: 0 },
  };
  tree.edit(() => {
    owner[viewModel].remove();
    return {};
  });

  expect(classify(sibling, batch)).toBe('outside');
});
