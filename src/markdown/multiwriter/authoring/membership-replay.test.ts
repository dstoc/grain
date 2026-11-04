import { expect, test } from 'vitest';
import { parseBlocks } from '../../block-parser/api.js';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { encodeEnvelope } from '../actions/codec.js';
import { compareBytes, decodeCbor, encodeCbor } from '../actions/cbor.js';
import type { CborValue } from '../actions/cbor.js';
import { DirectionalActionProvider } from '../providers/adapter.js';

// All replay uses original outer Yjs bytes; it never repacks action-store identities.
test('mixed prefix/new-membership/offline-tail reopens under one genesis without false forks', async () => {
  const genesis = commandGenesis(),
    a = commandReplica(genesis),
    old = commandReplica(genesis),
    b = commandReplica(genesis),
    c = commandReplica(genesis);
  let fail = true;
  const journal: Uint8Array[] = [];
  const provider = await DirectionalActionProvider.open({
    store: a.document.store,
    mode: 'disconnected',
    journal: {
      read: async () => [],
      append: async (bytes) => {
        if (fail) throw new Error('disk');
        journal.push(bytes.slice());
      },
      close() {},
    },
  });
  const messages: Uint8Array[] = [],
    off = a.document.store.onUpdate((bytes) => messages.push(bytes.slice()));
  try {
    a.editor.edit({ local: 'prefix', group: 1n }, insertText, {
      nodeId: a.handle(a.nodes()[0]),
      from: 6,
      text: '!',
    });
    const prefix = a.document.store.snapshot().ready[0],
      prefixBytes = encodeEnvelope(prefix);
    old.receive(a.document.store.encodeUpdate());
    // This branch has never received the extension-bearing action.
    old.editor.edit({ local: 'offline', group: 1n }, insertText, {
      nodeId: old.handle(old.nodes()[0]),
      from: 0,
      text: 'OLD',
    });
    const source = 'first\n\n# second',
      nodeId = a.handle(a.nodes()[0]);
    const result = a.editor.edit(
      { local: 'new', group: 2n },
      insertText,
      { nodeId, from: 0, to: 7, text: source },
      { conversion: { nodeId, plan: parseBlocks(source, { provenance: true }).provenance } },
    );
    if (result.status !== 'applied') throw new Error();
    const newBytes = encodeEnvelope(result.envelope);
    a.editor.edit({ local: 'new', group: 3n }, insertText, {
      nodeId: a.handle(a.nodes()[1]),
      from: 6,
      text: '!',
    });
    const snapshot = a.document.store.encodeUpdate();
    await expect(provider.flush()).rejects.toThrow();
    fail = false;
    await provider.retryPersistence();
    await provider.flush();
    expect(compareBytes(a.document.store.encodeUpdate(), snapshot)).toBe(0);
    for (const bytes of [...messages].reverse()) {
      b.receive(bytes);
      b.receive(bytes);
    }
    c.receive(old.document.store.encodeUpdate());
    c.receive(snapshot);
    b.receive(old.document.store.encodeUpdate());
    a.receive(old.document.store.encodeUpdate());
    for (const p of [a, b, c]) {
      expect(p.observe()).toEqual(a.observe());
      const ready = p.document.store.snapshot().ready;
      expect(ready).toHaveLength(4);
      expect(
        p.document.store
          .snapshot()
          .actions.every((a) => a.variants.length === 1 && a.readiness.state === 'ready'),
      ).toBe(true);
      expect(
        compareBytes(
          encodeEnvelope(
            ready.find(
              (a) => a.id.actor === prefix.id.actor && a.id.sequence === prefix.id.sequence,
            )!,
          ),
          prefixBytes,
        ),
      ).toBe(0);
      expect(
        compareBytes(
          encodeEnvelope(
            ready.find(
              (a) => a.id.actor === result.action.actor && a.id.sequence === result.action.sequence,
            )!,
          ),
          newBytes,
        ),
      ).toBe(0);
      const cold = commandReplica(genesis, p.document.store.encodeUpdate());
      try {
        expect(cold.observe()).toEqual(p.observe());
      } finally {
        cold.close();
      }
    }
    const persisted = commandReplica(genesis);
    try {
      for (const bytes of journal) persisted.receive(bytes);
      expect(persisted.document.store.snapshot().ready).toHaveLength(3);
      persisted.receive(old.document.store.encodeUpdate());
      expect(persisted.observe()).toEqual(a.observe());
    } finally {
      persisted.close();
    }
  } finally {
    off();
    fail = false;
    await provider.retryPersistence();
    await provider.close();
    [a, old, b, c].forEach((p) => p.close());
  }
});

test('adding an empty wire field retains a real fork and quarantines descendants', () => {
  const genesis = commandGenesis(),
    a = commandReplica(genesis),
    b = commandReplica(genesis);
  try {
    const nodeId = a.handle(a.nodes()[0]);
    const result = a.editor.edit(
      { local: 'absent', group: 1n },
      insertText,
      { nodeId, from: 0, text: '# ' },
      { promote: nodeId },
    );
    if (result.status !== 'applied') throw new Error();
    a.editor.edit({ local: 'descendant', group: 2n }, insertText, {
      nodeId: a.handle(a.nodes()[0]),
      from: 6,
      text: '!',
    });
    const original = encodeEnvelope(result.envelope);
    const wire = decodeCbor(original) as Record<string, CborValue>;
    const packet = (wire.effects as Record<string, CborValue>[]).find(
      (e) => e.type === 'Interpret',
    )!.packet as Record<string, CborValue>;
    expect(Object.hasOwn(packet, 'effectOrdinals')).toBe(false);
    packet.effectOrdinals = [];
    a.document.store.appendEncoded(encodeCbor(wire));
    b.receive(a.document.store.encodeUpdate());
    for (const p of [a, b]) {
      const snapshot = p.document.store.snapshot();
      expect(snapshot.ready).toEqual([]);
      expect(
        snapshot.actions.every(
          (a) => a.readiness.state === 'quarantined' && a.readiness.reason === 'fork',
        ),
      ).toBe(true);
      const fork = snapshot.actions.find((a) => a.id.sequence === result.action.sequence)!;
      expect(fork.variants).toHaveLength(2);
      const cold = commandReplica(genesis, p.document.store.encodeUpdate());
      try {
        expect(cold.document.store.snapshot()).toEqual(snapshot);
      } finally {
        cold.close();
      }
    }
  } finally {
    a.close();
    b.close();
  }
});
