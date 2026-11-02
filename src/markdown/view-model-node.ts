import {
  type MarkdownNode,
  type InlineNode,
  type DocumentNode,
  type ListNode,
  type BlockQuoteNode,
  type ListItemNode,
  isInlineNode,
} from './node.js';
import type { ViewModel, InlineViewModel } from './view-model.js';
import type { Signal } from '@preact/signals-core';
import type { InlineTree } from './inline-parser.js';

export const viewModel = Symbol('viewModel');

export interface Caches {
  _?: undefined;
}

interface MaybeViewModelNodeParts {
  [viewModel]?: ViewModel;
  children?: MarkdownNode[];
}
export type MaybeViewModelNode = MarkdownNode & MaybeViewModelNodeParts;

interface ViewModelNodeParts {
  [viewModel]: ViewModel;
  id: number;
  connected: boolean;
  version: number;
  parent?: ViewModelNode;
  previousSibling?: ViewModelNode;
  nextSibling?: ViewModelNode;
  renderSignal: Signal<number>;
  inlineTree?: InlineTree;
  children?: (MarkdownNode & ViewModelNode)[];
}

interface InlineViewModelNodeParts extends ViewModelNodeParts {
  [viewModel]: InlineViewModel;
  inlineTree: InlineTree;
  children?: (MarkdownNode & ViewModelNode)[];
}

export type ViewModelNode =
  | ((DocumentNode | ListNode | BlockQuoteNode | ListItemNode) & ViewModelNodeParts)
  | InlineViewModelNode;

export type InlineViewModelNode = InlineNode & InlineViewModelNodeParts;

export function isInlineViewModelNode(node: ViewModelNode): node is InlineViewModelNode {
  return isInlineNode(node);
}
