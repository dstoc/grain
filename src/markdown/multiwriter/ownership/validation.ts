import type { ActionEnvelope } from '../contracts.js';
import type { AuthorValidationContext, IngestValidatorOptions } from '../ingest/validator.js';
import { IngestCapacityError, IngestDataError } from '../ingest/work.js';
import type { BirthPlacement, EffectOrder, LayoutGenesis } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { reduceActivity } from '../visibility/activity.js';
import { CellIndex, sameId } from './cells.js';
import { deriveHomes } from './homes.js';
import type { HomeBinding } from './homes.js';
import { certifyOwnership } from './ownership.js';
import type { TapeSnapshot } from '../text/types.js';

/** MW-03 supplies deterministic node-to-birth bindings from retained allocation/effect facts.
 * This adapter certifies ownership/home conventions, not MW-06 projection or command validity.
 */
export function createOwnershipAuthorValidator(options: {
  readonly genesis: LayoutGenesis;
  readonly births: (action: ActionEnvelope) => readonly BirthPlacement[];
  readonly effectEligible?: (actions: readonly ActionEnvelope[], order: EffectOrder) => boolean;
  readonly interpretationEligible?: (
    actions: readonly ActionEnvelope[],
    order: EffectOrder,
  ) => boolean;
}): NonNullable<IngestValidatorOptions['validateAuthor']> {
  const genesis = structuredClone(options.genesis);
  return (action: ActionEnvelope, context: AuthorValidationContext) => {
    // Native capacity and host configuration errors must propagate, never quarantine a peer.
    const actions = [...context.dependencies, action];
    const allocations = [...genesis.allocations, ...actions.flatMap((entry) => entry.allocations)];
    const snapshots = allocations
      .filter((entry) => entry.type === 'tape')
      .map((tape) => context.native.snapshot(tape.id));
    const inputs = actions.map((entry) => ({ action: entry, births: options.births(entry) }));
    const activity = reduceActivity(actions);
    try {
      const homes = [
        ...deriveHomes(genesis),
        ...inputs.flatMap((entry) =>
          deriveHomes(
            { allocations: entry.action.allocations, births: entry.births },
            entry.action.effects,
          ),
        ),
      ];
      assertEdgeBrackets(action, homes, snapshots);
      certifyOwnership(
        {
          genesis,
          actions: inputs,
          snapshots,
          isActive: (order) =>
            activity.isActive(order.action.id) &&
            (options.effectEligible?.(actions, order) ?? true),
          interpretationEligible: (order) =>
            options.interpretationEligible?.(actions, order) ?? false,
        },
        action.id,
      );
      return null;
    } catch (error) {
      if (error instanceof IngestDataError || error instanceof IngestCapacityError) throw error;
      if (!(error instanceof Error)) throw error;
      return 'reference';
    }
  };
}

/** Final text-free edges alone do not certify two author-allocated brackets. Remove
 * this action's interior markers to locate the insertion's original home cell.
 */
function assertEdgeBrackets(
  action: ActionEnvelope,
  homes: readonly HomeBinding[],
  snapshots: readonly TapeSnapshot[],
): void {
  const newMarkers = new Set(
    action.allocations
      .filter((entry) => entry.type === 'marker')
      .map((entry) => resourceKey(entry.id)),
  );
  const inserted = action.nativeManifest.filter((entry) => entry.type === 'text');
  // Also check the partition itself before examining candidate text identities.
  const index = new CellIndex(snapshots);
  for (const home of homes) {
    const snapshot = snapshots.find((snapshot) => sameId(snapshot.tape, home.cell.tape))!;
    const markers = snapshot.parts.filter((part) => part.type === 'marker');
    const priorMarkers = markers.filter(
      (part) =>
        !newMarkers.has(resourceKey(part.marker)) ||
        sameId(part.marker, home.cell.start) ||
        sameId(part.marker, home.cell.end),
    );
    for (const part of snapshot.parts) {
      if (
        part.type !== 'text' ||
        !inserted.some(
          (birth) =>
            sameId(birth.tape, snapshot.tape) &&
            birth.native.client === part.native.client &&
            birth.native.clock < part.native.clock + part.text.length &&
            birth.native.clock + birth.native.length > part.native.clock,
        )
      )
        continue;
      const before = priorMarkers.findLast((marker) => marker.index < part.index);
      const after = priorMarkers.find((marker) => marker.index > part.index);
      if (!before || !after) throw new Error('Text outside home sentinels');
      if (!sameId(before.marker, home.cell.start) && !sameId(after.marker, home.cell.end)) continue;
      const left = markers.findLast((marker) => marker.index < part.index)!;
      const right = markers.find((marker) => marker.index > part.index)!;
      if (
        !newMarkers.has(resourceKey(left.marker)) ||
        !newMarkers.has(resourceKey(right.marker)) ||
        sameId(left.marker, home.cell.start) ||
        sameId(right.marker, home.cell.end)
      )
        throw new Error('Edge typing needs two interior author-allocated brackets');
      index.range({ tape: snapshot.tape, start: left.marker, end: right.marker });
    }
  }
}
