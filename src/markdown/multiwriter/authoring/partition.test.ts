import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { indent } from '../../../editing/commands/indent.js';
import { outdent } from '../../../editing/commands/outdent.js';
import { insertMarkdown } from '../../../editing/commands/insert-markdown.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';
import { DirectionalActionProvider } from '../providers/adapter.js';
import { SeededRandom } from '../../../../test/multiwriter/network.js';

const session = { local: 'commands', group: 1n };
test('independent command branches converge on duplicate/reversed original action-store updates and reopen', () => {
  const genesis = commandGenesis(),
    peers = [commandReplica(genesis), commandReplica(genesis), commandReplica(genesis)];
  const updates: Uint8Array[][] = peers.map(() => []),
    off = peers.map((p, i) => p.document.store.onUpdate((bytes) => updates[i].push(bytes)));
  try {
    const [a, b, c] = peers;
    a.editor.edit(session, insertParagraph, { nodeId: a.handle(a.nodes()[0]!), from: 3 });
    a.editor.edit(session, insertText, { nodeId: a.handle(a.nodes()[1]!), from: 1, text: 'A' });
    b.editor.edit(session, indent, { nodeId: b.handle(b.nodes()[0]!) });
    b.editor.edit(session, insertMarkdown, {
      contextId: b.handle(b.nodes()[0]!),
      markdown: 'peer',
    });
    c.editor.edit(session, insertText, { nodeId: c.handle(c.nodes()[0]!), from: 2, text: 'C' });
    const original = updates.map((u) => u.slice());
    for (let recipient = 0; recipient < peers.length; recipient++)
      for (const source of [2, 0, 1])
        if (source !== recipient) {
          for (const bytes of original[source].slice().reverse()) {
            peers[recipient].receive(bytes);
            peers[recipient].receive(bytes);
          }
        }
    for (const peer of peers) {
      expect(peer.observe()).toEqual(peers[0].observe());
      const reopened = commandReplica(genesis, peer.document.store.encodeUpdate());
      try {
        expect(reopened.observe()).toEqual(peer.observe());
      } finally {
        reopened.close();
      }
    }
  } finally {
    off.forEach((f) => f());
    peers.forEach((p) => p.close());
  }
});

test('108 consecutive mixed commands with persistence and ACKs held retain outbound isolation', async () => {
  const genesis = commandGenesis(),
    a = commandReplica(genesis),
    b = commandReplica(genesis),
    isolated = commandReplica(genesis),
    c = commandReplica(genesis);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const journal: Uint8Array[] = [];
  const provider = await DirectionalActionProvider.open({
    store: a.document.store,
    mode: 'outbound-only',
    journal: {
      read: async () => [],
      append: async (bytes) => {
        await held;
        journal.push(bytes.slice());
      },
      close() {},
    },
  });
  const detach = provider.attachPeer('B', { acknowledgments: true, send: async () => {} });
  const publications = [];
  try {
    b.editor.edit({ local: 'B', group: 1n }, deleteBlocks, { nodeIds: [b.handle(b.nodes()[0]!)] });
    const remote = b.document.store.encodeUpdate();
    for (let cycle = 0; cycle < 18; cycle++) {
      for (const peer of [a, isolated]) {
        let node = peer.nodes().at(-1)!;
        peer.editor.edit({ local: 'A', group: BigInt(cycle * 6 + 1) }, insertText, {
          nodeId: peer.handle(node),
          from: node.content.length,
          text: 'x',
        });
        node = peer.nodes().at(-1)!;
        peer.editor.edit({ local: 'A', group: BigInt(cycle * 6 + 2) }, insertParagraph, {
          nodeId: peer.handle(node),
          from: node.content.length,
        });
        peer.editor.edit({ local: 'A', group: BigInt(cycle * 6 + 3) }, joinWithPrevious, {
          nodeId: peer.handle(peer.nodes().at(-1)!),
        });
        peer.editor.edit({ local: 'A', group: BigInt(cycle * 6 + 4) }, indent, {
          nodeId: peer.handle(peer.nodes().at(-1)!),
        });
        peer.editor.edit({ local: 'A', group: BigInt(cycle * 6 + 5) }, outdent, {
          nodeId: peer.handle(peer.nodes().at(-1)!),
        });
        peer.editor.edit({ local: 'A', group: BigInt(cycle * 6 + 6) }, insertMarkdown, {
          contextId: peer.handle(peer.nodes().at(-1)!),
          markdown: 'copy',
        });
      }
      const before = a.document.store.encodeUpdate(),
        native = a.observe().native;
      expect(provider.receive('peer', remote)).toBe(false);
      expect(provider.receive('catch-up', remote)).toBe(false);
      expect(a.document.store.encodeUpdate()).toEqual(before);
      expect(a.observe().native).toEqual(native);
      expect(a.markdown()).toBe(isolated.markdown());
      publications.push(provider.capturePublication());
    }
    expect(a.document.store.snapshot().ready).toHaveLength(108);
    expect(journal).toHaveLength(0);
    expect(
      publications.every(
        (p) => p.status('B').applied && !p.status('B').persisted && !p.status('B').delivered,
      ),
    ).toBe(true);
    const localIds = a.document.store.snapshot().ready.map((x) => x.id);
    provider.setMode('bidirectional');
    expect(provider.receive('catch-up', remote)).toBe(true);
    a.editor.refresh();
    b.receive(a.document.store.encodeUpdate());
    c.receive(b.document.store.encodeUpdate());
    expect(a.observe()).toEqual(b.observe());
    expect(a.observe()).toEqual(c.observe());
    for (const id of localIds)
      expect(
        a.document.store
          .snapshot()
          .ready.some((x) => x.id.actor === id.actor && x.id.sequence === id.sequence),
      ).toBe(true);
    release();
    await provider.flush();
    expect(publications.every((p) => p.status('B').persisted)).toBe(true);
  } finally {
    release();
    detach();
    await provider.close();
    [a, b, c, isolated].forEach((p) => p.close());
  }
}, 600000);

