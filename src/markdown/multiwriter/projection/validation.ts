import type { ActionEnvelope, NativeTextRange } from '../contracts.js';
import type { BirthPlacement, LayoutGenesis } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { createOwnershipAuthorValidator, reduceOwnership } from '../ownership/index.js';
import type { IngestValidatorOptions } from '../ingest/validator.js';
import { finish, IngestCapacityError, IngestDataError } from '../ingest/work.js';
import { reduceActivity } from '../visibility/index.js';
import {
  exactContains,
  ProjectionError,
  selectInterpretations,
  validatePacket,
} from './interpretation.js';

/** MW-15 invokes this only on genesis + exact dependencies + candidate native body. */
export function createProjectionAuthorValidator(options: {
  readonly genesis: LayoutGenesis;
  readonly births: (action: ActionEnvelope) => readonly BirthPlacement[];
}): NonNullable<IngestValidatorOptions['validateAuthor']> {
  const genesis = structuredClone(options.genesis);
  return (action, context) => {
    const actions = [...context.dependencies, action];
    const activity = reduceActivity(actions);
    const selected = selectInterpretations(activity);
    const ownershipValidator = createOwnershipAuthorValidator({
      ...options,
      genesis,
      interpretationEligible: (_actions, order) =>
        selected.eligible({ action: order.action.id, ordinal: order.ordinal }),
    });
    const validation = ownershipValidator(action, context);
    const ownershipFailure =
      validation !== null && typeof validation === 'object' ? finish(validation) : validation;
    if (ownershipFailure) return ownershipFailure;
    const allocations = [
      ...genesis.allocations,
      ...actions.flatMap((action) => action.allocations),
    ];
    const snapshots = allocations
      .filter((entry) => entry.type === 'tape')
      .map((entry) => context.native.snapshot(entry.id));
    const read = (range: NativeTextRange) =>
      context.native
        .lookup(range)
        .map((fragment) => fragment.text)
        .join('');
    try {
      for (const [ordinal, effect] of action.effects.entries()) {
        if (effect.type !== 'Interpret') continue;
        const packet = effect.packet;
        validatePacket(packet, allocations, read);
        if (
          !action.allocations.some(
            (allocation) =>
              allocation.type === 'interpretation' &&
              resourceKey(allocation.id) === resourceKey(packet.id),
          )
        )
          throw new ProjectionError('Packet must be allocated by its author');
        for (const wrapper of packet.wrappers)
          if (
            !action.allocations.some(
              (allocation) =>
                allocation.type === 'node' && resourceKey(allocation.id) === resourceKey(wrapper),
            )
          )
            throw new ProjectionError('Packet wrappers must be allocated by its author');
        for (const range of packet.synthesizedText)
          if (
            !action.nativeManifest.some(
              (birth) =>
                birth.type === 'text' &&
                exactContains({ tape: birth.tape, ...birth.native }, range),
            ) ||
            !action.effects.some(
              (effect) =>
                effect.type === 'InsertText' &&
                effect.ranges.some((inserted) => exactContains(inserted, range)),
            )
          )
            throw new ProjectionError(
              'Synthesized editable text must be inserted in its author action',
            );
        const prefix = reduceOwnership({
          genesis,
          actions: actions.map((action) => ({ action, births: options.births(action) })),
          snapshots,
          isActive: (order) =>
            activity.isActive(order.action.id) &&
            (order.action.id.actor !== action.id.actor ||
              order.action.id.sequence !== action.id.sequence ||
              order.ordinal < ordinal),
          interpretationEligible: (order) =>
            selected.eligible({ action: order.action.id, ordinal: order.ordinal }),
        });
        const source = prefix.nodeAllocations.find(
          (node) => resourceKey(node.id) === resourceKey(packet.source),
        )!;
        // Inspect the source's retained raw traversal, not a merged owner/text search.
        // Joined sources remain addressable through their own lineage traversal.
        const sourceRanges = prefix
          .raw(source.flow!)
          .flatMap((entry) =>
            entry.type === 'cell' ? entry.fragments.map((fragment) => fragment.range) : [],
          );
        for (const mask of packet.syntaxMask) {
          const segments = context.native.lookup(mask);
          if (
            segments.some(
              (fragment) => !sourceRanges.some((source) => exactContains(source, fragment.range)),
            )
          )
            throw new ProjectionError('Syntax mask is outside author source traversal');
        }
        // Every retained placement is validated even if a later packet in this action wins.
        reduceOwnership({
          genesis,
          actions: actions.map((action) => ({ action, births: options.births(action) })),
          snapshots,
          isActive: (order) => activity.isActive(order.action.id),
          interpretationEligible: (order) =>
            (order.action.id.actor === action.id.actor &&
              order.action.id.sequence === action.id.sequence &&
              order.ordinal === ordinal) ||
            selected.eligible({ action: order.action.id, ordinal: order.ordinal }),
        });
      }
      return null;
    } catch (error) {
      if (error instanceof IngestDataError || error instanceof IngestCapacityError) throw error;
      if (!(error instanceof Error)) throw error;
      return 'reference';
    }
  };
}
