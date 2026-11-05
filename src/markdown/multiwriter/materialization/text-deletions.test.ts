import { expect, test } from 'vitest';
import { A, B, action, resource } from '../actions/test-fixtures.js';
import type { ActiveEffect } from '../visibility/activity.js';
import { reduceActivity } from '../visibility/activity.js';
import { reduceVisibility } from '../visibility/visibility.js';
import type { TextToken, VisibilityLayout } from '../visibility/visibility.js';
import { resourceKey } from '../visibility/identity.js';
import { ExactTextDeletions, indexedVisibility } from './text-deletions.js';

const counts = () => ({
  exactDeletionRangesIndexed: 0,
  exactDeletionQueries: 0,
  exactDeletionNodesVisited: 0,
});
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
    index = new ExactTextDeletions({ effects }, work);
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
        expect([...new Set(index.tags(token(clock, client, source)).map(resourceKey))]).toEqual(
          expected,
        );
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
    index = new ExactTextDeletions({ effects }, work);
  for (const clock of [0, 1, 2, 8191, 8192, 8193, 8194, 16380, 16381, 16382]) {
    const before = work.exactDeletionNodesVisited;
    expect(index.tags(token(clock))).toEqual(
      clock % 4 < 2 ? [resource('deletion', Math.floor(clock / 4))] : [],
    );
    expect(work.exactDeletionNodesVisited - before).toBeLessThanOrEqual(14);
  }
  expect(index.tags(token(1, 8))).toEqual([]);
  expect(index.tags(token(1, 7, otherTape))).toEqual([]);
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
