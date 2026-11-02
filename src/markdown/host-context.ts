import { createContext } from '@lit/context';

import { cast } from '../asserts.js';
import type { MarkdownRenderDelegate } from './render-delegate.js';
import { compareDocumentOrder } from './view-model-util.js';
import type { InlineMarkdownNodeView, ReadonlyMarkdownNodeView } from './node-view.js';
import type { CanonicalWriter } from './canonical-actions.js';

export class HostContext {
  focusNode?: InlineMarkdownNodeView;
  focusOffset?: number;
  root?: ReadonlyMarkdownNodeView;
  renderDelegate?: MarkdownRenderDelegate;
  canonicalWriter?: CanonicalWriter;
  readonly selection = new Set<InlineMarkdownNodeView>();
  selectionAnchor?: InlineMarkdownNodeView;
  selectionFocus?: InlineMarkdownNodeView;

  get hasSelection() {
    return !!this.selection.size;
  }

  clearSelection() {
    if (!this.selection.size) return;
    const [...selection] = this.selection.values();
    this.selection.clear();
    this.selectionAnchor = undefined;
    this.selectionFocus = undefined;
    for (const node of selection) {
      invalidateNodeView(node);
    }
  }

  setSelection(anchor: InlineMarkdownNodeView, focus: InlineMarkdownNodeView) {
    this.selectionAnchor = anchor;
    this.selectionFocus = focus;
    this.selection.add(anchor);
    this.selection.add(focus);
    invalidateNodeView(anchor);
    invalidateNodeView(focus);
  }

  extendSelection(from: InlineMarkdownNodeView, to: InlineMarkdownNodeView) {
    if (this.selection.has(to)) {
      this.selection.delete(from);
      if (this.selectionAnchor === from) {
        this.selectionAnchor = to;
      }
      invalidateNodeView(from);
    }
    this.selection.add(to);
    this.selectionFocus = to;
    invalidateNodeView(to);
  }

  expandSelection(nodes: Iterable<InlineMarkdownNodeView>) {
    const oldAnchor = this.selectionAnchor;
    const oldFocus = this.selectionFocus;
    for (const node of nodes) {
      this.selection.add(node);
    }
    for (const node of nodes) {
      invalidateNodeView(node);
    }
    const sorted = [...this.selection].sort(compareDocumentOrder);
    this.selectionAnchor = sorted[0];
    this.selectionFocus = cast(sorted.at(-1));
    oldAnchor && invalidateNodeView(oldAnchor);
    oldFocus && invalidateNodeView(oldFocus);
    focusNode(this, this.selectionFocus);
  }
}

export const hostContext = createContext<HostContext | undefined>('hostContext');

export function focusNode(context: HostContext, node: InlineMarkdownNodeView, offset?: number) {
  context.focusNode = node;
  context.focusOffset = offset;
  invalidateNodeView(node);
}

export function invalidateNodeView(node: InlineMarkdownNodeView): void {
  // The exposed signal is read-only in the renderer contract. Only this host
  // adapter can invalidate it for selection and focus styling.
  const signal = node.renderSignal as { value: number };
  signal.value++;
}
