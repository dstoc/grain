import type { ActionFocus, Bookmark, TreeDraft } from '../markdown/canonical-actions.js';
import type { NodeId, NodeKind } from '../markdown/canonical-model.js';

const INLINE_KINDS = new Set<NodeKind>(['paragraph', 'section', 'code-block']);

function walk(draft: TreeDraft, root: NodeId): NodeId[] {
  const result: NodeId[] = [];
  const pending = [root];
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

function parentOf(draft: TreeDraft, root: NodeId, child: NodeId): NodeId | undefined {
  return walk(draft, root).find((id) => draft.node(id).children.includes(child));
}

function siblings(draft: TreeDraft, root: NodeId, id: NodeId) {
  const parent = parentOf(draft, root, id);
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
  root: NodeId,
  id: NodeId,
  parent: NodeId,
  before: NodeId | null,
) {
  const current = siblings(draft, root, id);
  if (current.parent === parent && current.next === (before ?? undefined)) return;
  draft.place(id, parent, before);
}

function inline(draft: TreeDraft, id: NodeId) {
  const node = draft.node(id);
  if (!INLINE_KINDS.has(node.type) || node.content === undefined)
    throw new Error(`${node.type} is not an inline node`);
  return node;
}

function focus(
  draft: TreeDraft,
  nodeId: NodeId,
  offset: number,
  affinity: 'left' | 'right' = 'right',
) {
  const content = inline(draft, nodeId).content ?? '';
  const clamped = Math.max(0, Math.min(content.length, offset));
  return draft.bookmark(nodeId, clamped, affinity);
}

function focusResult(start: Bookmark | undefined, end: Bookmark | undefined): ActionFocus {
  return Object.freeze({ ...(start ? { start } : {}), ...(end ? { end } : {}) });
}

function nearestAncestor(
  draft: TreeDraft,
  root: NodeId,
  start: NodeId,
  types: readonly NodeKind[],
): NodeId | undefined {
  let current = start;
  while (current !== root) {
    const parent = parentOf(draft, root, current);
    if (!parent) return undefined;
    if (types.includes(draft.node(parent).type)) return parent;
    current = parent;
  }
  return undefined;
}

function descendantsAfter(
  draft: TreeDraft,
  root: NodeId,
  nodeId: NodeId,
  ancestorId: NodeId,
): NodeId[] {
  const result: NodeId[] = [];
  let current = nodeId;
  while (current !== ancestorId) {
    const parent = parentOf(draft, root, current);
    if (!parent) return result;
    const items = draft.node(parent).children;
    const index = items.indexOf(current);
    result.push(...items.slice(index + 1));
    current = parent;
  }
  return result;
}

function markerOf(draft: TreeDraft, id: NodeId): string {
  return draft.node(id).marker ?? '';
}

function nextAfter(draft: TreeDraft, root: NodeId, id: NodeId): NodeId | undefined {
  return siblings(draft, root, id).next;
}

function indentTarget(draft: TreeDraft, root: NodeId, nodeId: NodeId): NodeId {
  let target = nodeId;
  let parent = parentOf(draft, root, target);
  while (parent) {
    const type = draft.node(parent).type;
    if (type === 'list-item' || type === 'document' || type === 'section') break;
    target = parent;
    parent = parentOf(draft, root, target);
  }
  return target;
}

export function indentDraftNode(draft: TreeDraft, root: NodeId, nodeId: NodeId): void {
  const target = indentTarget(draft, root, nodeId);
  const targetParent = parentOf(draft, root, target);
  if (!targetParent) return;

  if (draft.node(targetParent).type === 'list-item') {
    const listItem = targetParent;
    const previous = siblings(draft, root, listItem).previous;
    if (previous && draft.node(previous).type === 'list-item') {
      const last = draft.node(previous).children.at(-1);
      let nestedList = last && draft.node(last).type === 'list' ? last : undefined;
      if (!nestedList) {
        nestedList = draft.create({ type: 'list' });
        draft.place(nestedList, previous, null);
      }
      draft.place(listItem, nestedList, null);
    } else if (previous && draft.node(previous).type === 'list') {
      draft.place(listItem, previous, null);
    }
    return;
  }

  const previous = siblings(draft, root, target).previous;
  const listItem = draft.create({ type: 'list-item', marker: '* ' });
  if (previous && draft.node(previous).type === 'list-item') {
    const last = draft.node(previous).children.at(-1);
    let nestedList = last && draft.node(last).type === 'list' ? last : undefined;
    if (!nestedList) {
      nestedList = draft.create({ type: 'list' });
      draft.place(nestedList, previous, null);
    }
    draft.place(listItem, nestedList, null);
  } else if (previous && draft.node(previous).type === 'list') {
    draft.place(listItem, previous, null);
  } else {
    const list = draft.create({ type: 'list' });
    placeBefore(draft, root, list, targetParent, target);
    draft.place(listItem, list, null);
  }
  draft.place(target, listItem, null);
}

export function unindentDraftNode(draft: TreeDraft, root: NodeId, nodeId: NodeId): void {
  const listItem = nearestAncestor(draft, root, nodeId, ['list-item']);
  if (!listItem) return;
  const next = nextAfter(draft, root, listItem);
  const list = parentOf(draft, root, listItem);
  if (!list || draft.node(list).type !== 'list') return;
  const listParent = parentOf(draft, root, list);
  if (!listParent) return;
  const listParentType = draft.node(listParent).type;

  if (listParentType === 'list-item') {
    const grandparent = parentOf(draft, root, listParent);
    if (grandparent) {
      const before = nextAfter(draft, root, listParent) ?? null;
      placeBefore(draft, root, listItem, grandparent, before);
    }
  }

  if (next) {
    let current: NodeId | undefined = next;
    while (current) {
      let nestedList = draft.node(listItem).children.at(-1);
      if (!nestedList || draft.node(nestedList).type !== 'list') {
        nestedList = draft.create({ type: 'list' });
        draft.place(nestedList, listItem, null);
      }
      const after = nextAfter(draft, root, current);
      draft.place(current, nestedList, null);
      current = after;
    }
  }

  if (listParentType !== 'list-item') {
    const beforeList = nextAfter(draft, root, list);
    const children = [...draft.node(listItem).children];
    for (const child of children) {
      placeBefore(draft, root, child, listParent, beforeList ?? null);
    }
    draft.detach(listItem);
  }

  if (draft.node(list).children.length === 0) draft.detach(list);
}

function removeNodePreservingChildren(draft: TreeDraft, root: NodeId, nodeId: NodeId): void {
  const node = draft.node(nodeId);
  const parent = parentOf(draft, root, nodeId);
  if (!parent) return;
  if (node.type === 'section') {
    const children = [...node.children];
    for (const child of children) placeBefore(draft, root, child, parent, nodeId);
  }
  draft.detach(nodeId);
}

function splitTail(
  draft: TreeDraft,
  sourceId: NodeId,
  start: number,
  end: number,
  destinationId: NodeId,
): void {
  if (end > start) draft.spliceText(sourceId, { from: start, to: end, insert: '' });
  const after = inline(draft, sourceId).content ?? '';
  const tailStart = Math.min(start, after.length);
  if (tailStart < after.length) {
    draft.transferInlineRange({
      source: sourceId,
      from: tailStart,
      to: after.length,
      destination: destinationId,
      at: 0,
      affinity: 'left',
    });
  }
}

function splitSiblingParagraph(
  draft: TreeDraft,
  root: NodeId,
  nodeId: NodeId,
  start: number,
  end: number,
): { readonly paragraphId: NodeId; readonly focusId: NodeId; readonly focusOffset: number } {
  const node = inline(draft, nodeId);
  const parent = parentOf(draft, root, nodeId);
  if (!parent) throw new Error('cannot split a detached inline node');
  const paragraph = draft.create({ type: 'paragraph', content: '' });

  if (node.type === 'section' && start === 0) {
    placeBefore(draft, root, paragraph, parent, nodeId);
    if (end > start) draft.spliceText(nodeId, { from: start, to: end, insert: '' });
    return { paragraphId: paragraph, focusId: paragraph, focusOffset: 0 };
  }

  if (node.type === 'section') {
    const firstChild = draft.node(nodeId).children[0];
    draft.place(paragraph, nodeId, firstChild ?? null);
  } else {
    placeBefore(draft, root, paragraph, parent, nextAfter(draft, root, nodeId) ?? null);
  }

  const shouldKeepOriginalOnRight = start === 0 && node.content!.length > 0;
  if (shouldKeepOriginalOnRight) {
    if (end > start) draft.spliceText(nodeId, { from: start, to: end, insert: '' });
    placeBefore(draft, root, paragraph, parent, nodeId);
    return {
      paragraphId: paragraph,
      focusId: end > start ? nodeId : paragraph,
      focusOffset: 0,
    };
  }

  splitTail(draft, nodeId, start, end, paragraph);
  return { paragraphId: paragraph, focusId: paragraph, focusOffset: 0 };
}

function splitEmptyContainer(draft: TreeDraft, root: NodeId, nodeId: NodeId): NodeId | undefined {
  const node = inline(draft, nodeId);
  if (node.type !== 'paragraph' || node.content !== '') return undefined;
  const ancestor = nearestAncestor(draft, root, nodeId, ['list-item', 'block-quote']);
  if (!ancestor || ancestor === root) return undefined;
  const parent = parentOf(draft, root, ancestor);
  if (!parent) return undefined;
  const type = draft.node(ancestor).type;
  const tail = descendantsAfter(draft, root, nodeId, ancestor);
  let target = nodeId;

  if (type === 'list-item') {
    const nextItem = draft.create({ type: 'list-item', marker: markerOf(draft, ancestor) });
    placeBefore(draft, root, nextItem, parent, nextAfter(draft, root, ancestor) ?? null);
    draft.place(nodeId, nextItem, null);
    target = nextItem;
  } else {
    placeBefore(draft, root, nodeId, parent, nextAfter(draft, root, ancestor) ?? null);
  }

  if (tail.length) {
    const tailWrapper =
      type === 'list-item'
        ? draft.create({ type: 'list-item', marker: markerOf(draft, ancestor) })
        : draft.create({ type: 'block-quote', marker: markerOf(draft, ancestor) });
    placeBefore(draft, root, tailWrapper, parent, nextAfter(draft, root, target) ?? null);
    for (const child of tail) {
      if (parentOf(draft, root, child)) draft.place(child, tailWrapper, null);
    }
  }
  return nodeId;
}

function splitParagraphInSimpleList(
  draft: TreeDraft,
  root: NodeId,
  nodeId: NodeId,
  start: number,
  end: number,
): NodeId | undefined {
  const item = parentOf(draft, root, nodeId);
  if (!item || draft.node(item).type !== 'list-item') return undefined;
  const list = parentOf(draft, root, item);
  if (!list || draft.node(list).type !== 'list') return undefined;
  const node = inline(draft, nodeId);
  const next = nextAfter(draft, root, nodeId);
  if (
    node.type !== 'paragraph' ||
    node.content!.length === 0 ||
    (draft.node(item).children.length !== 1 && (!next || draft.node(next).type !== 'list'))
  ) {
    return undefined;
  }

  let targetList: NodeId;
  let beforeItem: NodeId | null;
  if (next && draft.node(next).type === 'list') {
    targetList = next;
    beforeItem = draft.node(targetList).children[0] ?? null;
  } else if (next) {
    targetList = draft.create({ type: 'list' });
    placeBefore(draft, root, targetList, item, next);
    beforeItem = null;
  } else {
    targetList = list;
    beforeItem = nextAfter(draft, root, item) ?? null;
  }

  const first = draft.node(targetList).children[0];
  const newItem = draft.create({
    type: 'list-item',
    marker: first ? markerOf(draft, first) : '* ',
  });
  placeBefore(draft, root, newItem, targetList, beforeItem);
  const previousItem = siblings(draft, root, newItem).previous;
  if (
    previousItem &&
    draft.node(previousItem).type === 'list-item' &&
    draft.node(previousItem).checked !== null
  )
    draft.setChecked(newItem, false);
  const paragraph = draft.create({ type: 'paragraph', content: '' });
  draft.place(paragraph, newItem, null);

  if (start === 0 && node.content!.length > 0) {
    const oldLocation = siblings(draft, root, nodeId);
    const newLocation = siblings(draft, root, paragraph);
    if (!oldLocation.parent || !newLocation.parent) throw new Error('list split lost a parent');
    if (end > 0) draft.spliceText(nodeId, { from: 0, to: end, insert: '' });
    const oldBefore = oldLocation.next ?? null;
    const newBefore = newLocation.next ?? null;
    placeBefore(draft, root, nodeId, newLocation.parent, newBefore);
    placeBefore(draft, root, paragraph, oldLocation.parent, oldBefore);
    return end > 0 ? nodeId : paragraph;
  }

  splitTail(draft, nodeId, start, end, paragraph);
  return paragraph;
}

export function insertParagraph(
  draft: TreeDraft,
  root: NodeId,
  nodeId: NodeId,
  start: number,
  end = start,
): ActionFocus | undefined {
  const node = inline(draft, nodeId);
  const length = node.content!.length;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > length
  )
    throw new Error('paragraph split range is out of bounds');
  const startBookmark = focus(draft, nodeId, start, 'left');

  const parent = parentOf(draft, root, nodeId);
  if (
    node.type === 'paragraph' &&
    length === 0 &&
    parent &&
    draft.node(parent).type === 'list-item' &&
    parent !== root &&
    draft.node(parent).children.length === 1
  ) {
    const list = parentOf(draft, root, parent);
    const listParent = list ? parentOf(draft, root, list) : undefined;
    const firstMarker =
      list && draft.node(list).children[0] === parent ? markerOf(draft, parent) : undefined;
    const next = siblings(draft, root, parent).next;
    const promoteToParent = !!listParent && draft.node(listParent).type !== 'list-item';
    unindentDraftNode(draft, root, nodeId);
    const orderedMarker = firstMarker && /^(\d+)([.)])\s*$/.exec(firstMarker);
    if (promoteToParent && next && orderedMarker) {
      let number = BigInt(orderedMarker[1]!);
      const delimiter = orderedMarker[2]!;
      const markerPattern = new RegExp(`^\\d+\\${delimiter}\\s*$`);
      let item: NodeId | undefined = next;
      while (
        item &&
        draft.node(item).type === 'list-item' &&
        markerPattern.test(markerOf(draft, item))
      ) {
        draft.setMarker(item, `${number++}${delimiter} `);
        item = nextAfter(draft, root, item);
      }
    }
    return focusResult(startBookmark, focus(draft, nodeId, 0));
  }

  const emptySplit = splitEmptyContainer(draft, root, nodeId);
  if (emptySplit) return focusResult(startBookmark, focus(draft, nodeId, 0));

  const listParagraph = splitParagraphInSimpleList(draft, root, nodeId, start, end);
  if (listParagraph) return focusResult(startBookmark, focus(draft, listParagraph, 0));

  const result = splitSiblingParagraph(draft, root, nodeId, start, end);
  return focusResult(startBookmark, focus(draft, result.focusId, result.focusOffset));
}

