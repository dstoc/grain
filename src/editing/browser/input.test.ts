import { describe, expect, test } from 'vitest';

import type { InlineInput } from '../../markdown/inline-render.js';
import { translateInlineInput } from './input.js';

function pasteInput(
  nodeType: string,
  inputType: 'insertFromPaste' | 'insertReplacementText',
  text: string,
): InlineInput {
  return {
    inline: {} as InlineInput['inline'],
    node: { type: nodeType } as InlineInput['node'],
    content: 'abc',
    inputEvent: {
      inputType,
      data: null,
      dataTransfer: { getData: (type: string) => (type === 'text/plain' ? text : '') },
    } as InputEvent,
    inputStart: { index: 3 },
    inputEnd: { index: 3 },
  };
}

describe('translateInlineInput plain-text paste', () => {
  test.each(['insertFromPaste', 'insertReplacementText'] as const)(
    'preserves the delivered clipboard value for code blocks with %s',
    (inputType) => {
      const intent = translateInlineInput(
        pasteInput('code-block', inputType, 'One\r\nTwo\n\nThree  \t'),
        false,
      );

      expect(intent).toEqual({
        type: 'text',
        from: 3,
        to: 3,
        insert: 'One\r\nTwo\n\nThree  \t',
        isolated: true,
      });
    },
  );

  test.each(['insertFromPaste', 'insertReplacementText'] as const)(
    'keeps paragraph paste behavior for %s',
    (inputType) => {
      const intent = translateInlineInput(pasteInput('paragraph', inputType, 'One\nTwo'), false);

      expect(intent).toEqual({
        type: 'text',
        from: 3,
        to: 3,
        insert: 'One Two',
        isolated: true,
      });
    },
  );
});
