import { commandDraft } from '../command-draft.js';
import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import { requireInline, textPoint } from '../operations/inline.js';
import { normalizeBlockSelection } from '../operations/selection.js';
import { liftSectionChildren } from '../operations/containers.js';
import type { NodeId } from '../../markdown/semantic/types.js';

export interface ReplaceBlocksInput {
  readonly nodeIds: readonly NodeId[];
  readonly text: string;
}

export const replaceBlocks: Edit<ReplaceBlocksInput> = (context, { nodeIds, text }) => {
  const { draft, scopeRoot } = context;
  const targets = normalizeBlockSelection(draft, scopeRoot, nodeIds);
  const [first, ...rest] = targets;
  if (!first) return NOT_APPLICABLE;
  const firstNode = requireInline(draft, first);
  draft.spliceText(first, { from: 0, to: firstNode.content.length, insert: text });
  for (const nodeId of rest) {
    const node = requireInline(draft, nodeId);
    const parent = draft.parentOf(nodeId);
    if (!parent) throw new Error(`cannot remove detached selected block ${nodeId}`);
    if (node.type === 'section') liftSectionChildren(draft, nodeId);
    commandDraft(draft).deleteSubtree(nodeId);
  }
  return handled({
    focus: textPoint(draft, first, text.length),
    selection: { type: 'clear' },
  });
};
