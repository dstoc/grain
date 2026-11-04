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
import type { LocalStep } from '../../../test/multiwriter/network.js';
import type { TraceAction } from '../../../test/multiwriter/trace.js';
import { referenceFactory } from '../../../test/multiwriter/reference/factory.js';
import { scenario, structuralChoices } from '../../../test/multiwriter/reference/matrix.js';
const equal = (actual: unknown, expected: unknown, context: string) =>
  expect(actual, context).toEqual(expected);

async function synchronize(network: ReplicaNetwork, peers: readonly string[]) {
  for (const peer of peers) await network.step({ type: 'mode', peer, mode: 'bidirectional' });
  for (const from of peers)
    for (const to of peers)
      if (from !== to) {
        const id = `final-${from}-${to}`;
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
    const trace = scenario(choices, `structural-seed-${seed}`, true);
    const commands = trace.steps.flatMap((step) => (step.type === 'author' ? [step.action] : []));
    const byId = new Map(commands.map((action) => [action.id, action]));
    const network = await ReplicaNetwork.open(referenceFactory(trace), trace, equal, seed);
    try {
      for (const command of commands.filter((command) => command.sequence === 1n))
        await network.step({ type: 'author', action: command });
      await network.generate(60, (peer, state): LocalStep | undefined => {
        const next = commands.find(
          (action) => action.peer === peer && !state.held.includes(action.id),
        );
        if (!next) return;
        const closure = new Set<string>();
        const add = (action: TraceAction) => {
          for (const name of action.dependencies)
            if (!closure.has(name)) {
              closure.add(name);
              add(byId.get(name)!);
            }
        };
        add(next);
        if (
          !state.ready.every((name) => closure.has(name)) ||
          !next.dependencies.every((name) => state.ready.includes(name))
        )
          return;
        const control = next.intents.find((i) => i.type === 'control');
        if (
          control?.type === 'control' &&
          !(control.active ? state.redo : state.undo).includes(control.group)
        )
          return;
        return { type: 'author', action: next };
      });
      const generated = network.trace().steps;
      const authored = generated.flatMap((step) => (step.type === 'author' ? [step.action] : []));
      expect(new Set(authored.map((action) => action.peer)).size).toBe(3);
      console.info(
        JSON.stringify({
          seed,
          turns: 60,
          scheduledSteps: generated.length,
          authored: authored.length,
          intents: authored.flatMap((action) => action.intents.map((intent) => intent.type)),
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
