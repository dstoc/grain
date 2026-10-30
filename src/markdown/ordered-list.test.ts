import { describe, expect, test } from 'vitest';
import { MarkdownTree } from './view-model.js';
import { viewModel } from './view-model-node.js';
import { numberInsertedItems } from './ordered-list.js';
import { serializeToString } from './block-serializer.js';
import { performLogicalInsertion } from './view-model-util.js';

describe('numbered list insertion', () => {
  test('canonicalizes the selected run while preserving other runs and node identity', () => {
    const tree = new MarkdownTree({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            { type: 'list-item', marker: '5. ', children: [{ type: 'paragraph', content: 'a' }] },
            { type: 'list-item', marker: '9. ', children: [{ type: 'paragraph', content: 'b' }] },
            { type: 'list-item', marker: '20) ', children: [{ type: 'paragraph', content: 'c' }] },
          ],
        },
      ],
    });
    const list = tree.root.children![0];
    const [a, b, c] = list.children!;
    tree.edit(() => {
      const item = tree.add({
        type: 'list-item',
        marker: '* ',
        children: [{ type: 'paragraph', content: 'new' }],
      });
      item[viewModel].insertBefore(list, b);
      numberInsertedItems([item]);
      return {};
    });
    expect(list.children![0]).toBe(a);
    expect(list.children![2]).toBe(b);
    expect(list.children![3]).toBe(c);
    expect(serializeToString(tree.serialize())).toBe('5. a\n6. new\n7. b\n20) c\n');
  });

  test('uses arbitrary precision and canonical digits', () => {
    const tree = new MarkdownTree({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '00099999999999999999999) ',
              children: [{ type: 'paragraph', content: 'a' }],
            },
          ],
        },
      ],
    });
    const list = tree.root.children![0];
    tree.edit(() => {
      const item = tree.add({
        type: 'list-item',
        marker: '* ',
        children: [{ type: 'paragraph', content: 'b' }],
      });
      item[viewModel].insertBefore(list);
      numberInsertedItems([item]);
      return {};
    });
    expect(serializeToString(tree.serialize())).toBe(
      '99999999999999999999) a\n100000000000000000000) b\n',
    );
  });
});

test('logical insertion numbers a pasted list as one batch and restores it on undo', () => {
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      {
        type: 'list',
        children: [
          { type: 'list-item', marker: '5. ', children: [{ type: 'paragraph', content: 'a' }] },
          { type: 'list-item', marker: '9. ', children: [{ type: 'paragraph', content: 'b' }] },
          { type: 'list-item', marker: '20) ', children: [{ type: 'paragraph', content: 'c' }] },
        ],
      },
    ],
  });
  const list = tree.root.children![0];
  const [a, b, c] = list.children!;
  const before = serializeToString(tree.serialize());
  tree.edit(() => {
    const pasted = tree.add({
      type: 'list',
      children: [
        { type: 'list-item', marker: '1) ', children: [{ type: 'paragraph', content: 'x' }] },
        { type: 'list-item', marker: '2) ', children: [{ type: 'paragraph', content: 'y' }] },
      ],
    });
    performLogicalInsertion(a.children![0], [pasted]);
    return {};
  });
  const after = '5. a\n6. x\n7. y\n8. b\n20) c\n';
  expect(serializeToString(tree.serialize())).toBe(after);
  expect(list.children![0]).toBe(a);
  expect(list.children![3]).toBe(b);
  expect(list.children![4]).toBe(c);
  tree.undo(tree.root);
  expect(serializeToString(tree.serialize())).toBe(before);
});
