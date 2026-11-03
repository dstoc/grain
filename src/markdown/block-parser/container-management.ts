import type { ConstructionNode } from '../semantic/construction-tree.js';
import {
  type BlockParseState,
  type ConstructionBlockQuoteNode,
  type ConstructionListNode,
  type ConstructionListItemNode,
} from './types.js';
import { createSemanticNode, isInsideListPath, placeSemanticNode } from './utils.js';
import { removeEmptyRootParagraph as ensurePlaceholderRemoved } from './cleanup.js';

export function resetQuoteStack(state: BlockParseState) {
  state.currentQuoteBase = undefined;
  state.currentQuoteStack = [];
}

export function syncQuoteStack(
  state: BlockParseState,
  base: ConstructionNode,
  depth: number,
): ConstructionNode {
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
    const quote = createSemanticNode(state, {
      type: 'block-quote',
      marker: '> ',
    }) as ConstructionBlockQuoteNode;
    placeSemanticNode(state, quote, parent);
    state.currentQuoteStack.push(quote);
    state.sawContent = true;
  }

  return state.currentQuoteStack.at(-1) ?? base;
}

export function ensureListContainer(
  state: BlockParseState,
  parent: ConstructionNode,
): ConstructionListNode {
  if (state.currentList?.parent === parent) {
    return state.currentList;
  }

  const lastChild = parent.children?.at(-1);
  if (lastChild?.type === 'list') {
    const list = lastChild as ConstructionListNode;
    state.currentList = list;
    return list;
  }

  const list = createSemanticNode(state, {
    type: 'list',
  }) as ConstructionListNode;
  placeSemanticNode(state, list, parent);
  state.currentList = list;
  return list;
}

export function buildListPath(
  state: BlockParseState,
  parent: ConstructionNode,
  item: ConstructionListItemNode,
): ConstructionListItemNode[] {
  for (let depth = state.currentListPath.length - 1; depth >= 0; depth--) {
    const ancestor = state.currentListPath[depth];
    if (parent === ancestor || isInsideListPath(parent, ancestor)) {
      return [...state.currentListPath.slice(0, depth + 1), item];
    }
  }
  return [item];
}

export function syncSectionStack(state: BlockParseState, parent: ConstructionNode) {
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
