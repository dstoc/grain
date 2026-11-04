import * as Y from 'yjs';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionStore } from '../actions/store.js';
import { A, B, C, action, resource, fullEnvelope } from '../actions/test-fixtures.js';
import { decodeCbor, decodeCborSteps, encodeCbor } from '../actions/cbor.js';
import { decodeEnvelope, encodeEnvelope, EnvelopeDecodeError } from '../actions/codec.js';
import type { ActionEnvelope, ActionId } from '../contracts.js';
import { NativeTapeCache } from '../text/cache.js';
import type { NativeBody } from '../text/types.js';
import { createIngestValidator, MissingAuthorValidatorError } from './validator.js';
import { IngestPublication } from './publication.js';
import type { NativeView } from './publication.js';
import { compute, IngestCapacityError, IngestDataError } from './work.js';
import type { Computation } from './work.js';
import { scanUpdate } from './preflight.js';

// Store/native reference tests only. No MW-04/MW-06 substitute or MW-08 factory.
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.restoreAllMocks();
});
function cache() {
  const value = new NativeTapeCache();
  cleanup.push(() => value.destroy());
  return value;
}
const tape = resource('tape', 0);
const start = resource('marker', 1);
const end = resource('marker', 2);
function fixture() {
  const origin = cache();
  const prepared = origin.prepare('G', [
    { type: 'createTape', tape, start, end },
    { type: 'text', tape, index: 1, text: 'ab😀' },
  ]);
  prepared.commit();
  return prepared.body;
}
function store(
  genesis = fixture(),
  validateAuthor?: Parameters<typeof createIngestValidator>[0]['validateAuthor'],
) {
  const validate = createIngestValidator({ genesis, validateAuthor });
  const value = new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: genesis.allocations,
    validate,
  });
  cleanup.push(() => {
    value.destroy();
    validate.destroy();
  });
  return value;
}
function author(genesis: NativeBody) {
  const value = cache();
  value.apply('G', genesis);
  return value;
}
function insert(
  target: NativeTapeCache,
  envelope = action(),
  index = 2,
  text = 'X',
): ActionEnvelope {
  const prepared = target.prepare(`${envelope.id.actor}:${envelope.id.sequence}`, [
    { type: 'text', tape, index, text },
  ]);
  prepared.commit();
  const body = prepared.body;
  return {
    ...envelope,
    ...body,
    effects: [
      {
        type: 'InsertText',
        ranges: body.nativeManifest.flatMap((birth) =>
          birth.type === 'text' ? [{ tape: birth.tape, ...birth.native }] : [],
        ),
      },
    ],
  };
}
function complete<T>(input: Computation<T>, budget = 7): T {
  let value = input;
  let resumes = 0;
  while (value.state === 'deferred') {
    expect('value' in value).toBe(false);
    value = value.continuation.resume(budget);
    if (++resumes > 1_000_000) throw new Error('No progress');
  }
  return value.value;
}
const text = (native: NativeView) =>
  native
    .snapshot(tape)
    .parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');
const readiness = (value: ActionStore, id: ActionId) =>
  value
    .snapshot()
    .actions.find((entry) => entry.id.actor === id.actor && entry.id.sequence === id.sequence)
    ?.readiness;

it('decodes deep CBOR iteratively, and reports adjustable depth capacity without semantic rejection', () => {
  const deep = new Uint8Array(30_001).fill(0x81);
  deep[30_000] = 0;
  expect(() => decodeEnvelope(deep)).toThrow(IngestCapacityError);
  const decoded = complete(compute(decodeCborSteps(deep, 30_001), 1), 7);
  let value = decoded;
  for (let i = 0; i < 30_000; i++) {
    expect(Array.isArray(value)).toBe(true);
    value = (value as readonly never[])[0];
  }
  expect(value).toBe(0n);
  const target = store();
  target.appendEncoded(deep);
  const held = target.encodeUpdate();
  expect(() => target.snapshot()).toThrow(IngestCapacityError);
  expect(target.encodeUpdate()).toEqual(held);
  target.setDecodeLimits({ depth: 30_001 });
  expect(target.snapshot()).toMatchObject({
    ready: [],
    actions: [],
    diagnostics: [expect.stringContaining('schema-3')],
  });
});

