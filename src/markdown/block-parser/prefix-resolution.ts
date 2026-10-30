import type { ViewModelNode } from '../view-model-node.js';
import {
  type BlockParseState,
  type ListItemViewModelNode,
  type LinePrefixResult,
} from './types.js';
import {
  isInsideListPath,
  currentSectionContainer,
  listContinuationPrefix,
  activeQuoteChainForBase,
  getQuotedPrefixContainer,
  nextListPathItem,
  quoteContextForNode,
} from './utils.js';
import { resetQuoteStack, syncQuoteStack } from './container-management.js';

export function parseBlankLinePrefix(
  state: BlockParseState,
  line: string,
):
  | {
      quoteBase: ViewModelNode;
      quoteDepth: number;
      listDepth: number;
      continuedListIndent: boolean;
    }
  | undefined {
  let rest = line;
  let currentContainer: ViewModelNode = currentSectionContainer(state);
  let listDepth = 0;
  let quoteBase = currentContainer;
  let quoteDepth = 0;
  let matchedPrefix = false;
  let continuedListIndent = false;

  if (
    rest.startsWith(listContinuationPrefix(state.currentListPath.at(-1))) &&
    state.currentListPath.length &&
    isInsideListPath(currentContainer, state.currentListPath.at(-1))
  ) {
    rest = rest.slice(listContinuationPrefix(state.currentListPath.at(-1)).length);
    continuedListIndent = true;
    matchedPrefix = true;
  }

  while (true) {
    const quoteMatch = /^(>\s?)(.*)$/.exec(rest);
    if (quoteMatch) {
      matchedPrefix = true;
      if (quoteDepth === 0) {
        quoteBase = currentContainer;
      }
      quoteDepth++;
      rest = quoteMatch[2];
      currentContainer =
        getQuotedPrefixContainer(state, quoteBase ?? currentContainer, quoteDepth) ??
        currentContainer;
      continue;
    }

    const nextListItem = nextListPathItem(state.currentListPath, currentContainer, listDepth);
    if (nextListItem && rest.startsWith(listContinuationPrefix(nextListItem))) {
      matchedPrefix = true;
      rest = rest.slice(listContinuationPrefix(nextListItem).length);
      currentContainer = nextListItem;
      listDepth++;
      if (quoteDepth > 0 && rest.startsWith('>')) {
        quoteBase = currentContainer;
        quoteDepth = 0;
      }
      continue;
    }
    break;
  }

  if (matchedPrefix && /^\s*$/.test(rest)) {
    if (line.trimStart().startsWith('>')) {
      quoteDepth = Math.max(quoteDepth, 1);
    }
    return { quoteBase, quoteDepth, listDepth, continuedListIndent };
  }
  return;
}

export function parseLinePrefix(state: BlockParseState, line: string): LinePrefixResult {
  let rest = line;
  let currentContainer: ViewModelNode = currentSectionContainer(state);
  let listDepth = 0;
  let quoteBase: ViewModelNode | undefined;
  let quoteDepth = 0;
  const prefixes: ('list' | 'quote')[] = [];
  let continuedListIndent = false;

  if (
    rest.startsWith(listContinuationPrefix(state.currentListPath.at(-1))) &&
    state.currentListPath.length &&
    isInsideListPath(currentContainer, state.currentListPath.at(-1))
  ) {
    rest = rest.slice(listContinuationPrefix(state.currentListPath.at(-1)).length);
    continuedListIndent = true;
  }

  while (true) {
    const quoteMatch = /^(>\s?)(.*)$/.exec(rest);
    if (quoteMatch) {
      prefixes.push('quote');
      if (quoteDepth === 0) {
        quoteBase = currentContainer;
      }
      quoteDepth++;
      rest = quoteMatch[2];
      currentContainer =
        getQuotedPrefixContainer(state, quoteBase ?? currentContainer, quoteDepth) ??
        currentContainer;
      continue;
    }

    const nextListItem = nextListPathItem(state.currentListPath, currentContainer, listDepth);
    if (nextListItem && rest.startsWith(listContinuationPrefix(nextListItem))) {
      prefixes.push('list');
      rest = rest.slice(listContinuationPrefix(nextListItem).length);
      currentContainer = nextListItem;
      listDepth++;
      continue;
    }
    break;
  }
  return {
    content: rest,
    prefixes,
    listDepth,
    continuedListIndent,
  };
}

