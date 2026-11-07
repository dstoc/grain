import { measureWork } from '../diagnostics.js';
import { ActivityValidationError, reduceActivitySteps } from '../visibility/activity.js';
import { groupKey } from '../visibility/identity.js';
import { slotSequence } from '../layout/occurrences.js';
import { nativeView } from './publication.js';
import type { NativeView } from './publication.js';
import type { ActionEnvelope, Allocation, NativeTextRange, RangeRef } from '../contracts.js';
import type {
  ActionStoreOptions,
  ActionValidationContext,
  QuarantineReason,
} from '../actions/store.js';
import { encodeEnvelope } from '../actions/codec.js';
import { sameEnvelopeData } from '../actions/equal.js';
import { compareBytes } from '../actions/cbor.js';
import {
  actionKey,
  validReferencesSteps,
  validCertifiedReferencesSteps,
} from '../actions/references.js';
import { NativeTapeCache } from '../text/cache.js';
import type { NativeBody } from '../text/types.js';
import { NativeValidationError, resourceKey } from '../text/identity.js';
import { DEFAULT_INGEST_LIMITS, assertLimit, IngestDataError } from './work.js';
import { bindAuthorNative } from '../ownership/author-proof.js';
import type { Work } from './work.js';

type Reason = QuarantineReason | null;
/** Trusted immutable ready payloads. An optional exact difference reader can
 * avoid scanning a retained native branch. Ordinary maps retain the full check.
 */
export interface RetainedPayloadIndex {
  get(key: string): Uint8Array | undefined;
  changes?(before: RetainedPayloadIndex, visit: () => void): Iterable<string> | undefined;
}
export class MissingAuthorValidatorError extends Error {
  constructor() {
    super('MW-04/MW-06 author-view validator required for structural allocations/effects');
    this.name = 'MissingAuthorValidatorError';
  }
}
export interface AuthorValidationContext extends ActionValidationContext {
  /** Isolated exact author closure plus candidate births. Never the merged live cache. */
  readonly native: NativeView;
}
export interface IngestValidatorOptions {
  readonly genesis: NativeBody;
  readonly decodeOperations?: number;
  /** Real reducer-owned author-view checks. Absence is an operational integration error. */
  readonly validateAuthor?: (
    action: ActionEnvelope,
    context: AuthorValidationContext,
  ) => Reason | Work<Reason>;
}

/**
 * One certification branch, reusable on exact causal appends. Other branches reconstruct privately.
 * Successful prefixes retain native identities; eviction discards only derived state.
 */
