import { ActionStore } from '../actions/store.js';
import { compareBytes } from '../actions/cbor.js';
import { encodeEnvelope } from '../actions/codec.js';
import { assertLimit, compute, finish } from '../ingest/work.js';
import type { Computation } from '../ingest/work.js';
import * as persistent from './map.js';
import type { MapRoot } from './map.js';
import type {
  ActionFact,
  ActionStoreSnapshot,
  ActionVariant,
  QuarantineReason,
  StoredAction,
  ActionValidationContext,
} from '../actions/store.js';
import { actionKey, validCertifiedReferencesSteps } from '../actions/references.js';
import { groupKey } from '../visibility/identity.js';
import { registerReadySource } from '../authoring/ready-source.js';
import { MaterializedReadyIndex } from './ready-index.js';
import type { ActionEnvelope, ActionId, ActionReadiness, Allocation } from '../contracts.js';
import { compareActions } from '../contracts.js';
import type { Work } from '../ingest/work.js';

interface Certificate {
  readonly token: object;
  variant: ActionVariant;
  readonly dependencies: readonly Certificate[];
  readonly resources: ReadonlyMap<number, Allocation>;
  readonly seals?: MapRoot<boolean>;
  after?: MapRoot<Certificate>;
}
const emptyPast = Object.freeze({});
const identities = new WeakMap<object, object>();
function identity(root: object | undefined): object {
  if (!root) return emptyPast;
  let token = identities.get(root);
  if (!token) identities.set(root, (token = Object.freeze({})));
  return token;
}
function* entries<T>(root: MapRoot<T> | undefined): Generator<readonly [string, T]> {
  if (!root) return;
  yield* entries(root.left);
  yield [root.key, root.value];
  yield* entries(root.right);
}
export interface ReadinessWork {
  factsChanged: number;
  entriesEvaluated: number;
  dependencyEdges: number;
  closureEdges: number;
  authorChecks: number;
  fullSnapshotBuilds: number;
  frontierEntries: number;
  localCertificatesReused: number;
  variantEntriesUpdated: number;
  headCandidatesEvaluated: number;
  headDependencyEdges: number;
  orderedReadyActionsVisited: number;
}
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
const quarantine = (reason: QuarantineReason): ActionReadiness => ({
  state: 'quarantined',
  reason,
});

/** Incremental readiness over retained decoded facts. No canonical writes, no fact pruning.
 * The reference ActionStore.calculate remains a separate full-scan oracle.
 * Public snapshot exports and new-author closure checks remain explicit full-array costs.
 */
/** Borrowed immutable facts for trusted derived readers. Never expose these through
 * public snapshots or validators. Native byte arrays remain privately owned by the store.
 */
export interface ReadyActionView {
  readonly ready: readonly ActionEnvelope[];
  readonly heads: readonly ActionId[];
  readonly integrity: boolean;
  readonly variants: Pick<ReadonlyMap<string, Uint8Array>, 'get'>;
}
interface ReadyState extends ReadyActionView {
  readonly records?: MapRoot<StoredAction>;
  readonly diagnostics: readonly string[];
}
function mapComputation<A, B>(state: Computation<A>, map: (value: A) => B): Computation<B> {
  if (state.state === 'complete') return { state: 'complete', value: map(state.value) };
  return {
    state: 'deferred',
    continuation: {
      cancel: () => state.continuation.cancel(),
      resume: (budget) => mapComputation(state.continuation.resume(budget), map),
    },
  };
}
/** Escaping readers capture only the immutable payload root, not a calculation. */
function payloadView(root: MapRoot<Uint8Array> | undefined) {
  return { get: (key: string) => persistent.get(root, key) };
}

