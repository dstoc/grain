import { expect, test, vi } from 'vitest';
import { NativeTapeCache } from '../text/cache.js';
import type { NativeBody, NativeInsertion, TapeSnapshot } from '../text/types.js';
import { resource } from '../actions/test-fixtures.js';
import { compareBytes } from '../actions/cbor.js';
import { finish } from '../ingest/work.js';
import { SeededRandom } from '../../../../test/multiwriter/network.js';
import { MaterializedNative } from './native.js';

const tape = resource('tape', 0),
  start = resource('marker', 0),
  end = resource('marker', 1);
function prepare(
  cache: NativeTapeCache,
  key: string,
  operations: readonly NativeInsertion[],
): NativeBody {
  const value = cache.prepare(key, operations);
  value.commit();
  return value.body;
}
function initial(cache: NativeTapeCache, text = 'abcd😀') {
  return prepare(cache, 'G', [
    { type: 'createTape', tape, start, end },
    { type: 'text', tape, index: 1, text },
  ]);
}
function boundaries(snapshot: TapeSnapshot) {
  const points: number[] = [];
  for (const part of snapshot.parts) {
    if (part.type === 'marker') {
      if (part.index) points.push(part.index);
      continue;
    }
    for (let offset = 0; offset < part.text.length; offset++) {
      const before = part.text.charCodeAt(offset - 1),
        after = part.text.charCodeAt(offset);
      if (!(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff))
        points.push(part.index + offset);
    }
  }
  return points;
}

for (const size of [64, 4096])
  test(`native insertion copies interval paths without exporting a ${size}-fragment tape`, () => {
    const writer = new NativeTapeCache(10_000_000),
      reader = new MaterializedNative(10_000_000);
    try {
      const operations: NativeInsertion[] = [{ type: 'createTape', tape, start, end }];
      for (let i = 0; i < size; i++)
        operations.push(
          { type: 'text', tape, index: 1 + i * 2, text: 'x' },
          {
            type: 'marker',
            tape,
            index: 2 + i * 2,
            marker: resource('marker', i + 2),
            affinity: 'right',
          },
        );
      finish(reader.apply('G', prepare(writer, 'G', operations)));
      const held = reader.view(),
        old = held.snapshot(tape),
        before = { ...reader.work };
      const body = prepare(writer, 'A', [{ type: 'text', tape, index: size, text: '😀' }]);
      const snapshots = vi
        .spyOn(NativeTapeCache.prototype, 'snapshotSteps')
        .mockImplementation(() => {
          throw new Error('Native indexing exported the whole tape');
        });
      try {
        finish(reader.apply('A', body));
      } finally {
        snapshots.mockRestore();
      }
      expect(reader.work.partsIndexed - before.partsIndexed).toBe(1);
      expect(reader.work.nativeIndexNodesCopied - before.nativeIndexNodesCopied).toBeLessThan(100);
      expect(reader.view().snapshot(tape)).toEqual(writer.snapshot(tape));
      expect(held.snapshot(tape)).toEqual(old);
      expect(compareBytes(reader.view().encodeState(), writer.encodeState())).toBe(0);
    } finally {
      reader.destroy();
      writer.destroy();
    }
  }, 60000);

test('merged Yjs text items and later subdivisions preserve exact parts and held native positions', () => {
  const writer = new NativeTapeCache(),
    reader = new MaterializedNative(100000);
  try {
    finish(reader.apply('G', initial(writer, 'abc')));
    const held = reader.view(),
      old = held.snapshot(tape);
    for (const [key, operations] of [
      ['append', [{ type: 'text', tape, index: 4, text: '😀' }]],
      ['split', [{ type: 'text', tape, index: 2, text: 'X' }]],
      [
        'bracket',
        [
          { type: 'marker', tape, index: 3, marker: resource('marker', 2), affinity: 'left' },
          { type: 'text', tape, index: 4, text: 'yz' },
        ],
      ],
    ] as const) {
      const body = prepare(writer, key, operations);
      finish(reader.apply(key, body));
      expect(reader.view().snapshot(tape)).toEqual(writer.snapshot(tape));
      for (const part of writer.snapshot(tape).parts)
        expect(reader.view().locate(tape, part.native)).toBe(part.index);
      for (const part of old.parts) expect(held.locate(tape, part.native)).toBe(part.index);
      expect(held.snapshot(tape)).toEqual(old);
    }
    expect(() => reader.view().locate(tape, { ...old.parts[1].native, clock: 999999 })).toThrow();
  } finally {
    reader.destroy();
    writer.destroy();
  }
});

