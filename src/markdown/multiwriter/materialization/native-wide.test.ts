import { expect, test } from 'vitest';
import { NativeTapeCache } from '../text/cache.js';
import type { NativeInsertion } from '../text/types.js';
import type { ResourceId, ResourceKind } from '../contracts.js';
import { compareBytes } from '../actions/cbor.js';
import { finish } from '../ingest/work.js';
import { MaterializedNative } from './native.js';
const resource = <K extends ResourceKind>(kind: K, ordinal: number): ResourceId<K> => ({
  kind,
  ordinal,
  birth: { type: 'genesis', genesisId: 'wide-native' },
});

// These are native-stage work gates, not command/projection or full MW-13 gates.
for (const size of [1000, 5000])
  test(`native append indexes one tape among ${size} retained tapes`, () => {
    const writer = new NativeTapeCache(10_000_000),
      reader = new MaterializedNative(10_000_000);
    try {
      const operations: NativeInsertion[] = [];
      for (let i = 0; i < size; i++) {
        const tape = resource('tape', i),
          start = resource('marker', i * 4),
          end = resource('marker', i * 4 + 1);
        operations.push(
          { type: 'createTape', tape, start, end },
          {
            type: 'marker',
            tape,
            index: 1,
            marker: resource('marker', i * 4 + 2),
            affinity: 'left',
          },
          { type: 'text', tape, index: 2, text: 'abc' },
          {
            type: 'marker',
            tape,
            index: 5,
            marker: resource('marker', i * 4 + 3),
            affinity: 'right',
          },
        );
      }
      const genesis = writer.prepare('genesis', operations);
      genesis.commit();
      finish(reader.apply('genesis', genesis.body));
      const old = reader.view(),
        before = { ...reader.work },
        oldFirst = old.snapshot(resource('tape', 0));
      const last = old.snapshot(resource('tape', size - 1));
      const edit = writer.prepare('edit', [
        { type: 'text', tape: resource('tape', 0), index: 3, text: 'X' },
      ]);
      edit.commit();
      finish(reader.apply('edit', edit.body));
      expect(reader.work.bodiesIntegrated - before.bodiesIntegrated).toBe(1);
      expect(reader.work.tapesIndexed - before.tapesIndexed).toBe(1);
      expect(reader.work.partsIndexed - before.partsIndexed).toBeLessThan(10);
      const current = reader.view();
      expect(current.snapshot(resource('tape', 0))).toEqual(writer.snapshot(resource('tape', 0)));
      expect(current.snapshot(resource('tape', size - 1))).toEqual(last);
      expect(old.snapshot(resource('tape', 0))).toEqual(oldFirst);
      expect(compareBytes(current.encodeState(), writer.encodeState())).toBe(0);
    } finally {
      reader.destroy();
      writer.destroy();
    }
  }, 120000);
