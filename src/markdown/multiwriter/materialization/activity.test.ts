import { expect, test, vi } from 'vitest';
import { A, B, C, action, resource } from '../actions/test-fixtures.js';
import type { ActionEnvelope } from '../contracts.js';
import { compareActions } from '../contracts.js';
import { encodeEnvelope } from '../actions/codec.js';
import { actionKey } from '../actions/references.js';
import { reduceActivity } from '../visibility/activity.js';
import type { Activity } from '../visibility/activity.js';
import { finish } from '../ingest/work.js';
import { MaterializedActivity } from './activity.js';
import { SeededRandom } from '../../../../test/multiwriter/network.js';
import { registerReadySource } from '../authoring/ready-source.js';
import { MaterializedReadyIndex, registerReadyAppend } from './ready-index.js';

const payloads = (actions: readonly ActionEnvelope[]) =>
  new Map(actions.map((a) => [actionKey(a.id), encodeEnvelope(a)]));
function publish(cache: MaterializedActivity, actions: readonly ActionEnvelope[]) {
  const sorted = [...actions].sort(compareActions);
  const candidate = finish(cache.prepare(sorted, payloads(sorted)));
  candidate.commit();
  return candidate.value;
}
function equal(actual: Activity, actions: readonly ActionEnvelope[], queries = true) {
  const reference = reduceActivity(actions);
  expect(actual.actions).toEqual(reference.actions);
  expect(actual.effects).toEqual(reference.effects);
  for (const action of actions) {
    expect(actual.isActive(action.id)).toBe(reference.isActive(action.id));
    action.effects.forEach((_, ordinal) =>
      expect(actual.isEffectActive({ action: action.id, ordinal })).toBe(
        reference.isEffectActive({ action: action.id, ordinal }),
      ),
    );
    if (queries)
      for (const prior of actions) {
        expect(actual.observes(action.id, prior.id)).toBe(reference.observes(action.id, prior.id));
        expect(actual.concurrent(action.id, prior.id)).toBe(
          reference.concurrent(action.id, prior.id),
        );
      }
  }
}
function chain(length: number) {
  const actions: ActionEnvelope[] = [];
  for (let i = 0; i < length; i++)
    actions.push({
      ...action(A, BigInt(i + 1), actions.length ? [actions.at(-1)!] : []),
      effects: [
        { type: 'SetProperties', node: resource('node', 0), values: { checked: i % 2 === 0 } },
      ],
    });
  return actions;
}
test('a warm causal append replays one action and never enumerates its ancestors', () => {
  const cache = new MaterializedActivity(),
    actions = chain(300);
  const old = publish(cache, actions);
  equal(old, actions, false);
  const next = {
    ...action(A, 301n, [actions.at(-1)!]),
    groupId: { ...actions[0].groupId, sequence: 2n },
  };
  const before = cache.diagnostics();
  const current = publish(cache, [...actions, next]);
  expect(cache.diagnostics()).toMatchObject({
    actionsReplayed: before.actionsReplayed + 1,
    frontierEntries: before.frontierEntries,
    lastReplayFrom: 300,
    lastReplayLength: 1,
  });
  equal(current, [...actions, next], false);
  equal(old, actions, false);
  const duplicate = publish(cache, [...actions, next]);
  expect(cache.diagnostics().lastReplayLength).toBe(0);
  equal(duplicate, [...actions, next], false);
});
test('late arrivals and withdrawals restore an exact compatible activity checkpoint', () => {
  const cache = new MaterializedActivity(),
    actions = chain(300);
  const old = publish(cache, actions);
  const late = { ...action(B, 1n, [actions[127]]), effects: actions[0].effects };
  const merged = [...actions, late].sort(compareActions);
  equal(publish(cache, merged), merged, false);
  expect(cache.diagnostics()).toMatchObject({
    checkpointRestores: 1,
    lastReplayFrom: 128,
    lastReplayLength: 173,
  });
  const withdrawn = [...actions.slice(0, 180), late].sort(compareActions);
  equal(publish(cache, withdrawn), withdrawn, false);
  expect(cache.diagnostics().lastReplayFrom).toBe(128);
  equal(old, actions, false);
  const coldBeforeEviction = cache.diagnostics().coldReplays;
  cache.evict();
  equal(publish(cache, withdrawn), withdrawn, false);
  expect(cache.diagnostics().coldReplays).toBe(coldBeforeEviction + 1);
  expect(cache.diagnostics().lastReplayFrom).toBe(0);
});
test('late controls update their old targets without mutating prior snapshots; redo retains ordinals', () => {
  const cache = new MaterializedActivity(),
    actions = chain(260),
    target = actions[0];
  const old = publish(cache, actions);
  const undo: ActionEnvelope = {
    ...action(A, 261n, [actions.at(-1)!]),
    groupId: { ...target.groupId, sequence: 10000n },
    effects: [
      {
        type: 'SetGroupActive',
        group: target.groupId,
        actions: actions.map((a) => a.id),
        active: false,
        previousControl: null,
      },
    ],
  };
  const inactive = publish(cache, [...actions, undo]);
  equal(inactive, [...actions, undo], false);
  expect(inactive.effects).toEqual([]);
  expect(cache.diagnostics().lastReplayLength).toBe(1);
  expect(old.effects).toHaveLength(260);
  const redo: ActionEnvelope = {
    ...action(A, 262n, [undo]),
    groupId: { ...target.groupId, sequence: 10001n },
    effects: [
      {
        type: 'SetGroupActive',
        group: target.groupId,
        actions: actions.map((a) => a.id),
        active: true,
        previousControl: undo.id,
      },
    ],
  };
  equal(publish(cache, [...actions, undo, redo]), [...actions, undo, redo], false);
  expect(inactive.effects).toEqual([]);
  equal(old, actions, false);
});
for (const seed of [1, 7, 42, 34064])
  test(`causal frontier queries equal full ancestor sets: ${seed}`, () => {
    const cache = new MaterializedActivity(),
      random = new SeededRandom(seed),
      actions: ActionEnvelope[] = [];
    const last = new Map<string, ActionEnvelope>(),
      actors = [A, B, C];
    for (let step = 0; step < 30; step++) {
      const actor = actors[random.next(3)],
        previous = last.get(actor),
        deps = previous ? [previous] : [];
      if (actions.length) {
        const peer = actions[random.next(actions.length)];
        if (!deps.includes(peer)) deps.push(peer);
      }
      const next = {
        ...action(actor, (previous?.id.sequence ?? 0n) + 1n, deps),
        effects: [
          { type: 'SetProperties' as const, node: resource('node', 0), values: { checked: true } },
        ],
      };
      actions.push(next);
      last.set(actor, next);
      equal(publish(cache, actions), actions);
    }
  });
