import { expect, it } from 'vitest';
import { NativeFixture } from './test-fixtures.js';
import { resourceKey } from '../layout/index.js';
import type { OwnershipResult } from './index.js';

function observation(f: NativeFixture, result: OwnershipResult) {
  const top = result.flowPlacements.filter((flow) => flow.parent.type === 'block');
  const raw = top.map((flow) => result.raw(flow.flow));
  const cells = raw.flat().flatMap((entry) => (entry.type === 'cell' ? [entry] : []));
  expect(cells).toHaveLength(result.assignments.length);
  const keys = cells.map((cell) =>
    JSON.stringify([
      resourceKey(cell.assignment.cell.tape),
      resourceKey(cell.assignment.cell.start),
      resourceKey(cell.assignment.cell.end),
    ]),
  );
  expect(new Set(keys).size).toBe(keys.length);
  const text = cells
    .flatMap((cell) => cell.fragments)
    .flatMap((fragment) =>
      Array.from(
        { length: fragment.range.length },
        (_, offset) => `${fragment.range.client}:${fragment.range.clock + offset}`,
      ),
    );
  expect(new Set(text).size).toBe(text.length);
  expect(text.length).toBe(8);
  for (const home of f.homes) {
    expect(result.containsBoundary(home.cell, home.cell.start)).toBe(true);
    expect(result.containsBoundary(home.cell, home.cell.end)).toBe(true);
  }
  return {
    assignments: result.assignments,
    runs: result.runLayouts,
    flows: result.flowPlacements,
    raw,
    buckets: result.buckets,
    requirements: result.destinationRequirements,
    blocks: result.nodeAllocations.map((node) => result.blockPlacement(node.id)),
  };
}

it.each(Array.from({ length: 24 }, (_, i) => i + 0x8500))(
  'preserves total identity coverage across generated native/semantic replay (seed %i)',
  (seed) => {
    let state = seed;
    const next = (limit: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state >>> 8) % limit;
    };
    const f = new NativeFixture([
      { id: 'root', parent: null, role: 'root' },
      {
        id: 'P',
        parent: 'root',
        role: 'inline',
        flow: 'fP',
        run: 'rP',
        tape: 'tP',
        cells: [...'abcdef'].map((text, index) => ({ id: `P${index}`, text })),
      },
      {
        id: 'Q',
        parent: 'root',
        role: 'inline',
        flow: 'fQ',
        run: 'rQ',
        tape: 'tQ',
        cells: [...'XY'].map((text, index) => ({ id: `Q${index}`, text })),
      },
    ]);
    try {
      const names = ['A1', 'B1', 'C1'];
      for (const [i, name] of names.entries()) {
        const cut = next(6);
        const from = next(5);
        const to = from + 1 + next(6 - from);
        const type = next(4);
        f.author(name, (f) => {
          switch (type) {
            case 0:
              return [f.split('P', `S${i}`, `P${cut}`)];
            case 1:
              return [
                f.transfer(
                  Array.from({ length: to - from }, (_, offset) => `P${from + offset}`),
                  'Q:end',
                  `rT${i}`,
                ),
              ];
            case 2:
              return [f.join('fQ', 'P:end'), f.split('P', `S${i}`, `P${cut}`)];
            default:
              return [f.move('Q', 'P'), f.split('P', `S${i}`, `P${cut}`)];
          }
        });
        observation(f, f.reduce(name[0]));
      }
      let expected: ReturnType<typeof observation> | undefined;
      for (const schedule of [names, [...names].reverse(), [names[1], names[2], names[0]]]) {
        for (let prefix = 1; prefix <= schedule.length; prefix++) {
          f.fresh('C', schedule.slice(0, prefix));
          observation(f, f.reduce());
        }
        const original = f.peers.get('C')!.snapshot(f.id('tP', 'tape'));
        const actual = observation(f, f.reduce());
        if (expected) expect(actual).toEqual(expected);
        else expected = actual;
        for (const disabled of names) {
          observation(f, f.reduce('C', [disabled]));
          expect(observation(f, f.reduce())).toEqual(expected);
        }
        f.deliver('A', 'C', names);
        expect(observation(f, f.reduce())).toEqual(expected);
        expect(f.peers.get('C')!.snapshot(f.id('tP', 'tape'))).toEqual(original);
      }
    } finally {
      f.destroy();
    }
  },
);
