import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { control } from '../../../../test/multiwriter/commands/control.js';

const open = () => commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized');
function counts(p: ReturnType<typeof open>) {
  if (!('ownershipDiagnostics' in p.document)) throw new Error('Expected materialized reader');
  return p.document.ownershipDiagnostics();
}
function split(p: ReturnType<typeof open>, group: bigint) {
  const edit = p.editor.edit({ local: 'split', group }, insertParagraph, {
    nodeId: p.handle(p.nodes()[0]),
    from: 2,
  });
  if (edit.status !== 'applied') throw new Error('Expected split');
  return edit;
}

for (const depth of [10, 150])
  test(`structural append checks only new payload decisions after ${depth} ready actions`, () => {
    const p = open(),
      oracle = createMaterializationOracle();
    try {
      for (let i = 0; i < depth; i++)
        expect(
          p.editor.edit({ local: 'prefix', group: BigInt(i + 1) }, insertText, {
            nodeId: p.handle(p.nodes()[1]),
            from: 1,
            text: 'x',
          }).status,
        ).toBe('applied');
      const before = counts(p),
        old = p.document.publication.status().publication!;
      const edit = split(p, 1n),
        after = counts(p);
      expect(after.payloadsCompared - before.payloadsCompared).toBe(1);
      expect(after.interpretationSelections).toBe(before.interpretationSelections);
      expect(after.lastReplayFrom).toBe(depth);
      expect(after.lastReplayLength).toBe(1);
      expect(old.value.view.root.children[0].content).toBe('abcdef');
      oracle.check(p.document, p.genesis);
      control(p, edit, false);
      expect(counts(p).interpretationSelections).toBe(after.interpretationSelections);
      expect(counts(p).payloadsCompared - after.payloadsCompared).toBe(2);
      oracle.check(p.document, p.genesis);
    } finally {
      oracle.destroy();
      p.close();
    }
  }, 120000);

test('exact append evidence certifies ordinary subdivisions across split and join', () => {
  const p = open(),
    oracle = createMaterializationOracle();
  try {
    split(p, 1n);
    expect(
      p.editor.edit({ local: 'join', group: 1n }, joinWithPrevious, {
        nodeId: p.handle(p.nodes()[1]),
      }).status,
    ).toBe('applied');
    const before = counts(p);
    split(p, 2n);
    const after = counts(p);
    expect(after.payloadsCompared - before.payloadsCompared).toBe(1);
    expect(after.nativeReaderInvalidations).toBe(before.nativeReaderInvalidations);
    expect(after.lastReplayFrom).toBe(2);
    expect(after.lastReplayReason).toBe('content-subdivision');
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('packet decisions survive a structural append and controls reselect them', () => {
  const p = open(),
    oracle = createMaterializationOracle();
  try {
    const nodeId = p.handle(p.nodes()[0]);
    const promote = p.editor.edit(
      { local: 'promote', group: 1n },
      insertText,
      { nodeId, from: 0, text: '# ' },
      { promote: nodeId },
    );
    if (promote.status !== 'applied') throw new Error('Expected promotion');
    const before = counts(p);
    split(p, 1n);
    expect(counts(p).payloadsCompared - before.payloadsCompared).toBe(1);
    expect(counts(p).interpretationSelections).toBe(before.interpretationSelections);
    oracle.check(p.document, p.genesis);
    const undo = control(p, promote, false);
    oracle.check(p.document, p.genesis);
    control(p, promote, true, undo);
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('batched suffix additions reuse decisions while earlier arrivals compare the retained order', () => {
  const p = open(),
    peer = commandReplica(p.genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    split(p, 1n);
    peer.receive(p.document.store.encodeUpdate());
    const before = counts(p);
    split(peer, 1n);
    split(peer, 2n);
    p.receive(peer.document.store.encodeUpdate());
    expect(counts(p).payloadsCompared - before.payloadsCompared).toBe(2);
    oracle.check(p.document, p.genesis);
    const earlier = commandReplica(p.genesis, undefined, 'materialized');
    try {
      split(earlier, 1n);
      const retained = counts(p);
      p.receive(earlier.document.store.encodeUpdate());
      expect(counts(p).interpretationSelections).toBe(retained.interpretationSelections + 1);
      expect(counts(p).payloadsCompared - retained.payloadsCompared).toBe(4);
      oracle.check(p.document, p.genesis);
    } finally {
      earlier.close();
    }
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});

test('private command queries replay and compare only their unpublished action', () => {
  const p = open(),
    oracle = createMaterializationOracle();
  try {
    for (let i = 0; i < 150; i++)
      expect(
        p.editor.edit({ local: 'prefix', group: BigInt(i + 1) }, insertText, {
          nodeId: p.handle(p.nodes()[1]),
          from: 1,
          text: 'x',
        }).status,
      ).toBe('applied');
    if (!('commandOwnershipDiagnostics' in p.document)) throw new Error();
    const before = p.document.commandOwnershipDiagnostics();
    split(p, 1n);
    const after = p.document.commandOwnershipDiagnostics(),
      queries = after.queries - before.queries;
    expect(queries).toBeGreaterThan(0);
    expect(after.payloadsCompared - before.payloadsCompared).toBe(queries);
    expect(after.activityPayloadsCompared - before.activityPayloadsCompared).toBe(queries);
    expect(after.activityActionsReplayed - before.activityActionsReplayed).toBe(queries);
    expect(after.interpretationSelections).toBe(before.interpretationSelections);
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
}, 120000);
