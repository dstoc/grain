import * as Y from 'yjs';
import { expect, test, vi } from 'vitest';
import { ActionStore } from '../actions/store.js';
import type { ActionStoreOptions, ActionValidationContext, ActionFact } from '../actions/store.js';
import type { ActionEnvelope } from '../contracts.js';
import { A, B, C, action } from '../actions/test-fixtures.js';
import { encodeEnvelope } from '../actions/codec.js';
import { decodeCbor, encodeCbor } from '../actions/cbor.js';
import { IndexedActionStore } from './readiness.js';
import { SeededRandom } from '../../../../test/multiwriter/network.js';
import { actionKey } from '../actions/references.js';

const options: ActionStoreOptions = {
  documentId: 'D',
  genesisId: 'G',
  genesisAllocations: [],
  validate: () => null,
};
function pair() {
  const indexed = new IndexedActionStore(options),
    reference = new ActionStore(options);
  const equal = () => expect(indexed.snapshot()).toEqual(reference.snapshot());
  return {
    indexed,
    reference,
    equal,
    append(a: ActionEnvelope) {
      indexed.append(a);
      reference.append(a);
      equal();
    },
    bytes(bytes: Uint8Array) {
      indexed.appendEncoded(bytes);
      reference.appendEncoded(bytes);
      equal();
    },
    close() {
      indexed.destroy();
      reference.destroy();
    },
  };
}
test('revisits missing dependents, then withdraws only forked descendants', () => {
  const p = pair();
  const a = action(A),
    b = action(B, 1n, [a]),
    c = action(C, 1n, [b]);
  try {
    p.append(c);
    p.append(b);
    p.append(action(B, 3n));
    p.append(a);
    expect(p.indexed.snapshot().ready).toHaveLength(3);
    p.append({ ...a, groupId: { ...a.groupId, sequence: 12n } });
    expect(p.indexed.snapshot().ready).toHaveLength(0);
    p.append(action(C, 2n, [c]));
  } finally {
    p.close();
  }
});
test('matches intrinsic failure and propagated reason precedence, including cycles', () => {
  const p = pair();
  try {
    const a = action(A),
      b = action(B);
    p.append({ ...a, dependencies: [b.id], lamport: 1n });
    p.append({ ...b, dependencies: [a.id], lamport: 2n });
    p.append(action(C, 1n, [a, b]));
    const wire = decodeCbor(encodeEnvelope(action(A, 2n, [a]))) as Record<string, never>;
    p.bytes(encodeCbor({ ...wire, protocolVersion: 4n }));
    p.bytes(Uint8Array.of(255));
    p.append({ ...a, documentId: 'other' });
  } finally {
    p.close();
  }
});
for (const seed of [1, 7, 42, 85, 89, 34064, 123456, 0xffffffff])
  test(`equals full readiness after every generated receipt: ${seed}`, () => {
    const random = new SeededRandom(seed),
      p = pair(),
      actions: ActionEnvelope[] = [];
    const previous = new Map<string, ActionEnvelope>();
    const actors = [A, B, C];
    try {
      for (let i = 0; i < 30; i++) {
        const actor = actors[random.next(actors.length)],
          prior = previous.get(actor);
        const dependencies = prior ? [prior] : [];
        if (actions.length) {
          const peer = actions[random.next(actions.length)];
          if (!dependencies.includes(peer)) dependencies.push(peer);
        }
        const next = action(actor, (prior?.id.sequence ?? 0n) + 1n, dependencies);
        actions.push(next);
        previous.set(actor, next);
      }
      const deliveries = [
        ...actions,
        ...actions.filter((_, i) => i % 4 === 0),
        ...actions.filter((_, i) => i % 7 === 0).map((a) => ({ ...a, lamport: a.lamport + 5n })),
      ];
      while (deliveries.length) p.append(deliveries.splice(random.next(deliveries.length), 1)[0]);
      const cold = new IndexedActionStore(options);
      try {
        cold.applyUpdate(p.indexed.encodeUpdate());
        expect(cold.snapshot()).toEqual(p.reference.snapshot());
      } finally {
        cold.destroy();
      }
    } finally {
      p.close();
    }
  }, 20000);
