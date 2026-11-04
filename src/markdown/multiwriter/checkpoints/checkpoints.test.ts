import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { compareBytes, decodeCbor, encodeCbor } from '../actions/cbor.js';
import type { CborValue } from '../actions/cbor.js';
import { encodeEnvelope } from '../actions/codec.js';
import { ActionStore } from '../actions/store.js';
import { A, B, C, action } from '../actions/test-fixtures.js';
import { captureCheckpoint, decodeCheckpoint, restoreCheckpoint, journalBytes } from './index.js';

const stores: ActionStore[] = [];
function store(documentId = 'D', genesisId = 'G') {
  const result = new ActionStore({
    documentId,
    genesisId,
    genesisAllocations: [],
    validate: (a) =>
      a.effects.length ||
      a.allocations.length ||
      a.nativeInsertUpdates.length ||
      a.nativeManifest.length
        ? 'native-body'
        : null,
  });
  stores.push(result);
  return result;
}
async function restore(bytes: Uint8Array, template = store()) {
  const restored = await restoreCheckpoint(bytes, template);
  stores.push(restored);
  return restored;
}
function wire(bytes: Uint8Array) {
  return decodeCbor(bytes) as Record<string, CborValue>;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of stores.splice(0)) value.destroy();
});

it('retains exact native array identity, pending/forked/anonymous/duplicate records and controls', async () => {
  const value = store();
  const a = action();
  const b = action(B);
  const c = action(C);
  value.append(a);
  value.append(a); // duplicate native record, not duplicate semantic variant
  value.append({ ...a, groupId: { ...a.groupId, sequence: 2n } });
  value.append(action(B, 2n, [b]));
  value.append(c);
  // Bodyless history control is deliberately quarantined by this test's narrow validator.
  value.append({
    ...action(C, 2n, [c]),
    effects: [
      {
        type: 'SetGroupActive',
        group: c.groupId,
        actions: [c.id],
        active: false,
        previousControl: null,
      },
    ],
  });
  value.appendEncoded(new Uint8Array([255]));
  const before = value.retainedBytes();
  expect(before.envelopeRecords).toBe(7);
  expect(before.envelopePayloadBytes).toBe(
    encodeEnvelope(a).length * 2 +
      encodeEnvelope({ ...a, groupId: { ...a.groupId, sequence: 2n } }).length +
      encodeEnvelope(action(B, 2n, [b])).length +
      encodeEnvelope(c).length +
      encodeEnvelope({
        ...action(C, 2n, [c]),
        effects: [
          {
            type: 'SetGroupActive',
            group: c.groupId,
            actions: [c.id],
            active: false,
            previousControl: null,
          },
        ],
      }).length +
      1,
  );
  const bytes = await captureCheckpoint(value);
  const decoded = decodeCheckpoint(bytes);
  expect(decoded.update).toEqual(value.encodeUpdate());
  expect(decoded.manifest.coveredActions).toEqual([c.id]);
  expect(decoded.manifest.heads).toEqual([c.id]);
  const loaded = await restore(bytes);
  expect(loaded.snapshot()).toEqual(value.snapshot());
  expect(loaded.encodeUpdate()).toEqual(value.encodeUpdate());
  expect(loaded.retainedBytes()).toEqual(before);
  loaded.append(b);
  value.applyUpdate(loaded.encodeUpdate());
  expect(loaded.snapshot()).toEqual(value.snapshot());
  expect(loaded.snapshot().ready.map((a) => a.id)).toContainEqual(action(B, 2n).id);
});

