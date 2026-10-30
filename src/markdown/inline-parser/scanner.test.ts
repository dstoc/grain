import { describe, expect, it } from 'vitest';

import { scanInline } from './scanner.js';

describe('scanInline', () => {
  it('keeps plain text as a single text token', () => {
    expect(scanInline('hello world')).toEqual([
      {
        type: 'text',
        text: 'hello world',
        startIndex: 0,
        endIndex: 11,
      },
    ]);
  });

  it('splits bracket, paren, image, delimiter, and backtick runs into syntax tokens', () => {
    expect(scanInline('a![*b](c) ~~x~~ _y_ ```z```')).toEqual([
      {
        type: 'text',
        text: 'a',
        startIndex: 0,
        endIndex: 1,
      },
      {
        type: 'syntax',
        kind: 'image_marker',
        marker: '!',
        length: 1,
        text: '!',
        startIndex: 1,
        endIndex: 2,
      },
      {
        type: 'syntax',
        kind: 'bracket_open',
        marker: '[',
        length: 1,
        text: '[',
        startIndex: 2,
        endIndex: 3,
      },
      {
        type: 'syntax',
        kind: 'delimiter',
        marker: '*',
        length: 1,
        text: '*',
        startIndex: 3,
        endIndex: 4,
      },
      {
        type: 'text',
        text: 'b',
        startIndex: 4,
        endIndex: 5,
      },
      {
        type: 'syntax',
        kind: 'bracket_close',
        marker: ']',
        length: 1,
        text: ']',
        startIndex: 5,
        endIndex: 6,
      },
      {
        type: 'syntax',
        kind: 'paren_open',
        marker: '(',
        length: 1,
        text: '(',
        startIndex: 6,
        endIndex: 7,
      },
      {
        type: 'text',
        text: 'c',
        startIndex: 7,
        endIndex: 8,
      },
      {
        type: 'syntax',
        kind: 'paren_close',
        marker: ')',
        length: 1,
        text: ')',
        startIndex: 8,
        endIndex: 9,
      },
      {
        type: 'text',
        text: ' ',
        startIndex: 9,
        endIndex: 10,
      },
      {
        type: 'syntax',
        kind: 'delimiter',
        marker: '~',
        length: 2,
        text: '~~',
        startIndex: 10,
        endIndex: 12,
      },
      {
        type: 'text',
        text: 'x',
        startIndex: 12,
        endIndex: 13,
      },
      {
        type: 'syntax',
        kind: 'delimiter',
        marker: '~',
        length: 2,
        text: '~~',
        startIndex: 13,
        endIndex: 15,
      },
      {
        type: 'text',
        text: ' ',
        startIndex: 15,
        endIndex: 16,
      },
      {
        type: 'syntax',
        kind: 'delimiter',
        marker: '_',
        length: 1,
        text: '_',
        startIndex: 16,
        endIndex: 17,
      },
      {
        type: 'text',
        text: 'y',
        startIndex: 17,
        endIndex: 18,
      },
      {
        type: 'syntax',
        kind: 'delimiter',
        marker: '_',
        length: 1,
        text: '_',
        startIndex: 18,
        endIndex: 19,
      },
      {
        type: 'text',
        text: ' ',
        startIndex: 19,
        endIndex: 20,
      },
      {
        type: 'syntax',
        kind: 'code_span_delimiter',
        marker: '`',
        length: 3,
        text: '```',
        startIndex: 20,
        endIndex: 23,
      },
      {
        type: 'text',
        text: 'z',
        startIndex: 23,
        endIndex: 24,
      },
      {
        type: 'syntax',
        kind: 'code_span_delimiter',
        marker: '`',
        length: 3,
        text: '```',
        startIndex: 24,
        endIndex: 27,
      },
    ]);
  });

  it('recognizes tags conservatively and keeps invalid tags as text', () => {
    expect(scanInline('prefix #tag #tag-1 #1 #emoji🙂! suffix')).toEqual([
      {
        type: 'text',
        text: 'prefix ',
        startIndex: 0,
        endIndex: 7,
      },
      {
        type: 'tag',
        tagName: 'tag',
        text: '#tag',
        startIndex: 7,
        endIndex: 11,
      },
      {
        type: 'text',
        text: ' ',
        startIndex: 11,
        endIndex: 12,
      },
      {
        type: 'tag',
        tagName: 'tag-1',
        text: '#tag-1',
        startIndex: 12,
        endIndex: 18,
      },
      {
        type: 'text',
        text: ' #1 ',
        startIndex: 18,
        endIndex: 22,
      },
      {
        type: 'tag',
        tagName: 'emoji🙂',
        text: '#emoji🙂',
        startIndex: 22,
        endIndex: 30,
      },
      {
        type: 'text',
        text: '! suffix',
        startIndex: 30,
        endIndex: 38,
      },
    ]);
  });

  it('recognizes URI autolinks and leaves other angle-bracket text alone', () => {
    expect(
      scanInline('link <https://example.com> and <not a link> plus <mailto:test@example.com>'),
    ).toEqual([
      {
        type: 'text',
        text: 'link ',
        startIndex: 0,
        endIndex: 5,
      },
      {
        type: 'uri_autolink',
        url: 'https://example.com',
        text: '<https://example.com>',
        startIndex: 5,
        endIndex: 26,
      },
      {
        type: 'text',
        text: ' and <not a link> plus ',
        startIndex: 26,
        endIndex: 49,
      },
      {
        type: 'uri_autolink',
        url: 'mailto:test@example.com',
        text: '<mailto:test@example.com>',
        startIndex: 49,
        endIndex: 74,
      },
    ]);
  });
});
