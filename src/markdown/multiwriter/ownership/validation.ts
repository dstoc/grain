import type { ActionEnvelope } from '../contracts.js';
import type { AuthorValidationContext, IngestValidatorOptions } from '../ingest/validator.js';
import { IngestCapacityError, IngestDataError } from '../ingest/work.js';
import type { BirthPlacement, EffectOrder, LayoutGenesis } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { reduceActivity } from '../visibility/activity.js';
import { CellIndex, sameId } from './cells.js';
import { deriveHomes } from './homes.js';
import type { HomeBinding } from './homes.js';
import { OwnershipValidationError } from './errors.js';
import { certifyOwnership } from './ownership.js';
import type { OwnershipInput } from './ownership.js';
import {
  consumeAuthorProof,
  discardAuthorProof,
  AuthorProofProviderError,
} from './author-proof.js';
import type { AuthorProofProvider, AuthorProofRequest } from './author-proof.js';
import { countWork } from '../diagnostics.js';
import type { Activity } from '../visibility/activity.js';
import type { TapeSnapshot } from '../text/types.js';

/** Reuse one invocation's exact inputs across projection and ownership checks.
 * These are inputs to validation, never a certificate or a reason to skip checks.
 */
interface OwnershipAuthorPreamble {
  readonly action: ActionEnvelope;
  readonly native: AuthorValidationContext['native'];
  readonly actions: readonly ActionEnvelope[];
  readonly allocations: readonly ActionEnvelope['allocations'][number][];
  readonly snapshots: readonly TapeSnapshot[];
  readonly inputs: OwnershipInput['actions'];
  readonly activity: Activity;
  effectEligible(order: EffectOrder): boolean;
  interpretationEligible(order: EffectOrder): boolean;
}
const preambles = new WeakMap<AuthorValidationContext, OwnershipAuthorPreamble>();
/** Internal synchronous reuse only. A peer/context property cannot supply it. */
export function withOwnershipAuthorPreamble<T>(
  context: AuthorValidationContext,
  input: OwnershipAuthorPreamble,
  operation: () => T,
): T {
  if (preambles.has(context)) throw new Error('Ownership preamble invocation is already active');
  preambles.set(context, input);
  try {
    return operation();
  } finally {
    preambles.delete(context);
  }
}
/** MW-03 supplies deterministic node-to-birth bindings from retained allocation/effect facts.
 * This adapter certifies ownership/home conventions, not MW-06 projection or command validity.
 */
export function createOwnershipAuthorValidator(options: {
  readonly genesis: LayoutGenesis;
  readonly authorProof?: AuthorProofProvider;
  readonly births: (action: ActionEnvelope) => readonly BirthPlacement[];
  readonly effectEligible?: (actions: readonly ActionEnvelope[], order: EffectOrder) => boolean;
  readonly interpretationEligible?: (
    actions: readonly ActionEnvelope[],
    order: EffectOrder,
  ) => boolean;
}) {
  let genesisHomes: ReturnType<typeof deriveHomes> | undefined;
  const genesis = structuredClone(options.genesis);
  return (
    action: ActionEnvelope,
    context: AuthorValidationContext,
  ): ReturnType<NonNullable<IngestValidatorOptions['validateAuthor']>> => {
    const prepared = preambles.get(context);
    if (prepared && (prepared.action !== action || prepared.native !== context.native))
      throw new Error('Ownership preamble belongs to a different author invocation');
    // Native capacity and host configuration errors must propagate, never quarantine a peer.
    const actions = prepared?.actions ?? [...context.dependencies, action];
    const allocations = prepared?.allocations ?? [
      ...genesis.allocations,
      ...actions.flatMap((entry) => entry.allocations),
    ];
    const snapshots =
      prepared?.snapshots ??
      allocations
        .filter((entry) => entry.type === 'tape')
        .map((tape) => context.native.snapshot(tape.id));
    const inputs =
      prepared?.inputs ??
      actions.map((entry) => ({ action: entry, births: options.births(entry) }));
    const activity = prepared?.activity ?? reduceActivity(actions);
    if (prepared) countWork('authorProof.preambleInputsReused');
    countWork('authorProof.preambleActions', actions.length);
    countWork('authorProof.preambleAllocations', allocations.length);
    countWork('authorProof.preambleSnapshots', snapshots.length);
    countWork(
      'authorProof.preambleSnapshotParts',
      snapshots.reduce((n, s) => n + s.parts.length, 0),
    );
    const rejected = (error: unknown) => {
      if (error instanceof IngestDataError || error instanceof IngestCapacityError) throw error;
      if (!(error instanceof Error)) throw error;
      return 'reference' as const;
    };
    try {
      const homes = [
        ...(genesisHomes ??= deriveHomes(genesis)),
        ...inputs.flatMap((entry) =>
          deriveHomes(
            { allocations: entry.action.allocations, births: entry.births },
            entry.action.effects,
          ),
        ),
      ];
      countWork('authorProof.preambleHomes', homes.length);
      assertEdgeBrackets(action, homes, snapshots);
    } catch (error) {
      return rejected(error);
    }
    const input: OwnershipInput = {
      genesis,
      actions: inputs,
      snapshots,
      isActive: (order) =>
        activity.isActive(order.action.id) &&
        (prepared?.effectEligible(order) ?? options.effectEligible?.(actions, order) ?? true),
      interpretationEligible: (order) =>
        prepared?.interpretationEligible(order) ??
        options.interpretationEligible?.(actions, order) ??
        false,
    };
    // Provider/host failures are outside the semantic rejection boundary.
    if (options.authorProof) {
      countWork('authorProof.requests');
      const request: AuthorProofRequest = {
        invocation: Object.freeze({}),
        action,
        indexed: context.indexed,
        native: context.native,
        input,
        activity,
      };
      const result = (() => {
        try {
          return options.authorProof!(request);
        } catch (error) {
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
    try {
      countWork('authorProof.fullCertifications');
      certifyOwnership(input, action.id);
      return null;
    } catch (error) {
      return rejected(error);
    }
  };
}

/** Final text-free edges alone do not certify two author-allocated brackets. Remove
 * this action's interior markers to locate the insertion's original home cell.
 */
export function assertEdgeBrackets(
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
      if (!before || !after) throw new OwnershipValidationError('Text outside home sentinels');
      if (!sameId(before.marker, home.cell.start) && !sameId(after.marker, home.cell.end)) continue;
      const left = markers.findLast((marker) => marker.index < part.index)!;
      const right = markers.find((marker) => marker.index > part.index)!;
      if (
        !newMarkers.has(resourceKey(left.marker)) ||
        !newMarkers.has(resourceKey(right.marker)) ||
        sameId(left.marker, home.cell.start) ||
        sameId(right.marker, home.cell.end)
      )
        throw new OwnershipValidationError(
          'Edge typing needs two interior author-allocated brackets',
        );
      index.range({ tape: snapshot.tape, start: left.marker, end: right.marker });
    }
  }
}
