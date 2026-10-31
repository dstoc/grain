import { type DocumentNode } from '../node.js';
import { MarkdownTree } from '../view-model.js';

export { type BlockParser, type BlockParserSnapshot } from './types.js';
import { isDefined, pathForNode } from './utils.js';
import { cleanupInactiveEmptyBlocks, removeEmptyRootParagraph } from './cleanup.js';
import { createInitialState, restoreState } from './state.js';
import { parseLine, projectPendingLine, closeLeafBlocks } from './core.js';
import { discardProjectedPendingLine } from './projected-state.js';

import type { BlockParser, BlockParserSnapshot } from './types.js';

export function createBlockParser(snapshot?: BlockParserSnapshot): BlockParser {
  const tree = new MarkdownTree(
    snapshot?.root ?? {
      type: 'document',
      children: [{ type: 'paragraph', content: '' }],
    },
  );
  const state = snapshot ? restoreState(tree, snapshot) : createInitialState(tree);

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
      tree.edit(
        () => {
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
            parseLine(state, pendingText);
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
        sectionStackPaths: state.sectionStack
          .map((node) => pathForNode(state.root, node))
          .filter(isDefined),
      };
    },
  };
}

export function parseBlocks(markdown: string) {
  const parser = createBlockParser();
  parser.push(markdown);
  const blockTree = parser.finish();
  const node = blockTree.serialize() as DocumentNode;
  return { node };
}

export function parseMarkdownTree(markdown: string): MarkdownTree {
  const parser = createBlockParser();
  parser.push(markdown);
  return parser.finish();
}
