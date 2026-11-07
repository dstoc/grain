import { expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertText, insertParagraph } from '../authoring/index.js';
import { captureFootprint, classifyFootprints } from './scope.js';
import { capturePoint, resolveSelection } from './selection.js';
import { OwnershipResult } from '../ownership/ownership.js';
import { compareBytes } from '../actions/cbor.js';

for (const implementation of ['reference', 'materialized'] as const)
  test(`history classifies retained cells and restores native selection without exporting run inventories: ${implementation}`, () => {
    const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, implementation),
      h = p.editor.session('run-reads');
    try {
      for (let i = 0; i < 20; i++)
        expect(
          h.edit(
            insertText,
            { nodeId: p.handle(p.nodes()[0]), from: 1, to: 2, text: i % 2 ? 'Y' : 'X' },
            { typing: false },
          ).status,
        ).toBe('applied');
      const before = p.document.publication.status().publication!,
        node = p.nodes()[0],
        nodeId = p.handle(node),
        point = capturePoint(before, node, 2, 'right', before.value.view.root),
        edit = h.edit(
          insertParagraph,
          { nodeId, from: 3 },
          {
            typing: false,
            selectionBefore: {
              anchor: { nodeId, offset: 3, affinity: 'right' },
              focus: { nodeId, offset: 3, affinity: 'right' },
            },
          },
        );
      if (edit.status !== 'applied') throw new Error('Expected split');
      const after = p.document.publication.status().publication!,
        canonical = p.document.store.encodeUpdate(),
        native = after.native.encodeState(),
        inventories = vi.spyOn(OwnershipResult.prototype, 'runLayouts', 'get');
      try {
        const footprint = captureFootprint(edit.envelope, before, after.native);
        expect(classifyFootprints(after, [footprint], after.value.view.root.origin)).toBe('inside');
        expect(resolveSelection(after, { anchor: point, focus: point })).toMatchObject({
          state: 'exact',
          focus: { offset: 2 },
        });
        expect(inventories).not.toHaveBeenCalled();
      } finally {
        inventories.mockRestore();
      }
      expect(compareBytes(p.document.store.encodeUpdate(), canonical)).toBe(0);
      expect(compareBytes(after.native.encodeState(), native)).toBe(0);
      expect(h.undo({ scope: after.value.view.root.origin })).toMatchObject({
        state: 'applied',
        restoration: { state: 'exact', focus: { offset: 3 } },
      });
      expect(h.redo({ scope: p.view().root.origin }).state).toBe('applied');
      expect(p.nodes().map((n) => n.content)).toEqual(['aYc', 'def', 'tail']);
      const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'reference');
      try {
        expect(p.observe()).toEqual(cold.observe());
      } finally {
        cold.close();
      }
    } finally {
      p.close();
    }
  });
