import { test } from 'vitest';
import { contractCorpus } from '../../../../test/multiwriter/corpus.js';
import { replicaTraceAdapter } from '../../../../test/multiwriter/network.js';
import { referenceFactory } from '../../../../test/multiwriter/reference/factory.js';
import { runContractTrace } from '../../../../test/multiwriter/trace.js';
import { openMaterializedDocument } from './document.js';
import { equal } from '../../../../test/multiwriter/equal.js';
for (const id of [
  'old-prefix-after-lossless-maintenance',
  'history-limit-retains-canonical-facts',
]) {
  const trace = contractCorpus.find((t) => t.id === id)!;
  test(`actual MW-18 checkpoint and native materializer: ${id}`, async () => {
    await runContractTrace(
      replicaTraceAdapter(
        referenceFactory(
          trace,
          (action) => {
            if (action.sequence % 50n === 0n) console.info(`${id}: ${action.id} published`);
          },
          { openDocument: openMaterializedDocument, checkpointJournal: true },
        ),
        equal,
      ),
      trace,
      equal,
    );
  }, 3600000);
}
