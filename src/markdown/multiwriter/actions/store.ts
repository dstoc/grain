import { DEFAULT_INGEST_LIMITS, assertLimit, compute, finish } from '../ingest/work.js';
import type { Computation, Work } from '../ingest/work.js';
import { preflightUpdate } from '../ingest/preflight.js';
import * as Y from 'yjs';
import { compareActions } from '../contracts.js';
import type { ActionEnvelope, ActionId, ActionReadiness, Allocation } from '../contracts.js';
import { compareBytes } from './cbor.js';
import { decodeEnvelopeSteps, encodeEnvelope, EnvelopeDecodeError } from './codec.js';
import { actionKey, validReferencesSteps } from './references.js';

export type QuarantineReason = Extract<ActionReadiness, { state: 'quarantined' }>['reason'];
export interface ActionValidationContext {
  /** Full ready dependency closure, in semantic order. Never the later merged projection. */
  readonly dependencies: readonly ActionEnvelope[];
}
export interface ActionStoreOptions {
  readonly documentId: string;
  readonly genesisId: string;
  readonly genesisAllocations: readonly Allocation[];
  readonly decodeDepth?: number;
  readonly decodeOperations?: number;
  /**
   * Required certification of native bodies/manifests and author-local semantic validity.
   * Must be deterministic and side-effect free; generators charge resumable work.
   * MW-02/MW-15 supply the validator.
   * No action is ready before it returns null. Exceptions fail closed and propagate to the caller.
   */
  readonly validate: (
    action: ActionEnvelope,
    context: ActionValidationContext,
  ) => QuarantineReason | null | Work<QuarantineReason | null>;
}
export interface StoredAction {
  readonly id: ActionId;
  /** Copies, sorted bytewise. Conflicts are retained, never selected by arrival order. */
  readonly variants: readonly Uint8Array[];
  readonly readiness: ActionReadiness;
}
export interface ActionStoreSnapshot {
  readonly actions: readonly StoredAction[];
  readonly ready: readonly ActionEnvelope[];
  readonly heads: readonly ActionId[];
  /** Records without a decodable action ID, plus append-only collection violations. */
  readonly diagnostics: readonly string[];
  readonly integrity: boolean;
}
interface Variant {
  readonly bytes: Uint8Array;
  readonly envelope?: ActionEnvelope;
  readonly reason?: QuarantineReason;
}
interface Entry {
  readonly id: ActionId;
  readonly variants: Variant[];
}
interface ReadyCertificate {
  readonly variant: Variant;
  readonly dependencies: readonly ReadyCertificate[];
}
const quarantined = (reason: QuarantineReason): ActionReadiness => ({
  state: 'quarantined',
  reason,
});
const compareIds = (a: ActionId, b: ActionId): number =>
  a.actor < b.actor
    ? -1
    : a.actor > b.actor
      ? 1
      : a.sequence < b.sequence
        ? -1
        : a.sequence > b.sequence
          ? 1
          : 0;

/**
 * Canonical append-only envelope collection. The private Y.Doc prevents callers from mutating
 * stored byte arrays or deleting entries through the local API. Only this document is exchanged.
 * A snapshot is a full reference readiness calculation, not an accepted revision or a reducer.
 */
export class ActionStore {
  private readonly doc = new Y.Doc({ gc: false });
  private readonly envelopes = this.doc.getArray<Uint8Array>('envelopes');
  private readonly entries = new Map<string, Entry>();
  private readonly certificates = new Map<string, ReadyCertificate>();
  private readonly diagnostics: string[] = [];
  private integrity = true;
  private readonly undecoded: Uint8Array[] = [];
  private revision = 0;
  private computation = 0;
  private active?: Work<ActionStoreSnapshot>;
  private decodeDepth: number;
  private decodeOperations: number;
  private readonly options: ActionStoreOptions;
  private updateErrors?: unknown[];

