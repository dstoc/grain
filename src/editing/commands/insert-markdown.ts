import { assertScopedTarget, isWithinScope } from '../context.js';
import { parseBlocks } from '../../markdown/block-parser/api.js';
import type { DocumentNode, MarkdownNode } from '../../markdown/node.js';
import type { NodeId } from '../../markdown/semantic/types.js';
import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import { requireInline, textPoint } from '../operations/inline.js';
import { placeParsedNodes } from '../operations/parsed-content.js';
import { appendChild } from '../operations/placement.js';
import { liftSectionChildren } from '../operations/containers.js';
import { normalizeBlockSelection } from '../operations/selection.js';
import {
  ConstructionTree,
  type ConstructionNode,
} from '../../markdown/semantic/construction-tree.js';
import type { TreeDraft } from '../../markdown/semantic/draft.js';
import { walkSemanticTree } from '../../markdown/semantic/queries.js';

function containsSection(nodes: readonly MarkdownNode[]): boolean {
  return nodes.some((node) => node.type === 'section');
}

export interface InsertMarkdownInput {
  readonly contextId: NodeId;
  readonly markdown: string;
  /** Replace an empty active paragraph when paste came from a collapsed caret. */
  readonly replaceActiveEmptyTarget?: boolean;
}

interface ReplacementPlanBase {
  /** The parent that owns the pasted nodes. */
  readonly parentId: NodeId;
  readonly beforeId: NodeId;
  readonly targets: readonly NodeId[];
}

type ReplacementPlan =
  | (ReplacementPlanBase & { readonly kind: 'siblings' })
  | (ReplacementPlanBase & { readonly kind: 'list'; readonly destinationItemId: NodeId });

interface ReplacementResult {
  readonly lastInline: NodeId;
  readonly removedItems: ReadonlySet<NodeId>;
}

function replacementPlan(
  draft: TreeDraft,
  scopeRoot: NodeId,
  nodeIds: readonly NodeId[],
): ReplacementPlan | undefined {
  const targets = normalizeBlockSelection(draft, scopeRoot, nodeIds);
  if (!targets.length || targets.length !== new Set(nodeIds).size) return undefined;

  const parents = targets.map((id) => draft.parentOf(id));
  if (parents.some((id) => id === undefined)) return undefined;
  const firstParent = parents[0]!;
  const sameParent = parents.every((id) => id === firstParent);
  const parentType = draft.node(firstParent).type;

  if (sameParent && parentType !== 'list-item') {
    return { kind: 'siblings', parentId: firstParent, beforeId: targets[0]!, targets };
  }

  const isListContent = targets.every((id) => {
    const type = draft.node(id).type;
    return type === 'paragraph' || type === 'code-block';
  });
  if (!isListContent) return undefined;

  const items = parents as NodeId[];
  if (!items.every((id) => draft.node(id).type === 'list-item')) return undefined;
  const listIds = items.map((id) => draft.parentOf(id));
  if (listIds.some((id) => id === undefined)) return undefined;
  const listId = listIds[0]!;
  if (!listIds.every((id) => id === listId) || draft.node(listId).type !== 'list') return undefined;

  const destinationItemId = items[0]!;
  return {
    kind: 'list',
    parentId: destinationItemId,
    beforeId: targets[0]!,
    targets,
    destinationItemId,
  };
}

function applyReplacement(
  draft: TreeDraft,
  plan: ReplacementPlan,
  parsed: readonly MarkdownNode[],
): ReplacementResult | undefined {
  const lastInline = placeParsedNodes(draft, parsed, plan.parentId, plan.beforeId);
  if (!lastInline) return undefined;

  const selectedItems = new Set<NodeId>();
  for (const id of plan.targets) {
    const node = draft.node(id);
    const parentId = draft.parentOf(id);
    if (!parentId) return undefined;
    if (plan.kind === 'list') selectedItems.add(parentId);
    if (node.type === 'section') liftSectionChildren(draft, id);
    draft.detach(id);
  }

  const removedItems = new Set<NodeId>();
  if (plan.kind === 'list') {
    for (const itemId of selectedItems) {
      if (itemId === plan.destinationItemId || draft.node(itemId).children.length) continue;
      draft.detach(itemId);
      removedItems.add(itemId);
    }
  }

  return { lastInline, removedItems };
}

