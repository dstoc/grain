import { describe, expect, it } from 'vitest';

import { resolveDelimiters } from './resolve-delimiters.js';
import { scanInline } from './scanner.js';

describe('resolveDelimiters', () => {
  it('pairs backtick delimiter runs into a code span and swallows inner syntax tokens', () => {
    const input = '`a * [b] #tag <https://example.com>`';
    const resolved = resolveDelimiters(scanInline(input));

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      type: 'code_span',
      text: input,
      startIndex: 0,
      endIndex: input.length,
      innerText: 'a * [b] #tag <https://example.com>',
      innerStartIndex: 1,
      innerEndIndex: input.length - 1,
    });
  });

  it('pairs emphasis, strong emphasis, and strikethrough runs into structured nodes', () => {
    expect(resolveDelimiters(scanInline('*x* **y** ~~z~~'))).toMatchObject([
      {
        type: 'emphasis',
        text: '*x*',
        startIndex: 0,
        endIndex: 3,
        children: [
          {
            type: 'text',
            text: 'x',
            startIndex: 1,
            endIndex: 2,
          },
        ],
      },
      {
        type: 'text',
        text: ' ',
        startIndex: 3,
        endIndex: 4,
      },
      {
        type: 'strong_emphasis',
        text: '**y**',
        startIndex: 4,
        endIndex: 9,
        children: [
          {
            type: 'text',
            text: 'y',
            startIndex: 6,
            endIndex: 7,
          },
        ],
      },
      {
        type: 'text',
        text: ' ',
        startIndex: 9,
        endIndex: 10,
      },
      {
        type: 'strikethrough',
        text: '~~z~~',
        startIndex: 10,
        endIndex: 15,
        children: [
          {
            type: 'text',
            text: 'z',
            startIndex: 12,
            endIndex: 13,
          },
        ],
      },
    ]);
  });

  it('leaves an unmatched backtick run as literal syntax and text tokens', () => {
    expect(resolveDelimiters(scanInline('`code'))).toEqual([
      {
        type: 'syntax',
        kind: 'code_span_delimiter',
        marker: '`',
        length: 1,
        text: '`',
        startIndex: 0,
        endIndex: 1,
      },
      {
        type: 'text',
        text: 'code',
        startIndex: 1,
        endIndex: 5,
      },
    ]);
  });

  it('leaves unmatched delimiter runs literal when no valid pair forms', () => {
    expect(resolveDelimiters(scanInline('*code'))).toEqual(scanInline('*code'));
    expect(resolveDelimiters(scanInline('**'))).toEqual(scanInline('**'));
    expect(resolveDelimiters(scanInline('~~'))).toEqual(scanInline('~~'));
  });

  it('resolves nested emphasis inside a stronger outer pair', () => {
    expect(resolveDelimiters(scanInline('*a **b** c*'))).toMatchObject([
      {
        type: 'emphasis',
        text: '*a **b** c*',
        startIndex: 0,
        endIndex: 11,
        children: [
          {
            type: 'text',
            text: 'a ',
            startIndex: 1,
            endIndex: 3,
          },
          {
            type: 'strong_emphasis',
            text: '**b**',
            startIndex: 3,
            endIndex: 8,
            children: [
              {
                type: 'text',
                text: 'b',
                startIndex: 5,
                endIndex: 6,
              },
            ],
          },
          {
            type: 'text',
            text: ' c',
            startIndex: 8,
            endIndex: 10,
          },
        ],
      },
    ]);
  });

  it('keeps delimiters inside code spans literal', () => {
    expect(resolveDelimiters(scanInline('`*x* ~~y~~`'))).toEqual([
      {
        type: 'code_span',
        text: '`*x* ~~y~~`',
        startIndex: 0,
        endIndex: 11,
        innerText: '*x* ~~y~~',
        innerStartIndex: 1,
        innerEndIndex: 10,
      },
    ]);
  });

  it('resolves explicit inline links and images into structured nodes', () => {
    expect(resolveDelimiters(scanInline('[link](dest "title") ![alt](image.png)'))).toMatchObject([
      {
        type: 'inline_link',
        text: '[link](dest "title")',
        startIndex: 0,
        endIndex: 20,
        destination: 'dest',
        destinationStartIndex: 7,
        destinationEndIndex: 11,
        title: 'title',
        titleStartIndex: 13,
        titleEndIndex: 18,
        label: [
          {
            type: 'text',
            text: 'link',
            startIndex: 1,
            endIndex: 5,
          },
        ],
      },
      {
        type: 'text',
        text: ' ',
        startIndex: 20,
        endIndex: 21,
      },
      {
        type: 'image',
        text: '![alt](image.png)',
        startIndex: 21,
        endIndex: 38,
        destination: 'image.png',
        destinationStartIndex: 28,
        destinationEndIndex: 37,
        label: [
          {
            type: 'text',
            text: 'alt',
            startIndex: 23,
            endIndex: 26,
          },
        ],
      },
    ]);
  });

  it('resolves emphasis inside link text before link pairing', () => {
    expect(resolveDelimiters(scanInline('[*link*](dest)'))).toMatchObject([
      {
        type: 'inline_link',
        text: '[*link*](dest)',
        startIndex: 0,
        endIndex: 14,
        label: [
          {
            type: 'emphasis',
            text: '*link*',
            startIndex: 1,
            endIndex: 7,
            children: [
              {
                type: 'text',
                text: 'link',
                startIndex: 2,
                endIndex: 6,
              },
            ],
          },
        ],
      },
    ]);
  });

  it('keeps malformed link tails literal', () => {
    expect(resolveDelimiters(scanInline('[label](not a link)'))).toEqual(
      scanInline('[label](not a link)'),
    );
  });
});
