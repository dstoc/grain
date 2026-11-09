import { describe, expect, test } from 'vitest';
import {
  commandGenesis,
  commandReplica as openCommandReplica,
} from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { DirectionalActionProvider } from '../providers/adapter.js';

for (const implementation of ['reference', 'materialized'] as const)
  describe(implementation, () => {
    const commandReplica: typeof openCommandReplica = (genesis, bytes) =>
      openCommandReplica(genesis, bytes, implementation);

    for (const mode of ['disconnected', 'inbound-only'] as const)
      test(`headless commands persist while ${mode} defers sending; enabling send preserves the live chain`, async () => {
        const genesis = commandGenesis(),
          a = commandReplica(genesis),
          b = commandReplica(genesis),
          c = commandReplica(genesis),
          journal: Uint8Array[] = [];
        const provider = await DirectionalActionProvider.open({
          store: a.document.store,
          mode,
          journal: {
            read: async () => [],
            append: async (bytes) => {
              journal.push(bytes.slice());
            },
            close() {},
          },
        });
        const sends: Uint8Array[] = [];
        const off = provider.attachPeer('B', {
          acknowledgments: false,
          send: async (message) => {
            sends.push(message.update.slice());
            b.receive(message.update);
          },
        });
        try {
          b.editor.edit({ local: 'B', group: 1n }, insertText, {
            nodeId: b.handle(b.nodes()[0]),
            from: 0,
            text: 'remote',
          });
          const received = provider.receive('peer', b.document.store.encodeUpdate());
          expect(received).toBe(mode === 'inbound-only');
          a.editor.refresh();
          const local = a.editor.edit({ local: 'A', group: 1n }, insertText, {
            nodeId: a.handle(a.nodes()[0]),
            from: a.nodes()[0].content.length,
            text: 'local',
          });
          const split = a.editor.edit({ local: 'A', group: 2n }, insertParagraph, {
            nodeId: a.handle(a.nodes()[0]),
            from: 3,
          });
          expect(local.status).toBe('applied');
          expect(split.status).toBe('applied');
          await provider.flush();
          expect(sends).toHaveLength(0);
          expect(journal.length).toBeGreaterThan(0);
          expect(b.document.store.snapshot().ready).toHaveLength(1);
          const ids = a.document.store.snapshot().ready.map((a) => a.id),
            client = a.editor.nativeClientId;
          provider.setMode('bidirectional');
          await provider.publish();
          provider.receive('catch-up', b.document.store.encodeUpdate());
          a.editor.refresh();
          await provider.publish();
          c.receive(a.document.store.encodeUpdate());
          expect(a.observe()).toEqual(b.observe());
          expect(a.observe()).toEqual(c.observe());
          expect(a.editor.nativeClientId).toBe(client);
          expect(a.document.store.snapshot().ready.map((a) => a.id)).toEqual(
            expect.arrayContaining(ids),
          );
          const next = a.editor.edit({ local: 'A', group: 3n }, insertText, {
            nodeId: a.handle(a.nodes()[1]),
            from: 0,
            text: 'next',
          });
          if (local.status !== 'applied' || next.status !== 'applied') throw new Error();
          expect(next.action).toEqual({ ...local.action, sequence: local.action.sequence + 2n });
        } finally {
          off();
          await provider.close();
          [a, b, c].forEach((p) => p.close());
        }
      });

    test('an unrelated missing remote dependency does not block the ready local author past', () => {
      const genesis = commandGenesis(),
        a = commandReplica(genesis),
        b = commandReplica(genesis);
      const updates: Uint8Array[] = [];
      const off = b.document.store.onUpdate((bytes) => updates.push(bytes.slice()));
      try {
        for (const text of ['B1', 'B2'])
          b.editor.edit({ local: 'B', group: 1n }, insertText, {
            nodeId: b.handle(b.nodes()[0]),
            from: 0,
            text,
          });
        a.receive(updates[1]);
        expect(a.document.store.snapshot().ready).toHaveLength(0);
        const edit = a.editor.edit({ local: 'A', group: 1n }, insertText, {
          nodeId: a.handle(a.nodes()[0]),
          from: 0,
          text: 'A',
        });
        expect(edit.status).toBe('applied');
        expect(a.markdown()).toBe('Aabcdef\n');
        a.receive(updates[0]);
        b.receive(a.document.store.encodeUpdate());
        expect(a.document.store.snapshot().ready).toHaveLength(3);
        expect(a.observe()).toEqual(b.observe());
      } finally {
        off();
        a.close();
        b.close();
      }
    });
  });
