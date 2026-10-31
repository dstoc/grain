import { cast } from '../../asserts.js';
import { EditContext } from '../editor.js';
import { children, dfs, findNextEditable, isAncestorOf } from '../../markdown/view-model-util.js';
import { isInlineViewModelNode, viewModel } from '../../markdown/view-model-node.js';

export function removeSelectedNodes(context: EditContext) {
  const nodes = [...context.selection];
  const selected = new Set(nodes);
  const candidates = [];
  // Capture the document-order predecessors of the first selected block before
  // mutation, including editable descendants of preceding containers.
  for (const node of dfs(
    context.root,
    context.root[viewModel].nextSibling ?? context.root[viewModel].parent,
  )) {
    if (selected.has(node)) break;
    if (isInlineViewModelNode(node)) candidates.push(node);
  }
  context.startEditing();
  for (const node of nodes) {
    if (node.type === 'section' && node[viewModel].parent) {
      for (const child of children(node)) {
        child[viewModel].insertBefore(cast(node[viewModel].parent), node);
      }
    }
    node[viewModel].remove();
  }
  let didFocus = false;
  for (const node of candidates.reverse()) {
    if (node === context.root || isAncestorOf(context.root, node)) {
      context.focus(node, -Infinity);
      didFocus = true;
      break;
    }
  }
  if (!didFocus) {
    const next = findNextEditable(context.root, context.root, true);
    if (next) {
      context.focus(next, 0);
      didFocus = true;
    }
  }
  context.clearSelection();
  return true;
}
