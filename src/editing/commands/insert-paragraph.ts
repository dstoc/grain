import type { EditContext } from '../context.js';
import { assertScopedTarget, isWithinScope } from '../context.js';
import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import type { NodeId } from '../../markdown/semantic/types.js';
import { assertTextRange } from '../../markdown/semantic/types.js';
import { nearestAncestor } from '../../markdown/semantic/queries.js';
import { requireInline, splitInlineInto, textPoint } from '../operations/inline.js';
import { placeBefore } from '../operations/placement.js';
import { outdentNode } from './outdent.js';

function descendantsAfter(context: EditContext, nodeId: NodeId, ancestorId: NodeId): NodeId[] {
  const { draft } = context;
  const result: NodeId[] = [];
  let current = nodeId;
  while (current !== ancestorId) {
    const parent = draft.parentOf(current);
    if (!parent) throw new Error(`node ${nodeId} is not inside ${ancestorId}`);
    const items = draft.node(parent).children;
    const index = items.indexOf(current);
    if (index < 0) throw new Error(`parent ${parent} does not contain ${current}`);
    result.push(...items.slice(index + 1));
    current = parent;
  }
  return result;
}

function markerOf(context: EditContext, nodeId: NodeId): string {
  return context.draft.node(nodeId).marker ?? '';
}

function nextAfter(context: EditContext, nodeId: NodeId): NodeId | undefined {
  return context.draft.nextSiblingOf(nodeId);
}

interface SplitResult {
  readonly focusId: NodeId;
  readonly focusOffset: number;
}

function splitSiblingParagraph(
  context: EditContext,
  nodeId: NodeId,
  start: number,
  end: number,
): SplitResult {
  const { draft } = context;
  const node = requireInline(draft, nodeId);
  const parent = draft.parentOf(nodeId);
  if (!parent) throw new Error('cannot split a detached inline node');
  const paragraph = draft.create({ type: 'paragraph', content: '' });

  if (node.type === 'section' && start === 0) {
    placeBefore(draft, paragraph, parent, nodeId);
    if (end > start) draft.spliceText(nodeId, { from: start, to: end, insert: '' });
    return { focusId: paragraph, focusOffset: 0 };
  }

  if (node.type === 'section') {
    const firstChild = draft.node(nodeId).children[0];
    draft.place(paragraph, nodeId, firstChild ?? null);
  } else {
    placeBefore(draft, paragraph, parent, nextAfter(context, nodeId) ?? null);
  }

  const shouldKeepOriginalOnRight = start === 0 && node.content.length > 0;
  if (shouldKeepOriginalOnRight) {
    splitInlineInto(draft, nodeId, start, end, paragraph, 'right');
    placeBefore(draft, paragraph, parent, nodeId);
    return { focusId: end > start ? nodeId : paragraph, focusOffset: 0 };
  }

  splitInlineInto(draft, nodeId, start, end, paragraph);
  return { focusId: paragraph, focusOffset: 0 };
}

function splitEmptyContainer(context: EditContext, nodeId: NodeId): NodeId | undefined {
  const { draft, scopeRoot } = context;
  const node = requireInline(draft, nodeId);
  if (node.type !== 'paragraph' || node.content !== '') return undefined;
  const ancestor = nearestAncestor(draft, scopeRoot, nodeId, ['list-item', 'block-quote']);
  if (!ancestor) return undefined;
  const parent = draft.parentOf(ancestor);
  if (!parent) return undefined;
  const type = draft.node(ancestor).type;
  const tail = descendantsAfter(context, nodeId, ancestor);
  let target = nodeId;

  if (type === 'list-item') {
    const nextItem = draft.create({ type: 'list-item', marker: markerOf(context, ancestor) });
    placeBefore(draft, nextItem, parent, nextAfter(context, ancestor) ?? null);
    draft.place(nodeId, nextItem, null);
    target = nextItem;
  } else {
    placeBefore(draft, nodeId, parent, nextAfter(context, ancestor) ?? null);
  }

  if (tail.length) {
    const tailWrapper =
      type === 'list-item'
        ? draft.create({ type: 'list-item', marker: markerOf(context, ancestor) })
        : draft.create({ type: 'block-quote', marker: markerOf(context, ancestor) });
    placeBefore(draft, tailWrapper, parent, nextAfter(context, target) ?? null);
    for (const child of tail) {
      if (draft.parentOf(child)) draft.place(child, tailWrapper, null);
    }
  }
  return nodeId;
}

