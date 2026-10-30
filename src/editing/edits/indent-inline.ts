import { EditContext } from '../editor.js';
import { indent, unindent } from '../../indent-util.js';
import { renumberListMoves } from '../../markdown/ordered-list.js';

export function editInlineIndent(context: EditContext, mode: 'indent' | 'unindent') {
  context.startEditing();
  context.keepFocus();
  renumberListMoves(context.root, () => {
    if (mode === 'unindent') {
      unindent(context.node, context.root);
    } else {
      indent(context.node, context.root);
    }
  });
}
