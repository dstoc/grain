import type { TreeDraft } from '../../markdown/semantic/draft.js';
import type { CreateNodeSpec, NodeId } from '../../markdown/semantic/types.js';
import type { MarkdownNode } from '../../markdown/node.js';
import { isInlineNodeKind } from '../../markdown/semantic/types.js';
import { appendChild, placeBefore } from './placement.js';

export interface InsertedSubtree {
  readonly id: NodeId;
  readonly lastInline?: NodeId;
}

/** Copies parser content into new semantic nodes; it never transfers source identity. */
export function insertParsedSubtree(draft: TreeDraft, node: MarkdownNode): InsertedSubtree {
  const spec: CreateNodeSpec = (() => {
    switch (node.type) {
      case 'document':
        throw new Error('a semantic draft cannot create another root');
      case 'paragraph':
        return { type: 'paragraph', content: node.content };
      case 'section':
        return { type: 'section', content: node.content, marker: node.marker };
      case 'code-block':
        return { type: 'code-block', content: node.content, info: node.info };
      case 'list':
        return { type: 'list' };
      case 'list-item':
        return { type: 'list-item', marker: node.marker, checked: node.checked ?? null };
      case 'block-quote':
        return { type: 'block-quote', marker: node.marker };
    }
  })();
  const id = draft.create(spec);
  let lastInline = isInlineNodeKind(node.type) ? id : undefined;
  for (const child of node.children ?? []) {
    const inserted = insertParsedSubtree(draft, child);
    appendChild(draft, inserted.id, id);
    lastInline = inserted.lastInline ?? lastInline;
  }
  return { id, ...(lastInline ? { lastInline } : {}) };
}

export function placeParsedNodes(
  draft: TreeDraft,
  nodes: readonly MarkdownNode[],
  parentId: NodeId,
  beforeId: NodeId | null,
): NodeId | undefined {
  let lastInline: NodeId | undefined;
  for (const node of nodes) {
    const inserted = insertParsedSubtree(draft, node);
    placeBefore(draft, inserted.id, parentId, beforeId);
    lastInline = inserted.lastInline ?? lastInline;
  }
  return lastInline;
}
