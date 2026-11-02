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
  // A parsed root sentinel must not be mistaken for the synthetic empty document.
  hasExplicitRootParagraph: boolean;
  currentParagraph?: ParagraphViewModelNode;
  currentList?: ListViewModelNode;
  currentListPath: ListItemViewModelNode[];
  // Source indentation remains stable when document markers are normalized.
  sourceMarkerWidths: Map<ListItemViewModelNode, number>;
  currentQuoteBase?: ViewModelNode;
  currentQuoteStack: BlockQuoteViewModelNode[];
  currentCodeBlock?: CodeBlockViewModelNode;
  currentCodeFence?: string;
  currentCodeHasLines?: boolean;
  sectionStack: SectionViewModelNode[];
  sourceTracking: boolean;
  sourceOffset: number;
  receivedSourceLength: number;
  sourceBreakBefore?: Extract<OutputPiece, { kind: 'retain' }>;
  inlinePieces: Map<ViewModelNode, readonly OutputPiece[]>;
}

export type SourceRange = { readonly from: number; readonly to: number };

/** Ranges are half-open UTF-16 offsets into the exact source passed to the parser. */
export type OutputPiece =
  | { readonly kind: 'retain'; readonly sourceFrom: number; readonly sourceTo: number }
  | { readonly kind: 'synthesize'; readonly text: string };

export interface MappedText {
  readonly text: string;
  readonly pieces: readonly OutputPiece[];
}

/** Dot-separated child indexes in the output tree; `root` denotes an inline root. */
export type ParsedNodeKey = string;

export interface ParserConversionPlan {
  readonly output: DocumentNode;
  /** Exact source/synthesized pieces for each emitted inline node. */
  readonly inlinePieces: Readonly<Record<ParsedNodeKey, readonly OutputPiece[]>>;
  readonly consumed: readonly SourceRange[];
}

export interface LinePrefixResult {
  content: string;
  contentFrom: number;
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
  getConversionPlan(source: string): ParserConversionPlan;
  snapshot(): BlockParserSnapshot;
}

export interface BlockParserOptions {
  readonly provenance?: boolean;
}

export interface BlockParserSnapshot {
  root: DocumentNode;
  pendingText: string;
  projectedPending?: ProjectedPendingState;
  sawContent: boolean;
  hasExplicitRootParagraph?: boolean;
  finished: boolean;
  currentParagraphPath?: number[];
  currentListPath: number[][];
  sourceMarkerWidths?: { path: number[]; width: number }[];
  currentQuoteBasePath?: number[];
  currentQuoteStackPaths: number[][];
  currentCodeBlockPath?: number[];
  currentCodeFence?: string;
  currentCodeHasLines?: boolean;
  sectionStackPaths: number[][];
  sourceTracking?: boolean;
  sourceOffset?: number;
  receivedSourceLength?: number;
  inlinePieces?: { path: number[]; pieces: OutputPiece[] }[];
}
