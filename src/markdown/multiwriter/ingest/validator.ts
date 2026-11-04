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
import { compareBytes } from '../actions/cbor.js';
import { actionKey, validReferencesSteps } from '../actions/references.js';
import { NativeTapeCache } from '../text/cache.js';
import type { NativeBody } from '../text/types.js';
import { NativeValidationError, resourceKey } from '../text/identity.js';
import { DEFAULT_INGEST_LIMITS, assertLimit, IngestDataError } from './work.js';
import type { Work } from './work.js';

type Reason = QuarantineReason | null;
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
  setDecodeLimit(operations: number): void;
};
export function createIngestValidator(options: IngestValidatorOptions): IngestValidator {
  const genesis = structuredClone(options.genesis);
  let decodeOperations = options.decodeOperations ?? DEFAULT_INGEST_LIMITS.decodeOperations;
  assertLimit(decodeOperations);
  let cache: NativeTapeCache | undefined;
  let certified: Uint8Array[] = [];
  let busy = false;
  interface Certificate {
    readonly bytes: Uint8Array;
    readonly dependencies: readonly Certificate[];
  }
  const certificates = new Map<string, Certificate>();
  function discard() {
    cache?.destroy();
    cache = undefined;
    certified = [];
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
      if (!(yield* validReferencesSteps(action, context.dependencies, genesis.allocations)))
        return 'reference';
      const bytes: Uint8Array[] = [];
      const dependencyFacts = new Map<string, Certificate>();
      for (const dependency of context.dependencies) {
        yield;
        const encoded = encodeEnvelope(dependency);
        const certificate = certificates.get(actionKey(dependency.id));
        const matching = certificate && compareBytes(certificate.bytes, encoded) === 0;
        if (matching) dependencyFacts.set(actionKey(dependency.id), certificate);
        bytes.push(matching ? certificate.bytes : encoded);
      }
      const control = action.effects.some((effect) => effect.type === 'SetGroupActive');
      if (control) {
        try {
          yield* reduceActivitySteps([...context.dependencies, action]);
        } catch (error) {
          if (!(error instanceof ActivityValidationError)) throw error;
          return 'reference';
        }
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
      // Direct certificate identities encode the full transitive dependency facts without
      // retaining another copy of every ancestor body for every action.
      const dependencyCertificates = action.dependencies.map((id) =>
        dependencyFacts.get(actionKey(id)),
      );
      if (
        certificate &&
        compareBytes(certificate.bytes, ownBytes) === 0 &&
        dependencyCertificates.length === certificate.dependencies.length &&
        dependencyCertificates.every(
          (value, index) => value !== undefined && value === certificate.dependencies[index],
        )
      ) {
        success = true;
        return null;
      }
      if (
        !cache ||
        bytes.length !== certified.length ||
        bytes.some((value, index) => compareBytes(value, certified[index]) !== 0)
      ) {
        discard();
        cache = new NativeTapeCache(decodeOperations);
        // Genesis is trusted host configuration: its failure must fail opening, never quarantine a peer.
        yield* cache.applySteps('genesis', genesis);
        for (let index = 0; index < context.dependencies.length; index++) {
          yield;
          yield* cache.applySteps(`dependency:${index}`, context.dependencies[index]);
        }
      }
      const native = cache;
      try {
        yield* native.applySteps(`candidate:${bytes.length}`, action);
        yield* checkNativeReferences(action, native);
      } catch (error) {
        if (!(error instanceof IngestDataError) || error.stage !== 'native') throw error;
        return 'native-body';
      }
      if (!(yield* checkAllocations(action, context.dependencies, genesis.allocations)))
        return 'reference';
      if (options.validateAuthor) {
        const result = options.validateAuthor(action, { ...context, native: nativeView(native) });
        const reason = typeof result === 'object' && result !== null ? yield* result : result;
        if (reason) return reason;
      }
      if (dependencyCertificates.every((value): value is Certificate => value !== undefined))
        certificates.set(actionKey(action.id), {
          bytes: ownBytes,
          dependencies: dependencyCertificates,
        });
      certified = [...bytes, ownBytes];
      success = true;
      return null;
    } finally {
      if (!success) discard();
      busy = false;
    }
  }
  return Object.assign(validate, {
    setDecodeLimit: (operations: number) => {
      if (busy) throw new Error('Cancel ingest computation before changing native decode capacity');
      assertLimit(operations);
      decodeOperations = operations;
      discard();
    },
    destroy: () => {
      if (busy) throw new Error('Cancel ingest computation before destroying its validator');
      discard();
      certificates.clear();
    },
  });
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
  dependencies: readonly ActionEnvelope[],
  genesis: readonly Allocation[],
): Work<boolean> {
  const allocations = new Map<string, Allocation>();
  for (const list of [
    genesis,
    ...dependencies.map((entry) => entry.allocations),
    action.allocations,
  ])
    for (const allocation of list) {
      yield;
      allocations.set(resourceKey(allocation.id), allocation);
    }
  for (const allocation of action.allocations) {
    yield;
    if (allocation.type === 'node') {
      if (allocation.role === 'root') return false;
      if ((allocation.role === 'inline') !== (allocation.flow !== null)) return false;
      if (allocation.flow) {
        const flow = allocations.get(resourceKey(allocation.flow));
        if (flow?.type !== 'flow' || resourceKey(flow.home) !== resourceKey(allocation.id))
          return false;
      }
    } else if (allocation.type === 'flow') {
      const node = allocations.get(resourceKey(allocation.home));
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
        const previous = allocations.get(resourceKey(predecessor));
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
          cursor = cursor.slot.predecessor
            ? allocations.get(resourceKey(cursor.slot.predecessor))
            : undefined;
        }
      }
    }
  }
  return true;
}
