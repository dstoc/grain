import { expect, test } from 'vitest';
import { NativeTapeCache } from '../text/cache.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { MaterializedNative } from './native.js';
import { finish } from '../ingest/work.js';
import { compareBytes } from '../actions/cbor.js';
import { get, set } from './map.js';
import type { MapRoot } from './map.js';
import { resource } from '../actions/test-fixtures.js';
import type { NativeInsertion } from '../text/types.js';
import type { RangeRef } from '../contracts.js';

const seed = [
  { id: 'root', parent: null, role: 'root' as const },
  {
    id: 'P',
    parent: 'root',
    role: 'inline' as const,
    flow: 'fP',
    run: 'rP',
    tape: 'tP',
    cells: [
      { id: 'left', text: 'a😀' },
      { id: 'right', text: 'bc' },
    ],
  },
];

for (const size of [64, 4096])
  test(`native range reads seek directly into a fragmented tape (${size})`, () => {
    const cache = new NativeTapeCache(10_000_000),
      materialized = new MaterializedNative(10_000_000);
    const tape = resource('tape', 0),
      start = resource('marker', 0),
      end = resource('marker', 1);
    const operations: NativeInsertion[] = [{ type: 'createTape', tape, start, end }],
      ranges: RangeRef[] = [];
    let before = start,
      offset = 1;
    for (let i = 0; i < size; i++) {
      const marker = resource('marker', i + 2);
      operations.push({ type: 'text', tape, index: offset, text: 'a😀' });
      offset += 3;
      operations.push({ type: 'marker', tape, index: offset++, marker, affinity: 'right' });
      ranges.push({ tape, start: before, end: marker });
      before = marker;
    }
    try {
      const prepared = cache.prepare('G', operations);
      prepared.commit();
      finish(materialized.apply('G', prepared.body));
      const held = materialized.view();
      for (const index of [0, 1, Math.floor(size / 2), size - 1]) {
        const before = { ...materialized.work },
          actual = held.range(ranges[index]);
        expect(actual).toEqual(cache.range(ranges[index]));
        expect(materialized.work.rangePartsVisited - before.rangePartsVisited).toBe(1);
        const seeks = materialized.work.rangeIndexNodesVisited - before.rangeIndexNodesVisited;
        expect(seeks).toBeGreaterThan(0);
        expect(seeks).toBeLessThan(16);
        (actual[0].range as { clock: number }).clock = -1;
        expect(held.range(ranges[index])).toEqual(cache.range(ranges[index]));
      }
      expect(held.range({ tape, start: ranges.at(-1)!.end, end })).toEqual([]);
      expect(() => held.range({ ...ranges[0], end: ranges[0].start })).toThrow(/Invalid open/);
      const first = held.range(ranges[0]);
      const edited = cache.prepare('edit', [{ type: 'text', tape, index: 2, text: 'x' }]);
      edited.commit();
      finish(materialized.apply('edit', edited.body));
      expect(materialized.view().range(ranges[0])).toEqual(cache.range(ranges[0]));
      expect(
        materialized
          .view()
          .range(ranges[0])
          .map((part) => part.text)
          .join(''),
      ).toBe('ax😀');
      expect(held.range(ranges[0])).toEqual(first);
    } finally {
      cache.destroy();
      materialized.destroy();
    }
  }, 60000);
test('persistent roots retain old values through sorted and reverse key updates', () => {
  let root: MapRoot<number> | undefined;
  for (let i = 0; i < 5000; i++) root = set(root, String(i).padStart(5, '0'), i);
  const old = root;
  for (let i = 4999; i >= 0; i--) root = set(root, String(i).padStart(5, '0'), -i);
  for (let i = 0; i < 5000; i++) {
    const key = String(i).padStart(5, '0');
    expect(get(old, key)).toBe(i);
    expect(get(root, key)).toBe(-i);
  }
  expect(root!.height).toBeLessThan(20);
});

test('indexed native reads match cache validation and keep every returned object detached', () => {
  const fixture = new NativeFixture(seed),
    cache = new NativeTapeCache(),
    materialized = new MaterializedNative(100000);
  try {
    const body = fixture.bodies.get('G')!;
    cache.apply('G', body);
    finish(materialized.apply('G', body));
    const view = materialized.view();
    for (const allocation of body.allocations) {
      if (allocation.type === 'tape')
        expect(view.snapshot(allocation.id)).toEqual(cache.snapshot(allocation.id));
      if (allocation.type === 'marker')
        expect(view.marker(allocation.id)).toEqual(cache.marker(allocation.id));
    }
    for (const entry of body.nativeManifest)
      if (entry.type === 'text') {
        const range = { tape: entry.tape, ...entry.native };
        expect(view.lookup(range)).toEqual(cache.lookup(range));
        for (let i = 0; i < range.length; i++) {
          const id = { client: range.client, clock: range.clock + i };
          let reference;
          try {
            reference = cache.locate(range.tape, id);
          } catch {
            expect(() => view.locate(range.tape, id)).toThrow();
            continue;
          }
          expect(view.locate(range.tape, id)).toBe(reference);
        }
        for (const invalid of [
          { ...range, length: 0 },
          { ...range, clock: -1 },
          { ...range, length: range.length + 100000 },
          { ...range, client: 0x100000000 },
        ])
          expect(() => view.lookup(invalid)).toThrow();
      }
    const tape = body.allocations.find((a) => a.type === 'tape')!;
    if (tape.type !== 'tape') throw new Error();
    const interval = { tape: tape.id, start: tape.start, end: tape.end };
    expect(view.range(interval)).toEqual(cache.range(interval));
    expect(() => view.range({ ...interval, start: tape.end, end: tape.start })).toThrow();
    const detached = view.snapshot(tape.id);
    (detached.parts as unknown[]).length = 0;
    expect(view.snapshot(tape.id)).toEqual(cache.snapshot(tape.id));
    const marker = view.marker(tape.end);
    (marker.native as { clock: number }).clock = -1;
    expect(view.marker(tape.end)).toEqual(cache.marker(tape.end));
    expect(compareBytes(view.encodeState(), cache.encodeState())).toBe(0);
  } finally {
    fixture.destroy();
    cache.destroy();
    materialized.destroy();
  }
});

test('text changes retain permanent marker bindings while new brackets index only their own bindings', () => {
  const fixture = new NativeFixture(seed),
    materialized = new MaterializedNative(100000);
  try {
    finish(materialized.apply('G', fixture.bodies.get('G')!));
    const before = materialized.view();
    const marker = fixture.id('P:end', 'marker');
    const initial = materialized.work.markerBindingsIndexed;
    fixture.author('A1', (f) => f.insert('interior', 'x', 'P:after-a😀'));
    finish(materialized.apply('A1', fixture.bodies.get('A1')!));
    expect(materialized.work.markerBindingsIndexed).toBe(initial);
    expect(materialized.view().marker(marker).index).toBe(before.marker(marker).index + 1);
    const prior = materialized.view();
    fixture.author('A2', (f) => f.insert('edge', 'z', 'P:end'), ['A1'], 2n);
    const body = fixture.bodies.get('A2')!;
    finish(materialized.apply('A2', body));
    expect(materialized.work.markerBindingsIndexed - initial).toBe(2);
    for (const allocation of body.allocations)
      if (allocation.type === 'marker')
        expect(materialized.view().marker(allocation.id)).toEqual(
          fixture.peers.get('A')!.marker(allocation.id),
        );
    expect(before.marker(marker).index).toBe(prior.marker(marker).index - 1);
  } finally {
    fixture.destroy();
    materialized.destroy();
  }
});
