import type { ConstructionNode } from '../../semantic/construction-tree.js';
import { type BlockParseState } from '../types.js';
import { hasContainerAncestor } from '../utils.js';
import { syncQuoteStack, resetQuoteStack } from '../container-management.js';

export function projectPendingQuoteOpen(state: BlockParseState, parent: ConstructionNode) {
  syncQuoteStack(state, parent, 1);
}

export function closeQuote(state: BlockParseState) {
  if (state.currentParagraph && isInsideBlockQuote(state.currentParagraph)) {
    state.currentParagraph = undefined;
  }
  resetQuoteStack(state);
}

function isInsideBlockQuote(node: ConstructionNode): boolean {
  return hasContainerAncestor(node, 'block-quote');
}
