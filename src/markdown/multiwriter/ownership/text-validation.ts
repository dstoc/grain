import type { ActionEnvelope, ActionId } from '../contracts.js';
import type { AuthorValidationContext } from '../ingest/validator.js';
import { resourceKey } from '../text/identity.js';
import { IngestDataError, IngestCapacityError } from '../ingest/work.js';
import { CellIndex, sameId } from './cells.js';

export class TextRefinementError extends Error {}

/** Marker refinement, exact-text deletion and insertion cannot change raw
 * placement or the retained run skeleton. A certified author past already owns
 * every tape as a private home. Native range references are checked by ingest;
 * check affected native tapes and the two author-bracket rule here.
 * Structural allocations/effects still require coupled ownership replay.
 */
export function isTextRefinement(action: ActionEnvelope): boolean {
  return (
    action.allocations.every((a) => a.type === 'marker' || a.type === 'deletion') &&
    action.effects.every((e) => e.type === 'InsertText' || e.type === 'DeleteText')
  );
}
/** An already-authorized owner control of text-only actions changes visibility,
 * never raw placement/ownership. Group ownership and control-chain checks remain
 * the ingest activity validator's responsibility.
 */
export function textControlTargets(
  action: ActionEnvelope,
  lookup: (id: ActionId) => ActionEnvelope | undefined,
): readonly ActionEnvelope[] | undefined {
  const effect = action.effects[0];
  if (
    action.effects.length !== 1 ||
    effect?.type !== 'SetGroupActive' ||
    action.allocations.length ||
    action.nativeManifest.length ||
    action.nativeInsertUpdates.length ||
    !effect.actions.length
  )
    return undefined;
  const targets: ActionEnvelope[] = [];
  for (const id of effect.actions) {
    const target = lookup(id);
    if (!target || !isTextRefinement(target)) return undefined;
    targets.push(target);
  }
  return targets;
}
export function validateTextRefinement(
  action: ActionEnvelope,
  context: AuthorValidationContext,
): void {
  if (!context.indexed || !isTextRefinement(action))
    throw new Error('Text refinement requires a certified author past');
  const newMarkers = new Set(
    action.allocations.filter((a) => a.type === 'marker').map((a) => resourceKey(a.id)),
  );
  const touched = new Map(
    action.nativeManifest.map((birth) => [resourceKey(birth.tape), birth.tape]),
  );
  for (const [key, tape] of touched) {
    const allocation = context.indexed.past.allocation(tape);
    if (allocation?.type !== 'tape')
      throw new TextRefinementError('Text refinement requires an existing private tape');
    const snapshot = context.native.snapshot(tape);
    let index: CellIndex;
    try {
      index = new CellIndex([snapshot]);
    } catch (error) {
      if (error instanceof IngestDataError || error instanceof IngestCapacityError) throw error;
      if (!(error instanceof Error)) throw error;
      throw new TextRefinementError(error.message);
    }
    const cells = index.tape(tape);
    if (
      !sameId(cells[0].range.start, allocation.start) ||
      !sameId(cells.at(-1)!.range.end, allocation.end) ||
      cells[0].fragments.length ||
      cells.at(-1)!.fragments.length
    )
      throw new TextRefinementError(
        'Reserved home cells must remain text-free; bracket edge typing',
      );
    const markers = snapshot.parts.filter((part) => part.type === 'marker');
    const prior = markers.filter((part) => !newMarkers.has(resourceKey(part.marker)));
    const inserted = action.nativeManifest.flatMap((birth) =>
      birth.type === 'text' && resourceKey(birth.tape) === key ? [birth] : [],
    );
    for (const part of snapshot.parts) {
      if (
        part.type !== 'text' ||
        !inserted.some(
          (birth) =>
            birth.native.client === part.native.client &&
            birth.native.clock < part.native.clock + part.text.length &&
            birth.native.clock + birth.native.length > part.native.clock,
        )
      )
        continue;
      const before = prior.findLast((marker) => marker.index < part.index);
      const after = prior.find((marker) => marker.index > part.index);
      if (!before || !after) throw new TextRefinementError('Text outside home sentinels');
      if (!sameId(before.marker, allocation.start) && !sameId(after.marker, allocation.end))
        continue;
      const left = markers.findLast((marker) => marker.index < part.index)!;
      const right = markers.find((marker) => marker.index > part.index)!;
      if (!newMarkers.has(resourceKey(left.marker)) || !newMarkers.has(resourceKey(right.marker)))
        throw new TextRefinementError('Edge typing needs two interior author-allocated brackets');
    }
  }
}
