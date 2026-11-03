import type { TreeDraft } from '../markdown/semantic/draft.js';
import type { BlockSelection, EditSelection } from '../markdown/semantic/selection.js';
import type { NodeId } from '../markdown/semantic/types.js';

export interface EditContext {
  readonly draft: TreeDraft;
  readonly scopeRoot: NodeId;
  readonly selectionBefore?: EditSelection;
}

export function assertInScope(draft: TreeDraft, scopeRoot: NodeId, nodeId: NodeId): void {
  let current = nodeId;
  while (current !== scopeRoot) {
    const parent = draft.parentOf(current);
    if (!parent) throw new Error(`node ${nodeId} is outside edit scope ${scopeRoot}`);
    current = parent;
  }
}

export function assertScopedTarget(draft: TreeDraft, scopeRoot: NodeId, nodeId: NodeId): void {
  assertInScope(draft, scopeRoot, nodeId);
  if (nodeId === scopeRoot) throw new Error(`scope root ${scopeRoot} cannot be an edit target`);
}

export function isBlockSelection(
  selection: EditSelection | undefined,
): selection is BlockSelection {
  return selection !== undefined && 'nodeIds' in selection;
}
