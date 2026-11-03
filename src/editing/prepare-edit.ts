import type {
  ActionFocus,
  ActionOptions,
  ActionRequest,
  CanonicalWriter,
} from '../markdown/canonical-actions.js';
import type { Bookmark } from '../markdown/canonical-actions.js';
import type { EditSelection } from '../markdown/semantic/selection.js';
import type { SelectionIntent } from '../markdown/semantic/selection.js';
import type { EditContext } from './context.js';
import type { Edit, EditOutcome } from './outcomes.js';
import type { NodeId } from '../markdown/semantic/types.js';

interface CapturedSelection {
  readonly start?: Bookmark;
  readonly block?: {
    readonly nodeIds: readonly NodeId[];
    readonly anchor: Bookmark;
    readonly focus: Bookmark;
  };
}

export interface PreparedEdit {
  readonly request: ActionRequest;
  /** Host selection behavior for the accepted action; not part of the wire request. */
  readonly selection?: SelectionIntent;
}

function captureSelection(
  draft: EditContext['draft'],
  selectionBefore: EditSelection | undefined,
): CapturedSelection {
  const startPoint = selectionBefore?.anchor;
  const start = startPoint
    ? draft.bookmark(startPoint.nodeId, startPoint.offset, startPoint.affinity)
    : undefined;
  if (!selectionBefore || !('nodeIds' in selectionBefore)) {
    return start ? { start } : {};
  }
  return {
    ...(start ? { start } : {}),
    block: {
      nodeIds: [...selectionBefore.nodeIds],
      anchor: draft.bookmark(
        selectionBefore.anchor.nodeId,
        selectionBefore.anchor.offset,
        selectionBefore.anchor.affinity,
      ),
      focus: draft.bookmark(
        selectionBefore.focus.nodeId,
        selectionBefore.focus.offset,
        selectionBefore.focus.affinity,
      ),
    },
  };
}

function actionFocus(
  draft: EditContext['draft'],
  captured: CapturedSelection,
  outcome: Extract<EditOutcome, { readonly status: 'handled' }>,
): ActionFocus | undefined {
  const blockSelection = captured.block
    ? {
        anchor: captured.block.anchor,
        focus: captured.block.focus,
        ...(outcome.selection?.type === 'preserve-block-selection' &&
        outcome.selection.restoreOnRedo
          ? { restoreOnRedo: true }
          : {}),
      }
    : undefined;

  if (outcome.selection?.type === 'preserve-block-selection') {
    if (!blockSelection) throw new Error('cannot preserve a block selection that was not captured');
    if (!sameSelection(outcome.selection.selection, captured)) {
      throw new Error('an edit can only preserve its captured block selection');
    }
    return {
      ...(captured.start ? { start: captured.start } : {}),
      selection: blockSelection,
    };
  }

  const end = outcome.focus
    ? draft.bookmark(outcome.focus.nodeId, outcome.focus.offset, outcome.focus.affinity)
    : undefined;
  if (!captured.start && !end && !blockSelection) return undefined;
  return {
    ...(captured.start ? { start: captured.start } : {}),
    ...(end ? { end } : {}),
    ...(blockSelection ? { selection: blockSelection } : {}),
  };
}

function sameSelection(
  selection: Extract<SelectionIntent, { readonly type: 'preserve-block-selection' }>['selection'],
  captured: CapturedSelection,
): boolean {
  const block = captured.block;
  if (!block) return false;
  return (
    selection.nodeIds.length === block.nodeIds.length &&
    selection.nodeIds.every((nodeId, index) => nodeId === block.nodeIds[index]) &&
    selection.anchor.nodeId === block.anchor.nodeId &&
    selection.anchor.offset === block.anchor.offset &&
    selection.anchor.affinity === block.anchor.affinity &&
    selection.focus.nodeId === block.focus.nodeId &&
    selection.focus.offset === block.focus.offset &&
    selection.focus.affinity === block.focus.affinity
  );
}

/** Prepares one semantic command and declines to submit an inapplicable edit. */
export function prepareEdit<Input>(
  writer: Pick<CanonicalWriter, 'prepareCommand'>,
  options: ActionOptions,
  scopeRoot: NodeId,
  selectionBefore: EditSelection | undefined,
  command: Edit<Input>,
  input: Input,
): PreparedEdit | undefined {
  let outcome: EditOutcome | undefined;
  const request = writer.prepareCommand(options, (draft) => {
    const context: EditContext = {
      draft,
      scopeRoot,
      ...(selectionBefore ? { selectionBefore } : {}),
    };
    const captured = captureSelection(draft, selectionBefore);
    outcome = command(context, input);
    if (outcome.status === 'not-applicable') return;
    return actionFocus(draft, captured, outcome);
  });

  if (!outcome) throw new Error('edit command did not return an outcome');
  if (outcome.status === 'not-applicable') {
    if (request.operations.length !== 0) {
      throw new Error('not-applicable edit changed its draft');
    }
    return undefined;
  }
  return { request, ...(outcome.selection ? { selection: outcome.selection } : {}) };
}