it.each(['no-event', 'mixed-message'])(
  'keeps %s unresolved outer structs before and after their prerequisite',
  async (kind) => {
    const origin = store();
    const events: Uint8Array[] = [];
    origin.onUpdate((update) => events.push(update));
    const a = action();
    origin.append(a);
    origin.append(action(A, 2n, [a]));
    const other = store();
    other.append(action(C));
    const target = store();
    target.applyUpdate(
      kind === 'no-event' ? events[1] : Y.mergeUpdates([events[1], other.encodeUpdate()]),
    );
    expect(target.retainedBytes().envelopeRecords).toBe(kind === 'no-event' ? 1 : 2);
    const loaded = await restore(await captureCheckpoint(target));
    expect(loaded.encodeUpdate()).toEqual(target.encodeUpdate());
    expect(loaded.snapshot()).toEqual(target.snapshot());
    for (const value of [target, loaded]) value.applyUpdate(events[0]);
    expect(loaded.encodeUpdate()).toEqual(target.encodeUpdate());
    expect(loaded.snapshot()).toEqual(target.snapshot());
    expect(loaded.snapshot().ready).toHaveLength(kind === 'no-event' ? 2 : 3);
  },
);

it('captures detached state before asynchronous hashing and copies restore input before yielding', async () => {
  const value = store();
  value.append(action());
  const before = value.encodeUpdate();
  const promise = captureCheckpoint(value);
  value.append(action(B));
  const checkpoint = await promise;
  expect(decodeCheckpoint(checkpoint).update).toEqual(before);
  const loading = restore(checkpoint);
  checkpoint.fill(0);
  expect((await loading).encodeUpdate()).toEqual(before);
});

it('preserves unsigned 64-bit counters in a pending envelope without rounding', async () => {
  const value = store();
  value.append({
    ...action(A, (1n << 64n) - 1n),
    dependencies: [{ actor: A, sequence: (1n << 64n) - 2n }],
  });
  const loaded = await restore(await captureCheckpoint(value));
  expect(loaded.snapshot()).toEqual(value.snapshot());
  expect(loaded.snapshot().actions[0].id.sequence).toBe((1n << 64n) - 1n);
});

it('rejects every truncated container prefix and trailing bytes', async () => {
  const value = store();
  value.append(action());
  const bytes = await captureCheckpoint(value);
  for (let length = 0; length < bytes.length; length++)
    expect(() => decodeCheckpoint(bytes.subarray(0, length)), `prefix ${length}`).toThrow();
  expect(() => decodeCheckpoint(new Uint8Array([...bytes, 0]))).toThrow();
});

it.each([
  'format',
  'protocol',
  'extra',
  'missing',
  'identity',
  'manifestIdentity',
  'digestType',
  'updateType',
  'idType',
])('rejects malformed %s container fields', async (kind) => {
  const value = store();
  value.append(action());
  const fields = wire(await captureCheckpoint(value));
  const closure = fields.manifest as Record<string, CborValue>;
  if (kind === 'format') fields.formatVersion = 2n;
  if (kind === 'protocol') fields.protocolVersion = 4n;
  if (kind === 'extra') fields.extra = null;
  if (kind === 'missing') delete fields.update;
  if (kind === 'identity') fields.documentId = 7n;
  if (kind === 'manifestIdentity') closure.genesisId = 'other';
  if (kind === 'digestType') fields.digest = new Uint8Array(31);
  if (kind === 'updateType') fields.update = 'bytes';
  if (kind === 'idType') closure.coveredActions = [{ actor: new Uint8Array(15), sequence: 1n }];
  expect(() => decodeCheckpoint(encodeCbor(fields))).toThrow();
});

it.each([
  'digest',
  'coveredMissing',
  'coveredExtra',
  'headMissing',
  'order',
  'duplicate',
  'nativeInvalid',
])('strict restore rejects %s despite valid container syntax', async (kind) => {
  const value = store();
  value.append(action());
  value.append(action(B));
  const fields = wire(await captureCheckpoint(value));
  const closure = fields.manifest as Record<string, CborValue>;
  if (kind === 'digest') (fields.digest as Uint8Array)[0] ^= 1;
  if (kind === 'coveredMissing') closure.coveredActions = [];
  if (kind === 'coveredExtra')
    (closure.coveredActions as CborValue[]).push({
      actor: new Uint8Array(16).fill(9),
      sequence: 1n,
    });
  if (kind === 'headMissing') closure.heads = [];
  if (kind === 'order') (closure.coveredActions as CborValue[]).reverse();
  if (kind === 'duplicate')
    (closure.coveredActions as CborValue[]).push((closure.coveredActions as CborValue[])[0]);
  if (kind === 'nativeInvalid') {
    fields.update = new Uint8Array([255]);
    fields.digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fields.update.slice()));
  }
  await expect(restore(encodeCbor(fields))).rejects.toThrow();
});

