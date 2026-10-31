import { viewModel } from '../view-model-node.js';
import type { ViewModelNode } from '../view-model-node.js';
import type {
  BlockParseState,
  ProjectedPendingState,
  ParagraphViewModelNode,
  SectionViewModelNode,
  ListItemViewModelNode,
} from './types.js';
import {
  pruneDetachedState,
  removeEmptyRootParagraph as ensurePlaceholderRemoved,
} from './cleanup.js';
import { syncQuoteStack, ensureListContainer, buildListPath } from './container-management.js';
import { appendInlineText, closeParagraph } from './handlers/paragraphs.js';
import { openCodeBlock, parseFenceStart } from './handlers/code-blocks.js';
import { closeList, parseInitialListItemContent, parseListItem } from './handlers/lists.js';
import { parseAtxHeading } from './handlers/sections.js';

export function projectPendingResolvedContent(
  state: BlockParseState,
  container: ViewModelNode,
  content: string,
  line: string,
): ProjectedPendingState | undefined {
  if (content.trim() === '') {
    return;
  }
  const quoteMatch = /^(>\s?)(.*)$/.exec(content);
  if (quoteMatch) {
    const quote = syncQuoteStack(state, container, 1);
    return projectPendingResolvedContent(state, quote, quoteMatch[2], line);
  }
  const atxHeading = parseAtxHeading(content);
  if (atxHeading) {
    projectPendingSectionText(state, container, atxHeading.level, atxHeading.content);
    return { kind: 'section', text: line };
  }

  const listItem = parseListItem(content);
  if (listItem) {
    projectPendingListItem(state, container, listItem.marker, listItem.checked, listItem.content);
    return { kind: 'list-item', text: content };
  }

  const fence = parseFenceStart(content);
  if (fence) {
    projectPendingCodeBlockOpen(state, container, fence.marker, fence.info);
    return { kind: 'code-block-open', text: content };
  }

  if (!canProjectPendingParagraph(content)) {
    return;
  }
  const paragraphContent = container.type === 'block-quote' ? content.trimStart() : content;
  return {
    kind: 'paragraph',
    text: appendPendingParagraphText(state, container, paragraphContent),
  };
}

export function discardProjectedPendingLine(
  state: BlockParseState,
  projected?: ProjectedPendingState,
) {
  if (!projected) return;
  switch (projected.kind) {
    case 'paragraph':
      discardProjectedParagraph(state, projected.text);
      return;
    case 'section':
      discardProjectedSection(state);
      return;
    case 'code-block':
      discardProjectedCodeBlock(state, projected.text);
      return;
    case 'code-block-open':
      discardProjectedCodeBlockOpen(state);
      return;
    case 'quote-open':
      discardProjectedQuoteOpen(state);
      return;
    case 'list-item':
      discardProjectedListItem(state);
      return;
  }
}

function discardProjectedParagraph(state: BlockParseState, text: string) {
  if (!state.currentParagraph) return;
  removeTrailingText(state.currentParagraph, text.length);
  if (state.currentParagraph.content === '') {
    state.currentParagraph[viewModel].remove();
    state.currentParagraph = undefined;
  }
  pruneDetachedState(state);
}

function discardProjectedSection(state: BlockParseState) {
  const section = state.sectionStack.at(-1);
  if (!section) return;
  if ((section.children?.length ?? 0) > 0) return;
  section[viewModel].remove();
  state.sectionStack.pop();
  pruneDetachedState(state);
}

function discardProjectedCodeBlock(state: BlockParseState, text: string) {
  const node = state.currentCodeBlock;
  if (!node) return;
  if (text.length) (node as { content: string }).content = node.content.slice(0, -text.length);
  node[viewModel].renderSignal.value++;
  pruneDetachedState(state);
}

function discardProjectedCodeBlockOpen(state: BlockParseState) {
  const node = state.currentCodeBlock;
  if (node?.content !== '') return;
  const parent = node[viewModel].parent;
  node[viewModel].remove();
  state.currentCodeBlock = undefined;
  state.currentCodeFence = undefined;
  state.currentCodeHasLines = undefined;
  pruneEmptyContainerChain(parent);
  pruneDetachedState(state);
}

function discardProjectedQuoteOpen(state: BlockParseState) {
  const quote = state.currentQuoteStack.at(-1);
  if (!quote || quote.children?.length) return;
  const parent = quote[viewModel].parent;
  if (!parent) {
    pruneDetachedState(state);
    return;
  }
  quote[viewModel].remove();
  pruneEmptyContainerChain(parent);
  pruneDetachedState(state);
}

function discardProjectedListItem(state: BlockParseState) {
  const item = state.currentListPath.at(-1);
  if (!item) return;
  const list = item[viewModel].parent;
  item[viewModel].remove();
  state.sourceMarkerWidths.delete(item);
  state.currentParagraph = undefined;
  state.currentListPath.pop();
  if (list?.type === 'list' && !list.children?.length) {
    const parent = list[viewModel].parent;
    list[viewModel].remove();
    pruneEmptyContainerChain(parent);
  }
  pruneDetachedState(state);
}

function appendPendingParagraphText(
  state: BlockParseState,
  container: ViewModelNode,
  line: string,
): string {
  ensurePlaceholderRemoved(state);
  let prefix = '';
  if (state.currentParagraph?.[viewModel].parent !== container) {
    const paragraph = state.tree.add({
      type: 'paragraph',
      content: '',
    });
    paragraph[viewModel].insertBefore(container);
    state.currentParagraph = paragraph;
    state.sawContent = true;
  } else if (state.currentParagraph.content !== '') {
    prefix = '\n';
  }
  const inserted = prefix + line;
  appendInlineText(state.currentParagraph!, inserted);
  return inserted;
}

function projectPendingSectionText(
  state: BlockParseState,
  container: ViewModelNode,
  level: number,
  content: string,
) {
  ensurePlaceholderRemoved(state);
  const section = state.tree.add({
    type: 'section',
    marker: '#'.repeat(level),
    content,
    children: [],
  }) as SectionViewModelNode;
  section[viewModel].insertBefore(container);
  state.sectionStack.push(section);
  state.sawContent = true;
}

function projectPendingListItem(
  state: BlockParseState,
  parent: ViewModelNode,
  marker: string,
  checked: boolean | undefined,
  content: string,
) {
  closeParagraph(state);
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

function projectPendingCodeBlockOpen(
  state: BlockParseState,
  parent: ViewModelNode,
  marker: string,
  info: string | null,
) {
  closeParagraph(state);
  closeList(state);
  openCodeBlock(state, parent, marker, info);
}

function removeTrailingText(node: ParagraphViewModelNode, count: number) {
  const startIndex = node.content.length - count;
  node[viewModel].edit(
    {
      startIndex,
      oldEndIndex: node.content.length,
      newEndIndex: startIndex,
      newText: '',
    },
    false,
  );
}

export function canProjectPendingParagraph(line: string): boolean {
  return !parseFenceStart(line);
}

function pruneEmptyContainerChain(node?: ViewModelNode) {
  while (
    node?.[viewModel].parent &&
    !node[viewModel].firstChild &&
    ['list-item', 'list', 'block-quote'].includes(node.type)
  ) {
    const parent = node[viewModel].parent;
    node[viewModel].remove();
    node = parent;
  }
}
