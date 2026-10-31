import { viewModel } from '../../view-model-node.js';
import type { ViewModelNode } from '../../view-model-node.js';
import {
  type BlockParseState,
  type ListItemViewModelNode,
  type SectionViewModelNode,
} from '../types.js';
import {
  ensureListContainer,
  buildListPath,
  syncQuoteStack,
  syncSectionStack,
} from '../container-management.js';
import { removeEmptyRootParagraph as ensurePlaceholderRemoved } from '../cleanup.js';
import { parseAtxHeading } from './sections.js';
import { parseFenceStart, openCodeBlock } from './code-blocks.js';
import { parseQuotePrefix } from '../prefix-resolution.js';

export function parseListItem(
  line: string,
): { marker: string; checked?: boolean; content: string } | undefined {
  const match = /^((?:[-+*]|\d+[.)]) )(\[(x| )\] )?(.*)$/.exec(line);
  if (!match) return;
  const checked = match[3] === 'x' ? true : match[2] ? false : undefined;
  return {
    marker: match[1],
    checked,
    content: match[4],
  };
}

export function appendListItem(
  state: BlockParseState,
  parent: ViewModelNode,
  marker: string,
  checked: boolean | undefined,
  content: string,
) {
  ensurePlaceholderRemoved(state);
  const list = ensureListContainer(state, parent);

  const item = state.tree.add({
    type: 'list-item',
    marker,
    checked,
    children: [],
  }) as ListItemViewModelNode;
  item[viewModel].insertBefore(list);
  state.sourceMarkerWidths.set(item, marker.length);
  state.currentListPath = buildListPath(state, parent, item);
  parseInitialListItemContent(state, item, content);
  state.sawContent = true;
}

export function parseInitialListItemContent(
  state: BlockParseState,
  item: ListItemViewModelNode,
  content: string,
) {
  parseInitialContainerContent(state, item, content);
}

export function parseInitialContainerContent(
  state: BlockParseState,
  parent: ViewModelNode,
  content: string,
) {
  if (content.trim() === '<!-- -->') {
    const paragraph = state.tree.add({
      type: 'paragraph',
      content: '',
    });
    paragraph[viewModel].insertBefore(parent);
    state.currentParagraph = paragraph;
    return;
  }

  if (content === '') {
    const paragraph = state.tree.add({
      type: 'paragraph',
      content: '',
    });
    paragraph[viewModel].insertBefore(parent);
    state.currentParagraph = paragraph;
    return;
  }

  const atxHeading = parseAtxHeading(content);
  if (atxHeading) {
    const section = state.tree.add({
      type: 'section',
      marker: '#'.repeat(atxHeading.level),
      content: atxHeading.content,
      children: [],
    }) as SectionViewModelNode;
    section[viewModel].insertBefore(parent);
    syncSectionStack(state, parent);
    state.sectionStack.push(section);
    state.currentParagraph = undefined;
    return;
  }

  const quoteContent = parseQuotePrefix(content);
  if (quoteContent !== undefined) {
    const quote = syncQuoteStack(state, parent, 1);
    parseInitialContainerContent(state, quote, quoteContent);
    return;
  }

  const nestedListItem = parseListItem(content);
  if (nestedListItem) {
    appendListItem(
      state,
      parent,
      nestedListItem.marker,
      nestedListItem.checked,
      nestedListItem.content,
    );
    return;
  }

  const fence = parseFenceStart(content);
  if (fence) {
    openCodeBlock(state, parent, fence.marker, fence.info);
    state.currentParagraph = undefined;
    return;
  }

  const paragraph = state.tree.add({
    type: 'paragraph',
    content,
  });
  paragraph[viewModel].insertBefore(parent);
  state.currentParagraph = paragraph;
}

export function closeList(state: BlockParseState) {
  if (state.currentParagraph?.[viewModel].parent?.type === 'list-item') {
    state.currentParagraph = undefined;
  }
  state.currentList = undefined;
}
