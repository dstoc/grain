import { expect, test } from 'vitest';
import { createBlockParser } from './block-parser/api.js';
import { findNextEditable } from './view-model-util.js';
import { viewModel } from './view-model-node.js';
import { serializeToString } from './block-serializer.js';

function edit(tree: ReturnType<ReturnType<typeof createBlockParser>['getTree']>) {
  const node = findNextEditable(tree.root, tree.root, true)!;
  tree.edit(() => {
    node[viewModel].edit({ startIndex: 0, oldEndIndex: 0, newEndIndex: 1, newText: 'Q' });
    return {};
  });
}

test.each(['full', 'chunked', 'resumed'])('construction is not undoable: %s', (mode) => {
  let parser = createBlockParser();
  if (mode === 'full') parser.push('alpha');
  else {
    parser.push('al');
    if (mode === 'resumed') parser = createBlockParser(parser.snapshot());
    parser.push('pha');
  }
  const tree = parser.finish();
  const source = serializeToString(tree.serialize());
  expect(tree.undo(tree.root)).toBeUndefined();
  expect(serializeToString(tree.serialize())).toBe(source);
  edit(tree);
  expect(tree.undo(tree.root)).toBeDefined();
  expect(serializeToString(tree.serialize())).toBe(source);
  expect(tree.redo(tree.root)).toBeDefined();
  expect(serializeToString(tree.serialize())).toContain('Qalpha');
});

test('parser mutations invalidate history but empty input preserves it', () => {
  const parser = createBlockParser();
  parser.push('alpha\n');
  const tree = parser.getTree();
  edit(tree);
  parser.push('');
  expect(tree.undo(tree.root)).toBeDefined();
  expect(tree.redo(tree.root)).toBeDefined();
  parser.push('beta');
  expect(tree.undo(tree.root)).toBeUndefined();
  expect(tree.redo(tree.root)).toBeUndefined();
});
