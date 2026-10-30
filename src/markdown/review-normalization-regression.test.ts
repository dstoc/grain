import { expect, test } from 'vitest';
import { createBlockParser, parseBlocks } from './block-parser/api.js';

test.each([
  ['narrower normalized marker', '5. a\n99. b\n    - child\n'],
  ['wider normalized marker', '9. a\n1. b\n   - child\n'],
  ['normalized marker in a quote', '> 5. a\n> 99. b\n>     - child\n'],
  ['nested marker widths', '5. a\n99. b\n    9. nested\n    1. next\n       - child\n'],
  ['code fence continuation', '5. a\n99. b\n    ```\n    code\n    ```\n'],
])('list normalization preserves structure across chunk schedules: %s', (_name, source) => {
  const expected = parseBlocks(source).node;
  const parser = createBlockParser();
  for (const char of source) parser.push(char);
  expect(parser.finish().serialize()).toEqual(expected);
  for (let split = 0; split <= source.length; split++) {
    const partial = createBlockParser();
    partial.push(source.slice(0, split));
    const resumed = createBlockParser(partial.snapshot());
    partial.push(source.slice(split));
    resumed.push(source.slice(split));
    expect(partial.finish().serialize(), `split ${split}`).toEqual(expected);
    expect(resumed.finish().serialize(), `resumed split ${split}`).toEqual(expected);
  }
});

test('snapshot resume retains source indentation after marker normalization', () => {
  const prefix = '5. a\n99. b\n';
  const suffix = '    - child\n';
  const parser = createBlockParser();
  parser.push(prefix);
  const resumed = createBlockParser(parser.snapshot());
  resumed.push(suffix);
  expect(resumed.finish().serialize()).toEqual(parseBlocks(prefix + suffix).node);
});

test('source indentation nests the child under the normalized second item', () => {
  const root = parseBlocks('5. a\n99. b\n    - child\n').node;
  expect(root.children?.[0]).toMatchObject({
    type: 'list',
    children: [
      { type: 'list-item', marker: '5. ' },
      {
        type: 'list-item',
        marker: '6. ',
        children: [
          { type: 'paragraph', content: 'b' },
          { type: 'list', children: [{ type: 'list-item', children: [{ content: 'child' }] }] },
        ],
      },
    ],
  });
});
