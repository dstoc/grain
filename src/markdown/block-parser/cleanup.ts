import { viewModel } from '../view-model-node.js';
import type { ViewModelNode } from '../view-model-node.js';
import { isAttached, hasContainerAncestor } from './utils.js';
import { type BlockParseState } from './types.js';
import { resetQuoteStack } from './container-management.js';

export function removeEmptyRootParagraph(state: BlockParseState) {
  if (state.root.children?.length !== 1) return;
  const onlyChild = state.root.children[0];
  if (onlyChild.type !== 'paragraph' || onlyChild.content !== '') return;
  onlyChild[viewModel].remove();
}

export function pruneDetachedState(state: BlockParseState) {
  state.sectionStack = state.sectionStack.filter((node) =>
    isAttached(state.root, node),
  );

  if (
    state.currentParagraph &&
    !isAttached(state.root, state.currentParagraph)
  ) {
    state.currentParagraph = undefined;
  }

  if (
    state.currentCodeBlock &&
    !isAttached(state.root, state.currentCodeBlock)
  ) {
    state.currentCodeBlock = undefined;
    state.currentCodeFence = undefined;
  }

  if (
    state.currentQuoteBase &&
    !isAttached(state.root, state.currentQuoteBase)
  ) {
    state.currentQuoteBase = undefined;
    state.currentQuoteStack = [];
  } else {
    state.currentQuoteStack = state.currentQuoteStack.filter((node) =>
      isAttached(state.root, node),
    );
  }

  state.currentListPath = state.currentListPath.filter((node) =>
    isAttached(state.root, node),
  );

  if (state.currentList && !isAttached(state.root, state.currentList)) {
    state.currentList = undefined;
  }

  const currentListItem = state.currentListPath.at(-1);
  const parent = currentListItem?.[viewModel].parent;
  if (parent?.type === 'list') {
    state.currentList = parent;
  }
}

export function cleanupInactiveEmptyBlocks(state: BlockParseState) {
  const preserved = new Set<ViewModelNode>();
  for (const node of activeNodes(state)) {
    let current: ViewModelNode | undefined = node;
    while (current && !preserved.has(current)) {
      preserved.add(current);
      current = current[viewModel].parent;
    }
  }

  for (const node of collectEmptyBlocks(state.root)) {
    if (!preserved.has(node)) {
      node[viewModel].remove();
    }
  }
  pruneDetachedState(state);
}

function* activeNodes(state: BlockParseState): Generator<ViewModelNode> {
  yield state.root;
  if (state.currentParagraph) yield state.currentParagraph;
  if (state.currentList) yield state.currentList;
  for (const node of state.currentListPath) yield node;
  if (state.currentQuoteBase) yield state.currentQuoteBase;
  for (const node of state.currentQuoteStack) yield node;
  if (state.currentCodeBlock) yield state.currentCodeBlock;
  for (const node of state.sectionStack) yield node;
}

export function collectEmptyBlocks(root: ViewModelNode): ViewModelNode[] {
  const result: ViewModelNode[] = [];

  function visit(node: ViewModelNode) {
    for (const child of (node.children ?? []) as ViewModelNode[]) {
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
  resetQuoteStack(state);
  state.sectionStack = state.sectionStack.filter(
    (node) =>
      !hasContainerAncestor(node, 'list-item') &&
      !hasContainerAncestor(node, 'block-quote'),
  );
  pruneDetachedState(state);
}
