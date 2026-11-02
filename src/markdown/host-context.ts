import { createContext } from '@lit/context';

import { cast } from '../asserts.js';
import type { MarkdownRenderDelegate } from './render-delegate.js';
import { compareDocumentOrder } from './view-model-util.js';
import { type InlineViewModelNode, type ViewModelNode } from './view-model-node.js';
import type { CanonicalWriter } from './canonical-actions.js';

export class HostContext {
  focusNode?: InlineViewModelNode;
  focusOffset?: number;
  root?: ViewModelNode;
  renderDelegate?: MarkdownRenderDelegate;
  canonicalWriter?: CanonicalWriter;
  readonly selection = new Set<InlineViewModelNode>();
  selectionAnchor?: InlineViewModelNode;
  selectionFocus?: InlineViewModelNode;

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
      node.renderSignal.value++;
    }
  }

  setSelection(anchor: InlineViewModelNode, focus: InlineViewModelNode) {
    this.selectionAnchor = anchor;
    this.selectionFocus = focus;
    this.selection.add(anchor);
    this.selection.add(focus);
    anchor.renderSignal.value++;
    focus.renderSignal.value++;
  }

  extendSelection(from: InlineViewModelNode, to: InlineViewModelNode) {
    if (this.selection.has(to)) {
      this.selection.delete(from);
      if (this.selectionAnchor === from) {
        this.selectionAnchor = to;
      }
      from.renderSignal.value++;
    }
    this.selection.add(to);
    this.selectionFocus = to;
    to.renderSignal.value++;
  }

  expandSelection(nodes: Iterable<InlineViewModelNode>) {
    const oldAnchor = this.selectionAnchor;
    const oldFocus = this.selectionFocus;
    for (const node of nodes) {
      this.selection.add(node);
    }
    for (const node of nodes) {
      node.renderSignal.value++;
    }
    const sorted = [...this.selection].sort(compareDocumentOrder);
    this.selectionAnchor = sorted[0];
    this.selectionFocus = cast(sorted.at(-1));
    oldAnchor && oldAnchor.renderSignal.value++;
    oldFocus && oldFocus.renderSignal.value++;
    focusNode(this, this.selectionFocus);
  }
}

export const hostContext = createContext<HostContext | undefined>('hostContext');

export function focusNode(context: HostContext, node: InlineViewModelNode, offset?: number) {
  context.focusNode = node;
  context.focusOffset = offset;
  node.renderSignal.value++;
}
