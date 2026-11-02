import type { NodeId, NodeKind } from './canonical-model.js';
import type { TreeDraft } from './canonical-actions.js';

function walk(draft: TreeDraft, rootId: NodeId): NodeId[] {
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

function parentOf(draft: TreeDraft, rootId: NodeId, childId: NodeId): NodeId | undefined {
  for (const id of walk(draft, rootId)) {
    if (draft.node(id).children.includes(childId)) return id;
  }
  return undefined;
}

function parentKind(draft: TreeDraft, rootId: NodeId, childId: NodeId): NodeKind | undefined {
  const parent = parentOf(draft, rootId, childId);
  return parent ? draft.node(parent).type : undefined;
}

function siblings(draft: TreeDraft, rootId: NodeId, id: NodeId) {
  const parent = parentOf(draft, rootId, id);
  if (!parent) return { parent: undefined, previous: undefined, next: undefined };
  const children = draft.node(parent).children;
  const index = children.indexOf(id);
  return {
    parent,
    previous: index > 0 ? children[index - 1] : undefined,
    next: children[index + 1],
  };
}

function placeBefore(
  draft: TreeDraft,
  rootId: NodeId,
  id: NodeId,
  parent: NodeId,
  before: NodeId | null,
): void {
  const current = siblings(draft, rootId, id);
  if (current.parent === parent && current.next === (before ?? undefined)) return;
  draft.place(id, parent, before);
}

function moveTrailingNodesIntoSections(draft: TreeDraft, rootId: NodeId): void {
  for (const parentId of walk(draft, rootId)) {
    let section: NodeId | undefined;
    const children = [...draft.node(parentId).children];
    for (const childId of children) {
      if (draft.node(childId).type === 'section') {
        section = childId;
      } else if (section) {
        placeBefore(draft, rootId, childId, section, null);
      }
    }
  }
}

function normalizeContiguousSections(draft: TreeDraft, rootId: NodeId, sections: NodeId[]): void {
  const activeSections: NodeId[] = [];
  const contains = (parentId: NodeId, childId: NodeId) => {
    const previous = siblings(draft, rootId, parentId).previous;
    const parent = draft.node(parentId);
    return (
      (!previous && parentKind(draft, rootId, parentId) !== 'section') ||
      (draft.node(childId).marker?.length ?? 0) > (parent.marker?.length ?? 0)
    );
  };

  for (const sectionId of sections) {
    let last: NodeId | undefined;
    while (activeSections.length && !contains(activeSections.at(-1)!, sectionId)) {
      last = activeSections.pop()!;
      if (!activeSections.length) {
        const lastLocation = siblings(draft, rootId, last);
        if (lastLocation.parent) {
          placeBefore(draft, rootId, sectionId, lastLocation.parent, lastLocation.next ?? null);
        }
      }
    }
    if (activeSections.length && contains(activeSections.at(-1)!, sectionId)) {
      const active = activeSections.at(-1)!;
      if (last && parentOf(draft, rootId, last) === active) {
        const lastLocation = siblings(draft, rootId, last);
        placeBefore(draft, rootId, sectionId, active, lastLocation.next ?? null);
      } else {
        const nextSection = draft
          .node(active)
          .children.find((child) => draft.node(child).type === 'section');
        placeBefore(draft, rootId, sectionId, active, nextSection ?? null);
      }
    }
    activeSections.push(sectionId);
  }
}

function normalizeSections(draft: TreeDraft, rootId: NodeId): void {
  moveTrailingNodesIntoSections(draft, rootId);
  const ranges = new Map<NodeId, NodeId[]>();
  for (const nodeId of walk(draft, rootId)) {
    if (draft.node(nodeId).type !== 'section') continue;
    const { parent, previous } = siblings(draft, rootId, nodeId);
    let range: NodeId[];
    if (previous && draft.node(previous).type === 'section') {
      range = ranges.get(previous)!;
    } else if (parent && draft.node(parent).type === 'section') {
      range = ranges.get(parent)!;
    } else {
      range = [];
    }
    range.push(nodeId);
    ranges.set(nodeId, range);
  }
  for (const sections of ranges.values()) normalizeContiguousSections(draft, rootId, sections);
}

function mergeAdjacent(draft: TreeDraft, rootId: NodeId, id: NodeId, type: 'list' | 'block-quote') {
  while (true) {
    const next = siblings(draft, rootId, id).next;
    if (!next || draft.node(next).type !== type) return;
    const children = [...draft.node(next).children];
    for (const child of children) placeBefore(draft, rootId, child, id, null);
    draft.detach(next);
  }
}

function normalizeList(draft: TreeDraft, rootId: NodeId, id: NodeId): void {
  mergeAdjacent(draft, rootId, id, 'list');
  const first = draft.node(id).children[0];
  if (!first || draft.node(first).type !== 'list-item') return;
  const firstMarker = draft.node(first).marker ?? '';
  const numeric = /^(\d+)([.)])\s*$/.exec(firstMarker);
  let number = numeric ? BigInt(numeric[1]!) : 0n;
  for (const itemId of draft.node(id).children) {
    if (draft.node(itemId).type !== 'list-item') continue;
    const marker = numeric ? `${number++}${numeric[2]} ` : firstMarker;
    if (draft.node(itemId).marker !== marker) draft.setMarker(itemId, marker);
  }
}

function emptyContainer(draft: TreeDraft, rootId: NodeId, id: NodeId): boolean {
  const node = draft.node(id);
  return (
    parentOf(draft, rootId, id) !== undefined &&
    node.children.length === 0 &&
    (node.type === 'list-item' || node.type === 'list' || node.type === 'block-quote')
  );
}

/** Applies Grain's one-pass forward normalization to a disposable edit draft. */
export function normalizeCanonicalDraft(draft: TreeDraft, rootId: NodeId): void {
  normalizeSections(draft, rootId);

  for (const id of walk(draft, rootId)) {
    const type = draft.node(id).type;
    if (type === 'list') normalizeList(draft, rootId, id);
    if (type === 'block-quote') mergeAdjacent(draft, rootId, id, 'block-quote');
    if (type === 'list-item' && draft.node(id).checked === null) draft.setChecked(id, null);
  }

  for (const id of walk(draft, rootId)) {
    if (!emptyContainer(draft, rootId, id)) continue;
    let current: NodeId | undefined = id;
    while (current && emptyContainer(draft, rootId, current)) {
      const parent = parentOf(draft, rootId, current);
      draft.detach(current);
      current = parent;
    }
  }

  if (draft.node(rootId).children.length === 0) {
    const paragraph = draft.create({ type: 'paragraph', content: '' });
    draft.place(paragraph, rootId, null);
  }
}
