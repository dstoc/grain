import { withOwnershipAuthorPreamble } from '../ownership/validation.js';
import type { ActionEnvelope, NativeTextRange, RangeRef } from '../contracts.js';
import type { BirthPlacement, LayoutGenesis } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { createOwnershipAuthorValidator, reduceOwnership } from '../ownership/index.js';
import {
  isTextRefinement,
  textControlTargets,
  validateTextRefinement,
  TextRefinementError,
} from '../ownership/text-validation.js';
import { actionKey } from '../actions/references.js';
import { countWork } from '../diagnostics.js';
import type {
  AuthorProofProvider,
  LocalAuthorProofProvider,
  LocalAuthorProofRequest,
} from '../ownership/author-proof.js';
import {
  consumeAuthorProof,
  discardAuthorProof,
  AuthorProofProviderError,
} from '../ownership/author-proof.js';
import type { IngestValidatorOptions } from '../ingest/validator.js';
import { finish, IngestCapacityError, IngestDataError } from '../ingest/work.js';
import { reduceActivity } from '../visibility/index.js';
import {
  exactContains,
  ProjectionError,
  selectInterpretations,
  validatePacket,
  validateMembership,
  isPropertyUpdate,
} from './interpretation.js';

/** MW-15 invokes this only on genesis + exact dependencies + candidate native body. */
export function createProjectionAuthorValidator(options: {
  readonly genesis: LayoutGenesis;
  readonly authorProof?: AuthorProofProvider;
  readonly localAuthorProof?: LocalAuthorProofProvider;
  readonly births: (action: ActionEnvelope) => readonly BirthPlacement[];
}): NonNullable<IngestValidatorOptions['validateAuthor']> {
  const genesis = structuredClone(options.genesis);
  // One validator owns the immutable genesis and its home descriptors. Candidate
  // activity, native snapshots and birth callbacks remain invocation-specific.
  const validateOwnership = createOwnershipAuthorValidator({
    ...options,
    genesis,
    authorProof: options.localAuthorProof ? undefined : options.authorProof,
  });
  let validatePacketOwnership: ReturnType<typeof createOwnershipAuthorValidator> | undefined;
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
    // Every ancestor has an exact author certificate. A pure property update
    // adds no native body, birth, membership or raw structural intention. Check
    // its node references against that author past, without cloning the closure.
    // Host birth callbacks still run outside data-rejection catches.
    if (context.indexed && isPropertyUpdate(action) && options.births(action).length === 0) {
      return action.effects.every(
        (effect) =>
          effect.type === 'SetProperties' &&
          context.indexed!.past.allocation(effect.node)?.type === 'node',
      )
        ? null
        : 'reference';
    }
    if (context.indexed && action.effects[0]?.type === 'SetGroupActive') {
      const past = new Map(
        context.dependencies.map((dependency) => [actionKey(dependency.id), dependency]),
      );
      if (
        textControlTargets(action, (id) => past.get(actionKey(id))) &&
        options.births(action).length === 0
      )
        return null;
    }
    // A private exact-local attempt can certify the candidate before any author
    // closure inventory is requested. Unavailable results keep ordinary validation.
    let candidateBirths: readonly BirthPlacement[] | undefined;
    let birthFailure: { readonly error: unknown } | undefined;
    const births = () => {
      if (!candidateBirths) {
        countWork('projectionAuthor.candidateBirthCallbacks');
        try {
          candidateBirths = options.births(action);
        } catch (error) {
          birthFailure = { error };
          throw error;
        }
      }
      return candidateBirths;
    };
    if (options.localAuthorProof && !action.effects.some((effect) => effect.type === 'Interpret')) {
      const request: LocalAuthorProofRequest = {
        invocation: Object.freeze({}),
        action,
        indexed: context.indexed,
        native: context.native,
        births,
      };
      countWork('authorProof.requests');
      const result = (() => {
        try {
          return options.localAuthorProof!(request);
        } catch (error) {
          // Birth callbacks keep their existing boundary, including the host's
          // raw-provenance classification. Only provider failures are wrapped.
          if (birthFailure && birthFailure.error === error) throw error;
          throw new AuthorProofProviderError(error);
        }
      })();
      if (result.state === 'rejected') {
        countWork('authorProof.rejections');
        return 'reference';
      }
      if (result.state === 'proved') {
        try {
          consumeAuthorProof(request, result.proof);
          return null;
        } finally {
          discardAuthorProof(result.proof);
        }
      }
      countWork(`authorProof.miss.${result.reason}`);
    }
    const actions = [...context.dependencies, action];
    // Resolve host-supplied birth bindings before data-rejection catches. Host
    // failures must propagate; the reference boundary handles ProvenanceError.
    const inputs = actions.map((entry) => {
      if (entry === action) return { action: entry, births: births() };
      countWork('projectionAuthor.ancestorBirthCallbacks');
      return { action: entry, births: options.births(entry) };
    });
    const activity = reduceActivity(actions);
    const selected = selectInterpretations(activity);
    const allocations = [
      ...genesis.allocations,
      ...actions.flatMap((action) => action.allocations),
    ];
    const snapshots = allocations
      .filter((entry) => entry.type === 'tape')
      .map((entry) => {
        countWork('authorProof.snapshotBindingsIndexed');
        return context.native.snapshot(entry.id);
      });
    countWork('projectionAuthor.preambleActions', actions.length);
    countWork('projectionAuthor.preambleAllocations', allocations.length);
    countWork('projectionAuthor.preambleSnapshots', snapshots.length);
    countWork(
      'projectionAuthor.preambleSnapshotParts',
      snapshots.reduce((n, s) => n + s.parts.length, 0),
    );
    const read = (range: NativeTextRange) =>
      context.native
        .lookup(range)
        .map((fragment) => fragment.text)
        .join('');
    try {
      validateMembership(action, allocations);
    } catch (error) {
      if (error instanceof IngestDataError || error instanceof IngestCapacityError) throw error;
      if (!(error instanceof Error)) throw error;
      return 'reference';
    }
    const certify = (selection: ReturnType<typeof selectInterpretations>) => {
      const validate = action.effects.some((e) => e.type === 'Interpret')
        ? (validatePacketOwnership ??= createOwnershipAuthorValidator({
            ...options,
            genesis,
            authorProof: undefined,
          }))
        : validateOwnership;
      return withOwnershipAuthorPreamble(
        context,
        {
          action,
          native: context.native,
          actions,
          allocations,
          snapshots,
          inputs,
          activity,
          effectEligible: (order) =>
            selection.effectEligible({ action: order.action.id, ordinal: order.ordinal }),
          interpretationEligible: (order) =>
            selection.eligible({ action: order.action.id, ordinal: order.ordinal }),
        },
        () => {
          const result = validate(action, context);
          return result !== null && typeof result === 'object' ? finish(result) : result;
        },
      );
    };
    const failure = certify(selected);
    if (failure) return failure;
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
