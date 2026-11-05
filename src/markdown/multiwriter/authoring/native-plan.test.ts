import { expect, test, vi } from 'vitest';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { nativeView } from '../ingest/publication.js';
import { resource } from '../actions/test-fixtures.js';
import * as layout from '../layout/index.js';
import { NativePlan } from './native-plan.js';

const seed = (size: number) => [
  { id: 'root', parent: null, role: 'root' as const },
  ...Array.from({ length: size }, (_, i) => ({
    id: `P${i}`,
    parent: 'root',
    role: 'inline' as const,
    flow: `f${i}`,
    run: `r${i}`,
    tape: `t${i}`,
    cells: [{ id: `text${i}`, text: 'abc' }],
  })),
];
for (const size of [10, 150])
  test(`permanent marker queries do not scan ${size} loaded planned tapes`, () => {
    const f = new NativeFixture(seed(size));
    try {
      const cache = f.peers.get('A')!,
        native = nativeView(cache);
      const plan = new NativePlan({
        native,
        tapes: f.genesis.allocations.flatMap((a) => (a.type === 'tape' ? [a.id] : [])),
        clients: new Set(f.bodies.get('G')!.nativeManifest.map((m) => m.native.client)),
      });
      plan.all();
      const marker = f.id(`P${size - 1}:end`, 'marker'),
        expected = cache.marker(marker);
      const calls = vi.spyOn(layout, 'resourceKey');
      try {
        expect(plan.marker(marker)).toEqual(expected);
        expect(calls.mock.calls.length).toBeLessThan(5);
      } finally {
        calls.mockRestore();
      }
    } finally {
      f.destroy();
    }
  });

test('lazy planned queries load one tape and keep public snapshots and markers detached', () => {
  const f = new NativeFixture(seed(10));
  try {
    const cache = f.peers.get('A')!,
      native = nativeView(cache),
      reads = vi.fn(native.snapshot);
    const plan = new NativePlan({
      native: { ...native, snapshot: reads },
      tapes: [],
      clients: new Set(),
    });
    const tape = f.id('t0', 'tape'),
      end = f.id('P0:end', 'marker'),
      text = f.aliases.get('text0')!,
      range = f.ranges.get('text0')!;
    const exports = vi.spyOn(plan, 'snapshot');
    try {
      expect(plan.marker(end)).toEqual(cache.marker(end));
      expect(plan.locate(tape, text)).toBe(cache.locate(tape, text));
      expect(plan.lookup(text)).toEqual(cache.lookup(text));
      expect(plan.range(range)).toEqual(cache.range(range));
      expect(exports).not.toHaveBeenCalled();
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      exports.mockRestore();
    }
    const snapshot = plan.snapshot(tape),
      marker = plan.marker(end);
    (snapshot.parts as unknown[]).length = 0;
    (marker.native as { clock: number }).clock = -1;
    (marker.tape as { ordinal: number }).ordinal = -1;
    expect(plan.snapshot(tape)).toEqual(cache.snapshot(tape));
    expect(plan.marker(end)).toEqual(cache.marker(end));
    expect(() => plan.marker(resource('marker', 9999))).toThrow();
  } finally {
    f.destroy();
  }
});

test('planned insertions refresh marker positions only on their tape and preserve old exports', () => {
  const f = new NativeFixture(seed(2));
  try {
    const cache = f.peers.get('A')!,
      tapes = f.genesis.allocations.flatMap((a) =>
        a.type === 'tape' ? [cache.snapshot(a.id)] : [],
      ),
      plan = new NativePlan(tapes);
    const tape = f.id('t0', 'tape'),
      end = f.id('P0:end', 'marker'),
      other = f.id('P1:end', 'marker');
    const before = plan.marker(end),
      untouched = plan.marker(other),
      old = plan.snapshot(tape);
    const text = plan.add({ type: 'text', tape, index: 3, text: '😀' });
    const marker = resource('marker', 0);
    plan.add({ type: 'marker', tape, index: 5, marker, affinity: 'right' });
    expect(plan.marker(end).index).toBe(before.index + 3);
    expect(plan.marker(marker).index).toBe(5);
    expect(plan.marker(other)).toEqual(untouched);
    expect(old).toEqual(tapes[0]);
    expect(before).toEqual(cache.marker(end));
    const prepared = cache.prepare('bind-plan', plan.operations);
    prepared.commit();
    expect(plan.snapshot(tape).parts.map((p) => (p.type === 'text' ? p.text : 'M'))).toEqual(
      cache.snapshot(tape).parts.map((p) => (p.type === 'text' ? p.text : 'M')),
    );
    const bound = plan.bind(text[0], nativeView(cache));
    expect(
      bound
        .flatMap((r) => cache.lookup(r))
        .map((p) => p.text)
        .join(''),
    ).toBe('😀');
  } finally {
    f.destroy();
  }
});
