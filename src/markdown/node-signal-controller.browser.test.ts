import type { LitElement } from 'lit';
import { batch } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import { describe, expect, test, vi } from 'vitest';
import './block-render.js';
import { MarkdownInline } from './inline-render.js';
import { ConstructionPreviewAdapter } from './construction-preview.js';
import { ConstructionTree } from './semantic/construction-tree.js';
import type { ListItem } from './block-ui.js';
import { TASK_STATE_INTENT_EVENT, type TaskStateIntent } from './render-intents.js';
import { asInlineMarkdownNodeView, type ReadonlyMarkdownNodeView } from './node-view.js';
import type { MarkdownNode } from './node.js';

function viewOf(node: MarkdownNode): ReadonlyMarkdownNodeView {
  return new ConstructionPreviewAdapter(
    new ConstructionTree({ type: 'document', children: [node] }),
  ).root.children![0]!;
}

function nodes(): ReadonlyMarkdownNodeView[] {
  const firstDocument = new ConstructionPreviewAdapter(
    new ConstructionTree({ type: 'document', children: [{ type: 'paragraph', content: 'first' }] }),
  );
  const secondDocument = new ConstructionPreviewAdapter(
    new ConstructionTree({
      type: 'document',
      children: [{ type: 'paragraph', content: 'second' }],
    }),
  );
  return [
    viewOf({ type: 'section', marker: '#', content: '', children: [] }),
    viewOf({ type: 'section', marker: '##', content: '', children: [] }),
    viewOf({ type: 'list-item', marker: '-', checked: false, children: [] }),
    viewOf({ type: 'list-item', marker: '-', checked: true, children: [] }),
    viewOf({ type: 'paragraph', content: 'first' }),
    viewOf({ type: 'paragraph', content: 'second' }),
    firstDocument.root,
    secondDocument.root,
  ];
}

function mutableSignal(node: ReadonlyMarkdownNodeView): Signal<number> {
  return node.renderSignal as Signal<number>;
}

describe('node signal controller on mounted components', () => {
  for (const [tag, firstIndex, secondIndex] of [
    ['md-block', 0, 1],
    ['md-section-ui', 0, 1],
    ['md-list-item-ui', 2, 3],
    ['md-inline', 4, 5],
  ] as const) {
    test(`${tag} replaces and disposes subscriptions and reconnects`, async () => {
      const all = nodes();
      const first = all[firstIndex]!;
      const second = all[secondIndex]!;
      const element = (
        tag === 'md-inline' ? new MarkdownInline() : document.createElement(tag)
      ) as LitElement & {
        node?: ReadonlyMarkdownNodeView;
        nodeView?: ReturnType<typeof asInlineMarkdownNodeView>;
      };
      const setNode = (node: ReadonlyMarkdownNodeView | undefined) => {
        if (element instanceof MarkdownInline) {
          element.nodeView = node ? asInlineMarkdownNodeView(node) : undefined;
        } else {
          element.node = node;
        }
      };
      setNode(first);
      document.body.append(element);
      await element.updateComplete;
      const requests = vi.spyOn(element, 'requestUpdate');
      batch(() => {
        mutableSignal(first).value++;
        mutableSignal(first).value++;
      });
      expect(requests).toHaveBeenCalledTimes(1);
      await element.updateComplete;
      setNode(second);
      requests.mockClear();
      mutableSignal(first).value++;
      expect(requests).not.toHaveBeenCalled();
      await element.updateComplete;
      requests.mockClear();
      mutableSignal(first).value++;
      expect(requests).not.toHaveBeenCalled();
      mutableSignal(second).value++;
      expect(requests).toHaveBeenCalledTimes(1);
      await element.updateComplete;
      if (element instanceof MarkdownInline) {
        setNode(undefined);
        await element.updateComplete;
        requests.mockClear();
        mutableSignal(second).value++;
        expect(requests).not.toHaveBeenCalled();
        setNode(second);
        await element.updateComplete;
      }
      element.remove();
      requests.mockClear();
      mutableSignal(second).value++;
      expect(requests).not.toHaveBeenCalled();
      setNode(first);
      requests.mockClear();
      document.body.append(element);
      await element.updateComplete;
      requests.mockClear();
      mutableSignal(second).value++;
      expect(requests).not.toHaveBeenCalled();
      mutableSignal(first).value++;
      expect(requests).toHaveBeenCalledTimes(1);
      await element.updateComplete;
      element.remove();
      document.body.append(element);
      await element.updateComplete;
      requests.mockClear();
      mutableSignal(first).value++;
      expect(requests).toHaveBeenCalledTimes(1);
      element.remove();
    });
  }

  test('list item emits a typed task intent without mutating checked state', async () => {
    const item = viewOf({
      type: 'list-item',
      marker: '-',
      checked: false,
      children: [],
    }) as ListItem['node'];
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
    const tree = new ConstructionTree({
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
    const item = new ConstructionPreviewAdapter(tree).root.children![0]!
      .children![0]! as ListItem['node'];
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
    const tree = new ConstructionTree({
      type: 'document',
      children: [
        { type: 'paragraph', content: 'hello' },
        { type: 'paragraph', content: 'world' },
      ],
    });
    const preview = new ConstructionPreviewAdapter(tree);
    const block = document.createElement('md-block');
    block.node = preview.root;
    document.body.append(block);
    await block.updateComplete;
    const children = Array.from(
      block.querySelectorAll<HTMLElementTagNameMap['md-block']>(':scope > md-block'),
    );
    await Promise.all(children.map((child) => child.updateComplete));
    const inline = children[0]!.querySelector('md-inline')!;
    await inline.updateComplete;
    inline.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(inline);
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString();
    mutableSignal(preview.root).value++;
    mutableSignal(preview.root).value++;
    await block.updateComplete;
    expect(
      Array.from(block.querySelectorAll<HTMLElementTagNameMap['md-block']>(':scope > md-block')),
    ).toEqual(children);
    expect(document.activeElement).toBe(inline);
    expect(selection.toString()).toBe(selected);
    block.remove();
  });
});