it('propagates an unexpected decoder failure without converting it to a reference error', () => {
  const bytes = encodeEnvelope(action());
  vi.spyOn(TextDecoder.prototype, 'decode').mockImplementationOnce(() => {
    throw new Error('decoder offline');
  });
  expect(() => decodeEnvelope(bytes)).toThrow('decoder offline');
  expect(decodeEnvelope(bytes)).toEqual(action());
});

it('keeps every truncated envelope and seeded malformed vector outside the ready projection', () => {
  const bytes = encodeEnvelope(fullEnvelope());
  for (let length = 0; length < bytes.length; length++)
    expect(() => decodeEnvelope(bytes.subarray(0, length))).toThrow(EnvelopeDecodeError);
  let seed = 96;
  for (let n = 0; n < 400; n++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const candidate = bytes.slice();
    candidate[seed % candidate.length] ^= 1 << (seed % 8);
    try {
      const decoded = decodeEnvelope(candidate);
      expect(encodeEnvelope(decoded)).toEqual(candidate);
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeDecodeError);
    }
  }
}, 20_000);

it('preflights every truncated carrier before Yjs and preserves canonical bytes and events', () => {
  const source = store();
  source.append(action());
  const bytes = source.encodeUpdate();
  const target = store();
  const before = target.encodeUpdate();
  const events = vi.fn();
  target.onUpdate(events);
  for (let length = 0; length < bytes.length; length++)
    expect(() => target.applyUpdate(bytes.subarray(0, length))).toThrow(IngestDataError);
  for (const suffix of [new Uint8Array([0]), new Uint8Array([255])])
    expect(() => target.applyUpdate(new Uint8Array([...bytes, ...suffix]))).toThrow(
      IngestDataError,
    );
  expect(target.encodeUpdate()).toEqual(before);
  expect(events).not.toHaveBeenCalled();
  target.applyUpdate(bytes);
  expect(target.snapshot()).toEqual(source.snapshot());
});

it('defers carrier work before integration, then admits the original bytes after raising capacity', () => {
  const source = store();
  source.append(action());
  const update = source.encodeUpdate();
  const target = store();
  const before = target.encodeUpdate();
  target.setDecodeLimits({ operations: 1 });
  expect(() => target.applyUpdate(update)).toThrow(IngestCapacityError);
  expect(target.encodeUpdate()).toEqual(before);
  target.setDecodeLimits({ operations: 100_000 });
  target.applyUpdate(update);
  expect(target.snapshot().ready).toEqual([action()]);
  expect(complete(compute(scanUpdate(update, 'carrier'), 0), 1)).toBeUndefined();
});

it('rejects forbidden Yjs root/content/deletion writes before either decoder is entered', () => {
  const docs: Y.Doc[] = [];
  const bad = (edit: (doc: Y.Doc) => void) => {
    const doc = new Y.Doc({ gc: false });
    docs.push(doc);
    edit(doc);
    return Y.encodeStateAsUpdate(doc);
  };
  const updates = [
    bad((doc) => doc.getArray('other').push([new Uint8Array([0])])),
    bad((doc) => doc.getMap('envelopes').set('x', new Uint8Array([0]))),
    bad((doc) => doc.getArray('envelopes').push([new Y.Text('x')])),
    bad((doc) => doc.getArray('envelopes').push([{ nested: [1, 2] }])),
    bad((doc) => {
      const array = doc.getArray('envelopes');
      array.push([new Uint8Array([0])]);
      array.delete(0);
    }),
  ];
  const target = store();
  const before = target.encodeUpdate();
  for (const update of updates) expect(() => target.applyUpdate(update)).toThrow(IngestDataError);
  expect(target.encodeUpdate()).toEqual(before);
  for (const doc of docs) doc.destroy();
});

it.each([1, 7, 10_000])(
  'reaches exactly the reference ready set with %i-operation slices',
  (budget) => {
    const genesis = fixture();
    const target = store(genesis);
    const a = author(genesis);
    const b = author(genesis);
    const a1 = insert(a);
    const b1 = insert(b, action(B));
    const a2 = insert(a, action(A, 2n, [a1]), 3, 'Y');
    for (const entry of [a2, b1, a1]) target.append(entry);
    const reference = target.snapshot();
    expect(complete(target.compute(budget), budget)).toEqual(reference);
  },
);

