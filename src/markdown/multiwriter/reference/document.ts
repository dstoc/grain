import { ReferenceActionStore } from './store.js';
import { IngestPublication } from '../ingest/publication.js';
import { createIngestValidator } from '../ingest/validator.js';
import type { LayoutGenesis } from '../layout/index.js';
import { createProjectionAuthorValidator, projectMarkdown } from '../projection/index.js';
import type { ProjectionInput } from '../projection/project.js';
import type { NativeBody } from '../text/types.js';
import type { ActionEnvelope } from '../contracts.js';
import { ProvenanceError, reconstructBirths, reconstructProvenance } from './provenance.js';

export interface ReferenceGenesis {
  readonly documentId: string;
  readonly genesisId: string;
  readonly layout: LayoutGenesis;
  readonly body: NativeBody;
  readonly initialProperties?: ProjectionInput['initialProperties'];
}

/** One headless replica's certification and atomic publication, with no fixture registry.
 * All inputs are detached. Transport, local authoring and navigation are separate callers.
 */
export function openReferenceDocument(input: ReferenceGenesis) {
  const genesis = structuredClone(input);
  const validateAuthor = createProjectionAuthorValidator({
    genesis: genesis.layout,
    births: reconstructBirths,
  });
  const validate = createIngestValidator({
    genesis: genesis.body,
    validateAuthor(action, context) {
      try {
        return validateAuthor(action, context);
      } catch (error) {
        // Retain invalid peer facts without blocking independent ready actions.
        // Capacity, native-data and host failures keep their existing behavior.
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
  const publication = new IngestPublication(store, genesis.body, function* (actions, native) {
    yield;
    validate.retainReady(actions);
    const provenance = reconstructProvenance(genesis.layout, actions);
    return projectMarkdown({
      genesis: genesis.layout,
      genesisManifest: genesis.body.nativeManifest,
      initialProperties: genesis.initialProperties,
      ...provenance,
      native,
    });
  });
  return {
    store,
    publication,
    /** Preflight the actual store's ready past before publishing any local facts. */
    certifyLocal(action: ActionEnvelope): void {
      const reason = store.checkLocal(action);
      if (reason) throw new Error(`Local reference action failed certification: ${reason}`);
    },
    /** All materialized certification/publication native states, detached and read-only. */
    nativeStates(): readonly Uint8Array[] {
      const current = publication.status().publication;
      return [validate.encodeNativeState(), ...(current ? [current.native.encodeState()] : [])];
    },
    destroy() {
      publication.destroy();
      store.destroy();
      validate.destroy();
    },
  };
}

export { ProvenanceError } from './provenance.js';
