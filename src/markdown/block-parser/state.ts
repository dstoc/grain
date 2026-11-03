import type { ConstructionTree } from '../semantic/construction-tree.js';
import { nodeAtPath, isDefined } from './utils.js';
import {
  type BlockParseState,
  type BlockParserSnapshot,
  type ConstructionParagraphNode,
  type ConstructionListItemNode,
  type ConstructionBlockQuoteNode,
  type ConstructionCodeBlockNode,
  type ConstructionSectionNode,
} from './types.js';

export function createInitialState(tree: ConstructionTree): BlockParseState {
  return {
    tree,
    draft: tree.draft,
    root: tree.root,
    sawContent: false,
    hasExplicitRootParagraph: false,
    currentListPath: [],
    sourceMarkerWidths: new Map(),
    currentQuoteStack: [],
    sectionStack: [],
    sourceTracking: false,
    sourceOffset: 0,
    receivedSourceLength: 0,
    inlinePieces: new Map(),
  };
}

export function restoreState(
  tree: ConstructionTree,
  snapshot: BlockParserSnapshot,
): BlockParseState {
  const state = createInitialState(tree);
  state.sawContent = snapshot.sawContent;
  state.hasExplicitRootParagraph = snapshot.hasExplicitRootParagraph ?? false;
  state.currentParagraph = nodeAtPath(state.root, snapshot.currentParagraphPath) as
    | ConstructionParagraphNode
    | undefined;
  state.currentListPath = snapshot.currentListPath
    .map((path) => nodeAtPath(state.root, path) as ConstructionListItemNode | undefined)
    .filter(isDefined);
  for (const { path, width } of snapshot.sourceMarkerWidths ?? []) {
    const item = nodeAtPath(state.root, path);
    if (item?.type === 'list-item') state.sourceMarkerWidths.set(item, width);
  }
  state.currentQuoteBase = nodeAtPath(state.root, snapshot.currentQuoteBasePath);
  state.currentQuoteStack = snapshot.currentQuoteStackPaths
    .map((path) => nodeAtPath(state.root, path) as ConstructionBlockQuoteNode | undefined)
    .filter(isDefined);
  state.currentCodeBlock = nodeAtPath(state.root, snapshot.currentCodeBlockPath) as
    | ConstructionCodeBlockNode
    | undefined;
  state.currentCodeFence = snapshot.currentCodeFence;
  state.currentCodeHasLines =
    snapshot.currentCodeHasLines ?? Boolean(state.currentCodeBlock?.content);
  state.sectionStack = snapshot.sectionStackPaths
    .map((path) => nodeAtPath(state.root, path) as ConstructionSectionNode | undefined)
    .filter(isDefined);
  const currentListItem = state.currentListPath.at(-1);
  const parent = currentListItem?.parent;
  state.currentList = parent?.type === 'list' ? parent : undefined;
  return state;
}