  constructor(options: ActionStoreOptions) {
    if (typeof options.validate !== 'function') throw new Error('Action validation is required');
    // Keep configuration/genesis insulated from later caller mutations as well.
    this.decodeDepth = options.decodeDepth ?? DEFAULT_INGEST_LIMITS.depth;
    this.decodeOperations = options.decodeOperations ?? DEFAULT_INGEST_LIMITS.decodeOperations;
    assertLimit(this.decodeDepth);
    assertLimit(this.decodeOperations);
    this.options = { ...options, genesisAllocations: structuredClone(options.genesisAllocations) };
    this.envelopes.observe((event) => {
      for (const delta of event.changes.delta) {
        if (delta.delete) {
          this.integrity = false;
          this.diagnostics.push('Canonical envelope deletion violates append-only storage');
        }
        if (delta.insert) {
          if (!Array.isArray(delta.insert)) {
            this.integrity = false;
            this.diagnostics.push('Canonical collection contains a non-array insertion');
          } else for (const bytes of delta.insert) this.collect(bytes);
        }
      }
    });
  }

  append(action: ActionEnvelope): void {
    this.appendEncoded(encodeEnvelope(action));
  }

  /** Certify a local candidate against its exact ready past before appending facts.
   * No carrier/native publication occurs here; callers abort private preparation on failure.
   */
  checkLocal(action: ActionEnvelope): QuarantineReason | null {
    const bytes = encodeEnvelope(action);
    const snapshot = this.snapshot();
    if (!snapshot.integrity) return 'reference';
    const existing = snapshot.actions.find((entry) => actionKey(entry.id) === actionKey(action.id));
    if (existing)
      return existing.readiness.state === 'ready' &&
        existing.variants.length === 1 &&
        compareBytes(existing.variants[0], bytes) === 0
        ? null
        : 'reference';
    const chain = finish(this.chainError(action));
    if (chain) return chain;
    const ready = new Map(snapshot.ready.map((entry) => [actionKey(entry.id), entry]));
    if (action.dependencies.some((id) => !ready.has(actionKey(id)))) return 'reference';
    const maximum = action.dependencies.reduce((maximum, id) => {
      const time = ready.get(actionKey(id))!.lamport;
      return time > maximum ? time : maximum;
    }, 0n);
    if (action.lamport !== maximum + 1n) return 'actor-chain';
    const closure = new Map<string, ActionEnvelope>();
    const stack = [...action.dependencies];
    while (stack.length) {
      const key = actionKey(stack.pop()!);
      if (closure.has(key)) continue;
      const dependency = ready.get(key)!;
      closure.set(key, dependency);
      stack.push(...dependency.dependencies);
    }
    const dependencies = [...closure.values()].sort(compareActions);
    if (!finish(validReferencesSteps(action, dependencies, this.options.genesisAllocations)))
      return 'reference';
    const result = this.options.validate(structuredClone(action), {
      dependencies: structuredClone(dependencies),
    });
    return result !== null && typeof result === 'object' ? finish(result) : result;
  }

  /** Also retains malformed/unsupported envelopes for diagnostics and lossless exchange. */
  appendEncoded(bytes: Uint8Array): void {
    this.mutate(() => this.envelopes.push([bytes.slice()]));
  }

  applyUpdate(update: Uint8Array): void {
    preflightUpdate(update, 'carrier', this.decodeOperations);
    this.revision++;
    this.mutate(() => Y.applyUpdate(this.doc, update.slice()));
  }

  /** Retry held bytes after a local capacity change. No canonical facts are removed. */
  setDecodeLimits(limits: { depth?: number; operations?: number }): void {
    const depth = limits.depth ?? this.decodeDepth;
    const operations = limits.operations ?? this.decodeOperations;
    assertLimit(depth);
    assertLimit(operations);
    this.computation++;
    this.active?.return(undefined as unknown as ActionStoreSnapshot);
    this.decodeDepth = depth;
    this.decodeOperations = operations;
  }

  /** Changes on every receipt, including unresolved outer structs with no observer event. */
  get factsVersion(): number {
    return this.revision;
  }

  /** Conservative reservation includes facts a small receipt can unlock from pending structs. */
  persistenceReservation(update: Uint8Array): number {
    const pending = this.doc.store.pendingStructs ? this.encodeUpdate().byteLength : 0;
    return update.byteLength * 2 + pending * 2 + 1024;
  }

