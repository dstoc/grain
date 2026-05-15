import {describe, expect, it} from 'vitest';

import {createBlockParser, parseBlocks} from './block-parser.js';

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
          children: [
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
        },
      ],
    });
  });

  it('accumulates plain lines into one paragraph', () => {
    const {node} = parseBlocks('first line\nsecond line\n');
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'paragraph',
          content: 'first line\nsecond line',
        },
      ],
    });
  });

  it('promotes a paragraph into a setext heading', () => {
    const {node} = parseBlocks('Title\n---\nbody\n');
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'section',
          marker: '##',
          content: 'Title',
          children: [
            {
              type: 'paragraph',
              content: 'body',
            },
          ],
        },
      ],
    });
  });

  it('projects partial paragraph text during push', () => {
    const parser = createBlockParser();
    const tree = parser.push('hello');
    expect(tree.serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'paragraph',
          content: 'hello',
        },
      ],
    });
    expect(parser.getPendingText()).toBe('hello');
  });

  it('promotes a projected paragraph after later setext input', () => {
    const parser = createBlockParser();
    parser.push('Title');
    parser.push('\n---\nbody');
    const tree = parser.finish();
    expect(tree.serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'section',
          marker: '##',
          content: 'Title',
          children: [
            {
              type: 'paragraph',
              content: 'body',
            },
          ],
        },
      ],
    });
  });
});
