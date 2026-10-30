import { viewModel } from '../view-model-node.js';
import type { ViewModelNode } from '../view-model-node.js';
import {
  type BlockParseState,
  type BlockQuoteViewModelNode,
  type ListViewModelNode,
  type ListItemViewModelNode,
} from './types.js';
import { isInsideListPath } from './utils.js';
import { removeEmptyRootParagraph as ensurePlaceholderRemoved } from './cleanup.js';

export function resetQuoteStack(state: BlockParseState) {
  state.currentQuoteBase = undefined;
  state.currentQuoteStack = [];
}

export function syncQuoteStack(
  state: BlockParseState,
  base: ViewModelNode,
  depth: number,
): ViewModelNode {
  if (depth === 0) {
    resetQuoteStack(state);
    return base;
  }

  if (state.currentQuoteBase !== base) {
    resetQuoteStack(state);
    state.currentQuoteBase = base;
  }

  while (state.currentQuoteStack.length > depth) {
    state.currentQuoteStack.pop();
  }

  while (state.currentQuoteStack.length < depth) {
    ensurePlaceholderRemoved(state);
    const parent = state.currentQuoteStack.at(-1) ?? base;
    const quote = state.tree.add({
      type: 'block-quote',
      marker: '> ',
      children: [],
    }) as BlockQuoteViewModelNode;
    quote[viewModel].insertBefore(parent);
    state.currentQuoteStack.push(quote);
    state.sawContent = true;
  }

  return state.currentQuoteStack.at(-1) ?? base;
}

export function ensureListContainer(
  state: BlockParseState,
  parent: ViewModelNode,
): ListViewModelNode {
  if (state.currentList?.[viewModel].parent === parent) {
    return state.currentList;
  }

  const lastChild = parent.children?.at(-1);
  if (lastChild?.type === 'list') {
    const list = lastChild as ListViewModelNode;
    state.currentList = list;
    return list;
  }

  const list = state.tree.add({
    type: 'list',
    children: [],
  }) as ListViewModelNode;
  list[viewModel].insertBefore(parent);
  state.currentList = list;
  return list;
}

export function buildListPath(
  state: BlockParseState,
  parent: ViewModelNode,
  item: ListItemViewModelNode,
): ListItemViewModelNode[] {
  for (let depth = state.currentListPath.length - 1; depth >= 0; depth--) {
    const ancestor = state.currentListPath[depth];
    if (parent === ancestor || isInsideListPath(parent, ancestor)) {
      return [...state.currentListPath.slice(0, depth + 1), item];
    }
  }
  return [item];
}

export function syncSectionStack(state: BlockParseState, parent: ViewModelNode) {
  if (parent.type !== 'section') {
    state.sectionStack.length = 0;
    return;
  }
  while (state.sectionStack.length && state.sectionStack.at(-1) !== parent) {
    state.sectionStack.pop();
  }
}

export function popSectionsToLevel(state: BlockParseState, level: number) {
  while (state.sectionStack.length >= level) {
    state.sectionStack.pop();
  }
}