test('an ordinary suffix evaluates only its new entry; duplicates evaluate no entries', () => {
  const indexed = new IndexedActionStore(options);
  try {
    let last = action();
    for (let i = 0; i < 150; i++) {
      indexed.append(last);
      indexed.snapshot();
      last = action(A, last.id.sequence + 1n, [last]);
    }
    const before = indexed.readinessDiagnostics();
    indexed.append(last);
    indexed.snapshot();
    const after = indexed.readinessDiagnostics();
    expect(after.entriesEvaluated - before.entriesEvaluated).toBe(1);
    expect(after.authorChecks - before.authorChecks).toBe(1);
    indexed.append(last);
    indexed.snapshot();
    expect(indexed.readinessDiagnostics().entriesEvaluated).toBe(after.entriesEvaluated);
    indexed.snapshot();
    expect(indexed.readinessDiagnostics().entriesEvaluated).toBe(after.entriesEvaluated);
    expect(after.closureEdges - before.closureEdges).toBe(0);
    expect(after.frontierEntries - before.frontierEntries).toBe(0);
  } finally {
    indexed.destroy();
  }
}, 20000);
test('cancellation at each readiness yield cannot leak partial readiness or lose invalidation', () => {
  const a = action(A),
    b = action(B, 1n, [a]),
    c = action(C, 1n, [b]);
  for (let budget = 0; budget < 100; budget++) {
    const indexed = new IndexedActionStore(options),
      reference = new ActionStore(options);
    try {
      for (const store of [indexed, reference]) {
        store.append(a);
        store.append(b);
        store.append(c);
        store.snapshot();
      }
      const fork = { ...a, lamport: 3n };
      indexed.append(fork);
      reference.append(fork);
      const state = indexed.compute(budget);
      if (state.state === 'deferred') state.continuation.cancel();
      expect(indexed.snapshot(), `budget ${budget}`).toEqual(reference.snapshot());
    } finally {
      indexed.destroy();
      reference.destroy();
    }
  }
});
test('changed receipts and decoder limits invalidate held continuations', () => {
  const p = pair();
  try {
    p.append(action());
    p.indexed.append(action(A, 2n, [action()]));
    const first = p.indexed.compute(1);
    expect(first.state).toBe('deferred');
    p.indexed.append(action(B));
    if (first.state === 'deferred')
      expect(() => first.continuation.resume()).toThrow(/invalidated/);
    const second = p.indexed.compute(0);
    p.indexed.setDecodeLimits({ operations: 1000000 });
    if (second.state === 'deferred')
      expect(() => second.continuation.resume()).toThrow(/invalidated/);
    p.reference.applyUpdate(p.indexed.encodeUpdate());
    p.equal();
  } finally {
    p.close();
  }
});
test('pending outer prefixes and carrier integrity match the full reference', () => {
  const source = new ActionStore(options),
    p = pair();
  try {
    source.append(action());
    const prefix = source.encodeUpdate(),
      vector = source.encodeStateVector();
    source.append(action(A, 2n, [action()]));
    const tail = source.encodeUpdate(vector);
    for (const s of [p.indexed, p.reference]) s.applyUpdate(tail);
    p.equal();
    for (const s of [p.indexed, p.reference]) s.applyUpdate(prefix);
    p.equal();
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, source.encodeUpdate());
      doc.getArray('envelopes').delete(0, 1);
      for (const s of [p.indexed, p.reference])
        expect(() => s.applyUpdate(Y.encodeStateAsUpdate(doc))).toThrow();
      p.equal();
    } finally {
      doc.destroy();
    }
  } finally {
    source.destroy();
    p.close();
  }
});
test('validator failure and cancelled certification remain retryable with detached facts', () => {
  let fail = true;
  const validate = vi.fn<ActionStoreOptions['validate']>((candidate, context) => {
    if (fail) throw new Error('host failure');
    // A validator cannot corrupt the retained fact or another author's closure.
    (candidate as { documentId: string }).documentId = 'mutated';
    if (context.dependencies[0])
      (context.dependencies[0] as { documentId: string }).documentId = 'mutated';
    return null;
  });
  const store = new IndexedActionStore({ ...options, validate });
  try {
    store.append(action());
    expect(() => store.snapshot()).toThrow('host failure');
    fail = false;
    expect(store.snapshot().ready).toEqual([action()]);
    store.append(action(A, 2n, [action()]));
    expect(store.snapshot().ready.every((a) => a.documentId === 'D')).toBe(true);
    const exported = store.snapshot();
    exported.ready[0].nativeInsertUpdates.forEach((bytes) => bytes.fill(0));
    (exported.ready[0] as { documentId: string }).documentId = 'export mutation';
    expect(store.snapshot().ready[0].documentId).toBe('D');
  } finally {
    store.destroy();
  }
});

