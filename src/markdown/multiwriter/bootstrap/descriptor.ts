import { compareBytes, decodeCborSteps, encodeCbor } from '../actions/cbor.js';
import { genesisFromWire, genesisToWire } from '../actions/schema.js';
import type { Allocation, NativeResourceBirth } from '../contracts.js';
import {
  DEFAULT_INGEST_LIMITS,
  IngestCapacityError,
  assertLimit,
  finish,
  guardDecode,
} from '../ingest/work.js';
import { nativeView } from '../ingest/publication.js';
import type { BirthPlacement } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { deriveHomes } from '../ownership/index.js';
import { projectMarkdown } from '../projection/index.js';
import { reconstructProvenance } from '../reference/provenance.js';
import type { ReferenceGenesis } from '../reference/document.js';
import { NativeTapeCache } from '../text/cache.js';
import { constructGenesis } from './construct.js';

export interface GenesisDescriptor {
  readonly protocolVersion: 3;
  readonly bootstrapVersion: 1;
  readonly documentId: string;
  readonly genesisId: string;
  readonly allocations: readonly Allocation[];
  readonly births: readonly BirthPlacement[];
  readonly initialProperties: NonNullable<ReferenceGenesis['initialProperties']>;
  readonly nativeInsertUpdates: readonly Uint8Array[];
  readonly nativeManifest: readonly NativeResourceBirth[];
}
export interface BootstrapLimits {
  readonly bytes: number;
  readonly depth: number;
  readonly operations: number;
  readonly nativeOperations: number;
}
export class BootstrapCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapCompatibilityError';
  }
}
export class GenesisValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenesisValidationError';
  }
}
export function bootstrapLimits(input: Partial<BootstrapLimits> = {}): BootstrapLimits {
  const limits = {
    bytes: DEFAULT_INGEST_LIMITS.messageBytes,
    depth: DEFAULT_INGEST_LIMITS.depth,
    operations: DEFAULT_INGEST_LIMITS.decodeOperations,
    nativeOperations: DEFAULT_INGEST_LIMITS.decodeOperations,
    ...input,
  };
  for (const value of Object.values(limits)) assertLimit(value);
  return limits;
}
export function checkBytes(bytes: Uint8Array, limits: BootstrapLimits): void {
  if (bytes.byteLength > limits.bytes)
    throw new IngestCapacityError('envelope', 'bytes', bytes.byteLength);
}
export function readWire(bytes: Uint8Array, limits: BootstrapLimits) {
  checkBytes(bytes, limits);
  return finish(guardDecode(decodeCborSteps(bytes, limits.depth), limits.operations, 'envelope'));
}
/** Parse once at creation. Persist and distribute these exact bytes; never reparse to join. */
export function createGenesis(
  documentId: string,
  markdown: string,
  input?: Partial<BootstrapLimits>,
): Uint8Array {
  const limits = bootstrapLimits(input);
  const genesis = constructGenesis(documentId, markdown, limits.nativeOperations);
  return encodeGenesis(
    {
      protocolVersion: 3,
      bootstrapVersion: 1,
      documentId: genesis.documentId,
      genesisId: genesis.genesisId,
      allocations: genesis.layout.allocations,
      births: genesis.layout.births,
      initialProperties: genesis.initialProperties ?? [],
      nativeInsertUpdates: genesis.body.nativeInsertUpdates,
      nativeManifest: genesis.body.nativeManifest,
    },
    limits,
  );
}
/** Encoding also checks the complete descriptor, including native/projection invariants. */
export function encodeGenesis(
  input: GenesisDescriptor,
  limits?: Partial<BootstrapLimits>,
): Uint8Array {
  const bytes = encodeCbor(genesisToWire(input));
  decodeGenesis(bytes, limits);
  return bytes;
}
export function decodeGenesis(
  bytes: Uint8Array,
  input?: Partial<BootstrapLimits>,
): GenesisDescriptor {
  const limits = bootstrapLimits(input);
  const wire = readWire(bytes, limits);
  if (wire && typeof wire === 'object' && !Array.isArray(wire) && !(wire instanceof Uint8Array)) {
    const fields = wire as Record<string, unknown>;
    if (fields.protocolVersion !== 3n || fields.bootstrapVersion !== 1n)
      throw new BootstrapCompatibilityError('Unsupported genesis protocol/bootstrap version');
  }
  const descriptor = genesisFromWire(wire) as GenesisDescriptor;
  validateGenesis(descriptor, limits);
  return descriptor;
}
export function referenceGenesis(value: GenesisDescriptor): ReferenceGenesis {
  return structuredClone({
    documentId: value.documentId,
    genesisId: value.genesisId,
    layout: { allocations: value.allocations, births: value.births },
    body: {
      allocations: value.allocations,
      nativeInsertUpdates: value.nativeInsertUpdates,
      nativeManifest: value.nativeManifest,
    },
    initialProperties: value.initialProperties,
  });
}
export function requireSameGenesis(expected: Uint8Array | undefined, supplied: Uint8Array): void {
  if (!expected) throw new BootstrapCompatibilityError('Durable genesis metadata is missing');
  if (compareBytes(expected, supplied) !== 0)
    throw new BootstrapCompatibilityError('Genesis descriptor differs from the installed document');
}
function invalid(message: string): never {
  throw new GenesisValidationError(message);
}
function validateGenesis(value: GenesisDescriptor, limits: BootstrapLimits): void {
  if (!value.documentId || !value.genesisId) invalid('Document and genesis IDs must be nonempty');
  const ids = new Set<number>();
  const registry = new Map(value.allocations.map((a) => [resourceKey(a.id), a]));
  for (const allocation of value.allocations) {
    if (['deletion', 'interpretation'].includes(allocation.type))
      invalid('Unsupported genesis allocation');
    const id = allocation.id;
    if (
      id.birth.type !== 'genesis' ||
      id.birth.genesisId !== value.genesisId ||
      ids.has(id.ordinal)
    )
      invalid('Genesis resource ordinals must be unique and belong to this genesis');
    ids.add(id.ordinal);
  }
  // Every nested resource reference must resolve, including manifest and property origins.
  const pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== 'object' || next instanceof Uint8Array) continue;
    if ('kind' in next) {
      const id = next as Allocation['id'];
      if (!registry.has(resourceKey(id))) invalid('Unresolved genesis resource');
    } else pending.push(...Object.values(next));
  }
  const genesis = referenceGenesis(value);
  const occurrences = value.allocations.filter((a) => a.type === 'occurrence');
  if (
    occurrences.length !== value.births.length ||
    new Set(value.births.map((b) => resourceKey(b.occurrence))).size !== value.births.length
  )
    invalid('Genesis occurrences must bind exactly one birth');
  const homes = deriveHomes(genesis.layout);
  for (const allocation of value.allocations)
    if (allocation.type === 'run' && allocation.skeleton.length !== 1)
      invalid('Genesis roots require only their private home tape');
  for (const entry of value.initialProperties) {
    const node = registry.get(resourceKey(entry.node));
    if (node?.type !== 'node') invalid('Properties require a retained node');
    if (entry.values.presentation !== undefined && node.role !== 'inline')
      invalid('Only inline nodes have presentation');
    if (entry.values.checked != null && node.role !== 'list-item')
      invalid('Only list items have checked state');
    if (entry.values.info != null && entry.values.presentation !== 'code')
      invalid('Only code has info');
  }
  if (
    homes.length !==
    value.allocations.filter((a) => a.type === 'node' && a.role === 'inline').length
  )
    invalid('Each inline needs a private home');
  const native = new NativeTapeCache(limits.nativeOperations);
  try {
    native.apply('genesis', genesis.body);
    // Native validation, full layout reachability, birth coverage, reserved homes and origins.
    projectMarkdown({
      genesis: genesis.layout,
      genesisManifest: value.nativeManifest,
      initialProperties: value.initialProperties,
      ...reconstructProvenance(genesis.layout, []),
      native: nativeView(native),
    });
  } finally {
    native.destroy();
  }
}
