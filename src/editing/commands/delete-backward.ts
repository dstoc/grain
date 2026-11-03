import type { EditContext } from '../context.js';
import { assertScopedTarget } from '../context.js';
import { handled, NOT_APPLICABLE, type Edit } from '../outcomes.js';
import { liftSectionChildren, moveChildren, unwrapContainer } from '../operations/containers.js';
import { appendInline, previousInline, requireInline, textPoint } from '../operations/inline.js';
import type { NodeId } from '../../markdown/semantic/types.js';

function nearestListItem(context: EditContext, nodeId: NodeId): NodeId | undefined {
  const { draft, scopeRoot } = context;
  let current = nodeId;
  while (current !== scopeRoot) {
    const parent = draft.parentOf(current);
    if (!parent) return undefined;
    if (parent === scopeRoot) return undefined;
    if (draft.node(parent).type === 'list-item') return parent;
    current = parent;
  }
  return undefined;
}

export interface DeleteBackwardInput {
  readonly nodeId: NodeId;
}

export const deleteBackwardAtStart: Edit<DeleteBackwardInput> = (context, { nodeId }) => {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, nodeId);
  const node = requireInline(draft, nodeId);

  // Enter and Backspace precedence is intentional: convert the current heading
  // or code block before considering quote, adjacent-inline, or list behavior.
  if (node.type === 'section') {
    const nextMarker = (node.marker ?? '').slice(0, -1);
    if (nextMarker !== '') {
      draft.setMarker(nodeId, nextMarker);
      return handled({ focus: textPoint(draft, nodeId, 0) });
    }
    const parent = draft.parentOf(nodeId);
    if (!parent) return NOT_APPLICABLE;
    const children = [...draft.node(nodeId).children];
    liftSectionChildren(draft, nodeId);
    draft.convertInline(nodeId, { type: 'paragraph', content: { mode: 'preserve' } });
    if (children.length) {
      const firstChild = children[0]!;
      draft.place(nodeId, parent, firstChild);
    }
    return handled({ focus: textPoint(draft, nodeId, 0) });
  }

  if (node.type === 'code-block') {
    draft.convertInline(nodeId, { type: 'paragraph', content: { mode: 'preserve' } });
    return handled({ focus: textPoint(draft, nodeId, 0) });
  }

  const quote = (() => {
    let current = nodeId;
    while (current !== scopeRoot) {
      const parent = draft.parentOf(current);
      if (!parent) return undefined;
      if (parent === scopeRoot) return undefined;
      if (draft.node(parent).type === 'block-quote') return parent;
      current = parent;
    }
    return undefined;
  })();
  if (quote) {
    const target = previousInline(draft, quote, nodeId);
    if (target) {
      const seam = appendInline(draft, nodeId, target);
      const source = requireInline(draft, nodeId);
      if (source.type === 'section') liftSectionChildren(draft, nodeId);
      draft.detach(nodeId);
      return handled({ focus: seam });
    }
    unwrapContainer(draft, quote);
    return handled({ focus: textPoint(draft, nodeId, 0) });
  }

  const previous = previousInline(draft, scopeRoot, nodeId);
  if (previous) {
    const seam = appendInline(draft, nodeId, previous);
    draft.detach(nodeId);
    return handled({ focus: seam });
  }

  const listItem = nearestListItem(context, nodeId);
  const list = listItem ? draft.parentOf(listItem) : undefined;
  if (
    listItem &&
    list &&
    draft.node(list).type === 'list' &&
    draft.previousSiblingOf(listItem) === undefined &&
    draft.parentOf(list) === scopeRoot
  ) {
    moveChildren(draft, listItem, scopeRoot, list);
    draft.detach(listItem);
    if (draft.node(list).children.length === 0) draft.detach(list);
    return handled({ focus: textPoint(draft, nodeId, 0) });
  }
  return NOT_APPLICABLE;
};
