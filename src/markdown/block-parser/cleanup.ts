import type { ConstructionNode } from '../semantic/construction-tree.js';
import { detachSemanticNodeIfAttached, hasContainerAncestor, isAttached } from './utils.js';
import { type BlockParseState } from './types.js';

export function removeEmptyRootParagraph(state: BlockParseState) {
  if (state.hasExplicitRootParagraph) return;
  if (state.root.children?.length !== 1) return;
  const onlyChild = state.root.children[0];
  if (onlyChild.type !== 'paragraph' || onlyChild.content !== '') return;
  detachSemanticNodeIfAttached(state, onlyChild);
}

export function pruneDetachedState(state: BlockParseState) {
  state.sectionStack = state.sectionStack.filter((node) => isAttached(state.root, node));

  if (state.currentParagraph && !isAttached(state.root, state.currentParagraph)) {
    state.currentParagraph = undefined;
  }

  if (state.currentCodeBlock && !isAttached(state.root, state.currentCodeBlock)) {
    state.currentCodeBlock = undefined;
    state.currentCodeFence = undefined;
  }

  if (state.currentQuoteBase && !isAttached(state.root, state.currentQuoteBase)) {
    state.currentQuoteBase = undefined;
    state.currentQuoteStack = [];
  } else {
    state.currentQuoteStack = state.currentQuoteStack.filter((node) =>
      isAttached(state.root, node),
    );
  }

  state.currentListPath = state.currentListPath.filter((node) => isAttached(state.root, node));

  if (state.currentList && !isAttached(state.root, state.currentList)) {
    state.currentList = undefined;
  }

  const currentListItem = state.currentListPath.at(-1);
  const parent = currentListItem?.parent;
  if (parent?.type === 'list') {
    state.currentList = parent;
  }
}

export function cleanupInactiveEmptyBlocks(state: BlockParseState) {
  const preserved = new Set<ConstructionNode>();
  for (const node of activeNodes(state)) {
    let current: ConstructionNode | undefined = node;
    while (current && !preserved.has(current)) {
      preserved.add(current);
      current = current.parent;
    }
  }

  for (const node of collectEmptyBlocks(state.root)) {
    if (!preserved.has(node)) {
      detachSemanticNodeIfAttached(state, node);
    }
  }
  pruneDetachedState(state);
}

function* activeNodes(state: BlockParseState): Generator<ConstructionNode> {
  yield state.root;
  if (state.currentParagraph) yield state.currentParagraph;
  if (state.currentList) yield state.currentList;
  for (const node of state.currentListPath) yield node;
  if (state.currentQuoteBase) yield state.currentQuoteBase;
  for (const node of state.currentQuoteStack) yield node;
  if (state.currentCodeBlock) yield state.currentCodeBlock;
  for (const node of state.sectionStack) yield node;
}

function collectEmptyBlocks(root: ConstructionNode): ConstructionNode[] {
  const result: ConstructionNode[] = [];

  function visit(node: ConstructionNode) {
    for (const child of (node.children ?? []) as ConstructionNode[]) {
      visit(child);
    }
    if (
      node !== root &&
      !node.children?.length &&
      ['list-item', 'list', 'block-quote'].includes(node.type)
    ) {
      result.push(node);
    }
  }

  visit(root);
  return result;
}

export function exitDetachedContainerContexts(state: BlockParseState) {
  state.currentList = undefined;
  state.currentListPath = [];
  state.currentQuoteBase = undefined;
  state.currentQuoteStack = [];
  state.sectionStack = state.sectionStack.filter(
    (node) =>
      !hasContainerAncestor(node, 'list-item') && !hasContainerAncestor(node, 'block-quote'),
  );
  pruneDetachedState(state);
}
