import { commandDraft } from '../command-draft.js';
import type { TreeDraft } from '../../markdown/semantic/draft.js';
import type { NodeId } from '../../markdown/semantic/types.js';

/** Moves a snapshot of source children in their existing order. */
export function moveChildren(
  draft: TreeDraft,
  sourceId: NodeId,
  parentId: NodeId,
  beforeId: NodeId | null,
): void {
  const children = [...draft.node(sourceId).children];
  commandDraft(draft).liftChildren({
    source: sourceId,
    parent: parentId,
    before: beforeId,
    children,
    removeSource: false,
  });
}

/** Replaces a container with its children and then detaches the empty container. */
export function unwrapContainer(draft: TreeDraft, containerId: NodeId): void {
  const parentId = draft.parentOf(containerId);
  if (!parentId) throw new Error(`cannot unwrap detached container ${containerId}`);
  commandDraft(draft).liftChildren({
    source: containerId,
    parent: parentId,
    before: containerId,
    children: [...draft.node(containerId).children],
    removeSource: true,
  });
}

/** Lifts section blocks while leaving the section heading in place. */
export function liftSectionChildren(draft: TreeDraft, sectionId: NodeId): void {
  const parentId = draft.parentOf(sectionId);
  if (!parentId) throw new Error(`cannot lift children from detached section ${sectionId}`);
  moveChildren(draft, sectionId, parentId, sectionId);
}
