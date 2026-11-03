import type { ConstructionNode } from '../../semantic/construction-tree.js';
import {
  type BlockParseState,
  type MappedText,
  type ConstructionListItemNode,
  type ConstructionParagraphNode,
  type ConstructionSectionNode,
} from '../types.js';
import {
  ensureListContainer,
  buildListPath,
  syncQuoteStack,
  syncSectionStack,
} from '../container-management.js';
import { removeEmptyRootParagraph as ensurePlaceholderRemoved } from '../cleanup.js';
import { createSemanticNode, placeSemanticNode } from '../utils.js';
import { parseAtxHeading } from './sections.js';
import { parseFenceStart, openCodeBlock } from './code-blocks.js';
import { parseQuotePrefixMatch } from '../prefix-resolution.js';
import { sliceMappedText } from '../source-text.js';

export function parseListItem(
  line: string,
): { marker: string; checked?: boolean; content: string; contentFrom: number } | undefined {
  const match = /^((?:[-+*]|\d+[.)]) )(\[(x| )\] )?(.*)$/.exec(line);
  if (!match) return;
  const checked = match[3] === 'x' ? true : match[2] ? false : undefined;
  return {
    marker: match[1],
    checked,
    content: match[4],
    contentFrom: match[1].length + (match[2]?.length ?? 0),
  };
}

export function appendListItem(
  state: BlockParseState,
  parent: ConstructionNode,
  marker: string,
  checked: boolean | undefined,
  content: string,
  mapped?: MappedText,
) {
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
  parseInitialListItemContent(state, item, content, mapped);
  state.sawContent = true;
}

export function parseInitialListItemContent(
  state: BlockParseState,
  item: ConstructionListItemNode,
  content: string,
  mapped?: MappedText,
) {
  parseInitialContainerContent(state, item, content, mapped);
}

export function parseInitialContainerContent(
  state: BlockParseState,
  parent: ConstructionNode,
  content: string,
  mapped?: MappedText,
) {
  if (content.trim() === '<!-- -->') {
    const paragraph = createSemanticNode(state, {
      type: 'paragraph',
      content: '',
    }) as ConstructionParagraphNode;
    placeSemanticNode(state, paragraph, parent);
    state.currentParagraph = paragraph;
    if (mapped) state.inlinePieces.set(paragraph, []);
    return;
  }

  if (content === '') {
    const paragraph = createSemanticNode(state, {
      type: 'paragraph',
      content: '',
    }) as ConstructionParagraphNode;
    placeSemanticNode(state, paragraph, parent);
    state.currentParagraph = paragraph;
    if (mapped) state.inlinePieces.set(paragraph, []);
    return;
  }

  const atxHeading = parseAtxHeading(content);
  if (atxHeading) {
    const section = createSemanticNode(state, {
      type: 'section',
      marker: '#'.repeat(atxHeading.level),
      content: atxHeading.content,
    }) as ConstructionSectionNode;
    placeSemanticNode(state, section, parent);
    if (mapped) {
      state.inlinePieces.set(
        section,
        sliceMappedText(mapped, atxHeading.contentFrom, mapped.text.length).pieces,
      );
    }
    syncSectionStack(state, parent);
    state.sectionStack.push(section);
    state.currentParagraph = undefined;
    return;
  }

  const quotePrefix = parseQuotePrefixMatch(content);
  if (quotePrefix !== undefined) {
    const quote = syncQuoteStack(state, parent, 1);
    parseInitialContainerContent(
      state,
      quote,
      quotePrefix.content,
      mapped ? sliceMappedText(mapped, quotePrefix.contentFrom, mapped.text.length) : undefined,
    );
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
      mapped ? sliceMappedText(mapped, nestedListItem.contentFrom, mapped.text.length) : undefined,
    );
    return;
  }

  const fence = parseFenceStart(content);
  if (fence) {
    openCodeBlock(state, parent, fence.marker, fence.info);
    state.currentParagraph = undefined;
    return;
  }

  const paragraph = createSemanticNode(state, {
    type: 'paragraph',
    content,
  }) as ConstructionParagraphNode;
  placeSemanticNode(state, paragraph, parent);
  state.currentParagraph = paragraph;
  if (mapped) state.inlinePieces.set(paragraph, mapped.pieces);
}

export function closeList(state: BlockParseState) {
  if (state.currentParagraph?.parent?.type === 'list-item') {
    state.currentParagraph = undefined;
  }
  state.currentList = undefined;
}