export class IndexedActionStore extends ActionStore {
  private memo?: { readonly version: number; readonly value: ReadyState };
  private running?: Work<ReadyState>;
  private generation = 0;
  private records?: MapRoot<StoredAction>;
  private variants?: MapRoot<Uint8Array>;
  private heads = new persistent.PersistentMap<ActionId>();
  private readonly changed = new Set<string>();
  private certificateIndex?: MapRoot<Certificate>;
  private staged?: Certificate;
  private rebuildReaders = false;
  private readonly readyOwner = {};
  private readyIndex = new MaterializedReadyIndex(this.readyOwner);
  private readonly genesisResources = new Map(
    this.options.genesisAllocations.map((a) => [a.id.ordinal, a]),
  );
  private readonly readers = new Map<string, Set<string>>();
  private readonly states = new Map<string, ActionReadiness>();
  private readonly ready = new Map<string, ActionEnvelope>();
  private readonly certified = new Map<string, Certificate>();
  private readonly counts: ReadinessWork = {
    factsChanged: 0,
    entriesEvaluated: 0,
    dependencyEdges: 0,
    closureEdges: 0,
    authorChecks: 0,
    fullSnapshotBuilds: 0,
    frontierEntries: 0,
    localCertificatesReused: 0,
    variantEntriesUpdated: 0,
    headCandidatesEvaluated: 0,
    headDependencyEdges: 0,
    orderedReadyActionsVisited: 0,
  };
  readinessDiagnostics(): Readonly<ReadinessWork> {
    return { ...this.counts };
  }
  protected override factChanged(fact: ActionFact): void {
    this.counts.factsChanged++;
    this.invalidate(fact);
  }
  private invalidate(fact: ActionFact): void {
    const key = actionKey(fact.id);
    this.changed.add(key);
    // Include every retained variant. Extra edges after a fork are conservative;
    // removing edges could lose invalidation through a previously ready variant.
    for (const variant of fact.variants)
      for (const id of variant.envelope?.dependencies ?? []) {
        const dependency = actionKey(id);
        let readers = this.readers.get(dependency);
        if (!readers) this.readers.set(dependency, (readers = new Set()));
        readers.add(key);
      }
  }
  /** Internal reads avoid detached diagnostic exports. Receipt/limit changes and
   * replacement computations invalidate suspended work exactly as public compute does.
   */
  readReady(): ReadyActionView {
    let result = this.computeReady(Number.MAX_SAFE_INTEGER);
    while (result.state === 'deferred')
      result = result.continuation.resume(Number.MAX_SAFE_INTEGER);
    return result.value;
  }
  computeReady(operations?: number): Computation<ReadyState> {
    this.cancelRead();
    const version = this.factsVersion,
      generation = this.generation;
    if (this.memo?.version === version) {
      // Validate the caller's budget even for a completed memoized result.
      if (operations !== undefined) assertLimit(operations);
      return { state: 'complete', value: this.memo.value };
    }
    const work = this.calculateReady(version);
    this.running = work;
    return compute(
      work,
      operations,
      () => this.factsVersion === version && this.generation === generation,
    );
  }
  override snapshot(): ActionStoreSnapshot {
    return this.exportSnapshot(this.readReady() as ReadyState);
  }
  override compute(operations?: number): Computation<ActionStoreSnapshot> {
    return mapComputation(this.computeReady(operations), (value) => this.exportSnapshot(value));
  }
  override setDecodeLimits(limits: { depth?: number; operations?: number }): void {
    this.cancelRead();
    this.memo = undefined;
    super.setDecodeLimits(limits);
  }
  private cancelRead(): void {
    this.generation++;
    this.running?.return(undefined as unknown as ReadyState);
    this.running = undefined;
  }
  private exportSnapshot(view: ReadyState): ActionStoreSnapshot {
    this.counts.fullSnapshotBuilds++;
    const actions: StoredAction[] = [];
    const visit = (root: MapRoot<StoredAction> | undefined) => {
      if (!root) return;
      visit(root.left);
      actions.push(root.value);
      visit(root.right);
    };
    visit(view.records);
    actions.sort((a, b) => compareIds(a.id, b.id));
    return structuredClone({
      actions,
      ready: view.ready,
      heads: view.heads,
      diagnostics: view.diagnostics,
      integrity: view.integrity,
    });
  }
  override checkLocal(action: ActionEnvelope): QuarantineReason | null {
    const bytes = encodeEnvelope(action);
    const view = this.readReady();
    if (!view.integrity) return 'reference';
    const key = actionKey(action.id),
      existing = this.fact(key);
    if (existing)
      return this.states.get(key)?.state === 'ready' &&
        existing.variants.length === 1 &&
        compareBytes(existing.variants[0].bytes, bytes) === 0
        ? null
        : 'reference';
    const reason = finish(this.chainError(action));
    if (reason) return reason;
    if (action.dependencies.some((id) => !this.ready.has(actionKey(id)))) return 'reference';
    const maximum = action.dependencies.reduce((max, id) => {
      const time = this.ready.get(actionKey(id))!.lamport;
      return time > max ? time : max;
    }, 0n);
    if (action.lamport !== maximum + 1n) return 'actor-chain';
    const candidate = finish(this.candidate({ bytes, envelope: structuredClone(action) }));
    if (!finish(validCertifiedReferencesSteps(action, candidate.context.indexed!.past)))
      return 'reference';
    const validation = this.options.validate(structuredClone(action), candidate.context);
    const failure =
      typeof validation === 'object' && validation !== null ? finish(validation) : validation;
    if (!failure) this.staged = candidate.certificate;
    return failure;
  }
  private *candidate(
    variant: ActionVariant,
  ): Work<{ readonly certificate: Certificate; readonly context: ActionValidationContext }> {
    const action = variant.envelope!;
    const dependencies = action.dependencies.map((id) => this.certified.get(actionKey(id))!);
    let past: MapRoot<Certificate> | undefined, seals: MapRoot<boolean> | undefined;
    for (const dependency of dependencies) {
      yield;
      if (!past) past = dependency.after;
      else if (past !== dependency.after)
        for (const [actor, certificate] of entries(dependency.after)) {
          yield;
          this.counts.frontierEntries++;
          if (
            (persistent.get(past, actor)?.variant.envelope!.id.sequence ?? 0n) <
            certificate.variant.envelope!.id.sequence
          )
            past = persistent.set(past, actor, certificate);
        }
      if (!seals) seals = dependency.seals;
      else if (seals !== dependency.seals)
        for (const [key] of entries(dependency.seals)) {
          yield;
          seals = persistent.set(seals, key, true);
        }
    }
    const index = this.certificateIndex;
    const contains = (id: ActionId) =>
      id.sequence > 0n &&
      (persistent.get(past, id.actor)?.variant.envelope!.id.sequence ?? 0n) >= id.sequence;
    const certificate: Certificate = {
      token: Object.freeze({}),
      variant,
      dependencies,
      resources: new Map(
        action.allocations.map((allocation) => [allocation.id.ordinal, allocation]),
      ),
      seals: action.effects.reduce(
        (root, effect) =>
          effect.type === 'SetGroupActive'
            ? persistent.set(root, groupKey(effect.group), true)
            : root,
        seals,
      ),
    };
    certificate.after = persistent.set(past, action.id.actor, certificate);
    let detached: readonly ActionEnvelope[] | undefined;
    const context: ActionValidationContext = {
      get dependencies() {
        return (detached ??= structuredClone(finish(closure())));
      },
      indexed: {
        past: {
          identity: identity(past),
          contains,
          allocation: (id) => {
            const allocation =
              id.birth.type === 'genesis'
                ? id.birth.genesisId === this.options.genesisId
                  ? this.genesisResources.get(id.ordinal)
                  : undefined
                : contains(id.birth.action)
                  ? persistent.get(index, actionKey(id.birth.action))?.resources.get(id.ordinal)
                  : undefined;
            return allocation?.id.kind === id.kind ? structuredClone(allocation) : undefined;
          },
          groupSealed: (group) => persistent.get(seals, groupKey(group)) === true,
        },
        resultIdentity: identity(certificate.after),
        dependencies: Object.freeze(dependencies.map((certificate) => certificate.token)),
      },
    };
    const closure = () => this.closure(dependencies);
    return { certificate, context };
  }
  private *closure(dependencies: readonly Certificate[]): Work<readonly ActionEnvelope[]> {
    const closure = new Map<string, ActionEnvelope>();
    const ancestors = [...dependencies];
    while (ancestors.length) {
      yield;
      this.counts.closureEdges++;
      const certificate = ancestors.pop()!,
        ancestor = certificate.variant.envelope!;
      const key = actionKey(ancestor.id);
      if (closure.has(key)) continue;
      closure.set(key, ancestor);
      ancestors.push(...certificate.dependencies);
    }
    return [...closure.values()].sort(compareActions);
  }
  private *calculateReady(version: number): Work<ReadyState> {
    yield* this.decodePending();
    if (this.rebuildReaders) {
      for (const fact of this.retainedFacts()) {
        yield;
        this.invalidate(fact);
      }
      this.rebuildReaders = false;
    }
    const affected = new Set<string>();
    const stack = [...this.changed];
    while (stack.length) {
      yield;
      const key = stack.pop()!;
      if (affected.has(key)) continue;
      affected.add(key);
      for (const reader of this.readers.get(key) ?? []) {
        yield;
        this.counts.dependencyEdges++;
        stack.push(reader);
      }
    }
    const candidates: ActionEnvelope[] = [];
    // Establish intrinsic failures first, before dependency propagation. This also
    // gives impossible forward edges the same precedence as the full reference.
    for (const key of affected) {
      yield;
      this.counts.entriesEvaluated++;
      this.ready.delete(key);
      this.states.delete(key);
      const fact = this.fact(key)!;
      const variant = fact.variants[0];
      if (fact.variants.length > 1) this.states.set(key, quarantine('fork'));
      else if (!variant.envelope) this.states.set(key, quarantine(variant.reason!));
      else {
        const action = variant.envelope;
        let reason = yield* this.chainError(action);
        // Known noncausal edges are rejected even if their target is not ready.
        if (!reason)
          for (const id of action.dependencies) {
            yield;
            this.counts.dependencyEdges++;
            const dependency = this.fact(actionKey(id));
            if (
              dependency?.variants.length === 1 &&
              dependency.variants[0].envelope &&
              dependency.variants[0].envelope.lamport >= action.lamport
            )
              reason = 'actor-chain';
          }
        if (reason) this.states.set(key, quarantine(reason));
        else candidates.push(action);
      }
    }
    candidates.sort(compareActions);
    for (const action of candidates) {
      yield;
      const key = actionKey(action.id);
      const dependencies = [...action.dependencies].sort(compareIds);
      const invalid = dependencies
        .map((id) => this.states.get(actionKey(id)))
        .find((state) => state?.state === 'quarantined');
      if (invalid?.state === 'quarantined') {
        this.states.set(key, quarantine(invalid.reason));
        continue;
      }
      const missing = new Map<string, ActionId>();
      for (const id of dependencies) {
        yield;
        this.counts.dependencyEdges++;
        const state = this.states.get(actionKey(id));
        if (!state) missing.set(actionKey(id), id);
        else if (state.state === 'pending')
          for (const absent of state.missing) {
            yield;
            missing.set(actionKey(absent), absent);
          }
      }
      if (missing.size) {
        this.states.set(key, { state: 'pending', missing: [...missing.values()].sort(compareIds) });
        continue;
      }
      const maximum = dependencies.reduce((max, id) => {
        const time = this.ready.get(actionKey(id))!.lamport;
        return time > max ? time : max;
      }, 0n);
      if (action.lamport !== maximum + 1n) {
        this.states.set(key, quarantine('actor-chain'));
        continue;
      }
      const variant = this.fact(key)!.variants[0];
      const dependencyCertificates = dependencies.map((id) => this.certified.get(actionKey(id))!);
      const prior = this.certified.get(key);
      if (
        prior?.variant === variant &&
        prior.dependencies.length === dependencyCertificates.length &&
        dependencyCertificates.every(
          (certificate, index) => certificate === prior.dependencies[index],
        )
      ) {
        this.states.set(key, { state: 'ready' });
        this.ready.set(key, action);
        continue;
      }
      const staged = this.staged;
      let certificate: Certificate;
      let reason: QuarantineReason | null;
      if (
        staged &&
        compareBytes(staged.variant.bytes, variant.bytes) === 0 &&
        staged.dependencies.length === dependencyCertificates.length &&
        dependencyCertificates.every((value, index) => value === staged.dependencies[index])
      ) {
        certificate = staged;
        this.counts.localCertificatesReused++;
        reason = null;
      } else {
        const candidate = yield* this.candidate(variant);
        certificate = candidate.certificate;
        if (!(yield* validCertifiedReferencesSteps(action, candidate.context.indexed!.past)))
          reason = 'reference';
        else {
          this.counts.authorChecks++;
          const result = this.options.validate(structuredClone(action), candidate.context);
          reason = typeof result === 'object' && result !== null ? yield* result : result;
        }
      }
      this.states.set(key, reason ? quarantine(reason) : { state: 'ready' });
      if (!reason) {
        this.ready.set(key, action);
        // Remember the canonical decoded variant for the direct certificate reuse check.
        certificate.variant = variant;
        this.certified.set(key, certificate);
        this.certificateIndex = persistent.set(this.certificateIndex, key, certificate);
      }
    }
    // Capture only changed records in persistent roots. Older read views remain
    // coherent through later forks, cancellation, decoder retries and public exports.
    for (const key of affected) {
      yield;
      const fact = this.fact(key)!;
      this.records = persistent.set(this.records, key, {
        id: fact.id,
        variants: fact.variants.map((variant) => variant.bytes),
        readiness: this.states.get(key)!,
      });
    }
    const ready = [...this.ready.values()].sort(compareActions);
    this.counts.orderedReadyActionsVisited += ready.length;
    let variants = this.variants;
    const heads = this.heads.fork(),
      headCandidates = new Map<string, ActionId>();
    for (const key of affected) {
      yield;
      const previous = this.readyIndex.get(key),
        action = this.ready.get(key);
      variants = action
        ? persistent.set(variants, key, this.fact(key)!.variants[0].bytes)
        : persistent.remove(variants, key);
      this.counts.variantEntriesUpdated++;
      for (const entry of [previous, action]) {
        if (!entry) continue;
        headCandidates.set(actionKey(entry.id), entry.id);
        for (const id of entry.dependencies) {
          yield;
          this.counts.headDependencyEdges++;
          headCandidates.set(actionKey(id), id);
        }
      }
    }
    for (const [key, id] of headCandidates) {
      yield;
      this.counts.headCandidatesEvaluated++;
      let depended = false;
      if (this.ready.has(key))
        for (const reader of this.readers.get(key) ?? []) {
          yield;
          this.counts.headDependencyEdges++;
          // Reverse edges retain old variants conservatively. Only a current ready
          // payload's actual dependencies can suppress this head.
          if (this.ready.get(reader)?.dependencies.some((id) => actionKey(id) === key)) {
            depended = true;
            break;
          }
        }
      if (this.ready.has(key) && !depended) heads.set(key, id);
      else heads.delete(key);
    }
    const status = this.factStatus();
    const value: ReadyState = {
      records: this.records,
      ready: status.integrity ? ready : [],
      heads: status.integrity
        ? [...heads.values()].sort((a, b) =>
            compareActions(this.ready.get(actionKey(a))!, this.ready.get(actionKey(b))!),
          )
        : [],
      variants: payloadView(status.integrity ? variants : undefined),
      integrity: status.integrity,
      diagnostics: status.diagnostics.slice(),
    };
    const changes = new Map<string, ActionEnvelope | undefined>();
    if (status.integrity)
      for (const key of affected) {
        yield;
        changes.set(key, this.ready.get(key));
      }
    const readyIndex = status.integrity
      ? yield* this.readyIndex.refineSteps(changes, ready.at(-1)?.lamport ?? 0n)
      : new MaterializedReadyIndex(this.readyOwner);
    registerReadySource(value.ready, readyIndex);
    this.readyIndex = readyIndex;
    this.variants = status.integrity ? variants : undefined;
    this.heads = status.integrity ? heads : new persistent.PersistentMap();
    // Cancellation retains the entire dirty closure until the coherent read exists.
    this.changed.clear();
    this.memo = { version, value };
    return value;
  }
  /** Drop only derived readiness state. Canonical payloads, decoded facts and
   * undecoded ingress remain in ActionStore. The next read certifies them again.
   */
  evict(): void {
    this.cancelRead();
    this.memo = undefined;
    this.records = undefined;
    this.variants = undefined;
    this.heads = new persistent.PersistentMap();
    this.readyIndex = new MaterializedReadyIndex(this.readyOwner);
    this.certificateIndex = undefined;
    this.staged = undefined;
    this.changed.clear();
    this.readers.clear();
    this.states.clear();
    this.ready.clear();
    this.certified.clear();
    for (const fact of this.retainedFacts()) this.changed.add(actionKey(fact.id));
    this.rebuildReaders = true;
  }
  /** Counts of direct cache entries, not transitive heap or canonical byte sizes. */
  cacheDiagnostics() {
    return {
      certificates: this.certified.size,
      stagedCertificates: Number(this.staged !== undefined),
      records: this.states.size,
      ready: this.ready.size,
      dependencySources: this.readers.size,
      dirtyFacts: this.changed.size,
    };
  }
  override destroy(): void {
    this.cancelRead();
    this.memo = undefined;
    this.records = undefined;
    this.variants = undefined;
    this.heads = new persistent.PersistentMap();
    this.readyIndex = new MaterializedReadyIndex(this.readyOwner);
    this.certificateIndex = undefined;
    this.staged = undefined;
    super.destroy();
    this.changed.clear();
    this.readers.clear();
    this.states.clear();
    this.ready.clear();
    this.certified.clear();
  }
}
