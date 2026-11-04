import { actorId } from '../contracts.js';
import { isWellFormed } from './cbor.js';
import type { CborValue } from './cbor.js';

export class EnvelopeSchemaError extends Error {}

type Direction = 'encode' | 'decode';
type Schema = (value: unknown, direction: Direction) => unknown;
function fail(): never {
  throw new EnvelopeSchemaError('Invalid schema-3 envelope field');
}
const string: Schema = (v) => (typeof v === 'string' && isWellFormed(v) ? v : fail());
const bool: Schema = (v) => (typeof v === 'boolean' ? v : fail());
const counter: Schema = (v) => {
  if (typeof v !== 'bigint') fail();
  if (v < 0n || v > (1n << 64n) - 1n) fail();
  return v;
};
const integer: Schema = (v, direction) => {
  if (direction === 'decode') {
    if (typeof v !== 'bigint' || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return Number(v);
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || Object.is(v, -0)) fail();
  return BigInt(v);
};
const bytes: Schema = (v) => (v instanceof Uint8Array ? v.slice() : fail());
const actor: Schema = (v, direction) => {
  if (direction === 'encode') {
    if (typeof v !== 'string') fail();
    actorId(v);
    return Uint8Array.from(v.match(/../g)!, (pair) => parseInt(pair, 16));
  }
  if (!(v instanceof Uint8Array) || v.length !== 16) fail();
  return actorId(Array.from(v, (byte) => byte.toString(16).padStart(2, '0')).join(''));
};
const nullable =
  (schema: Schema): Schema =>
  (v, d) =>
    v === null ? null : schema(v, d);
const array =
  (schema: Schema): Schema =>
  (v, d) =>
    Array.isArray(v) ? v.map((item) => schema(item, d)) : fail();
const enumeration =
  (...values: string[]): Schema =>
  (v) =>
    typeof v === 'string' && values.includes(v) ? v : fail();
function record(fields: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema {
  return (v, d) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Uint8Array) fail();
    const value = v as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => !Object.hasOwn(fields, key) && !Object.hasOwn(optional, key))
    )
      fail();
    const out: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(fields)) {
      if (!Object.hasOwn(value, key)) fail();
      out[key] = schema(value[key], d);
    }
    for (const [key, schema] of Object.entries(optional))
      if (Object.hasOwn(value, key)) out[key] = schema(value[key], d);
    return out;
  };
}
function union(discriminant: string, variants: Record<string, Schema>): Schema {
  return (v, d) => {
    if (!v || typeof v !== 'object') fail();
    const tag = (v as Record<string, unknown>)[discriminant];
    if (typeof tag !== 'string' || !Object.hasOwn(variants, tag)) fail();
    return variants[tag](v, d);
  };
}
function tagged(type: string, fields: Record<string, Schema>): Schema {
  return record({ type: enumeration(type), ...fields });
}
export const actionIdSchema = record({ actor, sequence: counter });
const session = record({ actor, local: string });
const group = record({ session, sequence: counter });
const birth = union('type', {
  genesis: tagged('genesis', { genesisId: string }),
  action: tagged('action', { action: actionIdSchema }),
});
const resource = (kind: string) => record({ kind: enumeration(kind), birth, ordinal: integer });
const node = resource('node');
const flow = resource('flow');
const tape = resource('tape');
const marker = resource('marker');
const run = resource('run');
const occurrence = resource('occurrence');
const deletion = resource('deletion');
const interpretation = resource('interpretation');
const native = record({ client: integer, clock: integer });
const nativeRange = record({ client: integer, clock: integer, length: integer });
const nativeText = record({ client: integer, clock: integer, length: integer, tape });
const range = record({ tape, start: marker, end: marker });
const blockSlot = record({ parent: node, predecessor: nullable(occurrence) });
const side = enumeration('left', 'right');
const inlineSlot = record({ run, boundary: marker, side, predecessor: nullable(occurrence) });
const slot: Schema = (v, d) =>
  v && typeof v === 'object' && Object.hasOwn(v, 'parent') ? blockSlot(v, d) : inlineSlot(v, d);