export type IngestValidator = ActionStoreOptions['validate'] & {
  destroy(): void;
  /** Release the private native branch and exact certification preimages. */
  evict(): void;
  /** Direct cache counts and encoded payload lengths; these are not heap sizes. */
  cacheDiagnostics(): {
    readonly nativeBranch: boolean;
    readonly busy: boolean;
    readonly certificates: number;
    readonly preimages: number;
    readonly encodedBytes: number;
    readonly preimageNativeBytes: number;
    readonly retainedFactsCompared: number;
    readonly retainedIndexNodesVisited: number;
  };
  setDecodeLimit(operations: number): void;
  /** Detached native diagnostics, including the retained certification branch. */
  encodeNativeState(): Uint8Array;
  /** Withdraw a formerly certified branch when a late fork removes it from readiness. */
  retainReady(actions: readonly ActionEnvelope[]): void;
  /** Exact borrowed payload index from the optimized readiness reader. */
  retainReadyFacts(variants: RetainedPayloadIndex): void;
};
export function createIngestValidator(options: IngestValidatorOptions): IngestValidator {
  const genesis = structuredClone(options.genesis);
  let decodeOperations = options.decodeOperations ?? DEFAULT_INGEST_LIMITS.decodeOperations;
  assertLimit(decodeOperations);
  let cache: NativeTapeCache | undefined;
  const branchFacts = new Map<string, Uint8Array>();
  const addedFacts = new Set<string>();
  let retainedView: RetainedPayloadIndex | undefined;
  let retainedFactsCompared = 0,
    retainedIndexNodesVisited = 0;
  let branchIdentity: object | undefined;
  let busy = false;
  interface Certificate {
    readonly envelope: ActionEnvelope;
    readonly bytes: Uint8Array;
    readonly dependencies: readonly Certificate[];
    readonly indexedDependencies?: readonly object[];
  }
  const certificates = new Map<string, Certificate>();
  function discard() {
    cache?.destroy();
    cache = undefined;
    branchFacts.clear();
    addedFacts.clear();
    retainedView = undefined;
    branchIdentity = undefined;
  }
  function* validate(action: ActionEnvelope, context: ActionValidationContext): Work<Reason> {
    if (busy) throw new Error('Ingest validator already computing');
    busy = true;
    let success = false;
    try {
      const structural =
        action.allocations.some((entry) => !['tape', 'marker'].includes(entry.type)) ||
        action.effects.some(
          (effect) => effect.type !== 'InsertText' && effect.type !== 'SetGroupActive',
        );
      if (structural && !options.validateAuthor) throw new MissingAuthorValidatorError();
      const indexed = context.indexed;
      if (
        !(yield* indexed
          ? validCertifiedReferencesSteps(action, indexed.past)
          : validReferencesSteps(action, context.dependencies, genesis.allocations))
      )
        return 'reference';
      const control = action.effects.some((effect) => effect.type === 'SetGroupActive');
      if (control) {
        try {
          yield* reduceActivitySteps([...context.dependencies, action]);
        } catch (error) {
          if (!(error instanceof ActivityValidationError)) throw error;
          return 'reference';
        }
      } else if (indexed) {
        if (indexed.past.groupSealed(action.groupId)) return 'reference';
      } else
        for (const dependency of context.dependencies) {
          yield;
          for (const effect of dependency.effects) {
            yield;
            if (
              effect.type === 'SetGroupActive' &&
              groupKey(effect.group) === groupKey(action.groupId)
            )
              return 'reference';
          }
        }
      const ownBytes = encodeEnvelope(action);
      const certificate = certificates.get(actionKey(action.id));
      let dependencyCertificates: readonly (Certificate | undefined)[] = [];
      let bytes: Uint8Array[] | undefined;
      if (!indexed) {
        bytes = [];
        const dependencyFacts = new Map<string, Certificate>();
        for (const dependency of context.dependencies) {
          yield;
          const prior = certificates.get(actionKey(dependency.id));
          const encoded =
            prior && sameEnvelopeData(dependency, prior.envelope)
              ? prior.bytes
              : encodeEnvelope(dependency);
          const matching = prior && compareBytes(prior.bytes, encoded) === 0;
          if (matching) dependencyFacts.set(actionKey(dependency.id), prior);
          bytes.push(matching ? prior.bytes : encoded);
        }
        dependencyCertificates = action.dependencies.map((id) =>
          dependencyFacts.get(actionKey(id)),
        );
      }
      if (
        certificate &&
        compareBytes(certificate.bytes, ownBytes) === 0 &&
        (indexed
          ? certificate.indexedDependencies?.length === indexed.dependencies.length &&
            indexed.dependencies.every(
              (value, index) => value === certificate.indexedDependencies![index],
            )
          : dependencyCertificates.length === certificate.dependencies.length &&
            dependencyCertificates.every(
              (value, index) => value !== undefined && value === certificate.dependencies[index],
            ))
      ) {
        success = true;
        return null;
      }
      let reuse = !!cache && !!indexed && branchIdentity === indexed.past.identity;
      if (!indexed && cache) {
        const retained = [...branchFacts.values()];
        reuse =
          bytes!.length === retained.length &&
          bytes!.every((value, index) => compareBytes(value, retained[index]) === 0);
      }
      if (!reuse) {
        discard();
        cache = new NativeTapeCache(decodeOperations);
        // Genesis is trusted host configuration; failures must propagate.
        yield* measureWork('native-preparation', cache.applySteps('genesis', genesis));
        for (const dependency of context.dependencies) {
          yield;
          const key = actionKey(dependency.id);
          yield* measureWork('native-preparation', cache.applySteps(key, dependency));
          branchFacts.set(key, encodeEnvelope(dependency));
          addedFacts.add(key);
        }
      }
      const native = cache!;
      try {
        yield* measureWork(
          'native-preparation',
          native.applySteps(`candidate:${actionKey(action.id)}`, action),
        );
        yield* checkNativeReferences(action, native);
      } catch (error) {
        if (!(error instanceof IngestDataError) || error.stage !== 'native') throw error;
        return 'native-body';
      }
      if (!(yield* checkAllocations(action, context, genesis.allocations))) return 'reference';
      if (options.validateAuthor) {
        const view = nativeView(native);
        bindAuthorNative(context.indexed, action, view);
        const result = options.validateAuthor(action, {
          get dependencies() {
            return context.dependencies;
          },
          indexed: context.indexed,
          native: view,
        });
        const reason = typeof result === 'object' && result !== null ? yield* result : result;
        if (reason) return reason;
      }
      if (
        indexed ||
        dependencyCertificates.every((value): value is Certificate => value !== undefined)
      )
        certificates.set(actionKey(action.id), {
          envelope: structuredClone(action),
          bytes: ownBytes,
          dependencies: dependencyCertificates as readonly Certificate[],
          ...(indexed ? { indexedDependencies: indexed.dependencies } : {}),
        });
      const key = actionKey(action.id);
      branchFacts.set(key, ownBytes);
      addedFacts.add(key);
      branchIdentity = indexed?.resultIdentity;
      success = true;
      return null;
    } finally {
      if (!success) discard();
      busy = false;
    }
  }
  function retainReadyFacts(ready: RetainedPayloadIndex): void {
    if (busy) throw new Error('Cancel ingest computation before withdrawing its native branch');
    const changed =
      retainedView && ready.changes?.(retainedView, () => retainedIndexNodesVisited++);
    // A newly certified action need not be ready yet (for example after a failed
    // append). Check it even when the ready index is identical to the prior root.
    const keys = changed ? new Set([...changed, ...addedFacts]) : branchFacts.keys();
    for (const key of keys) {
      const fact = branchFacts.get(key);
      if (!fact) continue;
      retainedFactsCompared++;
      const bytes = ready.get(key);
      if (!bytes || compareBytes(fact, bytes) !== 0) {
        discard();
        return;
      }
    }
    retainedView = ready;
    addedFacts.clear();
  }
  return Object.assign(
    (action: ActionEnvelope, context: ActionValidationContext) =>
      measureWork('exact-author', validate(action, context), 'author'),
    {
      evict: () => {
        if (busy) throw new Error('Cancel ingest computation before evicting its validator');
        discard();
        certificates.clear();
      },
      cacheDiagnostics: () => ({
        nativeBranch: cache !== undefined,
        busy,
        certificates: certificates.size,
        preimages: certificates.size,
        encodedBytes: [...certificates.values()].reduce(
          (sum, certificate) => sum + certificate.bytes.byteLength,
          0,
        ),
        preimageNativeBytes: [...certificates.values()].reduce(
          (sum, certificate) =>
            sum +
            certificate.envelope.nativeInsertUpdates.reduce(
              (bytes, update) => bytes + update.byteLength,
              0,
            ),
          0,
        ),
        retainedFactsCompared,
        retainedIndexNodesVisited,
      }),
      encodeNativeState: () => cache?.encodeState() ?? Uint8Array.of(0, 0),
      retainReadyFacts,
      retainReady: (actions: readonly ActionEnvelope[]) => {
        retainReadyFacts(
          new Map(
            actions.map((action) => {
              const key = actionKey(action.id),
                certificate = certificates.get(key);
              return [
                key,
                certificate && sameEnvelopeData(action, certificate.envelope)
                  ? certificate.bytes
                  : encodeEnvelope(action),
              ];
            }),
          ),
        );
      },
      setDecodeLimit: (operations: number) => {
        if (busy)
          throw new Error('Cancel ingest computation before changing native decode capacity');
        assertLimit(operations);
        decodeOperations = operations;
        discard();
      },
      destroy: () => {
        if (busy) throw new Error('Cancel ingest computation before destroying its validator');
        discard();
        certificates.clear();
      },
    },
  );
}