test('native interval roots match independent concurrent carriers in both delivery orders and on duplicates', () => {
  const a = new NativeTapeCache(),
    b = new NativeTapeCache();
  try {
    const genesis = initial(a);
    b.apply('G', genesis);
    const first = prepare(a, 'A', [{ type: 'text', tape, index: 2, text: 'A' }]),
      second = prepare(b, 'B', [
        { type: 'text', tape, index: 2, text: 'B' },
        { type: 'marker', tape, index: 3, marker: resource('marker', 2), affinity: 'right' },
      ]);
    a.apply('B', second);
    const third = prepare(a, 'C', [{ type: 'text', tape, index: 4, text: '😀' }]);
    for (const schedule of [
      ['A', 'B', 'C'],
      ['B', 'A', 'C'],
    ]) {
      const cache = new NativeTapeCache(),
        reader = new MaterializedNative(100000),
        bodies = new Map([
          ['G', genesis],
          ['A', first],
          ['B', second],
          ['C', third],
        ]);
      try {
        cache.apply('G', genesis);
        finish(reader.apply('G', genesis));
        const held = reader.view(),
          old = held.snapshot(tape);
        for (const key of schedule) {
          cache.apply(key, bodies.get(key)!);
          finish(reader.apply(key, bodies.get(key)!));
          expect(reader.view().snapshot(tape)).toEqual(cache.snapshot(tape));
          finish(reader.apply(key, bodies.get(key)!));
          expect(reader.view().snapshot(tape)).toEqual(cache.snapshot(tape));
          expect(held.snapshot(tape)).toEqual(old);
        }
        expect(compareBytes(reader.view().encodeState(), cache.encodeState())).toBe(0);
      } finally {
        reader.destroy();
        cache.destroy();
      }
    }
  } finally {
    a.destroy();
    b.destroy();
  }
});

test('seeded mixed native insertions retain exact Yjs segmentation and every prior read root', () => {
  const writer = new NativeTapeCache(),
    reader = new MaterializedNative(100000),
    random = new SeededRandom(34064),
    held: { view: ReturnType<MaterializedNative['view']>; snapshot: TapeSnapshot }[] = [];
  try {
    finish(reader.apply('G', initial(writer)));
    for (let i = 0; i < 300; i++) {
      const current = reader.view();
      if (i % 30 === 0) held.push({ view: current, snapshot: current.snapshot(tape) });
      const options = boundaries(writer.snapshot(tape)),
        index = options[random.next(options.length)];
      const operation: NativeInsertion =
        i % 3
          ? { type: 'text', tape, index, text: i % 2 ? '😀x' : 'y' }
          : {
              type: 'marker',
              tape,
              index,
              marker: resource('marker', i + 2),
              affinity: i % 2 ? 'left' : 'right',
            };
      finish(reader.apply(`A${i}`, prepare(writer, `A${i}`, [operation])));
      expect(reader.view().snapshot(tape)).toEqual(writer.snapshot(tape));
      for (const part of writer.snapshot(tape).parts)
        expect(reader.view().locate(tape, part.native)).toBe(part.index);
    }
    for (const { view, snapshot } of held) {
      expect(view.snapshot(tape)).toEqual(snapshot);
      for (const part of snapshot.parts) expect(view.locate(tape, part.native)).toBe(part.index);
    }
  } finally {
    reader.destroy();
    writer.destroy();
  }
}, 60000);

test('cancelling after one touched tape is indexed keeps every published root intact', () => {
  const writer = new NativeTapeCache(),
    reader = new MaterializedNative(100000),
    other = resource('tape', 1),
    otherStart = resource('marker', 2),
    otherEnd = resource('marker', 3);
  try {
    const body = prepare(writer, 'G', [
      { type: 'createTape', tape, start, end },
      { type: 'text', tape, index: 1, text: 'abc' },
      { type: 'createTape', tape: other, start: otherStart, end: otherEnd },
      { type: 'text', tape: other, index: 1, text: 'xyz' },
    ]);
    finish(reader.apply('G', body));
    const held = reader.view(),
      old = [held.snapshot(tape), held.snapshot(other)],
      before = reader.work.tapesIndexed;
    const update = prepare(writer, 'A', [
      { type: 'text', tape, index: 2, text: '😀' },
      { type: 'text', tape: other, index: 2, text: '!' },
    ]);
    const work = reader.apply('A', update);
    while (reader.work.tapesIndexed === before) expect(work.next().done).toBe(false);
    expect(reader.work.tapesIndexed).toBe(before + 1);
    work.return();
    expect([reader.view().snapshot(tape), reader.view().snapshot(other)]).toEqual(old);
    expect([held.snapshot(tape), held.snapshot(other)]).toEqual(old);
    expect(() => finish(reader.apply('A', update))).toThrow(/Cancelled native indexing/);
  } finally {
    reader.destroy();
    writer.destroy();
  }
});
