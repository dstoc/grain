import { actorId } from '../contracts.js';
import type { ActionEnvelope, ActionId, ActorId, ResourceId, ResourceKind } from '../contracts.js';

export const A = actorId('00000000000000000000000000000001');
export const B = actorId('00000000000000000000000000000002');
export const C = actorId('00000000000000000000000000000003');
export function action(
  actor: ActorId = A,
  sequence = 1n,
  dependencies: readonly ActionEnvelope[] = [],
): ActionEnvelope {
  return {
    protocolVersion: 3,
    documentId: 'D',
    genesisId: 'G',
    id: { actor, sequence },
    lamport: dependencies.reduce((n, dep) => (dep.lamport > n ? dep.lamport : n), 0n) + 1n,
    dependencies: dependencies.map((dep) => dep.id),
    groupId: { session: { actor, local: 'editor' }, sequence: 1n },
    allocations: [],
    nativeInsertUpdates: [],
    nativeManifest: [],
    effects: [],
  };
}
export function resource<K extends ResourceKind>(
  kind: K,
  ordinal: number,
  id?: ActionId,
): ResourceId<K> {
  return {
    kind,
    ordinal,
    birth: id ? { type: 'action', action: id } : { type: 'genesis', genesisId: 'G' },
  };
}

/** Exercise every discriminant and optional property in the MW-00 logical contract. */
export function fullEnvelope(): ActionEnvelope {
  const envelope = action();
  const node = resource('node', 0, envelope.id);
  const flow = resource('flow', 1, envelope.id);
  const tape = resource('tape', 2, envelope.id);
  const start = resource('marker', 3, envelope.id);
  const end = resource('marker', 4, envelope.id);
  const run = resource('run', 5, envelope.id);
  const occurrence = resource('occurrence', 6, envelope.id);
  const tag = resource('deletion', 7, envelope.id);
  const interpretation = resource('interpretation', 8, envelope.id);
  const range = { tape, start, end };
  const block = { parent: node, predecessor: null };
  const inline = { run, boundary: start, side: 'left' as const, predecessor: occurrence };
  const native = { client: 7, clock: 0, length: 2 };
  const text = { ...native, tape };
  return {
    ...envelope,
    allocations: [
      { type: 'node', id: node, role: 'inline', flow, birthSlot: block },
      { type: 'flow', id: flow, home: node },
      { type: 'tape', id: tape, start, end },
      { type: 'marker', id: start, tape, native: { client: 7, clock: 2 }, affinity: 'right' },
      { type: 'run', id: run, flow, skeleton: [range] },
      { type: 'occurrence', id: occurrence, slot: inline },
      { type: 'occurrence', id: resource('occurrence', 9, envelope.id), slot: block },
      { type: 'deletion', id: tag },
      { type: 'interpretation', id: interpretation },
    ],
    nativeInsertUpdates: [new Uint8Array([0, 128, 255])],
    nativeManifest: [
      { type: 'text', tape, native, text: '😀' },
      { type: 'marker', tape, native: { client: 7, clock: 2 }, marker: start },
    ],
    effects: [
      { type: 'InsertText', ranges: [text] },
      { type: 'MoveBlock', node, occurrence, slot: block, standaloneFlow: flow },
      { type: 'JoinFlow', source: flow, destination: inline, occurrence, liftedChildren: [node] },
      {
        type: 'SplitFlow',
        basis: { ranges: [{ range, occurrence }] },
        cut: inline,
        retainedSide: 'right',
        newNode: node,
        newFlow: flow,
        newRun: run,
        occurrence,
        outerSlot: block,
      },
      { type: 'TransferRange', ranges: [range], destination: inline, run, occurrence },
      { type: 'DeleteText', tag, observed: [text] },
      {
        type: 'DeleteSubtree',
        tag,
        scope: {
          target: node,
          observedNodes: [node],
          ownedIntervals: [range],
          joinedFlows: [flow],
          heads: [action(B).id],
        },
      },
      {
        type: 'Interpret',
        packet: {
          id: interpretation,
          source: node,
          properties: { presentation: 'paragraph', marker: null, info: '' },
          wrappers: [node],
          placements: [{ node, occurrence, slot: block }],
          syntaxMask: [text],
          synthesizedText: [text],
        },
      },
      {
        type: 'SetProperties',
        node,
        values: { presentation: 'section', marker: '#', info: null, checked: false },
      },
      { type: 'SetProperties', node, values: {} },
      { type: 'LiftChildren', placements: [{ node, occurrence, slot: block }] },
      {
        type: 'SetGroupActive',
        group: envelope.groupId,
        actions: [action(B).id],
        active: false,
        previousControl: action(C).id,
      },
    ],
  };
}
