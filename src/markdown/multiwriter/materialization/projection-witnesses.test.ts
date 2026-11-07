import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { action, resource } from '../actions/test-fixtures.js';
import { actionKey } from '../actions/references.js';
import { compareActions } from '../contracts.js';
import type { ActionEnvelope, NodeId } from '../contracts.js';
import { registerReadySource } from '../authoring/ready-source.js';
import type { ReadySource } from '../authoring/ready-source.js';
import { captureDiagnostics } from '../diagnostics.js';
import { resourceKey } from '../layout/index.js';
import type { EffectRef } from '../visibility/activity.js';
import type { DestinationRequirement } from '../ownership/ownership.js';
import type { StructuralChanges } from './subdivision.js';
import { projectionChange } from './projection-adapter.js';

type Delta = {
  readonly ref: number;
  readonly before?: readonly number[];
  readonly after?: readonly number[];
};
const refKey = (ref: EffectRef) => `${actionKey(ref.action)}:${ref.ordinal}`;

/** Synthetic contribution deltas exercise the actual adapter. Real production
 * managed-command controls separately establish canonical/semantic behavior. */
function run(base: readonly (readonly number[])[], deltas: readonly Delta[], decline = false) {
  const p = commandReplica(commandGenesis('> first\n\nbarrier\n\n> second'));
  try {
    const publication = p.document.publication.status().publication!,
      value = publication.value,
      nodes: readonly NodeId[] = [
        value.view.root,
        value.view.root.children[0],
        value.view.root.children[2],
      ].map((n) => n.origin.representative),
      actions = Array.from(
        { length: Math.max(0, ...base.flat(), ...deltas.map((d) => d.ref)) + 2 },
        (_, i) => action(undefined, BigInt(i + 1)),
      ),
      byId = new Map(actions.map((a) => [actionKey(a.id), a]));
    const ref = (i: number): EffectRef => ({ action: actions[i].id, ordinal: 0 });
    const fresh: ActionEnvelope = decline
      ? {
          ...actions.at(-1)!,
          effects: [
            {
              type: 'SetGroupActive',
              actions: [action(undefined, 9999n).id],
              group: action(undefined, 9999n).groupId,
              active: false,
              previousControl: null,
            },
          ],
        }
      : actions.at(-1)!;
    const oldSource: ReadySource = {
      maxLamport: 1n,
      sequence: () => 0n,
      has: (key) => byId.has(key),
      get: (key) => byId.get(key),
      additions: () => undefined,
    };
    const source: ReadySource = {
      ...oldSource,
      additions: (previous) => {
        expect(previous).toBe(oldSource);
        return { actions: [fresh], nodesVisited: 1 };
      },
    };
    registerReadySource(actions, source);
    const binding = {
        native: publication.native,
        ready: oldSource,
        genesis: p.genesis.layout,
        checkpoint: {},
      },
      requirements = new Map(nodes.map((n, i) => [resourceKey(n), (base[i] ?? []).map(ref)])),
      snapshot = structuredClone(requirements);
    const requirement = (i: number, members: readonly number[]): DestinationRequirement => ({
      order: { action: actions[i], ordinal: 0 },
      nodes: members.map((i) => nodes[i]),
    });
    const changes: StructuralChanges = {
      base: binding,
      candidate: {
        ...binding,
        native: publication.native,
        ready: source,
        revision: 1,
        checkpoint: {},
      },
      actions: [],
      payloads: [],
      assignments: [],
      attachments: [],
      roots: [],
      subdivisions: [],
      tapes: [],
      layout: {
        nodes: [],
        runs: [],
        blocks: [],
        flows: [],
        occurrences: [
          {
            key: 'unchanged-destination',
            after: {
              id: resource('occurrence', 999),
              slot: { parent: nodes[2], predecessor: null },
              order: null,
            },
          },
        ],
      },
      derived: {
        cohorts: [],
        requirements: deltas.map((d, i) => ({
          key: String(i),
          before: d.before && requirement(d.ref, d.before),
          after: d.after && requirement(d.ref, d.after),
        })),
      },
      replayFrom: 0,
      replayTo: 1,
      reason: 'append',
    };
    const { value: result, report } = captureDiagnostics(() =>
      projectionChange(
        {
          value,
          producerBase: binding,
          source: oldSource,
          nodeRequirements: requirements,
          nodeAllocations: new Map(
            value.ownership.nodeAllocations.map((n) => [resourceKey(n.id), n]),
          ),
          tapeNodes: new Map(),
          flowHomes: new Map(),
        },
        {
          value: { ownership: value.ownership, changes, birthContent: [] },
          assertCurrent: () => {
            throw new Error('Adapter checked installation');
          },
          commit: () => {
            throw new Error('Adapter installed state');
          },
        },
        actions,
        publication.native,
        value.activity,
      ),
    );
    expect(requirements).toEqual(snapshot);
    const work = (name: string) => report.work[`driver/projection.adapterWitness${name}`] ?? 0;
    if (decline) {
      expect(result).toEqual({ state: 'fallback', reason: 'missing-control-target' });
      return { work, copied: 0 };
    }
    if (result.state !== 'adapted') throw new Error(result.reason);
    // Independent previous array semantics, with every intermediate scan/copy charged.
    const expected = new Map(requirements),
      touched = new Set<string>(),
      cost = { scans: 0, copies: 0 };
    for (const d of deltas) {
      if (d.before && d.after && JSON.stringify(d.before) === JSON.stringify(d.after)) continue;
      for (const member of [...(d.before ?? []), ...(d.after ?? [])])
        touched.add(resourceKey(nodes[member]));
      for (const member of d.before ?? []) {
        const key = resourceKey(nodes[member]);
        const filtered = (expected.get(key) ?? []).filter((r) => {
          cost.scans++;
          return refKey(r) !== refKey(ref(d.ref));
        });
        cost.copies += filtered.length;
        expected.set(key, filtered);
      }
      for (const member of d.after ?? []) {
        const key = resourceKey(nodes[member]),
          old = expected.get(key) ?? [];
        if (
          !old.some((r) => {
            cost.scans++;
            return refKey(r) === refKey(ref(d.ref));
          })
        ) {
          cost.copies += old.length;
          expected.set(key, [...old, ref(d.ref)]);
        }
      }
    }
    touched.add(resourceKey(nodes[2])); // Container-only reader: no edit-map seed.
    let final = 0;
    for (const key of touched) {
      const values = [...(expected.get(key) ?? [])].sort(
        (a, b) =>
          compareActions(byId.get(actionKey(a.action))!, byId.get(actionKey(b.action))!) ||
          a.ordinal - b.ordinal,
      );
      expected.set(key, values);
      final += values.length;
    }
    expect(result.change.requirements).toEqual(
      new Map([...touched].map((k) => [k, expected.get(k)])),
    );
    expect(work('EntriesCopied')).toBe(final);
    expect(work('FinalEntriesVisited')).toBe(final);
    expect(work('SortInputs')).toBe(final);
    expect(work('FinalNodes')).toBe(touched.size);
    // An addition that was already present preserves the old reference object.
    for (const [key, values] of result.change.requirements)
      for (const r of values) {
        const old = requirements.get(key)?.find((v) => refKey(v) === refKey(r));
        const removed = deltas.some(
          (d) =>
            d.before?.some((i) => resourceKey(nodes[i]) === key) &&
            refKey(ref(d.ref)) === refKey(r),
        );
        if (old && !removed) expect(r).toBe(old);
      }
    return { work, copied: final, oldCost: cost };
  } finally {
    p.close();
  }
}

