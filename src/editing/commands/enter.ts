import type { Edit } from '../outcomes.js';
import { requireInline } from '../operations/inline.js';
import { insertParagraph, type InsertParagraphInput } from './insert-paragraph.js';
import { insertText } from './insert-text.js';

/** Enter inserts literal LF in code and a structural paragraph elsewhere. */
export const enter: Edit<InsertParagraphInput> = (context, input) =>
  requireInline(context.draft, input.nodeId).type === 'code-block'
    ? insertText(context, { ...input, text: '\n' })
    : insertParagraph(context, input);
