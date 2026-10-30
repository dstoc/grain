import type {
  BlockQuoteNode,
  CodeBlockNode,
  DocumentNode,
  ListItemNode,
  MarkdownNode,
  ParagraphNode,
  SectionNode,
} from '../node.js';
import { MarkdownTree } from '../view-model.js';
import type { ViewModelNode } from '../view-model-node.js';

export type ParagraphViewModelNode = ParagraphNode & ViewModelNode;
export type SectionViewModelNode = SectionNode & ViewModelNode;
export type ListViewModelNode = Extract<MarkdownNode, { type: 'list' }> & ViewModelNode;
export type ListItemViewModelNode = ListItemNode & ViewModelNode;
export type BlockQuoteViewModelNode = BlockQuoteNode & ViewModelNode;
export type CodeBlockViewModelNode = CodeBlockNode & ViewModelNode;

export interface BlockParseState {
  tree: MarkdownTree;
  root: DocumentNode & ViewModelNode;
  sawContent: boolean;
  currentParagraph?: ParagraphViewModelNode;
  currentList?: ListViewModelNode;
  currentListPath: ListItemViewModelNode[];
  // Source indentation remains stable when document markers are normalized.
  sourceMarkerWidths: Map<ListItemViewModelNode, number>;
  currentQuoteBase?: ViewModelNode;
  currentQuoteStack: BlockQuoteViewModelNode[];
  currentCodeBlock?: CodeBlockViewModelNode;
  currentCodeFence?: string;
  sectionStack: SectionViewModelNode[];
}

export interface LinePrefixResult {
  content: string;
  prefixes: ('list' | 'quote')[];
  listDepth: number;
  continuedListIndent: boolean;
}

export type ProjectedPendingKind =
  | 'paragraph'
  | 'section'
  | 'code-block'
  | 'code-block-open'
  | 'quote-open'
  | 'list-item';

export interface ProjectedPendingState {
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

export interface BlockParserSnapshot {
  root: DocumentNode;
  pendingText: string;
  projectedPending?: ProjectedPendingState;
  sawContent: boolean;
  finished: boolean;
  currentParagraphPath?: number[];
  currentListPath: number[][];
  sourceMarkerWidths?: { path: number[]; width: number }[];
  currentQuoteBasePath?: number[];
  currentQuoteStackPaths: number[][];
  currentCodeBlockPath?: number[];
  currentCodeFence?: string;
  sectionStackPaths: number[][];
}
