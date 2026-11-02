import type { MarkdownNode } from './node.js';

export type SemanticNodeId = string;
export type SemanticNodeKind = MarkdownNode['type'];

export interface SemanticDraftNode {
  readonly id: SemanticNodeId;
  readonly type: SemanticNodeKind;
  readonly children: readonly SemanticNodeId[];
  readonly marker: string | null;
  readonly checked: boolean | null;
}

export interface SemanticNormalizationDraft {
  node(id: SemanticNodeId): SemanticDraftNode;
  parentOf(id: SemanticNodeId): SemanticNodeId | undefined;
  previousSiblingOf(id: SemanticNodeId): SemanticNodeId | undefined;
  nextSiblingOf(id: SemanticNodeId): SemanticNodeId | undefined;
  create(spec: { readonly type: SemanticNodeKind; readonly content?: string }): SemanticNodeId;
  place(id: SemanticNodeId, parent: SemanticNodeId, before: SemanticNodeId | null): void;
  detach(id: SemanticNodeId): void;
  setMarker(id: SemanticNodeId, marker: string | null): void;
  setChecked(id: SemanticNodeId, checked: boolean | null): void;
}

export interface SemanticNormalizeOptions {
  readonly preserveEmptyBlocks?: boolean;
}

function walk(draft: SemanticNormalizationDraft, rootId: SemanticNodeId): SemanticNodeId[] {
  const result: SemanticNodeId[] = [];
  const pending = [rootId];
  const seen = new Set<SemanticNodeId>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    pending.push(...draft.node(id).children.toReversed());
  }
  return result;
}

function placeBefore(
  draft: SemanticNormalizationDraft,
  id: SemanticNodeId,
  parent: SemanticNodeId,
  before: SemanticNodeId | null,
): void {
  if (draft.parentOf(id) === parent && draft.nextSiblingOf(id) === (before ?? undefined)) {
    return;
  }
  draft.place(id, parent, before);
}

function moveTrailingNodesIntoSections(
  draft: SemanticNormalizationDraft,
  rootId: SemanticNodeId,
): void {
  for (const parentId of walk(draft, rootId)) {
    let sectionId: SemanticNodeId | undefined;
    for (const childId of Array.from(draft.node(parentId).children)) {
      if (draft.node(childId).type === 'section') {
        sectionId = childId;
      } else if (sectionId) {
        placeBefore(draft, childId, sectionId, null);
      }
    }
  }
}

function normalizeContiguousSections(
  draft: SemanticNormalizationDraft,
  sections: readonly SemanticNodeId[],
): void {
  const activeSections: SemanticNodeId[] = [];
  const contains = (parentId: SemanticNodeId, childId: SemanticNodeId) => {
    const parentParentId = draft.parentOf(parentId);
    return (
      (!draft.previousSiblingOf(parentId) &&
        (!parentParentId || draft.node(parentParentId).type !== 'section')) ||
      (draft.node(childId).marker?.length ?? 0) > (draft.node(parentId).marker?.length ?? 0)
    );
  };

  for (const sectionId of sections) {
    let last: SemanticNodeId | undefined;
    while (activeSections.length && !contains(activeSections.at(-1)!, sectionId)) {
      last = activeSections.pop()!;
      if (!activeSections.length) {
        const lastParent = draft.parentOf(last);
        if (lastParent) {
          placeBefore(draft, sectionId, lastParent, draft.nextSiblingOf(last) ?? null);
        }
      }
    }
    if (activeSections.length && contains(activeSections.at(-1)!, sectionId)) {
      const active = activeSections.at(-1)!;
      if (last && draft.parentOf(last) === active) {
        placeBefore(draft, sectionId, active, draft.nextSiblingOf(last) ?? null);
      } else {
        const nextSection = draft
          .node(active)
          .children.find((child) => draft.node(child).type === 'section');
        placeBefore(draft, sectionId, active, nextSection ?? null);
      }
    }
    activeSections.push(sectionId);
  }
}

function normalizeSections(draft: SemanticNormalizationDraft, rootId: SemanticNodeId): void {
  moveTrailingNodesIntoSections(draft, rootId);
  const ranges = new Map<SemanticNodeId, SemanticNodeId[]>();
  for (const id of walk(draft, rootId)) {
    if (draft.node(id).type !== 'section') continue;
    const previous = draft.previousSiblingOf(id);
    const parent = draft.parentOf(id);
    let range: SemanticNodeId[];
    if (previous && draft.node(previous).type === 'section') {
      range = ranges.get(previous)!;
    } else if (parent && draft.node(parent).type === 'section') {
      range = ranges.get(parent)!;
    } else {
      range = [];
    }
    range.push(id);
    ranges.set(id, range);
  }
  for (const sections of ranges.values()) normalizeContiguousSections(draft, sections);
}

function mergeAdjacent(
  draft: SemanticNormalizationDraft,
  id: SemanticNodeId,
  type: 'list' | 'block-quote',
): void {
  while (true) {
    const next = draft.nextSiblingOf(id);
    if (!next || draft.node(next).type !== type) return;
    for (const child of Array.from(draft.node(next).children)) placeBefore(draft, child, id, null);
    draft.detach(next);
  }
}

function normalizeList(draft: SemanticNormalizationDraft, id: SemanticNodeId): void {
  mergeAdjacent(draft, id, 'list');
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

function emptyContainer(draft: SemanticNormalizationDraft, id: SemanticNodeId): boolean {
  const node = draft.node(id);
  return (
    draft.parentOf(id) !== undefined &&
    node.children.length === 0 &&
    (node.type === 'list-item' || node.type === 'list' || node.type === 'block-quote')
  );
}

/** Applies Grain's one-pass forward normalization to any semantic draft. */
export function normalizeSemanticTree(
  draft: SemanticNormalizationDraft,
  rootId: SemanticNodeId,
  options: SemanticNormalizeOptions = {},
): void {
  normalizeSections(draft, rootId);

  for (const id of walk(draft, rootId)) {
    const type = draft.node(id).type;
    if (type === 'list') normalizeList(draft, id);
    if (type === 'block-quote') mergeAdjacent(draft, id, 'block-quote');
    if (type === 'list-item' && draft.node(id).checked === null) draft.setChecked(id, null);
  }

  if (!options.preserveEmptyBlocks) {
    for (const id of walk(draft, rootId)) {
      if (!emptyContainer(draft, id)) continue;
      let current: SemanticNodeId | undefined = id;
      while (current && emptyContainer(draft, current)) {
        const parent = draft.parentOf(current);
        draft.detach(current);
        current = parent;
      }
    }
  }

  if (draft.node(rootId).children.length === 0) {
    const paragraph = draft.create({ type: 'paragraph', content: '' });
    draft.place(paragraph, rootId, null);
  }
}