export function insertLineBreak(
  draft: TreeDraft,
  root: NodeId,
  nodeId: NodeId,
  start: number,
  end = start,
): ActionFocus | undefined {
  const node = inline(draft, nodeId);
  if (node.type !== 'code-block') {
    const result = splitSiblingParagraph(draft, root, nodeId, start, start);
    return focusResult(
      focus(draft, nodeId, start, 'left'),
      focus(draft, result.focusId, result.focusOffset),
    );
  }
  const length = node.content!.length;
  if (start < 0 || end < start || end > length)
    throw new Error('code split range is out of bounds');
  const startBookmark = focus(draft, nodeId, start, 'left');
  if (start === 0 || start === length) {
    const result = splitSiblingParagraph(draft, root, nodeId, start, end);
    return focusResult(startBookmark, focus(draft, result.focusId, result.focusOffset));
  }
  const parent = parentOf(draft, root, nodeId);
  if (!parent) throw new Error('cannot split a detached code block');
  const paragraph = draft.create({ type: 'paragraph', content: '' });
  const trailing = draft.create({ type: 'code-block', info: node.info, content: '' });
  placeBefore(draft, root, paragraph, parent, nextAfter(draft, root, nodeId) ?? null);
  placeBefore(draft, root, trailing, parent, nextAfter(draft, root, paragraph) ?? null);
  splitTail(draft, nodeId, start, end, trailing);
  return focusResult(startBookmark, focus(draft, paragraph, 0));
}

