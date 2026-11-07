import { expect, test, vi } from 'vitest';
import { CellIndex, cellKey } from '../ownership/cells.js';
import { NativeTapeCache } from '../text/cache.js';
import { resource } from '../actions/test-fixtures.js';
import type { NativeInsertion, NativeBody } from '../text/types.js';
import { finish } from '../ingest/work.js';
import { MaterializedCells } from './cells.js';
import { MaterializedNative } from './native.js';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';

const tape = resource('tape', 0),
  start = resource('marker', 0),
  end = resource('marker', 1);
function prepare(
  cache: NativeTapeCache,
  key: string,
  operations: readonly NativeInsertion[],
): NativeBody {
  const value = cache.prepare(key, operations);
  value.commit();
  return value.body;
}

test('marker-stable cell roots read current fragments and scalar UTF-16 owners without a snapshot', () => {
  const writer = new NativeTapeCache(),
    reader = new MaterializedNative(100000);
  try {
    const body = prepare(writer, 'G', [
      { type: 'createTape', tape, start, end },
      { type: 'marker', tape, index: 1, marker: resource('marker', 2), affinity: 'left' },
      { type: 'text', tape, index: 2, text: 'a😀' },
      { type: 'marker', tape, index: 5, marker: resource('marker', 3), affinity: 'right' },
      { type: 'text', tape, index: 6, text: 'bc' },
    ]);
    finish(reader.apply('G', body));
    const held = new MaterializedCells([writer.snapshot(tape)], undefined, reader.view()),
      old = held.cells.map((cell) => ({ range: cell.range, fragments: cell.fragments }));
    const update = prepare(writer, 'A', [{ type: 'text', tape, index: 3, text: 'X😀' }]);
    finish(reader.apply('A', update));
    const snapshot = writer.snapshot(tape),
      reference = new CellIndex([snapshot]),
      native = reader.view();
    const snapshots = vi.spyOn(native, 'snapshot').mockImplementation(() => {
      throw new Error('Cell reuse exported a tape');
    });
    try {
      const current = held.withNative(native, [tape]);
      expect(
        current.cells.map((cell) => ({ range: cell.range, fragments: cell.fragments })),
      ).toEqual(reference.cells);
      for (const part of snapshot.parts) {
        if (part.type === 'marker') {
          expect(current.position(tape, part.marker)).toBe(part.index);
          expect(() => current.locateToken(tape, part.native)).toThrow();
        } else {
          for (let i = 0; i < part.text.length; i++) {
            const id = { ...part.native, clock: part.native.clock + i };
            expect(current.locateToken(tape, id)).toEqual(reference.locateToken(tape, id));
          }
          const range = { tape, ...part.native, length: part.text.length };
          expect(current.token(range)).toEqual(reference.token(range));
        }
      }
      const inserted = update.nativeManifest.find((entry) => entry.type === 'text')!;
      if (inserted.type !== 'text') throw new Error();
      expect(() => current.token({ tape, ...inserted.native, length: 2 })).toThrow(/surrogate/);
      const left = reference.adjacent(start, 'right'),
        right = reference.adjacent(end, 'left');
      const tapes = vi.spyOn(CellIndex.prototype, 'tape').mockImplementation(() => {
        throw new Error('Home validation enumerated a tape');
      });
      try {
        expect(current.adjacent(start, 'right')).toEqual(left);
        expect(current.adjacent(end, 'left')).toEqual(right);
      } finally {
        tapes.mockRestore();
      }
      expect(held.cells.map((cell) => ({ range: cell.range, fragments: cell.fragments }))).toEqual(
        old,
      );
    } finally {
      snapshots.mockRestore();
    }
  } finally {
    reader.destroy();
    writer.destroy();
  }
});

test('remote text publication reuses cell topology and preserves held reads through local replacement', () => {
  const genesis = commandGenesis('abc😀def\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    const held = p.document.publication.status().publication!,
      old = held.value.ownership.assignments;
    if (!('ownershipDiagnostics' in p.document)) throw new Error();
    const before = p.document.ownershipDiagnostics();
    expect(
      peer.editor.edit({ local: 'peer', group: 1n }, insertText, {
        nodeId: peer.handle(peer.nodes()[0]),
        from: 1,
        text: '😀',
      }).status,
    ).toBe('applied');
    p.receive(peer.document.store.encodeUpdate());
    expect(p.document.ownershipDiagnostics().cellTapesIndexed).toBe(before.cellTapesIndexed);
    expect(p.document.ownershipDiagnostics().nativeTapeReads).toBe(before.nativeTapeReads);
    oracle.check(p.document, genesis);
    const history = p.editor.session('replace');
    expect(
      history.edit(insertText, { nodeId: p.handle(p.nodes()[0]), from: 1, to: 3, text: 'X' })
        .status,
    ).toBe('applied');
    oracle.check(p.document, genesis);
    expect(history.undo().state).toBe('applied');
    oracle.check(p.document, genesis);
    expect(history.redo().state).toBe('applied');
    oracle.check(p.document, genesis);
    expect(held.value.ownership.assignments).toEqual(old);
    expect(held.value.view.root.children[0].content).toBe('abc😀def');
    expect(new Set(old.map((assignment) => cellKey(assignment.cell))).size).toBe(old.length);
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});

test('structural command staging retains current text from other reused native tapes', () => {
  const genesis = commandGenesis('abc\n\nxyz\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    expect(
      peer.editor.edit({ local: 'peer', group: 1n }, insertText, {
        nodeId: peer.handle(peer.nodes()[0]),
        from: 1,
        text: '😀',
      }).status,
    ).toBe('applied');
    p.receive(peer.document.store.encodeUpdate());
    const held = p.document.publication.status().publication!;
    const history = p.editor.session('structural');
    expect(history.edit(insertParagraph, { nodeId: p.handle(p.nodes()[1]), from: 1 }).status).toBe(
      'applied',
    );
    expect(p.nodes().map((node) => node.content)).toEqual(['a😀bc', 'x', 'yz', 'tail']);
    oracle.check(p.document, genesis);
    expect(history.undo().state).toBe('applied');
    oracle.check(p.document, genesis);
    expect(history.redo().state).toBe('applied');
    oracle.check(p.document, genesis);
    expect(held.value.view.root.children[0].content).toBe('a😀bc');
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});
