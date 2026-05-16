import type { ViewModelNode } from '../../view-model-node.js';
import { type BlockParseState } from '../types.js';
import { hasContainerAncestor } from '../utils.js';
import { syncQuoteStack, resetQuoteStack } from '../container-management.js';

export function projectPendingQuoteOpen(
  state: BlockParseState,
  parent: ViewModelNode,
) {
  syncQuoteStack(state, parent, 1);
}

export function closeQuote(state: BlockParseState) {
  if (state.currentParagraph && isInsideBlockQuote(state.currentParagraph)) {
    state.currentParagraph = undefined;
  }
  resetQuoteStack(state);
}

function isInsideBlockQuote(node: ViewModelNode): boolean {
  return hasContainerAncestor(node, 'block-quote');
}
