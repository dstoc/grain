import { expect, test } from 'vitest';
import { encodeCbor, decodeCbor, compareBytes } from '../actions/cbor.js';
import type { CborValue } from '../actions/cbor.js';
import { genesisToWire } from '../actions/schema.js';
import { NativeTapeCache } from '../text/cache.js';
import {
  createGenesis,
  decodeGenesis,
  encodeGenesis,
  BootstrapCompatibilityError,
} from './index.js';
import type { GenesisDescriptor } from './index.js';
import { IngestCapacityError } from '../ingest/work.js';

const bytes = createGenesis('document', 'a😀b');
const baseline = decodeGenesis(bytes);
function change(edit: (d: GenesisDescriptor) => void) {
  const descriptor = structuredClone(baseline);
  edit(descriptor);
  return encodeCbor(genesisToWire(descriptor));
}
test('binary descriptor round trip is exact, detached and has a single allocation list', () => {
  const supplied = bytes.slice();
  const a = decodeGenesis(supplied);
  expect(encodeGenesis(a)).toEqual(bytes);
  supplied.fill(0);
  a.nativeInsertUpdates[0].fill(0);
  expect(decodeGenesis(bytes)).toEqual(baseline);
  const wire = decodeCbor(bytes) as Record<string, CborValue>;
  expect(Object.keys(wire).sort()).toEqual([
    'allocations',
    'births',
    'bootstrapVersion',
    'documentId',
    'genesisId',
    'initialProperties',
    'nativeInsertUpdates',
    'nativeManifest',
    'protocolVersion',
  ]);
  expect(wire.protocolVersion).toBe(3n);
  expect(wire.bootstrapVersion).toBe(1n);
});
test('identical Markdown imports have independent lineages', () => {
  const imported = createGenesis('document', 'a😀b');
  expect(decodeGenesis(imported).genesisId).not.toBe(baseline.genesisId);
  expect(compareBytes(bytes, imported)).not.toBe(0);
});
for (const key of ['protocolVersion', 'bootstrapVersion'])
  test(`unsupported ${key} is a compatibility error`, () => {
    const wire = decodeCbor(bytes) as Record<string, CborValue>;
    expect(() => decodeGenesis(encodeCbor({ ...wire, [key]: 2n }))).toThrow(
      BootstrapCompatibilityError,
    );
  });
test.each(['\ud800', '\udfff'])('creation rejects invalid Unicode %j', (text) => {
  expect(() => createGenesis('document', text)).toThrow('Unicode');
  expect(() => createGenesis(text, '')).toThrow('Unicode');
});
test('invalid document ID fails creation', () => {
  expect(() => createGenesis('', '')).toThrow();
});
const corruptions: [string, (value: GenesisDescriptor) => void][] = [
  [
    'duplicate ordinal',
    (d) => (d.allocations as unknown[]).push(structuredClone(d.allocations[0])),
  ],
  ['missing root', (d) => (d.allocations as unknown[]).splice(0, 1)],
  ['missing birth', (d) => (d.births as unknown[]).pop()],
  ['duplicate binding', (d) => (d.births as unknown[]).push(d.births[0])],
  [
    'wrong lineage reference',
    (d) => Object.assign(d.births[0].node, { birth: { type: 'genesis', genesisId: 'foreign' } }),
  ],
  [
    'missing home',
    (d) =>
      (d.allocations as unknown[]).splice(
        d.allocations.findIndex((a) => a.type === 'run'),
        1,
      ),
  ],
  ['illegal role', (d) => Object.assign(d.allocations[1], { role: 'root' })],
  ['missing native body', (d) => (d.nativeInsertUpdates as unknown[]).splice(0)],
  ['corrupt native body', (d) => d.nativeInsertUpdates[0].fill(0)],
  ['missing manifest', (d) => (d.nativeManifest as unknown[]).splice(0)],
  [
    'wrong manifest text',
    (d) => {
      const text = d.nativeManifest.find((m) => m.type === 'text')!;
      Object.assign(text, { text: 'xxxxx' });
    },
  ],
  ['unknown properties', (d) => Object.assign(d.initialProperties[0].values, { unexpected: true })],
  [
    'non-inline presentation',
    (d) =>
      (d.initialProperties as unknown[]).push({
        node: d.allocations[0].id,
        values: { presentation: 'paragraph' },
      }),
  ],
  ['invalid checked state', (d) => Object.assign(d.initialProperties[0].values, { checked: true })],
  ['invalid code info', (d) => Object.assign(d.initialProperties[0].values, { info: 'ts' })],
  [
    'cycle',
    (d) => {
      const node = d.allocations.find((a) => a.type === 'node' && a.role === 'inline')!;
      if (node.type === 'node') {
        const slot = { parent: node.id, predecessor: null };
        Object.assign(node, { birthSlot: slot });
        const occurrence = d.allocations.find((a) => a.type === 'occurrence')!;
        Object.assign(occurrence, { slot });
      }
    },
  ],
];
test.each(corruptions)('descriptor rejects %s without changing valid input', (_, edit) => {
  expect(() => decodeGenesis(change(edit))).toThrow();
  expect(encodeGenesis(baseline)).toEqual(bytes);
});
test('nonempty sentinel-only tape fails the private-home invariant', () => {
  const d = structuredClone(baseline);
  const tape = d.allocations.find((a) => a.type === 'tape')!;
  if (tape.type !== 'tape') throw new Error('missing tape');
  const cache = new NativeTapeCache();
  try {
    const p = cache.prepare('bad', [
      { type: 'createTape', tape: tape.id, start: tape.start, end: tape.end },
      { type: 'text', tape: tape.id, index: 1, text: 'abc' },
    ]);
    const descriptor = {
      ...d,
      allocations: [
        ...d.allocations.filter((a) => a.type !== 'tape' && a.type !== 'marker'),
        ...p.body.allocations,
      ],
      nativeManifest: p.body.nativeManifest,
      nativeInsertUpdates: p.body.nativeInsertUpdates,
    };
    expect(() => encodeGenesis(descriptor)).toThrow('Reserved home cells must remain text-free');
    p.abort();
  } finally {
    cache.destroy();
  }
});
test('noncanonical, duplicate-key and truncated CBOR fail', () => {
  expect(() => decodeGenesis(Uint8Array.of(0xa2, 0x61, 0x61, 0, 0x61, 0x61, 0))).toThrow(
    'Duplicate',
  );
  expect(() => decodeGenesis(Uint8Array.of(0x18, 0x01))).toThrow('Nonpreferred');
  for (const length of [0, 1, 10, bytes.length - 1])
    expect(() => decodeGenesis(bytes.slice(0, length))).toThrow();
});
for (const limit of ['bytes', 'depth', 'operations', 'nativeOperations'] as const)
  test(`${limit} exhaustion is retryable on the same bytes`, () => {
    expect(() => decodeGenesis(bytes, { [limit]: 0 })).toThrow(IngestCapacityError);
    expect(encodeGenesis(decodeGenesis(bytes))).toEqual(bytes);
  });