it('does not decode inside canonical observers or label an exhausted slice as malformed', () => {
  const target = store();
  const wire = decodeCbor(encodeEnvelope(action())) as Record<string, never>;
  const heavy = encodeCbor({ ...wire, unknown: Array.from({ length: 10_000 }, () => 0n) });
  const decoder = vi.spyOn(TextDecoder.prototype, 'decode');
  target.appendEncoded(heavy);
  expect(decoder).not.toHaveBeenCalled();
  const result = target.compute(1);
  expect(result.state).toBe('deferred');
  expect(complete(result, 7)).toMatchObject({
    ready: [],
    actions: [{ readiness: { state: 'quarantined', reason: 'reference' } }],
    diagnostics: [],
  });
});

it('invalidates continuations after receipt, on replacement computation and on close', () => {
  const target = store();
  target.append(action());
  let result = target.compute(1);
  expect(result.state).toBe('deferred');
  target.append(action(B));
  if (result.state === 'deferred') {
    const continuation = result.continuation;
    expect(() => continuation.resume()).toThrow('invalidated');
  }
  result = target.compute(1);
  target.snapshot();
  if (result.state === 'deferred') {
    const continuation = result.continuation;
    expect(() => continuation.resume()).toThrow('invalidated');
  }
  result = target.compute(1);
  target.destroy();
  if (result.state === 'deferred') {
    const continuation = result.continuation;
    expect(() => continuation.resume()).toThrow('invalidated');
  }
});

it('certifies native origins only in the exact author closure in both arrival orders and after restart', () => {
  const genesis = fixture();
  const b = author(genesis);
  const b1 = insert(b, action(B));
  const c = author(genesis);
  c.apply('B', b1);
  const unauthorized = insert(c, action(C), 3, 'bad');
  for (const order of [
    [b1, unauthorized],
    [unauthorized, b1],
  ]) {
    const target = store(genesis);
    for (const entry of order) target.append(entry);
    expect(readiness(target, unauthorized.id)).toEqual({
      state: 'quarantined',
      reason: 'native-body',
    });
    expect(target.snapshot().ready).toEqual([b1]);
    const reopened = store(genesis);
    reopened.applyUpdate(target.encodeUpdate());
    expect(reopened.snapshot()).toEqual(target.snapshot());
  }
});

it.each([0, 1, Number.MAX_SAFE_INTEGER])(
  'rejects nonexistent/zero/overflow native effect ranges (%i)',
  (length) => {
    const genesis = fixture();
    const target = store(genesis);
    const bad = {
      ...action(),
      effects: [{ type: 'InsertText' as const, ranges: [{ tape, client: 42, clock: 1, length }] }],
    };
    target.append(bad);
    expect(readiness(target, bad.id)).toEqual({ state: 'quarantined', reason: 'native-body' });
  },
);

it('requires reducer-owned author checks and propagates operational hook failures for retry', () => {
  const target = store();
  target.append({
    ...action(),
    effects: [{ type: 'SetProperties', node: resource('node', 9), values: {} }],
  });
  // Existence failure is deterministic even without a reducer hook.
  expect(target.snapshot().ready).toEqual([]);
  const genesis = fixture();
  const tagged = {
    ...action(),
    allocations: [{ type: 'deletion' as const, id: resource('deletion', 9, action().id) }],
  };
  const unsupported = store(genesis);
  unsupported.append(tagged);
  expect(() => unsupported.snapshot()).toThrow(MissingAuthorValidatorError);
  let unavailable = true;
  const realHook = vi.fn(() => {
    if (unavailable) throw new Error('owner unavailable');
    return null;
  });
  const guarded = store(genesis, realHook);
  guarded.append(tagged);
  expect(() => guarded.snapshot()).toThrow('owner unavailable');
  unavailable = false;
  expect(guarded.snapshot().ready).toEqual([tagged]);
});

it('caches immutable successful certification and keeps the exact native branch on ordinary appends', () => {
  const genesis = fixture();
  const target = store(genesis);
  const a = author(genesis);
  const first = insert(a);
  target.append(first);
  target.snapshot();
  const apply = vi.spyOn(NativeTapeCache.prototype, 'applySteps');
  const second = insert(a, action(A, 2n, [first]), 3, 'Y');
  target.append(second);
  target.snapshot();
  expect(apply.mock.calls).toHaveLength(1);
  expect(apply.mock.calls[0][1]).toEqual(second);
  apply.mockClear();
  target.snapshot();
  expect(apply).not.toHaveBeenCalled();
});

