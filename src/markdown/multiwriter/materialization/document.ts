import { ReferenceActionStore } from '../reference/store.js';
import type { ReferenceGenesis } from '../reference/document.js';
import { createIngestValidator } from '../ingest/validator.js';
import { assertLimit } from '../ingest/work.js';
import { createProjectionAuthorValidator, projectMarkdown } from '../projection/index.js';
import {
  ProvenanceError,
  reconstructBirths,
  reconstructProvenance,
} from '../reference/provenance.js';
import type { ActionEnvelope } from '../contracts.js';
import { MaterializedPublication } from './publication.js';

/** Opt-in native materialization stage. The full reference document remains independent.
 * Readiness, author certification and semantic projection are still reference fallbacks.
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
  const store = new ReferenceActionStore({
    documentId: genesis.documentId,
    genesisId: genesis.genesisId,
    genesisAllocations: genesis.layout.allocations,
    validate,
  });
  const publication = new MaterializedPublication(
    store,
    genesis.body,
    function* (actions, native) {
      yield;
      return projectMarkdown({
        genesis: genesis.layout,
        genesisManifest: genesis.body.nativeManifest,
        initialProperties: genesis.initialProperties,
        ...reconstructProvenance(genesis.layout, actions),
        native,
      });
    },
    options.nativeDecodeOperations,
    (actions) => validate.retainReady(actions),
  );
  return {
    commandMode: 'overlay' as const,
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