test('internal reads retain immutable payload identities while every public export is detached', () => {
  const p = pair();
  try {
    const a = action(),
      b = action(A, 2n, [a]);
    p.indexed.append(a);
    const first = p.indexed.readReady();
    const before = p.indexed.readinessDiagnostics();
    expect(p.indexed.readReady()).toBe(first);
    p.indexed.append(b);
    const second = p.indexed.readReady();
    expect(second.ready[0]).toBe(first.ready[0]);
    expect(second.variants.get(`${A}:1`)).toBe(first.variants.get(`${A}:1`));
    expect(p.indexed.readinessDiagnostics().fullSnapshotBuilds).toBe(before.fullSnapshotBuilds);
    const exported = p.indexed.snapshot();
    (exported.ready[0] as { documentId: string }).documentId = 'corruption';
    exported.actions[0].variants[0].fill(0);
    expect(p.indexed.readReady()).toBe(second);
    expect(second.ready[0].documentId).toBe('D');
    p.indexed.append({ ...a, lamport: 12n });
    expect(p.indexed.readReady().ready).toHaveLength(0);
    expect(first.ready).toEqual([a]);
    expect(second.ready).toEqual([a, b]);
    p.reference.applyUpdate(p.indexed.encodeUpdate());
    p.equal();
  } finally {
    p.close();
  }
});

test('warm readiness updates only changed payload/head metadata while retaining ordered diagnostic cost', () => {
  const p = pair(),
    actions: ActionEnvelope[] = [];
  try {
    for (let i = 0; i < 1000; i++) {
      const next = action(A, BigInt(i + 1), actions.length ? [actions.at(-1)!] : []);
      actions.push(next);
      p.indexed.append(next);
    }
    const before = p.indexed.readReady(),
      counts = p.indexed.readinessDiagnostics();
    const next = action(A, 1001n, [actions.at(-1)!]);
    p.indexed.append(next);
    const facts = vi.spyOn(
      p.indexed as unknown as { fact(key: string): ActionFact | undefined },
      'fact',
    );
    let after: ReturnType<IndexedActionStore['readReady']>;
    try {
      after = p.indexed.readReady();
      expect(facts.mock.calls.length).toBeLessThan(30);
    } finally {
      facts.mockRestore();
    }
    const current = p.indexed.readinessDiagnostics();
    expect(current.variantEntriesUpdated - counts.variantEntriesUpdated).toBe(1);
    expect(current.headCandidatesEvaluated - counts.headCandidatesEvaluated).toBe(2);
    expect(current.headDependencyEdges - counts.headDependencyEdges).toBeLessThan(5);
    expect(current.orderedReadyActionsVisited - counts.orderedReadyActionsVisited).toBe(1001);
    expect(after.heads).toEqual([next.id]);
    expect(before.heads).toEqual([actions.at(-1)!.id]);
    expect(before.variants.get(actionKey(next.id))).toBeUndefined();
    expect(after.variants.get(actionKey(actions[0].id))).toBe(
      before.variants.get(actionKey(actions[0].id)),
    );
    const peer = action(B);
    p.indexed.append(peer);
    expect(p.indexed.readReady().heads).toEqual([peer.id, next.id]);
    p.indexed.append({ ...actions[499], groupId: { ...actions[499].groupId, sequence: 99n } });
    const withdrawn = p.indexed.readReady();
    expect(withdrawn.heads).toEqual([peer.id, actions[498].id]);
    expect(withdrawn.variants.get(actionKey(actions[499].id))).toBeUndefined();
    expect(after.variants.get(actionKey(actions[499].id))).toBeDefined();
    p.reference.applyUpdate(p.indexed.encodeUpdate());
    p.equal();
    p.indexed.evict();
    p.equal();
    expect(before.heads).toEqual([actions.at(-1)!.id]);
  } finally {
    p.close();
  }
});