it.each(['document', 'genesis'])('rejects host %s mismatch', async (kind) => {
  await expect(
    restore(
      await captureCheckpoint(store()),
      store(kind === 'document' ? 'X' : 'D', kind === 'genesis' ? 'X' : 'G'),
    ),
  ).rejects.toThrow('mismatch');
});

it('rejects native deletion on capture and cold restore, even with a valid digest', async () => {
  const doc = new Y.Doc({ gc: false });
  const array = doc.getArray<Uint8Array>('envelopes');
  array.push([encodeEnvelope(action())]);
  array.delete(0);
  const native = Y.encodeStateAsUpdate(doc);
  const value = store();
  expect(() => value.applyUpdate(native)).toThrow('deletion');
  await expect(captureCheckpoint(value)).rejects.toThrow('integrity');
  const fields = wire(await captureCheckpoint(store()));
  fields.update = native;
  fields.digest = new Uint8Array(await crypto.subtle.digest('SHA-256', native.slice()));
  await expect(restore(encodeCbor(fields))).rejects.toThrow('deletion');
  doc.destroy();
});

it('requires the actual deterministic validator rather than trusting the manifest', async () => {
  const value = store();
  value.append(action());
  const strict = new ActionStore({
    ...value.identity,
    genesisAllocations: [],
    validate: () => 'native-body',
  });
  stores.push(strict);
  await expect(restore(await captureCheckpoint(value), strict)).rejects.toThrow('manifest');
});

it('separates stored payload/native/update categories from container and redundant journal bytes', async () => {
  const value = store();
  const a = { ...action(), nativeInsertUpdates: [new Uint8Array([0, 0])] };
  value.append(a); // retained but quarantined: accounting is independent of readiness
  value.append(a);
  value.appendEncoded(new Uint8Array([255]));
  const canonical = value.retainedBytes();
  expect(canonical.nativeInsertionBodyBytes).toBe(4);
  expect(canonical.envelopePayloadBytes).toBe(encodeEnvelope(a).length * 2 + 1);
  const redundant = Array.from({ length: 20 }, () => value.encodeUpdate());
  const checkpoint = await captureCheckpoint(value);
  const consolidated = journalBytes({ checkpoint, updates: [] });
  expect(consolidated.totalBytes).toBe(checkpoint.length);
  expect(consolidated.totalBytes).toBeLessThan(journalBytes({ updates: redundant }).totalBytes);
  const loaded = await restore(checkpoint);
  expect(loaded.retainedBytes()).toEqual(canonical);
  expect(compareBytes(loaded.encodeUpdate(), value.encodeUpdate())).toBe(0);
});

