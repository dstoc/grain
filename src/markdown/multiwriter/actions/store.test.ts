import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import type { ActionEnvelope, ActionId, ActionReadiness, Allocation } from '../contracts.js';
import { MAX_COUNTER } from '../contracts.js';
import { decodeCbor, encodeCbor } from './cbor.js';
import { encodeEnvelope } from './codec.js';
import { A, B, C, action, resource } from './test-fixtures.js';
import { actionKey } from './references.js';
import { ActionStore } from './store.js';
import type { ActionStoreOptions } from './store.js';

// These tests exercise storage/readiness only. Empty actions have no native or semantic body.
function store(options: Partial<ActionStoreOptions> = {}) {
  return new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: [],
    validate: (value) =>
      value.effects.length || value.nativeInsertUpdates.length || value.nativeManifest.length
        ? 'native-body'
        : null,
    ...options,
  });
}
function status(value: ActionStore, id: ActionId): ActionReadiness | undefined {
  return value.snapshot().actions.find((entry) => actionKey(entry.id) === actionKey(id))?.readiness;
}
function ready(value: ActionStore): string[] {
  return value.snapshot().ready.map((entry) => actionKey(entry.id));
}
function* permutations<T>(values: readonly T[]): Generator<T[]> {
  if (values.length === 0) yield [];
  for (let i = 0; i < values.length; i++)
    for (const rest of permutations(values.filter((_, index) => index !== i)))
      yield [values[i], ...rest];
}

it('keeps incomplete branches pending while independent work becomes ready', () => {
  const value = store();
  const a1 = action();
  const a2 = action(A, 2n, [a1]);
  const b1 = action(B);
  const b2 = action(B, 2n, [b1, a2]);
  value.append(a2);
  value.append(b2);
  value.append(b1);
  expect(ready(value)).toEqual([actionKey(b1.id)]);
  expect(status(value, a2.id)).toEqual({ state: 'pending', missing: [a1.id] });
  expect(status(value, b2.id)).toEqual({ state: 'pending', missing: [a1.id] });
  expect(value.snapshot().heads).toEqual([b1.id]);
  value.append(a1);
  expect(ready(value)).toEqual([a1, b1, a2, b2].map((entry) => actionKey(entry.id)));
  expect(value.snapshot().heads).toEqual([b2.id]);
  value.destroy();
});
it('has the same complete ready closure for every delivery order and identical duplicates', () => {
  const a1 = action();
  const b1 = action(B);
  const a2 = action(A, 2n, [a1, b1]);
  const c1 = action(C, 1n, [a2]);
  for (const order of permutations([a1, b1, a2, c1])) {
    const value = store();
    for (const entry of order) {
      value.append(entry);
      value.append(entry);
    }
    expect(ready(value)).toEqual([a1, b1, a2, c1].map((entry) => actionKey(entry.id)));
    expect(value.snapshot().actions.every((entry) => entry.variants.length === 1)).toBe(true);
    expect(value.snapshot().heads).toEqual([c1.id]);
    value.destroy();
  }
});
it('deduplicates identity without hiding forks, and withdraws a previously ready closure', () => {
  const a1 = action();
  const changed = { ...a1, groupId: { ...a1.groupId, sequence: 2n } };
  const a2 = action(A, 2n, [a1]);
  const b1 = action(B);
  const c1 = action(C, 1n, [a2]);
  for (const versions of [
    [a1, changed],
    [changed, a1],
  ]) {
    const value = store();
    value.append(versions[0]);
    value.append(a2);
    value.append(c1);
    value.append(b1);
    expect(ready(value)).toHaveLength(4);
    value.append(versions[1]);
    value.append(versions[0]);
    for (const id of [a1.id, a2.id, c1.id])
      expect(status(value, id)).toEqual({ state: 'quarantined', reason: 'fork' });
    expect(ready(value)).toEqual([actionKey(b1.id)]);
    expect(
      value.snapshot().actions.find((entry) => actionKey(entry.id) === actionKey(a1.id))!.variants,
    ).toHaveLength(2);
    const restarted = store();
    restarted.applyUpdate(value.encodeUpdate());
    expect(restarted.snapshot()).toEqual(value.snapshot());
    value.destroy();
    restarted.destroy();
  }
});
it('uses exact Lamport and bytewise actor order, never collection order', () => {
  const value = store();
  value.append(action(C));
  value.append(action(B));
  value.append(action(A));
  expect(value.snapshot().ready.map((entry) => entry.id.actor)).toEqual([A, B, C]);
  value.destroy();
});

