import { expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { NativeTapeCache } from '../text/cache.js';
import * as projection from '../projection/project.js';

test('the differential oracle rebuilds native state and full semantic projection on every check', () => {
  const p = commandReplica(commandGenesis(), undefined, 'materialized');
  const oracle = createMaterializationOracle();
  const bodies = vi.spyOn(NativeTapeCache.prototype, 'applySteps');
  const projector = vi.spyOn(projection, 'projectMarkdown');
  try {
    oracle.check(p.document, p.genesis);
    oracle.check(p.document, p.genesis);
    expect(bodies.mock.calls.filter(([key]) => key === 'genesis')).toHaveLength(2);
    expect(projector).toHaveBeenCalledTimes(2);
  } finally {
    bodies.mockRestore();
    projector.mockRestore();
    oracle.destroy();
    p.close();
  }
});
