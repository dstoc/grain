import { assert } from '../../asserts.js';
import { EditContext } from '../editor.js';
import { isInlineNode } from '../../markdown/node.js';
import { findNextEditable } from '../../markdown/view-model-util.js';
import { InlineEdit } from '../../markdown/view-model.js';
import { viewModel } from '../../markdown/view-model-node.js';

export function editInlineNode(context: EditContext, edit: InlineEdit) {
  assert(isInlineNode(context.node));
  const node = context.node;
  context.startEditing();
  const newNodes = node[viewModel].edit(edit);
  if (newNodes) {
    // Although normalization has not happened, it will never remove an editable.
    const next = findNextEditable(newNodes[0], context.root, true);
    if (next) {
      // The parsed content normally follows the block markers.
      // Map the insertion point into that suffix, clamping positions in the
      // markers to the start of the editable content.
      const contentStart = node.content.lastIndexOf(next.content);
      context.focus(
        next,
        contentStart < 0
          ? next.content.length
          : Math.max(0, Math.min(next.content.length, edit.newEndIndex - contentStart)),
      );
    }
  } else {
    // TODO: generalize this (inline block mutation)
    const parent = node[viewModel].parent;
    if (
      parent?.type === 'list-item' &&
      parent.checked === undefined &&
      /^\[( |x)] /.test(node.content)
    ) {
      parent[viewModel].updateChecked(node.content[1] === 'x');
      node[viewModel].edit({
        newText: '',
        startIndex: 0,
        newEndIndex: 0,
        oldEndIndex: 4,
      });
    }
    context.focus(node, edit.newEndIndex);
  }
}