test('cancelled metadata candidates cannot change held payload roots or head order', () => {
  const p = pair(),
    a = action(),
    b = action(B, 1n, [a]);
  try {
    p.append(a);
    const before = p.indexed.readReady(),
      counts = p.indexed.readinessDiagnostics();
    p.indexed.append(b);
    let work = p.indexed.computeReady(0);
    for (
      let i = 0;
      p.indexed.readinessDiagnostics().variantEntriesUpdated === counts.variantEntriesUpdated &&
      i < 10000;
      i++
    ) {
      if (work.state !== 'deferred') throw new Error('Metadata probe published early');
      work = work.continuation.resume(1);
    }
    expect(p.indexed.readinessDiagnostics().variantEntriesUpdated).toBe(
      counts.variantEntriesUpdated + 1,
    );
    expect(before.variants.get(actionKey(b.id))).toBeUndefined();
    expect(before.heads).toEqual([a.id]);
    if (work.state !== 'deferred') throw new Error('Expected unpublished metadata');
    work.continuation.cancel();
    p.reference.append(b);
    p.equal();
    expect(p.indexed.readReady().heads).toEqual([b.id]);
    expect(before.heads).toEqual([a.id]);
    expect(before.variants.get(actionKey(b.id))).toBeUndefined();
  } finally {
    p.close();
  }
});

test('local certificates are reused only for exact bytes and exact dependency certificates', () => {
  const validate = vi.fn(() => null);
  const indexed = new IndexedActionStore({ ...options, validate });
  try {
    const a = action();
    expect(indexed.checkLocal(a)).toBeNull();
    indexed.append(a);
    indexed.readReady();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(indexed.readinessDiagnostics().localCertificatesReused).toBe(1);
    const b = action(A, 2n, [a]);
    expect(indexed.checkLocal(b)).toBeNull();
    const other = { ...b, groupId: { ...b.groupId, sequence: 3n } };
    indexed.append(other);
    indexed.readReady();
    expect(validate).toHaveBeenCalledTimes(3);
    expect(indexed.readinessDiagnostics().localCertificatesReused).toBe(1);
    const c = action(A, 3n, [other]);
    expect(indexed.checkLocal(c)).toBeNull();
    indexed.append({ ...a, lamport: 4n });
    indexed.append(c);
    expect(indexed.readReady().ready).toHaveLength(0);
  } finally {
    indexed.destroy();
  }
});

test('indexed causal resources exclude concurrent births and expose no retained mutable data', () => {
  const resource = (actor: typeof A, ordinal: number) => ({
    kind: 'deletion' as const,
    birth: { type: 'action' as const, action: { actor, sequence: 1n } },
    ordinal,
  });
  const a = { ...action(A), allocations: [{ type: 'deletion' as const, id: resource(A, 0) }] };
  const b = { ...action(B), allocations: [{ type: 'deletion' as const, id: resource(B, 0) }] };
  const validate: ActionStoreOptions['validate'] = (_action, context) => {
    if (_action.id.sequence !== 2n) return null;
    expect(context.indexed).toBeDefined();
    const past = context.indexed!.past;
    expect(past.contains(a.id)).toBe(true);
    expect(past.contains(b.id)).toBe(false);
    expect(past.allocation(resource(B, 0))).toBeUndefined();
    const allocation = past.allocation(resource(A, 0))!;
    (allocation.id as { ordinal: number }).ordinal = 100;
    expect(past.allocation(resource(A, 0))!.id.ordinal).toBe(0);
    expect(Object.keys(past.identity)).toEqual([]);
    expect(Object.isFrozen(context.indexed!.dependencies[0])).toBe(true);
    expect(Object.keys(context.indexed!.dependencies[0])).toEqual([]);
    return null;
  };
  const store = new IndexedActionStore({ ...options, validate });
  try {
    store.append(a);
    store.append(b);
    store.readReady();
    const valid = {
      ...action(A, 2n, [a]),
      effects: [{ type: 'DeleteText' as const, tag: resource(A, 0), observed: [] }],
    };
    expect(store.checkLocal(valid)).toBeNull();
    const invalid = { ...valid, effects: [{ ...valid.effects[0], tag: resource(B, 0) }] };
    expect(store.checkLocal(invalid)).toBe('reference');
    expect(store.readinessDiagnostics().closureEdges).toBe(0);
  } finally {
    store.destroy();
  }
});

