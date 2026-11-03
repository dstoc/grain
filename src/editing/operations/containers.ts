import type { TreeDraft } from '../../markdown/semantic/draft.js';
import type { NodeId } from '../../markdown/semantic/types.js';
import { placeBefore } from './placement.js';

/** Moves a snapshot of source children in their existing order. */
export function moveChildren(
  draft: TreeDraft,
  sourceId: NodeId,
  parentId: NodeId,
  beforeId: NodeId | null,
): void {
  const children = [...draft.node(sourceId).children];
  for (const childId of children) placeBefore(draft, childId, parentId, beforeId);
}

/** Replaces a container with its children and then detaches the empty container. */
export function unwrapContainer(draft: TreeDraft, containerId: NodeId): void {
  const parentId = draft.parentOf(containerId);
  if (!parentId) throw new Error(`cannot unwrap detached container ${containerId}`);
  moveChildren(draft, containerId, parentId, containerId);
  draft.detach(containerId);
}

/** Lifts section blocks while leaving the section heading in place. */
export function liftSectionChildren(draft: TreeDraft, sectionId: NodeId): void {
  const parentId = draft.parentOf(sectionId);
  if (!parentId) throw new Error(`cannot lift children from detached section ${sectionId}`);
  moveChildren(draft, sectionId, parentId, sectionId);
}
