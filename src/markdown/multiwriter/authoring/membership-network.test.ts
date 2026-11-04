import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { SeededRandom } from '../../../../test/multiwriter/network.js';
import { parseBlocks } from '../../block-parser/api.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';
import type { LocalEditResult } from './editor.js';

for (const seed of [9, 90, 34064])
  test(`seeded conversion/history commands and cold replay: ${seed}`, () => {
    const genesis = commandGenesis('alpha\n\nbeta'),
      peers = [commandReplica(genesis), commandReplica(genesis), commandReplica(genesis)],
      random = new SeededRandom(seed);
    const histories: LocalEditResult[][] = peers.map(() => []),
      counts = { type: 0, split: 0, delete: 0, conversion: 0, undo: 0, applied: 0, declined: 0 };
    try {
      for (let step = 0; step < 24; step++) {
        const i = random.next(3),
          p = peers[i],
          nodes = p.nodes(),
          node = nodes[random.next(nodes.length)],
          session = { local: 'network', group: BigInt(step + 1) };
        if (!node) {
          histories[i].push(p.editor.editEmptyRoot(session, 'empty'));
          continue;
        }
        const nodeId = p.handle(node);
        let result: LocalEditResult | undefined;
        switch (random.next(5)) {
          case 0:
            counts.type++;
            result = p.editor.edit(session, insertText, {
              nodeId,
              from: node.content.length,
              text: String(step),
            });
            break;
          case 1:
            counts.split++;
            result = p.editor.edit(session, insertParagraph, {
              nodeId,
              from: Math.floor(node.content.length / 2),
            });
            break;
          case 2:
            counts.delete++;
            result = p.editor.edit(session, deleteBlocks, { nodeIds: [nodeId] });
            break;
          case 3: {
            counts.conversion++;
            const source = `repeat${step}\n\n# repeat${step}`;
            result = p.editor.edit(
              session,
              insertText,
              { nodeId, from: 0, to: node.content.length, text: source },
              {
                conversion: { nodeId, plan: parseBlocks(source, { provenance: true }).provenance },
              },
            );
            break;
          }
          case 4: {
            const prior = histories[i].pop();
            if (prior?.status === 'applied') {
              control(p, prior, false);
              counts.undo++;
            }
            break;
          }
        }
        if (result?.status === 'applied') {
          counts.applied++;
          histories[i].push(result);
        }
        if (result?.status === 'declined') counts.declined++;
        if (step % 4 === 3) {
          const source = random.next(3),
            target = (source + 1 + random.next(2)) % 3;
          const bytes = peers[source].document.store.encodeUpdate();
          peers[target].receive(bytes);
          peers[target].receive(bytes);
        }
        if (step % 8 === 7) {
          const cold = commandReplica(genesis, p.document.store.encodeUpdate());
          try {
            expect(cold.observe()).toEqual(p.observe());
          } finally {
            cold.close();
          }
        }
      }
      for (const p of peers)
        for (const source of peers)
          if (p !== source) p.receive(source.document.store.encodeUpdate());
      for (const p of peers) {
        expect(
          p.document.store.snapshot().actions.every((a) => a.readiness.state === 'ready'),
        ).toBe(true);
        expect(p.observe(), `seed=${seed} counts=${JSON.stringify(counts)}`).toEqual(
          peers[0].observe(),
        );
        const cold = commandReplica(genesis, p.document.store.encodeUpdate());
        try {
          expect(cold.observe()).toEqual(p.observe());
        } finally {
          cold.close();
        }
      }
      console.info(`MW-09 membership seed=${seed} steps=24 counts=${JSON.stringify(counts)}`);
    } finally {
      peers.forEach((p) => p.close());
    }
  }, 60000);
