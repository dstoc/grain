import type { ConstructionNode } from '../../semantic/construction-tree.js';
import {
  type BlockParseState,
  type MappedText,
  type OutputPiece,
  type ConstructionParagraphNode,
} from '../types.js';
import { removeEmptyRootParagraph as ensurePlaceholderRemoved } from '../cleanup.js';
import { createSemanticNode, editSemanticText, placeSemanticNode } from '../utils.js';

export function appendParagraphLine(
  state: BlockParseState,
  container: ConstructionNode,
  line: string,
  mapped?: MappedText,
) {
  ensurePlaceholderRemoved(state);
  if (state.currentParagraph?.parent === container) {
    appendInlineText(state, state.currentParagraph, `\n${line}`);
    if (mapped) {
      const previous = state.inlinePieces.get(state.currentParagraph) ?? [];
      const pieces: OutputPiece[] = [
        ...previous,
        ...(state.sourceBreakBefore ? [state.sourceBreakBefore] : []),
        ...mapped.pieces,
      ];
      state.inlinePieces.set(state.currentParagraph, pieces);
    }
    return;
  }

  const paragraph = createSemanticNode(state, {
    type: 'paragraph',
    content: line,
  });
  placeSemanticNode(state, paragraph, container);
  state.currentParagraph = paragraph as ConstructionParagraphNode;
  if (mapped) state.inlinePieces.set(paragraph, mapped.pieces);
  state.sawContent = true;
}

export function appendInlineText(
  state: BlockParseState,
  node: ConstructionParagraphNode,
  text: string,
) {
  const startIndex = node.content.length;
  editSemanticText(state, node, startIndex, startIndex, text);
}

export function closeParagraph(state: BlockParseState) {
  state.currentParagraph = undefined;
}
