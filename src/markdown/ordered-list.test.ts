import { expect, test } from 'vitest';

import { createBlockParser, parseBlocks } from './block-parser/api.js';
import { serializeToString } from './block-serializer.js';
import { ConstructionTree } from './semantic/construction-tree.js';

test('construction normalizes an inserted item while preserving existing records', () => {
  const tree = new ConstructionTree({
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
  const list = tree.root.children[0]!;
  const [first, second, third] = list.children;
  const item = tree.draft.create({ type: 'list-item', marker: '* ' });
  const paragraph = tree.draft.create({ type: 'paragraph', content: 'new' });
  tree.draft.place(item, list.id, second!.id);
  tree.draft.place(paragraph, item, null);

  tree.normalize();

  expect(list.children).toEqual([first, tree.node(item), second, third]);
  expect(serializeToString(tree.serialize())).toBe('5. a\n6. new\n7. b\n8. c\n');
});

test('construction normalizes arbitrary precision ordered markers', () => {
  const tree = new ConstructionTree({
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
          { type: 'list-item', marker: '* ', children: [{ type: 'paragraph', content: 'b' }] },
        ],
      },
    ],
  });

  tree.normalize();

  expect(serializeToString(tree.serialize())).toBe(
    '99999999999999999999) a\n100000000000000000000) b\n',
  );
});

test('mixed numbered lists survive incremental parsing and structural serialization', () => {
  const source = '9. parent\n   - nested\n10. next\n20) other\n';
  const expected = parseBlocks(source).node;
  const parser = createBlockParser();
  for (const char of source) parser.push(char);
  expect(parser.finish().serialize()).toEqual(expected);
  const serialized = serializeToString(expected);
  expect(parseBlocks(serialized).node).toEqual(expected);
});

test('numbered source markers normalize across chunk schedules and snapshot resume', () => {
  const source = '5. a\n99. b\n3. c\n';
  const expected = parseBlocks(source).node;
  expect(serializeToString(expected)).toBe('5. a\n6. b\n7. c\n');

  for (let split = 0; split <= source.length; split++) {
    const parser = createBlockParser();
    parser.push(source.slice(0, split));
    const resumed = createBlockParser(parser.snapshot());
    resumed.push(source.slice(split));
    expect(resumed.finish().serialize()).toEqual(expected);
  }

  const parser = createBlockParser();
  for (const char of source) parser.push(char);
  expect(parser.finish().serialize()).toEqual(expected);
});
