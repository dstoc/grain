import type {
  BlockQuoteNode,
  CodeBlockNode,
  DocumentNode,
  ListItemNode,
  MarkdownNode,
  ParagraphNode,
  SectionNode,
} from './node.js';
import {type ParserEdit, type ParserTree, createSyntaxNode, createTree} from './parser-tree.js';
import {MarkdownTree} from './view-model.js';
import {viewModel} from './view-model-node.js';
import type {ViewModelNode} from './view-model-node.js';

type ParagraphViewModelNode = ParagraphNode & ViewModelNode;
type SectionViewModelNode = SectionNode & ViewModelNode;
type ListViewModelNode = Extract<MarkdownNode, {type: 'list'}> & ViewModelNode;
type ListItemViewModelNode = ListItemNode & ViewModelNode;
type BlockQuoteViewModelNode = BlockQuoteNode & ViewModelNode;
type CodeBlockViewModelNode = CodeBlockNode & ViewModelNode;

interface BlockParseState {
  tree: MarkdownTree;
  root: DocumentNode & ViewModelNode;
  sawContent: boolean;
  currentParagraph?: ParagraphViewModelNode;
  currentList?: ListViewModelNode;
  currentListPath: ListItemViewModelNode[];
  currentQuoteBase?: ViewModelNode;
  currentQuoteStack: BlockQuoteViewModelNode[];
  currentCodeBlock?: CodeBlockViewModelNode;
  currentCodeFence?: string;
  sectionStack: SectionViewModelNode[];
}

interface LinePrefixResult {
  content: string;
  prefixes: Array<'list' | 'quote'>;
  listDepth: number;
  continuedListIndent: boolean;
}

type ProjectedPendingKind =
  | 'paragraph'
  | 'section'
  | 'code-block'
  | 'code-block-open'
  | 'quote-open'
  | 'list-item';

interface ProjectedPendingState {
  kind: ProjectedPendingKind;
  text: string;
}

export interface BlockParser {
  push(text: string): MarkdownTree;
  finish(): MarkdownTree;
  getTree(): MarkdownTree;
  getPendingText(): string;
  snapshot(): BlockParserSnapshot;
}

export type Tree = ParserTree;

export interface BlockParserSnapshot {
  root: DocumentNode;
  pendingText: string;
  projectedPending?: ProjectedPendingState;
  sawContent: boolean;
  finished: boolean;
  currentParagraphPath?: number[];
  currentListPath: number[][];
  currentQuoteBasePath?: number[];
  currentQuoteStackPaths: number[][];
  currentCodeBlockPath?: number[];
  currentCodeFence?: string;
  sectionStackPaths: number[][];
}

export function createBlockParser(
  snapshot?: BlockParserSnapshot,
): BlockParser {
  const tree = new MarkdownTree(
    snapshot?.root ?? {
      type: 'document',
      children: [{type: 'paragraph', content: ''}],
    },
  );
  const state = snapshot
    ? restoreState(tree, snapshot)
    : createInitialState(tree);

  let pendingText = snapshot?.pendingText ?? '';
  let finished = snapshot?.finished ?? false;
  let projectedPending = snapshot?.projectedPending;

  return {
    push(text: string) {
      if (finished) {
        throw new Error('cannot push after finish');
      }
      if (!text) {
        return tree;
      }

      pendingText += text;
      tree.edit(() => {
        discardProjectedPendingLine(state, projectedPending);
        projectedPending = undefined;

        const lines = pendingText.split('\n');
        pendingText = lines.pop() ?? '';
        for (const line of lines) {
          parseLine(state, line);
        }

        projectedPending = projectPendingLine(state, pendingText);
        cleanupInactiveEmptyBlocks(state);
        return {};
      }, false, {preserveEmptyBlocks: true});
      return tree;
    },
    finish() {
      if (finished) {
        return tree;
      }
      tree.edit(() => {
        discardProjectedPendingLine(state, projectedPending);
        projectedPending = undefined;
        if (pendingText !== '') {
          parseLine(state, pendingText);
          pendingText = '';
        }
        closeLeafBlocks(state);
        removeEmptyRootParagraph(state);
        return {};
      }, false, {force: true});
      finished = true;
      return tree;
    },
    getTree() {
      return tree;
    },
    getPendingText() {
      return pendingText;
    },
    snapshot() {
      return {
        root: tree.serialize() as DocumentNode,
        pendingText,
        projectedPending,
        sawContent: state.sawContent,
        finished,
        currentParagraphPath: pathForNode(state.root, state.currentParagraph),
        currentListPath: state.currentListPath
          .map((node) => pathForNode(state.root, node))
          .filter(isDefined),
        currentQuoteBasePath: pathForNode(state.root, state.currentQuoteBase),
        currentQuoteStackPaths: state.currentQuoteStack
          .map((node) => pathForNode(state.root, node))
          .filter(isDefined),
        currentCodeBlockPath: pathForNode(state.root, state.currentCodeBlock),
        currentCodeFence: state.currentCodeFence,
        sectionStackPaths: state.sectionStack
          .map((node) => pathForNode(state.root, node))
          .filter(isDefined),
      };
    },
  };
}

