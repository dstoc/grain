import { isInlineNode, type DocumentNode } from '../node.js';
import { MarkdownTree } from '../view-model.js';

export {
  type BlockParser,
  type BlockParserOptions,
  type BlockParserSnapshot,
  type OutputPiece,
  type ParsedNodeKey,
  type ParserConversionPlan,
  type SourceRange,
} from './types.js';
import { isDefined, nodeAtPath, pathForNode } from './utils.js';
import { cleanupInactiveEmptyBlocks, removeEmptyRootParagraph } from './cleanup.js';
import { createInitialState, restoreState } from './state.js';
import { parseLine, projectPendingLine, closeLeafBlocks } from './core.js';
import { discardProjectedPendingLine } from './projected-state.js';
import { sourceText } from './source-text.js';
import { createMarkdownTreeConstructionDraft } from '../canonical-actions.js';
import type {
  BlockParserOptions,
  MappedText,
  OutputPiece,
  ParserConversionPlan,
  SourceRange,
} from './types.js';
import type { ViewModelNode } from '../view-model-node.js';

import type { BlockParser, BlockParserSnapshot } from './types.js';

function withoutTrailingHighSurrogate(text: string): string {
  if (!text.length) return text;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

export function createBlockParser(
  snapshot?: BlockParserSnapshot,
  options: BlockParserOptions = {},
): BlockParser {
  if (snapshot && options.provenance && !snapshot.sourceTracking) {
    throw new Error('cannot enable provenance after restoring an untracked parser snapshot');
  }
  if (
    snapshot?.sourceTracking &&
    (snapshot.sourceOffset === undefined || snapshot.receivedSourceLength === undefined)
  ) {
    throw new Error('provenance snapshot is missing source offsets');
  }
  const sourceTracking = options.provenance ?? snapshot?.sourceTracking ?? false;
  const root =
    snapshot?.root ??
    ({ type: 'document', children: [{ type: 'paragraph', content: '' }] } as DocumentNode);
  const tree = new MarkdownTree(
    root,
    undefined,
    undefined,
    createMarkdownTreeConstructionDraft(root),
  );
  const state = snapshot ? restoreState(tree, snapshot) : createInitialState(tree);
  state.sourceTracking = sourceTracking;
  state.sourceOffset = snapshot?.sourceOffset ?? 0;
  state.receivedSourceLength = snapshot?.receivedSourceLength ?? 0;
  if (state.sourceTracking) {
    if (snapshot) {
      for (const entry of snapshot.inlinePieces ?? []) {
        const node = nodeAtPath(state.root, entry.path);
        if (node)
          state.inlinePieces.set(
            node,
            entry.pieces.map((piece) => ({ ...piece })),
          );
      }
    } else {
      for (const child of state.root.children ?? []) {
        if (child.type === 'paragraph' && child.content === '') state.inlinePieces.set(child, []);
      }
    }
  }

  let pendingText = snapshot?.pendingText ?? '';
  let finished = snapshot?.finished ?? false;
  let projectedPending = snapshot?.projectedPending;
  if (finished) tree.finishConstructionDraft();

  return {
    push(text: string) {
      if (finished) {
        throw new Error('cannot push after finish');
      }
      if (!text) {
        return tree;
      }

      pendingText += text;
      if (state.sourceTracking) state.receivedSourceLength += text.length;
      tree.edit(
        () => {
          discardProjectedPendingLine(state, projectedPending);
          projectedPending = undefined;

          const lines = pendingText.split('\n');
          pendingText = lines.pop() ?? '';
          for (const line of lines) {
            parseSettledLine(state, line);
          }

          // A stream may end between the two UTF-16 units of a valid code point.
          // Keep the unmatched high surrogate in pendingText/snapshots, but do
          // not place it in the strict canonical construction draft until its
          // low surrogate arrives.
          projectedPending = projectPendingLine(state, withoutTrailingHighSurrogate(pendingText));
          cleanupInactiveEmptyBlocks(state);
          return {};
        },
        false,
        { preserveEmptyBlocks: true },
        undefined,
        'construction',
      );
      return tree;
    },
    finish() {
      if (finished) {
        return tree;
      }
      tree.edit(
        () => {
          if (pendingText !== '') {
            discardProjectedPendingLine(state, projectedPending);
            projectedPending = undefined;
            parseSettledLine(state, pendingText, false);
            pendingText = '';
          }
          closeLeafBlocks(state);
          removeEmptyRootParagraph(state);
          return {};
        },
        false,
        { force: true },
        undefined,
        'construction',
      );
      finished = true;
      tree.finishConstructionDraft();
      return tree;
    },
    getTree() {
      return tree;
    },
    getPendingText() {
      return pendingText;
    },
    getConversionPlan(source: string) {
      if (!state.sourceTracking) {
        throw new Error('parser provenance was not enabled');
      }
      if (!finished) throw new Error('parser provenance is available after finish');
      if (source.length !== state.receivedSourceLength) {
        throw new Error('source length does not match the parser input');
      }
      completeEmptyInlineMappings(state.root, state.inlinePieces);
      return conversionPlan(
        tree.serialize() as DocumentNode,
        state.root,
        state.inlinePieces,
        source,
      );
    },
    snapshot() {
      return {
        root: tree.serialize() as DocumentNode,
        pendingText,
        projectedPending,
        sawContent: state.sawContent,
        hasExplicitRootParagraph: state.hasExplicitRootParagraph,
        finished,
        currentParagraphPath: pathForNode(state.root, state.currentParagraph),
        currentListPath: state.currentListPath
          .map((node) => pathForNode(state.root, node))
          .filter(isDefined),
        sourceMarkerWidths: [...state.sourceMarkerWidths].flatMap(([item, width]) => {
          const path = pathForNode(state.root, item);
          return path ? [{ path, width }] : [];
        }),
        currentQuoteBasePath: pathForNode(state.root, state.currentQuoteBase),
        currentQuoteStackPaths: state.currentQuoteStack
          .map((node) => pathForNode(state.root, node))
          .filter(isDefined),
        currentCodeBlockPath: pathForNode(state.root, state.currentCodeBlock),
        currentCodeFence: state.currentCodeFence,
        currentCodeHasLines: state.currentCodeHasLines,
        sectionStackPaths: state.sectionStack
          .map((node) => pathForNode(state.root, node))
          .filter(isDefined),
        ...(state.sourceTracking
          ? {
              sourceTracking: true,
              sourceOffset: state.sourceOffset,
              receivedSourceLength: state.receivedSourceLength,
              inlinePieces: [...state.inlinePieces].flatMap(([node, pieces]) => {
                const path = pathForNode(state.root, node);
                return path ? [{ path, pieces: pieces.map((piece) => ({ ...piece })) }] : [];
              }),
            }
          : {}),
      };
    },
  };
}

function completeEmptyInlineMappings(
  root: ViewModelNode,
  pieces: Map<ViewModelNode, readonly OutputPiece[]>,
): void {
  const visit = (node: ViewModelNode) => {
    if (isInlineNode(node) && node.content === '' && !pieces.has(node)) pieces.set(node, []);
    for (const child of (node.children ?? []) as ViewModelNode[]) visit(child);
  };
  visit(root);
}

export function parseBlocks(markdown: string): { node: DocumentNode };
export function parseBlocks(
  markdown: string,
  options: { readonly provenance: true },
): { node: DocumentNode; provenance: ParserConversionPlan };
export function parseBlocks(
  markdown: string,
  options: { readonly provenance?: boolean } = {},
): { node: DocumentNode; provenance?: ParserConversionPlan } {
  const parser = createBlockParser(undefined, { provenance: options.provenance });
  parser.push(markdown);
  const blockTree = parser.finish();
  if (options.provenance) {
    const provenance = parser.getConversionPlan(markdown);
    return { node: provenance.output, provenance };
  }
  return { node: blockTree.serialize() as DocumentNode };
}

/**
 * Conservatively says whether inline source is still exactly one literal
 * paragraph under Grain's block parser. Any consumed syntax or structural
 * output takes the conversion path.
 */
export function isLiteralParagraphInput(markdown: string): boolean {
  return classifyInlineInput(markdown).kind === 'literal';
}

export type InlineInputClassification =
  | { readonly kind: 'literal' }
  | { readonly kind: 'conversion'; readonly plan: ParserConversionPlan };

export function classifyInlineInput(markdown: string): InlineInputClassification {
  const result = parseBlocks(markdown, { provenance: true });
  const children = result.provenance.output.children ?? [];
  return children.length === 1 &&
    children[0]?.type === 'paragraph' &&
    children[0].content === markdown
    ? { kind: 'literal' }
    : { kind: 'conversion', plan: result.provenance };
}

export function parseMarkdownTree(markdown: string): MarkdownTree {
  const parser = createBlockParser();
  parser.push(markdown);
  return parser.finish();
}

function parseSettledLine(
  state: ReturnType<typeof createInitialState>,
  line: string,
  hadNewline = true,
) {
  if (state.sourceTracking) {
    state.sourceBreakBefore =
      state.sourceOffset > 0
        ? { kind: 'retain', sourceFrom: state.sourceOffset - 1, sourceTo: state.sourceOffset }
        : undefined;
    const mapped: MappedText = sourceText(line, state.sourceOffset);
    parseLine(state, line, mapped);
    state.sourceOffset += line.length + (hadNewline ? 1 : 0);
    state.sourceBreakBefore = undefined;
  } else {
    parseLine(state, line);
  }
}

function conversionPlan(
  output: DocumentNode,
  root: ViewModelNode,
  sourcePieces: ReadonlyMap<ViewModelNode, readonly OutputPiece[]>,
  source: string,
): ParserConversionPlan {
  const inlinePieces: Record<string, readonly OutputPiece[]> = {};
  const retained: { from: number; to: number }[] = [];
  let previousRetainedEnd = 0;
  const walk = (node: ViewModelNode, path: number[]) => {
    if (isInlineNode(node)) {
      const pieces = sourcePieces.get(node);
      if (!pieces)
        throw new Error(`missing parser provenance for inline node at ${path.join('.')}`);
      const reconstructed = pieces
        .map((piece) => {
          if (piece.kind === 'synthesize') return piece.text;
          if (
            piece.sourceFrom < 0 ||
            piece.sourceTo > source.length ||
            piece.sourceTo <= piece.sourceFrom
          ) {
            throw new Error('parser provenance range is outside the input');
          }
          if (piece.sourceFrom < previousRetainedEnd) {
            throw new Error('parser provenance reorders retained input');
          }
          previousRetainedEnd = piece.sourceTo;
          retained.push({ from: piece.sourceFrom, to: piece.sourceTo });
          return source.slice(piece.sourceFrom, piece.sourceTo);
        })
        .join('');
      if (reconstructed !== node.content) {
        throw new Error(`parser provenance does not reconstruct inline node at ${path.join('.')}`);
      }
      inlinePieces[path.join('.') || 'root'] = Object.freeze(
        pieces.map((piece) => Object.freeze({ ...piece })),
      );
    }
    for (const [index, child] of (node.children ?? []).entries()) {
      walk(child as ViewModelNode, [...path, index]);
    }
  };
  walk(root, []);

  const consumed: SourceRange[] = [];
  let cursor = 0;
  for (const range of retained) {
    if (range.from < cursor) throw new Error('parser provenance duplicates retained input');
    if (range.from > cursor) consumed.push({ from: cursor, to: range.from });
    cursor = range.to;
  }
  if (cursor < source.length) consumed.push({ from: cursor, to: source.length });
  return {
    output,
    inlinePieces: Object.freeze(inlinePieces),
    consumed: Object.freeze(consumed.map((range) => Object.freeze(range))),
  };
}
