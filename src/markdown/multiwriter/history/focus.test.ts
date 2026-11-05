import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../authoring/index.js';
import { resolveSelection } from './selection.js';

for (const implementation of ['reference', 'materialized'] as const)
  test(`managed ${implementation} focus retains its author gap after a reentrant prepend before a surrogate pair`, () => {
    const genesis = commandGenesis('abcdef');
    const local = commandReplica(genesis, undefined, implementation);
    const peer = commandReplica(genesis, undefined, implementation);
    const history = local.editor.session('unicode');
    const nodeId = local.handle(local.nodes()[0]);
    let injected = false;
    const off = local.document.store.onUpdate((bytes) => {
      if (injected) return;
      injected = true;
      peer.receive(bytes);
      expect(
        peer.editor.edit({ local: 'peer', group: 1n }, insertText, {
          nodeId: peer.handle(peer.nodes()[0]),
          from: 0,
          text: 'P',
        }).status,
      ).toBe('applied');
      local.document.store.applyUpdate(peer.document.store.encodeUpdate());
    });
    try {
      const edit = history.edit(
        insertText,
        { nodeId, from: 1, to: 4, text: '😀' },
        {
          selectionBefore: {
            anchor: { nodeId, offset: 1, affinity: 'right' },
            focus: { nodeId, offset: 4, affinity: 'right' },
          },
        },
      );
      off();
      expect(edit.status).toBe('applied');
      if (edit.status !== 'applied' || !edit.selectionAfter)
        throw new Error('Missing staged selection');
      expect(local.nodes()[0].content).toBe('Pa😀ef');
      const publication = local.document.publication.status().publication!;
      expect(resolveSelection(publication, edit.selectionAfter)).toMatchObject({
        state: 'exact',
        anchor: { offset: 4 },
        focus: { offset: 4 },
      });
      expect(edit.focus).toEqual({
        address: edit.selectionAfter.focus.address,
        native: edit.selectionAfter.focus.native,
        side: edit.selectionAfter.focus.side,
      });
      const undo = history.undo();
      expect(undo.state).toBe('applied');
      if (undo.state === 'applied')
        expect(undo.restoration).toMatchObject({
          state: 'exact',
          anchor: { offset: 2 },
          focus: { offset: 5 },
        });
      expect(local.nodes()[0].content).toBe('Pabcdef');
      expect(history.redo().state).toBe('applied');
      expect(local.nodes()[0].content).toBe('Pa😀ef');
    } finally {
      off();
      local.close();
      peer.close();
    }
  });
