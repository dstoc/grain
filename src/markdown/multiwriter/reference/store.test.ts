import { expect, test } from 'vitest';
import { ActionStore } from '../actions/store.js';
import { action, A } from '../actions/test-fixtures.js';
import { ReferenceActionStore } from './store.js';
import type { ActionStoreSnapshot } from '../actions/store.js';
import type { Work } from '../ingest/work.js';

class CountedReferenceStore extends ReferenceActionStore {
  reads = 0;
  protected override *calculate(): Work<ActionStoreSnapshot> {
    this.reads++;
    return yield* super.calculate();
  }
}
const options = { documentId: 'D', genesisId: 'G', genesisAllocations: [], validate: () => null };

test('retains a resumed full reference result only for the same facts, with detached exports', () => {
  const store = new CountedReferenceStore(options);
  const full = new ActionStore(options);
  try {
    const first = action();
    store.append(first);
    full.applyUpdate(store.encodeUpdate());
    let result = store.compute(0);
    expect(result.state).toBe('deferred');
    while (result.state === 'deferred') result = result.continuation.resume(1);
    expect(result.value).toEqual(full.snapshot());
    expect(store.reads).toBe(1);
    (result.value.ready as unknown[]).length = 0;
    result.value.actions[0].variants[0][0] ^= 1;
    expect(store.snapshot()).toEqual(full.snapshot());
    expect(store.compute(0)).toEqual({ state: 'complete', value: full.snapshot() });
    expect(store.reads).toBe(1);
    store.append(action(A, 2n, [first]));
    full.applyUpdate(store.encodeUpdate());
    expect(store.snapshot()).toEqual(full.snapshot());
    expect(store.reads).toBe(2);
    store.append({ ...first, groupId: { ...first.groupId, sequence: 99n } });
    full.applyUpdate(store.encodeUpdate());
    expect(store.snapshot()).toEqual(full.snapshot());
    expect(store.snapshot().ready).toEqual([]);
    expect(store.reads).toBe(3);
  } finally {
    store.destroy();
    full.destroy();
  }
});

test('cancellation, changed receipts and decode-limit resets cannot memoize partial work', () => {
  const store = new CountedReferenceStore(options);
  try {
    store.append(action());
    const partial = store.compute(0);
    if (partial.state !== 'deferred') throw new Error('Expected deferred work');
    partial.continuation.cancel();
    expect(() => partial.continuation.resume()).toThrow('consumed');
    let next = store.compute(0);
    if (next.state !== 'deferred') throw new Error('Expected deferred work');
    const beforeReceipt = next.continuation;
    store.applyUpdate(Uint8Array.of(0, 0));
    expect(() => beforeReceipt.resume()).toThrow('changed facts');
    next = store.compute(0);
    if (next.state !== 'deferred') throw new Error('Expected deferred work');
    const beforeLimit = next.continuation;
    store.setDecodeLimits({});
    expect(() => beforeLimit.resume()).toThrow('changed facts');
    let complete = store.compute(0);
    while (complete.state === 'deferred') complete = complete.continuation.resume(1);
    expect(complete.value.ready).toEqual([action()]);
    const reads = store.reads;
    store.setDecodeLimits({});
    expect(store.snapshot()).toEqual(complete.value);
    expect(store.reads).toBe(reads + 1);
  } finally {
    store.destroy();
  }
});