const presentation = enumeration('paragraph', 'section', 'code');
const properties = record({ presentation, marker: nullable(string), info: nullable(string) });
const placement = record({ node, occurrence, slot: blockSlot });
const packetFields = record(
  {
    id: interpretation,
    source: node,
    properties,
    wrappers: array(node),
    placements: array(placement),
    syntaxMask: array(nativeText),
    synthesizedText: array(nativeText),
  },
  { derivedInlineOutputs: array(node), effectOrdinals: array(integer) },
);
const packet: Schema = (v, d) => {
  const out = packetFields(v, d) as Record<string, unknown>;
  for (const key of ['derivedInlineOutputs', 'effectOrdinals']) {
    if (!Object.hasOwn(out, key)) continue;
    const values = out[key] as unknown[];
    if (!values.length) {
      if (d === 'decode') fail();
      delete out[key];
      continue;
    }
    const ordinals = values.map((value) =>
      key === 'effectOrdinals'
        ? (value as bigint | number)
        : (value as { ordinal: bigint | number }).ordinal,
    );
    if (ordinals.some((value, i) => i > 0 && value <= ordinals[i - 1])) fail();
  }
  return out;
};
const allocation = union('type', {
  node: tagged('node', {
    id: node,
    role: enumeration('root', 'list', 'list-item', 'quote', 'inline'),
    flow: nullable(flow),
    birthSlot: nullable(blockSlot),
  }),
  flow: tagged('flow', { id: flow, home: node }),
  tape: tagged('tape', { id: tape, start: marker, end: marker }),
  marker: tagged('marker', { id: marker, tape, native, affinity: side }),
  run: tagged('run', { id: run, flow, skeleton: array(range) }),
  occurrence: tagged('occurrence', { id: occurrence, slot }),
  deletion: tagged('deletion', { id: deletion }),
  interpretation: tagged('interpretation', { id: interpretation }),
});
const manifest = union('type', {
  text: tagged('text', { tape, native: nativeRange, text: string }),
  marker: tagged('marker', { tape, native, marker }),
});
const propertyValues = record(
  {},
  { presentation, marker: nullable(string), info: nullable(string), checked: nullable(bool) },
);
const effect = union('type', {
  InsertText: tagged('InsertText', { ranges: array(nativeText) }),
  MoveBlock: tagged('MoveBlock', {
    node,
    occurrence,
    slot: blockSlot,
    standaloneFlow: nullable(flow),
  }),
  JoinFlow: tagged('JoinFlow', {
    source: flow,
    destination: inlineSlot,
    occurrence,
    liftedChildren: array(node),
  }),
  SplitFlow: tagged('SplitFlow', {
    basis: record({ ranges: array(record({ range, occurrence })) }),
    cut: inlineSlot,
    retainedSide: side,
    newNode: node,
    newFlow: flow,
    newRun: run,
    occurrence,
    outerSlot: blockSlot,
  }),
  TransferRange: tagged('TransferRange', {
    ranges: array(range),
    destination: inlineSlot,
    run,
    occurrence,
  }),
  DeleteText: tagged('DeleteText', { tag: deletion, observed: array(nativeText) }),
  DeleteSubtree: tagged('DeleteSubtree', {
    tag: deletion,
    scope: record({
      target: node,
      observedNodes: array(node),
      ownedIntervals: array(range),
      joinedFlows: array(flow),
      heads: array(actionIdSchema),
    }),
  }),
  Interpret: tagged('Interpret', { packet }),
  SetProperties: tagged('SetProperties', {
    node,
    values: propertyValues,
  }),
  LiftChildren: tagged('LiftChildren', { placements: array(placement) }),
  SetGroupActive: tagged('SetGroupActive', {
    group,
    actions: array(actionIdSchema),
    active: bool,
    previousControl: nullable(actionIdSchema),
  }),
});
const envelope = record({
  protocolVersion: integer,
  documentId: string,
  genesisId: string,
  id: actionIdSchema,
  lamport: counter,
  dependencies: array(actionIdSchema),
  groupId: group,
  allocations: array(allocation),
  nativeInsertUpdates: array(bytes),
  nativeManifest: array(manifest),
  effects: array(effect),
});
export function envelopeToWire(value: unknown): CborValue {
  return envelope(value, 'encode') as CborValue;
}
export function envelopeFromWire(value: CborValue): unknown {
  return envelope(value, 'decode');
}

// Genesis shares resource/native field encoding with envelopes, but is never an action.
const genesis = record({
  protocolVersion: integer,
  bootstrapVersion: integer,
  documentId: string,
  genesisId: string,
  allocations: array(allocation),
  births: array(record({ node, occurrence })),
  initialProperties: array(record({ node, values: propertyValues })),
  nativeInsertUpdates: array(bytes),
  nativeManifest: array(manifest),
});
export function genesisToWire(value: unknown): CborValue {
  return genesis(value, 'encode') as CborValue;
}
export function genesisFromWire(value: CborValue): unknown {
  return genesis(value, 'decode');
}
