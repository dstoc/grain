import { afterEach, expect, it, vi } from 'vitest';
import { ActionStore } from '../actions/store.js';
import { A, B, C, action, resource } from '../actions/test-fixtures.js';
import { encodeEnvelope } from '../actions/codec.js';
import { IngestDataError } from './work.js';
import { preflightUpdate } from './preflight.js';
import { NativeTapeCache } from '../text/cache.js';
import { createIngestValidator } from './validator.js';
import { DirectionalActionProvider } from '../providers/adapter.js';
import type { ActionJournal } from '../providers/types.js';

// Production store/native/provider boundaries; no MW-08 composition claim.
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function uint(n: number): number[] {
  const bytes = [];
  while (n > 127) {
    bytes.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return bytes;
}
function buf(bytes: Uint8Array): number[] {
  return [...uint(bytes.length), ...bytes];
}
const str = (value: string) => buf(new TextEncoder().encode(value));
function store() {
  // Storage-only controls contain no native body or semantic effect.
  const result = new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: [],
    validate: () => null,
  });
  cleanup.push(() => result.destroy());
  return result;
}
function carrier(secondOrigin: number, side: 'left' | 'right' = 'left') {
  return new Uint8Array([
    1,
    2,
    42,
    0,
    3,
    1,
    ...str('envelopes'),
    ...buf(encodeEnvelope(action(A))),
    side === 'left' ? 131 : 67,
    42,
    ...uint(secondOrigin),
    ...buf(encodeEnvelope(action(B))),
    0,
  ]);
}

it.each(['left', 'right'] as const)('accepts an earlier same-client carrier %s origin', (side) => {
  const target = store();
  target.applyUpdate(carrier(0, side));
  expect(target.snapshot().ready).toEqual([action(A), action(B)]);
});

const impossibleOrigins = [
  { side: 'left' as const, clock: 1 },
  { side: 'left' as const, clock: 2 },
  { side: 'right' as const, clock: 1 },
  { side: 'right' as const, clock: 2 },
];
it.each(impossibleOrigins)(
  'rejects carrier $side origin $clock before any mutation',
  ({ side, clock }) => {
    for (const existing of [false, true]) {
      const target = store();
      if (existing) target.append(action(C));
      const invalid = carrier(clock, side);
      expect(() => preflightUpdate(invalid, 'carrier')).toThrow(IngestDataError);
      const before = target.encodeUpdate();
      const vector = target.encodeStateVector();
      const snapshot = target.snapshot();
      const revision = target.factsVersion;
      const events = vi.fn();
      target.onUpdate(events);
      expect(() => target.applyUpdate(invalid)).toThrow(IngestDataError);
      expect(target.encodeUpdate()).toEqual(before);
      expect(target.encodeStateVector()).toEqual(vector);
      expect(target.snapshot()).toEqual(snapshot);
      expect(target.factsVersion).toBe(revision);
      expect(events).not.toHaveBeenCalled();
    }
  },
);

class MemoryJournal implements ActionJournal {
  readonly entries: Uint8Array[];
  constructor(entries: readonly Uint8Array[] = []) {
    this.entries = entries.map((entry) => entry.slice());
  }
  async read() {
    return this.entries.map((entry) => entry.slice());
  }
  async append(update: Uint8Array) {
    this.entries.push(update.slice());
  }
  close() {}
}
it.each(impossibleOrigins)(
  'preserves provider durability after rejected $side origin $clock',
  async ({ side, clock }) => {
    const target = store();
    target.append(action(C));
    const journal = new MemoryJournal();
    const provider = await DirectionalActionProvider.open({
      store: target,
      journal,
      mode: 'bidirectional',
    });
    try {
      await provider.flush();
      const before = target.encodeUpdate();
      const vector = target.encodeStateVector();
      const entries = await journal.read();
      expect(() => provider.receiveResult('peer', carrier(clock, side))).toThrow(IngestDataError);
      await provider.flush();
      expect(target.encodeUpdate()).toEqual(before);
      expect(target.encodeStateVector()).toEqual(vector);
      expect(await journal.read()).toEqual(entries);
      const restarted = store();
      const reopened = await DirectionalActionProvider.open({
        store: restarted,
        journal: new MemoryJournal(entries),
        mode: 'bidirectional',
      });
      try {
        expect(restarted.encodeUpdate()).toEqual(before);
        expect(restarted.snapshot()).toEqual(target.snapshot());
      } finally {
        await reopened.close();
      }
    } finally {
      await provider.close();
    }
  },
);

