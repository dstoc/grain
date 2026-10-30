import { viewModel } from '../view-model-node.js';
import { MarkdownTree } from '../view-model.js';
import { nodeAtPath, isDefined } from './utils.js';
import {
  type BlockParseState,
  type BlockParserSnapshot,
  type ParagraphViewModelNode,
  type ListItemViewModelNode,
  type BlockQuoteViewModelNode,
  type CodeBlockViewModelNode,
  type SectionViewModelNode,
} from './types.js';

export function createInitialState(tree: MarkdownTree): BlockParseState {
  return {
    tree,
    root: tree.root,
    sawContent: false,
    currentListPath: [],
    sourceMarkerWidths: new Map(),
    currentQuoteStack: [],
    sectionStack: [],
  };
}

export function restoreState(tree: MarkdownTree, snapshot: BlockParserSnapshot): BlockParseState {
  const state = createInitialState(tree);
  state.sawContent = snapshot.sawContent;
  state.currentParagraph = nodeAtPath(state.root, snapshot.currentParagraphPath) as
    | ParagraphViewModelNode
    | undefined;
  state.currentListPath = snapshot.currentListPath
    .map((path) => nodeAtPath(state.root, path) as ListItemViewModelNode | undefined)
    .filter(isDefined);
  for (const { path, width } of snapshot.sourceMarkerWidths ?? []) {
    const item = nodeAtPath(state.root, path);
    if (item?.type === 'list-item') state.sourceMarkerWidths.set(item, width);
  }
  state.currentQuoteBase = nodeAtPath(state.root, snapshot.currentQuoteBasePath);
  state.currentQuoteStack = snapshot.currentQuoteStackPaths
    .map((path) => nodeAtPath(state.root, path) as BlockQuoteViewModelNode | undefined)
    .filter(isDefined);
  state.currentCodeBlock = nodeAtPath(state.root, snapshot.currentCodeBlockPath) as
    | CodeBlockViewModelNode
    | undefined;
  state.currentCodeFence = snapshot.currentCodeFence;
  state.sectionStack = snapshot.sectionStackPaths
    .map((path) => nodeAtPath(state.root, path) as SectionViewModelNode | undefined)
    .filter(isDefined);
  const currentListItem = state.currentListPath.at(-1);
  const parent = currentListItem?.[viewModel].parent;
  state.currentList = parent?.type === 'list' ? parent : undefined;
  return state;
}
