import type { EditContext } from '../context.js';
import { assertScopedTarget } from '../context.js';
import { handled, type Edit } from '../outcomes.js';
import { assertTextRange, type NodeId } from '../../markdown/semantic/types.js';
import { requireInline, splitInlineInto, textPoint } from '../operations/inline.js';
import { placeBefore } from '../operations/placement.js';

function nextAfter(context: EditContext, nodeId: NodeId): NodeId | undefined {
  return context.draft.nextSiblingOf(nodeId);
}

function splitSiblingParagraph(
  context: EditContext,
  nodeId: NodeId,
  start: number,
  end: number,
): { readonly nodeId: NodeId; readonly offset: number } {
  const { draft } = context;
  const node = requireInline(draft, nodeId);
  const parent = draft.parentOf(nodeId);
  if (!parent) throw new Error('cannot split a detached inline node');
  const paragraph = draft.create({ type: 'paragraph', content: '' });
  if (node.type === 'section' && start === 0) {
    placeBefore(draft, paragraph, parent, nodeId);
    if (end > start) draft.spliceText(nodeId, { from: start, to: end, insert: '' });
    return { nodeId: paragraph, offset: 0 };
  }
  if (node.type === 'section') {
    const firstChild = draft.node(nodeId).children[0];
    draft.place(paragraph, nodeId, firstChild ?? null);
  } else {
    placeBefore(draft, paragraph, parent, nextAfter(context, nodeId) ?? null);
  }
  if (start === 0 && node.content.length > 0) {
    splitInlineInto(draft, nodeId, start, end, paragraph, 'right');
    placeBefore(draft, paragraph, parent, nodeId);
    return { nodeId: end > start ? nodeId : paragraph, offset: 0 };
  }
  splitInlineInto(draft, nodeId, start, end, paragraph);
  return { nodeId: paragraph, offset: 0 };
}

export interface InsertLineBreakInput {
  readonly nodeId: NodeId;
  readonly from: number;
  readonly to?: number;
}

export const insertLineBreak: Edit<InsertLineBreakInput> = (
  context,
  { nodeId, from, to = from },
) => {
  const { draft, scopeRoot } = context;
  assertScopedTarget(draft, scopeRoot, nodeId);
  const node = requireInline(draft, nodeId);
  assertTextRange(node.content, from, to, 'line break range');
  if (node.type !== 'code-block') {
    const result = splitSiblingParagraph(context, nodeId, from, from);
    return handled({ focus: textPoint(draft, result.nodeId, result.offset) });
  }

  if (from === 0 || from === node.content.length) {
    const result = splitSiblingParagraph(context, nodeId, from, to);
    return handled({ focus: textPoint(draft, result.nodeId, result.offset) });
  }

  const parent = draft.parentOf(nodeId);
  if (!parent) throw new Error('cannot split a detached code block');
  const paragraph = draft.create({ type: 'paragraph', content: '' });
  const trailing = draft.create({ type: 'code-block', info: node.info, content: '' });
  placeBefore(draft, paragraph, parent, nextAfter(context, nodeId) ?? null);
  placeBefore(draft, trailing, parent, nextAfter(context, paragraph) ?? null);
  splitInlineInto(draft, nodeId, from, to, trailing);
  return handled({ focus: textPoint(draft, paragraph, 0) });
};