it('releases a real native cache, rebuilds retained IDs, then merges an offline old-anchor insertion', async () => {
  const { NativeTapeCache } = await import('../text/cache.js');
  const { resource } = await import('../actions/test-fixtures.js');
  const { actionKey } = await import('../actions/references.js');
  const { resourceKey } = await import('../text/identity.js');
  const tape = resource('tape', 0);
  const start = resource('marker', 1);
  const end = resource('marker', 2);
  const creator = new NativeTapeCache();
  const creation = creator.prepare('G', [
    { type: 'createTape', tape, start, end },
    { type: 'text', tape, index: 1, text: 'ab' },
  ]);
  creation.commit();
  const genesis = creation.body;
  const offline = new NativeTapeCache();
  offline.apply('G', genesis);
  let live: InstanceType<typeof NativeTapeCache> | undefined = new NativeTapeCache();
  live.apply('G', genesis);
  // This narrow validator actually replays native origins/manifests on the author's closure.
  // It accepts only literal InsertText effects matching the action's native text births.
  const options = {
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: genesis.allocations,
    validate: (
      a: import('../contracts.js').ActionEnvelope,
      context: import('../actions/store.js').ActionValidationContext,
    ): 'native-body' | null => {
      const validation = new NativeTapeCache();
      try {
        validation.apply('G', genesis);
        for (const ancestor of context.dependencies)
          validation.apply(actionKey(ancestor.id), ancestor);
        validation.apply(actionKey(a.id), a);
        const expectedRanges = a.nativeManifest.flatMap((entry) =>
          entry.type === 'text' ? [{ tape: entry.tape, ...entry.native }] : [],
        );
        if (
          a.effects.length !== 1 ||
          a.effects[0].type !== 'InsertText' ||
          a.effects[0].ranges.length !== expectedRanges.length ||
          a.effects[0].ranges.some(
            (range, i) =>
              range.client !== expectedRanges[i].client ||
              range.clock !== expectedRanges[i].clock ||
              range.length !== expectedRanges[i].length ||
              resourceKey(range.tape) !== resourceKey(expectedRanges[i].tape),
          )
        )
          return 'native-body';
        return null;
      } catch {
        return 'native-body';
      } finally {
        validation.destroy();
      }
    },
  };
  const value = new ActionStore(options);
  stores.push(value);
  function insert(target: InstanceType<typeof NativeTapeCache>, actor: typeof A, text: string) {
    const a = action(actor);
    const pending = target.prepare(actionKey(a.id), [{ type: 'text', tape, index: 2, text }]);
    const body = pending.body;
    const ranges = body.nativeManifest.flatMap((entry) =>
      entry.type === 'text' ? [{ tape: entry.tape, ...entry.native }] : [],
    );
    pending.commit();
    return { ...a, ...body, effects: [{ type: 'InsertText' as const, ranges }] };
  }
  try {
    const oldText = offline.snapshot(tape).parts.find((part) => part.type === 'text')!;
    const oldMarker = offline.marker(start);
    value.append(insert(live, A, 'X'));
    expect(value.snapshot().ready).toHaveLength(1);
    const canonical = value.retainedBytes();
    const oldClient = live.clientId;
    live.destroy();
    expect(() => live!.snapshot(tape)).toThrow('closed');
    // The host drops its cache reference so the destroyed native Doc can be reclaimed.
    live = undefined;
    const loaded = await restore(await captureCheckpoint(value), value);
    const rebuilt = new NativeTapeCache();
    try {
      rebuilt.rebuild([
        { key: 'G', body: genesis },
        ...loaded.snapshot().ready.map((body) => ({ key: actionKey(body.id), body })),
      ]);
      expect(rebuilt.clientId).not.toBe(oldClient);
      expect(rebuilt.marker(start)).toEqual(oldMarker);
      expect(
        rebuilt
          .lookup({ tape, ...oldText.native, length: 2 })
          .map((part) => part.text)
          .join(''),
      ).toBe('ab');
      expect(loaded.retainedBytes()).toEqual(canonical);
      const late = insert(offline, B, 'Y'); // still uses the original offline native gap
      const independent = new ActionStore(options);
      stores.push(independent);
      independent.append(late);
      loaded.applyUpdate(independent.encodeUpdate());
      independent.applyUpdate(loaded.encodeUpdate());
      expect(loaded.snapshot().ready).toHaveLength(2);
      expect(independent.encodeUpdate()).toEqual(loaded.encodeUpdate());
      const ready = loaded.snapshot().ready;
      rebuilt.rebuild([
        { key: 'G', body: genesis },
        ...ready.map((body) => ({ key: actionKey(body.id), body })),
      ]);
      for (const body of ready) offline.apply(actionKey(body.id), body);
      expect(rebuilt.snapshot(tape)).toEqual(offline.snapshot(tape));
      expect(
        rebuilt
          .range({ tape, start, end })
          .map((part) => part.text)
          .join(''),
      ).toMatch(/^a[XY]{2}b$/);
    } finally {
      rebuilt.destroy();
    }
  } finally {
    creator.destroy();
    live?.destroy();
    offline.destroy();
  }
});