it('uses existing history-owner validation without erasing native allocation facts after undo', () => {
  const genesis = fixture();
  const target = store(genesis);
  const a = author(genesis);
  const first = insert(a);
  const undo: ActionEnvelope = {
    ...action(A, 2n, [first]),
    effects: [
      {
        type: 'SetGroupActive',
        group: first.groupId,
        actions: [first.id],
        active: false,
        previousControl: null,
      },
    ],
  };
  const b = author(genesis);
  b.apply('first', first);
  const later = insert(b, action(B, 1n, [first, undo]), 3, 'Y');
  for (const entry of [later, undo, first]) target.append(entry);
  expect(target.snapshot().ready).toEqual([first, undo, later]);
  const invalid = { ...action(C, 1n, [first]), effects: undo.effects };
  target.append(invalid);
  expect(readiness(target, invalid.id)).toEqual({ state: 'quarantined', reason: 'reference' });
});

it('publishes native state, heads and reducer output together; late forks stop authoring until rebuilt', () => {
  const genesis = fixture();
  const target = store(genesis);
  const a = author(genesis);
  const b = author(genesis);
  const first = insert(a);
  const independent = insert(b, action(B), 2, 'B');
  target.append(first);
  const publication = new IngestPublication(target, genesis, function* (actions, native) {
    const ids = [];
    for (const entry of actions) {
      yield;
      ids.push(entry.id);
    }
    return { ids, text: text(native), addresses: ids };
  });
  cleanup.push(() => publication.destroy());
  expect(complete(publication.refresh(1), 7).value.text).toBe('aXb😀');
  target.append(independent);
  const pending = publication.refresh(1);
  expect(publication.status()).toMatchObject({
    stale: true,
    canAuthor: false,
    publication: { value: { text: 'aXb😀' } },
  });
  expect(complete(pending, 1).value.text).toMatch(/^a[XB]{2}b😀$/);
  target.append({ ...first, groupId: { ...first.groupId, sequence: 99n } });
  expect(publication.status()).toMatchObject({ stale: true, canAuthor: false });
  const fresh = complete(publication.refresh(1), 7);
  expect(fresh.heads).toEqual([independent.id]);
  expect(fresh.value).toEqual({
    ids: [independent.id],
    addresses: [independent.id],
    text: 'aBb😀',
  });
  expect(publication.status()).toMatchObject({ stale: false, canAuthor: true });
  const missing = action(C, 2n, [action(C)]);
  target.append(missing);
  expect(publication.status()).toMatchObject({ stale: false, canAuthor: true });
});

it('retains the last completed publication after reducer failure and cancels work on new facts', () => {
  const genesis = fixture();
  const target = store(genesis);
  target.append(action());
  let fail = false;
  const publication = new IngestPublication(target, genesis, function* (actions) {
    yield;
    if (fail) throw new Error('reducer offline');
    return actions.length;
  });
  cleanup.push(() => publication.destroy());
  complete(publication.refresh());
  target.append(action(B));
  fail = true;
  expect(() => complete(publication.refresh(1), 7)).toThrow('reducer offline');
  expect(publication.status()).toMatchObject({
    stale: true,
    canAuthor: false,
    publication: { value: 1 },
  });
  fail = false;
  const work = publication.refresh(1);
  target.append(action(C));
  if (work.state === 'deferred') expect(() => work.continuation.resume()).toThrow('invalidated');
  expect(complete(publication.refresh(1), 7).value).toBe(3);
});

it('cancels suspended native inspection without mutating or retaining a busy writer', () => {
  const genesis = fixture();
  const target = cache();
  const pending = compute(target.applySteps('G', genesis), 1);
  expect(pending.state).toBe('deferred');
  if (pending.state === 'deferred') pending.continuation.cancel();
  target.apply('G', genesis);
  expect(text(target)).toBe('ab😀');
});

it.each([new TypeError('decoder unavailable'), new RangeError('decoder capacity')])(
  'does not quarantine an unexpected %s from a decoder',
  (failure) => {
    const bytes = encodeEnvelope(action());
    vi.spyOn(TextDecoder.prototype, 'decode').mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => decodeEnvelope(bytes)).toThrow(failure);
    expect(decodeEnvelope(bytes)).toEqual(action());
  },
);

