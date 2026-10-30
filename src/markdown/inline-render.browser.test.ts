import { describe, expect, test } from 'vitest';
import { MarkdownInline } from './inline-render.js';
import { createBlockParser } from './block-parser/api.js';
import type { InlineViewModelNode } from './view-model-node.js';

async function settle(element: HTMLElementTagNameMap['md-inline']) {
  await element.updateComplete;
  await Promise.all(Array.from(element.querySelectorAll('md-span'), (span) => span.updateComplete));
}

describe('MarkdownInline', () => {
  test('updates a mounted code block as projected content is replaced and settled', async () => {
    const parser = createBlockParser();
    parser.push('```js\n');
    const node = parser.getTree().root.children![0] as InlineViewModelNode;
    const inline = new MarkdownInline();
    inline.node = node;
    document.body.append(inline);
    await settle(inline);
    expect(inline.textContent).toBe('');

    for (const [chunk, expected] of [
      ['function', 'function'],
      [' greet(name)', 'function greet(name)'],
      ['\nreturn name;', 'function greet(name)\nreturn name;'],
      ['\n```', 'function greet(name)\nreturn name;'],
    ]) {
      parser.push(chunk);
      await settle(inline);
      expect(inline.textContent).toBe(expected);
      expect(parser.getTree().root.children![0]).toBe(node);
    }
    parser.finish();
    await settle(inline);
    expect(inline.textContent).toBe('function greet(name)\nreturn name;');
    inline.remove();
  });
});
