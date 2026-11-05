import { IndexedActionStore } from './readiness.js';
import type { ReferenceGenesis } from '../reference/document.js';
import { createIngestValidator } from '../ingest/validator.js';
import { assertLimit } from '../ingest/work.js';
import { createProjectionAuthorValidator } from '../projection/index.js';
import { MaterializedActivity } from './activity.js';
import { MaterializedProjection } from './projection.js';
import type { PreparedActivity } from './activity.js';
import type { PreparedProjection } from './projection.js';
import { ProvenanceError, reconstructBirths } from '../reference/provenance.js';
import type { ActionEnvelope } from '../contracts.js';
import { MaterializedPublication } from './publication.js';

/** Opt-in native materialization stage. The full reference document remains independent.
 * Readiness uses dirty dependency indexes. Author closure construction and semantic
 * projection still use full-array/reference fallbacks.
 */
export function openMaterializedDocument(
  input: ReferenceGenesis,
  options: { readonly nativeDecodeOperations?: number } = {},
) {
  const genesis = structuredClone(input);
  const validateAuthor = createProjectionAuthorValidator({
    genesis: genesis.layout,
    births: reconstructBirths,
  });
  const validate = createIngestValidator({
    genesis: genesis.body,
    decodeOperations: options.nativeDecodeOperations,
    validateAuthor(action, context) {
      try {
        return validateAuthor(action, context);
      } catch (error) {
        if (error instanceof ProvenanceError) return 'reference';
        throw error;
      }
    },
  });
  const store = new IndexedActionStore({
    documentId: genesis.documentId,
    genesisId: genesis.genesisId,
    genesisAllocations: genesis.layout.allocations,
    validate,
  });
  const activity = new MaterializedActivity();
  const projection = new MaterializedProjection();
  let preparedProjection: PreparedProjection | undefined;
  let prepared: PreparedActivity | undefined;
  const publication = new MaterializedPublication(
    store,
    genesis.body,
    function* (actions, native, variants) {
      prepared = yield* activity.prepare(actions, variants);
      yield;
      preparedProjection = yield* projection.prepare(
        genesis,
        actions,
        native,
        prepared.value,
        variants,
      );
      return preparedProjection.value;
    },
    options.nativeDecodeOperations,
    (_actions, variants) => validate.retainReadyFacts(variants),
    {
      fullProjectionCount: () => projection.fullProjectionCount(),
      commit() {
        prepared!.commit();
        preparedProjection!.commit();
        preparedProjection = undefined;
        prepared = undefined;
      },
      cancel() {
        prepared = undefined;
        activity.cancel();
        preparedProjection = undefined;
        projection.cancel();
      },
      evict() {
        activity.evict();
        projection.evict();
      },
    },
  );
  return {
    commandMode: 'overlay' as const,
    readyActions: () => store.readReady().ready,
    activityDiagnostics: () => activity.diagnostics(),
    ownershipDiagnostics: () => projection.diagnostics().ownership,
    projectionDiagnostics: () => projection.diagnostics(),
    store,
    publication,
    setNativeDecodeLimit(operations: number): void {
      assertLimit(operations);
      publication.setDecodeLimit(operations);
      store.setDecodeLimits({});
      validate.setDecodeLimit(operations);
    },
    certifyLocal(action: ActionEnvelope): void {
      const reason = store.checkLocal(action);
      if (reason) throw new Error(`Local materialized action failed certification: ${reason}`);
    },
    nativeStates(): readonly Uint8Array[] {
      const current = publication.status().publication;
      return [validate.encodeNativeState(), ...(current ? [current.native.encodeState()] : [])];
    },
    destroy(): void {
      publication.destroy();
      store.destroy();
      validate.destroy();
    },
  };
}