function previousInline(draft: TreeDraft, root: NodeId, nodeId: NodeId): NodeId | undefined {
  const editable = walk(draft, root).filter((id) => INLINE_KINDS.has(draft.node(id).type));
  const index = editable.indexOf(nodeId);
  return index > 0 ? editable[index - 1] : undefined;
}

function previousInlineWithin(
  draft: TreeDraft,
  containerId: NodeId,
  nodeId: NodeId,
): NodeId | undefined {
  const editable = walk(draft, containerId).filter((id) => INLINE_KINDS.has(draft.node(id).type));
  const index = editable.indexOf(nodeId);
  return index > 0 ? editable[index - 1] : undefined;
}

function mergeInline(draft: TreeDraft, root: NodeId, sourceId: NodeId, targetId: NodeId): void {
  const source = inline(draft, sourceId);
  const target = inline(draft, targetId);
  const at = target.content!.length;
  const parent = parentOf(draft, root, sourceId);
  if (source.type === 'section' && parent) {
    const children = [...draft.node(sourceId).children];
    for (const child of children) placeBefore(draft, root, child, parent, sourceId);
  }
  if (source.content!.length) {
    draft.transferInlineRange({
      source: sourceId,
      from: 0,
      to: source.content!.length,
      destination: targetId,
      at,
      affinity: 'left',
    });
  }
  draft.detach(sourceId);
}

