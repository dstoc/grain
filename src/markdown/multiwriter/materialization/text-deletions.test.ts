import { expect, test } from 'vitest';
import { A, B, action, resource } from '../actions/test-fixtures.js';
import type { ActiveEffect } from '../visibility/activity.js';
import { reduceActivity } from '../visibility/activity.js';
import type { Activity } from '../visibility/activity.js';
import { reduceVisibility, reduceVisibilityWithTextTags } from '../visibility/visibility.js';
import type { TextToken, VisibilityLayout } from '../visibility/visibility.js';
import { resourceKey } from '../visibility/identity.js';
import { ExactTextDeletions } from './text-deletions.js';
import { captureDiagnostics } from '../diagnostics.js';

const counts = () => ({
  exactDeletionRangesIndexed: 0,
  exactDeletionQueries: 0,
  exactDeletionNodesVisited: 0,
});
const indexedVisibility =
  (work: ReturnType<typeof counts>) =>
  (activity: Activity, layout: VisibilityLayout, tokens: readonly TextToken[]) => {
    const index = ExactTextDeletions.fromEffects(activity, work);
    return reduceVisibilityWithTextTags(
      activity,
      layout,
      tokens,
      () => true,
      (token) => index.matches(token),
    );
  };
const tape = resource('tape', 0),
  otherTape = resource('tape', 1);
const token = (clock: number, client = 7, source = tape): TextToken => ({
  tape: source,
  native: { client, clock },
  birth: null,
});

test('exact interval queries match an independent scan across overlaps, clients and tapes', () => {
  let seed = 94013;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const effects: ActiveEffect[] = Array.from({ length: 200 }, (_, ordinal) => ({
    action: { actor: A, sequence: 1n },
    ordinal,
    effect: {
      type: 'DeleteText',
      tag: resource('deletion', ordinal),
      observed: Array.from({ length: 3 }, () => ({
        tape: random(2) ? tape : otherTape,
        client: 7 + random(2),
        clock: random(200),
        length: random(40),
      })),
    },
  }));
  const work = counts(),
    index = ExactTextDeletions.fromEffects({ effects }, work);
  for (const source of [tape, otherTape])
    for (const client of [7, 8, 9])
      for (let clock = 0; clock < 241; clock++) {
        const expected = effects.flatMap(({ effect }) =>
          effect.type === 'DeleteText' &&
          effect.observed.some(
            (range) =>
              resourceKey(range.tape) === resourceKey(source) &&
              range.client === client &&
              range.clock <= clock &&
              clock - range.clock < range.length,
          )
            ? [resourceKey(effect.tag)]
            : [],
        );
        expect([
          ...new Set(
            [...index.matches(token(clock, client, source))]
              .sort((a, b) => a.order - b.order)
              .map((match) => resourceKey(match.tag)),
          ),
        ]).toEqual(expected);
      }
  expect(work.exactDeletionRangesIndexed).toBe(600);
});

test('disjoint retained deletion intervals need logarithmic query work, including both endpoints', () => {
  const effects: ActiveEffect[] = Array.from({ length: 4096 }, (_, ordinal) => ({
    action: { actor: A, sequence: 1n },
    ordinal,
    effect: {
      type: 'DeleteText',
      tag: resource('deletion', ordinal),
      observed: [{ tape, client: 7, clock: ordinal * 4, length: 2 }],
    },
  }));
  const work = counts(),
    index = ExactTextDeletions.fromEffects({ effects }, work);
  for (const clock of [0, 1, 2, 8191, 8192, 8193, 8194, 16380, 16381, 16382]) {
    const before = work.exactDeletionNodesVisited;
    expect(index.matches(token(clock)).map((match) => match.tag)).toEqual(
      clock % 4 < 2 ? [resource('deletion', Math.floor(clock / 4))] : [],
    );
    expect(work.exactDeletionNodesVisited - before).toBeLessThanOrEqual(14);
  }
  expect(index.matches(token(1, 8))).toEqual([]);
  expect(index.matches(token(1, 7, otherTape))).toEqual([]);
});

test('indexed exact tags preserve interleaved subtree tag order, duplicates and inactive controls', () => {
  const root = resource('node', 0),
    node = resource('node', 1),
    interval = { tape, start: resource('marker', 0), end: resource('marker', 1) };
  const first = action(A),
    second = action(B, 1n, [first]),
    last = action(A, 2n, [first, second]);
  const exact = { tape, client: 7, clock: 1, length: 3 };
  const actions = [
    {
      ...first,
      effects: [
        {
          type: 'DeleteText' as const,
          tag: resource('deletion', 0, first.id),
          observed: [exact, exact],
        },
      ],
    },
    {
      ...second,
      effects: [
        {
          type: 'DeleteSubtree' as const,
          tag: resource('deletion', 0, second.id),
          scope: {
            target: node,
            observedNodes: [node],
            ownedIntervals: [interval],
            joinedFlows: [],
            heads: second.dependencies,
          },
        },
      ],
    },
    {
      ...last,
      effects: [
        { type: 'DeleteText' as const, tag: resource('deletion', 0, last.id), observed: [exact] },
      ],
    },
  ];
  const layout: VisibilityLayout = {
    nodes: [root, node].map((id, i) => ({
      type: 'node',
      id,
      role: i ? 'inline' : 'root',
      flow: null,
      birthSlot: i ? { parent: root, predecessor: null } : null,
    })),
    parent: (id) => (id === root ? null : root),
    owner: () => node,
    requirements: () => [],
    contains: (_, value) => value.native.clock >= 2,
    containsBirthContent: () => false,
  };
  const tokens = Array.from({ length: 5 }, (_, i) => token(i)),
    activity = reduceActivity(actions),
    work = counts();
  expect(indexedVisibility(work)(activity, layout, tokens)).toEqual(
    reduceVisibility(activity, layout, tokens),
  );
  const undo = {
    ...action(A, 3n, actions),
    effects: [
      {
        type: 'SetGroupActive' as const,
        group: first.groupId,
        actions: [first.id, last.id],
        active: false,
        previousControl: null,
      },
    ],
  };
  const inactive = reduceActivity([...actions, undo]);
  expect(indexedVisibility(work)(inactive, layout, tokens)).toEqual(
    reduceVisibility(inactive, layout, tokens),
  );
});