/** Native identity/membership checks complement existence checks in actions/references.ts. */
function* checkNativeReferences(action: ActionEnvelope, cache: NativeTapeCache): Work<void> {
  const stack: unknown[] = [action.allocations, action.effects];
  while (stack.length) {
    yield;
    const value = stack.pop();
    if (!value || typeof value !== 'object' || value instanceof Uint8Array) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        yield;
        stack.push(item);
      }
      continue;
    }
    const fields = value as Record<string, unknown>;
    if ('tape' in fields && 'client' in fields && 'clock' in fields && 'length' in fields) {
      yield* cache.lookupSteps(value as NativeTextRange);
    } else if ('tape' in fields && 'start' in fields && 'end' in fields) {
      const ref = value as RangeRef;
      const start = yield* cache.markerSteps(ref.start);
      const end = yield* cache.markerSteps(ref.end);
      if (
        resourceKey(start.tape) !== resourceKey(ref.tape) ||
        resourceKey(end.tape) !== resourceKey(ref.tape) ||
        start.index >= end.index
      )
        throw new NativeValidationError('Invalid open native range');
    } else if ('run' in fields && 'boundary' in fields && 'side' in fields) {
      yield* cache.markerSteps(fields.boundary as RangeRef['start']);
    } else
      for (const item of Object.values(fields)) {
        yield;
        stack.push(item);
      }
  }
}

