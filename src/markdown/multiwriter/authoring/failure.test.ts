import { describe, expect, test, vi } from 'vitest';
import {
  commandGenesis,
  commandReplica as openCommandReplica,
} from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { CommandCompiler, ConversionDeclined } from './compiler.js';
import { RetainedEditError } from './index.js';
import { DirectionalActionProvider } from '../providers/adapter.js';
import { parseBlocks } from '../../block-parser/api.js';
import { prepareParserConversion } from '../projection/parser-plan.js';

for (const implementation of ['reference', 'materialized'] as const)
  describe(implementation, () => {
    const commandReplica: typeof openCommandReplica = (genesis, bytes) =>
      openCommandReplica(genesis, bytes, implementation);

    const session = { local: 'failure', group: 1n };
    for (const point of ['input', 'binding', 'certification', 'append'] as const)
      test(`preappend ${point} failure leaves facts/heads/native unchanged`, () => {
        const p = commandReplica(commandGenesis()),
          before = p.observe(),
          bytes = p.document.store.encodeUpdate(),
          client = p.editor.nativeClientId;
        let restore = () => {};
        try {
          if (point === 'binding') {
            const spy = vi.spyOn(CommandCompiler.prototype, 'bind').mockImplementationOnce(() => {
              throw new Error('binding failed');
            });
            restore = () => spy.mockRestore();
          }
          if (point === 'certification') {
            const spy = vi.spyOn(p.document, 'certifyLocal').mockImplementationOnce(() => {
              throw new Error('certification failed');
            });
            restore = () => spy.mockRestore();
          }
          if (point === 'append') {
            const spy = vi.spyOn(p.document.store, 'append').mockImplementationOnce(() => {
              throw new Error('append failed');
            });
            restore = () => spy.mockRestore();
          }
          const nodeId = p.handle(p.nodes()[0]!);
          expect(() =>
            p.editor.edit(session, insertText, {
              nodeId,
              from: point === 'input' ? 999 : 2,
              text: 'discard',
            }),
          ).toThrow();
          expect(p.observe()).toEqual(before);
          expect(p.document.store.encodeUpdate()).toEqual(bytes);
          if (point !== 'input') expect(p.editor.nativeClientId).not.toBe(client);
          restore();
          const result = p.editor.edit(session, insertText, { nodeId, from: 2, text: 'kept' });
          expect(result.status).toBe('applied');
          if (result.status === 'applied') expect(result.action.sequence).toBe(1n);
          expect(p.markdown()).toBe('abkeptcdef\n');
        } finally {
          restore();
          p.close();
        }
      });
    for (const point of ['append-observer', 'projection'] as const)
      test(`postappend ${point} failure retains the action and recovers`, () => {
        const p = commandReplica(commandGenesis());
        let restore = () => {};
        try {
          if (point === 'append-observer') {
            const append = p.document.store.append.bind(p.document.store);
            const spy = vi.spyOn(p.document.store, 'append').mockImplementationOnce((a) => {
              append(a);
              throw new Error('observer failed after append');
            });
            restore = () => spy.mockRestore();
          } else {
            const spy = vi.spyOn(p.document.publication, 'refresh').mockImplementationOnce(() => {
              throw new Error('projection failed');
            });
            restore = () => spy.mockRestore();
          }
          expect(() =>
            p.editor.edit(session, insertText, {
              nodeId: p.handle(p.nodes()[0]!),
              from: 2,
              text: 'kept',
            }),
          ).toThrow(RetainedEditError);
          restore();
          expect(p.document.store.snapshot().ready).toHaveLength(1);
          expect(p.document.publication.status()).toMatchObject({ stale: true, canAuthor: false });
          expect(() =>
            p.editor.edit(session, insertText, {
              nodeId: 'construction:1',
              from: 0,
              text: 'blocked',
            }),
          ).toThrow(/stale/);
          p.editor.refresh();
          expect(p.markdown()).toBe('abkeptcdef\n');
          const result = p.editor.edit(session, insertText, {
            nodeId: p.handle(p.nodes()[0]!),
            from: 0,
            text: 'next',
          });
          if (result.status !== 'applied') throw new Error('Next edit failed');
          expect(result.action.sequence).toBe(2n);
          expect(p.document.store.snapshot().ready).toHaveLength(2);
        } finally {
          restore();
          p.close();
        }
      });
    test('provider persistence retry preserves the exact compiler action without duplicate authoring', async () => {
      const p = commandReplica(commandGenesis()),
        journal: Uint8Array[] = [];
      let failed = true;
      const provider = await DirectionalActionProvider.open({
        store: p.document.store,
        mode: 'disconnected',
        journal: {
          read: async () => [],
          append: async (bytes) => {
            if (failed) throw new Error('disk failed');
            journal.push(bytes.slice());
          },
          close() {},
        },
      });
      try {
        p.editor.edit(session, insertParagraph, { nodeId: p.handle(p.nodes()[0]!), from: 3 });
        const publication = provider.capturePublication(),
          bytes = p.document.store.encodeUpdate();
        await expect(provider.flush()).rejects.toThrow();
        expect(publication.status()).toEqual({ applied: true, persisted: false });
        failed = false;
        await provider.retryPersistence();
        await provider.flush();
        expect(publication.status()).toEqual({ applied: true, persisted: true });
        expect(p.document.store.encodeUpdate()).toEqual(bytes);
        expect(p.document.store.snapshot().ready).toHaveLength(1);
        expect(journal.length).toBeGreaterThan(0);
      } finally {
        failed = false;
        await provider.retryPersistence();
        await provider.close();
        p.close();
      }
    });
    test('optional multi-inline conversion publishes complete output, while operational parser errors propagate', () => {
      const p = commandReplica(commandGenesis());
      try {
        const nodeId = p.handle(p.nodes()[0]!);
        p.editor.edit(
          session,
          insertText,
          { nodeId, from: 0, to: 6, text: 'one\n\ntwo' },
          { promote: nodeId },
        );
        expect(p.nodes().map((n) => n.content)).toEqual(['one', 'two']);
        const plan = parseBlocks('# title', { provenance: true }).provenance;
        const bad = new Proxy(plan, {
          get(target, key, receiver) {
            if (key === 'output') throw new Error('operational getter');
            return Reflect.get(target, key, receiver);
          },
        });
        expect(() =>
          prepareParserConversion({
            source: p.nodes()[0]!.origin.representative,
            text: '',
            fragments: [],
            plan: bad,
            bindings: [],
          }),
        ).toThrow('operational getter');
      } finally {
        p.close();
      }
    });
    test('recursive calls are rejected before any facts are appended', () => {
      const p = commandReplica(commandGenesis()),
        bytes = p.document.store.encodeUpdate();
      try {
        expect(() =>
          p.editor.edit(
            session,
            () => {
              p.editor.edit(session, () => ({ status: 'handled' }), undefined);
              return { status: 'handled' };
            },
            undefined,
          ),
        ).toThrow(/Recursive/);
        expect(p.document.store.encodeUpdate()).toEqual(bytes);
      } finally {
        p.close();
      }
    });

    test('an invalid optional promotion keeps the literal edit and omits the complete packet', () => {
      const p = commandReplica(commandGenesis());
      const spy = vi.spyOn(CommandCompiler.prototype, 'interpret').mockImplementationOnce(() => {
        throw new ConversionDeclined('invalid-conversion', 'invalid parser plan');
      });
      try {
        const nodeId = p.handle(p.nodes()[0]);
        const result = p.editor.edit(
          session,
          insertText,
          { nodeId, from: 0, text: '# ' },
          { promote: nodeId },
        );
        expect(result.status).toBe('applied');
        expect(p.nodes().map((n) => n.content)).toEqual(['# abcdef']);
        if (result.status !== 'applied') throw new Error();
        expect(result.envelope.effects.some((e) => e.type === 'Interpret')).toBe(false);
      } finally {
        spy.mockRestore();
        p.close();
      }
    });
  });
