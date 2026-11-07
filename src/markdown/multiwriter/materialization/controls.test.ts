import { expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { compareBytes } from '../actions/cbor.js';
import { NativeTapeCache } from '../text/cache.js';
import * as projector from '../projection/project.js';

function diagnostics(p: CommandReplica) {
  if (!('projectionDiagnostics' in p.document)) throw new Error();
  return p.document.projectionDiagnostics();
}
function applied(result: ReturnType<CommandReplica['editor']['edit']>) {
  if (result.status !== 'applied') throw new Error('Expected applied command');
  return result;
}
function coldEqual(p: CommandReplica) {
  const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'materialized');
  try {
    expect(cold.observe()).toEqual(p.observe());
  } finally {
    cold.close();
  }
}

for (const size of [10, 150])
  test(`text replacement undo/redo updates one flow among ${size} paragraphs without full projection`, () => {
    const p = commandReplica(
        commandGenesis(Array.from({ length: size }, () => 'abc😀def').join('\n\n')),
        undefined,
        'materialized',
      ),
      oracle = createMaterializationOracle();
    const h = p.editor.session('text-controls'),
      nodeId = p.handle(p.nodes()[0]);
    try {
      applied(
        h.edit(
          insertText,
          { nodeId, from: 1, to: 5, text: 'XY' },
          {
            selectionBefore: {
              anchor: { nodeId, offset: 1, affinity: 'right' },
              focus: { nodeId, offset: 5, affinity: 'right' },
            },
          },
        ),
      );
      const before = p.document.publication.status().publication!,
        native = before.native.encodeState(),
        tail = before.value.view.root.children[1],
        counts = diagnostics(p);
      const full = vi.spyOn(projector, 'projectWithActivity'),
        author = vi.spyOn(projector, 'projectMarkdown'),
        reads = vi.spyOn(NativeTapeCache.prototype, 'snapshotSteps');
      try {
        const undo = h.undo();
        expect(undo.state).toBe('applied');
        expect(p.nodes()[0].content).toBe('abc😀def');
        if (undo.state === 'applied')
          expect(undo.restoration).toMatchObject({
            state: 'exact',
            anchor: { offset: 1 },
            focus: { offset: 5 },
          });
        expect(h.redo().state).toBe('applied');
        expect(p.nodes()[0].content).toBe('aXYdef');
        expect(full).not.toHaveBeenCalled();
        expect(author).not.toHaveBeenCalled();
        expect(reads).not.toHaveBeenCalled();
      } finally {
        full.mockRestore();
        author.mockRestore();
        reads.mockRestore();
      }
      expect(diagnostics(p).localTextControls - counts.localTextControls).toBe(2);
      expect(diagnostics(p).projectionRecordsReplaced - counts.projectionRecordsReplaced).toBe(4);
      expect(diagnostics(p).ownership.nativeTapeReads).toBe(counts.ownership.nativeTapeReads);
      expect(p.nodes()[1]).toBe(tail);
      expect(before.value.view.root.children[0].content).toBe('aXYdef');
      expect(compareBytes(before.native.encodeState(), native)).toBe(0);
      expect(
        compareBytes(p.document.publication.status().publication!.native.encodeState(), native),
      ).toBe(0);
      oracle.check(p.document, p.genesis);
      coldEqual(p);
    } finally {
      oracle.destroy();
      p.close();
    }
  }, 60000);

test('controls toggle complete multi-action typing groups while preserving exact overlapping peer tags', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized'),
    peer = commandReplica(p.genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  const h = p.editor.session('typing'),
    nodeId = p.handle(p.nodes()[0]);
  try {
    applied(
      h.edit(
        insertText,
        { nodeId, from: 1, text: 'X' },
        {
          typing: true,
          selectionBefore: {
            anchor: { nodeId, offset: 1, affinity: 'right' },
            focus: { nodeId, offset: 1, affinity: 'right' },
          },
        },
      ),
    );
    applied(
      h.edit(
        insertText,
        { nodeId, from: 2, text: 'Y' },
        {
          typing: true,
          selectionBefore: {
            anchor: { nodeId, offset: 2, affinity: 'right' },
            focus: { nodeId, offset: 2, affinity: 'right' },
          },
        },
      ),
    );
    expect(h.groups().undo[0].actions).toHaveLength(2);
    const deletion = applied(
      peer.editor.edit({ local: 'peer', group: 1n }, insertText, {
        nodeId: peer.handle(peer.nodes()[0]),
        from: 1,
        to: 4,
        text: '',
      }),
    );
    p.receive(peer.document.store.encodeUpdate());
    expect(p.nodes()[0].content).toBe('aXYef');
    const full = vi.spyOn(projector, 'projectWithActivity');
    try {
      expect(h.undo().state).toBe('applied');
      expect(p.nodes()[0].content).toBe('aef');
      expect(h.redo().state).toBe('applied');
      expect(p.nodes()[0].content).toBe('aXYef');
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
    }
    oracle.check(p.document, p.genesis);
    peer.receive(p.document.store.encodeUpdate());
    const undo = control(peer, deletion, false);
    p.receive(peer.document.store.encodeUpdate());
    expect(p.nodes()[0].content).toBe('aXYbcdef');
    oracle.check(p.document, p.genesis);
    control(peer, deletion, true, undo);
    p.receive(peer.document.store.encodeUpdate());
    expect(p.nodes()[0].content).toBe('aXYef');
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});

test('a structural target uses local projection after text-only controls', () => {
  const p = commandReplica(commandGenesis('abc\n\ntail'), undefined, 'materialized'),
    oracle = createMaterializationOracle();
  const h = p.editor.session('mixed'),
    nodeId = p.handle(p.nodes()[0]);
  try {
    applied(h.edit(insertText, { nodeId, from: 1, text: 'X' }));
    expect(h.undo().state).toBe('applied');
    expect(h.redo().state).toBe('applied');
    applied(h.edit(insertParagraph, { nodeId, from: 1 }));
    const full = vi.spyOn(projector, 'projectWithActivity');
    try {
      expect(h.undo().state).toBe('applied');
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
    }
    expect(p.nodes().map((n) => n.content)).toEqual(['aXbc', 'tail']);
    oracle.check(p.document, p.genesis);
    expect(h.redo().state).toBe('applied');
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
});
