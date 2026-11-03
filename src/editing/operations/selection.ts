import type { TreeDraft } from '../../markdown/semantic/draft.js';
import { assertScopedTarget } from '../context.js';
import { isInlineNodeKind, type NodeId } from '../../markdown/semantic/types.js';

/**
 * Orders unique inline targets with one scoped preorder walk. Selected section
 * headings and their selected inline descendants remain separate targets.
 */
export function normalizeBlockSelection(
  draft: TreeDraft,
  scopeRoot: NodeId,
  selection: Iterable<NodeId>,
): NodeId[] {
  const selected = new Set<NodeId>();
  for (const nodeId of selection) {
    assertScopedTarget(draft, scopeRoot, nodeId);
    selected.add(nodeId);
  }
  if (!selected.size) return [];

  const ordered: NodeId[] = [];
  const pending = [scopeRoot];
  while (pending.length) {
    const nodeId = pending.pop()!;
    const node = draft.node(nodeId);
    if (selected.has(nodeId) && isInlineNodeKind(node.type)) ordered.push(nodeId);
    pending.push(...node.children.toReversed());
  }
  return ordered;
}
