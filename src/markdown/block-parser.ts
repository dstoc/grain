import type {
  BlockQuoteNode,
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
type BlockQuoteViewModelNode = BlockQuoteNode & ViewModelNode;

interface BlockParseState {
  tree: MarkdownTree;
  root: DocumentNode & ViewModelNode;
  sawContent: boolean;
  currentParagraph?: ParagraphViewModelNode;
  currentList?: ListViewModelNode;
  currentQuote?: BlockQuoteViewModelNode;
  sectionStack: SectionViewModelNode[];
}

export interface BlockParser {
  push(text: string): MarkdownTree;
  finish(): MarkdownTree;
  getTree(): MarkdownTree;
  getPendingText(): string;
}

export type Tree = ParserTree;

export function createBlockParser(): BlockParser {
  const tree = new MarkdownTree({
    type: 'document',
    children: [{type: 'paragraph', content: ''}],
  });
  const state: BlockParseState = {
    tree,
    root: tree.root,
    sawContent: false,
    sectionStack: [],
  };

  let pendingText = '';
  let finished = false;
  let projectedPendingLine = '';

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

function parseLine(state: BlockParseState, line: string) {
  if (isBlankLine(line)) {
    closeLeafBlocks(state);
    return;
  }

  if (tryPromoteSetextHeading(state, line)) {
    return;
  }

  const atxHeading = parseAtxHeading(line);
  if (atxHeading) {
    closeLeafBlocks(state);
    openSection(state, atxHeading.level, atxHeading.content);
    return;
  }

  const listItem = parseListItem(line);
  if (listItem) {
    closeParagraph(state);
    closeQuote(state);
    appendListItem(state, listItem.marker, listItem.checked, listItem.content);
    return;
  }

  const quote = parseBlockQuote(line);
  if (quote) {
    closeList(state);
    appendQuoteLine(state, quote.marker, quote.content);
    return;
  }

  closeList(state);
  closeQuote(state);
  appendParagraphLine(state, line);
}

function projectPendingLine(state: BlockParseState, line: string): string {
  if (!line || !isSafeProvisionalParagraph(line)) {
    return '';
  }
  closeList(state);
  closeQuote(state);
  appendPendingParagraphText(state, line);
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

function appendPendingParagraphText(state: BlockParseState, line: string) {
  ensurePlaceholderRemoved(state);
  if (!state.currentParagraph) {
    const paragraph = state.tree.add({
      type: 'paragraph',
      content: '',
    }) as ParagraphViewModelNode;
    paragraph[viewModel].insertBefore(currentContainer(state));
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

function tryPromoteSetextHeading(state: BlockParseState, line: string): boolean {
  const match = /^(=+|-+)\s*$/.exec(line);
  const paragraph = state.currentParagraph;
  if (!match || !paragraph || paragraph.content.includes('\n')) {
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

  const container = currentContainer(state);
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
  const parent = currentContainer(state);
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
  marker: string,
  checked: boolean | undefined,
  content: string,
) {
  ensurePlaceholderRemoved(state);
  const parent = currentContainer(state);
  if (!state.currentList || state.currentList[viewModel].parent !== parent) {
    const list = state.tree.add({
      type: 'list',
      children: [],
    }) as ListViewModelNode;
    list[viewModel].insertBefore(parent);
    state.currentList = list;
  }
  const list = state.currentList as ListViewModelNode;

  const item = state.tree.add({
    type: 'list-item',
    marker,
    checked,
    children: [{type: 'paragraph', content}],
  }) as ListItemNode & ViewModelNode;
  item[viewModel].insertBefore(list);
  state.currentParagraph = item.children?.[0] as ParagraphViewModelNode | undefined;
  state.sawContent = true;
}

function parseBlockQuote(
  line: string,
): {marker: string; content: string} | undefined {
  const match = /^(>\s?)(.*)$/.exec(line);
  if (!match) return;
  return {
    marker: match[1],
    content: match[2],
  };
}

function appendQuoteLine(
  state: BlockParseState,
  marker: string,
  content: string,
) {
  ensurePlaceholderRemoved(state);
  const parent = currentContainer(state);
  if (!state.currentQuote || state.currentQuote[viewModel].parent !== parent) {
    const quote = state.tree.add({
      type: 'block-quote',
      marker,
      children: [],
    }) as BlockQuoteViewModelNode;
    quote[viewModel].insertBefore(parent);
    state.currentQuote = quote;
    state.currentParagraph = undefined;
  }
  const quote = state.currentQuote as BlockQuoteViewModelNode;

  if (state.currentParagraph && state.currentParagraph[viewModel].parent === quote) {
    appendInlineText(state.currentParagraph, `\n${content}`);
  } else {
    const paragraph = state.tree.add({
      type: 'paragraph',
      content,
    }) as ParagraphViewModelNode;
    paragraph[viewModel].insertBefore(quote);
    state.currentParagraph = paragraph;
  }
  state.sawContent = true;
}

function appendParagraphLine(state: BlockParseState, line: string) {
  ensurePlaceholderRemoved(state);
  if (state.currentParagraph) {
    appendInlineText(state.currentParagraph, `\n${line}`);
    return;
  }

  const paragraph = state.tree.add({
    type: 'paragraph',
    content: line,
  }) as ParagraphViewModelNode;
  paragraph[viewModel].insertBefore(currentContainer(state));
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

function currentContainer(state: BlockParseState): ViewModelNode {
  return state.sectionStack.at(-1) ?? state.root;
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
  if (state.currentParagraph?.[viewModel].parent?.type === 'block-quote') {
    state.currentParagraph = undefined;
  }
  state.currentQuote = undefined;
}

function closeLeafBlocks(state: BlockParseState) {
  closeParagraph(state);
  closeList(state);
  closeQuote(state);
}
