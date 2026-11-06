import { afterEach, describe, expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { CommandCompiler } from './compiler.js';
import type { OriginPiece } from './draft.js';
import type { ViewNode } from '../projection/types.js';
import { resourceKey } from '../layout/index.js';
import { compareBytes } from '../actions/cbor.js';

afterEach(() => vi.restoreAllMocks());

function identities(node: ViewNode) {
  return node.fragments
    .filter((fragment) => fragment.visible)
    .flatMap(({ range }) =>
      Array.from(
        { length: range.length },
        (_, i) => `${resourceKey(range.tape)}:${range.client}:${range.clock + i}`,
      ),
    );
}

for (const implementation of ['reference', 'materialized'] as const)
  describe(implementation, () => {
    test('text-only multi-fragment replacements preserve Unicode, retained identities and history', () => {
      const p = commandReplica(commandGenesis('ab😀cd\n\nother'), undefined, implementation);
      try {
        const history = p.editor.session('fragments'),
          nodeId = p.handle(p.nodes()[0]);
        expect(history.edit(insertText, { nodeId, from: 2, text: 'X' }).status).toBe('applied');
        expect(history.edit(insertText, { nodeId, from: 6, text: 'Y' }).status).toBe('applied');
        expect(p.nodes()[0].content).toBe('abX😀cYd');
        const before = p.observe(),
          retained = identities(p.nodes()[0]),
          old = p.document.publication.status().publication!,
          bytes = old.native.encodeState();
        const edit = history.edit(
          (ctx) => {
            insertText(ctx, { nodeId, from: 1, to: 2, text: 'é' });
            insertText(ctx, { nodeId, from: 4, to: 7, text: '🙂' });
            return insertText(ctx, { nodeId, from: 0, text: '前' });
          },
          undefined,
          { typing: false },
        );
        expect(edit.status).toBe('applied');
        expect(p.nodes()[0].content).toBe('前aéX🙂Yd');
        const after = identities(p.nodes()[0]);
        expect([after[1], after[4], after[7], after[8]]).toEqual([
          retained[0],
          retained[2],
          retained[6],
          retained[7],
        ]);
        for (const index of [1, 3, 4, 5]) expect(after).not.toContain(retained[index]);
        if (implementation === 'materialized')
          expect(compareBytes(old.native.encodeState(), bytes)).toBe(0);
        expect(old.value.view.root.children[0].content).toBe('abX😀cYd');
        const cold = commandReplica(p.genesis, p.document.store.encodeUpdate());
        try {
          expect(p.observe()).toEqual(cold.observe());
        } finally {
          cold.close();
        }
        expect(history.undo().state).toBe('applied');
        expect(p.markdown()).toBe(before.markdown);
        expect(identities(p.nodes()[0])).toEqual(retained);
        expect(history.redo().state).toBe('applied');
        expect(identities(p.nodes()[0])).toEqual(after);
        expect(p.nodes()[0].content).toBe('前aéX🙂Yd');
      } finally {
        p.close();
      }
    });

    for (const invalid of ['tape', 'client', 'lower-bound', 'upper-bound', 'backward'] as const)
      test(`invalid retained ${invalid} leaves publication, canonical facts and history unchanged`, () => {
        const p = commandReplica(commandGenesis('😀abcd\n\nforeign'), undefined, implementation);
        try {
          const nodeId = p.handle(p.nodes()[0]),
            history = p.editor.session('invalid-fragment'),
            before = p.observe(),
            bytes = p.document.store.encodeUpdate(),
            publication = p.document.publication.status().publication!,
            foreign = p.nodes()[1].fragments.find((fragment) => fragment.visible)!.range.tape;
          const run = CommandCompiler.prototype.run;
          const spy = vi.spyOn(CommandCompiler.prototype, 'run').mockImplementationOnce(function (
            this: CommandCompiler,
          ) {
            const final = [...this.draft.pieces.get(nodeId)!];
            const index = final.findIndex((piece) => piece.type === 'retained');
            const piece = final[index];
            if (piece.type !== 'retained') throw new Error('Expected retained fragment');
            if (invalid === 'backward') {
              const retained = final.filter((piece) => piece.type === 'retained');
              expect(retained.length).toBeGreaterThan(1);
              this.draft.pieces.set(nodeId, retained.toReversed());
            } else {
              const range = { ...piece.range };
              if (invalid === 'tape') {
                expect(resourceKey(foreign)).not.toBe(resourceKey(range.tape));
                range.tape = foreign;
              } else if (invalid === 'client') range.client++;
              else if (invalid === 'lower-bound') {
                expect(range.clock).toBeGreaterThan(0);
                range.clock = 0;
              } else range.length += 1000;
              const replacement: OriginPiece = { ...piece, range };
              final[index] = replacement;
              this.draft.pieces.set(nodeId, final);
            }
            run.call(this);
          });
          expect(() => history.edit(insertText, { nodeId, from: 2, text: 'discard' })).toThrow(
            'Text-only draft lost its retained source order',
          );
          spy.mockRestore();
          if (implementation === 'materialized')
            expect(p.document.publication.status().publication).toBe(publication);
          expect(compareBytes(p.document.store.encodeUpdate(), bytes)).toBe(0);
          expect(p.observe()).toEqual(before);
          expect(history.undo().state).toBe('empty');
          const continued = history.edit(insertText, { nodeId, from: 2, text: 'kept' });
          expect(continued.status).toBe('applied');
          if (continued.status !== 'applied') throw new Error('Expected continued input');
          expect(continued.action.sequence).toBe(1n);
          expect(p.nodes()[0].content).toBe('😀keptabcd');
          expect(history.undo().state).toBe('applied');
          expect(p.markdown()).toBe(before.markdown);
          expect(identities(p.nodes()[0])).toEqual(
            identities(publication.value.view.root.children[0]),
          );
        } finally {
          p.close();
        }
      });
  });
