import type { ActionEnvelope, NativeTextRange, RangeRef } from '../contracts.js';
import type { BirthPlacement, LayoutGenesis } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { createOwnershipAuthorValidator, reduceOwnership } from '../ownership/index.js';
import {
  isTextRefinement,
  validateTextRefinement,
  TextRefinementError,
} from '../ownership/text-validation.js';
import type { IngestValidatorOptions } from '../ingest/validator.js';
import { finish, IngestCapacityError, IngestDataError } from '../ingest/work.js';
import { reduceActivity } from '../visibility/index.js';
import {
  exactContains,
  ProjectionError,
  selectInterpretations,
  validatePacket,
  validateMembership,
} from './interpretation.js';

/** MW-15 invokes this only on genesis + exact dependencies + candidate native body. */
export function createProjectionAuthorValidator(options: {
  readonly genesis: LayoutGenesis;
  readonly births: (action: ActionEnvelope) => readonly BirthPlacement[];
}): NonNullable<IngestValidatorOptions['validateAuthor']> {
  const genesis = structuredClone(options.genesis);
  return (action, context) => {
    // The indexed past certifies all ancestor constructors. Pure refinement has
    // no placement, ownership, packet membership or interpretation decisions.
    // Resolve the host callback outside the rejection catch as on the full path.
    if (context.indexed && isTextRefinement(action) && options.births(action).length === 0) {
      try {
        validateTextRefinement(action, context);
        return null;
      } catch (error) {
        if (!(error instanceof TextRefinementError)) throw error;
        return 'reference';
      }
    }
    const actions = [...context.dependencies, action];
    // Resolve host-supplied birth bindings before data-rejection catches. Host
    // failures must propagate; the reference boundary handles ProvenanceError.
    const inputs = actions.map((action) => ({ action, births: options.births(action) }));
    const births = (action: ActionEnvelope) =>
      inputs.find(
        (entry) =>
          entry.action.id.actor === action.id.actor &&
          entry.action.id.sequence === action.id.sequence,
      )!.births;
    const activity = reduceActivity(actions);
    const selected = selectInterpretations(activity);
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
      validateMembership(action, allocations);
      const certify = (selection: ReturnType<typeof selectInterpretations>) => {
        const result = createOwnershipAuthorValidator({
          ...options,
          births,
          genesis,
          effectEligible: (_actions, order) =>
            selection.effectEligible({ action: order.action.id, ordinal: order.ordinal }),
          interpretationEligible: (_actions, order) =>
            selection.eligible({ action: order.action.id, ordinal: order.ordinal }),
        })(action, context);
        return result !== null && typeof result === 'object' ? finish(result) : result;
      };
      const failure = certify(selected);
      if (failure) return failure;
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
        const validating = selectInterpretations(activity, [], { action: action.id, ordinal });
        const memberFailure = certify(validating);
        if (memberFailure) return memberFailure;
        const prefixAt = (before: number) =>
          reduceOwnership({
            genesis,
            actions: inputs,
            snapshots,
            isActive: (order) =>
              activity.isActive(order.action.id) &&
              (order.action.id.actor !== action.id.actor ||
                order.action.id.sequence !== action.id.sequence ||
                order.ordinal < before) &&
              validating.effectEligible({ action: order.action.id, ordinal: order.ordinal }),
            interpretationEligible: (order) =>
              validating.eligible({ action: order.action.id, ordinal: order.ordinal }),
          });
        const prefix = prefixAt(ordinal);
        for (const index of packet.effectOrdinals ?? []) {
          const member = action.effects[index];
          if (member.type !== 'TransferRange') continue;
          const before = prefixAt(index);
          const cells = member.ranges.flatMap((range) => before.cells(range));
          const cellKey = (range: RangeRef) =>
            [range.tape, range.start, range.end].map(resourceKey).join('|');
          const traversalKeys = (
            flow: NonNullable<(typeof before.nodeAllocations)[number]['flow']>,
          ) =>
            before
              .raw(flow)
              .flatMap((e) => (e.type === 'cell' ? [cellKey(e.assignment.cell)] : []));
          const wanted = cells.map((cell) => cellKey(cell.cell));
          const valid = [packet.source, ...(packet.derivedInlineOutputs ?? [])].some((id) => {
            const node = before.nodeAllocations.find((n) => resourceKey(n.id) === resourceKey(id));
            if (!node?.flow) return false;
            const traversal = traversalKeys(node.flow);
            let previous = -1;
            return (
              wanted.length > 0 &&
              wanted.every((key) => {
                const at = traversal.indexOf(key);
                if (at <= previous) return false;
                previous = at;
                return true;
              })
            );
          });
          if (!valid)
            throw new ProjectionError('Packet transfer is outside author source/output traversal');
        }
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
      }
      return null;
    } catch (error) {
      if (error instanceof IngestDataError || error instanceof IngestCapacityError) throw error;
      if (!(error instanceof Error)) throw error;
      return 'reference';
    }
  };
}
