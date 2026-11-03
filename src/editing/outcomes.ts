import type { EditContext } from './context.js';
import type { SelectionIntent, TextPoint } from '../markdown/semantic/selection.js';

export type EditOutcome =
  | { readonly status: 'not-applicable' }
  | {
      readonly status: 'handled';
      readonly focus?: TextPoint;
      readonly selection?: SelectionIntent;
    };

export type Edit<Input> = (context: EditContext, input: Input) => EditOutcome;

export const NOT_APPLICABLE: EditOutcome = Object.freeze({ status: 'not-applicable' });

export function handled(
  outcome: Omit<Extract<EditOutcome, { readonly status: 'handled' }>, 'status'> = {},
): EditOutcome {
  return { status: 'handled', ...outcome };
}
