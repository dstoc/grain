import { assertScopedTarget } from '../context.js';
import { handled, type Edit } from '../outcomes.js';
import type { NodeId } from '../../markdown/semantic/types.js';
import { requireInline, textPoint } from '../operations/inline.js';

export interface InsertTextInput {
  readonly nodeId: NodeId;
  readonly from: number;
  readonly to?: number;
  readonly text: string;
}
/** Literal input, including a code block's Enter, uses explicit document text edits. */
export const insertText: Edit<InsertTextInput> = (
  { draft, scopeRoot },
  { nodeId, from, to = from, text },
) => {
  assertScopedTarget(draft, scopeRoot, nodeId);
  requireInline(draft, nodeId);
  draft.spliceText(nodeId, { from, to, insert: text });
  return handled({ focus: textPoint(draft, nodeId, from + text.length) });
};
