import { viewModel } from '../view-model-node.js';
import type { ViewModelNode } from '../view-model-node.js';
import type { BlockParseState, ListItemViewModelNode, BlockQuoteViewModelNode } from './types.js';

export function isBlankLine(line: string): boolean {
  return /^\s*$/.test(line);
}

export function isInsideListPath(node: ViewModelNode, ancestor?: ListItemViewModelNode): boolean {
  if (!ancestor) return false;
  let parent: ViewModelNode | undefined = node;
  while (parent) {
    if (parent === ancestor) return true;
    parent = parent[viewModel].parent;
  }
  return false;
}

export function isAttached(root: ViewModelNode, node: ViewModelNode): boolean {
  return pathForNode(root, node) !== undefined;
}

export function hasContainerAncestor(
  node: ViewModelNode,
  type: 'list-item' | 'block-quote',
): boolean {
  let parent = node[viewModel].parent;
  while (parent) {
    if (parent.type === type) return true;
    parent = parent[viewModel].parent;
  }
  return false;
}

export function pathForNode(root: ViewModelNode, node?: ViewModelNode): number[] | undefined {
  if (!node) return;
  const path: number[] = [];
  while (node !== root) {
    const parent: ViewModelNode | undefined = node[viewModel].parent;
    if (!parent) return;
    const index = parent.children?.indexOf(node);
    if (index === undefined || index < 0) return;
    path.unshift(index);
    node = parent;
  }
  return path;
}

export function nodeAtPath(root: ViewModelNode, path?: number[]): ViewModelNode | undefined {
  if (!path) return;
  let node: ViewModelNode | undefined = root;
  for (const index of path) {
    node = node.children?.[index];
    if (!node) return;
  }
  return node;
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function currentSectionContainer(state: BlockParseState): ViewModelNode {
  return state.sectionStack.at(-1) ?? state.root;
}

export function listContinuationPrefix(
  state: BlockParseState,
  item?: ListItemViewModelNode,
): string {
  return ' '.repeat(item ? (state.sourceMarkerWidths.get(item) ?? item.marker.length) : 0);
}

export function nextListPathItem(
  path: ListItemViewModelNode[],
  container: ViewModelNode,
  depth: number,
): ListItemViewModelNode | undefined {
  const item = path[depth];
  const parent = item?.[viewModel].parent;
  if (parent?.type !== 'list') return;
  return parent[viewModel].parent === container ? item : undefined;
}

export function getQuotedPrefixContainer(
  state: BlockParseState,
  base: ViewModelNode,
  depth: number,
): ViewModelNode | undefined {
  const activeChain = activeQuoteChainForBase(state, base);
  if (activeChain.length >= depth) {
    return activeChain[depth - 1];
  }
  if (state.currentQuoteBase === base) {
    return state.currentQuoteStack[depth - 1];
  }
  return activeChain[depth - 1];
}

export function activeQuoteChainForBase(
  state: BlockParseState,
  base: ViewModelNode,
): BlockQuoteViewModelNode[] {
  const seed =
    state.currentCodeBlock ??
    state.currentParagraph ??
    state.currentListPath.at(-1) ??
    state.currentQuoteStack.at(-1) ??
    state.sectionStack.at(-1);
  if (!seed) return [];

  const path: ViewModelNode[] = [];
  let node: ViewModelNode | undefined = seed;
  while (node && node !== base) {
    path.push(node);
    node = node[viewModel].parent;
  }
  if (node !== base) return [];

  const chain = path
    .reverse()
    .filter((node): node is BlockQuoteViewModelNode => node.type === 'block-quote');
  return chain.length ? chain : trailingQuoteChainFromBase(base);
}

function trailingQuoteChainFromBase(base: ViewModelNode): BlockQuoteViewModelNode[] {
  const quotes: BlockQuoteViewModelNode[] = [];
  let current = base.children?.at(-1);
  while (current?.type === 'block-quote') {
    quotes.push(current as BlockQuoteViewModelNode);
    current = current.children?.at(-1);
  }
  return quotes.some(hasBlockQuoteDescendant) ? quotes : [];
}

function hasBlockQuoteDescendant(node: ViewModelNode): boolean {
  for (const child of node.children ?? []) {
    if (child.type === 'block-quote') {
      return true;
    }
    if (child.children?.length && hasBlockQuoteDescendant(child)) {
      return true;
    }
  }
  return false;
}

export function quoteContextForNode(
  node: ViewModelNode,
): { quoteBase: ViewModelNode; quoteDepth: number } | undefined {
  const quotes: BlockQuoteViewModelNode[] = [];
  let current: ViewModelNode | undefined = node[viewModel].parent;
  let quoteBase: ViewModelNode | undefined;

  while (current) {
    if (current.type === 'block-quote') {
      quotes.push(current);
    } else if (quotes.length) {
      quoteBase = current;
      break;
    }
    current = current[viewModel].parent;
  }

  if (!quoteBase || quotes.length === 0) {
    return;
  }

  return {
    quoteBase,
    quoteDepth: quotes.length,
  };
}