describe('actor chains and causal timestamps', () => {
  const a1 = action();
  it.each([
    { ...a1, id: { actor: A, sequence: 0n } },
    { ...a1, id: { actor: A, sequence: 3n }, dependencies: [a1.id], lamport: 2n },
    { ...a1, dependencies: [a1.id] },
    { ...a1, dependencies: [action(B).id, action(B).id], lamport: 2n },
    { ...a1, dependencies: [{ actor: A, sequence: 2n }], lamport: 2n },
    { ...a1, dependencies: [{ actor: B, sequence: 0n }], lamport: 2n },
    { ...a1, lamport: 0n },
    { ...a1, lamport: 2n },
    { ...a1, groupId: { ...a1.groupId, session: { actor: B, local: 'editor' } } },
  ])('quarantines malformed chains without blocking independent work', (bad) => {
    const value = store();
    value.append(bad);
    value.append(action(C));
    expect(status(value, bad.id)).toEqual({ state: 'quarantined', reason: 'actor-chain' });
    expect(ready(value)).toEqual([actionKey(action(C).id)]);
    value.destroy();
  });
  it('rejects cycles and noncausal/incorrect Lamport edges', () => {
    for (const [leftTime, rightTime] of [
      [1n, 1n],
      [2n, 1n],
      [1n, 2n],
    ]) {
      const value = store();
      const left = { ...action(A), dependencies: [action(B).id], lamport: leftTime };
      const right = { ...action(B), dependencies: [action(A).id], lamport: rightTime };
      value.append(left);
      value.append(right);
      expect(
        value.snapshot().actions.every((entry) => entry.readiness.state === 'quarantined'),
      ).toBe(true);
      value.destroy();
    }
    const value = store();
    value.append(a1);
    for (const lamport of [1n, 3n, MAX_COUNTER]) {
      const bad = { ...action(B, 1n, [a1]), lamport };
      const fresh = store();
      fresh.append(a1);
      fresh.append(bad);
      expect(status(fresh, bad.id)).toEqual({ state: 'quarantined', reason: 'actor-chain' });
      fresh.destroy();
    }
    value.destroy();
  });
  it('treats a contiguous absent predecessor as pending, never as an implicit genesis', () => {
    const value = store();
    const a2 = action(A, 2n, [a1]);
    value.append(a2);
    expect(status(value, a2.id)).toEqual({ state: 'pending', missing: [a1.id] });
    value.destroy();
  });
});

it('holds unsupported versions and wrong document/genesis records outside the ready set', () => {
  for (const [patch, reason] of [
    [{ protocolVersion: 4n }, 'version'],
    [{ documentId: 'other' }, 'reference'],
    [{ genesisId: 'other' }, 'reference'],
  ] as const) {
    const value = store();
    const wire = decodeCbor(encodeEnvelope(action())) as Record<string, never>;
    value.appendEncoded(encodeCbor({ ...wire, ...patch }));
    value.append(action(A, 2n, [action()]));
    expect(
      value
        .snapshot()
        .actions.every(
          (entry) => entry.readiness.state === 'quarantined' && entry.readiness.reason === reason,
        ),
    ).toBe(true);
    value.destroy();
  }
});
it('retains malformed bytes losslessly and identifies malformed variants where possible', () => {
  const value = store();
  value.appendEncoded(new Uint8Array([0xff]));
  expect(value.snapshot().diagnostics).toHaveLength(1);
  const wire = decodeCbor(encodeEnvelope(action())) as Record<string, never>;
  value.appendEncoded(encodeCbor({ ...wire, unknown: true }));
  expect(status(value, action().id)).toEqual({ state: 'quarantined', reason: 'reference' });
  value.append(action());
  expect(status(value, action().id)).toEqual({ state: 'quarantined', reason: 'fork' });
  const rebuilt = store();
  rebuilt.applyUpdate(value.encodeUpdate());
  expect(rebuilt.snapshot()).toEqual(value.snapshot());
  value.destroy();
  rebuilt.destroy();
});

