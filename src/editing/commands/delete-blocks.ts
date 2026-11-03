import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import { textPoint } from '../operations/inline.js';
import { normalizeBlockSelection } from '../operations/selection.js';
import { liftSectionChildren } from '../operations/containers.js';
import { isInlineNodeKind, type NodeId } from '../../markdown/semantic/types.js';

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
  } else if (draft.node(scopeRoot).type === 'document') {
    // The shared normalizer also guarantees this sentinel, but creating it here
    // gives the deletion action a stable caret target and undoable identity.
    const empty = draft.create({ type: 'paragraph', content: '' });
    draft.place(empty, scopeRoot, null);
    focus = textPoint(draft, empty, 0, 'right');
  }

  return handled({ focus, selection: { type: 'clear' } });
};
