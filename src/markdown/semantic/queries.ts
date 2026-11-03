import type { SemanticNormalizationDraft, TreeDraft } from './draft.js';
import type { NodeId, NodeKind } from './types.js';

export function walkSemanticTree(draft: SemanticNormalizationDraft, rootId: NodeId): NodeId[] {
  const result: NodeId[] = [];
  const pending = [rootId];
  const seen = new Set<NodeId>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    pending.push(...draft.node(id).children.toReversed());
  }
  return result;
}

export function requireInline(draft: TreeDraft, id: NodeId) {
  const node = draft.node(id);
  if (node.type !== 'paragraph' && node.type !== 'section' && node.type !== 'code-block') {
    throw new Error(`${node.type} is not an inline node`);
  }
  return node;
}

export function nearestAncestor(
  draft: TreeDraft,
  rootId: NodeId,
  startId: NodeId,
  types: readonly NodeKind[],
): NodeId | undefined {
  let current = startId;
  while (current !== rootId) {
    const parent = draft.parentOf(current);
    if (!parent) return undefined;
    if (parent === rootId) return undefined;
    if (types.includes(draft.node(parent).type)) return parent;
    current = parent;
  }
  return undefined;
}
