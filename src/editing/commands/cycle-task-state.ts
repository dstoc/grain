import type { NodeId } from '../../markdown/semantic/types.js';
import { assertScopedTarget } from '../context.js';
import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';

export interface CycleTaskStateInput {
  readonly nodeId: NodeId;
}

/** Cycles a list item's task state without giving the renderer mutation access. */
export const cycleTaskState: Edit<CycleTaskStateInput> = (context, { nodeId }) => {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, nodeId);
  const node = draft.node(nodeId);
  if (node.type !== 'list-item') return NOT_APPLICABLE;
  draft.setChecked(nodeId, node.checked === true ? null : node.checked === false ? true : false);
  return handled();
};
