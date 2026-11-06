import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { compareBytes } from '../actions/cbor.js';

test('retained replacements use indexed visibility through managed split/join, history and cache eviction', () => {
  const genesis = commandGenesis(Array.from({ length: 10 }, () => 'abc😀def').join('\n\n')),
    p = commandReplica(genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle(),
    history = p.editor.session('structural-visibility');
  try {
    for (let i = 0; i < 150; i++)
      expect(
        history.edit(
          insertText,
          { nodeId: p.handle(p.nodes()[0]), from: 1, to: 2, text: i % 2 ? 'y' : 'x' },
          { typing: false },
        ).status,
      ).toBe('applied');
    if (!('projectionDiagnostics' in p.document)) throw new Error('Expected materialized reader');
    const before = p.document.publication.status().publication!,
      oldText = before.value.view.root.children[0].content,
      oldNative = before.native.encodeState(),
      counts = p.document.projectionDiagnostics();
    const nodeId = p.handle(p.nodes()[0]);
    expect(history.edit(insertParagraph, { nodeId, from: 2 }).status).toBe('applied');
    const after = p.document.projectionDiagnostics();
    expect(after.exactDeletionRangesIndexed - counts.exactDeletionRangesIndexed).toBe(0);
    expect(after.exactDeletionQueries - counts.exactDeletionQueries).toBeGreaterThan(0);
    expect(after.exactDeletionNodesVisited - counts.exactDeletionNodesVisited).toBeLessThan(
      (after.exactDeletionQueries - counts.exactDeletionQueries) * 12,
    );
    oracle.check(p.document, genesis);
    expect(history.edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[1]) }).status).toBe(
      'applied',
    );
    oracle.check(p.document, genesis);
    expect(history.undo().state).toBe('applied');
    oracle.check(p.document, genesis);
    expect(history.redo().state).toBe('applied');
    oracle.check(p.document, genesis);
    expect(before.value.view.root.children[0].content).toBe(oldText);
    expect(compareBytes(before.native.encodeState(), oldNative)).toBe(0);
    const canonical = p.document.store.encodeUpdate();
    p.document.publication.evict();
    p.editor.refresh();
    expect(compareBytes(p.document.store.encodeUpdate(), canonical)).toBe(0);
    oracle.check(p.document, genesis);
    expect(history.undo().state).toBe('applied');
    expect(
      history.edit(insertText, { nodeId: p.handle(p.nodes()[1]), from: 0, text: '!' }).status,
    ).toBe('applied');
    oracle.check(p.document, genesis);
    const cold = commandReplica(genesis, p.document.store.encodeUpdate(), 'reference');
    try {
      expect(p.observe()).toEqual(cold.observe());
    } finally {
      cold.close();
    }
  } finally {
    oracle.destroy();
    p.close();
  }
}, 120000);