function splitParagraphInSimpleList(
  context: EditContext,
  nodeId: NodeId,
  start: number,
  end: number,
): NodeId | undefined {
  const { draft } = context;
  const item = draft.parentOf(nodeId);
  if (!item || draft.node(item).type !== 'list-item') return undefined;
  const list = draft.parentOf(item);
  if (!list || draft.node(list).type !== 'list') return undefined;
  const node = requireInline(draft, nodeId);
  const next = nextAfter(context, nodeId);
  if (
    node.type !== 'paragraph' ||
    node.content.length === 0 ||
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
    placeBefore(draft, targetList, item, next);
    beforeItem = null;
  } else {
    targetList = list;
    beforeItem = nextAfter(context, item) ?? null;
  }

  if (!isWithinScope(draft, context.scopeRoot, targetList)) return undefined;
  const first = draft.node(targetList).children[0];
  const newItem = draft.create({
    type: 'list-item',
    marker: first ? markerOf(context, first) : '* ',
  });
  placeBefore(draft, newItem, targetList, beforeItem);
  const previousItem = draft.previousSiblingOf(newItem);
  if (
    previousItem &&
    draft.node(previousItem).type === 'list-item' &&
    draft.node(previousItem).checked !== null
  ) {
    draft.setChecked(newItem, false);
  }
  const paragraph = draft.create({ type: 'paragraph', content: '' });
  draft.place(paragraph, newItem, null);

  if (start === 0 && node.content.length > 0) {
    const oldParent = draft.parentOf(nodeId);
    const newParent = draft.parentOf(paragraph);
    if (!oldParent || !newParent) throw new Error('list split lost a parent');
    splitInlineInto(draft, nodeId, start, end, paragraph, 'right');
    const oldBefore = nextAfter(context, nodeId) ?? null;
    const newBefore = nextAfter(context, paragraph) ?? null;
    placeBefore(draft, nodeId, newParent, newBefore);
    placeBefore(draft, paragraph, oldParent, oldBefore);
    return end > 0 ? nodeId : paragraph;
  }

  splitInlineInto(draft, nodeId, start, end, paragraph);
  return paragraph;
}

export interface InsertParagraphInput {
  readonly nodeId: NodeId;
  readonly from: number;
  readonly to?: number;
}

export const insertParagraph: Edit<InsertParagraphInput> = (
  context,
  { nodeId, from, to = from },
) => {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, nodeId);
  const node = requireInline(draft, nodeId);
  assertTextRange(node.content, from, to, 'paragraph split range');

  const parent = draft.parentOf(nodeId);
  if (
    node.type === 'paragraph' &&
    node.content.length === 0 &&
    parent &&
    draft.node(parent).type === 'list-item' &&
    parent !== scopeRoot &&
    draft.node(parent).children.length === 1
  ) {
    const list = draft.parentOf(parent);
    const listParent = list ? draft.parentOf(list) : undefined;
    const firstMarker =
      list && draft.node(list).children[0] === parent ? markerOf(context, parent) : undefined;
    const next = draft.nextSiblingOf(parent);
    const promoteToParent = !!listParent && draft.node(listParent).type !== 'list-item';
    if (!outdentNode(context, nodeId)) return NOT_APPLICABLE;
    const orderedMarker = firstMarker && /^(\d+)([.)])\s*$/.exec(firstMarker);
    if (promoteToParent && next && orderedMarker) {
      let number = BigInt(orderedMarker[1]!);
      const delimiter = orderedMarker[2]!;
      const markerPattern = new RegExp(`^\\d+\\${delimiter}\\s*$`);
      let item: NodeId | undefined = next;
      while (
        item &&
        draft.node(item).type === 'list-item' &&
        markerPattern.test(markerOf(context, item))
      ) {
        draft.setMarker(item, `${number++}${delimiter} `);
        item = nextAfter(context, item);
      }
    }
    return handled({ focus: textPoint(draft, nodeId, 0) });
  }

  const emptySplit = splitEmptyContainer(context, nodeId);
  if (emptySplit) return handled({ focus: textPoint(draft, nodeId, 0) });

  const listParagraph = splitParagraphInSimpleList(context, nodeId, from, to);
  if (listParagraph) return handled({ focus: textPoint(draft, listParagraph, 0) });

  const result = splitSiblingParagraph(context, nodeId, from, to);
  return handled({ focus: textPoint(draft, result.focusId, result.focusOffset) });
};