for (const seed of [1, 7, 42, 90, 34064])
  test(`seeded commands at current peer state: seed ${seed}`, () => {
    const genesis = commandGenesis('alpha\n\nbeta'),
      peers = [commandReplica(genesis), commandReplica(genesis), commandReplica(genesis)],
      random = new SeededRandom(seed);
    const counts = { type: 0, enter: 0, join: 0, indent: 0, paste: 0, delete: 0, multi: 0 };
    try {
      for (let step = 0; step < 30; step++) {
        const peer = peers[random.next(peers.length)],
          nodes = peer.nodes(),
          node = nodes[random.next(nodes.length)]!,
          nodeId = peer.handle(node),
          session = { local: 'seed', group: BigInt(step + 1) };
        switch (random.next(7)) {
          case 0:
            peer.editor.edit(session, insertText, {
              nodeId,
              from: node.content.length,
              text: String(step),
            });
            counts.type++;
            break;
          case 1:
            peer.editor.edit(session, insertParagraph, {
              nodeId,
              from: Math.floor(node.content.length / 2),
            });
            counts.enter++;
            break;
          case 2:
            peer.editor.edit(session, joinWithPrevious, { nodeId });
            counts.join++;
            break;
          case 3:
            peer.editor.edit(session, indent, { nodeId });
            counts.indent++;
            break;
          case 4:
            peer.editor.edit(session, insertMarkdown, { contextId: nodeId, markdown: 'pasted' });
            counts.paste++;
            break;
          case 5:
            peer.editor.edit(session, deleteBlocks, { nodeIds: [nodeId] });
            counts.delete++;
            break;
          case 6:
            peer.editor.edit(
              session,
              (context, input) => {
                insertText(context, { nodeId: input, from: 0, text: 'M' });
                return insertParagraph(context, { nodeId: input, from: 1 });
              },
              nodeId,
            );
            counts.multi++;
            break;
        }
        if (step % 5 === 4) {
          const from = random.next(3),
            to = (from + 1 + random.next(2)) % 3;
          peers[to].receive(peers[from].document.store.encodeUpdate());
        }
      }
      for (const peer of peers)
        for (const source of peers)
          if (peer !== source) peer.receive(source.document.store.encodeUpdate());
      for (const peer of peers) {
        expect(peer.observe(), `seed=${seed} counts=${JSON.stringify(counts)}`).toEqual(
          peers[0].observe(),
        );
        const reopened = commandReplica(genesis, peer.document.store.encodeUpdate());
        try {
          expect(reopened.observe()).toEqual(peer.observe());
        } finally {
          reopened.close();
        }
      }
    } finally {
      peers.forEach((p) => p.close());
    }
  }, 60000);
