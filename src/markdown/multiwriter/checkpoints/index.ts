import { compareBytes, decodeCbor, encodeCbor } from '../actions/cbor.js';
import type { CborValue } from '../actions/cbor.js';
import { actionIdSchema } from '../actions/schema.js';
import type { ActionStore } from '../actions/store.js';
import { PROTOCOL_VERSION } from '../contracts.js';
import type { ActionId, CheckpointManifest } from '../contracts.js';

export const CHECKPOINT_FORMAT_VERSION = 1;
export interface ActionCheckpoint {
  readonly formatVersion: typeof CHECKPOINT_FORMAT_VERSION;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentId: string;
  readonly genesisId: string;
  readonly update: Uint8Array;
  readonly manifest: CheckpointManifest;
  readonly digest: Uint8Array;
}

function record(value: CborValue, keys: readonly string[]): Record<string, CborValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array)
    throw new Error('Invalid checkpoint record');
  const fields = value as Record<string, CborValue>;
  if (Object.keys(fields).length !== keys.length || keys.some((key) => !Object.hasOwn(fields, key)))
    throw new Error('Invalid checkpoint fields');
  return fields;
}
function identity(fields: Record<string, CborValue>) {
  if (
    fields.protocolVersion !== BigInt(PROTOCOL_VERSION) ||
    typeof fields.documentId !== 'string' ||
    typeof fields.genesisId !== 'string'
  )
    throw new Error('Invalid checkpoint identity');
  return {
    protocolVersion: PROTOCOL_VERSION,
    documentId: fields.documentId,
    genesisId: fields.genesisId,
  };
}
function ids(value: CborValue): readonly ActionId[] {
  if (!Array.isArray(value)) throw new Error('Invalid checkpoint action IDs');
  return value.map((id) => actionIdSchema(id, 'decode') as ActionId);
}
function manifestWire(manifest: CheckpointManifest): CborValue {
  return {
    ...manifest,
    protocolVersion: BigInt(manifest.protocolVersion),
    coveredActions: manifest.coveredActions.map((id) => actionIdSchema(id, 'encode') as CborValue),
    heads: manifest.heads.map((id) => actionIdSchema(id, 'encode') as CborValue),
  };
}
function manifest(store: ActionStore): CheckpointManifest {
  const snapshot = store.snapshot();
  if (!snapshot.integrity) throw new Error('Cannot checkpoint an integrity-failed action store');
  return {
    ...store.identity,
    coveredActions: snapshot.ready.map((action) => action.id),
    heads: snapshot.heads,
  };
}
async function digest(update: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', update.slice()));
}

/** Detach before reserving a persistence barrier. Encoding can be retried without recapturing. */
export function prepareCheckpoint(store: ActionStore): () => Promise<Uint8Array> {
  const update = store.encodeUpdate();
  const captured = manifest(store);
  return async () =>
    encodeCbor({
      formatVersion: BigInt(CHECKPOINT_FORMAT_VERSION),
      protocolVersion: BigInt(PROTOCOL_VERSION),
      documentId: captured.documentId,
      genesisId: captured.genesisId,
      update,
      manifest: manifestWire(captured),
      digest: await digest(update),
    });
}

/** Capture native bytes and ready closure before the first await; later edits belong to the tail. */
export async function captureCheckpoint(store: ActionStore): Promise<Uint8Array> {
  return prepareCheckpoint(store)();
}

/** Strict container decode only. Use restoreCheckpoint to validate native state and ready coverage. */
export function decodeCheckpoint(bytes: Uint8Array): ActionCheckpoint {
  const fields = record(decodeCbor(bytes), [
    'formatVersion',
    'protocolVersion',
    'documentId',
    'genesisId',
    'update',
    'manifest',
    'digest',
  ]);
  if (fields.formatVersion !== BigInt(CHECKPOINT_FORMAT_VERSION))
    throw new Error('Unsupported checkpoint format');
  const binding = identity(fields);
  const closure = record(fields.manifest, [
    'protocolVersion',
    'documentId',
    'genesisId',
    'coveredActions',
    'heads',
  ]);
  const closureBinding = identity(closure);
  if (
    binding.documentId !== closureBinding.documentId ||
    binding.genesisId !== closureBinding.genesisId
  )
    throw new Error('Checkpoint manifest identity mismatch');
  if (
    !(fields.update instanceof Uint8Array) ||
    !(fields.digest instanceof Uint8Array) ||
    fields.digest.length !== 32
  )
    throw new Error('Invalid checkpoint binary fields');
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    ...binding,
    update: fields.update,
    digest: fields.digest,
    manifest: {
      ...closureBinding,
      coveredActions: ids(closure.coveredActions),
      heads: ids(closure.heads),
    },
  };
}

/** Caller owns the returned fresh store. A failed candidate is destroyed, never exposed. */
export async function restoreCheckpoint(
  bytes: Uint8Array,
  template: ActionStore,
): Promise<ActionStore> {
  // Decode copies all binary fields synchronously, before hashing yields to the caller.
  const checkpoint = decodeCheckpoint(bytes);
  const expected = template.identity;
  if (checkpoint.documentId !== expected.documentId || checkpoint.genesisId !== expected.genesisId)
    throw new Error('Checkpoint document/genesis mismatch');
  if (compareBytes(checkpoint.digest, await digest(checkpoint.update)))
    throw new Error('Checkpoint digest mismatch');
  const candidate = template.emptyClone();
  try {
    candidate.applyUpdate(checkpoint.update);
    if (
      compareBytes(
        encodeCbor(manifestWire(manifest(candidate))),
        encodeCbor(manifestWire(checkpoint.manifest)),
      )
    )
      throw new Error('Checkpoint ready manifest mismatch');
    if (compareBytes(candidate.encodeUpdate(), checkpoint.update))
      throw new Error('Checkpoint native state mismatch');
    return candidate;
  } catch (error) {
    candidate.destroy();
    throw error;
  }
}

/** Serialized storage sizes; these overlap canonical sizes and are not heap estimates. */
export function journalBytes(state: {
  readonly checkpoint?: Uint8Array;
  readonly updates: readonly Uint8Array[];
}) {
  const checkpointBytes = state.checkpoint?.byteLength ?? 0;
  const tailUpdateBytes = state.updates.reduce((n, update) => n + update.byteLength, 0);
  return {
    checkpointBytes,
    tailUpdateBytes,
    batchCount: state.updates.length,
    totalBytes: checkpointBytes + tailUpdateBytes,
  };
}