it('validates only complete causal closure, with no concurrent or future actions', () => {
  const validate = vi.fn<ActionStoreOptions['validate']>(() => null);
  const value = store({ validate });
  const a1 = action();
  const a2 = action(A, 2n, [a1]);
  const b1 = action(B);
  value.append(a2);
  value.append(b1);
  value.snapshot();
  expect(validate.mock.calls.map((args) => args[0])).toEqual([b1]);
  validate.mockClear();
  value.append(a1);
  value.snapshot();
  expect(validate.mock.calls).toEqual([
    [a1, { dependencies: [] }],
    [b1, { dependencies: [] }],
    [a2, { dependencies: [a1] }],
  ]);
  value.destroy();
});
it('propagates native validation quarantine and never certifies a missing body validator', () => {
  const value = store();
  const a1 = { ...action(), nativeInsertUpdates: [new Uint8Array([0, 0])] };
  value.append(a1);
  value.append(action(A, 2n, [a1]));
  value.append(action(B));
  expect(status(value, a1.id)).toEqual({ state: 'quarantined', reason: 'native-body' });
  expect(ready(value)).toEqual([actionKey(action(B).id)]);
  value.destroy();
});
it('fails closed if a validator throws, without poisoning immutable facts', () => {
  let fail = true;
  const value = store({
    validate: () => {
      if (fail) throw new Error('Validator unavailable');
      return null;
    },
  });
  value.append(action());
  expect(() => value.snapshot()).toThrow('Validator unavailable');
  fail = false;
  expect(ready(value)).toEqual([actionKey(action().id)]);
  value.destroy();
});

it('checks references against genesis, own allocations and dependency closure, not merged state', () => {
  const node = resource('node', 0);
  const genesis: Allocation = {
    type: 'node',
    id: node,
    role: 'inline',
    flow: null,
    birthSlot: null,
  };
  const a1: ActionEnvelope = {
    ...action(),
    effects: [{ type: 'SetProperties', node, values: { checked: true } }],
  };
  const value = store({ genesisAllocations: [genesis], validate: () => null });
  value.append(a1);
  expect(ready(value)).toHaveLength(1);
  const absent = store({ validate: () => null });
  absent.append(a1);
  expect(status(absent, a1.id)).toEqual({ state: 'quarantined', reason: 'reference' });
  const born = resource('node', 0, action(B).id);
  const b1: ActionEnvelope = { ...action(B), allocations: [{ ...genesis, id: born }] };
  value.append(b1);
  const invalid: ActionEnvelope = {
    ...action(C),
    effects: [{ type: 'SetProperties', node: born, values: {} }],
  };
  value.append(invalid);
  expect(status(value, invalid.id)).toEqual({ state: 'quarantined', reason: 'reference' });
  const valid: ActionEnvelope = { ...action(A, 2n, [a1, b1]), effects: invalid.effects };
  value.append(valid);
  expect(status(value, valid.id)).toEqual({ state: 'ready' });
  value.destroy();
  absent.destroy();
});
it('rejects reused allocation ordinals across kinds and foreign births', () => {
  const value = store({ validate: () => null });
  const a1 = action();
  const bad: ActionEnvelope = {
    ...a1,
    allocations: [
      { type: 'deletion', id: resource('deletion', 0, a1.id) },
      { type: 'interpretation', id: resource('interpretation', 0, a1.id) },
    ],
  };
  value.append(bad);
  expect(status(value, a1.id)).toEqual({ state: 'quarantined', reason: 'reference' });
  const foreign = { ...action(B), allocations: bad.allocations.slice(0, 1) };
  value.append(foreign);
  expect(status(value, foreign.id)).toEqual({ state: 'quarantined', reason: 'reference' });
  value.destroy();
});
it('does not let a later control alter earlier author-local validation', () => {
  const node = resource('node', 0, action().id);
  const birth: ActionEnvelope = {
    ...action(),
    allocations: [{ type: 'node', id: node, role: 'inline', flow: null, birthSlot: null }],
  };
  const edit: ActionEnvelope = {
    ...action(B, 1n, [birth]),
    effects: [{ type: 'SetProperties', node, values: {} }],
  };
  const undo: ActionEnvelope = {
    ...action(A, 2n, [birth, edit]),
    effects: [
      {
        type: 'SetGroupActive',
        group: birth.groupId,
        actions: [birth.id],
        active: false,
        previousControl: null,
      },
    ],
  };
  const seen: string[][] = [];
  const value = store({
    validate: (entry, context) => {
      if (entry.id.actor === B) seen.push(context.dependencies.map((dep) => actionKey(dep.id)));
      return null;
    },
  });
  value.append(birth);
  value.append(edit);
  value.snapshot();
  value.append(undo);
  value.snapshot();
  expect(seen).toEqual([[actionKey(birth.id)], [actionKey(birth.id)]]);
  expect(status(value, edit.id)).toEqual({ state: 'ready' });
  value.destroy();
});