it('never exposes an earlier native insertion from an action whose later body is malformed', () => {
  const genesis = fixture();
  const source = author(genesis);
  const first = insert(source);
  const second = insert(source, action(A, 2n, [first]), 3, 'Y');
  const target = author(genesis);
  const before = target.snapshot(tape);
  const body: NativeBody = {
    allocations: [],
    nativeManifest: [...first.nativeManifest, ...second.nativeManifest],
    nativeInsertUpdates: [...first.nativeInsertUpdates, new Uint8Array([255])],
  };
  let result = compute(target.applySteps('bad', body), 1);
  let failed = false;
  while (result.state === 'deferred') {
    expect(target.snapshot(tape)).toEqual(before);
    try {
      result = result.continuation.resume(1);
    } catch (error) {
      expect(error).toBeInstanceOf(IngestDataError);
      failed = true;
      break;
    }
  }
  expect(failed).toBe(true);
  expect(target.snapshot(tape)).toEqual(before);
  target.apply('valid', first);
  expect(text(target)).toBe('aXb😀');
});

it('rejects malformed native manifests and surrogate-splitting references through the store', () => {
  const genesis = fixture();
  const source = author(genesis);
  const valid = insert(source, action(), 2, 'XY');
  const birth = valid.nativeManifest.find((entry) => entry.type === 'text')!;
  if (birth.type !== 'text') throw new Error('Missing text');
  const variants: ActionEnvelope[] = [
    { ...valid, nativeManifest: [] },
    { ...valid, nativeManifest: [birth, birth] },
    { ...valid, nativeManifest: [{ ...birth, text: 'bad' }] },
    { ...valid, nativeManifest: [{ ...birth, native: { ...birth.native, length: 0 } }] },
    {
      ...valid,
      nativeManifest: [{ ...birth, native: { ...birth.native, clock: birth.native.clock + 1 } }],
    },
  ];
  const initial = genesis.nativeManifest.find((entry) => entry.type === 'text')!;
  if (initial.type !== 'text') throw new Error('Missing genesis text');
  variants.push({
    ...action(),
    effects: [
      {
        type: 'InsertText',
        ranges: [{ tape, ...initial.native, clock: initial.native.clock + 3, length: 1 }],
      },
    ],
  });
  for (const invalid of variants) {
    const target = store(genesis);
    target.append(invalid);
    expect(readiness(target, invalid.id)).toEqual({ state: 'quarantined', reason: 'native-body' });
    expect(target.snapshot().ready).toEqual([]);
  }
});

it('retries envelope and native decoder capacity without poisoning retained facts', () => {
  const genesis = fixture();
  const origin = author(genesis);
  const entry = insert(origin);
  const validate = createIngestValidator({ genesis, decodeOperations: 1 });
  const target = new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: genesis.allocations,
    validate,
    decodeOperations: 1,
  });
  cleanup.push(() => {
    target.destroy();
    validate.destroy();
  });
  target.append(entry);
  const held = target.encodeUpdate();
  expect(() => target.snapshot()).toThrow(IngestCapacityError);
  expect(target.encodeUpdate()).toEqual(held);
  target.setDecodeLimits({ operations: 100_000 });
  expect(() => target.snapshot()).toThrow(IngestCapacityError);
  expect(target.encodeUpdate()).toEqual(held);
  validate.setDecodeLimit(100_000);
  expect(target.snapshot()).toMatchObject({ ready: [entry], diagnostics: [] });
  // A lower local limit does not discard already-decoded facts or successful certification.
  target.setDecodeLimits({ operations: 1 });
  expect(target.snapshot().ready).toEqual([entry]);
});

it('prevents a suspended native inspection from writing after explicit reconstruction', () => {
  const genesis = fixture();
  const source = author(genesis);
  const entry = insert(source);
  const target = author(genesis);
  const work = compute(target.applySteps('candidate', entry), 1);
  target.rebuild([{ key: 'G', body: genesis }]);
  expect(() => complete(work, 7)).toThrow('invalidated');
  expect(text(target)).toBe('ab😀');
});

it('never grants authoring or publishes from a store with failed integrity', () => {
  const genesis = fixture();
  const target = store(genesis);
  const publication = new IngestPublication(target, genesis, function* () {
    yield;
    return 'initial';
  });
  cleanup.push(() => publication.destroy());
  complete(publication.refresh());
  // Exercise the defensive integrity guard after a runtime caller violates the binary API.
  // @ts-expect-error A JavaScript host can violate this TypeScript-only parameter contract.
  target.appendEncoded([1, 2, 3]);
  expect(publication.status()).toMatchObject({ stale: true, canAuthor: false });
  expect(() => complete(publication.refresh())).toThrow('integrity');
});
