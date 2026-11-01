import type { EditContext } from '../editor.js';
import type { InlineViewModelNode, ViewModelNode } from '../../markdown/view-model-node.js';
import { isInlineViewModelNode, viewModel } from '../../markdown/view-model-node.js';
import { dfs } from '../../markdown/view-model-util.js';
import { removeNodePreservingChildren } from './remove-selected-nodes.js';

export function selectedBlocksInDocumentOrder(
  root: ViewModelNode,
  selection: Iterable<ViewModelNode>,
): InlineViewModelNode[] {
  const selected = new Set(selection);
  const nodes: InlineViewModelNode[] = [];
  for (const node of dfs(root)) {
    if (selected.has(node) && isInlineViewModelNode(node)) nodes.push(node);
  }
  return nodes;
}

export function replaceSelectedBlocks(context: EditContext, text: string) {
  const nodes = selectedBlocksInDocumentOrder(context.root, context.selection);
  const [first, ...rest] = nodes;
  if (!first) return;

  context.startEditing();
  context.clearSelection();
  first[viewModel].edit(
    {
      startIndex: 0,
      oldEndIndex: first.content.length,
      newText: text,
      newEndIndex: text.length,
    },
    false,
  );
  for (const node of rest) removeNodePreservingChildren(node);
  context.focus(first, text.length);
  return first;
}
