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
  tree.redo(tree.root);
  expect(serializeToString(tree.serialize())).toBe(after);
});

test('unindent numbers the source and destination once, preserving transferred sibling markers', async () => {
  const { unindent } = await import('../indent-util.js');
  const { numberListMoves } = await import('./ordered-list.js');
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      {
        type: 'list',
        children: [
          {
            type: 'list-item',
            marker: '10. ',
            children: [
              { type: 'paragraph', content: 'parent' },
              {
                type: 'list',
                children: [
                  {
                    type: 'list-item',
                    marker: '5. ',
                    children: [{ type: 'paragraph', content: 'a' }],
                  },
                  {
                    type: 'list-item',
                    marker: '6. ',
                    children: [{ type: 'paragraph', content: 'b' }],
                  },
                  {
                    type: 'list-item',
                    marker: '7. ',
                    children: [{ type: 'paragraph', content: 'c' }],
                  },
                  {
                    type: 'list-item',
                    marker: '8. ',
                    children: [{ type: 'paragraph', content: 'd' }],
                  },
                ],
              },
            ],
          },
          { type: 'list-item', marker: '11. ', children: [{ type: 'paragraph', content: 'tail' }] },
        ],
      },
    ],
  });
  const list = tree.root.children![0];
  const b = list.children![0].children![1].children![1];
  const before = serializeToString(tree.serialize());
  tree.edit(() => {
    numberListMoves(tree.root, () => unindent(b.children![0], tree.root));
    return {};
  });
  const after = serializeToString(tree.serialize());
  expect(after).toBe('10. parent\n    5. a\n11. b\n    7. c\n    8. d\n12. tail\n');
  tree.undo(tree.root);
  expect(serializeToString(tree.serialize())).toBe(before);
  tree.redo(tree.root);
  expect(serializeToString(tree.serialize())).toBe(after);
});

test('moves a batch into another run and restores both runs on undo and redo', async () => {
  const { numberListMoves } = await import('./ordered-list.js');
  const item = (marker: string, content: string) => ({
    type: 'list-item' as const,
    marker,
    children: [{ type: 'paragraph' as const, content }],
  });
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      { type: 'list', children: [item('5. ', 'a'), item('6. ', 'b'), item('7. ', 'c')] },
      { type: 'paragraph', content: 'separator' },
      { type: 'list', children: [item('20. ', 'x'), item('21. ', 'y')] },
    ],
  });
  const [source, , destination] = tree.root.children!;
  const [a, b] = source.children!;
  const y = destination.children![1];
  const before = serializeToString(tree.serialize());
  tree.edit(() => {
    numberListMoves(tree.root, () => {
      a[viewModel].insertBefore(destination, y);
      b[viewModel].insertBefore(destination, y);
    });
    return {};
  });
  expect(source.children![0]).toMatchObject({ marker: '5. ' });
  expect(destination.children!.map((node) => node.type === 'list-item' && node.marker)).toEqual([
    '20. ',
    '21. ',
    '22. ',
    '23. ',
  ]);
  const after = serializeToString(tree.serialize());
  tree.undo(tree.root);
  expect(serializeToString(tree.serialize())).toBe(before);
  tree.redo(tree.root);
  expect(serializeToString(tree.serialize())).toBe(after);
});

test('moving the first two items within a run preserves its captured start', async () => {
  const { numberListMoves } = await import('./ordered-list.js');
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      {
        type: 'list',
        children: [
          { type: 'list-item', marker: '5. ', children: [{ type: 'paragraph', content: 'a' }] },
          { type: 'list-item', marker: '6. ', children: [{ type: 'paragraph', content: 'b' }] },
          { type: 'list-item', marker: '7. ', children: [{ type: 'paragraph', content: 'c' }] },
        ],
      },
    ],
  });
  const list = tree.root.children![0];
  const [a, b] = list.children!;
  tree.edit(() => {
    numberListMoves(tree.root, () => {
      a[viewModel].insertBefore(list);
      b[viewModel].insertBefore(list);
    });
    return {};
  });
  const after = '5. c\n6. a\n7. b\n';
  expect(serializeToString(tree.serialize())).toBe(after);
  tree.undo(tree.root);
  expect(serializeToString(tree.serialize())).toBe('5. a\n6. b\n7. c\n');
  tree.redo(tree.root);
  expect(serializeToString(tree.serialize())).toBe(after);
});

test('mixed numbered lists survive incremental parsing and structural serialization', async () => {
  const { createBlockParser, parseBlocks } = await import('./block-parser/api.js');
  const source = '9. parent\n   - nested\n10. next\n20) other\n';
  const expected = parseBlocks(source).node;
  const parser = createBlockParser();
  for (const char of source) parser.push(char);
  expect(parser.finish().serialize()).toEqual(expected);
  const serialized = serializeToString(expected);
  expect(parseBlocks(serialized).node).toEqual(expected);
});