export function deleteContentBackwards(
  draft: TreeDraft,
  root: NodeId,
  nodeId: NodeId,
): ActionFocus | undefined {
  const node = inline(draft, nodeId);
  const startBookmark = focus(draft, nodeId, 0, 'left');

  if (node.type === 'section') {
    const marker = node.marker ?? '';
    const nextMarker = marker.slice(0, -1);
    if (nextMarker !== '') {
      draft.setMarker(nodeId, nextMarker);
      return focusResult(startBookmark, focus(draft, nodeId, 0));
    }
    const parent = parentOf(draft, root, nodeId);
    if (!parent) return undefined;
    const children = [...draft.node(nodeId).children];
    for (const child of children) placeBefore(draft, root, child, parent, nodeId);
    draft.convertInline(nodeId, { type: 'paragraph', content: { mode: 'preserve' } });
    if (children.length) placeBefore(draft, root, nodeId, parent, children[0]!);
    return focusResult(startBookmark, focus(draft, nodeId, 0));
  }

  if (node.type === 'code-block') {
    draft.convertInline(nodeId, { type: 'paragraph', content: { mode: 'preserve' } });
    return focusResult(startBookmark, focus(draft, nodeId, 0));
  }

  const quote = nearestAncestor(draft, root, nodeId, ['block-quote']);
  if (quote) {
    const target = previousInlineWithin(draft, quote, nodeId);
    if (target) {
      const offset = inline(draft, target).content!.length;
      mergeInline(draft, root, nodeId, target);
      return focusResult(startBookmark, focus(draft, target, offset));
    }
    const parent = parentOf(draft, root, quote);
    if (parent) {
      const children = [...draft.node(quote).children];
      for (const child of children) placeBefore(draft, root, child, parent, quote);
      draft.detach(quote);
      return focusResult(startBookmark, focus(draft, nodeId, 0));
    }
  }

  const previous = previousInline(draft, root, nodeId);
  if (previous) {
    const target = inline(draft, previous);
    const offset = target.content!.length;
    mergeInline(draft, root, nodeId, previous);
    return focusResult(startBookmark, focus(draft, previous, offset));
  }

  const listItem = nearestAncestor(draft, root, nodeId, ['list-item']);
  const list = listItem ? parentOf(draft, root, listItem) : undefined;
  if (
    listItem &&
    list &&
    draft.node(list).type === 'list' &&
    siblings(draft, root, listItem).previous === undefined &&
    parentOf(draft, root, list) === root
  ) {
    const children = [...draft.node(listItem).children];
    for (const child of children) placeBefore(draft, root, child, root, list);
    draft.detach(listItem);
    if (draft.node(list).children.length === 0) draft.detach(list);
    return focusResult(startBookmark, focus(draft, nodeId, 0));
  }
  return undefined;
}

