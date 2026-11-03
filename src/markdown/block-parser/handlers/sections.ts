import type { ConstructionNode } from '../../semantic/construction-tree.js';
import {
  type BlockParseState,
  type MappedText,
  type ConstructionSectionNode,
  type ConstructionParagraphNode,
} from '../types.js';
import {
  createSemanticNode,
  currentSectionContainer,
  detachSemanticNodeIfAttached,
  placeSemanticNode,
} from '../utils.js';
import { removeEmptyRootParagraph as ensurePlaceholderRemoved } from '../cleanup.js';
import { syncSectionStack, popSectionsToLevel } from '../container-management.js';
import { closeParagraph } from './paragraphs.js';

export function tryPromoteSetextHeading(
  state: BlockParseState,
  line: string,
  container: ConstructionNode,
): boolean {
  const match = /^(=+|-+)\s*$/.exec(line);
  const paragraph = state.currentParagraph;
  if (!match || !paragraph || paragraph.content.includes('\n') || paragraph.parent !== container) {
    return false;
  }

  const parent = paragraph.parent;
  if (!parent || (parent.type !== 'document' && parent.type !== 'section')) {
    return false;
  }

  const level = match[1].startsWith('=') ? 1 : 2;
  closeParagraph(state);
  promoteParagraphToSection(state, paragraph, parent, level);
  return true;
}

export function promoteParagraphToSection(
  state: BlockParseState,
  paragraph: ConstructionParagraphNode,
  parent: ConstructionNode,
  level: number,
) {
  syncSectionStack(state, parent);
  popSectionsToLevel(state, level);

  const container = currentSectionContainer(state);
  const nextSibling = paragraph.nextSibling;
  const section = createSemanticNode(state, {
    type: 'section',
    marker: '#'.repeat(level),
    content: paragraph.content,
  }) as ConstructionSectionNode;
  placeSemanticNode(state, section, container, nextSibling);
  const pieces = state.inlinePieces.get(paragraph);
  if (pieces) state.inlinePieces.set(section, pieces);
  detachSemanticNodeIfAttached(state, paragraph);
  state.inlinePieces.delete(paragraph);
  state.sectionStack.push(section);
  state.sawContent = true;
}

export function parseAtxHeading(
  line: string,
): { level: number; content: string; contentFrom: number } | undefined {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) return;
  return {
    level: match[1].length,
    content: match[2],
    contentFrom: match[0].length - match[2].length,
  };
}

export function openSection(
  state: BlockParseState,
  level: number,
  content: string,
  mapped?: MappedText,
) {
  popSectionsToLevel(state, level);
  const parent = currentSectionContainer(state);
  ensurePlaceholderRemoved(state);
  const section = createSemanticNode(state, {
    type: 'section',
    marker: '#'.repeat(level),
    content,
  }) as ConstructionSectionNode;
  placeSemanticNode(state, section, parent);
  if (mapped) state.inlinePieces.set(section, mapped.pieces);
  state.sectionStack.push(section);
  state.sawContent = true;
}
