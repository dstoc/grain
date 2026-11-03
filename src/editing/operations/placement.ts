import type { TreeDraft } from '../../markdown/semantic/draft.js';
import type { NodeId } from '../../markdown/semantic/types.js';

export function placeBefore(
  draft: TreeDraft,
  nodeId: NodeId,
  parentId: NodeId,
  beforeId: NodeId | null,
): void {
  const currentParent = draft.parentOf(nodeId);
  const next = currentParent === undefined ? undefined : draft.nextSiblingOf(nodeId);
  if (currentParent === parentId && (next ?? null) === beforeId) return;
  if (nodeId === beforeId) return;
  draft.place(nodeId, parentId, beforeId);
}

export function placeAfter(
  draft: TreeDraft,
  nodeId: NodeId,
  parentId: NodeId,
  afterId: NodeId,
): void {
  if (nodeId === afterId) return;
  placeBefore(draft, nodeId, parentId, draft.nextSiblingOf(afterId) ?? null);
}

export function appendChild(draft: TreeDraft, nodeId: NodeId, parentId: NodeId): void {
  const currentParent = draft.parentOf(nodeId);
  if (currentParent === parentId && draft.nextSiblingOf(nodeId) === undefined) return;
  draft.place(nodeId, parentId, null);
}