export function editIndent(
  draft: TreeDraft,
  root: NodeId,
  nodeId: NodeId,
  mode: 'indent' | 'unindent',
  selection: readonly NodeId[] = [],
): ActionFocus | undefined {
  const target = selection.length ? selection : [nodeId];
  const start = focus(draft, nodeId, 0, 'left');
  for (const id of target) {
    if (mode === 'indent') indentDraftNode(draft, root, id);
    else unindentDraftNode(draft, root, id);
  }
  return focusResult(start, focus(draft, nodeId, 0));
}

export function wrapInline(
  draft: TreeDraft,
  root: NodeId,
  nodeId: NodeId,
  wrapper: 'block-quote' | 'list-item',
): ActionFocus | undefined {
  const node = inline(draft, nodeId);
  const start = focus(draft, nodeId, 0, 'left');
  const parent = parentOf(draft, root, nodeId);
  if (!parent) return undefined;
  if (wrapper === 'block-quote') {
    const quote = draft.create({ type: 'block-quote', marker: '> ' });
    placeBefore(draft, root, quote, parent, nodeId);
    draft.place(nodeId, quote, null);
  } else {
    const list = draft.create({ type: 'list' });
    const item = draft.create({ type: 'list-item', marker: '* ' });
    placeBefore(draft, root, list, parent, nodeId);
    draft.place(item, list, null);
    draft.place(nodeId, item, null);
  }
  return focusResult(start, focus(draft, nodeId, node.content!.length));
}

