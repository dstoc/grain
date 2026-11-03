import { describe, expect, test } from 'vitest';
import { MarkdownInline } from './inline-render.js';
import { createBlockParser } from './block-parser/api.js';
import { ConstructionPreviewAdapter } from './construction-preview.js';
import { asInlineMarkdownNodeView } from './node-view.js';
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
    const preview = new ConstructionPreviewAdapter(parser.getTree());
    const nodes = preview.root.children!;
    const paragraph = new MarkdownInline();
    const code = new MarkdownInline();
    paragraph.nodeView = asInlineMarkdownNodeView(nodes[0]!);
    code.nodeView = asInlineMarkdownNodeView(nodes[1]!);
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
    const preview = new ConstructionPreviewAdapter(parser.getTree());
    const inline = new MarkdownInline();
    inline.nodeView = asInlineMarkdownNodeView(preview.root.children![0]!);
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
    const preview = new ConstructionPreviewAdapter(tree);
    const renderer = new MarkdownRenderer();
    renderer.block = preview.root;
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
    const preview = new ConstructionPreviewAdapter(parser.getTree());
    const renderer = new MarkdownRenderer();
    renderer.block = preview.root;
    renderer.renderDelegate = { renderCodeBlock: () => undefined };
    document.body.append(renderer);
    await nextTask();
    const inline = renderer.shadowRoot!.querySelector('md-inline')!;
    const node = inline.nodeView;
    for (const chunk of ['**bold**', ' [label](url)', ' https://example.com']) {
      parser.push(chunk);
      preview.refresh();
      await settle(inline);
      expect(inline.innerText).toBe(node!.content);
      expect(inline.nodeView).toBe(node);
      expect(inline.querySelector('a, [formatting]')).toBeNull();
    }
    renderer.remove();
    const custom = new MarkdownRenderer();
    custom.block = preview.root;
    custom.renderDelegate = { renderCodeBlock: () => html`<b>custom</b>` };
    document.body.append(custom);
    await nextTask();
    expect(custom.shadowRoot!.querySelector('b')?.textContent).toBe('custom');
    custom.remove();
  });

  test('continues formatting ordinary inline Markdown and links', async () => {
    const parser = createBlockParser();
    parser.push('**bold** https://example.com');
    const preview = new ConstructionPreviewAdapter(parser.getTree());
    const renderer = new MarkdownRenderer();
    parser.finish();
    preview.refresh();
    renderer.block = preview.root;
    document.body.append(renderer);
    await nextTask();
    const inline = renderer.shadowRoot!.querySelector('md-inline')!;
    await settle(inline);
    expect(inline.querySelector('[type="strong_emphasis"]')).not.toBeNull();
    expect(inline.querySelector('a')?.textContent).toBe('https://example.com');
    renderer.remove();
  });

  test('keeps strikethrough aligned with visible text when unfocused', async () => {
    const parser = createBlockParser();
    const source = 'plain ~~alpha~~ omega a~~b~~c';
    parser.push(source);
    const tree = parser.finish();
    const preview = new ConstructionPreviewAdapter(tree);
    const renderer = new MarkdownRenderer();
    renderer.block = preview.root;
    document.body.append(renderer);
    await nextTask();

    const inline = renderer.shadowRoot!.querySelector('md-inline')!;
    await settle(inline);
    const strikes = [...inline.querySelectorAll('md-span[type="strikethrough"]')];
    const alphaStrike = strikes.find((strike) => strike.textContent === '~~alpha~~')!;
    const alpha = [...alphaStrike.querySelectorAll('md-span[type="text"]')].find(
      (span) => span.textContent === 'alpha',
    )!;
    const adjacentStrike = strikes.find((strike) => strike.textContent === '~~b~~')!;
    const b = [...adjacentStrike.querySelectorAll('md-span[type="text"]')].find(
      (span) => span.textContent === 'b',
    )!;

    const expectDecorationToCoverText = (strike: Element, text: Element) => {
      const strikeRect = strike.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      expect(textRect.height).toBeGreaterThan(0);
      if (inline.matches(':focus-within')) {
        expect(strikeRect.height).toBeGreaterThan(0);
        expect(strikeRect.top).toBeLessThanOrEqual(textRect.top);
        expect(strikeRect.bottom).toBeGreaterThanOrEqual(textRect.bottom);
        expect(getComputedStyle(strike).textDecorationLine).toBe('line-through');
      } else {
        expect(strikeRect.left).toBeCloseTo(textRect.left);
        expect(strikeRect.right).toBeCloseTo(textRect.right);
        expect(getComputedStyle(text).textDecorationLine).toBe('line-through');
      }
    };

    expect(inline.innerText).toBe('plain alpha omega abc');
    expectDecorationToCoverText(alphaStrike, alpha);
    expectDecorationToCoverText(adjacentStrike, b);
    inline.focus();
    await settle(inline);
    expect(inline.innerText).toBe('plain ~~alpha~~ omega a~~b~~c');
    expectDecorationToCoverText(alphaStrike, alpha);
    expectDecorationToCoverText(adjacentStrike, b);
    inline.blur();
    await settle(inline);
    expect(inline.innerText).toBe('plain alpha omega abc');
    expectDecorationToCoverText(alphaStrike, alpha);
    expectDecorationToCoverText(adjacentStrike, b);
    expect(serializeToString(tree.serialize())).toBe(`${source}\n`);
    renderer.remove();
  });

  test('renders changes made while detached and follows replacement nodes', async () => {
    const first = createBlockParser();
    first.push('```js\nfirst');
    const firstPreview = new ConstructionPreviewAdapter(first.getTree());
    const second = createBlockParser();
    second.push('```js\nsecond');
    const secondPreview = new ConstructionPreviewAdapter(second.getTree());
    const inline = new MarkdownInline();
    inline.nodeView = asInlineMarkdownNodeView(firstPreview.root.children![0]!);
    document.body.append(inline);
    await settle(inline);
    expect(inline.textContent).toBe('first');
    inline.remove();
    first.push(' changed');
    firstPreview.refresh();
    document.body.append(inline);
    await settle(inline);
    expect(inline.textContent).toBe('first changed');
    inline.remove();
    inline.nodeView = asInlineMarkdownNodeView(secondPreview.root.children![0]!);
    second.push(' updated');
    secondPreview.refresh();
    document.body.append(inline);
    await settle(inline);
    expect(inline.textContent).toBe('second updated');
    inline.nodeView = undefined;
    await settle(inline);
    expect(inline.textContent).toBe('');
    inline.remove();
  });

  test('renders leading empty code lines during playback', async () => {
    const parser = createBlockParser();
    parser.push('```js\n');
    const preview = new ConstructionPreviewAdapter(parser.getTree());
    const inline = new MarkdownInline();
    inline.nodeView = asInlineMarkdownNodeView(preview.root.children![0]!);
    document.body.append(inline);
    for (const char of '\n\nalpha\n```') {
      parser.push(char);
      preview.refresh();
      await settle(inline);
      if (char === 'a' && parser.getPendingText() === 'a') {
        expect(inline.textContent).toBe('\n\na');
      }
    }
    parser.finish();
    preview.refresh();
    await settle(inline);
    expect(inline.textContent).toBe('\n\nalpha');
    inline.remove();
  });

  test('updates a mounted code block as projected content is replaced and settled', async () => {
    const parser = createBlockParser();
    parser.push('```js\n');
    const preview = new ConstructionPreviewAdapter(parser.getTree());
    const node = asInlineMarkdownNodeView(preview.root.children![0]!);
    const inline = new MarkdownInline();
    inline.nodeView = node;
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
      preview.refresh();
      await settle(inline);
      expect(inline.textContent).toBe(expected);
      expect(asInlineMarkdownNodeView(preview.root.children![0]!)).toBe(node);
    }
    parser.finish();
    preview.refresh();
    await settle(inline);
    expect(inline.textContent).toBe('function greet(name)\nreturn name;');
    inline.remove();
  });
});
