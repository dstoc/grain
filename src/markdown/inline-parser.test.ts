import { describe, expect, it } from 'vitest';

import { parse, parser } from './inline-parser.js';
import { parse as parseFromIndex, parser as parserFromIndex } from './inline-parser/index.js';

describe('inline parser scaffold', () => {
  it('preserves the plain text fallback tree', () => {
    const tree = parse('hello');
    expect(tree.rootNode).toMatchObject({
      type: 'text',
      text: 'hello',
      startIndex: 0,
      endIndex: 5,
      namedChildren: [],
    });
    expect(typeof tree.rootNode.id).toBe('number');
  });

  it('keeps parser.parse and the new index entrypoint aligned', () => {
    const fromWrapper = parser.parse('plain text');
    const fromIndex = parserFromIndex.parse('plain text');
    const { id: wrapperId, ...wrapperNode } = fromWrapper.rootNode;
    const { id: indexId, ...indexNode } = fromIndex.rootNode;

    expect(typeof wrapperId).toBe('number');
    expect(typeof indexId).toBe('number');
    expect(wrapperNode).toEqual(indexNode);
    expect(parseFromIndex('plain text').rootNode).toMatchObject(wrapperNode);
    expect(parser.parse('plain text').rootNode).toMatchObject(indexNode);
  });
});
