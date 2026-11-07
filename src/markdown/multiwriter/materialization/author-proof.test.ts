import { expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import {
  insertParagraph,
  insertText,
  joinWithPrevious,
  RetainedEditError,
} from '../authoring/index.js';
import { captureDiagnostics } from '../diagnostics.js';
import { resourceKey } from '../layout/index.js';
import { MaterializedOwnership } from './coupled.js';

for (const depth of [0, 8, 32])
  test(`every managed split uses an exact-author proof after ${depth} unrelated births`, () => {
    const p = commandReplica(commandGenesis('abcdef\n\nxyz'), undefined, 'materialized');
    const oracle = createMaterializationOracle();
    try {
      if (!('authorProofDiagnostics' in p.document)) throw new Error('Expected materialized');
      const diagnostics = p.document.authorProofDiagnostics;
      const other = p.nodes()[1].origin.representative;
      const report = captureDiagnostics(() => {
        for (let i = 0; i < depth; i++) {
          const node = p
            .nodes()
            .find((n) => resourceKey(n.origin.representative) === resourceKey(other))!;
          expect(
            p.editor.session('births').edit(insertParagraph, { nodeId: p.handle(node), from: 1 })
              .status,
          ).toBe('applied');
          expect(diagnostics().hits).toBe(i + 1);
        }
        expect(
          p.editor
            .session('target')
            .edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 }).status,
        ).toBe('applied');
      }).report;
      expect(p.document.authorProofDiagnostics()).toMatchObject({
        hits: depth + 1,
        rejected: 0,
        oldActionsReplayed: 0,
        misses: {},
      });
      expect(report.work['author/authorProof.hits']).toBe(depth + 1);
      expect(report.work['author/authorProof.snapshotBindingsIndexed']).toBe(
        ((depth + 1) * (depth + 6)) / 2,
      );
      expect(report.work['author/authorProof.actionBytesCopied']).toBeGreaterThan(0);
      expect(report.work['author/authorProof.envelopeBytesEncoded']).toBeGreaterThan(
        report.work['author/authorProof.actionBytesCopied'],
      );
      expect(report.work['author/authorProof.refinementWitnessesCopied']).toBeGreaterThan(0);
      expect(report.work['author/authorProof.refinementRangesCopied']).toBeGreaterThan(
        report.work['author/authorProof.refinementWitnessesCopied'],
      );

      // Compiler ownership queries are separately charged under the author purpose.
      expect(report.work['author/ownership.suffixActions']).toBe(2 * (depth + 1));
      expect(report.work['author/authorProof.suffixActions']).toBe(depth + 1);
      expect(report.work['author/referenceOwnership.fullReconstructions'] ?? 0).toBe(0);
      expect(report.work['author/authorProof.preambleActions']).toBe(
        ((depth + 1) * (depth + 2)) / 2,
      );
      oracle.check(p.document, p.genesis);
    } finally {
      oracle.destroy();
      p.close();
    }
  });

test('split, typing, join and continued history retain the exact owned base and held readers', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized');
  const oracle = createMaterializationOracle();
  try {
    if (!('authorProofDiagnostics' in p.document)) throw new Error('Expected materialized');
    const old = p.observe();
    const held = p.document.publication.status().publication!;
    const oldView = structuredClone(held.value.view);
    const first = p.handle(p.nodes()[0]);
    expect(p.editor.session('split').edit(insertParagraph, { nodeId: first, from: 2 }).status).toBe(
      'applied',
    );
    expect(
      p.editor.session('left').edit(insertText, { nodeId: first, from: 1, text: 'L' }).status,
    ).toBe('applied');
    const right = p.handle(p.nodes()[1]);
    expect(
      p.editor.session('right').edit(insertText, { nodeId: right, from: 1, text: 'R' }).status,
    ).toBe('applied');
    const session = p.editor.session('join');
    expect(session.edit(joinWithPrevious, { nodeId: right }).status).toBe('applied');
    expect(p.document.authorProofDiagnostics().hits).toBe(2);
    expect(p.document.authorProofDiagnostics().misses).toEqual({});
    oracle.check(p.document, p.genesis);
    expect(held.value.view).toEqual(oldView);
    expect(old.markdown).toBe('abcdef\n\ntail\n');
    session.undo();
    oracle.check(p.document, p.genesis);
    session.redo();
    oracle.check(p.document, p.genesis);
    expect(
      p.editor.session('next').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 1 })
        .status,
    ).toBe('applied');
    expect(p.document.authorProofDiagnostics().hits).toBe(3);
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('provider failures propagate through projection validation without appending or changing old roots', () => {
  const p = commandReplica(commandGenesis(), undefined, 'materialized');
  const error = new Error('proof provider storage failure');
  const before = p.document.store.encodeUpdate();
  const held = p.document.publication.status().publication!;
  const spy = vi.spyOn(MaterializedOwnership.prototype, 'prepareAuthor').mockImplementation(() => {
    throw error;
  });
  try {
    expect(() =>
      p.editor.session('failed').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 }),
    ).toThrow(error.message);
    expect(p.document.store.encodeUpdate()).toEqual(before);
    expect(p.document.publication.status().publication).toBe(held);
  } finally {
    spy.mockRestore();
  }
  try {
    expect(
      p.editor.session('retry').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 })
        .status,
    ).toBe('applied');
  } finally {
    p.close();
  }
});

