import { assert, deepCopy, deepFreeze, stableJson } from './util.js';
import type { AcceptedAction, ActionFocus, ActionRequest, Bookmark } from './action-types.js';

export const MAX_CACHED_RESPONSES = 256;
export const MAX_CACHED_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface CachedActionResponse {
  readonly hash: string;
  readonly accepted: AcceptedAction;
  readonly bytes: number;
}

export function sessionWatermarkKey(epoch: string, sessionId: string): string {
  return stableJson([epoch, sessionId]);
}

export function actionIdentity(
  documentId: string,
  epoch: string,
  sessionId: string,
  sequence: number,
): string {
  return stableJson([documentId, epoch, sessionId, sequence]);
}

export function requestHash(request: ActionRequest): string {
  return stableJson({
    ...request,
    textUpdate: request.textUpdate ? Array.from(request.textUpdate) : undefined,
  });
}

export function copyActionFocus(value: unknown): ActionFocus | undefined {
  if (value === undefined) return undefined;
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'focus must be an object',
  );
  const focus = value as ActionFocus;
  const copyBookmark = (bookmark: Bookmark | undefined): Bookmark | undefined => {
    if (bookmark === undefined) return undefined;
    assert(
      typeof bookmark.nodeId === 'string' && bookmark.nodeId.length > 0,
      'focus node ID is invalid',
    );
    assert(Number.isInteger(bookmark.offset) && bookmark.offset >= 0, 'focus offset is invalid');
    assert(
      bookmark.affinity === 'left' || bookmark.affinity === 'right',
      'focus affinity is invalid',
    );
    if (bookmark.spanIndex !== undefined)
      assert(
        Number.isInteger(bookmark.spanIndex) && bookmark.spanIndex >= 0,
        'focus span index is invalid',
      );
    return Object.freeze({ ...bookmark });
  };
  assert(
    Object.keys(focus).every((key) => key === 'start' || key === 'end' || key === 'selection'),
    'focus contains an unsupported field',
  );
  const start = copyBookmark(focus.start);
  const end = copyBookmark(focus.end);
  let selection: ActionFocus['selection'];
  if (focus.selection !== undefined) {
    assert(
      Object.keys(focus.selection).every(
        (key) => key === 'anchor' || key === 'focus' || key === 'kind' || key === 'restoreOnRedo',
      ),
      'focus selection contains an unsupported field',
    );
    const anchor = copyBookmark(focus.selection.anchor);
    const selectionFocus = copyBookmark(focus.selection.focus);
    assert(anchor && selectionFocus, 'focus selection endpoints are required');
    assert(
      focus.selection.restoreOnRedo === undefined ||
        typeof focus.selection.restoreOnRedo === 'boolean',
      'focus selection redo flag is invalid',
    );
    assert(
      focus.selection.kind === undefined ||
        focus.selection.kind === 'block' ||
        focus.selection.kind === 'text',
      'focus selection kind is invalid',
    );
    selection = Object.freeze({
      anchor,
      focus: selectionFocus,
      ...(focus.selection.kind ? { kind: focus.selection.kind } : {}),
      ...(focus.selection.restoreOnRedo ? { restoreOnRedo: true } : {}),
    });
  }
  return Object.freeze({
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(selection ? { selection } : {}),
  });
}

export function copyAcceptedAction(accepted: AcceptedAction): AcceptedAction {
  return Object.freeze({ ...accepted, update: Uint8Array.from(accepted.update) });
}

export function acceptedResponseBytes(accepted: AcceptedAction): number {
  const envelope = stableJson({
    actionId: accepted.actionId,
    sessionId: accepted.sessionId,
    authorityEpoch: accepted.authorityEpoch,
    revision: accepted.revision,
    receipt: accepted.receipt,
  });
  return accepted.update.byteLength + new TextEncoder().encode(envelope).byteLength;
}

export function copyRequest(request: ActionRequest): ActionRequest {
  return Object.freeze({
    ...request,
    ...(request.focus ? { focus: copyActionFocus(request.focus) } : {}),
    preconditions: Object.freeze(
      request.preconditions.map((item) => Object.freeze(deepCopy(item))),
    ),
    operations: Object.freeze(request.operations.map((item) => deepFreeze(deepCopy(item)))),
    ...(request.textUpdate ? { textUpdate: Uint8Array.from(request.textUpdate) } : {}),
  });
}
