import { describe, expect, it } from 'vitest';
import {
  actorId,
  assertCounter,
  compareActions,
  compareEffects,
  DEFAULT_HISTORY_LIMIT,
  ENVELOPE_ENCODING,
  MAX_COUNTER,
  PROTOCOL_VERSION,
  RETENTION_POLICY,
  STORAGE_CONTRACT,
  SYNC_DIRECTIONS,
  YJS_VERSION,
} from './contracts.js';
import type {
  ActionEnvelope,
  ActionReadiness,
  Allocation,
  CellAssignment,
  CheckpointManifest,
  FlowPlacement,
  NativeResourceBirth,
  ProjectionAddress,
  PublicationStatus,
  ResourceId,
  ResourceKind,
  RunLayout,
  SemanticEffect,
  SessionId,
} from './contracts.js';

const A = actorId('00000000000000000000000000000001');
const B = actorId('00000000000000000000000000000002');
const id = { actor: A, sequence: 1n };
const session: SessionId = { actor: A, local: 'editor' };
function resource<K extends ResourceKind>(kind: K, ordinal: number): ResourceId<K> {
  return { kind, birth: { type: 'action', action: id }, ordinal };
}
const node = resource('node', 0);
const flow = resource('flow', 1);
const tape = resource('tape', 2);
const start = resource('marker', 3);
const end = resource('marker', 4);
const run = resource('run', 5);
const occurrence = resource('occurrence', 6);
const tag = resource('deletion', 7);
const packet = resource('interpretation', 8);
const range = { tape, start, end };
const blockSlot = { parent: node, predecessor: null };
const inlineSlot = { run, boundary: start, side: 'right', predecessor: null } as const;
const native = { client: 7, clock: 10, length: 2 };
const nativeText = { ...native, tape };
const group = { session, sequence: 1n };
const properties = { presentation: 'paragraph', marker: null, info: null } as const;

/** Compile-time examples exercise each shared discriminant without a schema-2 import. */
const allocations: readonly Allocation[] = [
  { type: 'node', id: node, role: 'inline', flow, birthSlot: blockSlot },
  { type: 'flow', id: flow, home: node },
  { type: 'tape', id: tape, start, end },
  { type: 'marker', id: start, tape, native, affinity: 'right' },
  { type: 'run', id: run, flow, skeleton: [range] },
  { type: 'occurrence', id: occurrence, slot: inlineSlot },
  { type: 'deletion', id: tag },
  { type: 'interpretation', id: packet },
];
const effects: readonly SemanticEffect[] = [
  { type: 'InsertText', ranges: [nativeText] },
  { type: 'MoveBlock', node, occurrence, slot: blockSlot, standaloneFlow: flow },
  { type: 'JoinFlow', source: flow, destination: inlineSlot, occurrence, liftedChildren: [] },
  {
    type: 'SplitFlow',
    basis: { ranges: [{ range, occurrence }] },
    cut: inlineSlot,
    retainedSide: 'right',
    newNode: node,
    newFlow: flow,
    newRun: run,
    occurrence,
    outerSlot: blockSlot,
  },
  { type: 'TransferRange', ranges: [range], destination: inlineSlot, run, occurrence },
  { type: 'DeleteText', tag, observed: [nativeText] },
  {
    type: 'DeleteSubtree',
    tag,
    scope: {
      target: node,
      observedNodes: [node],
      ownedIntervals: [range],
      joinedFlows: [flow],
      heads: [id],
    },
  },
  {
    type: 'Interpret',
    packet: {
      id: packet,
      source: node,
      properties,
      wrappers: [],
      placements: [],
      syntaxMask: [nativeText],
      synthesizedText: [],
    },
  },
  { type: 'SetProperties', node, values: { checked: true } },
  { type: 'LiftChildren', placements: [{ node, occurrence, slot: blockSlot }] },
  { type: 'SetGroupActive', group, actions: [id], active: false, previousControl: null },
];
const nativeManifest: readonly NativeResourceBirth[] = [
  { type: 'text', tape, native, text: '😀' },
  { type: 'marker', tape, native: { client: 7, clock: 12 }, marker: end },
];
const envelope: ActionEnvelope = {
  protocolVersion: 3,
  documentId: 'document',
  genesisId: 'G',
  id,
  lamport: 1n,
  dependencies: [],
  groupId: group,
  allocations,
  nativeInsertUpdates: [],
  nativeManifest,
  effects,
};

it('freezes schema, codec, Yjs and canonical storage policy independently of the old authority', () => {
  expect(PROTOCOL_VERSION).toBe(3);
  expect(YJS_VERSION).toBe('13.6.33');
  expect(ENVELOPE_ENCODING).toEqual({
    format: 'deterministic-cbor',
    definiteLengths: true,
    duplicateMapKeys: false,
    floatingPoint: false,
    optionalTags: false,
    counterBits: 64,
  });
  expect(STORAGE_CONTRACT).toEqual({
    canonical: 'actionDoc',
    envelopes: 'append-only-array',
    semanticArrayOrder: false,
    synchronizedNativeCache: false,
    nativeDeletion: false,
    nativeFormatting: false,
    nativeUndoManager: false,
  });
  expect(Object.keys(envelope).sort()).toEqual(
    [
      'protocolVersion',
      'documentId',
      'genesisId',
      'id',
      'lamport',
      'dependencies',
      'groupId',
      'allocations',
      'nativeInsertUpdates',
      'nativeManifest',
      'effects',
    ].sort(),
  );
  expect(new Set(allocations.map((value) => value.type)).size).toBe(8);
  expect(new Set(effects.map((value) => value.type)).size).toBe(11);
});

