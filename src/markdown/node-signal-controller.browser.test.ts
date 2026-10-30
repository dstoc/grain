import type { LitElement } from 'lit';
import { batch } from '@preact/signals-core';
import { describe, expect, test, vi } from 'vitest';
import './block-render.js';
import { MarkdownTree } from './view-model.js';
import { viewModel, type ViewModelNode } from './view-model-node.js';
import type { ListItem } from './block-ui.js';

function nodes(): ViewModelNode[] {
  return [
    { type: 'section', marker: '#', content: '', children: [] },
    { type: 'section', marker: '##', content: '', children: [] },
    { type: 'list-item', marker: '-', checked: false, children: [] },
    { type: 'list-item', marker: '-', checked: true, children: [] },
  ].map((node) => new MarkdownTree(node as ConstructorParameters<typeof MarkdownTree>[0]).root);
}

describe('node signal controller on mounted components', () => {
  for (const [tag, firstIndex, secondIndex] of [
    ['md-block', 0, 1],
    ['md-section-ui', 0, 1],
    ['md-list-item-ui', 2, 3],
  ] as const) {
    test(`${tag} replaces and disposes subscriptions and reconnects`, async () => {
      const all = nodes();
      const first = all[firstIndex];
      const second = all[secondIndex];
      const element = document.createElement(tag) as LitElement & { node: ViewModelNode };
      // All selected elements accept the corresponding node type.
      element.node = first;
      document.body.append(element);
      await element.updateComplete;
      const requests = vi.spyOn(element, 'requestUpdate');
      batch(() => {
        first[viewModel].renderSignal.value++;
        first[viewModel].renderSignal.value++;
      });
      expect(requests).toHaveBeenCalledTimes(1);
      await element.updateComplete;
      element.node = second;
      requests.mockClear();
      first[viewModel].renderSignal.value++;
      expect(requests).not.toHaveBeenCalled();
      await element.updateComplete;
      requests.mockClear();
      first[viewModel].renderSignal.value++;
      expect(requests).not.toHaveBeenCalled();
      second[viewModel].renderSignal.value++;
      expect(requests).toHaveBeenCalledTimes(1);
      await element.updateComplete;
      element.remove();
      requests.mockClear();
      second[viewModel].renderSignal.value++;
      expect(requests).not.toHaveBeenCalled();
      element.node = first;
      requests.mockClear();
      document.body.append(element);
      await element.updateComplete;
      requests.mockClear();
      second[viewModel].renderSignal.value++;
      expect(requests).not.toHaveBeenCalled();
      first[viewModel].renderSignal.value++;
      expect(requests).toHaveBeenCalledTimes(1);
      await element.updateComplete;
      element.remove();
      document.body.append(element);
      await element.updateComplete;
      requests.mockClear();
      first[viewModel].renderSignal.value++;
      expect(requests).toHaveBeenCalledTimes(1);
      element.remove();
    });
  }

  test('list item renders changed checked state after its transaction', async () => {
    const item = nodes()[2] as ListItem['node'];
    const element = document.createElement('md-list-item-ui') as ListItem;
    element.node = item;
    document.body.append(element);
    await element.updateComplete;
    const gutter = element.shadowRoot!.querySelector('#gutter')!;
    const before = gutter.innerHTML;
    (gutter as HTMLElement).click();
    await element.updateComplete;
    expect(item.checked).toBe(true);
    expect(gutter.innerHTML).not.toBe(before);
    expect(element.shadowRoot!.querySelector('#gutter')).toBe(gutter);
    element.remove();
  });
  test('a parent signal update preserves keyed children, focus, and selection', async () => {
    const tree = new MarkdownTree({
      type: 'document',
      children: [
        { type: 'paragraph', content: 'hello' },
        { type: 'paragraph', content: 'world' },
      ],
    });
    const block = document.createElement('md-block');
    block.node = tree.root;
    document.body.append(block);
    await block.updateComplete;
    const children = Array.from(
      block.querySelectorAll<HTMLElementTagNameMap['md-block']>(':scope > md-block'),
    );
    await Promise.all(children.map((child) => child.updateComplete));
    const inline = children[0].querySelector('md-inline')!;
    await inline.updateComplete;
    inline.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(inline);
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString();
    tree.edit(() => {
      tree.root[viewModel].renderSignal.value++;
      tree.root[viewModel].renderSignal.value++;
      return {};
    });
    await block.updateComplete;
    expect(
      Array.from(block.querySelectorAll<HTMLElementTagNameMap['md-block']>(':scope > md-block')),
    ).toEqual(children);
    expect(document.activeElement).toBe(inline);
    expect(selection.toString()).toBe(selected);
    block.remove();
  });
});