  encodeUpdate(stateVector?: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /** Persistence/provider hook. Each listener receives its own copy of the update.
   * Listener failures surface after native cleanup and all update notifications finish.
   * The mutation is retained; the first failure is rethrown to the mutation caller.
   */
  onUpdate(listener: (update: Uint8Array) => void): () => void {
    const callback = (update: Uint8Array) => {
      try {
        listener(update.slice());
      } catch (error) {
        this.updateErrors!.push(error);
      }
    };
    this.doc.on('update', callback);
    return () => this.doc.off('update', callback);
  }

  private mutate(write: () => void): void {
    // Reentrant writes from listeners share the outer boundary. Throwing inside Yjs's
    // update event can strand its transaction cleanup queue and stop later collection.
    if (this.updateErrors) {
      write();
      return;
    }
    const errors: unknown[] = [];
    this.updateErrors = errors;
    try {
      write();
    } catch (error) {
      errors.push(error);
    } finally {
      this.updateErrors = undefined;
    }
    if (errors.length) throw errors[0];
  }

  destroy(): void {
    this.computation++;
    this.active?.return(undefined as unknown as ActionStoreSnapshot);
    this.doc.destroy();
    this.certificates.clear();
  }

  private collect(value: unknown): void {
    this.revision++;
    if (value instanceof Uint8Array) this.undecoded.push(value.slice());
    else {
      this.integrity = false;
      this.diagnostics.push('Canonical collection entry must be an encoded envelope');
    }
  }

  private *decode(bytes: Uint8Array): Work<void> {
    let id: ActionId;
    let variant: Variant;
    try {
      const envelope = yield* decodeEnvelopeSteps(bytes, this.decodeDepth, this.decodeOperations);
      id = envelope.id;
      variant = { bytes, envelope };
    } catch (error) {
      if (!(error instanceof EnvelopeDecodeError)) throw error;
      if (!error.id) {
        this.diagnostics.push(error.message);
        return;
      }
      id = error.id;
      variant = { bytes, reason: error.reason };
    }
    const key = actionKey(id);
    const entry = this.entries.get(key) ?? { id, variants: [] };
    if (!entry.variants.some((item) => compareBytes(item.bytes, bytes) === 0)) {
      entry.variants.push(variant);
      entry.variants.sort((a, b) => compareBytes(a.bytes, b.bytes));
    }
    this.entries.set(key, entry);
  }

  snapshot(): ActionStoreSnapshot {
    this.computation++;
    this.active?.return(undefined as unknown as ActionStoreSnapshot);
    this.active = this.calculate();
    return finish(this.active);
  }

  /** No partial ready set escapes. A changed receipt invalidates an outstanding continuation. */
  compute(operations?: number): Computation<ActionStoreSnapshot> {
    const revision = this.revision;
    const computation = ++this.computation;
    this.active?.return(undefined as unknown as ActionStoreSnapshot);
    this.active = this.calculate();
    return compute(
      this.active,
      operations,
      () => this.revision === revision && this.computation === computation,
    );
  }

  private *calculate(): Work<ActionStoreSnapshot> {
    while (this.undecoded.length) {
      yield* this.decode(this.undecoded[0]);
      this.undecoded.shift();
    }
    const entries = [...this.entries.values()].sort((a, b) => compareIds(a.id, b.id));
    const states = new Map<string, ActionReadiness>();
    const candidates: ActionEnvelope[] = [];
    for (const entry of entries) {
      yield;
      const key = actionKey(entry.id);
      const variant = entry.variants[0];
      if (entry.variants.length > 1) states.set(key, quarantined('fork'));
      else if (!variant.envelope) states.set(key, quarantined(variant.reason!));
      else {
        const action = variant.envelope;
        const reason = yield* this.chainError(action);
        if (reason) states.set(key, quarantined(reason));
        else candidates.push(action);
      }
    }
    // Reject impossible known causal edges before topological evaluation, including cycles.
    for (const action of candidates) {
      yield;
      for (const _id of action.dependencies) yield;
      const dependencies = action.dependencies.map((id) => this.entries.get(actionKey(id)));
      if (
        dependencies.some(
          (entry) =>
            entry?.variants.length === 1 &&
            entry.variants[0].envelope &&
            entry.variants[0].envelope.lamport >= action.lamport,
        )
      )
        states.set(actionKey(action.id), quarantined('actor-chain'));
    }
    candidates.sort(compareActions);
    const ready = new Map<string, ActionEnvelope>();
    const readyCertificates = new Map<string, ReadyCertificate>();
    for (const action of candidates) {
      yield;
      const key = actionKey(action.id);
      if (states.has(key)) continue;
      const dependencies = [...action.dependencies].sort(compareIds);
      const invalid = dependencies
        .map((id) => states.get(actionKey(id)))
        .find((state) => state?.state === 'quarantined');
      if (invalid?.state === 'quarantined') {
        states.set(key, quarantined(invalid.reason));
        continue;
      }
      const missing = new Map<string, ActionId>();
      for (const id of dependencies) {
        yield;
        const state = states.get(actionKey(id));
        if (!state) missing.set(actionKey(id), id);
        else if (state.state === 'pending')
          for (const absent of state.missing) {
            yield;
            missing.set(actionKey(absent), absent);
          }
      }
      if (missing.size) {
        states.set(key, { state: 'pending', missing: [...missing.values()].sort(compareIds) });
        continue;
      }
      const maxTime = dependencies.reduce((max, id) => {
        const time = ready.get(actionKey(id))!.lamport;
        return time > max ? time : max;
      }, 0n);
      if (action.lamport !== maxTime + 1n) {
        states.set(key, quarantined('actor-chain'));
        continue;
      }
      // A successful author check depends only on this immutable payload and its
      // exact causal facts. Direct certificate identities encode the transitive
      // closure. Forked/unready dependencies never enter readyCertificates.
      const variant = this.entries.get(key)!.variants[0];
      const prior = this.certificates.get(key);
      const dependencyCertificates = dependencies.map((id) =>
        readyCertificates.get(actionKey(id))!,
      );
      if (
        prior?.variant === variant &&
        dependencyCertificates.length === prior.dependencies.length &&
        dependencyCertificates.every(
          (certificate, index) => certificate === prior.dependencies[index],
        )
      ) {
        states.set(key, { state: 'ready' });
        ready.set(key, action);
        readyCertificates.set(key, prior);
        continue;
      }
      const closure = new Map<string, ActionEnvelope>();
      const stack = [...dependencies];
      while (stack.length) {
        yield;
        const id = stack.pop()!;
        const depKey = actionKey(id);
        if (closure.has(depKey)) continue;
        const ancestor = ready.get(depKey)!;
        closure.set(depKey, ancestor);
        for (const dependency of ancestor.dependencies) {
          yield;
          stack.push(dependency);
        }
      }
      const causalBase = [...closure.values()].sort(compareActions);
      // Pass detached values to validators; neither validator nor snapshot callers own facts.
      const validation = !(yield* validReferencesSteps(
        action,
        causalBase,
        this.options.genesisAllocations,
      ))
        ? 'reference'
        : this.options.validate(structuredClone(action), {
            dependencies: structuredClone(causalBase),
          });
      const reason =
        typeof validation === 'object' && validation !== null ? yield* validation : validation;
      states.set(key, reason ? quarantined(reason) : { state: 'ready' });
      if (!reason) {
        ready.set(key, action);
        const certificate = { variant, dependencies: dependencyCertificates };
        this.certificates.set(key, certificate);
        readyCertificates.set(key, certificate);
      }
    }
    const heads = new Map([...ready].map(([key, action]) => [key, action.id]));
    for (const action of ready.values()) {
      yield;
      for (const id of action.dependencies) {
        yield;
        heads.delete(actionKey(id));
      }
    }
    return structuredClone({
      actions: entries.map((entry) => ({
        id: entry.id,
        variants: entry.variants.map((variant) => variant.bytes),
        readiness: states.get(actionKey(entry.id))!,
      })),
      ready: this.integrity ? [...ready.values()] : [],
      heads: this.integrity ? [...heads.values()] : [],
      diagnostics: this.diagnostics,
      integrity: this.integrity,
    });
  }

  private *chainError(action: ActionEnvelope): Work<QuarantineReason | null> {
    if (
      action.documentId !== this.options.documentId ||
      action.genesisId !== this.options.genesisId
    )
      return 'reference';
    if (
      action.id.sequence === 0n ||
      action.lamport === 0n ||
      action.groupId.session.actor !== action.id.actor
    )
      return 'actor-chain';
    const keys = new Set<string>();
    for (const id of action.dependencies) {
      yield;
      const key = actionKey(id);
      if (
        keys.has(key) ||
        key === actionKey(action.id) ||
        id.sequence === 0n ||
        (id.actor === action.id.actor && id.sequence >= action.id.sequence)
      )
        return 'actor-chain';
      keys.add(key);
    }
    if (
      action.id.sequence > 1n &&
      !keys.has(
        actionKey({
          actor: action.id.actor,
          sequence: action.id.sequence - 1n,
        }),
      )
    )
      return 'actor-chain';
    return null;
  }
}
