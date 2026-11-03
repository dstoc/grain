import type { EditContext } from '../context.js';
import { assertScopedTarget, isBlockSelection, isWithinScope } from '../context.js';
import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import { normalizeBlockSelection } from '../operations/selection.js';
import { placeAfter, placeBefore } from '../operations/placement.js';
import { textPoint } from '../operations/inline.js';
import type { NodeId, NodeKind } from '../../markdown/semantic/types.js';

function nearestListItem(context: EditContext, nodeId: NodeId): NodeId | undefined {
  const { draft, scopeRoot } = context;
  let current = nodeId;
  while (current !== scopeRoot) {
    const parent = draft.parentOf(current);
    if (!parent) return undefined;
    if (parent === scopeRoot) return undefined;
    if (draft.node(parent).type === 'list-item') return parent;
    current = parent;
  }
  return undefined;
}

function nextAfter(draft: EditContext['draft'], nodeId: NodeId): NodeId | undefined {
  return draft.nextSiblingOf(nodeId);
}

function makeNestedList(context: EditContext, listItem: NodeId): NodeId {
  const { draft } = context;
  const last = draft.node(listItem).children.at(-1);
  if (last && draft.node(last).type === 'list') return last;
  const nested = draft.create({ type: 'list' });
  draft.place(nested, listItem, null);
  return nested;
}

/** Performs one outdent move without opening another edit runner. */
export function outdentNode(context: EditContext, nodeId: NodeId): boolean {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, nodeId);
  const listItem = nearestListItem(context, nodeId);
  if (!listItem) return false;
  const list = draft.parentOf(listItem);
  if (!list || draft.node(list).type !== 'list') return false;
  const listParent = draft.parentOf(list);
  if (!listParent) return false;
  const listParentType: NodeKind = draft.node(listParent).type;
  const destination = listParentType === 'list-item' ? draft.parentOf(listParent) : listParent;
  if (!destination || !isWithinScope(draft, scopeRoot, destination)) return false;
  const next = nextAfter(draft, listItem);

  if (listParentType === 'list-item') {
    placeAfter(draft, listItem, destination, listParent);
  }

  if (next) {
    let current: NodeId | undefined = next;
    while (current) {
      const nestedList = makeNestedList(context, listItem);
      const after = nextAfter(draft, current);
      draft.place(current, nestedList, null);
      current = after;
    }
  }

  if (listParentType !== 'list-item') {
    const beforeList = nextAfter(draft, list);
    const children = [...draft.node(listItem).children];
    for (const child of children) placeBefore(draft, child, listParent, beforeList ?? null);
    draft.detach(listItem);
  }

  if (draft.node(list).children.length === 0) draft.detach(list);
  return true;
}

export interface OutdentInput {
  readonly nodeId: NodeId;
  readonly nodeIds?: readonly NodeId[];
}

export const outdent: Edit<OutdentInput> = (context, { nodeId, nodeIds = [] }) => {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, nodeId);
  const targets = nodeIds.length ? normalizeBlockSelection(draft, scopeRoot, nodeIds) : [nodeId];
  if (!targets.length) return NOT_APPLICABLE;

  let changed = false;
  for (const target of targets) changed = outdentNode(context, target) || changed;
  if (!changed) return NOT_APPLICABLE;
  const selection = isBlockSelection(context.selectionBefore)
    ? {
        type: 'preserve-block-selection' as const,
        selection: context.selectionBefore,
        restoreOnRedo: true,
      }
    : undefined;
  return handled({
    focus: textPoint(draft, nodeId, 0),
    ...(selection ? { selection } : {}),
  });
};
