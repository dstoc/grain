import { expect, test, vi } from 'vitest';
import { commandGenesis } from '../../../../test/multiwriter/commands/replica.js';
import { LayoutPrefix } from './layout.js';
import { MaterializedLayout } from '../materialization/layout.js';
import * as identity from './occurrences.js';
import { action, resource, B } from '../actions/test-fixtures.js';

for (const size of [150, 1000])
  for (const Constructor of [LayoutPrefix, MaterializedLayout])
    test(`${Constructor.name} indexes fresh occurrence membership for ${size} births`, () => {
      const genesis = commandGenesis(
        Array.from({ length: size }, () => 'abc').join('\n\n'),
        10_000_000,
      );
      const calls = vi.spyOn(identity, 'resourceKey');
      try {
        const layout = new Constructor(genesis.layout);
        expect(layout.children(layout.root)).toHaveLength(size);
        expect(calls.mock.calls.length).toBeLessThan(size * 100);
      } finally {
        calls.mockRestore();
      }
    });

for (const Constructor of [LayoutPrefix, MaterializedLayout])
  test(`${Constructor.name} validates only sequences changed by the current allocation batch`, () => {
    const genesis = commandGenesis(
      Array.from({ length: 150 }, (_, i) => `# s${i}\n\nabc`).join('\n\n'),
    );
    const layout = new Constructor(genesis.layout),
      parent = layout.children(layout.root).at(-1)!;
    const base = action(),
      node = resource('node', 0, base.id),
      occurrence = resource('occurrence', 1, base.id),
      slot = { parent, predecessor: null };
    const born = {
      ...base,
      allocations: [
        { type: 'node' as const, id: node, role: 'quote' as const, flow: null, birthSlot: slot },
        { type: 'occurrence' as const, id: occurrence, slot },
      ],
    };
    const input = { action: born, births: [{ node, occurrence }] };
    const calls = vi.spyOn(identity, 'resourceKey'),
      orders = vi.spyOn(identity, 'orderOccurrences');
    try {
      if (layout instanceof MaterializedLayout) layout.beginAction(input, () => true);
      else layout.beginAction(input);
      expect(calls.mock.calls.length).toBeLessThan(150);
      expect(orders).toHaveBeenCalledTimes(1);
      calls.mockClear();
      orders.mockClear();
      const next = { action: action(B, 1n, [born]), births: [] };
      if (layout instanceof MaterializedLayout) layout.beginAction(next, () => true);
      else layout.beginAction(next);
      expect(calls.mock.calls.length).toBe(0);
      expect(orders).not.toHaveBeenCalled();
    } finally {
      calls.mockRestore();
      orders.mockRestore();
    }
    expect(layout.children(parent)).toContainEqual(node);
  });

for (const Constructor of [LayoutPrefix, MaterializedLayout])
  test(`${Constructor.name} rejects a cycle among new anchors in a retained sequence`, () => {
    const genesis = commandGenesis('abc'),
      layout = new Constructor(genesis.layout),
      base = action();
    const nodes = [resource('node', 0, base.id), resource('node', 1, base.id)],
      occurrences = [resource('occurrence', 2, base.id), resource('occurrence', 3, base.id)],
      slots = occurrences.map((_, i) => ({ parent: layout.root, predecessor: occurrences[1 - i] }));
    const born = {
      ...base,
      allocations: nodes.flatMap((node, i) => [
        {
          type: 'node' as const,
          id: node,
          role: 'quote' as const,
          flow: null,
          birthSlot: slots[i],
        },
        { type: 'occurrence' as const, id: occurrences[i], slot: slots[i] },
      ]),
    };
    const input = {
      action: born,
      births: nodes.map((node, i) => ({ node, occurrence: occurrences[i] })),
    };
    expect(() =>
      layout instanceof MaterializedLayout
        ? layout.beginAction(input, () => true)
        : layout.beginAction(input),
    ).toThrow('Cyclic occurrence predecessors');
  });