it('exchanges actual independent actionDocs through duplicates, merged updates and state-vector catch-up', () => {
  const peers = [store(), store(), store()];
  const updates: Uint8Array[] = [];
  const stop = peers[0].onUpdate((update) => updates.push(update));
  const a1 = action();
  const b1 = action(B);
  const c1 = action(C);
  peers[0].append(a1);
  peers[1].append(b1);
  peers[2].append(c1);
  stop();
  peers[0].append(action(A, 2n, [a1]));
  expect(updates).toHaveLength(1);
  const merged = Y.mergeUpdates(peers.map((peer) => peer.encodeUpdate()));
  for (const peer of peers) {
    peer.applyUpdate(merged);
    peer.applyUpdate(merged);
  }
  expect(peers[0].snapshot()).toEqual(peers[1].snapshot());
  expect(peers[1].snapshot()).toEqual(peers[2].snapshot());
  const a3 = action(
    A,
    3n,
    peers[0].snapshot().ready.filter((entry) => entry.id.actor !== A || entry.id.sequence === 2n),
  );
  peers[0].append(a3);
  peers[1].applyUpdate(peers[0].encodeUpdate(peers[1].encodeStateVector()));
  expect(peers[1].snapshot()).toEqual(peers[0].snapshot());
  const reopened = store();
  reopened.applyUpdate(peers[0].encodeUpdate());
  expect(reopened.snapshot()).toEqual(peers[0].snapshot());
  for (const peer of [...peers, reopened]) peer.destroy();
});
it('keeps incomplete outer Yjs updates out until their native array prerequisites arrive', () => {
  const source = store();
  const updates: Uint8Array[] = [];
  source.onUpdate((update) => updates.push(update));
  source.append(action());
  source.append(action(A, 2n, [action()]));
  const target = store();
  target.applyUpdate(updates[1]);
  expect(target.snapshot().actions).toEqual([]);
  target.append(action(B));
  expect(ready(target)).toEqual([actionKey(action(B).id)]);
  target.applyUpdate(updates[0]);
  expect(ready(target)).toHaveLength(3);
  source.destroy();
  target.destroy();
});
it('copies incoming/outgoing payloads, including validator arguments and snapshots', () => {
  const value = store({
    validate: (entry) => {
      (entry.id as { sequence: bigint }).sequence = 99n;
      return null;
    },
  });
  const bytes = encodeEnvelope(action());
  value.appendEncoded(bytes);
  bytes.fill(0);
  const snapshot = value.snapshot();
  snapshot.actions[0].variants[0].fill(0);
  (snapshot.ready[0].id as { sequence: bigint }).sequence = 42n;
  expect(value.snapshot().ready[0]).toEqual(action());
  value.destroy();
});
it('rejects forbidden collection deletes before changing the current ready set', () => {
  const value = store();
  value.append(action());
  const badPeer = new Y.Doc();
  Y.applyUpdate(badPeer, value.encodeUpdate());
  badPeer.getArray('envelopes').delete(0, 1);
  expect(() => value.applyUpdate(Y.encodeStateAsUpdate(badPeer))).toThrow('append-only');
  expect(value.snapshot()).toMatchObject({
    integrity: true,
    ready: [action()],
    heads: [action().id],
    diagnostics: [],
  });
  expect(value.snapshot().actions).toHaveLength(1);
  badPeer.destroy();
  value.destroy();
});

it('owns incoming update bytes so caller reuse cannot mutate canonical persistence', () => {
  const source = store();
  source.append(action());
  const target = store();
  const incoming = source.encodeUpdate();
  target.applyUpdate(incoming);
  incoming.fill(0);
  const reopened = store();
  reopened.applyUpdate(target.encodeUpdate());
  expect(reopened.snapshot()).toEqual(source.snapshot());
  source.destroy();
  target.destroy();
  reopened.destroy();
});

it('requires a validation function before creating a store', () => {
  expect(
    // @ts-expect-error Omitting validation cannot produce a usable action store.
    () => new ActionStore({ documentId: 'D', genesisId: 'G', genesisAllocations: [] }),
  ).toThrow('Action validation is required');
});
it('retains zero-valued group IDs as unsigned identities', () => {
  const value = store();
  value.append({ ...action(), groupId: { ...action().groupId, sequence: 0n } });
  expect(ready(value)).toHaveLength(1);
  value.destroy();
});

