import { viewModel } from '../view-model-node.js';
import type { ViewModelNode } from '../view-model-node.js';
import type {
  BlockParseState,
  MappedText,
  ProjectedPendingState,
  LinePrefixResult,
} from './types.js';
import {
  parseQuotedListContinuation,
  parseBlankLinePrefix,
  shouldPreserveListPathOnQuotedBlankLine,
  parseLinePrefix,
  parseQuotePrefixMatch,
  resolvePrefixContainers,
} from './prefix-resolution.js';
import { syncQuoteStack } from './container-management.js';
import { closeParagraph, appendParagraphLine } from './handlers/paragraphs.js';
import { isBlankLine, currentSectionContainer } from './utils.js';
import { exitDetachedContainerContexts } from './cleanup.js';
import {
  isClosingFence,
  appendCodeBlockLine,
  stripActiveCodeBlockContinuation,
  closeCodeBlock,
  parseFenceStart,
  openCodeBlock,
} from './handlers/code-blocks.js';
import { projectPendingQuoteOpen, closeQuote } from './handlers/quotes.js';
import { projectPendingResolvedContent } from './projected-state.js';
import { tryPromoteSetextHeading, parseAtxHeading, openSection } from './handlers/sections.js';
import { parseListItem, appendListItem, closeList } from './handlers/lists.js';
import { sliceMappedText } from './source-text.js';

export function parseLine(state: BlockParseState, line: string, mapped?: MappedText) {
  if (state.currentCodeBlock && state.currentCodeFence) {
    const stripped = stripActiveCodeBlockContinuation(state, line);
    if (isClosingFence(stripped.content, state.currentCodeFence)) {
      closeCodeBlock(state);
    } else {
      appendCodeBlockLine(
        state,
        stripped.content,
        true,
        mapped ? sliceMappedText(mapped, stripped.contentFrom, mapped.text.length) : undefined,
      );
    }
    return;
  }

  if (shouldRestartQuotedListBranch(state, line)) {
    closeParagraph(state);
    closeQuote(state);
  }
  const quotedListContinuation = parseQuotedListContinuation(state, line);
  if (quotedListContinuation) {
    syncQuoteStack(state, quotedListContinuation.quoteBase, quotedListContinuation.quoteDepth);
    state.currentListPath = quotedListContinuation.listPath;
    const parentBlock = state.currentListPath.at(-1)?.[viewModel].parent;
    state.currentList = parentBlock?.type === 'list' ? parentBlock : undefined;
    if (quotedListContinuation.content === '') {
      closeParagraph(state);
      return;
    }
    parseResolvedContainerContent(
      state,
      quotedListContinuation.container,
      quotedListContinuation.content,
      mapped
        ? sliceMappedText(mapped, quotedListContinuation.contentFrom, mapped.text.length)
        : undefined,
    );
    return;
  }

  const blankPrefix = parseBlankLinePrefix(state, line);
  if (blankPrefix) {
    closeParagraph(state);
    state.currentList = undefined;
    if (blankPrefix.continuedListIndent) {
      state.currentListPath = [...state.currentListPath];
    } else if (shouldPreserveListPathOnQuotedBlankLine(state, blankPrefix)) {
      state.currentListPath = [...state.currentListPath];
    } else {
      state.currentListPath = state.currentListPath.slice(0, blankPrefix.listDepth);
    }
    if (blankPrefix.quoteDepth > 0) {
      syncQuoteStack(state, blankPrefix.quoteBase, blankPrefix.quoteDepth);
    }
    return;
  }

  if (isBlankLine(line)) {
    closeLeafBlocks(state);
    return;
  }

  if (line.startsWith('>')) {
    expandCurrentListPathFromTree(state);
  }
  const prefix = parseLinePrefix(state, line);
  if (!(state.currentCodeBlock && state.currentCodeFence)) {
    if (prefix.prefixes.length === 0 && prefix.listDepth === 0 && !prefix.continuedListIndent) {
      exitDetachedContainerContexts(state);
    }
    if (prefix.continuedListIndent) {
      state.currentListPath = [...state.currentListPath];
    } else {
      state.currentListPath = state.currentListPath.slice(0, prefix.listDepth);
    }
  }
  const container = resolvePrefixContainers(state, prefix);
  parseResolvedContainerContent(
    state,
    container,
    prefix.content,
    mapped ? sliceMappedText(mapped, prefix.contentFrom, mapped.text.length) : undefined,
  );
}

export function projectPendingLine(
  state: BlockParseState,
  line: string,
): ProjectedPendingState | undefined {
  if (!line) {
    return;
  }

  if (state.currentCodeBlock && state.currentCodeFence) {
    const stripped = stripActiveCodeBlockContinuation(state, line);
    if (isClosingFence(stripped.content, state.currentCodeFence)) {
      return;
    }
    return {
      kind: 'code-block',
      text: appendCodeBlockLine(state, stripped.content, false),
    };
  }

  if (shouldRestartQuotedListBranch(state, line)) {
    closeParagraph(state);
    closeQuote(state);
  }

  const quotedListContinuation = parseQuotedListContinuation(state, line);
  if (quotedListContinuation) {
    syncQuoteStack(state, quotedListContinuation.quoteBase, quotedListContinuation.quoteDepth);
    state.currentListPath = quotedListContinuation.listPath;
    const parentBlock = state.currentListPath.at(-1)?.[viewModel].parent;
    state.currentList = parentBlock?.type === 'list' ? parentBlock : undefined;
    return projectPendingResolvedContent(
      state,
      quotedListContinuation.container,
      quotedListContinuation.content,
      line,
    );
  }

  const prefix = parseLinePrefix(state, line);
  if (shouldWaitForPendingPrefixResolution(state, line, prefix)) {
    return;
  }
  if (/^>\s*$/.test(line)) {
    if (state.currentQuoteStack.length > 1 || state.currentListPath.length) {
      return;
    }
    projectPendingQuoteOpen(state, currentSectionContainer(state));
    return { kind: 'quote-open', text: line };
  }
  if (prefix.content.trim() === '') {
    return;
  }
  if (prefix.prefixes.length === 0 && prefix.listDepth === 0 && !prefix.continuedListIndent) {
    exitDetachedContainerContexts(state);
  }
  if (prefix.continuedListIndent) {
    state.currentListPath = [...state.currentListPath];
  }
  const container = resolvePrefixContainers(state, prefix);
  return projectPendingResolvedContent(state, container, prefix.content, line);
}