test('a competing publication preparation invalidates the proof before append', () => {
  const p = commandReplica(commandGenesis(), undefined, 'materialized');
  const held = p.document.publication.status().publication!;
  const before = p.document.store.encodeUpdate();
  const original = MaterializedOwnership.prototype.prepareAuthor;
  const spy = vi
    .spyOn(MaterializedOwnership.prototype, 'prepareAuthor')
    .mockImplementation(function* (this: MaterializedOwnership, ...args) {
      p.document.publication.refresh();
      return yield* original.apply(this, args);
    });
  try {
    expect(() =>
      p.editor.session('stale').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 }),
    ).toThrow('invalidated');
    expect(p.document.store.encodeUpdate()).toEqual(before);
    expect(p.document.publication.status().publication).toBe(held);
    if (!('authorProofDiagnostics' in p.document)) throw new Error('Expected materialized');
    expect(p.document.authorProofDiagnostics().hits).toBe(0);
  } finally {
    spy.mockRestore();
  }
  try {
    expect(
      p.editor.session('retry').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 })
        .status,
    ).toBe('applied');
  } finally {
    p.close();
  }
});

test('evicted ownership uses full certification once and reseeds the next exact local proof', () => {
  const p = commandReplica(commandGenesis(), undefined, 'materialized');
  const oracle = createMaterializationOracle();
  try {
    if (!('authorProofDiagnostics' in p.document)) throw new Error('Expected materialized');
    p.document.publication.evict();
    expect(
      p.editor.session('cold').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 })
        .status,
    ).toBe('applied');
    expect(p.document.authorProofDiagnostics()).toMatchObject({
      hits: 0,
      misses: { 'unavailable-owned-base': 1 },
    });
    oracle.check(p.document, p.genesis);
    expect(
      p.editor.session('warm').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 1 })
        .status,
    ).toBe('applied');
    expect(p.document.authorProofDiagnostics().hits).toBe(1);
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('checked-property publication and undo advance the owned author base', () => {
  const p = commandReplica(commandGenesis('- [ ] abcdef\n\ntail'), undefined, 'materialized');
  const oracle = createMaterializationOracle();
  try {
    if (!('authorProofDiagnostics' in p.document)) throw new Error('Expected materialized');
    const history = p.editor.session('checked');
    expect(
      history.edit((ctx) => {
        ctx.draft.setChecked(p.handle(p.view().root.children[0].children[0]), true);
        return { status: 'handled' };
      }, undefined).status,
    ).toBe('applied');
    expect(history.undo().state).toBe('applied');
    const before = p.document.authorProofDiagnostics().hits;
    expect(
      p.editor.session('split').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 })
        .status,
    ).toBe('applied');
    expect(p.document.authorProofDiagnostics().hits).toBe(before + 1);
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('a retained structural append registers history once after a real observer failure', () => {
  const p = commandReplica(commandGenesis(), undefined, 'materialized');
  const oracle = createMaterializationOracle();
  const history = p.editor.session('retained');
  const stop = p.document.store.onUpdate(() => {
    throw new Error('retained structural observer');
  });
  try {
    expect(() =>
      history.edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 }),
    ).toThrow(RetainedEditError);
  } finally {
    stop();
  }
  try {
    if (!('authorProofDiagnostics' in p.document)) throw new Error('Expected materialized');
    expect(p.document.authorProofDiagnostics().hits).toBe(1);
    expect(p.document.store.snapshot().ready).toHaveLength(1);
    p.editor.refresh();
    oracle.check(p.document, p.genesis);
    expect(history.undo().state).toBe('applied');
    expect(p.nodes().map((n) => n.content)).toEqual(['abcdef']);
    expect(history.redo().state).toBe('applied');
    expect(p.nodes().map((n) => n.content)).toEqual(['ab', 'cdef']);
    expect(
      p.editor
        .session('next')
        .edit(insertText, { nodeId: p.handle(p.nodes()[1]), from: 1, text: 'X' }).status,
    ).toBe('applied');
    oracle.check(p.document, p.genesis);
    const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'reference');
    try {
      expect(cold.observe()).toEqual(p.observe());
    } finally {
      cold.close();
    }
  } finally {
    oracle.destroy();
    p.close();
  }
});
