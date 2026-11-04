// @ts-expect-error Node APIs are supplied by Vitest; Grain has no @types/node dependency.
import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  ReplicaNetwork,
  SeededRandom,
  encodeNetworkTrace,
  decodeNetworkTrace,
  replayNetworkTrace,
} from '../../../test/multiwriter/network.js';
import { referenceFactory } from '../../../test/multiwriter/reference/factory.js';
import { generateAction } from '../../../test/multiwriter/reference/generator.js';
import { scenario, structuralChoices } from '../../../test/multiwriter/reference/matrix.js';
const equal = (actual: unknown, expected: unknown, context: string) =>
  expect(actual, context).toEqual(expected);

async function synchronize(network: ReplicaNetwork, peers: readonly string[]) {
  for (const peer of peers) await network.step({ type: 'mode', peer, mode: 'bidirectional' });
  for (const from of peers)
    for (const to of peers)
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
  for (const peer of peers) await network.step({ type: 'replay', peer });
}

for (const left of structuralChoices)
  for (const right of structuralChoices) {
    test(`independent matrix: ${left} / ${right}`, async () => {
      const trace = scenario([left, right], `${left}-${right}`);
      const network = await ReplicaNetwork.open(referenceFactory(trace), trace, equal);
      try {
        for (const step of trace.steps)
          if (step.type !== 'expect') await network.executeContractStep(step);
        await synchronize(network, trace.peers);
      } catch (error) {
        writeFileSync(
          `/tmp/mw08-matrix-${left}-${right}.json`,
          encodeNetworkTrace(network.trace()),
        );
        throw error;
      } finally {
        await network.dispose();
      }
    }, 60000);
  }

for (const seed of [1, 7, 42, 85, 89, 34064, 123456, 0xffff_ffff]) {
  test(`independent generated structural schedule: seed ${seed}`, async () => {
    const random = new SeededRandom(seed);
    const choices = Array.from(
      { length: 3 },
      () => structuralChoices[random.next(structuralChoices.length)],
    );
    const trace = scenario(choices, `structural-seed-${seed}`);
    const network = await ReplicaNetwork.open(referenceFactory(trace), trace, equal, seed);
    let afterRemote = 0;
    try {
      for (const step of trace.steps) if (step.type === 'author') await network.step(step);
      const local = (
        peer: string,
        state: import('../../../test/multiwriter/trace.js').Observation,
        random: SeededRandom,
      ) => {
        const commands = network
          .trace()
          .steps.flatMap((step) => (step.type === 'author' ? [step.action] : []));
        const action = generateAction(peer, state, commands, random);
        if (
          state.ready.some((id) => commands.find((command) => command.id === id)?.peer !== peer) &&
          action.intents.some((intent) => intent.type !== 'control')
        )
          afterRemote++;
        return { type: 'author' as const, action };
      };
      await network.generate(12, local);
      await synchronize(network, trace.peers);
      for (const peer of trace.peers)
        for (const preference of ['create', 'undo', 'redo'] as const) {
          const commands = network
            .trace()
            .steps.flatMap((step) => (step.type === 'author' ? [step.action] : []));
          const action = generateAction(
            peer,
            await network.observe(peer),
            commands,
            random,
            preference,
          );
          await network.step({ type: 'author', action });
        }
      await network.generate(12, local);
      const generated = network.trace().steps;
      const authored = generated.flatMap((step) => (step.type === 'author' ? [step.action] : []));
      expect(afterRemote).toBeGreaterThan(0);
      expect(new Set(authored.map((action) => action.peer)).size).toBe(3);
      expect(
        authored
          .slice(3)
          .filter((action) => action.intents.some((intent) => intent.type !== 'control')).length,
      ).toBeGreaterThan(5);
      expect(
        authored.some((action) =>
          action.intents.some((intent) => intent.type === 'control' && !intent.active),
        ),
      ).toBe(true);
      expect(
        authored.some((action) =>
          action.intents.some((intent) => intent.type === 'control' && intent.active),
        ),
      ).toBe(true);
      console.info(
        JSON.stringify({
          seed,
          turns: 24,
          afterRemote,
          scheduledSteps: generated.length,
          authored: authored.length,
          operations: Object.fromEntries(
            [
              ...new Set(authored.flatMap((action) => action.intents.map((intent) => intent.type))),
            ].map((type) => [
              type,
              authored.flatMap((action) => action.intents).filter((intent) => intent.type === type)
                .length,
            ]),
          ),
          deliveries: generated.filter((step) => step.type === 'deliver').length,
          restarts: generated.filter((step) => step.type === 'restart').length,
        }),
      );
      await synchronize(network, trace.peers);
      const encoded = encodeNetworkTrace(network.trace());
      const recovered = decodeNetworkTrace(encoded);
      expect(encodeNetworkTrace(recovered)).toBe(encoded);
      await replayNetworkTrace(referenceFactory(trace), recovered, equal);
    } catch (error) {
      writeFileSync(`/tmp/mw08-seed-${seed}.json`, encodeNetworkTrace(network.trace()));
      throw error;
    } finally {
      await network.dispose();
    }
  }, 120000);
}