export function parseBlocks(
  markdown: string,
  tree?: ParserTree,
  _edit?: ParserEdit,
  keepTree = false,
) {
  tree?.delete();
  const parser = createBlockParser();
  parser.push(markdown);
  const blockTree = parser.finish();
  const node = blockTree.serialize() as DocumentNode;
  const rootTree = createTree(createSyntaxNode('document', markdown));
  return {node, tree: keepTree ? rootTree : (rootTree.delete(), undefined)};
}

export function parseMarkdownTree(markdown: string): MarkdownTree {
  const parser = createBlockParser();
  parser.push(markdown);
  return parser.finish();
}

function createInitialState(tree: MarkdownTree): BlockParseState {
  return {
    tree,
    root: tree.root,
    sawContent: false,
    currentListPath: [],
    currentQuoteStack: [],
    sectionStack: [],
  };
}

function restoreState(
  tree: MarkdownTree,
  snapshot: BlockParserSnapshot,
): BlockParseState {
  const state = createInitialState(tree);
  state.sawContent = snapshot.sawContent;
  state.currentParagraph = nodeAtPath(
    state.root,
    snapshot.currentParagraphPath,
  ) as ParagraphViewModelNode | undefined;
  state.currentListPath = snapshot.currentListPath
    .map((path) => nodeAtPath(state.root, path) as ListItemViewModelNode | undefined)
    .filter(isDefined);
  state.currentQuoteBase = nodeAtPath(state.root, snapshot.currentQuoteBasePath);
  state.currentQuoteStack = snapshot.currentQuoteStackPaths
    .map((path) => nodeAtPath(state.root, path) as BlockQuoteViewModelNode | undefined)
    .filter(isDefined);
  state.currentCodeBlock = nodeAtPath(
    state.root,
    snapshot.currentCodeBlockPath,
  ) as CodeBlockViewModelNode | undefined;
  state.currentCodeFence = snapshot.currentCodeFence;
  state.sectionStack = snapshot.sectionStackPaths
    .map((path) => nodeAtPath(state.root, path) as SectionViewModelNode | undefined)
    .filter(isDefined);
  const currentListItem = state.currentListPath.at(-1);
  const parent = currentListItem?.[viewModel].parent;
  state.currentList =
    parent?.type === 'list' ? (parent as ListViewModelNode) : undefined;
  return state;
}

function parseLine(state: BlockParseState, line: string) {
  const quotedListContinuation = parseQuotedListContinuation(state, line);
  if (quotedListContinuation) {
    syncQuoteStack(
      state,
      quotedListContinuation.quoteBase,
      quotedListContinuation.quoteDepth,
    );
    state.currentListPath = [quotedListContinuation.container];
    state.currentList =
      quotedListContinuation.container[viewModel].parent?.type === 'list'
        ? (quotedListContinuation.container[viewModel].parent as ListViewModelNode)
        : undefined;
    if (quotedListContinuation.content === '') {
      closeParagraph(state);
      return;
    }
    parseResolvedContainerContent(
      state,
      quotedListContinuation.container,
      quotedListContinuation.content,
    );
    return;
  }

  const blankPrefix = parseBlankLinePrefix(state, line);
  if (blankPrefix) {
    closeParagraph(state);
    state.currentList = undefined;
    syncQuoteStack(state, blankPrefix.quoteBase, blankPrefix.quoteDepth);
    return;
  }

  if (isBlankLine(line)) {
    closeLeafBlocks(state);
    return;
  }

  const prefix = parseLinePrefix(state, line);
  if (
    prefix.prefixes.length === 0 &&
    prefix.listDepth === 0 &&
    !prefix.continuedListIndent
  ) {
    exitDetachedContainerContexts(state);
  }
  if (prefix.continuedListIndent) {
    state.currentListPath = [...state.currentListPath];
  } else {
    state.currentListPath = state.currentListPath.slice(0, prefix.listDepth);
  }
  const container = resolvePrefixContainers(state, prefix);
  parseResolvedContainerContent(state, container, prefix.content);
}

