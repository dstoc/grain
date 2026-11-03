import type { DocumentNode } from '../node.js';
import type {
  ConstructionNode,
  ConstructionTree,
  ConstructionTreeDraft,
} from '../semantic/construction-tree.js';

export type ConstructionParagraphNode = Extract<ConstructionNode, { type: 'paragraph' }>;
export type ConstructionSectionNode = Extract<ConstructionNode, { type: 'section' }>;
export type ConstructionListNode = Extract<ConstructionNode, { type: 'list' }>;
export type ConstructionListItemNode = Extract<ConstructionNode, { type: 'list-item' }>;
export type ConstructionBlockQuoteNode = Extract<ConstructionNode, { type: 'block-quote' }>;
export type ConstructionCodeBlockNode = Extract<ConstructionNode, { type: 'code-block' }>;

export interface BlockParseState {
  tree: ConstructionTree;
  draft: ConstructionTreeDraft;
  root: Extract<ConstructionNode, { type: 'document' }>;
  sawContent: boolean;
  // A parsed root sentinel must not be mistaken for the synthetic empty document.
  hasExplicitRootParagraph: boolean;
  currentParagraph?: ConstructionParagraphNode;
  currentList?: ConstructionListNode;
  currentListPath: ConstructionListItemNode[];
  // Source indentation remains stable when document markers are normalized.
  sourceMarkerWidths: Map<ConstructionListItemNode, number>;
  currentQuoteBase?: ConstructionNode;
  currentQuoteStack: ConstructionBlockQuoteNode[];
  currentCodeBlock?: ConstructionCodeBlockNode;
  currentCodeFence?: string;
  currentCodeHasLines?: boolean;
  sectionStack: ConstructionSectionNode[];
  sourceTracking: boolean;
  sourceOffset: number;
  receivedSourceLength: number;
  sourceBreakBefore?: Extract<OutputPiece, { kind: 'retain' }>;
  inlinePieces: Map<ConstructionNode, readonly OutputPiece[]>;
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
  push(text: string): ConstructionTree;
  finish(): ConstructionTree;
  getTree(): ConstructionTree;
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