for (const width of [8, 32, 128])
  for (const changed of [1, 4, 8])
    test(`adapter seeds each destination once (${width} witnesses, ${changed} deltas)`, () => {
      const result = run(
        [Array.from({ length: width }, (_, i) => i), [width + changed], [width + changed + 1]],
        Array.from({ length: changed }, (_, i) => ({ ref: i, before: [0] })).concat(
          Array.from({ length: changed }, (_, i) => ({
            ref: width + i,
            before: [] as number[],
            after: [0, 1],
          })),
        ),
      );
      expect(result.work('NodesSeeded')).toBe(2);
      expect(result.work('SeedEntriesVisited')).toBe(width + 1);
      expect(result.work('KeyedReads')).toBe(2 * changed);
      expect(result.work('KeyedUpdates')).toBe(width + 1 + 3 * changed);
      expect(result.copied).toBe(width + changed + 2);
      expect(result.oldCost!.scans).toBeGreaterThan(result.work('SeedEntriesVisited'));
    });

test('adapter handles empty removals, overlap and duplicate attempted additions', () => {
  const removed = run(
    [[1, 2], [], []],
    [
      { ref: 1, before: [0] },
      { ref: 2, before: [0] },
    ],
  );
  expect(removed.copied).toBe(0);
  expect(removed.work('SeedEntriesVisited')).toBe(2);
  expect(removed.work('KeyedUpdates')).toBe(4);
  const duplicates = run(
    [[1], [], []],
    [1, 1, 1, 2, 2].map((ref) => ({ ref, after: [0] })),
  );
  expect(duplicates.work('NodesSeeded')).toBe(1);
  expect(duplicates.work('KeyedReads')).toBe(5);
  expect(duplicates.work('KeyedUpdates')).toBe(2);
  const overlap = run([[1], [1], [2]], [{ ref: 1, before: [0, 1], after: [1, 2] }]);
  expect(overlap.work('NodesSeeded')).toBe(3);
  expect(overlap.work('SeedEntriesVisited')).toBe(3);
});

test('a later adapter decline still charges attempted witness edits', () => {
  const result = run(
    [[1, 2, 3], [], []],
    [
      { ref: 1, before: [0] },
      { ref: 4, after: [0, 1] },
    ],
    true,
  );
  expect(result.work('NodesSeeded')).toBe(2);
  expect(result.work('SeedEntriesVisited')).toBe(3);
  expect(result.work('KeyedReads')).toBe(2);
  expect(result.work('KeyedUpdates')).toBe(6);
  expect(result.work('EntriesCopied')).toBe(0);
  expect(result.work('FinalNodes')).toBe(0);
});
