import { expect, test, vi } from 'vitest';
import { commandGenesis } from '../../../../test/multiwriter/commands/replica.js';
import { OwnershipResult } from '../ownership/ownership.js';
import { NativeTapeCache } from '../text/cache.js';
import { nativeView } from '../ingest/publication.js';
import { reconstructProvenance } from '../reference/provenance.js';
import { projectMarkdown, serializeProjection } from './project.js';

test('full reconstruction reads detached ownership collections once per projection', () => {
  const markdown = Array.from({ length: 150 }, () => 'abc').join('\n\n');
  const genesis = commandGenesis(markdown),
    cache = new NativeTapeCache();
  try {
    cache.apply('G', genesis.body);
    const nodes = vi.spyOn(OwnershipResult.prototype, 'nodeAllocations', 'get'),
      runs = vi.spyOn(OwnershipResult.prototype, 'runLayouts', 'get'),
      requirements = vi.spyOn(OwnershipResult.prototype, 'destinationRequirements', 'get');
    try {
      const result = projectMarkdown({
        genesis: genesis.layout,
        genesisManifest: genesis.body.nativeManifest,
        initialProperties: genesis.initialProperties,
        ...reconstructProvenance(genesis.layout, []),
        native: nativeView(cache),
      });
      expect(serializeProjection(result.view)).toBe(`${markdown}\n`);
      expect(nodes).toHaveBeenCalledTimes(1);
      expect(runs).toHaveBeenCalledTimes(1);
      expect(requirements).toHaveBeenCalledTimes(1);
    } finally {
      nodes.mockRestore();
      runs.mockRestore();
      requirements.mockRestore();
    }
  } finally {
    cache.destroy();
  }
});
