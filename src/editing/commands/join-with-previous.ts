import { assertScopedTarget } from '../context.js';
import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import { appendInline, previousInline, requireInline } from '../operations/inline.js';
import { liftSectionChildren } from '../operations/containers.js';
import type { NodeId } from '../../markdown/semantic/types.js';

export interface JoinWithPreviousInput {
  readonly nodeId: NodeId;
}

export const joinWithPrevious: Edit<JoinWithPreviousInput> = (context, { nodeId }) => {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, nodeId);
  requireInline(draft, nodeId);
  const targetId = previousInline(draft, scopeRoot, nodeId);
  if (!targetId) return NOT_APPLICABLE;
  const source = requireInline(draft, nodeId);
  const parent = draft.parentOf(nodeId);
  if (source.type === 'section' && parent) liftSectionChildren(draft, nodeId);
  const seam = appendInline(draft, nodeId, targetId);
  return handled({ focus: seam });
};
