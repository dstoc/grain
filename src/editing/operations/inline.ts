import type { DraftNode, TreeDraft } from '../../markdown/semantic/draft.js';
import type { TextPoint } from '../../markdown/semantic/selection.js';
import {
  assertTextRange,
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

export function moveInlineRange(
  draft: TreeDraft,
  sourceId: NodeId,
  from: number,
  to: number,
  destinationId: NodeId,
  at: number,
  affinity: TextAffinity = 'left',
): void {
  const source = requireInline(draft, sourceId);
  const destination = requireInline(draft, destinationId);
  assertTextRange(source.content, from, to, 'inline transfer range');
  assertTextPoint(destination.content, at, 'inline transfer destination');
  if (from === to) return;
  draft.transferInlineRange({
    source: sourceId,
    from,
    to,
    destination: destinationId,
    at,
    affinity,
  });
}

/** Appends literal source content and returns the destination seam. */
export function appendInline(draft: TreeDraft, sourceId: NodeId, destinationId: NodeId): TextPoint {
  const source = requireInline(draft, sourceId);
  const destination = requireInline(draft, destinationId);
  const at = destination.content.length;
  if (source.content.length) {
    moveInlineRange(draft, sourceId, 0, source.content.length, destinationId, at, 'left');
  }
  return textPoint(draft, destinationId, at, 'left');
}

/** Deletes the requested range, then moves the surviving suffix to a chosen node. */
export function splitInlineInto(
  draft: TreeDraft,
  sourceId: NodeId,
  from: number,
  to: number,
  destinationId: NodeId,
): void {
  const source = requireInline(draft, sourceId);
  requireInline(draft, destinationId);
  assertTextRange(source.content, from, to, 'inline split range');
  if (to > from) draft.spliceText(sourceId, { from, to, insert: '' });
  const afterDelete = requireInline(draft, sourceId).content;
  if (from < afterDelete.length) {
    moveInlineRange(draft, sourceId, from, afterDelete.length, destinationId, 0, 'left');
  }
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
