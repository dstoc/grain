import { commandDraft } from '../command-draft.js';
import type { DraftNode, TreeDraft } from '../../markdown/semantic/draft.js';
import type { TextPoint } from '../../markdown/semantic/selection.js';
import {
  assertTextPoint,
  isInlineNodeKind,
  type NodeId,
  type TextAffinity,
} from '../../markdown/semantic/types.js';

export type InlineDraftNode = Extract<
  DraftNode,
  { readonly type: 'paragraph' | 'section' | 'code-block' }
>;

export function requireInline(draft: TreeDraft, nodeId: NodeId): InlineDraftNode {
  const node = draft.node(nodeId);
  if (node.type !== 'paragraph' && node.type !== 'section' && node.type !== 'code-block') {
    throw new Error(`${node.type} is not an inline node`);
  }
  return node;
}

export function textPoint(
  draft: TreeDraft,
  nodeId: NodeId,
  offset: number,
  affinity: TextAffinity = 'right',
): TextPoint {
  const node = requireInline(draft, nodeId);
  assertTextPoint(node.content, offset, 'text point');
  return Object.freeze({ nodeId, offset, affinity });
}

/** Joins the source lineage into the destination and removes its visible header. */
export function appendInline(draft: TreeDraft, sourceId: NodeId, destinationId: NodeId): TextPoint {
  requireInline(draft, sourceId);
  const at = requireInline(draft, destinationId).content.length;
  commandDraft(draft).joinInline(sourceId, destinationId);
  return textPoint(draft, destinationId, at, 'left');
}

/** Records a flow partition even when the captured side is empty. */
export function splitInlineInto(
  draft: TreeDraft,
  sourceId: NodeId,
  from: number,
  to: number,
  destinationId: NodeId,
  retainedSide: 'left' | 'right' = 'left',
): void {
  requireInline(draft, sourceId);
  requireInline(draft, destinationId);
  commandDraft(draft).splitInline({
    source: sourceId,
    from,
    to,
    destination: destinationId,
    retainedSide,
  });
}

export function previousInline(
  draft: TreeDraft,
  scopeRoot: NodeId,
  nodeId: NodeId,
): NodeId | undefined {
  let current = nodeId;
  while (current !== scopeRoot) {
    const parentId = draft.parentOf(current);
    if (!parentId) throw new Error(`node ${nodeId} is outside edit scope ${scopeRoot}`);
    const previousId = draft.previousSiblingOf(current);
    if (previousId) {
      const pending: { readonly nodeId: NodeId; readonly visit: boolean }[] = [
        { nodeId: previousId, visit: true },
      ];
      while (pending.length) {
        const entry = pending.pop()!;
        const candidateId = entry.nodeId;
        const candidate = draft.node(candidateId);
        if (entry.visit) {
          pending.push({ nodeId: candidateId, visit: false });
          for (const child of candidate.children) pending.push({ nodeId: child, visit: true });
        } else if (isInlineNodeKind(candidate.type)) {
          return candidateId;
        }
      }
    }
    if (isInlineNodeKind(draft.node(parentId).type)) return parentId;
    current = parentId;
  }
  return undefined;
}
