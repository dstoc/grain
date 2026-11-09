import { serializeToString } from '../../markdown/block-serializer.js';
import type { MarkdownNode } from '../../markdown/node.js';
import type { ReadonlyMarkdownNodeView } from '../../markdown/node-view.js';

export interface ClipboardPayload {
  readonly markdown: string;
  readonly text: string;
}

export function serializeBlockSelection(
  document: { readonly root: ReadonlyMarkdownNodeView },
  selection: readonly ReadonlyMarkdownNodeView[],
): string {
  const selected = new Set(selection);
  const sectionsWithSelectedChildren = new WeakSet<MarkdownNode>();
  const hasSelectedDescendant = (node: ReadonlyMarkdownNodeView): boolean =>
    (node.children ?? []).some((child) => selected.has(child) || hasSelectedDescendant(child));
  const roots = new Set<ReadonlyMarkdownNodeView>();
  for (const node of selection) {
    if (node.previousSibling) {
      roots.add(node);
      continue;
    }
    let root = node;
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.type === 'section') break;
      root = ancestor;
      if (ancestor.previousSibling) break;
    }
    roots.add(root);
  }
  for (const root of roots) {
    for (let ancestor = root.parent; ancestor; ancestor = ancestor.parent) {
      if (roots.has(ancestor)) {
        roots.delete(root);
        break;
      }
    }
  }
  const order = new Map<ReadonlyMarkdownNodeView, number>();
  const visit = (node: ReadonlyMarkdownNodeView) => {
    order.set(node, order.size);
    (node.children ?? []).forEach(visit);
  };
  visit(document.root);
  const convert = (node: ReadonlyMarkdownNodeView): MarkdownNode | undefined => {
    const children = (node.children ?? [])
      .map(convert)
      .filter((child): child is MarkdownNode => child !== undefined);
    const isSelected = selected.has(node);
    let result: MarkdownNode;
    switch (node.type) {
      case 'document':
        if (!children.length) return undefined;
        result = { type: 'document', children };
        break;
      case 'paragraph':
        if (!isSelected) return undefined;
        result = { type: 'paragraph', content: node.content ?? '' };
        break;
      case 'section':
        if (!isSelected && !children.length) return undefined;
        result = {
          type: 'section',
          marker: node.marker ?? '',
          content: isSelected ? (node.content ?? '') : '',
          children,
        };
        if (isSelected && hasSelectedDescendant(node)) sectionsWithSelectedChildren.add(result);
        break;
      case 'code-block':
        if (!isSelected) return undefined;
        result = { type: 'code-block', info: node.info ?? null, content: node.content ?? '' };
        break;
      case 'list':
        if (!children.length) return undefined;
        result = { type: 'list', children };
        break;
      case 'list-item':
        if (!children.length) return undefined;
        result = {
          type: 'list-item',
          marker: node.marker ?? '',
          ...(node.checked === undefined ? {} : { checked: node.checked }),
          children,
        };
        break;
      case 'block-quote':
        if (!children.length) return undefined;
        result = { type: 'block-quote', marker: node.marker ?? '', children };
        break;
    }
    return result;
  };
  const orderedRoots = [...roots].toSorted((a, b) => order.get(a)! - order.get(b)!);
  const blocks = orderedRoots
    .map(convert)
    .filter((block): block is MarkdownNode => block !== undefined);
  return blocks.length
    ? serializeToString({ type: 'document', children: blocks }, undefined, undefined, (node) =>
        sectionsWithSelectedChildren.has(node) ? '\n' : undefined,
      )
    : '';
}

export function writeMarkdownClipboard(event: ClipboardEvent, markdown: string): boolean {
  event.preventDefault();
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  try {
    clipboard.setData('text/plain', markdown);
  } catch {
    return false;
  }
  try {
    clipboard.setData('text/markdown', markdown);
  } catch {
    // Plain text is sufficient when the browser rejects custom clipboard data.
  }
  return true;
}

export function readClipboardPayload(clipboard: ClipboardEvent['clipboardData']): ClipboardPayload {
  return {
    markdown: clipboard?.getData('text/markdown') ?? '',
    text: clipboard?.getData('text/plain') ?? '',
  };
}