function* checkAllocations(
  action: ActionEnvelope,
  context: ActionValidationContext,
  genesis: readonly Allocation[],
): Work<boolean> {
  const allocations = new Map<string, Allocation>();
  for (const list of context.indexed
    ? [action.allocations]
    : [genesis, ...context.dependencies.map((entry) => entry.allocations), action.allocations])
    for (const allocation of list) {
      yield;
      allocations.set(resourceKey(allocation.id), allocation);
    }
  const get = (id: Allocation['id']) =>
    allocations.get(resourceKey(id)) ?? context.indexed?.past.allocation(id);
  for (const allocation of action.allocations) {
    yield;
    if (allocation.type === 'node') {
      if (allocation.role === 'root') return false;
      if ((allocation.role === 'inline') !== (allocation.flow !== null)) return false;
      if (allocation.flow) {
        const flow = get(allocation.flow);
        if (flow?.type !== 'flow' || resourceKey(flow.home) !== resourceKey(allocation.id))
          return false;
      }
    } else if (allocation.type === 'flow') {
      const node = get(allocation.home);
      if (
        node?.type !== 'node' ||
        node.role !== 'inline' ||
        !node.flow ||
        resourceKey(node.flow) !== resourceKey(allocation.id)
      )
        return false;
    } else if (allocation.type === 'occurrence') {
      const predecessor = allocation.slot.predecessor;
      if (predecessor) {
        const previous = get(predecessor);
        if (
          previous?.type !== 'occurrence' ||
          slotSequence(previous.slot) !== slotSequence(allocation.slot)
        )
          return false;
        const seen = new Set<string>([resourceKey(allocation.id)]);
        let cursor: Allocation | undefined = previous;
        while (cursor?.type === 'occurrence') {
          yield;
          const key = resourceKey(cursor.id);
          if (seen.has(key)) return false;
          seen.add(key);
          cursor = cursor.slot.predecessor ? get(cursor.slot.predecessor) : undefined;
        }
      }
    }
  }
  return true;
}
