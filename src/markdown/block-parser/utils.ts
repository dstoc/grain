import type { ConstructionNode } from '../semantic/construction-tree.js';
import type {
  BlockParseState,
  ConstructionListItemNode,
  ConstructionBlockQuoteNode,
} from './types.js';
import type { CreateNodeSpec } from '../semantic/types.js';

export function isBlankLine(line: string): boolean {
  return /^\s*$/.test(line);
}

export function createSemanticNode(state: BlockParseState, spec: CreateNodeSpec): ConstructionNode {
  return state.tree.node(state.draft.create(spec));
}

export function placeSemanticNode(
  state: BlockParseState,
  node: ConstructionNode,
  parent: ConstructionNode,
  before?: ConstructionNode,
): void {
  state.draft.place(node.id, parent.id, before?.id ?? null);
}

export function detachSemanticNodeIfAttached(state: BlockParseState, node: ConstructionNode): void {
  if (state.draft.parentOf(node.id) !== undefined) state.draft.detach(node.id);
}

export function editSemanticText(
  state: BlockParseState,
  node: ConstructionNode,
  from: number,
  to: number,
  insert: string,
): void {
  state.draft.spliceText(node.id, { from, to, insert });
}

export function isInsideListPath(
  node: ConstructionNode,
  ancestor?: ConstructionListItemNode,
): boolean {
  if (!ancestor) return false;
  let parent: ConstructionNode | undefined = node;
  while (parent) {
    if (parent === ancestor) return true;
    parent = parent.parent;
  }
  return false;
}

export function isAttached(root: ConstructionNode, node: ConstructionNode): boolean {
  return pathForNode(root, node) !== undefined;
}

export function hasContainerAncestor(
  node: ConstructionNode,
  type: 'list-item' | 'block-quote',
): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === type) return true;
    parent = parent.parent;
  }
  return false;
}

export function pathForNode(root: ConstructionNode, node?: ConstructionNode): number[] | undefined {
  if (!node) return;
  const path: number[] = [];
  while (node !== root) {
    const parent: ConstructionNode | undefined = node.parent;
    if (!parent) return;
    const index = parent.children?.indexOf(node);
    if (index === undefined || index < 0) return;
    path.unshift(index);
    node = parent;
  }
  return path;
}

export function nodeAtPath(root: ConstructionNode, path?: number[]): ConstructionNode | undefined {
  if (!path) return;
  let node: ConstructionNode | undefined = root;
  for (const index of path) {
    node = node.children?.[index];
    if (!node) return;
  }
  return node;
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function currentSectionContainer(state: BlockParseState): ConstructionNode {
  return state.sectionStack.at(-1) ?? state.root;
}

export function listContinuationPrefix(
  state: BlockParseState,
  item?: ConstructionListItemNode,
): string {
  return ' '.repeat(item ? (state.sourceMarkerWidths.get(item) ?? item.marker.length) : 0);
}

export function nextListPathItem(
  path: ConstructionListItemNode[],
  container: ConstructionNode,
  depth: number,
): ConstructionListItemNode | undefined {
  const item = path[depth];
  const parent = item?.parent;
  if (parent?.type !== 'list') return;
  return parent.parent === container ? item : undefined;
}

export function getQuotedPrefixContainer(
  state: BlockParseState,
  base: ConstructionNode,
  depth: number,
): ConstructionNode | undefined {
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
  base: ConstructionNode,
): ConstructionBlockQuoteNode[] {
  const seed =
    state.currentCodeBlock ??
    state.currentParagraph ??
    state.currentListPath.at(-1) ??
    state.currentQuoteStack.at(-1) ??
    state.sectionStack.at(-1);
  if (!seed) return [];

  const path: ConstructionNode[] = [];
  let node: ConstructionNode | undefined = seed;
  while (node && node !== base) {
    path.push(node);
    node = node.parent;
  }
  if (node !== base) return [];

  const chain = path
    .reverse()
    .filter((node): node is ConstructionBlockQuoteNode => node.type === 'block-quote');
  return chain.length ? chain : trailingQuoteChainFromBase(base);
}

function trailingQuoteChainFromBase(base: ConstructionNode): ConstructionBlockQuoteNode[] {
  const quotes: ConstructionBlockQuoteNode[] = [];
  let current = base.children?.at(-1);
  while (current?.type === 'block-quote') {
    quotes.push(current as ConstructionBlockQuoteNode);
    current = current.children?.at(-1);
  }
  return quotes.some(hasBlockQuoteDescendant) ? quotes : [];
}

function hasBlockQuoteDescendant(node: ConstructionNode): boolean {
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
  node: ConstructionNode,
): { quoteBase: ConstructionNode; quoteDepth: number } | undefined {
  const quotes: ConstructionBlockQuoteNode[] = [];
  let current: ConstructionNode | undefined = node.parent;
  let quoteBase: ConstructionNode | undefined;

  while (current) {
    if (current.type === 'block-quote') {
      quotes.push(current);
    } else if (quotes.length) {
      quoteBase = current;
      break;
    }
    current = current.parent;
  }

  if (!quoteBase || quotes.length === 0) {
    return;
  }

  return {
    quoteBase,
    quoteDepth: quotes.length,
  };
}
