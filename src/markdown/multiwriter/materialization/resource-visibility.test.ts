import { expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';
import { resolveAddress, textPoint } from '../projection/addresses.js';
import { OwnershipResult } from '../ownership/ownership.js';
import { compareBytes } from '../actions/cbor.js';
import { captureDiagnostics } from '../diagnostics.js';
import * as projector from '../projection/project.js';

for (const size of [10, 150])
  test(`distant active subtree deletion does not invalidate local text, controls or selected addresses (${size})`, () => {
    const genesis = commandGenesis(
      Array.from({ length: size }, (_, i) => `p${i}abcdef`).join('\n\n'),
    );
    const p = commandReplica(genesis, undefined, 'materialized'),
      oracle = createMaterializationOracle();
    const history = p.editor.session('text'),
      deleted = p.editor.session('deleted');
    try {
      expect(deleted.edit(deleteBlocks, { nodeIds: [p.handle(p.nodes().at(-2)!)] }).status).toBe(
        'applied',
      );
      const held = p.document.publication.status().publication!,
        tail = p.nodes().at(-1)!;
      const heldView = structuredClone(held.value.view),
        native = held.native.encodeState();
      const address = textPoint(tail, 2, 'right').address;
      expect(held.value.visibility.nodes.some((n) => n.deleted)).toBe(true);
      const full = vi.spyOn(projector, 'projectWithActivity');
      try {
        expect(
          history.edit(
            insertText,
            { nodeId: p.handle(p.nodes()[0]), from: 2, to: 3, text: '!' },
            { typing: false },
          ).status,
        ).toBe('applied');
        expect(history.undo().state).toBe('applied');
        expect(history.redo().state).toBe('applied');
        expect(full).not.toHaveBeenCalled();
        expect(p.nodes().at(-1)).toBe(tail);
      } finally {
        full.mockRestore();
      }
      oracle.check(p.document, genesis);
      const current = p.document.publication.status().publication!;
      const allocations = vi.spyOn(OwnershipResult.prototype, 'nodeAllocations', 'get');
      try {
        const { value, report } = captureDiagnostics(() =>
          resolveAddress(address, current.value.ownership, current.value.visibility),
        );
        expect(value.state).toBe('available');
        expect(report.work['driver/address.fullIndexesRead'] ?? 0).toBe(0);
        expect(allocations).not.toHaveBeenCalled();
      } finally {
        allocations.mockRestore();
      }
      expect(
        resolveAddress(address, current.value.ownership, { ...current.value.visibility }),
      ).toEqual(resolveAddress(address, current.value.ownership, current.value.visibility));
      expect(held.value.view).toEqual(heldView);
      expect(compareBytes(held.native.encodeState(), native)).toBe(0);
      const bytes = p.document.store.encodeUpdate();
      if (!('projectionDiagnostics' in p.document)) throw new Error('Expected materialized reader');
      p.document.publication.evict();
      p.editor.refresh();
      expect(compareBytes(bytes, p.document.store.encodeUpdate())).toBe(0);
      expect(resolveAddress(address, held.value.ownership, held.value.visibility).state).toBe(
        'available',
      );
      oracle.check(p.document, genesis);
    } finally {
      oracle.destroy();
      p.close();
    }
  });

test('split/join and their history retain exact contributions without rebuilding a deletion index', () => {
  const genesis = commandGenesis('abcdef\n\nother\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized');
  const oracle = createMaterializationOracle(),
    history = p.editor.session('structure');
  try {
    expect(
      history.edit(
        insertText,
        { nodeId: p.handle(p.nodes()[0]), from: 1, to: 2, text: '!' },
        { typing: false },
      ).status,
    ).toBe('applied');
    const { report } = captureDiagnostics(() => {
      expect(
        history.edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 }).status,
      ).toBe('applied');
      expect(history.edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[1]) }).status).toBe(
        'applied',
      );
      expect(history.undo().state).toBe('applied');
      expect(history.redo().state).toBe('applied');
    });
    expect(report.work['publication/deletion.fullIndexesConstructed'] ?? 0).toBe(0);
    expect(report.work['staging/deletion.fullIndexesConstructed'] ?? 0).toBe(0);
    oracle.check(p.document, genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

for (const feature of ['suppressed', 'scaffold'] as const)
  test(`a distant ${feature} birth does not force full projection for real text commands and history`, () => {
    const p = commandReplica(
      commandGenesis(Array.from({ length: 10 }, (_, i) => `p${i}abcdef`).join('\n\n')),
      undefined,
      'materialized',
    );
    const oracle = createMaterializationOracle();
    try {
      const split = p.editor.edit({ local: 'setup', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[8]),
        from: feature === 'scaffold' ? p.nodes()[8].content.length : 3,
      });
      if (split.status !== 'applied') throw new Error('Expected split');
      if (feature === 'scaffold')
        expect(
          p.editor.edit({ local: 'peer', group: 1n }, insertText, {
            nodeId: p.handle(p.nodes()[9]),
            from: 0,
            text: 'peer',
          }).status,
        ).toBe('applied');
      control(p, split, false);
      expect(
        p.document.publication.status().publication!.value.visibility.nodes.some((n) => n[feature]),
      ).toBe(true);
      const tail = p.nodes().at(-1)!,
        history = p.editor.session('distant');
      const full = vi.spyOn(projector, 'projectWithActivity');
      try {
        expect(
          history.edit(
            insertText,
            { nodeId: p.handle(p.nodes()[0]), from: 2, to: 3, text: '!' },
            { typing: false },
          ).status,
        ).toBe('applied');
        expect(history.undo().state).toBe('applied');
        expect(history.redo().state).toBe('applied');
        expect(full).not.toHaveBeenCalled();
        expect(p.nodes().at(-1)).toBe(tail);
      } finally {
        full.mockRestore();
      }
      oracle.check(p.document, p.genesis);
    } finally {
      oracle.destroy();
      p.close();
    }
  });
