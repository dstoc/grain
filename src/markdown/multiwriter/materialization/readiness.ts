import { ActionStore } from '../actions/store.js';
import type {
  ActionFact,
  ActionStoreSnapshot,
  ActionVariant,
  QuarantineReason,
} from '../actions/store.js';
import { actionKey, validReferencesSteps } from '../actions/references.js';
import type { ActionEnvelope, ActionId, ActionReadiness } from '../contracts.js';
import { compareActions } from '../contracts.js';
import type { Work } from '../ingest/work.js';

interface Certificate {
  readonly variant: ActionVariant;
  readonly dependencies: readonly Certificate[];
}
export interface ReadinessWork {
  factsChanged: number;
  entriesEvaluated: number;
  dependencyEdges: number;
  closureEdges: number;
  authorChecks: number;
  snapshotExports: number;
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
 * Detached snapshot exports and new-author closure checks remain explicit full-array costs.
 */
export class IndexedActionStore extends ActionStore {
  private readonly changed = new Set<string>();
  private readonly known = new Map<string, ActionFact>();
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
    snapshotExports: 0,
  };
  readinessDiagnostics(): Readonly<ReadinessWork> {
    return { ...this.counts };
  }
  protected override factChanged(fact: ActionFact): void {
    const key = actionKey(fact.id);
    this.known.set(key, fact);
    this.changed.add(key);
    this.counts.factsChanged++;
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
  protected override *calculate(): Work<ActionStoreSnapshot> {
    yield* this.decodePending();
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
      const closure = new Map<string, ActionEnvelope>();
      const ancestors = [...dependencies];
      while (ancestors.length) {
        yield;
        this.counts.closureEdges++;
        const id = ancestors.pop()!,
          ancestorKey = actionKey(id);
        if (closure.has(ancestorKey)) continue;
        const ancestor = this.ready.get(ancestorKey)!;
        closure.set(ancestorKey, ancestor);
        ancestors.push(...ancestor.dependencies);
      }
      const causalBase = [...closure.values()].sort(compareActions);
      let reason: QuarantineReason | null;
      if (!(yield* validReferencesSteps(action, causalBase, this.options.genesisAllocations)))
        reason = 'reference';
      else {
        this.counts.authorChecks++;
        const result = this.options.validate(structuredClone(action), {
          dependencies: structuredClone(causalBase),
        });
        reason = typeof result === 'object' && result !== null ? yield* result : result;
      }
      this.states.set(key, reason ? quarantine(reason) : { state: 'ready' });
      if (!reason) {
        this.ready.set(key, action);
        this.certified.set(key, { variant, dependencies: dependencyCertificates });
      }
    }
    // Cancellation retains the complete dirty closure. It is safe to keep completed
    // immutable certificates, but no partial readiness result can escape.
    this.changed.clear();
    const ready = [...this.ready.values()].sort(compareActions);
    const heads = new Map(ready.map((action) => [actionKey(action.id), action.id]));
    for (const action of ready)
      for (const id of action.dependencies) {
        yield;
        heads.delete(actionKey(id));
      }
    const status = this.factStatus();
    this.counts.snapshotExports++;
    return structuredClone({
      actions: [...this.known.values()]
        .sort((a, b) => compareIds(a.id, b.id))
        .map((fact) => ({
          id: fact.id,
          variants: fact.variants.map((variant) => variant.bytes),
          readiness: this.states.get(actionKey(fact.id))!,
        })),
      ready: status.integrity ? ready : [],
      heads: status.integrity ? [...heads.values()] : [],
      ...status,
    });
  }
  override destroy(): void {
    super.destroy();
    this.changed.clear();
    this.known.clear();
    this.readers.clear();
    this.states.clear();
    this.ready.clear();
    this.certified.clear();
  }
}