function fixture() {
  const tape = resource('tape', 0);
  const start = resource('marker', 1);
  const end = resource('marker', 2);
  const original = new NativeTapeCache();
  cleanup.push(() => original.destroy());
  const prepared = original.prepare('G', [{ type: 'createTape', tape, start, end }]);
  prepared.commit();
  const genesis = prepared.body;
  const firstMarker = genesis.nativeManifest[0].native;
  const lastMarker = genesis.nativeManifest[1].native;
  const update = (invalid?: { side: 'left' | 'right'; clock: number }) =>
    new Uint8Array([
      1,
      2,
      42,
      0,
      // The second struct stays between genesis markers in the malformed branch.
      // The first struct's same-client origin violates causal clock order.
      196,
      ...uint(invalid?.side === 'left' ? 42 : firstMarker.client),
      ...uint(invalid?.side === 'left' ? invalid.clock : firstMarker.clock),
      ...uint(invalid?.side === 'right' ? 42 : lastMarker.client),
      ...uint(invalid?.side === 'right' ? invalid.clock : lastMarker.clock),
      ...str('X'),
      196,
      ...uint(invalid ? firstMarker.client : 42),
      ...uint(invalid ? firstMarker.clock : 0),
      ...uint(lastMarker.client),
      ...uint(lastMarker.clock),
      ...str('Y'),
      0,
    ]);
  const entry = (invalid?: { side: 'left' | 'right'; clock: number }) => ({
    ...action(A),
    nativeInsertUpdates: [update(invalid)],
    nativeManifest: [
      { type: 'text' as const, tape, native: { client: 42, clock: 0, length: 1 }, text: 'X' },
      { type: 'text' as const, tape, native: { client: 42, clock: 1, length: 1 }, text: 'Y' },
    ],
  });
  const validate = createIngestValidator({ genesis });
  const target = new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: genesis.allocations,
    validate,
  });
  cleanup.push(() => {
    target.destroy();
    validate.destroy();
  });
  return { target, entry };
}
it('control: certifies ordinary same-client native origins', () => {
  const { target, entry } = fixture();
  target.append(entry());
  target.append(action(B));
  expect(target.snapshot().ready).toEqual([entry(), action(B)]);
});
it.each([
  { side: 'left' as const, clock: 0 },
  { side: 'left' as const, clock: 1 },
  { side: 'right' as const, clock: 0 },
  { side: 'right' as const, clock: 1 },
])(
  'quarantines native $side origin $clock and dependents while retaining independent work',
  (invalid) => {
    const { target, entry } = fixture();
    const bad = entry(invalid);
    const dependent = action(A, 2n, [bad]);
    target.append(dependent);
    target.append(bad);
    target.append(action(B));
    expect(() => preflightUpdate(bad.nativeInsertUpdates[0], 'native')).toThrowError(
      expect.objectContaining({ stage: 'native', code: 'origin' }),
    );
    const snapshot = target.snapshot();
    for (const id of [bad.id, dependent.id])
      expect(
        snapshot.actions.find(
          (entry) => entry.id.actor === id.actor && entry.id.sequence === id.sequence,
        )?.readiness,
      ).toEqual({ state: 'quarantined', reason: 'native-body' });
    expect(snapshot.ready).toEqual([action(B)]);
    expect(target.snapshot()).toEqual(snapshot);
  },
);

it.each([new TypeError('native decoder unavailable'), new RangeError('native decoder capacity')])(
  'propagates unexpected native operational failures: %s',
  (failure) => {
    const { target, entry } = fixture();
    const valid = entry();
    target.append(valid);
    const original = NativeTapeCache.prototype.applySteps;
    const apply = vi.spyOn(NativeTapeCache.prototype, 'applySteps').mockImplementation(function* (
      this: NativeTapeCache,
      key,
      body,
    ) {
      if (key.startsWith('candidate:')) throw failure;
      return yield* original.call(this, key, body);
    });
    try {
      expect(() => target.snapshot()).toThrow(failure);
    } finally {
      apply.mockRestore();
    }
    expect(target.snapshot().ready).toEqual([valid]);
  },
);
