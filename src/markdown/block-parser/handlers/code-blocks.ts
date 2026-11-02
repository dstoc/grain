import { viewModel } from '../../view-model-node.js';
import type { ViewModelNode } from '../../view-model-node.js';
import {
  type BlockParseState,
  type CodeBlockViewModelNode,
  type MappedText,
  type OutputPiece,
} from '../types.js';
import {
  createSemanticNode,
  editSemanticText,
  listContinuationPrefix,
  placeSemanticNode,
} from '../utils.js';
import { removeEmptyRootParagraph as ensurePlaceholderRemoved } from '../cleanup.js';

export function parseFenceStart(line: string): { marker: string; info: string | null } | undefined {
  const match = /^(```+)(.*)$/.exec(line);
  if (!match) return;
  const info = match[2].trim();
  return {
    marker: match[1],
    info: info === '' ? null : info,
  };
}

export function openCodeBlock(
  state: BlockParseState,
  parent: ViewModelNode,
  marker: string,
  info: string | null,
) {
  ensurePlaceholderRemoved(state);
  const node = createSemanticNode(state, {
    type: 'code-block',
    info,
    content: '',
  }) as CodeBlockViewModelNode;
  placeSemanticNode(state, node, parent);
  if (state.sourceTracking) state.inlinePieces.set(node, []);
  state.currentCodeBlock = node;
  state.currentCodeFence = marker;
  state.currentCodeHasLines = false;
  state.sawContent = true;
}

export function appendCodeBlockLine(
  state: BlockParseState,
  line: string,
  settled = true,
  mapped?: MappedText,
): string {
  const node = state.currentCodeBlock;
  if (!node) return '';
  const hadLines = Boolean(state.currentCodeHasLines);
  const inserted = hadLines ? `\n${line}` : line;
  if (settled) state.currentCodeHasLines = true;
  const startIndex = node.content.length;
  editSemanticText(state, node, startIndex, startIndex, inserted);
  if (settled && mapped) {
    const previous: readonly OutputPiece[] = state.inlinePieces.get(node) ?? [];
    state.inlinePieces.set(node, [
      ...previous,
      ...(hadLines && state.sourceBreakBefore ? [state.sourceBreakBefore] : []),
      ...mapped.pieces,
    ]);
  }
  return inserted;
}

export function stripActiveCodeBlockContinuation(
  state: BlockParseState,
  line: string,
): { readonly content: string; readonly contentFrom: number } {
  const originalLength = line.length;
  const ancestors: ViewModelNode[] = [];
  let parent = state.currentCodeBlock?.[viewModel].parent;
  while (parent) {
    if (parent.type === 'list-item' || parent.type === 'block-quote') ancestors.unshift(parent);
    parent = parent[viewModel].parent;
  }
  for (const ancestor of ancestors) {
    if (ancestor.type === 'block-quote') {
      const match = /^>\s?/.exec(line);
      if (!match) break;
      line = line.slice(match[0].length);
    } else if (ancestor.type === 'list-item') {
      const prefix = listContinuationPrefix(state, ancestor);
      if (!line.startsWith(prefix)) break;
      line = line.slice(prefix.length);
    }
  }
  return { content: line, contentFrom: originalLength - line.length };
}

export function isClosingFence(line: string, marker: string): boolean {
  return new RegExp(`^\\s{0,3}${escapeRegExp(marker)}\\s*$`).test(line);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function closeCodeBlock(state: BlockParseState) {
  state.currentCodeBlock = undefined;
  state.currentCodeFence = undefined;
  state.currentCodeHasLines = undefined;
}
