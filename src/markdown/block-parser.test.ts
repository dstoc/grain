import { describe, expect, it } from 'vitest';

import { createBlockParser, parseBlocks } from './block-parser/api.js';
import { serializeToString } from './block-serializer.js';
import type { DocumentNode } from './node.js';

function expectCharByCharAppendMatchesFullParse(source: string) {
  const full = parseBlocks(source).node;
  const parser = createBlockParser();
  for (const char of source) {
    parser.push(char);
  }
  const incremental = parser.finish().serialize();
  expect(incremental).toEqual(full);
}

function expectScheduledAppendMatchesFullParse(source: string, schedules: string[][]) {
  const full = parseBlocks(source).node;
  for (const schedule of schedules) {
    const parser = createBlockParser();
    for (const chunk of schedule) {
      parser.push(chunk);
    }
    expect(parser.finish().serialize()).toEqual(full);
  }
}

describe('parseBlocks', () => {
  it('returns an empty paragraph for empty input', () => {
    const { node } = parseBlocks('');
    expect(node).toEqual({
      type: 'document',
      children: [{ type: 'paragraph', content: '' }],
    });
  });

  it('parses headings, lists, block quotes, and paragraphs', () => {
    const { node } = parseBlocks('# Title\n- item\n> quote\nplain text\n');
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
                  children: [{ type: 'paragraph', content: 'item' }],
                },
              ],
            },
            {
              type: 'block-quote',
              marker: '> ',
              children: [{ type: 'paragraph', content: 'quote' }],
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
    const { node } = parseBlocks('first line\nsecond line\n');
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
    const { node } = parseBlocks('Title\n---\nbody\n');
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

  it('projects nested list-item paragraph content during push', () => {
    const parser = createBlockParser();
    parser.push('* > * ');
    expect(parser.push('h').serialize()).toEqual({
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
                              content: 'h',
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

  it('projects nested quote paragraph content during push', () => {
    const parser = createBlockParser();
    parser.push('* > > ');
    expect(parser.push('h').serialize()).toEqual({
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
                  type: 'block-quote',
                  marker: '> ',
                  children: [
                    {
                      type: 'block-quote',
                      marker: '> ',
                      children: [
                        {
                          type: 'paragraph',
                          content: 'h',
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

  it('holds back prefix-only shell fragments during push', () => {
    const cases = [
      {
        fragment: '* ',
        node: {
          type: 'document',
          children: [
            {
              type: 'list',
              children: [
                {
                  type: 'list-item',
                  marker: '* ',
                  checked: undefined,
                  children: [{ type: 'paragraph', content: '' }],
                },
              ],
            },
          ],
        },
      },
      {
        fragment: '* >',
        node: {
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
                      type: 'block-quote',
                      marker: '> ',
                      children: [{ type: 'paragraph', content: '' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      {
        fragment: '* > ',
        node: {
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
                      type: 'block-quote',
                      marker: '> ',
                      children: [{ type: 'paragraph', content: '' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      {
        fragment: '* > *',
        node: {
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
                      type: 'block-quote',
                      marker: '> ',
                      children: [{ type: 'paragraph', content: '*' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      {
        fragment: '* > * ',
        node: {
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
                              children: [{ type: 'paragraph', content: '' }],
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
      },
    ] as const;

    for (const { fragment, node } of cases) {
      const parser = createBlockParser();
      parser.push(fragment);
      expect(parser.getTree().serialize()).toEqual(node);
    }
  });

  it('projects an empty list item shell during push', () => {
    const parser = createBlockParser();
    parser.push('* ');
    expect(parser.getTree().serialize()).toEqual({
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
                  content: '',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('projects an empty block quote shell during push', () => {
    const parser = createBlockParser();
    parser.push('> ');
    expect(parser.getTree().serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
          children: [],
        },
      ],
    });
  });

  it('projects an empty block quote shell across incremental pushes', () => {
    const parser = createBlockParser();
    parser.push('>');
    parser.push(' ');
    expect(parser.getTree().serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
          children: [],
        },
      ],
    });
  });

  it('projects an empty code block shell during push', () => {
    const parser = createBlockParser();
    parser.push('```ts');
    expect(parser.getTree().serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'code-block',
          info: 'ts',
          content: '',
        },
      ],
    });
  });

  it('projects incomplete code block content during push', () => {
    const parser = createBlockParser();
    parser.push('```\n');
    parser.push('content');
    expect(parser.getTree().serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'code-block',
          info: null,
          content: 'content',
        },
      ],
    });
  });

  it('projects partial paragraph text inside a list item', () => {
    const parser = createBlockParser();
    parser.push('- item\n  cont');
    expect(parser.getTree().serialize()).toEqual({
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
                  content: 'item\ncont',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('projects partial ATX heading text as a section', () => {
    const parser = createBlockParser();
    parser.push('## heading');
    expect(parser.getTree().serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'section',
          marker: '##',
          content: 'heading',
          children: [],
        },
      ],
    });
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
    const { node } = parseBlocks('- item\n  > quote\n  - nested\n');
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
    const { node } = parseBlocks('> quote\n> - nested\n');
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
    const { node } = parseBlocks('> quote\n> * list 1\n>   * list 2\n');
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

  it('keeps the sibling after a nested quote inside the quoted list item', () => {
    const source = '> - > quote\n>   after\n';
    expect(parseBlocks(source).node).toEqual({
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
                  marker: '- ',
                  checked: undefined,
                  children: [
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
                      type: 'paragraph',
                      content: 'after',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expectCharByCharAppendMatchesFullParse(source);
  });

  it('returns to the parent list after a nested list', () => {
    const { node } = parseBlocks('- outer\n  - inner\n- sibling\n');
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
    const { node } = parseBlocks('- item\n  continuation\n');
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
    const { node } = parseBlocks(source);
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
    expect(serializeToString(node)).toBe('* list para 1\n  para continue\n  \n  list para 2\n');
  });

  it('keeps a second paragraph inside a quoted list item', () => {
    const source = '> * list para 1\n>   para continue\n>\n>   list para 2\n';
    const { node } = parseBlocks(source);
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

  it('keeps a second paragraph inside a doubly quoted list item', () => {
    const source = '> > - list para 1\n> >   para continue\n> >   \n> >   list para 2\n';
    const { node } = parseBlocks(source);
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
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
                      marker: '- ',
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
        },
      ],
    });
  });

  it('keeps sibling paragraphs inside a doubly quoted block quote', () => {
    const source = '> > before\n> > \n> > after\n';
    const { node } = parseBlocks(source);
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
          children: [
            {
              type: 'block-quote',
              marker: '> ',
              children: [
                {
                  type: 'paragraph',
                  content: 'before',
                },
                {
                  type: 'paragraph',
                  content: 'after',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('parses html comment sentinel as an empty paragraph', () => {
    const { node } = parseBlocks('<!-- -->\n');
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'paragraph',
          content: '',
        },
      ],
    });
  });

  it('roundtrips separate lists through empty paragraph sentinels', () => {
    const source = '* list 1\n\n<!-- -->\n\n* list 2\n';
    const { node } = parseBlocks(source);
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
                  content: 'list 1',
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: '',
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
    });
    expect(serializeToString(node)).toBe(source);
  });

  it('roundtrips separate quotes through empty paragraph sentinels', () => {
    const source = '> quote 1\n\n<!-- -->\n\n> quote 2\n';
    const { node } = parseBlocks(source);
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
          children: [
            {
              type: 'paragraph',
              content: 'quote 1',
            },
          ],
        },
        {
          type: 'paragraph',
          content: '',
        },
        {
          type: 'block-quote',
          marker: '> ',
          children: [
            {
              type: 'paragraph',
              content: 'quote 2',
            },
          ],
        },
      ],
    });
    expect(serializeToString(node)).toBe(source);
  });

  it('roundtrips separate top-level sections through empty paragraph sentinels', () => {
    const source = '# section 1\n<!-- -->\n\n# section 2\n';
    const { node } = parseBlocks(source);
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'section',
          marker: '#',
          content: 'section 1',
          children: [
            {
              type: 'paragraph',
              content: '',
            },
            {
              type: 'section',
              marker: '#',
              content: 'section 2',
              children: [],
            },
          ],
        },
      ],
    });
    expect(serializeToString(node)).toBe(source);
  });

  it('roundtrips a section-rooted chain before a quoted sibling through an empty paragraph sentinel', () => {
    const source = '# section 1\n> quote 1\n\n<!-- -->\n\n> quote 2\n';
    const { node } = parseBlocks(source);
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'section',
          marker: '#',
          content: 'section 1',
          children: [
            {
              type: 'block-quote',
              marker: '> ',
              children: [
                {
                  type: 'paragraph',
                  content: 'quote 1',
                },
              ],
            },
            {
              type: 'paragraph',
              content: '',
            },
            {
              type: 'block-quote',
              marker: '> ',
              children: [
                {
                  type: 'paragraph',
                  content: 'quote 2',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(serializeToString(node)).toBe(source);
  });

  it('roundtrips quoted nested content through an empty paragraph sentinel', () => {
    const source = '> quote 1\n> \n> > nested quote\n\n<!-- -->\n\n> quote 2\n';
    const { node } = parseBlocks(source);
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
          children: [
            {
              type: 'paragraph',
              content: 'quote 1',
            },
            {
              type: 'block-quote',
              marker: '> ',
              children: [
                {
                  type: 'paragraph',
                  content: 'nested quote',
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: '',
        },
        {
          type: 'block-quote',
          marker: '> ',
          children: [
            {
              type: 'paragraph',
              content: 'quote 2',
            },
          ],
        },
      ],
    });
    expect(serializeToString(node)).toBe(source);
  });

  it('keeps a fenced code block inside a doubly quoted list item after a blank separator', () => {
    const source = '> > - list para 1\n> >   \n> >   ```ts\n> >   body\n> >   ```\n';
    const { node } = parseBlocks(source);
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
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
                      marker: '- ',
                      checked: undefined,
                      children: [
                        {
                          type: 'paragraph',
                          content: 'list para 1',
                        },
                        {
                          type: 'code-block',
                          info: 'ts',
                          content: 'body',
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

  it('matches full parse when appending list continuation one character at a time', () => {
    expectCharByCharAppendMatchesFullParse('* list\n  continue\n');
  });

  it('parses a section as the first child of a list item', () => {
    const { node } = parseBlocks('* # section\n  content\n');
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
                  type: 'section',
                  marker: '#',
                  content: 'section',
                  children: [
                    {
                      type: 'paragraph',
                      content: 'content',
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

  it('continues a paragraph under a list-item section across multiple indented lines', () => {
    const { node } = parseBlocks('* # section\n  para\n  continue\n');
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
                  type: 'section',
                  marker: '#',
                  content: 'section',
                  children: [
                    {
                      type: 'paragraph',
                      content: 'para\ncontinue',
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

  it('continues a paragraph under a list-item section without a trailing newline', () => {
    const { node } = parseBlocks('* # section\n  para\n  continue');
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
                  type: 'section',
                  marker: '#',
                  content: 'section',
                  children: [
                    {
                      type: 'paragraph',
                      content: 'para\ncontinue',
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

  it('parses a same-line quote marker in a list item as a block quote', () => {
    const { node } = parseBlocks('* > quote\n');
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
                  type: 'block-quote',
                  marker: '> ',
                  children: [
                    {
                      type: 'paragraph',
                      content: 'quote',
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

  it('parses a deeper same-line quote marker inside a list-item quote as a nested quote', () => {
    const { node } = parseBlocks('* > > no inner quote\n');
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
                  type: 'block-quote',
                  marker: '> ',
                  children: [
                    {
                      type: 'block-quote',
                      marker: '> ',
                      children: [
                        {
                          type: 'paragraph',
                          content: 'no inner quote',
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

  it('parses a deeper same-line list marker inside a list-item quote as a nested list', () => {
    const { node } = parseBlocks('* > * no inner list\n');
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
                              content: 'no inner list',
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

  it('parses a same-line code fence marker in a list item as a code block', () => {
    const { node } = parseBlocks('* ```js\n');
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
                  type: 'code-block',
                  info: 'js',
                  content: '',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it.each(['alpha  ', 'alpha\n', 'alpha  \n\n', 'alpha ` ```  '])(
    'preserves trailing fenced code content in a nested round trip: %j',
    (content) => {
      const expected: DocumentNode = {
        type: 'document',
        children: [
          {
            type: 'list',
            children: [
              {
                type: 'list-item',
                marker: '- ',
                checked: undefined,
                children: [{ type: 'code-block', info: 'js', content }],
              },
            ],
          },
        ],
      };
      const serialized = serializeToString(expected);
      expect(parseBlocks(serialized).node).toEqual(expected);
    },
  );

  it('roundtrips a fenced code block inside a bullet list item', () => {
    const expected: DocumentNode = {
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
                  type: 'code-block',
                  info: 'ts',
                  content: 'bullet code',
                },
              ],
            },
          ],
        },
      ],
    };
    expect(parseBlocks(serializeToString(expected)).node).toEqual(expected);
  });

  it('roundtrips a fenced code block inside an ordered list item', () => {
    const expected: DocumentNode = {
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '1. ',
              checked: undefined,
              children: [
                {
                  type: 'code-block',
                  info: 'ts',
                  content: 'ordered code',
                },
              ],
            },
          ],
        },
      ],
    };
    expect(parseBlocks(serializeToString(expected)).node).toEqual(expected);
  });

  it('roundtrips a fenced md code block containing markdown-looking lines', () => {
    const source =
      '```md\n' +
      '## Transcluded Markdown\n' +
      'This block is rendered through the transclusion delegate.\n' +
      '\n' +
      '- nested item\n' +
      '- **formatted** child content\n' +
      '```\n';
    const { node } = parseBlocks(source);
    expect(serializeToString(node)).toBe(source);
  });

  it('matches full parse for a section containing a quoted fenced code block under char-by-char append', () => {
    const expected: DocumentNode = {
      type: 'document',
      children: [
        {
          type: 'section',
          marker: '#',
          content: 'section 1',
          children: [
            {
              type: 'block-quote',
              marker: '> ',
              children: [
                {
                  type: 'code-block',
                  info: 'ts',
                  content: 'section > quote',
                },
              ],
            },
          ],
        },
      ],
    };
    const markdown = serializeToString(expected);
    expectCharByCharAppendMatchesFullParse(markdown);
  });

  it('parses a same-line unordered list marker in a list item as a nested list', () => {
    const { node } = parseBlocks('* - nested\n');
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

  it('parses a same-line ordered list marker in a list item as a nested list', () => {
    const { node } = parseBlocks('* 1. nested\n');
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
                  type: 'list',
                  children: [
                    {
                      type: 'list-item',
                      marker: '1. ',
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

  it('matches full parse when appending a list-item section one character at a time', () => {
    expectCharByCharAppendMatchesFullParse('* # section\n  content\n');
  });

  it('matches full parse when appending a multi-line list-item section paragraph one character at a time', () => {
    expectCharByCharAppendMatchesFullParse('* # section\n  para\n  continue\n');
  });

  it('matches full parse when appending a multi-line list-item section paragraph one character at a time without a trailing newline', () => {
    expectCharByCharAppendMatchesFullParse('* # section\n  para\n  continue');
  });

  it('projects a list-item section paragraph continuation without a trailing newline', () => {
    const parser = createBlockParser();
    parser.push('* # section\n  para');
    expect(parser.getTree().serialize()).toEqual({
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
                  type: 'section',
                  marker: '#',
                  content: 'section',
                  children: [
                    {
                      type: 'paragraph',
                      content: 'para',
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

  it('projects a plain list-item paragraph continuation without a trailing newline', () => {
    const parser = createBlockParser();
    parser.push('* item\n  cont');
    expect(parser.getTree().serialize()).toEqual({
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
                  content: 'item\ncont',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('projects a quoted list-item paragraph continuation without a trailing newline', () => {
    const parser = createBlockParser();
    parser.push('> * item\n>   cont');
    expect(parser.getTree().serialize()).toEqual({
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
                      content: 'item\ncont',
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

  it('projects a nested list-item paragraph continuation without a trailing newline', () => {
    const parser = createBlockParser();
    parser.push('* outer\n  * inner\n    cont');
    expect(parser.getTree().serialize()).toEqual({
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
                  content: 'outer',
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
                          content: 'inner\ncont',
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

  it('projects a quoted list-item section paragraph continuation without a trailing newline', () => {
    const parser = createBlockParser();
    parser.push('> * # section\n>   para');
    expect(parser.getTree().serialize()).toEqual({
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
                      type: 'section',
                      marker: '#',
                      content: 'section',
                      children: [
                        {
                          type: 'paragraph',
                          content: 'para',
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

  it('projects a fenced code block continuation inside a list item without a trailing newline', () => {
    const parser = createBlockParser();
    parser.push('* ```\n  body');
    expect(parser.getTree().serialize()).toEqual({
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
                  type: 'code-block',
                  info: null,
                  content: 'body',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('projects a fenced code block continuation inside a quoted list item without a trailing newline', () => {
    const parser = createBlockParser();
    parser.push('> * ```\n>   body');
    expect(parser.getTree().serialize()).toEqual({
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
                      type: 'code-block',
                      info: null,
                      content: 'body',
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

  it('keeps a paragraph sibling after a fenced code block inside a doubly quoted list item', () => {
    const source =
      '> > - ```ts\n> >   quote > quote > bullet\n> >   ```\n> >   container 2 after paragraph\n';
    const { node } = parseBlocks(source);
    expect(node).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
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
                      marker: '- ',
                      checked: undefined,
                      children: [
                        {
                          type: 'code-block',
                          info: 'ts',
                          content: 'quote > quote > bullet',
                        },
                        {
                          type: 'paragraph',
                          content: 'container 2 after paragraph',
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

  it('keeps a nested quote sibling after a paragraph inside a quoted list item', () => {
    const source = '> - container 1 before paragraph\n>   > quote > bullet > quote\n';
    const { node } = parseBlocks(source);
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
                  marker: '- ',
                  checked: undefined,
                  children: [
                    {
                      type: 'paragraph',
                      content: 'container 1 before paragraph',
                    },
                    {
                      type: 'block-quote',
                      marker: '> ',
                      children: [
                        {
                          type: 'paragraph',
                          content: 'quote > bullet > quote',
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

  it('keeps a paragraph sibling after a nested quoted list inside a quoted list item', () => {
    const source = '> - - quote > bullet > bullet\n>   \n>   container 1 after paragraph\n';
    const { node } = parseBlocks(source);
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
                  marker: '- ',
                  checked: undefined,
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
                              content: 'quote > bullet > bullet',
                            },
                          ],
                        },
                      ],
                    },
                    {
                      type: 'paragraph',
                      content: 'container 1 after paragraph',
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

  it('keeps a nested quoted sibling after a blank separator inside a quoted list item', () => {
    const source = '> - > container 2 before paragraph\n>   > \n>   > quote > bullet > quote\n';
    const { node } = parseBlocks(source);
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
                  marker: '- ',
                  checked: undefined,
                  children: [
                    {
                      type: 'block-quote',
                      marker: '> ',
                      children: [
                        {
                          type: 'paragraph',
                          content: 'container 2 before paragraph',
                        },
                        {
                          type: 'paragraph',
                          content: 'quote > bullet > quote',
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

  it('parses a quoted code block inside a quoted list item', () => {
    const source = '> - > ```ts\n>   > quote > bullet > quote\n>   > ```\n';
    const { node } = parseBlocks(source);
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
                  marker: '- ',
                  checked: undefined,
                  children: [
                    {
                      type: 'block-quote',
                      marker: '> ',
                      children: [
                        {
                          type: 'code-block',
                          info: 'ts',
                          content: 'quote > bullet > quote',
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

  it('projects a fenced code block continuation inside a doubly quoted list item without a trailing newline', () => {
    const parser = createBlockParser();
    parser.push('> > - ```\n> >   quote > quote > bullet');
    expect(parser.getTree().serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
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
                      marker: '- ',
                      checked: undefined,
                      children: [
                        {
                          type: 'code-block',
                          info: null,
                          content: 'quote > quote > bullet',
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

  it('projects a doubly quoted paragraph incrementally before newline', () => {
    const parser = createBlockParser();
    for (const char of '> > hi') {
      parser.push(char);
    }
    expect(parser.getTree().serialize()).toEqual({
      type: 'document',
      children: [
        {
          type: 'block-quote',
          marker: '> ',
          children: [
            {
              type: 'block-quote',
              marker: '> ',
              children: [
                {
                  type: 'paragraph',
                  content: 'hi',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('matches full parse when appending a nested quoted paragraph sibling one character at a time', () => {
    expectCharByCharAppendMatchesFullParse(
      '> > quote > quote\n> \n> container 0 after paragraph\n',
    );
  });

  it('matches full parse when appending a nested quoted code block sibling one character at a time', () => {
    expectCharByCharAppendMatchesFullParse(
      '> > container 1 before paragraph\n> > \n> > ```ts\n> > quote > quote\n> > ```\n',
    );
  });

  it('matches full parse when appending a fenced code block inside a doubly quoted list item one character at a time', () => {
    expectCharByCharAppendMatchesFullParse(
      '> > - ```ts\n> >   quote > quote > bullet\n> >   ```\n',
    );
  });

  it('matches full parse when appending a quoted code block inside a quoted list item one character at a time', () => {
    expectCharByCharAppendMatchesFullParse(
      '> - > ```ts\n>   > quote > bullet > quote\n>   > ```\n',
    );
  });

  it('matches full parse when appending a nested quoted paragraph sibling after a blank separator one character at a time', () => {
    expectCharByCharAppendMatchesFullParse(
      '> - > container 2 before paragraph\n>   > \n>   > quote > bullet > quote\n',
    );
  });

  it('matches full parse when appending a quoted sibling after a blank quoted separator inside a list item one character at a time', () => {
    expectCharByCharAppendMatchesFullParse(
      '# section 1\n- > > container 2 before quote\n  > \n  > section > bullet > quote\n  > \n  > > container 2 after quote\n',
    );
  });

  it('matches full parse when appending the list-quote-quote repro under multiple schedules', () => {
    expectScheduledAppendMatchesFullParse('a\n* > a\n> a\n', [
      ['a', '\n* > a\n> a\n'],
      ['a\n', '* > a\n', '> a\n'],
    ]);
  });

  it('matches full parse when appending a nested quoted code block after a blank separator one character at a time', () => {
    expectCharByCharAppendMatchesFullParse(
      '> - > container 2 before paragraph\n>   > \n>   > ```ts\n>   > quote > bullet > quote\n>   > ```\n',
    );
  });

  it('matches full parse when appending a quoted list item one character at a time', () => {
    expectCharByCharAppendMatchesFullParse('* > one\n  > two\n');
  });

  it('matches full parse when appending a deeper same-line quote marker one character at a time', () => {
    expectCharByCharAppendMatchesFullParse('* > > no inner quote\n');
  });

  it('matches full parse when appending a deeper same-line list marker one character at a time', () => {
    expectCharByCharAppendMatchesFullParse('* > * no inner list\n');
  });

  it('ends a list-item section before an unindented following paragraph', () => {
    const { node } = parseBlocks('* # section\n\noutside?\n');
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
                  type: 'section',
                  marker: '#',
                  content: 'section',
                  children: [],
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: 'outside?',
        },
      ],
    });
  });

  it('projects an unindented paragraph outside a list-item section without a trailing newline', () => {
    const parser = createBlockParser();
    parser.push('* # section\n\noutside?');
    expect(parser.getTree().serialize()).toEqual({
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
                  type: 'section',
                  marker: '#',
                  content: 'section',
                  children: [],
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: 'outside?',
        },
      ],
    });
  });
});
