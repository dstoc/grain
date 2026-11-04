import { expect, test } from 'vitest';
import * as Y from 'yjs';
import { parseBlocks } from '../block-parser/api.js';
import { createGenesis, decodeGenesis, openBootstrap } from './bootstrap/index.js';
import { encodeBundle, encodeGenesis } from './bootstrap/index.js';
import { referenceGenesis } from './bootstrap/descriptor.js';
import { serializeToString } from '../block-serializer.js';
import { SYNC_DIRECTIONS } from './contracts.js';
import type { SyncMode } from './contracts.js';
import { openReferenceDocument } from './reference/document.js';
import type { ReferenceGenesis } from './reference/document.js';
import { serializeProjection } from './projection/index.js';
import { encodeEnvelope } from './actions/codec.js';
import { encodeCbor, decodeCbor } from './actions/cbor.js';
import { envelopeToWire } from './actions/schema.js';

import { publication, insert } from '../../../test/multiwriter/bootstrap-helpers.js';
function construct(source: string): ReferenceGenesis {
  const limits = { operations: 1_000_000 };
  return referenceGenesis(decodeGenesis(createGenesis('bootstrap-test', source, limits), limits));
}
const sources = [
  '',
  'ordinary 😀 text\n\nsecond paragraph',
  '# Title\n\n## Child\n\nbody\n',
  '- [x] done\n- [ ] todo\n  - nested\n',
  '> quote\n>\n> - list\n',
  '```ts\nconst x = "😀";\n\n```',
  'Title\n===\n',
  '---\n\n    indented\n',
];
test.each(sources)('parsed genesis projects canonical supported Markdown: %j', (source) => {
  const genesis = construct(source),
    document = openReferenceDocument(genesis);
  try {
    const p = publication(document);
    const exported = serializeProjection(p.value.view);
    expect(exported).toBe(serializeToString(parseBlocks(source).node));
    const imported = construct(exported);
    const fresh = openReferenceDocument(imported);
    try {
      expect(serializeProjection(publication(fresh).value.view)).toBe(exported);
      expect(imported.genesisId).not.toBe(genesis.genesisId);
    } finally {
      fresh.destroy();
    }
    expect(document.store.snapshot().ready).toEqual([]);
    const markerCount = genesis.layout.allocations.filter((a) => a.type === 'marker').length;
    const inlines = genesis.layout.allocations.filter((a) => a.type === 'flow').length;
    expect(markerCount).toBeLessThanOrEqual(4 * inlines);
    expect(new Set(genesis.layout.allocations.map((a) => a.id.ordinal)).size).toBe(
      genesis.layout.allocations.length,
    );
  } finally {
    document.destroy();
  }
});
test('independent snapshots retain common native identity, detached inputs, and one shared empty paragraph', () => {
  const genesis = construct(''),
    a = openReferenceDocument(genesis),
    b = openReferenceDocument(structuredClone(genesis));
  try {
    const before = publication(a);
    genesis.body.nativeInsertUpdates[0].fill(0);
    expect(publication(b).native.encodeState()).toEqual(before.native.encodeState());
    expect(before.value.view.root.children).toHaveLength(1);
    expect(before.value.ownership.homeBindings).toHaveLength(1);
    expect(before.value.view).toEqual(publication(b).value.view);
  } finally {
    a.destroy();
    b.destroy();
  }
  expect(construct('').genesisId).not.toBe(construct('').genesisId);
});
test('two offline initial insertions converge and cold reconstruction reuses native IDs', () => {
  const genesis = construct(''),
    a = openReferenceDocument(genesis),
    b = openReferenceDocument(genesis),
    c = openReferenceDocument(genesis);
  try {
    a.store.append(insert(genesis, 'x', 1));
    b.store.append(insert(genesis, 'y', 2));
    const ua = a.store.encodeUpdate(),
      ub = b.store.encodeUpdate();
    a.store.applyUpdate(ub);
    b.store.applyUpdate(ua);
    c.store.applyUpdate(b.store.encodeUpdate());
    const pa = publication(a),
      pb = publication(b),
      pc = publication(c);
    expect(pa.native.encodeState()).toEqual(pb.native.encodeState());
    expect(pa.native.encodeState()).toEqual(pc.native.encodeState());
    expect(pa.value.view).toEqual(pc.value.view);
    expect(pa.value.view.root.children).toHaveLength(1);
    expect([...pa.value.view.root.children[0].content].sort()).toEqual(['x', 'y']);
    expect(a.store.encodeUpdate()).toEqual(c.store.encodeUpdate());
    const bytes = c.store.encodeUpdate();
    publication(c);
    serializeProjection(pc.value.view);
    expect(c.store.encodeUpdate()).toEqual(bytes);
  } finally {
    a.destroy();
    b.destroy();
    c.destroy();
  }
});
test('an old writer can address the original nonempty genesis after cold reconstruction', () => {
  const genesis = construct('original😀');
  const delayed = insert(genesis, '!', 1);
  const source = openReferenceDocument(genesis);
  const reconstructed = openReferenceDocument(structuredClone(genesis));
  try {
    const originalIds = publication(source).value.view.root.children[0].fragments.map(
      (f) => f.range,
    );
    reconstructed.store.applyUpdate(source.store.encodeUpdate());
    const carrier = new Y.Doc({ gc: false });
    try {
      carrier.getArray('envelopes').push([encodeEnvelope(delayed)]);
      reconstructed.store.applyUpdate(Y.encodeStateAsUpdate(carrier));
    } finally {
      carrier.destroy();
    }
    const result = publication(reconstructed);
    expect(reconstructed.store.snapshot().ready).toHaveLength(1);
    expect(serializeProjection(result.value.view)).toBe('original😀!\n');
    const lookup = (ranges: typeof originalIds) =>
      ranges.map((range) => result.native.lookup(range).map((fragment) => fragment.range));
    expect(lookup(originalIds)).toEqual(originalIds.map((range) => [range]));
  } finally {
    source.destroy();
    reconstructed.destroy();
  }
});
for (const mode of Object.keys(SYNC_DIRECTIONS) as SyncMode[])
  for (const route of ['peer', 'catch-up', 'self-echo', 'cross-tab'] as const)
    test(`fresh-join tail uses receive gate: ${mode}/${route}`, async () => {
      const genesis = construct(''),
        source = openReferenceDocument(genesis);
      const entries: Uint8Array[] = [];
      const attachment = await openBootstrap({
        genesis: encodeGenesisDescriptor(genesis),
        persistedGenesis: encodeGenesisDescriptor(genesis),
        mode,
        journal: {
          read: async () => [],
          append: async (u) => {
            entries.push(u.slice());
          },
          close() {},
        },
      });
      const { provider, document: joined } = attachment;
      try {
        source.store.append(insert(genesis, 'x', 1));
        const before = joined.store.encodeUpdate();
        expect(
          attachment.receiveBundle(
            route,
            encodeBundle({
              genesis: attachment.genesisBytes(),
              actionUpdate: source.store.encodeUpdate(),
            }),
          ).state,
        ).toBe(SYNC_DIRECTIONS[mode].receive ? 'admitted' : 'disabled');
        expect(joined.store.snapshot().ready.length).toBe(SYNC_DIRECTIONS[mode].receive ? 1 : 0);
        if (!SYNC_DIRECTIONS[mode].receive) expect(joined.store.encodeUpdate()).toEqual(before);
        provider.setMode('bidirectional');
        attachment.receiveBundle(
          route,
          encodeBundle({
            genesis: attachment.genesisBytes(),
            actionUpdate: source.store.encodeUpdate(),
          }),
        );
        expect(serializeProjection(publication(joined).value.view)).toBe('x\n');
        await provider.flush();
      } finally {
        await attachment.close();
        source.destroy();
      }
    });
