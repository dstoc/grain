import { expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { compareBytes } from '../actions/cbor.js';
import * as projector from '../projection/project.js';
import { MaterializedPublication } from './publication.js';
import { NativeTapeCache } from '../text/cache.js';

const open = (text = 'abc\n\ntail') => {
  const nativeDecodeOperations = text.length > 1000 ? 10_000_000 : undefined;
  return commandReplica(commandGenesis(text, nativeDecodeOperations), undefined, 'materialized', {
    nativeDecodeOperations,
  });
};
function diagnostics(p: ReturnType<typeof open>) {
  if (!('projectionDiagnostics' in p.document)) throw new Error('Expected materialized projection');
  return p.document.projectionDiagnostics();
}
function type(p: ReturnType<typeof open>, group: bigint, text = 'X', from = 1) {
  const result = p.editor.edit({ local: 'coupled', group }, insertText, {
    nodeId: p.handle(p.nodes()[0]),
    from,
    text,
  });
  if (result.status !== 'applied') throw new Error('Expected applied edit');
  return result;
}

test('text append preserves unaffected view/address/handle records and old native reads', () => {
  const p = open(),
    oracle = createMaterializationOracle();
  try {
    const before = p.document.publication.status().publication!,
      first = before.value.view.root.children[0],
      tail = before.value.view.root.children[1];
    const oldRaw = before.value.ownership.raw(before.value.ownership.runLayouts[0].flow),
      oldNative = before.native.encodeState();
    const full = vi.spyOn(projector, 'projectWithActivity');
    try {
      type(p, 1n, '😀');
      type(p, 2n, '!');
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
    }
    const after = p.document.publication.status().publication!;
    expect(after.value.view.root.children[1]).toBe(tail);
    expect(after.value.view.root.children[1].boundaries).toBe(tail.boundaries);
    expect(after.value.view.root.children[0].origin).toBe(first.origin);
    expect(after.value.view.root.children[0].boundaries[0].address).toBe(
      first.boundaries[0].address,
    );
    expect(before.value.view.root.children[0].content).toBe('abc');
    expect(before.value.ownership.raw(before.value.ownership.runLayouts[0].flow)).toEqual(oldRaw);
    expect(compareBytes(before.native.encodeState(), oldNative)).toBe(0);
    expect(diagnostics(p)).toMatchObject({
      fullProjections: 1,
      localTextProjections: 2,
      projectionRecordsReplaced: 4,
    });
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('coupled checkpoints restore before the earliest controlled target, then survive eviction/restart', () => {
  const p = open('abc'),
    oracle = createMaterializationOracle();
  try {
    const edits = Array.from({ length: 132 }, (_, i) => type(p, BigInt(i + 1)));
    expect(diagnostics(p).ownership).toMatchObject({
      lastReplayFrom: 131,
      lastReplayLength: 1,
      retainedCheckpoints: 1,
    });
    oracle.check(p.document, p.genesis);
    const undo = control(p, edits[129], false);
    expect(diagnostics(p).ownership).toMatchObject({
      lastReplayFrom: 128,
      lastReplayLength: 5,
      checkpointRestores: 1,
    });
    oracle.check(p.document, p.genesis);
    control(p, edits[129], true, undo);
    expect(diagnostics(p).ownership).toMatchObject({
      lastReplayFrom: 128,
      lastReplayLength: 6,
      checkpointRestores: 2,
    });
    oracle.check(p.document, p.genesis);
    const bytes = p.document.store.encodeUpdate();
    if (!(p.document.publication instanceof MaterializedPublication)) throw new Error();
    p.document.publication.evict();
    expect(compareBytes(p.document.store.encodeUpdate(), bytes)).toBe(0);
    type(p, 133n);
    oracle.check(p.document, p.genesis);
    const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'materialized');
    try {
      expect(cold.observe()).toEqual(p.observe());
    } finally {
      cold.close();
    }
  } finally {
    oracle.destroy();
    p.close();
  }
}, 120000);

for (const size of [10, 150, 1000])
  test(`warm literal work reads only its tape and never full-projects ${size} paragraphs`, () => {
    const p = open(Array.from({ length: size }, () => 'abc').join('\n\n'));
    try {
      type(p, 1n);
      const snapshots = vi.spyOn(NativeTapeCache.prototype, 'snapshotSteps');
      const full = vi.spyOn(projector, 'projectWithActivity');
      const before = diagnostics(p);
      try {
        type(p, 2n, '😀');
        expect(full).not.toHaveBeenCalled();
        const tapes = new Set(snapshots.mock.calls.map(([tape]) => JSON.stringify(tape)));
        expect(tapes.size).toBe(1);
        expect(diagnostics(p).projectionRecordsReplaced - before.projectionRecordsReplaced).toBe(2);
        expect(diagnostics(p).textTapesRebuilt - before.textTapesRebuilt).toBe(1);
      } finally {
        snapshots.mockRestore();
        full.mockRestore();
      }
    } finally {
      p.close();
    }
  }, 120000);
