import { assertScopedTarget, isWithinScope } from '../context.js';
import { parseBlocks } from '../../markdown/block-parser/api.js';
import type { MarkdownNode } from '../../markdown/node.js';
import type { NodeId } from '../../markdown/semantic/types.js';
import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import { requireInline, textPoint } from '../operations/inline.js';
import { placeParsedNodes } from '../operations/parsed-content.js';
import { appendChild } from '../operations/placement.js';

function containsSection(nodes: readonly MarkdownNode[]): boolean {
  return nodes.some((node) => node.type === 'section');
}

export interface InsertMarkdownInput {
  readonly contextId: NodeId;
  readonly markdown: string;
  /** Replace an empty active paragraph when paste came from a collapsed caret. */
  readonly replaceActiveEmptyTarget?: boolean;
}

/** Parses clipboard Markdown into copied semantic nodes at the active block. */
export const insertMarkdown: Edit<InsertMarkdownInput> = (
  context,
  { contextId, markdown, replaceActiveEmptyTarget = false },
) => {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, contextId);
  requireInline(draft, contextId);
  const parsed = parseBlocks(markdown + '\n').node;
  let nodes = [...(parsed.children ?? [])];
  if (!nodes.length) return NOT_APPLICABLE;

  const current = draft.node(contextId);
  const hasPastedContent = nodes.some((node) => node.type !== 'paragraph' || node.content !== '');
  const replaceTarget =
    replaceActiveEmptyTarget &&
    hasPastedContent &&
    current.type === 'paragraph' &&
    current.content === '';
  let parentId: NodeId | undefined;
  let beforeId: NodeId | null = null;
  let targetDetached = false;
  let attachAfter:
    | { readonly id: NodeId; readonly parent: NodeId; readonly before: NodeId | null }
    | undefined;
  if (current.type === 'section') {
    parentId = contextId;
    if (containsSection(nodes)) {
      const list = draft.create({ type: 'list' });
      const item = draft.create({ type: 'list-item', marker: '* ' });
      appendChild(draft, item, list);
      parentId = item;
      attachAfter = { id: list, parent: contextId, before: null };
    }
  } else {
    parentId = draft.parentOf(contextId);
    if (!parentId) return NOT_APPLICABLE;
    beforeId = draft.nextSiblingOf(contextId) ?? null;
    if (!beforeId && draft.node(parentId).type === 'list-item') {
      const item = parentId;
      const list = draft.parentOf(item);
      if (item !== scopeRoot && list) {
        parentId = list;
        beforeId = draft.nextSiblingOf(item) ?? null;
        if (replaceTarget && draft.node(item).children.length === 1) {
          draft.detach(contextId);
          draft.detach(item);
          targetDetached = true;
        }
      }
    }
    if (replaceTarget && !targetDetached) draft.detach(contextId);
  }

  const scopeDestination = attachAfter?.parent ?? parentId;
  if (!parentId || !scopeDestination || !isWithinScope(draft, scopeRoot, scopeDestination))
    return NOT_APPLICABLE;
  if (draft.node(parentId).type === 'list') {
    if (nodes.length === 1 && nodes[0]!.type === 'list') {
      nodes = [...(nodes[0]!.children ?? [])];
    } else {
      const item = draft.create({ type: 'list-item', marker: '* ' });
      attachAfter = { id: item, parent: parentId, before: beforeId };
      parentId = item;
      beforeId = null;
    }
  }
  if (!nodes.length) return NOT_APPLICABLE;

  const lastInline = placeParsedNodes(draft, nodes, parentId, beforeId);
  if (attachAfter) draft.place(attachAfter.id, attachAfter.parent, attachAfter.before);
  return handled(
    lastInline
      ? {
          focus: textPoint(draft, lastInline, requireInline(draft, lastInline).content.length),
          selection: { type: 'clear' },
        }
      : { selection: { type: 'clear' } },
  );
};
