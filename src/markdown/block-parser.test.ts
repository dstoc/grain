import {describe, expect, it} from 'vitest';

import {createBlockParser, parseBlocks} from './block-parser.js';
import {serializeToString} from './block-serializer.js';

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

  it('restores from a snapshot and continues parsing', () => {
    const parser = createBlockParser();
    parser.push('Title');
    const snapshot = parser.snapshot();
    const resumed = createBlockParser(snapshot);
    resumed.push('\n---\nbody');
    const tree = resumed.finish();
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

  it('nests block quotes and lists under a list item', () => {
    const {node} = parseBlocks('- item\n  > quote\n  - nested\n');
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '- ',
              checked: undefined,
              children: [
                {
                  type: 'paragraph',
                  content: 'item',
                },
                {
                  type: 'block-quote',
                  marker: '> ',
                  children: [
                    {
                      type: 'paragraph',
                      content: 'quote',
                    },
                  ],
                },
                {
                  type: 'list',
                  children: [
                    {
                      type: 'list-item',
                      marker: '- ',
                      checked: undefined,
                      children: [
                        {
                          type: 'paragraph',
                          content: 'nested',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('allows lists inside block quotes', () => {
    const {node} = parseBlocks('> quote\n> - nested\n');
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
          children: [
            {
              type: 'paragraph',
              content: 'quote',
            },
            {
              type: 'list',
              children: [
                {
                  type: 'list-item',
                  marker: '- ',
                  checked: undefined,
                  children: [
                    {
                      type: 'paragraph',
                      content: 'nested',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('nests a list under a quoted list item', () => {
    const {node} = parseBlocks('> quote\n> * list 1\n>   * list 2\n');
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
          children: [
            {
              type: 'paragraph',
              content: 'quote',
            },
            {
              type: 'list',
              children: [
                {
                  type: 'list-item',
                  marker: '* ',
                  checked: undefined,
                  children: [
                    {
                      type: 'paragraph',
                      content: 'list 1',
                    },
                    {
                      type: 'list',
                      children: [
                        {
                          type: 'list-item',
                          marker: '* ',
                          checked: undefined,
                          children: [
                            {
                              type: 'paragraph',
                              content: 'list 2',
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('returns to the parent list after a nested list', () => {
    const {node} = parseBlocks('- outer\n  - inner\n- sibling\n');
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '- ',
              checked: undefined,
              children: [
                {
                  type: 'paragraph',
                  content: 'outer',
                },
                {
                  type: 'list',
                  children: [
                    {
                      type: 'list-item',
                      marker: '- ',
                      checked: undefined,
                      children: [
                        {
                          type: 'paragraph',
                          content: 'inner',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: 'list-item',
              marker: '- ',
              checked: undefined,
              children: [
                {
                  type: 'paragraph',
                  content: 'sibling',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('restores nested list state from a snapshot', () => {
    const parser = createBlockParser();
    parser.push('- outer\n  - inner\n');
    const snapshot = parser.snapshot();
    const resumed = createBlockParser(snapshot);
    resumed.push('- sibling\n');
    const tree = resumed.finish();
    expect(tree.serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '- ',
              checked: undefined,
              children: [
                {
                  type: 'paragraph',
                  content: 'outer',
                },
                {
                  type: 'list',
                  children: [
                    {
                      type: 'list-item',
                      marker: '- ',
                      checked: undefined,
                      children: [
                        {
                          type: 'paragraph',
                          content: 'inner',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: 'list-item',
              marker: '- ',
              checked: undefined,
              children: [
                {
                  type: 'paragraph',
                  content: 'sibling',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('supports fenced code blocks across appended chunks', () => {
    const parser = createBlockParser();
    parser.push('```ts\nconst a = 1;');
    const snapshot = parser.snapshot();
    const resumed = createBlockParser(snapshot);
    resumed.push('\nconst b = 2;\n```\n');
    const tree = resumed.finish();
    expect(tree.serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'code-block',
          info: 'ts',
          content: 'const a = 1;\nconst b = 2;',
        },
      ],
    });
  });

  it('continues a list item paragraph on indented lines', () => {
    const {node} = parseBlocks('- item\n  continuation\n');
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '- ',
              checked: undefined,
              children: [
                {
                  type: 'paragraph',
                  content: 'item\ncontinuation',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('serializes list continuation and second paragraphs with indentation', () => {
    const source = '* list para 1\n  para continue\n\n  list para 2\n';
    const {node} = parseBlocks(source);
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '* ',
              checked: undefined,
              children: [
                {
                  type: 'paragraph',
                  content: 'list para 1\npara continue',
                },
                {
                  type: 'paragraph',
                  content: 'list para 2',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(serializeToString(node)).toBe(
      '* list para 1\n  para continue\n  \n  list para 2\n',
    );
  });

  it('keeps a second paragraph inside a quoted list item', () => {
    const source = '> * list para 1\n>   para continue\n>\n>   list para 2\n';
    const {node} = parseBlocks(source);
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
          children: [
            {
              type: 'list',
              children: [
                {
                  type: 'list-item',
                  marker: '* ',
                  checked: undefined,
                  children: [
                    {
                      type: 'paragraph',
                      content: 'list para 1\npara continue',
                    },
                    {
                      type: 'paragraph',
                      content: 'list para 2',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });
});
