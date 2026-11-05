import { expect, test, vi } from 'vitest';
import { ConstructionTreeDraft } from '../../semantic/construction-tree.js';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import * as projection from '../projection/project.js';
import { compareBytes } from '../actions/cbor.js';
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

test('managed literal staging avoids full projection and captures before a reentrant peer prepend', () => {
  const genesis = commandGenesis('abcdef');
  const a = commandReplica(genesis, undefined, 'materialized'),
    b = commandReplica(genesis, undefined, 'materialized');
  const h = a.editor.session('staged'),
    nodeId = a.handle(a.nodes()[0]);
  let injected = false;
  const stop = a.document.store.onUpdate((bytes) => {
    if (injected) return;
    injected = true;
    b.receive(bytes);
    expect(
      b.editor.edit({ local: 'peer', group: 1n }, insertText, {
        nodeId: b.handle(b.nodes()[0]),
        from: 0,
        text: 'P',
      }).status,
    ).toBe('applied');
    a.document.store.applyUpdate(b.document.store.encodeUpdate());
  });
  const full = vi.spyOn(projection, 'projectMarkdown');
  try {
    expect(
      h.edit(
        insertText,
        { nodeId, from: 2, text: 'X' },
        {
          selectionBefore: {
            anchor: { nodeId, offset: 2, affinity: 'right' },
            focus: { nodeId, offset: 2, affinity: 'right' },
          },
        },
      ).status,
    ).toBe('applied');
    expect(full).not.toHaveBeenCalled();
    full.mockRestore();
    stop();
    expect(a.nodes()[0].content).toBe('PabXcdef');
    const undo = h.undo();
    expect(undo.state).toBe('applied');
    if (undo.state === 'applied')
      expect(undo.restoration).toMatchObject({
        state: 'exact',
        anchor: { offset: 3 },
        focus: { offset: 3 },
      });
    const redo = h.redo();
    expect(redo.state).toBe('applied');
    if (redo.state === 'applied')
      expect(redo.restoration).toMatchObject({
        state: 'exact',
        anchor: { offset: 4 },
        focus: { offset: 4 },
      });
    expect(a.nodes()[0].content).toBe('PabXcdef');
    const oracle = createMaterializationOracle();
    try {
      oracle.check(a.document, genesis);
    } finally {
      oracle.destroy();
    }
  } finally {
    full.mockRestore();
    stop();
    a.close();
    b.close();
  }
});

test('rejected managed staging leaves publication, history and canonical facts unchanged', () => {
  const p = commandReplica(commandGenesis('abcdef'), undefined, 'materialized'),
    h = p.editor.session('rejection');
  const before = p.document.publication.status().publication!,
    bytes = p.document.store.encodeUpdate(),
    nodeId = p.handle(p.nodes()[0]);
  const reject = vi.spyOn(p.document, 'certifyLocal').mockImplementationOnce(() => {
    throw new Error('candidate rejected');
  });
  try {
    expect(() => h.edit(insertText, { nodeId, from: 2, text: 'X' })).toThrow('candidate rejected');
    expect(p.document.publication.status().publication).toBe(before);
    expect(compareBytes(p.document.store.encodeUpdate(), bytes)).toBe(0);
    expect(h.status()).toMatchObject({ undo: 0, redo: 0 });
    reject.mockRestore();
    expect(h.edit(insertText, { nodeId, from: 2, text: 'Y' }).status).toBe('applied');
    expect(p.nodes()[0].content).toBe('abYcdef');
    expect(h.undo().state).toBe('applied');
    expect(p.nodes()[0].content).toBe('abcdef');
  } finally {
    reject.mockRestore();
    p.close();
  }
});