function projectPendingLine(
  state: BlockParseState,
  line: string,
): ProjectedPendingState | undefined {
  if (!line) {
    return;
  }

  if (state.currentCodeBlock && state.currentCodeFence) {
    const prefix = parseLinePrefix(state, line);
    if (prefix.content === '') {
      return;
    }
    if (isClosingFence(prefix.content, state.currentCodeFence)) {
      return;
    }
    return {kind: 'code-block', text: appendCodeBlockLine(state, prefix.content)};
  }

  const quotedListContinuation = parseQuotedListContinuation(state, line);
  if (quotedListContinuation) {
    syncQuoteStack(
      state,
      quotedListContinuation.quoteBase,
      quotedListContinuation.quoteDepth,
    );
    state.currentListPath = [quotedListContinuation.container];
    state.currentList =
      quotedListContinuation.container[viewModel].parent?.type === 'list'
        ? (quotedListContinuation.container[viewModel].parent as ListViewModelNode)
        : undefined;
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
    projectPendingQuoteOpen(state, currentSectionContainer(state));
    return {kind: 'quote-open', text: line};
  }
  if (prefix.content === '') {
    return;
  }
  if (
    prefix.prefixes.length === 0 &&
    prefix.listDepth === 0 &&
    !prefix.continuedListIndent
  ) {
    exitDetachedContainerContexts(state);
  }
  if (prefix.continuedListIndent) {
    state.currentListPath = [...state.currentListPath];
  }
  const container = resolvePrefixContainers(state, prefix);
  return projectPendingResolvedContent(state, container, prefix.content, line);
}

function projectPendingResolvedContent(
  state: BlockParseState,
  container: ViewModelNode,
  content: string,
  line: string,
): ProjectedPendingState | undefined {
  if (content === '') {
    return;
  }
  const atxHeading = parseAtxHeading(content);
  if (atxHeading) {
    projectPendingSectionText(state, container, atxHeading.level, atxHeading.content);
    return {kind: 'section', text: line};
  }

  const listItem = parseListItem(content);
  if (listItem) {
    projectPendingListItem(
      state,
      container,
      listItem.marker,
      listItem.checked,
      listItem.content,
    );
    return {kind: 'list-item', text: content};
  }

  const fence = parseFenceStart(content);
  if (fence) {
    projectPendingCodeBlockOpen(state, container, fence.marker, fence.info);
    return {kind: 'code-block-open', text: content};
  }

  if (!canProjectPendingParagraph(content)) {
    return;
  }
  return {
    kind: 'paragraph',
    text: appendPendingParagraphText(state, container, content),
  };
}

