import { describe, expect, it } from 'vitest';

import { parse } from './api.js';

describe('inline parser api', () => {
  it('returns a code span root node for a matching backtick pair', () => {
    expect(parse('`code`').rootNode).toMatchObject({
      type: 'code_span',
      text: '`code`',
      startIndex: 0,
      endIndex: 6,
      namedChildren: [
        {
          type: 'text',
          text: 'code',
          startIndex: 1,
          endIndex: 5,
          namedChildren: [],
        },
      ],
    });
  });

  it('wraps mixed inline content in a root container while preserving spans', () => {
    expect(parse('pre `code` post').rootNode).toMatchObject({
      type: 'inline_root',
      text: 'pre `code` post',
      startIndex: 0,
      endIndex: 15,
      namedChildren: [
        {
          type: 'text',
          text: 'pre ',
          startIndex: 0,
          endIndex: 4,
          namedChildren: [],
        },
        {
          type: 'code_span',
          text: '`code`',
          startIndex: 4,
          endIndex: 10,
          namedChildren: [
            {
              type: 'text',
              text: 'code',
              startIndex: 5,
              endIndex: 9,
              namedChildren: [],
            },
          ],
        },
        {
          type: 'text',
          text: ' post',
          startIndex: 10,
          endIndex: 15,
          namedChildren: [],
        },
      ],
    });
  });

  it('resolves inline links with destination and title children', () => {
    expect(parse('[link](dest "title")').rootNode).toMatchObject({
      type: 'inline_link',
      text: '[link](dest "title")',
      startIndex: 0,
      endIndex: 20,
      namedChildren: [
        {
          type: 'link_text',
          text: 'link',
          startIndex: 1,
          endIndex: 5,
          namedChildren: [
            {
              type: 'text',
              text: 'link',
              startIndex: 1,
              endIndex: 5,
              namedChildren: [],
            },
          ],
        },
        {
          type: 'link_destination',
          text: 'dest',
          startIndex: 7,
          endIndex: 11,
          namedChildren: [],
        },
        {
          type: 'link_title',
          text: 'title',
          startIndex: 13,
          endIndex: 18,
          namedChildren: [],
        },
      ],
    });
  });

  it('resolves shortcut links for bracketed labels', () => {
    expect(parse('[label]').rootNode).toMatchObject({
      type: 'shortcut_link',
      text: '[label]',
      startIndex: 0,
      endIndex: 7,
      namedChildren: [
        {
          type: 'link_text',
          text: 'label',
          startIndex: 1,
          endIndex: 6,
          namedChildren: [
            {
              type: 'text',
              text: 'label',
              startIndex: 1,
              endIndex: 6,
              namedChildren: [],
            },
          ],
        },
      ],
    });
  });

  it('resolves images with alt text and destination children', () => {
    expect(parse('![alt](dest)').rootNode).toMatchObject({
      type: 'image',
      text: '![alt](dest)',
      startIndex: 0,
      endIndex: 12,
      namedChildren: [
        {
          type: 'link_text',
          text: 'alt',
          startIndex: 2,
          endIndex: 5,
          namedChildren: [
            {
              type: 'text',
              text: 'alt',
              startIndex: 2,
              endIndex: 5,
              namedChildren: [],
            },
          ],
        },
        {
          type: 'link_destination',
          text: 'dest',
          startIndex: 7,
          endIndex: 11,
          namedChildren: [],
        },
      ],
    });
  });

  it('keeps malformed link tails literal', () => {
    expect(parse('[label](not a link)').rootNode).toMatchObject({
      type: 'text',
      text: '[label](not a link)',
      startIndex: 0,
      endIndex: 19,
      namedChildren: [],
    });
  });

  it('uses an inline_root container for mixed text and links', () => {
    expect(parse('pre [link](dest) post').rootNode).toMatchObject({
      type: 'inline_root',
      text: 'pre [link](dest) post',
      startIndex: 0,
      endIndex: 21,
      namedChildren: [
        {
          type: 'text',
          text: 'pre ',
          startIndex: 0,
          endIndex: 4,
          namedChildren: [],
        },
        {
          type: 'inline_link',
          text: '[link](dest)',
          startIndex: 4,
          endIndex: 16,
          namedChildren: [
            {
              type: 'link_text',
              text: 'link',
              startIndex: 5,
              endIndex: 9,
              namedChildren: [
                {
                  type: 'text',
                  text: 'link',
                  startIndex: 5,
                  endIndex: 9,
                  namedChildren: [],
                },
              ],
            },
            {
              type: 'link_destination',
              text: 'dest',
              startIndex: 11,
              endIndex: 15,
              namedChildren: [],
            },
          ],
        },
        {
          type: 'text',
          text: ' post',
          startIndex: 16,
          endIndex: 21,
          namedChildren: [],
        },
      ],
    });
  });

  it('keeps inner punctuation literal inside code spans', () => {
    expect(parse('`a * [b] #tag <https://example.com>`').rootNode).toMatchObject({
      type: 'code_span',
      text: '`a * [b] #tag <https://example.com>`',
      startIndex: 0,
      endIndex: 36,
      namedChildren: [
        {
          type: 'text',
          text: 'a * [b] #tag <https://example.com>',
          startIndex: 1,
          endIndex: 35,
          namedChildren: [],
        },
      ],
    });
  });

  it('builds emphasis, strong emphasis, and strikethrough nodes end to end', () => {
    expect(parse('*x* **y** ~~z~~').rootNode).toMatchObject({
      type: 'inline_root',
      text: '*x* **y** ~~z~~',
      startIndex: 0,
      endIndex: 15,
      namedChildren: [
        {
          type: 'emphasis',
          text: '*x*',
          startIndex: 0,
          endIndex: 3,
          namedChildren: [
            {
              type: 'text',
              text: 'x',
              startIndex: 1,
              endIndex: 2,
              namedChildren: [],
            },
          ],
        },
        {
          type: 'text',
          text: ' ',
          startIndex: 3,
          endIndex: 4,
          namedChildren: [],
        },
        {
          type: 'strong_emphasis',
          text: '**y**',
          startIndex: 4,
          endIndex: 9,
          namedChildren: [
            {
              type: 'text',
              text: 'y',
              startIndex: 6,
              endIndex: 7,
              namedChildren: [],
            },
          ],
        },
        {
          type: 'text',
          text: ' ',
          startIndex: 9,
          endIndex: 10,
          namedChildren: [],
        },
        {
          type: 'strikethrough',
          text: '~~z~~',
          startIndex: 10,
          endIndex: 15,
          namedChildren: [
            {
              type: 'text',
              text: 'z',
              startIndex: 12,
              endIndex: 13,
              namedChildren: [],
            },
          ],
        },
      ],
    });
  });

  it('keeps unmatched delimiters literal in mixed content', () => {
    expect(parse('pre *x* post *y').rootNode).toMatchObject({
      type: 'inline_root',
      text: 'pre *x* post *y',
      startIndex: 0,
      endIndex: 15,
      namedChildren: [
        {
          type: 'text',
          text: 'pre ',
          startIndex: 0,
          endIndex: 4,
          namedChildren: [],
        },
        {
          type: 'emphasis',
          text: '*x*',
          startIndex: 4,
          endIndex: 7,
          namedChildren: [
            {
              type: 'text',
              text: 'x',
              startIndex: 5,
              endIndex: 6,
              namedChildren: [],
            },
          ],
        },
        {
          type: 'text',
          text: ' post ',
          startIndex: 7,
          endIndex: 13,
          namedChildren: [],
        },
        {
          type: 'syntax',
          text: '*',
          startIndex: 13,
          endIndex: 14,
          namedChildren: [],
        },
        {
          type: 'text',
          text: 'y',
          startIndex: 14,
          endIndex: 15,
          namedChildren: [],
        },
      ],
    });
  });

  it('keeps delimiters literal inside code spans and resolves emphasis inside link text', () => {
    expect(parse('`*x*` [*link*](dest)').rootNode).toMatchObject({
      type: 'inline_root',
      text: '`*x*` [*link*](dest)',
      startIndex: 0,
      endIndex: 20,
      namedChildren: [
        {
          type: 'code_span',
          text: '`*x*`',
          startIndex: 0,
          endIndex: 5,
          namedChildren: [
            {
              type: 'text',
              text: '*x*',
              startIndex: 1,
              endIndex: 4,
              namedChildren: [],
            },
          ],
        },
        {
          type: 'text',
          text: ' ',
          startIndex: 5,
          endIndex: 6,
          namedChildren: [],
        },
        {
          type: 'inline_link',
          text: '[*link*](dest)',
          startIndex: 6,
          endIndex: 20,
          namedChildren: [
            {
              type: 'link_text',
              text: '*link*',
              startIndex: 7,
              endIndex: 13,
              namedChildren: [
                {
                  type: 'emphasis',
                  text: '*link*',
                  startIndex: 7,
                  endIndex: 13,
                  namedChildren: [
                    {
                      type: 'text',
                      text: 'link',
                      startIndex: 8,
                      endIndex: 12,
                      namedChildren: [],
                    },
                  ],
                },
              ],
            },
            {
              type: 'link_destination',
              text: 'dest',
              startIndex: 15,
              endIndex: 19,
              namedChildren: [],
            },
          ],
        },
      ],
    });
  });

  it('keeps unmatched brackets literal', () => {
    expect(parse('`code').rootNode).toMatchObject({
      type: 'text',
      text: '`code',
      startIndex: 0,
      endIndex: 5,
      namedChildren: [],
    });
  });
});