test('a lazy compatibility closure remains exact after withdrawal and destruction', () => {
  const a = action(),
    b = action(A, 2n, [a]);
  let captured: ActionValidationContext | undefined;
  const store = new IndexedActionStore({
    ...options,
    validate: (candidate, context) => {
      if (candidate.id.sequence === 2n) captured = context;
      return null;
    },
  });
  store.append(a);
  store.append(b);
  store.readReady();
  expect(captured).toBeDefined();
  expect(store.readinessDiagnostics().closureEdges).toBe(0);
  store.append({ ...a, lamport: 20n });
  expect(store.readReady().ready).toHaveLength(0);
  store.destroy();
  expect(captured!.indexed!.past.contains(a.id)).toBe(true);
  expect(captured!.dependencies).toEqual([a]);
  (captured!.dependencies[0] as { documentId: string }).documentId = 'caller-owned';
  expect(a.documentId).toBe('D');
});

test('readiness eviction rebuilds retained pending/forked facts without a canonical update', () => {
  const p = pair();
  try {
    const a = action(A),
      b = action(B, 1n, [a]),
      c = action(C, 1n, [b]);
    p.append(a);
    p.append(b);
    p.append(c);
    p.append({ ...a, groupId: { ...a.groupId, sequence: 99n } });
    p.append(action(B, 3n));
    const old = p.indexed.readReady(),
      before = p.indexed.encodeUpdate(),
      count = p.indexed.readinessDiagnostics().factsChanged;
    const events = vi.fn(),
      off = p.indexed.onUpdate(events);
    try {
      p.indexed.evict();
      expect(p.indexed.cacheDiagnostics()).toMatchObject({
        certificates: 0,
        stagedCertificates: 0,
        records: 0,
        ready: 0,
        dependencySources: 0,
        dirtyFacts: 4,
      });
      expect(events).not.toHaveBeenCalled();
      expect(p.indexed.encodeUpdate()).toEqual(before);
      expect(p.indexed.readinessDiagnostics().factsChanged).toBe(count);
      p.equal();
      expect(old.ready).toHaveLength(0);
      p.append(action(C, 2n, [c]));
    } finally {
      off();
    }
  } finally {
    p.close();
  }
});

test('readiness eviction cancels suspended author validation before rebuilding its certificates', () => {
  let entered = false,
    cancelled = false;
  const indexed = new IndexedActionStore({
    ...options,
    validate: function* () {
      entered = true;
      try {
        yield;
        return null;
      } finally {
        cancelled = true;
      }
    },
  });
  try {
    indexed.append(action());
    const before = indexed.encodeUpdate();
    let work = indexed.computeReady(0);
    for (let i = 0; !entered && i < 10000; i++) {
      if (work.state !== 'deferred') throw new Error('Expected suspended readiness');
      work = work.continuation.resume(1);
    }
    expect(entered).toBe(true);
    indexed.evict();
    expect(cancelled).toBe(true);
    if (work.state !== 'deferred') throw new Error('Missing suspended computation');
    expect(() => work.continuation.resume(1)).toThrow(/invalidated/);
    expect(indexed.cacheDiagnostics().certificates).toBe(0);
    expect(indexed.readReady().ready).toHaveLength(1);
    expect(indexed.encodeUpdate()).toEqual(before);
  } finally {
    indexed.destroy();
  }
});

test('eviction drops unappended local certificates and preserves undecoded ingress', () => {
  const validate = vi.fn<ActionStoreOptions['validate']>(() => null);
  const indexed = new IndexedActionStore({ ...options, validate });
  const reference = new ActionStore(options);
  try {
    const a = action();
    expect(indexed.checkLocal(a)).toBe(null);
    expect(indexed.cacheDiagnostics().stagedCertificates).toBe(1);
    indexed.evict();
    expect(indexed.cacheDiagnostics().stagedCertificates).toBe(0);
    indexed.append(a);
    reference.append(a);
    indexed.appendEncoded(Uint8Array.of(255));
    reference.appendEncoded(Uint8Array.of(255));
    indexed.evict();
    expect(indexed.snapshot()).toEqual(reference.snapshot());
    expect(indexed.readinessDiagnostics().localCertificatesReused).toBe(0);
    expect(validate).toHaveBeenCalledTimes(2);
  } finally {
    indexed.destroy();
    reference.destroy();
  }
});