export function resolvePrefixContainers(
  state: BlockParseState,
  prefix: LinePrefixResult,
): ViewModelNode {
  let container = currentSectionContainer(state);
  let listDepth = 0;
  let quoteBase: ViewModelNode | undefined;
  let quoteDepth = 0;
  let sawQuote = false;

  for (const token of prefix.prefixes) {
    if (token === 'list') {
      const next = nextListPathItem(state.currentListPath, container, listDepth);
      if (next) {
        container = next;
        listDepth++;
      }
      quoteBase = undefined;
      quoteDepth = 0;
      continue;
    }

    sawQuote = true;
    if (quoteDepth === 0) {
      quoteBase = container;
    }
    quoteDepth++;
    const quoteRoot = quoteBase ?? container;
    const activeQuotes = activeQuoteChainForBase(state, quoteRoot);
    if (activeQuotes.length >= quoteDepth) {
      container = activeQuotes[quoteDepth - 1];
      continue;
    }
    container = syncQuoteStack(
      state,
      activeQuotes.at(-1) ?? quoteRoot,
      quoteDepth - activeQuotes.length,
    );
  }

  if (!sawQuote) {
    resetQuoteStack(state);
  }
  return container;
}

export function parseQuotedListContinuation(
  state: BlockParseState,
  line: string,
):
  | {
      container: ListItemViewModelNode;
      listPath: ListItemViewModelNode[];
      content: string;
      quoteBase: ViewModelNode;
      quoteDepth: number;
    }
  | undefined {
  const deepestContainer = state.currentListPath.at(-1);
  if (!deepestContainer) return;

  const quoteContext = quoteContextForNode(deepestContainer);
  if (!quoteContext || quoteContext.quoteDepth === 0) return;

  let rest = line;
  for (let depth = 0; depth < quoteContext.quoteDepth; depth++) {
    const quoteMatch = /^(>\s?)(.*)$/.exec(rest);
    if (!quoteMatch) {
      return;
    }
    rest = quoteMatch[2];
  }

  let currentContainer =
    getQuotedPrefixContainer(state, quoteContext.quoteBase, quoteContext.quoteDepth) ??
    quoteContext.quoteBase;
  let container: ListItemViewModelNode | undefined;
  const listPath: ListItemViewModelNode[] = [];

  while (true) {
    const nextListItem = nextListPathItem(state.currentListPath, currentContainer, listPath.length);
    if (!nextListItem || !rest.startsWith(listContinuationPrefix(nextListItem))) {
      break;
    }
    rest = rest.slice(listContinuationPrefix(nextListItem).length);
    currentContainer = nextListItem;
    container = nextListItem;
    listPath.push(nextListItem);
  }

  if (!container) {
    return;
  }

  const content = rest;
  if (content.trim() === '') {
    return;
  }
  if (content.startsWith('>')) {
    return;
  }
  if (state.currentCodeBlock && state.currentCodeFence && /^>\s?/.test(content)) {
    return;
  }
  if (/^>\s*$/.test(content)) {
    return;
  }

  return {
    container,
    listPath,
    content,
    quoteBase: quoteContext.quoteBase,
    quoteDepth: quoteContext.quoteDepth,
  };
}

export function shouldPreserveListPathOnQuotedBlankLine(
  state: BlockParseState,
  blankPrefix: {
    quoteBase: ViewModelNode;
    quoteDepth: number;
    listDepth: number;
    continuedListIndent: boolean;
  },
): boolean {
  if (
    blankPrefix.continuedListIndent ||
    blankPrefix.listDepth !== 0 ||
    blankPrefix.quoteDepth === 0
  ) {
    return false;
  }
  const lastItem = state.currentListPath.at(-1);
  if (!lastItem) return false;
  const quoteContext = quoteContextForNode(lastItem);
  return (
    quoteContext?.quoteBase === blankPrefix.quoteBase &&
    quoteContext?.quoteDepth === blankPrefix.quoteDepth
  );
}