function documentOrderSelection(draft: TreeDraft, root: NodeId, selection: Iterable<NodeId>) {
  const selected = new Set(selection);
  return walk(draft, root).filter(
    (id) => selected.has(id) && INLINE_KINDS.has(draft.node(id).type),
  );
}

export function replaceSelectedBlocks(
  draft: TreeDraft,
  root: NodeId,
  selection: Iterable<NodeId>,
  text: string,
): ActionFocus | undefined {
  const [first, ...rest] = documentOrderSelection(draft, root, selection);
  if (!first) return undefined;
  const firstNode = inline(draft, first);
  const start = focus(draft, first, 0, 'left');
  draft.spliceText(first, { from: 0, to: firstNode.content!.length, insert: text });
  for (const id of rest) removeNodePreservingChildren(draft, root, id);
  return focusResult(start, focus(draft, first, text.length));
}

export function joinWithPrevious(
  draft: TreeDraft,
  root: NodeId,
  nodeId: NodeId,
): ActionFocus | undefined {
  inline(draft, nodeId);
  const target = previousInline(draft, root, nodeId);
  if (!target) return undefined;
  const start = focus(draft, nodeId, 0, 'left');
  const offset = inline(draft, target).content!.length;
  mergeInline(draft, root, nodeId, target);
  return focusResult(start, focus(draft, target, offset));
}