test('complete carrier bootstrap retains unresolved outer structs and unsupported envelopes', () => {
  const genesis = construct(''),
    original = insert(genesis, 'x', 1);
  const carrier = new Y.Doc({ gc: false }),
    a = openReferenceDocument(genesis),
    reopened = openReferenceDocument(genesis);
  const updates: Uint8Array[] = [];
  carrier.on('update', (u: Uint8Array) => updates.push(u.slice()));
  const wire = envelopeToWire(original) as Record<string, never>;
  const oldVersion = encodeCbor({ ...wire, protocolVersion: 2n });
  try {
    carrier.getArray('envelopes').push([oldVersion]);
    carrier.getArray('envelopes').push([encodeEnvelope(original)]);
    a.store.applyUpdate(updates[1]);
    expect(a.store.snapshot().actions).toHaveLength(0);
    reopened.store.applyUpdate(a.store.encodeUpdate());
    expect(reopened.store.encodeUpdate()).toEqual(a.store.encodeUpdate());
    reopened.store.applyUpdate(updates[0]);
    a.store.applyUpdate(updates[0]);
    expect(reopened.store.snapshot().ready).toEqual([]); // same-ID version conflict quarantines both
    expect(reopened.store.snapshot()).toEqual(a.store.snapshot());
    expect(reopened.store.encodeUpdate()).toEqual(a.store.encodeUpdate());
    expect(serializeProjection(publication(reopened).value.view)).toBe(
      serializeToString(parseBlocks('').node),
    );
    expect(decodeCbor(oldVersion)).toHaveProperty('protocolVersion', 2n);
  } finally {
    carrier.destroy();
    a.destroy();
    reopened.destroy();
  }
});
test.each([10, 150])(
  'wide parsed genesis retains raw sibling order and native identity after cold open: %i',
  (size) => {
    const source = Array.from({ length: size }, (_, i) => `paragraph ${i}`).join('\n\n');
    const genesis = construct(source),
      a = openReferenceDocument(genesis),
      b = openReferenceDocument(structuredClone(genesis));
    try {
      const pa = publication(a),
        pb = publication(b);
      expect(pa.value.view.root.children.map((n) => n.content)).toEqual(
        Array.from({ length: size }, (_, i) => `paragraph ${i}`),
      );
      expect(pa.value.view).toEqual(pb.value.view);
      expect(pa.native.encodeState()).toEqual(pb.native.encodeState());
    } finally {
      a.destroy();
      b.destroy();
    }
  },
  30_000,
);

function encodeGenesisDescriptor(genesis: ReferenceGenesis) {
  return encodeGenesis({
    protocolVersion: 3,
    bootstrapVersion: 1,
    documentId: genesis.documentId,
    genesisId: genesis.genesisId,
    allocations: genesis.layout.allocations,
    births: genesis.layout.births,
    initialProperties: genesis.initialProperties ?? [],
    nativeInsertUpdates: genesis.body.nativeInsertUpdates,
    nativeManifest: genesis.body.nativeManifest,
  });
}
