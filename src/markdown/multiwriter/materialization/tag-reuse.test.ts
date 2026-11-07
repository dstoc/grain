import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { action, resource } from '../actions/test-fixtures.js';
import { resourceKey } from '../layout/index.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';

test('accepted repeated deletion tags retain first-covering order through structural projection and cold replay', () => {
  const genesis = commandGenesis('abcdef\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    const a = action(),
      first = resource('deletion', 0, a.id),
      second = resource('deletion', 1, a.id);
    const observed = (text: string) => {
      const entry = genesis.body.nativeManifest.find(
        (entry) => entry.type === 'text' && entry.text === text,
      );
      if (!entry || entry.type !== 'text') throw new Error('Missing original native text');
      return { tape: entry.tape, ...entry.native };
    };
    const body = {
      ...a,
      documentId: genesis.documentId,
      genesisId: genesis.genesisId,
      allocations: [
        { type: 'deletion' as const, id: first },
        { type: 'deletion' as const, id: second },
      ],
      effects: [
        { type: 'DeleteText' as const, tag: first, observed: [observed('a')] },
        { type: 'DeleteText' as const, tag: second, observed: [observed('b')] },
        { type: 'DeleteText' as const, tag: first, observed: [observed('b')] },
      ],
    };
    p.document.certifyLocal(body);
    p.document.store.append(body);
    p.editor.refresh();
    expect(p.document.store.snapshot().ready).toHaveLength(1);
    expect(p.nodes()[0].content).toBe('cdef');
    oracle.check(p.document, genesis);
    expect(
      p.editor.edit({ local: 'split', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[0]),
        from: 1,
      }).status,
    ).toBe('applied');
    const token = observed('b'),
      visibility = p.document.publication
        .status()
        .publication!.value.visibility.text.find(
          (entry) =>
            resourceKey(entry.token.tape) === resourceKey(token.tape) &&
            entry.token.native.client === token.client &&
            entry.token.native.clock === token.clock,
        );
    expect(visibility!.tags).toEqual([second, first]);
    expect(p.nodes().map((node) => node.content)).toEqual(['c', 'def', 'tail']);
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
});
