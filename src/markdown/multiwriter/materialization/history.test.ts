import { expect, test, vi } from 'vitest';
import { ConstructionTreeDraft } from '../../semantic/construction-tree.js';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertText, RetainedEditError } from '../authoring/index.js';

for (const phase of ['edit', 'control'] as const)
  test(`materialized history recovers after a real ${phase} update observer failure`, () => {
    const genesis = commandGenesis('abc'),
      peer = commandReplica(genesis, undefined, 'materialized');
    const oracle = createMaterializationOracle(),
      history = peer.editor.session('observer');
    const type = (text: string, offset: number) => {
      const nodeId = peer.handle(peer.nodes()[0]);
      return history.edit(
        insertText,
        { nodeId, from: offset, text },
        {
          typing: true,
          selectionBefore: {
            anchor: { nodeId, offset, affinity: 'right' },
            focus: { nodeId, offset, affinity: 'right' },
          },
        },
      );
    };
    try {
      expect(type('x', 3).status).toBe('applied');
      if (phase === 'control') expect(type('y', 4).status).toBe('applied');
      const remove = peer.document.store.onUpdate(() => {
        throw new Error('observer');
      });
      try {
        expect(() => (phase === 'edit' ? type('y', 4) : history.undo())).toThrow(RetainedEditError);
      } finally {
        remove();
      }
      const retained = peer.document.store.snapshot();
      expect(retained.ready).toHaveLength(phase === 'edit' ? 2 : 3);
      expect(history.groups()[phase === 'edit' ? 'undo' : 'redo'][0].actions).toHaveLength(2);
      peer.editor.refresh();
      oracle.check(peer.document, genesis);
      expect(peer.document.store.snapshot()).toEqual(retained);
      expect(peer.nodes()[0].content).toBe(phase === 'edit' ? 'abcxy' : 'abc');
      expect((phase === 'edit' ? history.undo() : history.redo()).state).toBe('applied');
      oracle.check(peer.document, genesis);
      expect(peer.nodes()[0].content).toBe(phase === 'edit' ? 'abc' : 'abcxy');
      expect((phase === 'edit' ? history.redo() : history.undo()).state).toBe('applied');
      oracle.check(peer.document, genesis);
      expect(type('!', 0).status).toBe('applied');
      oracle.check(peer.document, genesis);
      expect(peer.nodes()[0].content).toBe(phase === 'edit' ? '!abcxy' : '!abc');
    } finally {
      oracle.destroy();
      peer.close();
    }
  });

test('managed literal input with a selection keeps the command overlay through the history driver', () => {
  const peer = commandReplica(commandGenesis('abcdef'), undefined, 'materialized');
  const adopt = vi.spyOn(ConstructionTreeDraft.prototype, 'adopt');
  try {
    const h = peer.editor.session('overlay'),
      nodeId = peer.handle(peer.nodes()[0]);
    const result = h.edit(
      insertText,
      { nodeId, from: 2, text: 'X' },
      {
        typing: true,
        selectionBefore: {
          anchor: { nodeId, offset: 2, affinity: 'right' },
          focus: { nodeId, offset: 2, affinity: 'right' },
        },
      },
    );
    expect(result.status).toBe('applied');
    expect(adopt).not.toHaveBeenCalled();
    expect(h.status()).toMatchObject({ undo: 1, redo: 0 });
    const undo = h.undo();
    expect(undo.state).toBe('applied');
    if (undo.state === 'applied')
      expect(undo.restoration).toMatchObject({
        state: 'exact',
        anchor: { offset: 2 },
        focus: { offset: 2 },
      });
    expect(peer.nodes()[0].content).toBe('abcdef');
    expect(h.redo().state).toBe('applied');
    expect(peer.nodes()[0].content).toBe('abXcdef');
  } finally {
    adopt.mockRestore();
    peer.close();
  }
});
