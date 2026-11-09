import { test } from 'vitest';
import { contractCorpus } from '../../../../test/multiwriter/corpus.js';
import { replicaTraceAdapter } from '../../../../test/multiwriter/network.js';
import { runContractTrace } from '../../../../test/multiwriter/trace.js';
import { referenceFactory } from '../../../../test/multiwriter/reference/factory.js';
import { openMaterializedDocument } from './document.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';

import { equal } from '../../../../test/multiwriter/equal.js';

for (const trace of contractCorpus) {
  test(
    `native materialization versus full reference at each publication: ${trace.id}`,
    async () => {
      const oracle = createMaterializationOracle();
      try {
        await runContractTrace(
          replicaTraceAdapter(
            referenceFactory(
              trace,
              (action) => {
                if (action.sequence % 50n === 0n)
                  console.info(`${trace.id}: ${action.id} published`);
              },
              {
                openDocument: openMaterializedDocument,
                onPublication: oracle.check,
              },
            ),
            equal,
          ),
          trace,
          equal,
        );
      } finally {
        oracle.destroy();
      }
    },
    trace.id === 'history-limit-retains-canonical-facts' ? 3600000 : 120000,
  );
}
