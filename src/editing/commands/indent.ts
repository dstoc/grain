import type { EditContext } from '../context.js';
import { assertScopedTarget, isBlockSelection, isWithinScope } from '../context.js';
import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import { normalizeBlockSelection } from '../operations/selection.js';
import { appendChild, placeBefore } from '../operations/placement.js';
import { textPoint } from '../operations/inline.js';
import type { NodeId } from '../../markdown/semantic/types.js';

function indentTarget(context: EditContext, nodeId: NodeId): NodeId {
  const { draft, scopeRoot } = context;
  let target = nodeId;
  let parent = draft.parentOf(target);
  while (parent && parent !== scopeRoot) {
    const type = draft.node(parent).type;
    if (type === 'list-item' || type === 'section') break;
    target = parent;
    parent = draft.parentOf(target);
  }
  return target;
}

/** Performs one indentation move without opening another edit runner. */
export function indentNode(context: EditContext, nodeId: NodeId): boolean {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, nodeId);
  const target = indentTarget(context, nodeId);
  const targetParent = draft.parentOf(target);
  if (!targetParent) return false;

  if (draft.node(targetParent).type === 'list-item') {
    const previousItem = draft.previousSiblingOf(targetParent);
    if (!previousItem) return false;
    if (!isWithinScope(draft, scopeRoot, previousItem)) return false;
    const previousType = draft.node(previousItem).type;
    if (previousType === 'list-item') {
      const last = draft.node(previousItem).children.at(-1);
      let nestedList = last && draft.node(last).type === 'list' ? last : undefined;
      if (!nestedList) {
        nestedList = draft.create({ type: 'list' });
        appendChild(draft, nestedList, previousItem);
      }
      appendChild(draft, targetParent, nestedList);
      return true;
    }
    if (previousType === 'list') {
      appendChild(draft, targetParent, previousItem);
      return true;
    }
    return false;
  }

  const previous = draft.previousSiblingOf(target);
  const listItem = draft.create({ type: 'list-item', marker: '* ' });
  if (previous && draft.node(previous).type === 'list-item') {
    const last = draft.node(previous).children.at(-1);
    let nestedList = last && draft.node(last).type === 'list' ? last : undefined;
    if (!nestedList) {
      nestedList = draft.create({ type: 'list' });
      appendChild(draft, nestedList, previous);
    }
    appendChild(draft, listItem, nestedList);
  } else if (previous && draft.node(previous).type === 'list') {
    appendChild(draft, listItem, previous);
  } else {
    const list = draft.create({ type: 'list' });
    placeBefore(draft, list, targetParent, target);
    appendChild(draft, listItem, list);
  }
  appendChild(draft, target, listItem);
  return true;
}

export interface IndentInput {
  readonly nodeId: NodeId;
  readonly nodeIds?: readonly NodeId[];
}

export const indent: Edit<IndentInput> = (context, { nodeId, nodeIds = [] }) => {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, nodeId);
  const targets = nodeIds.length ? normalizeBlockSelection(draft, scopeRoot, nodeIds) : [nodeId];
  if (!targets.length) return NOT_APPLICABLE;

  let changed = false;
  for (const target of targets) changed = indentNode(context, target) || changed;
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
