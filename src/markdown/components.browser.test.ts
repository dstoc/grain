import { expect, test } from 'vitest';
import { viewModel } from './view-model-node.js';
import { MarkdownTree } from './view-model.js';
import { HostContext } from './host-context.js';
import { MarkdownBlock, MarkdownRenderer } from './block-render.js';
import { MarkdownInline, MarkdownSpan } from './inline-render.js';
import { MarkdownTransclusion } from './transclusion.js';
import '../editing/editor.js';
import './block-ui.js';

test('registers components and reflects reactive properties', async () => {
  for (const name of [
    'md-editor',
    'md-block',
    'md-block-render',
    'md-section-ui',
    'md-list-item-ui',
    'md-inline',
    'md-span',
    'md-transclusion',
  ]) {
    expect(customElements.get(name)).toBeDefined();
  }
  const block = new MarkdownBlock();
  document.body.append(block);
  block.root = true;
  block.type = 'paragraph';
  await block.updateComplete;
  expect(block.hasAttribute('root')).toBe(true);
  expect(block.getAttribute('type')).toBe('paragraph');
  block.removeAttribute('root');
  expect(block.root).toBe(false);
  block.remove();
});

test('context consumers subscribe, disconnect and reconnect to provider replacements', async () => {
  const provider = new MarkdownRenderer();
  const block = new MarkdownBlock();
  const inline = new MarkdownInline();
  const transclusion = new MarkdownTransclusion();
  provider.append(block, inline, transclusion);
  document.body.append(provider);
  const first = provider.hostContext;
  expect(block.hostContext).toBe(first);
  expect(inline.hostContext).toBe(first);
  expect(transclusion.hostContext).toBe(first);
  const second = new HostContext();
  provider.hostContext = second;
  expect(block.hostContext).toBe(second);
  expect(inline.hostContext).toBe(second);
  expect(transclusion.hostContext).toBe(second);
  block.remove();
  const third = new HostContext();
  provider.hostContext = third;
  expect(block.hostContext).toBe(second);
  provider.append(block);
  expect(block.hostContext).toBe(third);
  provider.remove();
});

test('queries observe current light DOM rather than caching results', () => {
  const inline = new MarkdownInline();
  document.body.append(inline);
  expect(inline.span).toBeNull();
  const parent = new MarkdownSpan();
  const child = new MarkdownSpan();
  inline.append(parent);
  parent.append(child);
  expect(inline.span).toBe(parent);
  expect(Array.from(parent.spans)).toEqual([child]);
  child.remove();
  parent.remove();
  expect(inline.span).toBeNull();
  expect(parent.spans.length).toBe(0);
  inline.remove();
});

test('signal properties replace and dispose effects with their original lifecycle', async () => {
  const first = new MarkdownTree({ type: 'document', children: [] }).root;
  const second = new MarkdownTree({ type: 'document', children: [] }).root;
  const block = new MarkdownBlock();
  let effects = 0;
  block.effect = () => {
    effects++;
    block.node?.[viewModel].renderSignal.value;
  };
  document.body.append(block);
  block.node = first;
  expect(effects).toBe(1);
  block.node = first;
  expect(effects).toBe(1);
  first[viewModel].renderSignal.value++;
  expect(effects).toBe(2);
  block.node = second;
  expect(effects).toBe(3);
  first[viewModel].renderSignal.value++;
  expect(effects).toBe(3);
  second[viewModel].renderSignal.value++;
  expect(effects).toBe(4);
  block.remove();
  second[viewModel].renderSignal.value++;
  expect(effects).toBe(4);
  document.body.append(block);
  block.node = second;
  second[viewModel].renderSignal.value++;
  expect(effects).toBe(4);
  block.node = undefined;
  expect(effects).toBe(5);
  block.remove();
});

test('nearest nested provider delivers context and replacement without updating its host', async () => {
  const outer = new MarkdownRenderer();
  const inner = new MarkdownRenderer();
  const consumer = new MarkdownInline();
  inner.append(consumer);
  outer.append(inner);
  document.body.append(outer);
  await Promise.all([
    outer.updateComplete,
    inner.updateComplete,
    consumer.updateComplete,
  ]);
  expect(consumer.hostContext).toBe(inner.hostContext);
  const next = new HostContext();
  inner.hostContext = next;
  expect(consumer.hostContext).toBe(next);
  expect(inner.isUpdatePending).toBe(false);
  outer.hostContext = new HostContext();
  expect(consumer.hostContext).toBe(next);
  outer.remove();
});

test('queries return null and an empty list before connection', () => {
  expect(new MarkdownInline().span).toBeNull();
  expect(new MarkdownSpan().spans.length).toBe(0);
});
