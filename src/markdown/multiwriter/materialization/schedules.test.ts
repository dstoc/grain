// @ts-expect-error Node APIs are supplied by Vitest; Grain has no @types/node dependency.
import { writeFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  ReplicaNetwork,
  SeededRandom,
  encodeNetworkTrace,
  decodeNetworkTrace,
  replayNetworkTrace,
} from '../../../../test/multiwriter/network.js';
import { referenceFactory } from '../../../../test/multiwriter/reference/factory.js';
import { generateAction } from '../../../../test/multiwriter/reference/generator.js';
import { scenario, structuralChoices } from '../../../../test/multiwriter/reference/matrix.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { openMaterializedDocument } from './document.js';
import { equal } from '../../../../test/multiwriter/equal.js';
for (const seed of [1, 7, 42, 85, 89, 34064, 123456, 0xffffffff]) {
  test(`native materialization equals full reference during generated delivery: ${seed}`, async () => {
    const random = new SeededRandom(seed);
    const trace = scenario(
      Array.from({ length: 3 }, () => structuralChoices[random.next(structuralChoices.length)]),
      `mw13-${seed}`,
    );
    const oracle = createMaterializationOracle();
    const factory = () =>
      referenceFactory(trace, undefined, {
        openDocument: openMaterializedDocument,
        onPublication: oracle.check,
      });
    const network = await ReplicaNetwork.open(factory(), trace, equal, seed);
    try {
      for (const step of trace.steps) if (step.type === 'author') await network.step(step);
      await network.generate(24, (peer, state, random) => {
        const actions = network
          .trace()
          .steps.flatMap((step) => (step.type === 'author' ? [step.action] : []));
        return { type: 'author', action: generateAction(peer, state, actions, random) };
      });
      for (const peer of trace.peers)
        await network.step({ type: 'mode', peer, mode: 'bidirectional' });
      for (const from of trace.peers)
        for (const to of trace.peers)
          if (from !== to) {
            const id = `catch-up-${network.trace().steps.length}-${from}-${to}`;
            await network.step({ type: 'link', from, to, enabled: true, reverseControl: false });
            await network.step({
              type: 'send',
              id,
              from,
              to,
              actions: (await network.observe(from)).held,
              route: 'catch-up',
            });
            await network.step({ type: 'deliver', id });
          }
      for (const peer of trace.peers) await network.step({ type: 'replay', peer });
      const encoded = encodeNetworkTrace(network.trace());
      await replayNetworkTrace(factory(), decodeNetworkTrace(encoded), equal);
    } catch (error) {
      writeFileSync(`/tmp/mw13-schedule-${seed}.json`, encodeNetworkTrace(network.trace()));
      throw error;
    } finally {
      await network.dispose();
      oracle.destroy();
    }
  }, 300000);
}
