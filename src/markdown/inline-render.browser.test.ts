import { describe, expect, test } from 'vitest';
import { MarkdownInline } from './inline-render.js';
import { createBlockParser } from './block-parser/api.js';
import type { InlineViewModelNode } from './view-model-node.js';
import { styles } from './style.js';
import { serializeToString } from './block-serializer.js';
import { MarkdownRenderer } from './block-render.js';
import { nextTask } from '../editing/test/lifecycle.js';
import { html } from 'lit';

async function settle(element: HTMLElementTagNameMap['md-inline']) {
  await element.updateComplete;
  await Promise.all(Array.from(element.querySelectorAll('md-span'), (span) => span.updateComplete));
}

describe('MarkdownInline', () => {
  test('shows literal punctuation alongside formatting and keeps code blocks literal', async () => {
    const style = document.createElement('style');
    style.textContent = styles.map((item) => item.cssText).join('\n');
    document.head.append(style);
    const parser = createBlockParser();
    const source = 'call(arg); **bold**\n\n```js\ncall(arg); **bold**\n```';
    for (const character of source) parser.push(character);
    parser.finish();
    expect(serializeToString(parser.getTree().serialize())).toBe(`${source}\n`);
    const nodes = parser.getTree().root.children!;
    const paragraph = new MarkdownInline();
    const code = new MarkdownInline();
    paragraph.node = nodes[0] as InlineViewModelNode;
    code.node = nodes[1] as InlineViewModelNode;
    document.body.append(paragraph, code);
    await settle(paragraph);
    await settle(code);
    expect(paragraph.innerText).toBe('call(arg); bold');
    expect(code.innerText).toBe('call(arg); **bold**');
    expect(code.querySelector('md-span[type="strong_emphasis"]')).toBeNull();
    paragraph.focus();
    expect(paragraph.innerText).toBe('call(arg); **bold**');
    paragraph.remove();
    code.remove();
    style.remove();
  });

  test.each([
    ['**a(b)**', 'a(b)'],
    ['(x) *italic* `code`', '(x) italic `code`'],
    ['[unfinished **bold**', '[unfinished bold'],
    ['*unfinished **bold**', '*unfinished bold'],
    ['[a(b)](https://example.com) **bold**', 'a(b) bold'],
  ])('shows literal punctuation in %s', async (source, expected) => {
    const style = document.createElement('style');
    style.textContent = styles.map((item) => item.cssText).join('\n');
    document.head.append(style);
    const parser = createBlockParser();
    parser.push(source);
    parser.finish();
    const inline = new MarkdownInline();
    inline.node = parser.getTree().root.children![0] as InlineViewModelNode;
    document.body.append(inline);
    await settle(inline);
    expect(inline.innerText).toBe(expected);
    inline.remove();
    style.remove();
  });
  test('renders fenced code literally in the styled renderer and preserves serialization', async () => {
    const source =
      '```js\nconst x = "**bold**";\nconst y = "[label](url)";\n  https://example.com/a\n```';
    const parser = createBlockParser();
    parser.push(source);
    const tree = parser.finish();
    const renderer = new MarkdownRenderer();
    renderer.block = tree.root;
    document.body.append(renderer);
    await nextTask();
    const inline = renderer.shadowRoot!.querySelector('md-inline')!;
    await settle(inline);
    const content = 'const x = "**bold**";\nconst y = "[label](url)";\n  https://example.com/a';
    expect(inline.innerText).toBe(content);
    expect(inline.querySelector('a, [formatting]')).toBeNull();
    expect(serializeToString(tree.serialize())).toBe(source + '\n');
    inline.focus();
    expect(inline.innerText).toBe(content);
    let clicks = 0;
    inline.addEventListener('inline-link-click', () => clicks++);
    inline.blur();
    inline.querySelector('md-span')!.click();
    expect(clicks).toBe(0);
    renderer.remove();
  });

  test('retains literal streaming output and delegate fallback', async () => {
    const parser = createBlockParser();
    parser.push('> ```js\n> ');
    const renderer = new MarkdownRenderer();
    renderer.block = parser.getTree().root;
    renderer.renderDelegate = { renderCodeBlock: () => undefined };
    document.body.append(renderer);
    await nextTask();
    const inline = renderer.shadowRoot!.querySelector('md-inline')!;
    const node = inline.node;
    for (const chunk of ['**bold**', ' [label](url)', ' https://example.com']) {
      parser.push(chunk);
      await settle(inline);
      expect(inline.innerText).toBe(node!.content);
      expect(inline.node).toBe(node);
      expect(inline.querySelector('a, [formatting]')).toBeNull();
    }
    renderer.remove();
    const custom = new MarkdownRenderer();
    custom.block = parser.getTree().root;
    custom.renderDelegate = { renderCodeBlock: () => html`<b>custom</b>` };
    document.body.append(custom);
    await nextTask();
    expect(custom.shadowRoot!.querySelector('b')?.textContent).toBe('custom');
    custom.remove();
  });

  test('continues formatting ordinary inline Markdown and links', async () => {
    const parser = createBlockParser();
    parser.push('**bold** https://example.com');
    const renderer = new MarkdownRenderer();
    renderer.block = parser.finish().root;
    document.body.append(renderer);
    await nextTask();
    const inline = renderer.shadowRoot!.querySelector('md-inline')!;
    await settle(inline);
    expect(inline.querySelector('[type="strong_emphasis"]')).not.toBeNull();
    expect(inline.querySelector('a')?.textContent).toBe('https://example.com');
    renderer.remove();
  });
  test('renders changes made while detached and follows replacement nodes', async () => {
    const first = createBlockParser();
    first.push('```js\nfirst');
    const second = createBlockParser();
    second.push('```js\nsecond');
    const inline = new MarkdownInline();
    inline.node = first.getTree().root.children![0] as InlineViewModelNode;
    document.body.append(inline);
    await settle(inline);
    expect(inline.textContent).toBe('first');
    inline.remove();
    first.push(' changed');
    document.body.append(inline);
    await settle(inline);
    expect(inline.textContent).toBe('first changed');
    inline.remove();
    inline.node = second.getTree().root.children![0] as InlineViewModelNode;
    second.push(' updated');
    document.body.append(inline);
    await settle(inline);
    expect(inline.textContent).toBe('second updated');
    inline.node = undefined;
    await settle(inline);
    expect(inline.textContent).toBe('');
    inline.remove();
  });

  test('renders leading empty code lines during playback', async () => {
    const parser = createBlockParser();
    parser.push('```js\n');
    const inline = new MarkdownInline();
    inline.node = parser.getTree().root.children![0] as InlineViewModelNode;
    document.body.append(inline);
    for (const char of '\n\nalpha\n```') {
      parser.push(char);
      await settle(inline);
      if (char === 'a' && parser.getPendingText() === 'a') {
        expect(inline.textContent).toBe('\n\na');
      }
    }
    parser.finish();
    await settle(inline);
    expect(inline.textContent).toBe('\n\nalpha');
    inline.remove();
  });

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
