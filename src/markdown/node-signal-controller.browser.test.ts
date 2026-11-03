import type { LitElement } from 'lit';
import { batch } from '@preact/signals-core';
import { describe, expect, test, vi } from 'vitest';
import './block-render.js';
import '../editing/editor.js';
import { MarkdownInline } from './inline-render.js';
import { MarkdownTree } from './view-model.js';
import { viewModel, type ViewModelNode } from './view-model-node.js';
import type { ListItem } from './block-ui.js';
import { TASK_STATE_INTENT_EVENT, type TaskStateIntent } from './render-intents.js';

function nodes(): ViewModelNode[] {
  return [
    { type: 'section', marker: '#', content: '', children: [] },
    { type: 'section', marker: '##', content: '', children: [] },
    { type: 'list-item', marker: '-', checked: false, children: [] },
    { type: 'list-item', marker: '-', checked: true, children: [] },
    { type: 'paragraph', content: 'first' },
    { type: 'paragraph', content: 'second' },
    { type: 'document', children: [{ type: 'paragraph', content: 'first' }] },
    { type: 'document', children: [{ type: 'paragraph', content: 'second' }] },
  ].map((node) => new MarkdownTree(node as ConstructorParameters<typeof MarkdownTree>[0]).root);
}

describe('node signal controller on mounted components', () => {
  for (const [tag, property, firstIndex, secondIndex] of [
    ['md-block', 'node', 0, 1],
    ['md-section-ui', 'node', 0, 1],
    ['md-list-item-ui', 'node', 2, 3],
    ['md-inline', 'node', 4, 5],
    ['md-editor', 'root', 6, 7],
  ] as const) {
    test(`${tag} replaces and disposes subscriptions and reconnects`, async () => {
      const all = nodes();
      const first = all[firstIndex];
      const second = all[secondIndex];
      const element = (
        tag === 'md-inline' ? new MarkdownInline() : document.createElement(tag)
      ) as LitElement & {
        node?: ViewModelNode;
        root?: ViewModelNode;
      };
      // All selected elements accept the corresponding node type.
      element[property] = first;
      document.body.append(element);
      await element.updateComplete;
      const requests = vi.spyOn(element, 'requestUpdate');
      batch(() => {
        first[viewModel].renderSignal.value++;
        first[viewModel].renderSignal.value++;
      });
      expect(requests).toHaveBeenCalledTimes(1);
      await element.updateComplete;
      element[property] = second;
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
      if (tag === 'md-inline' || tag === 'md-editor') {
        element[property] = undefined;
        await element.updateComplete;
        requests.mockClear();
        second[viewModel].renderSignal.value++;
        expect(requests).not.toHaveBeenCalled();
        element[property] = second;
        await element.updateComplete;
      }
      element.remove();
      requests.mockClear();
      second[viewModel].renderSignal.value++;
      expect(requests).not.toHaveBeenCalled();
      element[property] = first;
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

  test('list item emits a typed task intent without mutating checked state', async () => {
    const item = nodes()[2] as ListItem['node'];
    const element = document.createElement('md-list-item-ui') as ListItem;
    const intents: TaskStateIntent[] = [];
    element.addEventListener(TASK_STATE_INTENT_EVENT, (event) => {
      intents.push((event as CustomEvent<TaskStateIntent>).detail);
    });
    element.node = item;
    document.body.append(element);
    await element.updateComplete;
    const gutter = element.shadowRoot!.querySelector('#gutter')!;
    const before = gutter.innerHTML;
    (gutter as HTMLElement).click();
    await element.updateComplete;
    expect(item.checked).toBe(false);
    expect(intents).toEqual([{ node: item, operation: 'cycle' }]);
    expect(gutter.innerHTML).toBe(before);
    expect(element.shadowRoot!.querySelector('#gutter')).toBe(gutter);
    element.remove();
  });
  test('numbered gutter displays the marker and emits typed task intents', async () => {
    const tree = new MarkdownTree({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '123456789) ',
              children: [{ type: 'paragraph', content: 'task' }],
            },
          ],
        },
      ],
    });
    const item = tree.root.children![0].children![0] as ListItem['node'];
    const element = document.createElement('md-list-item-ui') as ListItem;
    const intents: TaskStateIntent[] = [];
    element.addEventListener(TASK_STATE_INTENT_EVENT, (event) => {
      intents.push((event as CustomEvent<TaskStateIntent>).detail);
    });
    element.node = item;
    document.body.append(element);
    await element.updateComplete;
    const gutter = element.shadowRoot!.querySelector('#gutter')!;
    expect(gutter.querySelector('span')!.textContent).toBe('123456789)');
    for (let index = 0; index < 4; index++) {
      const button = gutter.querySelector('button')!;
      expect(button.getAttribute('aria-label')).toBe('Make task unchecked');
      expect(button.querySelector('svg') !== null).toBe(item.checked !== undefined);
      if (item.checked === undefined) button.querySelector('span')!.click();
      else button.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await element.updateComplete;
      expect(item.checked).toBeUndefined();
    }
    expect(intents).toHaveLength(4);
    expect(intents.every((intent) => intent.node === item && intent.operation === 'cycle')).toBe(
      true,
    );
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
