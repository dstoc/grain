import { viewModel } from '../../view-model-node.js';
import type { ViewModelNode } from '../../view-model-node.js';
import { type BlockParseState } from '../types.js';
import { listContinuationPrefix } from '../utils.js';
import { removeEmptyRootParagraph as ensurePlaceholderRemoved } from '../cleanup.js';

export function parseFenceStart(
  line: string,
): { marker: string; info: string | null } | undefined {
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
  const node = state.tree.add({
    type: 'code-block',
    info,
    content: '',
  });
  node[viewModel].insertBefore(parent);
  state.currentCodeBlock = node;
  state.currentCodeFence = marker;
  state.sawContent = true;
}

export function appendCodeBlockLine(
  state: BlockParseState,
  line: string,
): string {
  const node = state.currentCodeBlock;
  if (!node) return '';
  const inserted = node.content === '' ? line : `\n${line}`;
  const newContent = `${node.content}${inserted}`;
  (node as { content: string }).content = newContent;
  node[viewModel].renderSignal.value++;
  return inserted;
}

export function stripActiveCodeBlockContinuation(
  state: BlockParseState,
  line: string,
): string {
  const parent = state.currentCodeBlock?.[viewModel].parent;
  const currentListItem = state.currentListPath.at(-1);
  if (
    parent?.type === 'list-item' &&
    currentListItem === parent &&
    line.startsWith(listContinuationPrefix(currentListItem))
  ) {
    return line.slice(listContinuationPrefix(currentListItem).length);
  }
  return line;
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
}