it('keeps resource domains and structural ranges distinct from exact observed text deletion', () => {
  // @ts-expect-error A node is not a flow, even when it has the same allocation ordinal.
  const wrongFlow: ResourceId<'flow'> = node;
  expect(wrongFlow.kind).toBe('node');
  // @ts-expect-error Structural intervals are not observed native character sets.
  const wrongDelete: NativeResourceBirth = { type: 'text', tape, native: range, text: 'x' };
  expect(wrongDelete.type).toBe('text');
  // @ts-expect-error Version 2 is not a live schema-3 envelope.
  const wrongVersion: ActionEnvelope = { ...envelope, protocolVersion: 2 };
  expect(wrongVersion.protocolVersion).toBe(2);
  const cell: CellAssignment = { cell: range, occurrence, run };
  const layout: RunLayout = { run, flow, skeleton: [range] };
  const placements: readonly FlowPlacement[] = [
    { flow, parent: { type: 'block', node } },
    { flow, parent: { type: 'flow', slot: inlineSlot, occurrence } },
  ];
  const addresses: readonly ProjectionAddress[] = [
    { type: 'node', representative: node, constituents: [node] },
    { type: 'edge', child: node, slot: blockSlot },
    { type: 'text', slot: inlineSlot, origin: range },
    { type: 'empty-root', slot: blockSlot },
  ];
  expect(cell.run).toBe(layout.run);
  expect(placements.map((value) => value.parent.type)).toEqual(['block', 'flow']);
  expect(addresses.map((value) => value.type)).toEqual(['node', 'edge', 'text', 'empty-root']);
});

describe('exact semantic ordering', () => {
  it.each([0n, 1n, 9007199254740993n, MAX_COUNTER])('retains uint64 value %s', (value) => {
    expect(() => assertCounter(value)).not.toThrow();
  });
  it.each([1, 1.5, '1', null, undefined])('rejects a non-bigint counter %j', (value) => {
    expect(() => assertCounter(value as unknown as bigint)).toThrow('unsigned 64-bit');
  });
  it.each([-1n, MAX_COUNTER + 1n])('rejects counter overflow %s', (value) => {
    expect(() => assertCounter(value)).toThrow('unsigned 64-bit');
  });
  it.each(['', 'A'.repeat(32), '0'.repeat(31), 'g'.repeat(32)])(
    'rejects noncanonical actor %j',
    (value) => {
      expect(() => actorId(value)).toThrow('128 bits');
    },
  );
  it('compares Lamport, actor bytes, sequence and effect ordinal without number conversion', () => {
    const first = { lamport: 9007199254740992n, id: { actor: B, sequence: MAX_COUNTER } };
    const next = { lamport: 9007199254740993n, id: { actor: A, sequence: 1n } };
    expect(compareActions(first, next)).toBe(-1);
    expect(
      compareActions(
        { ...next, id: { actor: A, sequence: MAX_COUNTER } },
        { ...next, id: { actor: B, sequence: 0n } },
      ),
    ).toBe(-1);
    expect(
      compareActions(
        { ...next, id: { actor: A, sequence: MAX_COUNTER - 1n } },
        { ...next, id: { actor: A, sequence: MAX_COUNTER } },
      ),
    ).toBe(-1);
    expect(compareActions(next, next)).toBe(0);
    expect(compareEffects({ action: next, ordinal: 0 }, { action: next, ordinal: 1 })).toBeLessThan(
      0,
    );
    expect(
      compareEffects({ action: next, ordinal: 0 }, { action: first, ordinal: 99 }),
    ).toBeGreaterThan(0);
  });
});

it('separates transport directions from permission to edit and from publication durability', () => {
  expect(SYNC_DIRECTIONS).toEqual({
    bidirectional: { send: true, receive: true },
    'outbound-only': { send: true, receive: false },
    'inbound-only': { send: false, receive: true },
    disconnected: { send: false, receive: false },
  });
  const status: PublicationStatus = { applied: true, persisted: false };
  expect(status.delivered).toBeUndefined();
  const readiness: readonly ActionReadiness[] = [
    { state: 'ready' },
    { state: 'pending', missing: [id] },
    { state: 'quarantined', reason: 'fork' },
  ];
  expect(readiness.map((value) => value.state)).toEqual(['ready', 'pending', 'quarantined']);
});

it('freezes no-expiration retention and separates checkpoint coverage from the local 500-group horizon', () => {
  const checkpoint: CheckpointManifest = {
    protocolVersion: 3,
    documentId: 'document',
    genesisId: 'G',
    coveredActions: [id],
    heads: [id],
  };
  expect(checkpoint.genesisId).toBe(envelope.genesisId);
  expect(DEFAULT_HISTORY_LIMIT).toBe(500);
  expect(RETENTION_POLICY).toEqual({
    expireOfflineReplicas: false,
    pruneCanonicalFacts: false,
    rewriteGenesisOnCheckpoint: false,
    nativeCacheGc: false,
    localHistoryLimit: 500,
    evictDerivedCaches: true,
    consolidatePersistenceLosslessly: true,
  });
});
