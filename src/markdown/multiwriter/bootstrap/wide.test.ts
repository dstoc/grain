import { expect, test } from 'vitest';
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
      try {
        const p = opened.document.publication.status().publication!;
        expect(p.value.view.root.children.map((n) => n.content)).toEqual(
          Array.from({ length: count }, (_, i) => `p${i}`),
        );
        const bundle = decodeBundle(opened.captureBundle(), limits);
        const descriptor = decodeGenesis(bundle.genesis, limits);
        const cache = new NativeTapeCache(limits.nativeOperations);
        try {
          cache.apply('genesis', referenceGenesis(descriptor).body);
          expect(cache.encodeState()).toEqual(p.native.encodeState());
          for (const tape of descriptor.allocations.filter((a) => a.type === 'tape'))
            expect(cache.snapshot(tape.id)).toEqual(p.native.snapshot(tape.id));
        } finally {
          cache.destroy();
        }
        expect(bundle.genesis).toEqual(bytes);
        expect(bundle.actionUpdate).toEqual(opened.document.store.encodeUpdate());
        expect(encodeBundle(bundle, limits)).toEqual(opened.captureBundle());
        console.info(`wide ${count}: complete ${(performance.now() - started).toFixed(0)}ms`);
      } finally {
        await opened.close();
      }
    },
    60 * 60_000,
  );
