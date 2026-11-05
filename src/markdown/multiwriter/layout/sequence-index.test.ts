import { afterEach, expect, test, vi } from 'vitest';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { LayoutPrefix } from './layout.js';
import * as ordering from './occurrences.js';

const seed = (size: number) => [
  { id: 'root', role: 'root' as const, parent: null },
  ...Array.from({ length: size }, (_, i) => ({
    id: `P${i}`,
    role: 'inline' as const,
    parent: 'root',
    flow: `f${i}`,
    run: `r${i}`,
    tape: `t${i}`,
    cells: [],
  })),
];
afterEach(() => vi.restoreAllMocks());
for (const size of [10, 150])
  test(`fresh reference boundary queries do not scan ${size} unrelated block occurrences`, () => {
    const f = new NativeFixture(seed(size));
    try {
      const prefix = new LayoutPrefix(f.genesis),
        slot = f.slots.get(`P${size - 1}:end`)!;
      const sequence = vi.spyOn(ordering, 'slotSequence');
      expect(prefix.occurrenceOrder(slot)).toEqual([]);
      expect(sequence).toHaveBeenCalledTimes(1);
      sequence.mockRestore();
      expect(() => prefix.occurrenceOrder(slot, [{ roots: [] }])).toThrow(
        'Empty occurrence bucket',
      );
      expect(prefix.children(prefix.root)).toEqual(
        Array.from({ length: size }, (_, i) => f.id(`P${i}`, 'node')),
      );
    } finally {
      f.destroy();
    }
  });

test('fresh sequence indexes retain inactive ghost anchors and isolate run/boundary/side sequences', () => {
  const f = new NativeFixture(seed(3));
  try {
    const first = f.author('A1', (f) => [f.join('f1', 'P0:end')]),
      second = f.author('A2', (f) => [f.join('f2', 'P1:end')], ['A1'], 2n);
    const prefix = new LayoutPrefix(f.genesis);
    prefix.beginAction(first);
    prefix.step(0, false);
    prefix.beginAction(second);
    prefix.step(0, true);
    const slot = f.slots.get('P0:end')!;
    const values = prefix.occurrenceOrder(slot);
    expect(values.map((v) => v.id)).toEqual(
      first.action.allocations.filter((a) => a.type === 'occurrence').map((a) => a.id),
    );
    expect(prefix.joinedFlows(slot)).toEqual([]);
    expect(prefix.joinedFlows(f.slots.get('P1:end')!)).toEqual([f.id('f2', 'flow')]);
    expect(prefix.occurrenceOrder({ ...slot, side: 'right' })).toEqual([]);
    const list = values as unknown[];
    list.length = 0;
    expect(prefix.occurrenceOrder(slot)).toHaveLength(1);
    expect(prefix.children(prefix.root)).toHaveLength(3);
  } finally {
    f.destroy();
  }
});