function copyDraftNode(draft: TreeDraft, id: NodeId): MarkdownNode {
  const node = draft.node(id);
  const children = node.children.map((childId) => copyDraftNode(draft, childId));
  switch (node.type) {
    case 'document':
    case 'list':
      return { type: node.type, children };
    case 'block-quote':
      return { type: node.type, marker: node.marker ?? '> ', children };
    case 'list-item':
      return {
        type: node.type,
        marker: node.marker ?? '- ',
        ...(node.checked == null ? {} : { checked: node.checked }),
        children,
      };
    case 'paragraph':
      return { type: node.type, content: node.content };
    case 'section':
      return {
        type: node.type,
        marker: node.marker ?? '#',
        content: node.content,
        children,
      };
    case 'code-block':
      return { type: node.type, info: node.info, content: node.content };
  }
}

function mapDraftIds(
  draft: TreeDraft,
  sourceId: NodeId,
  copy: ConstructionNode,
  ids: Map<NodeId, NodeId>,
): void {
  ids.set(sourceId, copy.id);
  const children = draft.node(sourceId).children;
  if (children.length !== copy.children.length) throw new Error('preflight tree shape changed');
  children.forEach((childId, index) => mapDraftIds(draft, childId, copy.children[index]!, ids));
}

/**
 * Runs the exact shared normalizer on an isolated semantic copy before changing
 * the canonical draft. This catches section promotion, wrapper merges, and host
 * scope changes that cannot be detected from the immediate insertion siblings.
 */
function replacementIsSafe(
  draft: TreeDraft,
  scopeRoot: NodeId,
  plan: ReplacementPlan,
  parsed: readonly MarkdownNode[],
): boolean {
  try {
    let rootId = scopeRoot;
    while (draft.parentOf(rootId)) rootId = draft.parentOf(rootId)!;
    if (draft.node(rootId).type !== 'document') return false;
    const copiedRoot = copyDraftNode(draft, rootId) as DocumentNode;
    const simulation = new ConstructionTree(copiedRoot);
    const ids = new Map<NodeId, NodeId>();
    mapDraftIds(draft, rootId, simulation.root, ids);

    const scopeCopy = ids.get(scopeRoot);
    if (!scopeCopy) return false;
    const simulationPlan =
      plan.kind === 'list'
        ? {
            ...plan,
            parentId: ids.get(plan.parentId)!,
            beforeId: ids.get(plan.beforeId)!,
            targets: plan.targets.map((id) => ids.get(id)!),
            destinationItemId: ids.get(plan.destinationItemId)!,
          }
        : {
            ...plan,
            parentId: ids.get(plan.parentId)!,
            beforeId: ids.get(plan.beforeId)!,
            targets: plan.targets.map((id) => ids.get(id)!),
          };
    const beforeIds = new Set(ids.values());
    const beforeScope = new Set(walkSemanticTree(simulation.draft, scopeCopy));
    const oldWrappers = [...ids.entries()]
      .filter(([sourceId]) => {
        const type = draft.node(sourceId).type;
        return type === 'list' || type === 'block-quote';
      })
      .map(([, copyId]) => copyId);
    const selected = new Set(simulationPlan.targets);
    const result = applyReplacement(simulation.draft, simulationPlan, parsed);
    if (!result) return false;
    simulation.normalize();

    const afterIds = new Set(walkSemanticTree(simulation.draft, simulation.rootId));
    if (!afterIds.has(scopeCopy)) return false;
    const afterScope = new Set(walkSemanticTree(simulation.draft, scopeCopy));

    if (oldWrappers.some((id) => !afterIds.has(id))) return false;
    for (const oldId of beforeIds) {
      if (selected.has(oldId) || result.removedItems.has(oldId)) continue;
      if (!afterIds.has(oldId) || beforeScope.has(oldId) !== afterScope.has(oldId)) return false;
    }
    for (const id of afterIds) {
      if (!beforeIds.has(id) && !afterScope.has(id)) return false;
    }
    return afterScope.has(result.lastInline);
  } catch {
    return false;
  }
}