it('rejects deletion in a cold checkpoint as well as a live update', () => {
  const source = store();
  source.append(action());
  const badPeer = new Y.Doc();
  Y.applyUpdate(badPeer, source.encodeUpdate());
  badPeer.getArray('envelopes').delete(0, 1);
  const restored = store();
  expect(() => restored.applyUpdate(Y.encodeStateAsUpdate(badPeer))).toThrow('append-only');
  expect(restored.snapshot()).toMatchObject({
    integrity: true,
    actions: [],
    ready: [],
    diagnostics: [],
  });
  source.destroy();
  badPeer.destroy();
  restored.destroy();
});

it('converges on fork quarantine for every delivery order, including a fork before its descendants', () => {
  const a1 = action();
  const fork = { ...a1, groupId: { ...a1.groupId, sequence: 2n } };
  const a2 = action(A, 2n, [a1]);
  const b1 = action(B);
  const c1 = action(C, 1n, [a2]);
  let expected: ReturnType<ActionStore['snapshot']> | undefined;
  for (const order of permutations([a1, fork, a2, b1, c1])) {
    const value = store();
    for (const entry of order) {
      value.append(entry);
      const snapshot = value.snapshot();
      for (const accepted of snapshot.ready)
        expect(
          accepted.dependencies.every((id) =>
            snapshot.ready.some((dep) => actionKey(dep.id) === actionKey(id)),
          ),
        ).toBe(true);
    }
    expect(ready(value)).toEqual([actionKey(b1.id)]);
    if (expected) expect(value.snapshot()).toEqual(expected);
    else expected = value.snapshot();
    value.destroy();
  }
});
it('keeps an undo control pending until its target closure exists', () => {
  const target = action();
  const control: ActionEnvelope = {
    ...action(A, 2n, [target]),
    effects: [
      {
        type: 'SetGroupActive',
        group: target.groupId,
        actions: [target.id],
        active: false,
        previousControl: null,
      },
    ],
  };
  const validate = vi.fn<ActionStoreOptions['validate']>(() => null);
  const value = store({ validate });
  value.append(control);
  expect(status(value, control.id)).toEqual({ state: 'pending', missing: [target.id] });
  expect(validate).not.toHaveBeenCalled();
  value.append(target);
  expect(status(value, control.id)).toEqual({ state: 'ready' });
  expect(validate).toHaveBeenLastCalledWith(control, { dependencies: [target] });
  value.destroy();
});
it('permits same-action allocations while rejecting domain aliases and unknown native tapes', () => {
  const ownNode = resource('node', 0, action().id);
  const own: ActionEnvelope = {
    ...action(),
    allocations: [{ type: 'node', id: ownNode, role: 'inline', flow: null, birthSlot: null }],
    effects: [{ type: 'SetProperties', node: ownNode, values: {} }],
  };
  const value = store({ validate: () => null });
  value.append(own);
  expect(status(value, own.id)).toEqual({ state: 'ready' });
  value.destroy();
  const wrongDomain: ActionEnvelope = {
    ...own,
    allocations: [
      {
        type: 'node',
        id: ownNode,
        role: 'inline',
        flow: resource('flow', 0, own.id),
        birthSlot: null,
      },
    ],
  };
  const wrongTape: ActionEnvelope = {
    ...action(),
    nativeManifest: [
      {
        type: 'text',
        tape: resource('tape', 9),
        native: { client: 7, clock: 0, length: 1 },
        text: 'x',
      },
    ],
  };
  for (const entry of [wrongDomain, wrongTape]) {
    const bad = store({ validate: () => null });
    bad.append(entry);
    expect(status(bad, entry.id)).toEqual({ state: 'quarantined', reason: 'reference' });
    bad.destroy();
  }
});
it('rejects nonbinary canonical entries before changing the current ready set', () => {
  const badPeer = new Y.Doc();
  badPeer.getArray('envelopes').push([{ id: 'not an encoded envelope' }]);
  const value = store();
  value.append(action());
  const before = value.encodeUpdate();
  expect(() => value.applyUpdate(Y.encodeStateAsUpdate(badPeer))).toThrow('encoded envelope');
  expect(value.encodeUpdate()).toEqual(before);
  expect(value.snapshot()).toMatchObject({ integrity: true, ready: [action()], diagnostics: [] });
  badPeer.destroy();
  value.destroy();
});
