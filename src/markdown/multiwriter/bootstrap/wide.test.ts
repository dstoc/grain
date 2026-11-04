import { expect, test } from 'vitest';
import { compareBytes } from '../actions/cbor.js';
import {
  createGenesis,
  decodeBundle,
  decodeGenesis,
  encodeBundle,
  openBootstrap,
} from './index.js';
import { referenceGenesis } from './descriptor.js';
import { NativeTapeCache } from '../text/cache.js';

const enabled =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.MULTIWRITER_BOOTSTRAP_WIDE === '1';

// These are explicit local capacities for large bootstrap artifacts, not wire-format limits.
const limits = { bytes: 128 * 1024 * 1024, operations: 20_000_000, nativeOperations: 10_000_000 };
for (const count of [1000, 5000])
  test.runIf(enabled)(
    `wide ${count}-paragraph genesis cold-reconstructs exact native IDs and sibling order`,
    async () => {
      const started = performance.now();
      const markdown = Array.from({ length: count }, (_, i) => `p${i}`).join('\n\n');
      const bytes = createGenesis('wide', markdown, limits);
      console.info(
        `wide ${count}: constructed ${(performance.now() - started).toFixed(0)}ms, ${bytes.length} bytes`,
      );
      const opened = await openBootstrap({
        genesis: bytes,
        persistedGenesis: bytes,
        bootstrapLimits: limits,
        mode: 'disconnected',
        journal: { read: async () => [], append: async () => {}, close() {} },
      });
      console.info(`wide ${count}: opened ${(performance.now() - started).toFixed(0)}ms`);
      try {
        const p = opened.document.publication.status().publication!;
        expect(p.value.view.root.children.map((n) => n.content)).toEqual(
          Array.from({ length: count }, (_, i) => `p${i}`),
        );
        const bundle = decodeBundle(opened.captureBundle(), limits);
        const descriptor = decodeGenesis(bundle.genesis, limits);
        console.info(`wide ${count}: decoded ${(performance.now() - started).toFixed(0)}ms`);
        const cache = new NativeTapeCache(limits.nativeOperations);
        try {
          cache.apply('genesis', referenceGenesis(descriptor).body);
          // Vitest's iterable equality expands Uint8Array into Object.entries pairs.
          // Compare every byte without allocating one assertion object per byte.
          expect(compareBytes(cache.encodeState(), p.native.encodeState())).toBe(0);
          for (const tape of descriptor.allocations.filter((a) => a.type === 'tape'))
            expect(cache.snapshot(tape.id)).toEqual(p.native.snapshot(tape.id));
        } finally {
          cache.destroy();
        }
        console.info(`wide ${count}: native checked ${(performance.now() - started).toFixed(0)}ms`);
        expect(compareBytes(bundle.genesis, bytes)).toBe(0);
        expect(compareBytes(bundle.actionUpdate, opened.document.store.encodeUpdate())).toBe(0);
        expect(compareBytes(encodeBundle(bundle, limits), opened.captureBundle())).toBe(0);
        console.info(`wide ${count}: complete ${(performance.now() - started).toFixed(0)}ms`);
      } finally {
        await opened.close();
      }
    },
    60 * 60_000,
  );
