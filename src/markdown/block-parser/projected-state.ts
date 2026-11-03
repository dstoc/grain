import type { ConstructionNode } from '../semantic/construction-tree.js';
import type {
  BlockParseState,
  ProjectedPendingState,
  ConstructionParagraphNode,
  ConstructionSectionNode,
  ConstructionListItemNode,
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
import {
  createSemanticNode,
  detachSemanticNodeIfAttached,
  editSemanticText,
  placeSemanticNode,
} from './utils.js';

export function projectPendingResolvedContent(
  state: BlockParseState,
  container: ConstructionNode,
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
  removeTrailingText(state, state.currentParagraph, text.length);
  if (state.currentParagraph.content === '') {
    detachSemanticNodeIfAttached(state, state.currentParagraph);
    state.currentParagraph = undefined;
  }
  pruneDetachedState(state);
}

function discardProjectedSection(state: BlockParseState) {
  const section = state.sectionStack.at(-1);
  if (!section) return;
  if ((section.children?.length ?? 0) > 0) return;
  detachSemanticNodeIfAttached(state, section);
  state.sectionStack.pop();
  pruneDetachedState(state);
}

function discardProjectedCodeBlock(state: BlockParseState, text: string) {
  const node = state.currentCodeBlock;
  if (!node) return;
  if (text.length) {
    const startIndex = node.content.length - text.length;
    editSemanticText(state, node, startIndex, node.content.length, '');
  }
  pruneDetachedState(state);
}

function discardProjectedCodeBlockOpen(state: BlockParseState) {
  const node = state.currentCodeBlock;
  if (node?.content !== '') return;
  const parent = node.parent;
  detachSemanticNodeIfAttached(state, node);
  state.currentCodeBlock = undefined;
  state.currentCodeFence = undefined;
  state.currentCodeHasLines = undefined;
  pruneEmptyContainerChain(state, parent);
  pruneDetachedState(state);
}

function discardProjectedQuoteOpen(state: BlockParseState) {
  const quote = state.currentQuoteStack.at(-1);
  if (!quote || quote.children?.length) return;
  const parent = quote.parent;
  if (!parent) {
    pruneDetachedState(state);
    return;
  }
  detachSemanticNodeIfAttached(state, quote);
  pruneEmptyContainerChain(state, parent);
  pruneDetachedState(state);
}

function discardProjectedListItem(state: BlockParseState) {
  const item = state.currentListPath.at(-1);
  if (!item) return;
  const list = item.parent;
  detachSemanticNodeIfAttached(state, item);
  state.sourceMarkerWidths.delete(item);
  state.currentParagraph = undefined;
  state.currentListPath.pop();
  if (list?.type === 'list' && !list.children?.length) {
    const parent = list.parent;
    detachSemanticNodeIfAttached(state, list);
    pruneEmptyContainerChain(state, parent);
  }
  pruneDetachedState(state);
}

function appendPendingParagraphText(
  state: BlockParseState,
  container: ConstructionNode,
  line: string,
): string {
  ensurePlaceholderRemoved(state);
  let prefix = '';
  if (state.currentParagraph?.parent !== container) {
    const paragraph = createSemanticNode(state, {
      type: 'paragraph',
      content: '',
    });
    placeSemanticNode(state, paragraph, container);
    state.currentParagraph = paragraph as ConstructionParagraphNode;
    state.sawContent = true;
  } else if (state.currentParagraph.content !== '') {
    prefix = '\n';
  }
  const inserted = prefix + line;
  appendInlineText(state, state.currentParagraph!, inserted);
  return inserted;
}

function projectPendingSectionText(
  state: BlockParseState,
  container: ConstructionNode,
  level: number,
  content: string,
) {
  ensurePlaceholderRemoved(state);
  const section = createSemanticNode(state, {
    type: 'section',
    marker: '#'.repeat(level),
    content,
  }) as ConstructionSectionNode;
  placeSemanticNode(state, section, container);
  state.sectionStack.push(section);
  state.sawContent = true;
}

function projectPendingListItem(
  state: BlockParseState,
  parent: ConstructionNode,
  marker: string,
  checked: boolean | undefined,
  content: string,
) {
  closeParagraph(state);
  ensurePlaceholderRemoved(state);
  const list = ensureListContainer(state, parent);
  const item = createSemanticNode(state, {
    type: 'list-item',
    marker,
    checked,
  }) as ConstructionListItemNode;
  placeSemanticNode(state, item, list);
  state.sourceMarkerWidths.set(item, marker.length);
  state.currentListPath = buildListPath(state, parent, item);
  parseInitialListItemContent(state, item, content);
  state.sawContent = true;
}

function projectPendingCodeBlockOpen(
  state: BlockParseState,
  parent: ConstructionNode,
  marker: string,
  info: string | null,
) {
  closeParagraph(state);
  closeList(state);
  openCodeBlock(state, parent, marker, info);
}

function removeTrailingText(
  state: BlockParseState,
  node: ConstructionParagraphNode,
  count: number,
) {
  const startIndex = node.content.length - count;
  editSemanticText(state, node, startIndex, node.content.length, '');
}

export function canProjectPendingParagraph(line: string): boolean {
  return !parseFenceStart(line);
}

function pruneEmptyContainerChain(state: BlockParseState, node?: ConstructionNode) {
  while (
    node?.parent &&
    !node.children[0] &&
    ['list-item', 'list', 'block-quote'].includes(node.type)
  ) {
    const parent = node.parent;
    detachSemanticNodeIfAttached(state, node);
    node = parent;
  }
}
