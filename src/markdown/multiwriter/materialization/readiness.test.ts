import * as Y from 'yjs';
import { expect, test, vi } from 'vitest';
import { ActionStore } from '../actions/store.js';
import type { ActionStoreOptions } from '../actions/store.js';
import type { ActionEnvelope } from '../contracts.js';
import { A, B, C, action } from '../actions/test-fixtures.js';
import { encodeEnvelope } from '../actions/codec.js';
import { decodeCbor, encodeCbor } from '../actions/cbor.js';
import { IndexedActionStore } from './readiness.js';
import { SeededRandom } from '../../../../test/multiwriter/network.js';

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
    // The explicit remaining full-closure cost is observable rather than hidden.
    expect(after.closureEdges - before.closureEdges).toBe(150);
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