function discardProjectedPendingLine(
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
  const parent = state.currentParagraph[viewModel].parent;
  removeTrailingText(state.currentParagraph, text.length);
  if (state.currentParagraph.content === '') {
    state.currentParagraph[viewModel].remove();
    state.currentParagraph = undefined;
    pruneEmptyContainerChain(parent);
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
  (node as {content: string}).content = node.content.slice(0, -text.length);
  node[viewModel].renderSignal.value++;
  pruneDetachedState(state);
}

function discardProjectedCodeBlockOpen(state: BlockParseState) {
  const node = state.currentCodeBlock;
  if (!node || node.content !== '') return;
  const parent = node[viewModel].parent;
  node[viewModel].remove();
  state.currentCodeBlock = undefined;
  state.currentCodeFence = undefined;
  pruneEmptyContainerChain(parent);
  pruneDetachedState(state);
}

function discardProjectedQuoteOpen(state: BlockParseState) {
  const quote = state.currentQuoteStack.at(-1);
  if (!quote || quote.children?.length) return;
  const parent = quote[viewModel].parent;
  quote[viewModel].remove();
  pruneEmptyContainerChain(parent);
  pruneDetachedState(state);
}

function discardProjectedListItem(state: BlockParseState) {
  const item = state.currentListPath.at(-1);
  if (!item) return;
  const list = item[viewModel].parent;
  item[viewModel].remove();
  state.currentParagraph = undefined;
  state.currentListPath.pop();
  if (list?.type === 'list' && !list.children?.length) {
    list[viewModel].remove();
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
  if (!state.currentParagraph || state.currentParagraph[viewModel].parent !== container) {
    const paragraph = state.tree.add({
      type: 'paragraph',
      content: '',
    }) as ParagraphViewModelNode;
    paragraph[viewModel].insertBefore(container);
    state.currentParagraph = paragraph;
    state.sawContent = true;
  } else if (state.currentParagraph.content !== '') {
    prefix = '\n';
  }
  const inserted = prefix + line;
  appendInlineText(state.currentParagraph as ParagraphViewModelNode, inserted);
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

function projectPendingQuoteOpen(
  state: BlockParseState,
  parent: ViewModelNode,
) {
  syncQuoteStack(state, parent, 1);
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

function canProjectPendingParagraph(line: string): boolean {
  return !parseFenceStart(line);
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

function isBlankLine(line: string): boolean {
  return /^\s*$/.test(line);
}

function parseBlankLinePrefix(
  state: BlockParseState,
  line: string,
): {quoteBase: ViewModelNode; quoteDepth: number} | undefined {
  let rest = line;
  let currentContainer: ViewModelNode = currentSectionContainer(state);
  let quoteBase = currentContainer;
  let quoteDepth = 0;
  let matchedPrefix = false;

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

    const nextListItem = nextListPathItem(
      state.currentListPath,
      currentContainer,
      0,
    );
    if (
      nextListItem &&
      rest.startsWith(listContinuationPrefix(nextListItem))
    ) {
      matchedPrefix = true;
      rest = rest.slice(listContinuationPrefix(nextListItem).length);
      currentContainer = nextListItem;
      continue;
    }
    break;
  }

  if (matchedPrefix && /^\s*$/.test(rest)) {
    return {quoteBase, quoteDepth};
  }
  return;
}

function tryPromoteSetextHeading(
  state: BlockParseState,
  line: string,
  container: ViewModelNode,
): boolean {
  const match = /^(=+|-+)\s*$/.exec(line);
  const paragraph = state.currentParagraph;
  if (
    !match ||
    !paragraph ||
    paragraph.content.includes('\n') ||
    paragraph[viewModel].parent !== container
  ) {
    return false;
  }

  const parent = paragraph[viewModel].parent;
  if (!parent || (parent.type !== 'document' && parent.type !== 'section')) {
    return false;
  }

  const level = match[1][0] === '=' ? 1 : 2;
  closeParagraph(state);
  promoteParagraphToSection(state, paragraph, parent, level);
  return true;
}

function promoteParagraphToSection(
  state: BlockParseState,
  paragraph: ParagraphViewModelNode,
  parent: ViewModelNode,
  level: number,
) {
  syncSectionStack(state, parent);
  popSectionsToLevel(state, level);

  const container = currentSectionContainer(state);
  const nextSibling = paragraph[viewModel].nextSibling;
  const section = state.tree.add({
    type: 'section',
    marker: '#'.repeat(level),
    content: paragraph.content,
    children: [],
  }) as SectionViewModelNode;
  section[viewModel].insertBefore(container, nextSibling);
  paragraph[viewModel].remove();
  state.sectionStack.push(section);
  state.sawContent = true;
}

function parseAtxHeading(
  line: string,
): {level: number; content: string} | undefined {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) return;
  return {
    level: match[1].length,
    content: match[2],
  };
}

function openSection(state: BlockParseState, level: number, content: string) {
  popSectionsToLevel(state, level);
  const parent = currentSectionContainer(state);
  ensurePlaceholderRemoved(state);
  const section = state.tree.add({
    type: 'section',
    marker: '#'.repeat(level),
    content,
    children: [],
  }) as SectionViewModelNode;
  section[viewModel].insertBefore(parent);
  state.sectionStack.push(section);
  state.sawContent = true;
}

function parseListItem(
  line: string,
): {marker: string; checked?: boolean; content: string} | undefined {
  const match = /^((?:[-+*]|\d+[.)]) )(\[(x| )\] )?(.*)$/.exec(line);
  if (!match) return;
  const checked = match[3] === 'x' ? true : match[2] ? false : undefined;
  return {
    marker: match[1],
    checked,
    content: match[4],
  };
}

function appendListItem(
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
  state.currentListPath = buildListPath(state, parent, item);
  parseInitialListItemContent(state, item, content);
  state.sawContent = true;
}

function parseInitialListItemContent(
  state: BlockParseState,
  item: ListItemViewModelNode,
  content: string,
) {
  parseInitialContainerContent(state, item, content);
}

function parseInitialContainerContent(
  state: BlockParseState,
  parent: ViewModelNode,
  content: string,
) {
  if (content.trim() === '<!-- -->') {
    const paragraph = state.tree.add({
      type: 'paragraph',
      content: '',
    }) as ParagraphViewModelNode;
    paragraph[viewModel].insertBefore(parent);
    state.currentParagraph = paragraph;
    return;
  }

  if (content === '') {
    const paragraph = state.tree.add({
      type: 'paragraph',
      content: '',
    }) as ParagraphViewModelNode;
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

  const quoteMatch = /^(>\s?)(.*)$/.exec(content);
  if (quoteMatch) {
    const quote = syncQuoteStack(state, parent, 1);
    parseInitialContainerContent(state, quote, quoteMatch[2]);
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
  }) as ParagraphViewModelNode;
  paragraph[viewModel].insertBefore(parent);
  state.currentParagraph = paragraph;
}

function parseFenceStart(line: string): {marker: string; info: string | null} | undefined {
  const match = /^(```+)(.*)$/.exec(line);
  if (!match) return;
  const info = match[2].trim();
  return {
    marker: match[1],
    info: info === '' ? null : info,
  };
}

function parseResolvedContainerContent(
  state: BlockParseState,
  container: ViewModelNode,
  content: string,
) {
  if (content.trim() === '<!-- -->') {
    closeLeafBlocks(state);
    appendParagraphLine(state, container, '');
    return;
  }

  if (state.currentCodeBlock && state.currentCodeFence) {
    if (isClosingFence(content, state.currentCodeFence)) {
      closeCodeBlock(state);
    } else {
      appendCodeBlockLine(state, content);
    }
    return;
  }

  if (tryPromoteSetextHeading(state, content, container)) {
    return;
  }

  const atxHeading = parseAtxHeading(content);
  if (atxHeading) {
    closeLeafBlocks(state);
    openSection(state, atxHeading.level, atxHeading.content);
    return;
  }

  const quoteMatch = /^(>\s?)(.*)$/.exec(content);
  if (quoteMatch) {
    closeParagraph(state);
    const quote = syncQuoteStack(state, container, 1);
    parseResolvedContainerContent(state, quote, quoteMatch[2]);
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
    appendParagraphLine(state, container, content);
    return;
  }
  closeList(state);
  appendParagraphLine(state, container, content);
}

function openCodeBlock(
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
  }) as CodeBlockViewModelNode;
  node[viewModel].insertBefore(parent);
  state.currentCodeBlock = node;
  state.currentCodeFence = marker;
  state.sawContent = true;
}

function appendCodeBlockLine(state: BlockParseState, line: string): string {
  const node = state.currentCodeBlock;
  if (!node) return '';
  const inserted = node.content === '' ? line : `\n${line}`;
  const newContent = `${node.content}${inserted}`;
  (node as {content: string}).content = newContent;
  node[viewModel].renderSignal.value++;
  return inserted;
}

function isClosingFence(line: string, marker: string): boolean {
  return new RegExp(`^\\s{0,3}${escapeRegExp(marker)}\\s*$`).test(line);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function closeCodeBlock(state: BlockParseState) {
  state.currentCodeBlock = undefined;
  state.currentCodeFence = undefined;
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

function appendParagraphLine(
  state: BlockParseState,
  container: ViewModelNode,
  line: string,
) {
  ensurePlaceholderRemoved(state);
  if (state.currentParagraph && state.currentParagraph[viewModel].parent === container) {
    appendInlineText(state.currentParagraph, `\n${line}`);
    return;
  }

  const paragraph = state.tree.add({
    type: 'paragraph',
    content: line,
  }) as ParagraphViewModelNode;
  paragraph[viewModel].insertBefore(container);
  state.currentParagraph = paragraph;
  state.sawContent = true;
}

function appendInlineText(node: ParagraphViewModelNode, text: string) {
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

function ensurePlaceholderRemoved(state: BlockParseState) {
  const onlyChild = state.root.children?.[0];
  if (
    state.root.children?.length === 1 &&
    onlyChild?.type === 'paragraph' &&
    onlyChild.content === ''
  ) {
    (onlyChild as ParagraphViewModelNode)[viewModel].remove();
  }
}

function removeEmptyRootParagraph(state: BlockParseState) {
  if (state.root.children?.length !== 1) return;
  const onlyChild = state.root.children[0];
  if (onlyChild.type !== 'paragraph' || onlyChild.content !== '') return;
  (onlyChild as ParagraphViewModelNode)[viewModel].remove();
}

function pruneDetachedState(state: BlockParseState) {
  state.sectionStack = state.sectionStack.filter((node) => isAttached(state.root, node));

  if (state.currentParagraph && !isAttached(state.root, state.currentParagraph)) {
    state.currentParagraph = undefined;
  }

  if (state.currentCodeBlock && !isAttached(state.root, state.currentCodeBlock)) {
    state.currentCodeBlock = undefined;
    state.currentCodeFence = undefined;
  }

  if (state.currentQuoteBase && !isAttached(state.root, state.currentQuoteBase)) {
    state.currentQuoteBase = undefined;
    state.currentQuoteStack = [];
  } else {
    state.currentQuoteStack = state.currentQuoteStack.filter((node) =>
      isAttached(state.root, node),
    );
  }

  state.currentListPath = state.currentListPath.filter((node) =>
    isAttached(state.root, node),
  );

  if (state.currentList && !isAttached(state.root, state.currentList)) {
    state.currentList = undefined;
  }

  const currentListItem = state.currentListPath.at(-1);
  const parent = currentListItem?.[viewModel].parent;
  if (parent?.type === 'list') {
    state.currentList = parent as ListViewModelNode;
  }
}

function cleanupInactiveEmptyBlocks(state: BlockParseState) {
  const preserved = new Set<ViewModelNode>();
  for (const node of activeNodes(state)) {
    let current: ViewModelNode | undefined = node;
    while (current && !preserved.has(current)) {
      preserved.add(current);
      current = current[viewModel].parent;
    }
  }

  for (const node of collectEmptyBlocks(state.root)) {
    if (!preserved.has(node)) {
      node[viewModel].remove();
    }
  }
  pruneDetachedState(state);
}

function *activeNodes(state: BlockParseState): Generator<ViewModelNode> {
  yield state.root;
  if (state.currentParagraph) yield state.currentParagraph;
  if (state.currentList) yield state.currentList;
  for (const node of state.currentListPath) yield node;
  if (state.currentQuoteBase) yield state.currentQuoteBase;
  for (const node of state.currentQuoteStack) yield node;
  if (state.currentCodeBlock) yield state.currentCodeBlock;
  for (const node of state.sectionStack) yield node;
}

function collectEmptyBlocks(root: ViewModelNode): ViewModelNode[] {
  const result: ViewModelNode[] = [];

  function visit(node: ViewModelNode) {
    for (const child of (node.children ?? []) as ViewModelNode[]) {
      visit(child);
    }
    if (
      node !== root &&
      !node.children?.length &&
      ['list-item', 'list', 'block-quote'].includes(node.type)
    ) {
      result.push(node);
    }
  }

  visit(root);
  return result;
}

function pruneEmptyContainerChain(node?: ViewModelNode) {
  while (
    node &&
    node[viewModel].parent &&
    !node[viewModel].firstChild &&
    ['list-item', 'list', 'block-quote'].includes(node.type)
  ) {
    const parent = node[viewModel].parent;
    node[viewModel].remove();
    node = parent;
  }
}

function exitDetachedContainerContexts(state: BlockParseState) {
  state.currentList = undefined;
  state.currentListPath = [];
  resetQuoteStack(state);
  state.sectionStack = state.sectionStack.filter(
    (node) => !hasContainerAncestor(node, 'list-item') && !hasContainerAncestor(node, 'block-quote'),
  );
  pruneDetachedState(state);
}

function currentSectionContainer(state: BlockParseState): ViewModelNode {
  return state.sectionStack.at(-1) ?? state.root;
}

function nextListPathItem(
  path: ListItemViewModelNode[],
  container: ViewModelNode,
  depth: number,
): ListItemViewModelNode | undefined {
  const item = path[depth];
  const parent = item?.[viewModel].parent;
  if (parent?.type !== 'list') return;
  return parent[viewModel].parent === container ? item : undefined;
}

function getQuotedPrefixContainer(
  state: BlockParseState,
  base: ViewModelNode,
  depth: number,
): ViewModelNode | undefined {
  if (state.currentQuoteBase === base) {
    return state.currentQuoteStack[depth - 1];
  }
  return activeQuoteChainForBase(state, base)[depth - 1];
}

function activeQuoteChainForBase(
  state: BlockParseState,
  base: ViewModelNode,
): BlockQuoteViewModelNode[] {
  const seed =
    state.currentCodeBlock ??
    state.currentParagraph ??
    state.currentListPath.at(-1) ??
    state.currentQuoteStack.at(-1) ??
    state.sectionStack.at(-1);
  if (!seed) return [];

  const path: ViewModelNode[] = [];
  let node: ViewModelNode | undefined = seed;
  while (node && node !== base) {
    path.push(node);
    node = node[viewModel].parent;
  }
  if (node !== base) return [];

  return path.reverse().filter((node): node is BlockQuoteViewModelNode => node.type === 'block-quote');
}

function parseLinePrefix(
  state: BlockParseState,
  line: string,
): LinePrefixResult {
  let rest = line;
  let currentContainer: ViewModelNode = currentSectionContainer(state);
  let listDepth = 0;
  let quoteBase: ViewModelNode | undefined;
  let quoteDepth = 0;
  const prefixes: Array<'list' | 'quote'> = [];
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

    const nextListItem = nextListPathItem(
      state.currentListPath,
      currentContainer,
      listDepth,
    );
    if (
      nextListItem &&
      rest.startsWith(listContinuationPrefix(nextListItem))
    ) {
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

function isInsideListPath(
  node: ViewModelNode,
  ancestor?: ListItemViewModelNode,
): boolean {
  if (!ancestor) return false;
  let parent: ViewModelNode | undefined = node;
  while (parent) {
    if (parent === ancestor) return true;
    parent = parent[viewModel].parent;
  }
  return false;
}

function resolvePrefixContainers(
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
    container = syncQuoteStack(state, quoteBase ?? container, quoteDepth);
  }

  if (!sawQuote) {
    resetQuoteStack(state);
  }
  return container;
}

function syncQuoteStack(
  state: BlockParseState,
  base: ViewModelNode,
  depth: number,
): ViewModelNode {
  if (depth === 0) {
    resetQuoteStack(state);
    return base;
  }

  if (state.currentQuoteBase !== base) {
    resetQuoteStack(state);
    state.currentQuoteBase = base;
  }

  while (state.currentQuoteStack.length > depth) {
    state.currentQuoteStack.pop();
  }

  while (state.currentQuoteStack.length < depth) {
    ensurePlaceholderRemoved(state);
    const parent = state.currentQuoteStack.at(-1) ?? base;
    const quote = state.tree.add({
      type: 'block-quote',
      marker: '> ',
      children: [],
    }) as BlockQuoteViewModelNode;
    quote[viewModel].insertBefore(parent);
    state.currentQuoteStack.push(quote);
    state.sawContent = true;
  }

  return state.currentQuoteStack.at(-1) ?? base;
}

function resetQuoteStack(state: BlockParseState) {
  state.currentQuoteBase = undefined;
  state.currentQuoteStack.length = 0;
}

function ensureListContainer(
  state: BlockParseState,
  parent: ViewModelNode,
): ListViewModelNode {
  if (state.currentList && state.currentList[viewModel].parent === parent) {
    return state.currentList;
  }

  const lastChild = parent.children?.at(-1);
  if (lastChild?.type === 'list') {
    const list = lastChild as ListViewModelNode;
    state.currentList = list;
    return list;
  }

  const list = state.tree.add({
    type: 'list',
    children: [],
  }) as ListViewModelNode;
  list[viewModel].insertBefore(parent);
  state.currentList = list;
  return list;
}

function listContinuationPrefix(item?: ListItemViewModelNode): string {
  return ' '.repeat(item?.marker.length ?? 0);
}

function buildListPath(
  state: BlockParseState,
  parent: ViewModelNode,
  item: ListItemViewModelNode,
): ListItemViewModelNode[] {
  for (let depth = state.currentListPath.length - 1; depth >= 0; depth--) {
    const ancestor = state.currentListPath[depth];
    if (parent === ancestor || isInsideListPath(parent, ancestor)) {
      return [...state.currentListPath.slice(0, depth + 1), item];
    }
  }
  return [item];
}

function parseQuotedListContinuation(
  state: BlockParseState,
  line: string,
): {
  container: ListItemViewModelNode;
  content: string;
  quoteBase: ViewModelNode;
  quoteDepth: number;
} | undefined {
  if (state.currentCodeBlock && state.currentCodeFence) {
    return;
  }

  const container = state.currentListPath.at(-1);
  if (!container) return;

  const quoteContext = quoteContextForNode(container);
  if (!quoteContext || quoteContext.quoteDepth === 0) return;

  let rest = line;
  for (let depth = 0; depth < quoteContext.quoteDepth; depth++) {
    const quoteMatch = /^(>\s?)(.*)$/.exec(rest);
    if (!quoteMatch) {
      return;
    }
    rest = quoteMatch[2];
  }

  const continuation = listContinuationPrefix(container);
  if (!rest.startsWith(continuation)) {
    return;
  }

  return {
    container,
    content: rest.slice(continuation.length),
    quoteBase: quoteContext.quoteBase,
    quoteDepth: quoteContext.quoteDepth,
  };
}

function quoteContextForNode(
  node: ViewModelNode,
): {quoteBase: ViewModelNode; quoteDepth: number} | undefined {
  const quotes: BlockQuoteViewModelNode[] = [];
  let current: ViewModelNode | undefined = node[viewModel].parent;
  let quoteBase: ViewModelNode | undefined;

  while (current) {
    if (current.type === 'block-quote') {
      quotes.push(current);
    } else if (quotes.length) {
      quoteBase = current;
      break;
    }
    current = current[viewModel].parent;
  }

  if (!quoteBase || quotes.length === 0) {
    return;
  }

  return {
    quoteBase,
    quoteDepth: quotes.length,
  };
}

function syncSectionStack(state: BlockParseState, parent: ViewModelNode) {
  if (parent.type !== 'section') {
    state.sectionStack.length = 0;
    return;
  }
  while (state.sectionStack.length && state.sectionStack.at(-1) !== parent) {
    state.sectionStack.pop();
  }
}

function popSectionsToLevel(state: BlockParseState, level: number) {
  while (state.sectionStack.length >= level) {
    state.sectionStack.pop();
  }
}

function closeParagraph(state: BlockParseState) {
  state.currentParagraph = undefined;
}

function closeList(state: BlockParseState) {
  if (state.currentParagraph?.[viewModel].parent?.type === 'list-item') {
    state.currentParagraph = undefined;
  }
  state.currentList = undefined;
}

function closeQuote(state: BlockParseState) {
  if (state.currentParagraph && isInsideBlockQuote(state.currentParagraph)) {
    state.currentParagraph = undefined;
  }
  resetQuoteStack(state);
}

function closeLeafBlocks(state: BlockParseState) {
  closeParagraph(state);
  closeList(state);
  closeQuote(state);
  closeCodeBlock(state);
}

function isInsideBlockQuote(node: ViewModelNode): boolean {
  let parent = node[viewModel].parent;
  while (parent) {
    if (parent.type === 'block-quote') return true;
    parent = parent[viewModel].parent;
  }
  return false;
}

function isAttached(root: ViewModelNode, node: ViewModelNode): boolean {
  return pathForNode(root, node) !== undefined;
}

function hasContainerAncestor(
  node: ViewModelNode,
  type: 'list-item' | 'block-quote',
): boolean {
  let parent = node[viewModel].parent;
  while (parent) {
    if (parent.type === type) return true;
    parent = parent[viewModel].parent;
  }
  return false;
}

function pathForNode(
  root: ViewModelNode,
  node?: ViewModelNode,
): number[] | undefined {
  if (!node) return;
  const path: number[] = [];
  while (node !== root) {
    const parent: ViewModelNode | undefined = node[viewModel].parent;
    if (!parent) return;
    const index = parent.children?.indexOf(node);
    if (index === undefined || index < 0) return;
    path.unshift(index);
    node = parent;
  }
  return path;
}

function nodeAtPath(
  root: ViewModelNode,
  path?: number[],
): ViewModelNode | undefined {
  if (!path) return;
  let node: ViewModelNode | undefined = root;
  for (const index of path) {
    node = node.children?.[index] as ViewModelNode | undefined;
    if (!node) return;
  }
  return node;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