function shouldWaitForPendingPrefixResolution(
  state: BlockParseState,
  line: string,
  prefix: LinePrefixResult,
): boolean {
  if (prefix.continuedListIndent) {
    return false;
  }
  if (parseListItem(prefix.content)) {
    return false;
  }
  if (parseFenceStart(prefix.content)) {
    return false;
  }
  if (prefix.prefixes.at(-1) === 'quote' && prefix.content === '') {
    return false;
  }
  if (/^(?:[-+*]|\d+[.)]?|#+)$/.test(prefix.content.trim())) {
    return true;
  }
  if (line.startsWith(' ') && prefix.content === '') {
    return true;
  }
  if (!state.currentListPath.length) return false;
  if (!line.startsWith(' ')) return false;
  return prefix.prefixes.length === 0;
}

function expandCurrentListPathFromTree(state: BlockParseState) {
  while (true) {
    const current = state.currentListPath.at(-1);
    if (!current) return;
    const nestedList = [...(current.children ?? [])]
      .reverse()
      .find((child) => child.type === 'list');
    if (!nestedList?.children?.length) return;
    const nestedItem = nestedList.children.at(-1) as ViewModelNode | undefined;
    if (nestedItem?.type !== 'list-item') return;
    if (state.currentListPath.includes(nestedItem)) return;
    state.currentListPath = [...state.currentListPath, nestedItem];
    const parentBlock = nestedItem[viewModel].parent;
    state.currentList = parentBlock?.type === 'list' ? parentBlock : state.currentList;
  }
}

function shouldRestartQuotedListBranch(state: BlockParseState, line: string): boolean {
  return (
    line.trimStart().startsWith('>') &&
    state.currentParagraph?.[viewModel].parent?.type === 'block-quote' &&
    state.currentListPath.length > 0 &&
    state.currentQuoteStack.length > 0
  );
}

function parseResolvedContainerContent(
  state: BlockParseState,
  container: ViewModelNode,
  content: string,
  mapped?: MappedText,
) {
  if (content.trim() === '<!-- -->') {
    closeLeafBlocks(state);
    appendParagraphLine(
      state,
      container,
      '',
      mapped ? sliceMappedText(mapped, mapped.text.length, mapped.text.length) : undefined,
    );
    if (container === state.root) state.hasExplicitRootParagraph = true;
    return;
  }

  if (state.currentCodeBlock && state.currentCodeFence) {
    const stripped = stripActiveCodeBlockContinuation(state, content);
    if (isClosingFence(stripped.content, state.currentCodeFence)) {
      closeCodeBlock(state);
    } else {
      appendCodeBlockLine(
        state,
        stripped.content,
        true,
        mapped ? sliceMappedText(mapped, stripped.contentFrom, mapped.text.length) : undefined,
      );
    }
    return;
  }

  if (tryPromoteSetextHeading(state, content, container)) {
    return;
  }

  const atxHeading = parseAtxHeading(content);
  if (atxHeading) {
    closeLeafBlocks(state);
    openSection(
      state,
      atxHeading.level,
      atxHeading.content,
      mapped ? sliceMappedText(mapped, atxHeading.contentFrom, mapped.text.length) : undefined,
    );
    return;
  }

  const quotePrefix = parseQuotePrefixMatch(content);
  if (quotePrefix !== undefined) {
    closeParagraph(state);
    const quote = syncQuoteStack(state, container, 1);
    parseResolvedContainerContent(
      state,
      quote,
      quotePrefix.content,
      mapped ? sliceMappedText(mapped, quotePrefix.contentFrom, mapped.text.length) : undefined,
    );
    return;
  }

  const listItem = parseListItem(content);
  if (listItem) {
    closeParagraph(state);
    appendListItem(
      state,
      container,
      listItem.marker,
      listItem.checked,
      listItem.content,
      mapped ? sliceMappedText(mapped, listItem.contentFrom, mapped.text.length) : undefined,
    );
    return;
  }

  const fence = parseFenceStart(content);
  if (fence) {
    closeParagraph(state);
    closeList(state);
    openCodeBlock(state, container, fence.marker, fence.info);
    return;
  }

  if (canContinueListParagraph(state, container, content)) {
    appendParagraphLine(state, container, content, mapped);
    return;
  }
  closeList(state);
  appendParagraphLine(state, container, content, mapped);
}

function canContinueListParagraph(
  state: BlockParseState,
  container: ViewModelNode,
  line: string,
): boolean {
  if (!state.currentListPath.length) return false;
  if (line.trim() === '') return false;
  if (parseListItem(line)) return false;
  if (parseFenceStart(line)) return false;
  return container.type === 'list-item';
}

export function closeLeafBlocks(state: BlockParseState) {
  closeParagraph(state);
  closeList(state);
  closeQuote(state);
  closeCodeBlock(state);
}
