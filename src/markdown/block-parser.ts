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
  projectedPendingLine: string;
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
  let projectedPendingLine = snapshot?.projectedPendingLine ?? '';

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
        discardProjectedPendingLine(state, projectedPendingLine);
        projectedPendingLine = '';

        const lines = pendingText.split('\n');
        pendingText = lines.pop() ?? '';
        for (const line of lines) {
          parseLine(state, line);
        }

        projectedPendingLine = projectPendingLine(state, pendingText);
        return {};
      }, false);
      return tree;
    },
    finish() {
      if (finished) {
        return tree;
      }
      tree.edit(() => {
        discardProjectedPendingLine(state, projectedPendingLine);
        projectedPendingLine = '';
        if (pendingText !== '') {
          parseLine(state, pendingText);
          pendingText = '';
        }
        closeLeafBlocks(state);
        return {};
      }, false);
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
        projectedPendingLine,
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
  const container = resolvePrefixContainers(state, prefix);
  const unquotedContent = prefix.content;

  if (state.currentCodeBlock && state.currentCodeFence) {
    if (isClosingFence(unquotedContent, state.currentCodeFence)) {
      closeCodeBlock(state);
    } else {
      appendCodeBlockLine(state, unquotedContent);
    }
    return;
  }

  if (tryPromoteSetextHeading(state, unquotedContent, container)) {
    return;
  }

  const atxHeading = parseAtxHeading(unquotedContent);
  if (atxHeading) {
    closeLeafBlocks(state);
    openSection(state, atxHeading.level, atxHeading.content);
    return;
  }

  const listItem = parseListItem(unquotedContent);
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

  const fence = parseFenceStart(unquotedContent);
  if (fence) {
    closeParagraph(state);
    closeList(state);
    openCodeBlock(state, container, fence.marker, fence.info);
    return;
  }

  if (canContinueListParagraph(state, container, unquotedContent)) {
    appendParagraphLine(state, container, unquotedContent);
    return;
  }
  closeList(state);
  appendParagraphLine(state, container, unquotedContent);
}

function projectPendingLine(state: BlockParseState, line: string): string {
  if (!line || !isSafeProvisionalParagraph(line)) {
    return '';
  }
  closeList(state);
  state.currentListPath.length = 0;
  resetQuoteStack(state);
  appendPendingParagraphText(state, currentSectionContainer(state), line);
  return line;
}

function discardProjectedPendingLine(state: BlockParseState, line: string) {
  if (!line || !state.currentParagraph) {
    return;
  }
  removeTrailingText(state.currentParagraph, line.length);
  if (state.currentParagraph.content === '') {
    state.currentParagraph[viewModel].remove();
    state.currentParagraph = undefined;
  }
}

function appendPendingParagraphText(
  state: BlockParseState,
  container: ViewModelNode,
  line: string,
) {
  ensurePlaceholderRemoved(state);
  if (!state.currentParagraph || state.currentParagraph[viewModel].parent !== container) {
    const paragraph = state.tree.add({
      type: 'paragraph',
      content: '',
    }) as ParagraphViewModelNode;
    paragraph[viewModel].insertBefore(container);
    state.currentParagraph = paragraph;
    state.sawContent = true;
  }
  appendInlineText(state.currentParagraph as ParagraphViewModelNode, line);
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

function isSafeProvisionalParagraph(line: string): boolean {
  return !/^(#{1,6})($|\s)|^((?:[-+*]|\d+[.)]) )|^(>\s?)/.test(line);
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
      if (quoteBase !== currentContainer) {
        quoteBase = currentContainer;
        quoteDepth = 0;
      }
      quoteDepth++;
      rest = quoteMatch[2];
      currentContainer =
        getQuotedPrefixContainer(state, quoteBase, quoteDepth) ??
        currentContainer;
      continue;
    }

    const nextListItem = nextListPathItem(
      state.currentListPath,
      currentContainer,
      0,
    );
    if (nextListItem && rest.startsWith('  ')) {
      matchedPrefix = true;
      rest = rest.slice(2);
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
    children: [{type: 'paragraph', content}],
  }) as ListItemViewModelNode;
  item[viewModel].insertBefore(list);
  state.currentParagraph = item.children?.[0] as ParagraphViewModelNode | undefined;
  state.currentListPath = buildListPath(state, parent, item);
  state.sawContent = true;
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

function appendCodeBlockLine(state: BlockParseState, line: string) {
  const node = state.currentCodeBlock;
  if (!node) return;
  const newContent = node.content === '' ? line : `${node.content}\n${line}`;
  (node as {content: string}).content = newContent;
  node[viewModel].renderSignal.value++;
}

function isClosingFence(line: string, marker: string): boolean {
  return new RegExp(`^${escapeRegExp(marker)}\\s*$`).test(line);
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
  if (state.sawContent) return;
  const onlyChild = state.root.children?.[0];
  if (
    state.root.children?.length === 1 &&
    onlyChild?.type === 'paragraph' &&
    onlyChild.content === ''
  ) {
    (onlyChild as ParagraphViewModelNode)[viewModel].remove();
  }
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
  if (state.currentQuoteBase !== base) return;
  return state.currentQuoteStack[depth - 1];
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

  while (true) {
    const quoteMatch = /^(>\s?)(.*)$/.exec(rest);
    if (quoteMatch) {
      prefixes.push('quote');
      if (quoteBase !== currentContainer) {
        quoteBase = currentContainer;
        quoteDepth = 0;
      }
      quoteDepth++;
      rest = quoteMatch[2];
      currentContainer =
        getQuotedPrefixContainer(state, quoteBase, quoteDepth) ??
        currentContainer;
      continue;
    }

    const nextListItem = nextListPathItem(
      state.currentListPath,
      currentContainer,
      listDepth,
    );
    if (nextListItem && rest.startsWith('  ')) {
      prefixes.push('list');
      rest = rest.slice(2);
      currentContainer = nextListItem;
      listDepth++;
      continue;
    }
    break;
  }
  state.currentListPath = state.currentListPath.slice(0, listDepth);

  return {
    content: rest,
    prefixes,
  };
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
    if (quoteBase !== container) {
      quoteBase = container;
      quoteDepth = 0;
    }
    quoteDepth++;
    container = syncQuoteStack(state, quoteBase, quoteDepth);
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

function buildListPath(
  state: BlockParseState,
  parent: ViewModelNode,
  item: ListItemViewModelNode,
): ListItemViewModelNode[] {
  if (parent.type === 'list-item') {
    const depth = state.currentListPath.indexOf(parent as ListItemViewModelNode);
    if (depth >= 0) {
      return [...state.currentListPath.slice(0, depth + 1), item];
    }
    return [parent as ListItemViewModelNode, item];
  }
  return [item];
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
