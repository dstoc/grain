import { expect, it } from 'vitest';
import { createBlockParser, parseBlocks } from './block-parser/api.js';

it.each(['😀', '# 😀', '> 😀', '- 😀', '```\n😀\n```'])(
  'preserves the full parse across UTF-16 chunk boundaries: %j',
  (source) => {
    const parser = createBlockParser();
    for (let index = 0; index < source.length; index++) parser.push(source[index]!);
    expect(parser.finish().serialize()).toEqual(parseBlocks(source).node);
  },
);

it('resumes a snapshot taken between the two UTF-16 units of a code point', () => {
  const source = '# 😀';
  const parser = createBlockParser(undefined, { provenance: true });
  parser.push(source.slice(0, 3));
  const resumed = createBlockParser(parser.snapshot());
  resumed.push(source.slice(3));
  expect(resumed.finish().serialize()).toEqual(parseBlocks(source).node);
  expect(resumed.getConversionPlan(source)).toEqual(
    parseBlocks(source, { provenance: true }).provenance,
  );
});