/** Parses clipboard Markdown into copied semantic nodes at the active block. */
export const insertMarkdown: Edit<InsertMarkdownInput> = (
  context,
  { contextId, markdown, replaceActiveEmptyTarget = false },
) => {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, contextId);
  requireInline(draft, contextId);
  const parsed = parseBlocks(markdown + '\n').node;
  let nodes = [...(parsed.children ?? [])];
  if (!nodes.length) return NOT_APPLICABLE;

  if (context.selectionBefore && 'nodeIds' in context.selectionBefore) {
    const plan = replacementPlan(draft, scopeRoot, context.selectionBefore.nodeIds);
    if (!plan || !replacementIsSafe(draft, scopeRoot, plan, nodes)) return NOT_APPLICABLE;
    const result = applyReplacement(draft, plan, nodes);
    if (!result) return NOT_APPLICABLE;
    const focus = requireInline(draft, result.lastInline);
    return handled({
      focus: textPoint(draft, result.lastInline, focus.content.length),
      selection: { type: 'clear' },
    });
  }

  const current = draft.node(contextId);
  const hasPastedContent = nodes.some((node) => node.type !== 'paragraph' || node.content !== '');
  const replaceTarget =
    replaceActiveEmptyTarget &&
    hasPastedContent &&
    current.type === 'paragraph' &&
    current.content === '';
  let parentId: NodeId | undefined;
  let beforeId: NodeId | null = null;
  let targetDetached = false;
  let attachAfter:
    | { readonly id: NodeId; readonly parent: NodeId; readonly before: NodeId | null }
    | undefined;
  if (current.type === 'section') {
    parentId = contextId;
    if (containsSection(nodes)) {
      const list = draft.create({ type: 'list' });
      const item = draft.create({ type: 'list-item', marker: '* ' });
      appendChild(draft, item, list);
      parentId = item;
      attachAfter = { id: list, parent: contextId, before: null };
    }
  } else {
    parentId = draft.parentOf(contextId);
    if (!parentId) return NOT_APPLICABLE;
    beforeId = draft.nextSiblingOf(contextId) ?? null;
    if (!beforeId && draft.node(parentId).type === 'list-item') {
      const item = parentId;
      const list = draft.parentOf(item);
      if (item !== scopeRoot && list) {
        parentId = list;
        beforeId = draft.nextSiblingOf(item) ?? null;
        const itemNode = draft.node(item);
        const pastedList = nodes.length === 1 && nodes[0]!.type === 'list';
        if (replaceTarget && itemNode.children.length === 1) {
          if (!pastedList) {
            parentId = item;
            beforeId = null;
          } else if (
            itemNode.type === 'list-item' &&
            itemNode.marker === '* ' &&
            itemNode.checked == null
          ) {
            draft.detach(contextId);
            draft.detach(item);
            targetDetached = true;
          }
        }
      }
    }
    if (replaceTarget && !targetDetached) draft.detach(contextId);
  }

  const scopeDestination = attachAfter?.parent ?? parentId;
  if (!parentId || !scopeDestination || !isWithinScope(draft, scopeRoot, scopeDestination))
    return NOT_APPLICABLE;
  if (draft.node(parentId).type === 'list') {
    if (nodes.length === 1 && nodes[0]!.type === 'list') {
      nodes = [...(nodes[0]!.children ?? [])];
    } else {
      const item = draft.create({ type: 'list-item', marker: '* ' });
      attachAfter = { id: item, parent: parentId, before: beforeId };
      parentId = item;
      beforeId = null;
    }
  }
  if (!nodes.length) return NOT_APPLICABLE;

  const lastInline = placeParsedNodes(draft, nodes, parentId, beforeId);
  if (attachAfter) draft.place(attachAfter.id, attachAfter.parent, attachAfter.before);
  return handled(
    lastInline
      ? {
          focus: textPoint(draft, lastInline, requireInline(draft, lastInline).content.length),
          selection: { type: 'clear' },
        }
      : { selection: { type: 'clear' } },
  );
};
