import type { EditContext } from '../../../editing/context.js';
import { assertScopedTarget } from '../../../editing/context.js';
import type { ParserConversionPlan } from '../../block-parser/types.js';
import type { NodeId } from '../../semantic/types.js';
import { MultiwriterCommandDraft } from './draft.js';

/** Compose an explicit conversion with other headless commands in one local action.
 * Returned handles follow parser preorder, including wrappers. */
export function interpretMarkdown(
  context: EditContext,
  node: NodeId,
  plan: ParserConversionPlan,
): readonly NodeId[] {
  assertScopedTarget(context.draft, context.scopeRoot, node);
  if (!(context.draft instanceof MultiwriterCommandDraft))
    throw new Error('Parser interpretation requires a multiwriter command draft');
  return context.draft.interpret(node, plan);
}
