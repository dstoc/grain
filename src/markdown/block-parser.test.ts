import {describe, expect, it} from 'vitest';

import {parseBlocks} from './block-parser.js';

describe('parseBlocks', () => {
  it('returns an empty paragraph for empty input', () => {
    const {node} = parseBlocks('');
    expect(node).toEqual({
      type: 'document',
      children: [{type: 'paragraph', content: ''}],
    });
  });

  it('parses headings, lists, block quotes, and paragraphs', () => {
    const {node} = parseBlocks('# Title\n- item\n> quote\nplain text\n');
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'section',
          marker: '#',
          content: 'Title',
          children: [],
        },
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '- ',
              checked: undefined,
              children: [{type: 'paragraph', content: 'item'}],
            },
          ],
        },
        {
          type: 'block-quote',
          marker: '> ',
          children: [{type: 'paragraph', content: 'quote'}],
        },
        {
          type: 'paragraph',
          content: 'plain text',
        },
      ],
    });
  });
});
