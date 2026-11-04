import { describe, expect, it } from 'vitest';
import { replaceEdge } from './forest.js';
import type { ForestEdge } from './forest.js';

interface Move {
  time: number;
  child: number;
  parent: number;
}
interface Edge {
  child: number;
  parent: number;
  meta: number;
}
interface Logged extends Move {
  old: Edge | undefined;
}

/** Independent Figure-4 oracle: edge triples, descendant closure, undo/do/redo log.
 * https://martin.kleppmann.com/papers/move-op.pdf, Figure 4, lines 26–49.
 * No production forest operations or ancestor walk are used here. Paper deletion
 * via trash is deliberately excluded: Grain deletion never removes raw edges.
 */
class PublishedReplay {
  tree: Edge[];
  log: Logged[] = [];
  constructor(parents: readonly (number | null)[]) {
    this.tree = parents.flatMap((parent, child) =>
      parent === null ? [] : [{ child, parent, meta: -1 }],
    );
  }
  private do(move: Move): Logged {
    const old = this.tree.find((edge) => edge.child === move.child);
    const descendants = new Set([move.child]);
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of this.tree) {
        if (descendants.has(edge.parent) && !descendants.has(edge.child)) {
          descendants.add(edge.child);
          changed = true;
        }
      }
    }
    if (!descendants.has(move.parent)) {
      this.tree = this.tree.filter((edge) => edge.child !== move.child);
      this.tree.push({ child: move.child, parent: move.parent, meta: move.time });
    }
    return { ...move, old };
  }
  apply(move: Move): void {
    const redo: Logged[] = [];
    while (this.log.length && this.log[0].time > move.time) {
      const prior = this.log.shift()!;
      this.tree = this.tree.filter((edge) => edge.child !== prior.child);
      if (prior.old) this.tree.push(prior.old);
      redo.push(prior);
    }
    this.log.unshift(this.do(move));
    while (redo.length) this.log.unshift(this.do(redo.pop()!));
  }
}
function permutations<T>(values: readonly T[]): T[][] {
  return values.length === 0
    ? [[]]
    : values.flatMap((value, index) =>
        permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest]),
      );
}
function replay(
  parents: readonly (number | null)[],
  moves: readonly Move[],
): Map<number, ForestEdge<number, number>> {
  const forest = new Map(parents.map((parent, child) => [child, { parent, value: -1 }]));
  for (const move of [...moves].sort((a, b) => a.time - b.time)) {
    replaceEdge(forest, move.child, move.parent, move.time, true);
  }
  return forest;
}
function triples(forest: Map<number, ForestEdge<number, number>>): Edge[] {
  return [...forest].flatMap(([child, edge]) =>
    edge.parent === null ? [] : [{ child, parent: edge.parent, meta: edge.value }],
  );
}
function sorted(edges: readonly Edge[]): Edge[] {
  return [...edges].sort((a, b) => a.child - b.child);
}

it('distinguishes role, cycle, missing allocation and successful metadata replacement', () => {
  const tree = replay([null, 0, 1], []);
  expect(replaceEdge(tree, 1, 2, 4, false)).toBe('role');
  expect(replaceEdge(tree, 1, 2, 4, true)).toBe('cycle');
  expect(replaceEdge(tree, 1, 1, 4, true)).toBe('cycle');
  expect(tree.get(1)).toEqual({ parent: 0, value: -1 });
  expect(replaceEdge(tree, 2, 0, 5, true)).toBe('applied');
  expect(replaceEdge(tree, 1, 2, 6, true)).toBe('applied');
  expect(tree.get(1)).toEqual({ parent: 2, value: 6 });
  expect(() => replaceEdge(tree, 1, 9, 4, true)).toThrow('Missing');
});

describe('published move fixtures', () => {
  it('Figure 1: same child has only the later destination', () => {
    expect(
      replay(
        [null, 0, 0, 0],
        [
          { time: 1, child: 1, parent: 2 },
          { time: 2, child: 1, parent: 3 },
        ],
      ).get(1),
    ).toEqual({ parent: 3, value: 2 });
  });
  it('Figure 2: the later opposing move is ineffective', () => {
    const tree = replay(
      [null, 0, 0],
      [
        { time: 1, child: 1, parent: 2 },
        { time: 2, child: 2, parent: 1 },
      ],
    );
    expect(tree.get(1)?.parent).toBe(2);
    expect(tree.get(2)?.parent).toBe(0);
  });
  it('reclassifies late safe→unsafe and unsafe→safe (§3.5)', () => {
    const late = { time: 2, child: 1, parent: 2 };
    expect(replay([null, 0, 0], [late]).get(1)?.parent).toBe(2);
    expect(replay([null, 0, 0], [late, { time: 1, child: 2, parent: 1 }]).get(1)?.parent).toBe(0);
    expect(replay([null, 0, 1], [late]).get(1)?.parent).toBe(0);
    expect(replay([null, 0, 1], [late, { time: 1, child: 2, parent: 0 }]).get(1)?.parent).toBe(2);
  });
  it('matches independent log replay at every delivery prefix over exhaustive three-move schedules', () => {
    let comparisons = 0;
    const choices = [1, 2, 3].flatMap((child) => [0, 1, 2, 3].map((parent) => ({ child, parent })));
    for (const parents of [
      [null, 0, 0, 0],
      [null, 0, 1, 2],
    ] as const) {
      for (const a of choices)
        for (const b of choices)
          for (const c of choices) {
            const moves = [a, b, c].map((move, index) => ({ ...move, time: index + 1 }));
            for (const schedule of permutations(moves)) {
              const oracle = new PublishedReplay(parents);
              const held: Move[] = [];
              for (const move of schedule) {
                oracle.apply(move);
                held.push(move);
                expect(sorted(triples(replay(parents, held)))).toEqual(sorted(oracle.tree));
                expect(oracle.log).toHaveLength(held.length); // Unsafe requests must remain in the log.
                comparisons++;
              }
            }
          }
    }
    expect(comparisons).toBe(62208);
  }, 30000);
});
