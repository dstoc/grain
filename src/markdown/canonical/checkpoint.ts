import * as Y from 'yjs';

import {
  META,
  NODES,
  NORMALIZATION_VERSION,
  SCHEMA_VERSION,
  SESSION_WATERMARKS,
  TAPE_REVISIONS,
  schemaMap,
} from './schema.js';
import { validateCanonicalState } from './validation.js';
import type { CanonicalCheckpoint, CanonicalOpenOptions } from './document-types.js';

type RecordMap = Y.Map<unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function metaValue<T>(meta: Y.Map<unknown>, key: string): T {
  return meta.get(key) as T;
}

export function encodeCanonicalCheckpoint(state: Y.Doc): CanonicalCheckpoint {
  const meta = schemaMap<unknown>(state, META);
  return Object.freeze({
    documentId: metaValue<string>(meta, 'documentId'),
    schemaVersion: metaValue<number>(meta, 'schemaVersion'),
    normalizationVersion: metaValue<number>(meta, 'normalizationVersion'),
    authorityEpoch: metaValue<string>(meta, 'authorityEpoch'),
    acceptedRevision: metaValue<number>(meta, 'acceptedRevision'),
    update: Uint8Array.from(Y.encodeStateAsUpdate(state)),
  });
}

export function openCanonicalCheckpoint(
  checkpoint: CanonicalCheckpoint,
  options: CanonicalOpenOptions = {},
): Y.Doc {
  assert(
    checkpoint.schemaVersion === SCHEMA_VERSION,
    `unsupported schema version ${checkpoint.schemaVersion}`,
  );
  const expectedNormalization = options.normalizationVersion ?? NORMALIZATION_VERSION;
  assert(
    expectedNormalization === NORMALIZATION_VERSION,
    `unsupported normalization version ${expectedNormalization}`,
  );
  assert(
    checkpoint.normalizationVersion === expectedNormalization,
    `unsupported normalization version ${checkpoint.normalizationVersion}`,
  );
  return reconstructCheckpoint(checkpoint, SCHEMA_VERSION, expectedNormalization);
}

export function openMaintenanceCheckpoint(
  checkpoint: CanonicalCheckpoint,
  schemaVersion: number,
): Y.Doc {
  assert(
    checkpoint.schemaVersion === schemaVersion,
    `unsupported maintenance schema ${checkpoint.schemaVersion}`,
  );
  assert(
    checkpoint.normalizationVersion === NORMALIZATION_VERSION,
    'unsupported normalization version',
  );
  const document = reconstructCheckpoint(checkpoint, schemaVersion, NORMALIZATION_VERSION);
  try {
    for (const record of schemaMap<RecordMap>(document, NODES).values()) {
      const children = record.get('children');
      assert(
        schemaVersion === SCHEMA_VERSION
          ? children instanceof Y.Array
          : !(children instanceof Y.Array),
        `checkpoint has children storage incompatible with schema ${schemaVersion}`,
      );
    }
    return document;
  } catch (error) {
    document.destroy();
    throw error;
  }
}

export function restoreCanonicalCheckpoint(
  checkpoint: CanonicalCheckpoint,
  authorityEpoch: string,
): Y.Doc {
  assert(authorityEpoch.length > 0, 'authority epoch cannot be empty');
  assert(
    authorityEpoch !== checkpoint.authorityEpoch,
    'restored authority epoch must differ from the checkpoint epoch',
  );
  const restored = openCanonicalCheckpoint(checkpoint);
  try {
    const meta = schemaMap<unknown>(restored, META);
    const revisions = schemaMap<number>(restored, TAPE_REVISIONS);
    const sessionWatermarks = schemaMap<number>(restored, SESSION_WATERMARKS);
    restored.transact(() => {
      meta.set('authorityEpoch', authorityEpoch);
      meta.set('acceptedRevision', 0);
      for (const tapeId of revisions.keys()) revisions.set(tapeId, 0);
      for (const sessionId of sessionWatermarks.keys()) sessionWatermarks.delete(sessionId);
    }, 'grain:epoch-restore');
    const validation = validateCanonicalState(restored);
    assert(
      validation.valid,
      `restored checkpoint failed validation: ${validation.errors.join('; ')}`,
    );
    return restored;
  } catch (error) {
    restored.destroy();
    throw error;
  }
}

function reconstructCheckpoint(
  checkpoint: CanonicalCheckpoint,
  expectedSchemaVersion: number,
  expectedNormalizationVersion: number,
): Y.Doc {
  const document = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(document, Uint8Array.from(checkpoint.update));
    assert(
      !document.store.pendingStructs && !document.store.pendingDs,
      'checkpoint has unresolved native dependencies',
    );
    const meta = schemaMap<unknown>(document, META);
    assert(
      metaValue<number>(meta, 'schemaVersion') === expectedSchemaVersion,
      'checkpoint has an unsupported schema version',
    );
    assert(
      metaValue<number>(meta, 'normalizationVersion') === expectedNormalizationVersion,
      'checkpoint has an unsupported normalization version',
    );
    assert(
      metaValue<string>(meta, 'documentId') === checkpoint.documentId,
      'checkpoint document ID does not match its state',
    );
    assert(
      metaValue<string>(meta, 'authorityEpoch') === checkpoint.authorityEpoch,
      'checkpoint authority epoch does not match its state',
    );
    assert(
      metaValue<number>(meta, 'acceptedRevision') === checkpoint.acceptedRevision,
      'checkpoint revision does not match its state',
    );
    const validation = validateCanonicalState(document);
    assert(validation.valid, `checkpoint failed validation: ${validation.errors.join('; ')}`);
    return document;
  } catch (error) {
    document.destroy();
    throw error;
  }
}