test('exact payload replacement at a checkpoint boundary cannot reuse the old prefix', () => {
  const cache = new MaterializedActivity(),
    actions = chain(260);
  publish(cache, actions);
  const changed = actions.map((a, i) =>
    i === 127
      ? {
          ...a,
          effects: [
            {
              type: 'SetProperties' as const,
              node: resource('node', 0),
              values: { checked: null },
            },
          ],
        }
      : a,
  );
  equal(publish(cache, changed), changed, false);
  expect(cache.diagnostics().lastReplayFrom).toBe(0);
  expect(cache.diagnostics().lastReplayLength).toBe(260);
});
test('cancelled, superseded and evicted candidates cannot commit partial activity', () => {
  const actions = chain(10);
  for (let budget = 0; budget < 50; budget++) {
    const cache = new MaterializedActivity(),
      old = publish(cache, actions.slice(0, 4));
    const work = cache.prepare(actions, payloads(actions));
    for (let i = 0; i < budget; i++) if (work.next().done) break;
    work.return(undefined as never);
    equal(old, actions.slice(0, 4));
    const held = finish(cache.prepare(actions, payloads(actions)));
    cache.cancel();
    expect(() => held.commit()).toThrow('no longer current');
    equal(publish(cache, actions.slice(0, 4)), actions.slice(0, 4));
    const pending = finish(cache.prepare(actions, payloads(actions)));
    publish(cache, actions.slice(0, 5));
    expect(() => pending.commit()).toThrow('no longer current');
    const evicted = finish(cache.prepare(actions, payloads(actions)));
    cache.evict();
    expect(() => evicted.commit()).toThrow('no longer current');
    equal(publish(cache, actions), actions);
  }
});
test('mutating an output or input array cannot corrupt future activity roots or payload certificates', () => {
  const cache = new MaterializedActivity(),
    actions = chain(3),
    saved = structuredClone(actions);
  const old = publish(cache, actions);
  (old.actions[0] as { documentId: string }).documentId = 'mutated';
  (old.effects[0].effect as { values: { checked: boolean } }).values.checked = false;
  (actions[0] as { documentId: string }).documentId = 'input mutated';
  equal(publish(cache, saved), saved);
});
test('malformed controls fail closed and leave the committed activity reusable', () => {
  const cache = new MaterializedActivity(),
    actions = chain(3),
    target = actions[0];
  const old = publish(cache, actions);
  const bad: ActionEnvelope = {
    ...action(A, 4n, [actions[2]]),
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
  expect(() => publish(cache, [...actions, bad])).toThrow(/every action/);
  expect(() => reduceActivity([...actions, bad])).toThrow(/every action/);
  equal(old, actions);
  equal(publish(cache, actions), actions);
  expect(() => old.observes(action(B).id, target.id)).toThrow(/outside/);
  expect(() => old.isEffectActive({ action: target.id, ordinal: 2 })).toThrow(/ordinal/);
});

test('checkpoint retention is bounded and an invalidated prefix older than the cache replays cold', () => {
  const cache = new MaterializedActivity(),
    actions = chain(1280);
  publish(cache, actions);
  expect(cache.diagnostics().retainedCheckpoints).toBe(8);
  const late = action(B, 1n, [actions[0]]);
  const merged = [...actions, late].sort(compareActions);
  const before = cache.diagnostics().coldReplays;
  equal(publish(cache, merged), merged, false);
  expect(cache.diagnostics().lastReplayFrom).toBe(0);
  expect(cache.diagnostics().coldReplays).toBe(before + 1);
  expect(cache.diagnostics().retainedCheckpoints).toBe(8);
});

test('exact ready membership skips retained payloads in publication and unpublished staging', () => {
  const cache = new MaterializedActivity(),
    actions = chain(1000);
  const source = new MaterializedReadyIndex({}).refine(
    new Map(actions.map((action) => [actionKey(action.id), action])),
    1000n,
  );
  registerReadySource(actions, source);
  finish(cache.prepare(actions, payloads(actions))).commit();
  const old = publishIndexed(cache, actions, source);
  const next = action(A, 1001n, [actions.at(-1)!]),
    all = [...actions, next];
  const current = source.refine(new Map([[actionKey(next.id), next]]), next.lamport);
  registerReadySource(all, current);
  const at = vi.spyOn(all, 'at').mockImplementation((index) => {
    if (index !== actions.length) throw new Error('Enumerated retained actions');
    return next;
  });
  const bytes = payloads(all),
    get = vi.spyOn(bytes, 'get').mockImplementation((key) => {
      if (key !== actionKey(next.id)) throw new Error('Compared a retained payload');
      return encodeEnvelope(next);
    });
  const before = cache.diagnostics();
  try {
    const stage = { length: all.length, at: all.at.bind(all) };
    registerReadyAppend(stage, actions, next);
    equal(finish(cache.prepare(stage, bytes)).value, all, false);
    cache.cancel();
    const prepared = finish(cache.prepare(all, bytes));
    prepared.commit();
    equal(prepared.value, all, false);
    expect(cache.diagnostics().payloadsCompared - before.payloadsCompared).toBe(2);
    expect(cache.diagnostics().readyIndexNodesVisited - before.readyIndexNodesVisited).toBeLessThan(
      200,
    );
    equal(old, actions, false);
  } finally {
    at.mockRestore();
    get.mockRestore();
  }
});

function publishIndexed(
  cache: MaterializedActivity,
  actions: readonly ActionEnvelope[],
  source: MaterializedReadyIndex,
) {
  registerReadySource(actions, source);
  const candidate = finish(cache.prepare(actions, payloads(actions)));
  candidate.commit();
  return candidate.value;
}

test('an author activity fork requires the exact committed source and remains generation guarded', () => {
  const cache = new MaterializedActivity(),
    actions = chain(2);
  const entries = new Map(actions.map((a) => [actionKey(a.id), a]));
  const source = new MaterializedReadyIndex({}).refine(entries, 2n);
  const unrelated = new MaterializedReadyIndex({}).refine(entries, 2n);
  publishIndexed(cache, actions, source);
  expect(cache.authorBase(unrelated, actions.length)).toBeUndefined();
  expect(cache.authorBase(source, actions.length - 1)).toBeUndefined();
  const base = cache.authorBase(source, actions.length)!;
  expect(base).toBeDefined();
  base.assertCurrent();
  cache.cancel();
  expect(() => base.assertCurrent()).toThrow('invalidated');
  // A private fork's immutable prefix remains independently usable.
  const candidate = finish(base.branch.prepare(actions, payloads(actions)));
  equal(candidate.value, actions);
  base.branch.evict();
  cache.evict();
});

test('indexed earlier arrivals, replacements and unrelated sources retain exact prefix fallback', () => {
  for (const scenario of ['earlier', 'replace', 'withdraw', 'unrelated'] as const) {
    const cache = new MaterializedActivity(),
      actions = chain(260),
      owner = {};
    const source = new MaterializedReadyIndex(owner).refine(
      new Map(actions.map((a) => [actionKey(a.id), a])),
      260n,
    );
    const old = publishIndexed(cache, actions, source);
    let changed: readonly ActionEnvelope[], current: MaterializedReadyIndex;
    if (scenario === 'earlier') {
      const late = action(B, 1n, [actions[127]]);
      changed = [...actions, late].sort(compareActions);
      current = source.refine(new Map([[actionKey(late.id), late]]), 260n);
    } else if (scenario === 'replace') {
      changed = actions.map((a, i) =>
        i === 127 ? { ...a, documentId: 'different exact payload' } : a,
      );
      current = source.refine(new Map([[actionKey(changed[127].id), changed[127]]]), 260n);
    } else if (scenario === 'withdraw') {
      changed = actions.slice(0, 127);
      current = source.refine(
        new Map(actions.slice(127).map((a) => [actionKey(a.id), undefined])),
        127n,
      );
    } else {
      changed = actions;
      current = new MaterializedReadyIndex({}).refine(
        new Map(actions.map((a) => [actionKey(a.id), a])),
        260n,
      );
    }
    const before = cache.diagnostics();
    equal(publishIndexed(cache, changed, current), changed, false);
    expect(cache.diagnostics().payloadsCompared - before.payloadsCompared).toBe(changed.length);
    equal(old, actions, false);
    if (scenario === 'earlier') expect(cache.diagnostics().lastReplayFrom).toBe(128);
    if (scenario === 'replace') expect(cache.diagnostics().lastReplayFrom).toBe(0);
  }
});
