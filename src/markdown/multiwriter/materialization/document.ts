import { measureWork } from '../diagnostics.js';
import { measure } from '../diagnostics.js';
import { IndexedActionStore, readySequence } from './readiness.js';
import type { ReferenceGenesis } from '../reference/document.js';
import { createIngestValidator } from '../ingest/validator.js';
import { actionKey } from '../actions/references.js';
import { encodeEnvelope } from '../actions/codec.js';
import { finish, assertLimit } from '../ingest/work.js';
import { createProjectionAuthorValidator } from '../projection/index.js';
import { MaterializedActivity } from './activity.js';
import { registerReadyAppend } from './ready-index.js';
import { MaterializedProjection } from './projection.js';
import type { PreparedActivity } from './activity.js';
import type { PreparedProjection } from './projection.js';
import {
  ProvenanceError,
  reconstructBirths,
  reconstructProvenance,
} from '../reference/provenance.js';
import type { CommandOwnership } from '../authoring/document.js';
import type { ActionEnvelope } from '../contracts.js';
import type { NativeView } from '../ingest/publication.js';
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
  const commandWork = {
    queries: 0,
    actionsReplayed: 0,
    effectsReplayed: 0,
    nativeTapeReads: 0,
    coldReplays: 0,
    payloadsCompared: 0,
    interpretationSelections: 0,
    activityActionsReplayed: 0,
    activityPayloadsCompared: 0,
  };
  let preparedProjection: PreparedProjection | undefined;
  let prepared: PreparedActivity | undefined;
  const publication = new MaterializedPublication(
    store,
    genesis.body,
    function* (actions, native, variants) {
      prepared = yield* activity.prepare(actions, variants);
      yield;
      preparedProjection = yield* measureWork(
        'visibility-normalization',
        projection.prepare(genesis, actions, native, prepared.value, variants),
      );
      return preparedProjection.value;
    },
    options.nativeDecodeOperations,
    (_actions, variants) => validate.retainReadyFacts(variants),
    {
      fullProjectionCount: () => projection.fullProjectionCount(),
      commit() {
        const activityCandidate = prepared!,
          projectionCandidate = preparedProjection!;
        activityCandidate.assertCurrent();
        projectionCandidate.assertCurrent();
        activityCandidate.commit();
        projectionCandidate.commit();
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
        // A suspended readiness validator must finish cancellation before its
        // private branch/preimages can be released. No canonical facts change.
        store.evict();
        validate.evict();
        activity.evict();
        projection.evict();
      },
    },
  );
  return {
    commandMode: 'overlay' as const,
    readyActions: () => readySequence(store.readReady()),
    activityDiagnostics: () => activity.diagnostics(),
    ownershipDiagnostics: () => projection.diagnostics().ownership,
    projectionDiagnostics: () => projection.diagnostics(),
    commandOwnershipDiagnostics: () => ({ ...commandWork }),
    createCommandOwnership(): CommandOwnership | undefined {
      const status = publication.status();
      if (status.stale || !status.canAuthor) return undefined;
      const branch = projection.commandOwnership();
      if (!branch) return undefined;
      const commandActivity = activity.fork();
      const ready = store.readReady(),
        version = store.factsVersion;
      // Compiler queries can replace the same unpublished action repeatedly.
      // Always replay from the committed prefix; never commit a partial action.
      return (action, native, touched) => {
        if (store.factsVersion !== version)
          throw new Error('Command ownership invalidated by changed facts');
        const actions = [...readySequence(ready), action],
          key = actionKey(action.id),
          bytes = encodeEnvelope(action);
        registerReadyAppend(actions, readySequence(ready), action);
        const variants = { get: (id: string) => (id === key ? bytes : ready.variants.get(id)) };
        const before = branch.diagnostics(),
          beforeActivity = commandActivity.diagnostics();
        try {
          const prepared = finish(commandActivity.prepare(actions, variants));
          return finish(
            measureWork(
              'coupled-replay',
              branch.prepare(
                {
                  genesis: genesis.layout,
                  genesisManifest: genesis.body.nativeManifest,
                  initialProperties: genesis.initialProperties,
                  actions: actions.map((action) => ({ action, births: reconstructBirths(action) })),
                  birthContent: [],
                  native,
                },
                prepared.value,
                variants,
                touched,
                actions,
              ),
            ),
          ).value.ownership;
        } finally {
          branch.cancel();
          commandActivity.cancel();
          const after = branch.diagnostics();
          commandWork.queries++;
          for (const field of [
            'actionsReplayed',
            'effectsReplayed',
            'nativeTapeReads',
            'coldReplays',
            'payloadsCompared',
            'interpretationSelections',
          ] as const)
            commandWork[field] += after[field] - before[field];
          const afterActivity = commandActivity.diagnostics();
          commandWork.activityActionsReplayed +=
            afterActivity.actionsReplayed - beforeActivity.actionsReplayed;
          commandWork.activityPayloadsCompared +=
            afterActivity.payloadsCompared - beforeActivity.payloadsCompared;
        }
      };
    },
    cacheDiagnostics: () => ({
      readiness: store.cacheDiagnostics(),
      author: validate.cacheDiagnostics(),
    }),
    store,
    publication,
    setNativeDecodeLimit(operations: number): void {
      assertLimit(operations);
      publication.setDecodeLimit(operations);
      store.setDecodeLimits({});
      validate.setDecodeLimit(operations);
    },
    stageLocalAction(action: ActionEnvelope, native: NativeView) {
      return measure(
        'visibility-normalization',
        () => {
          const status = publication.status();
          if (status.stale || !status.canAuthor) return undefined;
          const ready = store.readReady();
          const length = readySequence(ready).length + 1,
            key = actionKey(action.id),
            bytes = encodeEnvelope(action);
          const sequence = {
            length,
            at: (index: number) => {
              index = Math.trunc(index) || 0;
              const at = index < 0 ? length + index : index;
              if (at < 0 || at >= length) return undefined;
              return at === readySequence(ready).length ? action : readySequence(ready).at(at);
            },
          };
          registerReadyAppend(sequence, readySequence(ready), action);
          const variants = { get: (id: string) => (id === key ? bytes : ready.variants.get(id)) };
          try {
            const prepared = finish(activity.prepare(sequence, variants));
            const value = projection.canStageText(action)
              ? projection.stageText(sequence, native, prepared.value, variants)
              : projection.canStageProperties(action)
                ? projection.stageProperties(
                    sequence,
                    native,
                    prepared.value,
                    variants,
                    genesis.initialProperties,
                  )
                : projection.stageStructure(
                    {
                      genesis: genesis.layout,
                      genesisManifest: genesis.body.nativeManifest,
                      initialProperties: genesis.initialProperties,
                      ...reconstructProvenance(genesis.layout, [...readySequence(ready), action]),
                      native,
                    },
                    prepared.value,
                    variants,
                    sequence,
                  );
            return value ? { heads: [action.id], native, value } : undefined;
          } finally {
            activity.cancel();
          }
        },
        'staging',
      );
    },
    certifyLocal(action: ActionEnvelope): void {
      return measure(
        'exact-author',
        () => {
          const reason = store.checkLocal(action);
          if (reason) throw new Error(`Local materialized action failed certification: ${reason}`);
        },
        'author',
      );
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
