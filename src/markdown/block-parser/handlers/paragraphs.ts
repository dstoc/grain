import { viewModel } from '../../view-model-node.js';
import type { ViewModelNode } from '../../view-model-node.js';
import { type BlockParseState, type ParagraphViewModelNode } from '../types.js';
import { removeEmptyRootParagraph as ensurePlaceholderRemoved } from '../cleanup.js';

export function appendParagraphLine(
  state: BlockParseState,
  container: ViewModelNode,
  line: string,
) {
  ensurePlaceholderRemoved(state);
  if (state.currentParagraph?.[viewModel].parent === container) {
    appendInlineText(state.currentParagraph, `\n${line}`);
    return;
  }

  const paragraph = state.tree.add({
    type: 'paragraph',
    content: line,
  });
  paragraph[viewModel].insertBefore(container);
  state.currentParagraph = paragraph;
  state.sawContent = true;
}

export function appendInlineText(node: ParagraphViewModelNode, text: string) {
  const startIndex = node.content.length;
  node[viewModel].edit(
    {
      startIndex,
      oldEndIndex: startIndex,
      newEndIndex: startIndex + text.length,
      newText: text,
    },
    false,
  );
}

export function closeParagraph(state: BlockParseState) {
  state.currentParagraph = undefined;
}
