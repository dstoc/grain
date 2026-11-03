import { assertScopedTarget } from '../context.js';
import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import { requireInline, textPoint } from '../operations/inline.js';
import { placeBefore } from '../operations/placement.js';
import type { NodeId } from '../../markdown/semantic/types.js';

export interface WrapInput {
  readonly nodeId: NodeId;
  readonly wrapper: 'block-quote' | 'list-item';
}

export const wrap: Edit<WrapInput> = (context, { nodeId, wrapper }) => {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, nodeId);
  const node = requireInline(draft, nodeId);
  const parent = draft.parentOf(nodeId);
  if (!parent) return NOT_APPLICABLE;
  if (wrapper === 'block-quote') {
    const quote = draft.create({ type: 'block-quote', marker: '> ' });
    placeBefore(draft, quote, parent, nodeId);
    draft.place(nodeId, quote, null);
  } else {
    const list = draft.create({ type: 'list' });
    const item = draft.create({ type: 'list-item', marker: '* ' });
    placeBefore(draft, list, parent, nodeId);
    draft.place(item, list, null);
    draft.place(nodeId, item, null);
  }
  return handled({ focus: textPoint(draft, nodeId, node.content.length) });
};