for (const finalKind of ['exact', 'subtree'] as const)
  test(`reused tags follow their first covering declaration: ${finalKind}`, () => {
    const root = resource('node', 0),
      node = resource('node', 1),
      a = action(A);
    const first = resource('deletion', 0, a.id),
      second = resource('deletion', 1, a.id);
    const activity = reduceActivity([
      {
        ...a,
        effects: [
          { type: 'DeleteText', tag: first, observed: [{ tape, client: 7, clock: 0, length: 1 }] },
          { type: 'DeleteText', tag: second, observed: [{ tape, client: 7, clock: 1, length: 1 }] },
          finalKind === 'exact'
            ? {
                type: 'DeleteText',
                tag: first,
                observed: [{ tape, client: 7, clock: 1, length: 1 }],
              }
            : {
                type: 'DeleteSubtree',
                tag: first,
                scope: {
                  target: node,
                  observedNodes: [node],
                  ownedIntervals: [
                    { tape, start: resource('marker', 0), end: resource('marker', 1) },
                  ],
                  joinedFlows: [],
                  heads: [],
                },
              },
        ],
      },
    ]);
    const layout: VisibilityLayout = {
      nodes: [root, node].map((id, i) => ({
        type: 'node',
        id,
        role: i ? 'inline' : 'root',
        flow: null,
        birthSlot: i ? { parent: root, predecessor: null } : null,
      })),
      parent: (id) => (id === root ? null : root),
      owner: () => node,
      requirements: () => [],
      contains: () => true,
      containsBirthContent: () => false,
    };
    expect(indexedVisibility(counts())(activity, layout, [token(1)])).toEqual(
      reduceVisibility(activity, layout, [token(1)]),
    );
  });

// Controlled semantic deltas exercise C without claiming a B producer.
test('persistent contributions preserve first-covering order through earlier arrival, retraction and reactivation', () => {
  const early = action(A),
    late = action(B);
  const first = resource('deletion', 0, early.id),
    second = resource('deletion', 0, late.id);
  const range = (clock: number) => ({ tape, client: 7, clock, length: 1 });
  const a = {
    ...early,
    effects: [
      { type: 'DeleteText' as const, tag: first, observed: [range(0)] },
      { type: 'DeleteText' as const, tag: second, observed: [range(1)] },
    ],
  };
  const b = {
    ...late,
    effects: [{ type: 'DeleteText' as const, tag: first, observed: [range(1)] }],
  };
  const work = counts();
  const held = ExactTextDeletions.create([b], () => true, work);
  const inserted = held.update([a], () => true, work);
  expect(held.tags(token(1), work)).toEqual([first]);
  expect(inserted.tags(token(1), work)).toEqual([second, first]);
  const inactive = inserted.update([a], () => false, work);
  expect(inactive.tags(token(1), work)).toEqual([first]);
  expect(inactive.update([a], () => true, work).tags(token(1), work)).toEqual([second, first]);
  const withdrawn = inserted.update([], () => true, work, [{ action: a.id, ordinal: 1 }]);
  expect(withdrawn.tags(token(1), work)).toEqual([first]);
  expect(inserted.tags(token(1), work)).toEqual([second, first]);
  // The full reducer derives order independently from original envelopes.
  const root = resource('node', 0);
  const layout: VisibilityLayout = {
    nodes: [{ type: 'node', id: root, role: 'root', flow: null, birthSlot: null }],
    parent: () => null,
    owner: () => root,
    requirements: () => [],
    contains: () => false,
    containsBirthContent: () => false,
  };
  expect(inserted.tags(token(1), work)).toEqual(
    reduceVisibility(reduceActivity([b, a]), layout, [token(1)]).text[0].tags,
  );
});

test('one contribution update on a long tape copies logarithmic paths and leaves held roots unchanged', () => {
  const a = action(A),
    work = counts();
  const body = {
    ...a,
    effects: Array.from({ length: 4096 }, (_, ordinal) => ({
      type: 'DeleteText' as const,
      tag: resource('deletion', ordinal),
      observed: [{ tape, client: 7, clock: ordinal * 4, length: 2 }],
    })),
  };
  const held = ExactTextDeletions.create([body], () => true, work);
  const update = {
    ...action(B),
    effects: [
      {
        type: 'DeleteText' as const,
        tag: resource('deletion', 0, action(B).id),
        observed: [{ tape, client: 7, clock: 3, length: 1 }],
      },
    ],
  };
  const { value: next, report } = captureDiagnostics(() => held.update([update], () => true, work));
  expect(report.work['driver/deletion.changedEffectsInspected']).toBe(1);
  expect(report.work['driver/deletion.rangesIndexed']).toBe(1);
  expect(report.work['driver/deletion.intervalNodesSummarized']).toBeLessThan(30);
  expect(report.work['driver/deletion.fullIndexesConstructed'] ?? 0).toBe(0);
  expect(held.tags(token(3), work)).toEqual([]);
  expect(next.tags(token(3), work)).toEqual([update.effects[0].tag]);
  const removed = next.update([], () => true, work, [{ action: update.id, ordinal: 0 }]);
  expect(removed.tags(token(3), work)).toEqual([]);
  expect(next.tags(token(3), work)).toEqual([update.effects[0].tag]);
});
