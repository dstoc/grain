import { expect, test } from 'vitest';
import { contractCorpus } from '../../../../test/multiwriter/corpus.js';
import { replicaTraceAdapter } from '../../../../test/multiwriter/network.js';
import { runContractTrace } from '../../../../test/multiwriter/trace.js';
import { referenceFactory } from '../../../../test/multiwriter/reference/factory.js';
import { openMaterializedDocument } from './document.js';
import { checkMaterializedPublication } from '../../../../test/multiwriter/materialization-oracle.js';

const equal = (actual: unknown, expected: unknown, context: string) =>
  expect(actual, context).toEqual(expected);

for (const trace of contractCorpus) {
  test(
    `native materialization versus cold oracle at each publication: ${trace.id}`,
    async () => {
      await runContractTrace(
        replicaTraceAdapter(
          referenceFactory(trace, undefined, {
            openDocument: openMaterializedDocument,
            onPublication: checkMaterializedPublication,
          }),
          equal,
        ),
        trace,
        equal,
      );
    },
    trace.id === 'history-limit-retains-canonical-facts' ? 3600000 : 120000,
  );
}
