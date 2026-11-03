import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import { textPoint } from '../operations/inline.js';
import { normalizeBlockSelection } from '../operations/selection.js';
import { liftSectionChildren } from '../operations/containers.js';
import type { TreeDraft } from '../../markdown/semantic/draft.js';
import {
  isAllowedSemanticChild,
  isInlineNodeKind,
  type NodeId,
} from '../../markdown/semantic/types.js';

export interface DeleteBlocksInput {
  readonly nodeIds: readonly NodeId[];
}

function inlinePreorder(context: Parameters<Edit<DeleteBlocksInput>>[0]): NodeId[] {
  const { draft, scopeRoot } = context;
  const result: NodeId[] = [];
  const pending = [scopeRoot];
  while (pending.length) {
    const nodeId = pending.pop()!;
    const node = draft.node(nodeId);
    if (isInlineNodeKind(node.type)) result.push(nodeId);
    pending.push(...node.children.toReversed());
  }
  return result;
}

function createEmptyCaretTarget(draft: TreeDraft, scopeRoot: NodeId): NodeId {
  let parentId = scopeRoot;
  if (draft.node(scopeRoot).type === 'list') {
    const itemId = draft.node(scopeRoot).children.find((childId) => {
      return draft.node(childId).type === 'list-item';
    });
    if (itemId) {
      parentId = itemId;
    } else {
      parentId = draft.create({ type: 'list-item' });
      draft.place(parentId, scopeRoot, null);
    }
  }

  if (!isAllowedSemanticChild(draft.node(parentId).type, 'paragraph')) {
    throw new Error(`scope ${scopeRoot} cannot contain an empty caret paragraph`);
  }
  const empty = draft.create({ type: 'paragraph', content: '' });
  draft.place(empty, parentId, null);
  return empty;
}

/** Removes selected blocks while preserving section children and choosing a surviving caret. */
export const deleteBlocks: Edit<DeleteBlocksInput> = (context, { nodeIds }) => {
  const { draft, scopeRoot } = context;
  const targets = normalizeBlockSelection(draft, scopeRoot, nodeIds);
  if (targets.length === 0) return NOT_APPLICABLE;

  const selected = new Set(targets);
  const order = inlinePreorder(context);
  const firstTarget = order.findIndex((nodeId) => selected.has(nodeId));
  const previous = order
    .slice(0, firstTarget)
    .toReversed()
    .find((nodeId) => !selected.has(nodeId));
  const next = order.slice(firstTarget + 1).find((nodeId) => !selected.has(nodeId));
  const hasSurvivingInline = order.some((nodeId) => !selected.has(nodeId));
  const scopeType = draft.node(scopeRoot).type;
  if (
    !hasSurvivingInline &&
    scopeType !== 'list' &&
    !isAllowedSemanticChild(scopeType, 'paragraph')
  ) {
    return NOT_APPLICABLE;
  }

  for (const nodeId of targets) {
    const node = draft.node(nodeId);
    if (!draft.parentOf(nodeId)) throw new Error(`cannot remove detached selected block ${nodeId}`);
    if (node.type === 'section') liftSectionChildren(draft, nodeId);
    draft.detach(nodeId);
  }

  let focus: ReturnType<typeof textPoint> | undefined;
  if (previous && draft.parentOf(previous)) {
    focus = textPoint(draft, previous, draft.node(previous).content!.length, 'left');
  } else if (next && draft.parentOf(next)) {
    focus = textPoint(draft, next, 0, 'right');
  } else {
    // Keep an editable caret inside a scoped container so normalization does
    // not remove it from the document outside this command's edit boundary.
    const empty = createEmptyCaretTarget(draft, scopeRoot);
    focus = textPoint(draft, empty, 0, 'right');
  }

  return handled({ focus, selection: { type: 'clear' } });
};
