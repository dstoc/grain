import { afterEach, expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { cycleTaskState } from '../../../editing/commands/cycle-task-state.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';
import { action, resource } from '../actions/test-fixtures.js';
import * as projector from '../projection/project.js';
import { isPropertyRefinement, propertyControlTargets } from './properties.js';
import { MaterializedPublication } from './publication.js';
import { compareBytes } from '../actions/cbor.js';
import { ConstructionTreeDraft } from '../../semantic/construction-tree.js';
import { MultiwriterCommandDraft } from '../authoring/draft.js';

const open = (text: string) => commandReplica(commandGenesis(text), undefined, 'materialized');
function counts(p: ReturnType<typeof open>) {
  if (!('projectionDiagnostics' in p.document)) throw new Error();
  return p.document.projectionDiagnostics();
}
afterEach(() => vi.restoreAllMocks());

for (const size of [10, 150])
  test(`task state and owner controls replace only the affected ancestor path (${size})`, () => {
    const p = open(Array.from({ length: size }, (_, i) => `- [ ] task ${i}`).join('\n')),
      oracle = createMaterializationOracle();
    try {
      const before = p.document.publication.status().publication!,
        native = before.native.encodeState();
      const list = before.value.view.root.children[0],
        item = list.children[Math.floor(size / 2)],
        nodeId = p.handle(item);
      const history = p.editor.session('task'),
        start = counts(p);
      const full = vi.spyOn(projector, 'projectWithActivity');
      const adopt = vi.spyOn(ConstructionTreeDraft.prototype, 'adopt');
      expect(history.edit(cycleTaskState, { nodeId }).status).toBe('applied');
      expect(history.undo().state).toBe('applied');
      expect(history.redo().state).toBe('applied');
      expect(full).not.toHaveBeenCalled();
      expect(adopt).not.toHaveBeenCalled();
      const after = p.document.publication.status().publication!,
        work = counts(p);
      expect(work.fullProjections).toBe(start.fullProjections);
      expect(work.localPropertyProjections - start.localPropertyProjections).toBe(3);
      expect(work.stagedPropertyProjections - start.stagedPropertyProjections).toBe(1);
      expect(work.ownership.nativeTapeReads).toBe(start.ownership.nativeTapeReads);
      expect(work.ownership.cellTapesIndexed).toBe(start.ownership.cellTapesIndexed);
      expect(after.value.view.root.children[0].children[0]).toBe(list.children[0]);
      expect(after.value.view.root.children[0].children[Math.floor(size / 2)].children).toBe(
        item.children,
      );
      expect(after.value.view.root.children[0].children[Math.floor(size / 2)].checked).toBe(true);
      expect(item.checked).toBe(false);
      expect(compareBytes(before.native.encodeState(), native)).toBe(0);
      full.mockRestore();
      adopt.mockRestore();
      oracle.check(p.document, p.genesis);
      const cold = commandReplica(p.genesis, p.document.store.encodeUpdate());
      try {
        expect(cold.observe()).toEqual(p.observe());
      } finally {
        cold.close();
      }
      const publication = p.document.publication;
      if (!(publication instanceof MaterializedPublication)) throw new Error();
      publication.evict();
      expect(history.edit(cycleTaskState, { nodeId }).status).toBe('applied');
      oracle.check(p.document, p.genesis);
      expect(history.undo().state).toBe('applied');
      oracle.check(p.document, p.genesis);
    } finally {
      oracle.destroy();
      p.close();
    }
  }, 60000);

test('code info, competing peer writes and controls preserve text addresses and later structural edits', () => {
  const genesis = commandGenesis('```js\ncode😀\n```\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis),
    oracle = createMaterializationOracle();
  const setInfo = (
    ctx: Parameters<typeof insertParagraph>[0],
    { nodeId, info }: { nodeId: string; info: string },
  ) => {
    ctx.draft.setInfo(nodeId, info);
    return { status: 'handled' } as const;
  };
  try {
    const before = p.nodes()[0],
      nodeId = p.handle(before),
      history = p.editor.session('info');
    peer.editor.edit({ local: 'peer', group: 1n }, setInfo, {
      nodeId: peer.handle(peer.nodes()[0]),
      info: 'peer',
    });
    expect(history.edit(setInfo, { nodeId, info: 'ts' }).status).toBe('applied');
    expect(p.nodes()[0].boundaries).toBe(before.boundaries);
    p.receive(peer.document.store.encodeUpdate());
    oracle.check(p.document, genesis);
    expect(history.undo().state).toBe('applied');
    expect(p.nodes()[0].info).toBe('peer');
    oracle.check(p.document, genesis);
    expect(history.redo().state).toBe('applied');
    oracle.check(p.document, genesis);
    const inline = p.nodes()[0];
    expect(
      history.edit(insertText, { nodeId: p.handle(inline), from: inline.content.length, text: '!' })
        .status,
    ).toBe('applied');
    expect(
      history.edit(insertParagraph, { nodeId: p.handle(p.nodes().at(-1)!), from: 2 }).status,
    ).toBe('applied');
    oracle.check(p.document, genesis);
  } finally {
    oracle.destroy();
    p.close();
    peer.close();
  }
});

test('marker/presentation, mixed history groups and unavailable targets retain full projection', () => {
  const p = open('- [ ] task\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    const history = p.editor.session('mixed'),
      item = p.view().root.children[0].children[0],
      inline = p.nodes()[0];
    const start = counts(p);
    history.edit((ctx) => {
      ctx.draft.setChecked(p.handle(item), true);
      return insertText(ctx, { nodeId: p.handle(inline), from: 0, text: 'X' });
    }, undefined);
    expect(counts(p).fullProjections).toBeGreaterThan(start.fullProjections);
    expect(history.undo().state).toBe('applied');
    oracle.check(p.document, p.genesis);
    const before = counts(p).fullProjections;
    p.editor.edit(
      { local: 'marker', group: 1n },
      (ctx) => {
        ctx.draft.setMarker(p.handle(p.view().root.children[0].children[0]), '2. ');
        return { status: 'handled' };
      },
      undefined,
    );
    expect(counts(p).fullProjections).toBeGreaterThan(before);
    oracle.check(p.document, p.genesis);
    p.editor.edit({ local: 'delete', group: 1n }, deleteBlocks, {
      nodeIds: [p.handle(p.nodes()[0])],
    });
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('property classification rejects native writes, structural allocations and mixed controls', () => {
  const base = action(),
    property = {
      ...base,
      effects: [
        { type: 'SetProperties' as const, node: resource('node', 0), values: { checked: true } },
      ],
    };
  expect(isPropertyRefinement(property)).toBe(true);
  for (const values of [
    { marker: '1. ' },
    { presentation: 'section' as const },
    { checked: true, marker: '* ' },
  ])
    expect(
      isPropertyRefinement({ ...property, effects: [{ ...property.effects[0], values }] }),
    ).toBe(false);
  expect(isPropertyRefinement({ ...property, nativeInsertUpdates: [new Uint8Array([0])] })).toBe(
    false,
  );
  expect(
    isPropertyRefinement({
      ...property,
      allocations: [{ type: 'deletion', id: resource('deletion', 1) }],
    }),
  ).toBe(false);
  const control = {
    ...action(),
    effects: [
      {
        type: 'SetGroupActive' as const,
        group: property.groupId,
        actions: [property.id],
        active: false,
        previousControl: null,
      },
    ],
  };
  expect(propertyControlTargets(control, () => property)).toEqual([property]);
  expect(propertyControlTargets(control, () => undefined)).toBeUndefined();
  expect(
    propertyControlTargets(control, () => ({
      ...property,
      effects: [{ ...property.effects[0], values: { marker: '* ' } }],
    })),
  ).toBeUndefined();
  expect(
    propertyControlTargets({ ...control, nativeInsertUpdates: [new Uint8Array()] }, () => property),
  ).toBeUndefined();
});

test('cancelled property path copies stay private and later receipts rebuild atomically', () => {
  const genesis = commandGenesis('- [ ] task\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis),
    oracle = createMaterializationOracle();
  const updates: Uint8Array[] = [];
  const stop = peer.document.store.onUpdate((bytes) => updates.push(bytes.slice()));
  try {
    const item = peer.view().root.children[0].children[0],
      nodeId = peer.handle(item);
    peer.editor.edit({ local: 'peer', group: 1n }, cycleTaskState, { nodeId });
    peer.editor.edit({ local: 'peer', group: 2n }, cycleTaskState, { nodeId });
    const before = p.document.publication.status().publication!,
      start = counts(p).projectionRecordsReplaced;
    p.document.store.applyUpdate(updates[0]);
    let work = p.document.publication.refresh(0);
    for (let i = 0; counts(p).projectionRecordsReplaced === start && i < 100000; i++) {
      if (work.state !== 'deferred')
        throw new Error('published before private property checkpoint');
      work = work.continuation.resume(1);
    }
    expect(counts(p).projectionRecordsReplaced).toBeGreaterThan(start);
    expect(p.document.publication.status().publication).toBe(before);
    expect(before.value.view.root.children[0].children[0].checked).toBe(false);
    p.document.store.applyUpdate(updates[1]);
    if (work.state !== 'deferred') throw new Error();
    expect(() => work.continuation.resume(1)).toThrow(/invalidated/);
    p.editor.refresh();
    expect(p.view().root.children[0].children[0].checked).toBeNull();
    expect(before.value.view.root.children[0].children[0].checked).toBe(false);
    oracle.check(p.document, genesis);
    const cold = commandReplica(genesis, p.document.store.encodeUpdate());
    try {
      expect(cold.observe()).toEqual(p.observe());
    } finally {
      cold.close();
    }
  } finally {
    stop();
    oracle.destroy();
    p.close();
    peer.close();
  }
});

test('held property overlays survive later tree materialization and same-action structural commands', () => {
  const p = open('- [ ] task\n\n```js\ncode\n```'),
    oracle = createMaterializationOracle();
  try {
    const draft = new MultiwriterCommandDraft(p.view().root, true),
      item = p.view().root.children[0].children[0],
      itemId = p.handle(item);
    const held = draft.node(itemId),
      code = p.nodes().find((n) => n.type === 'code-block')!,
      codeId = p.handle(code);
    draft.setChecked(itemId, true);
    expect(held.checked).toBe(true);
    draft.setChecked(itemId, null);
    expect(held.checked).toBeNull();
    draft.setInfo(codeId, 'ts');
    expect(draft.node(codeId).info).toBe('ts');
    void draft.tree;
    expect(held.checked).toBeNull();
    expect(draft.node(codeId).info).toBe('ts');
    const h = p.editor.session('property-then-structure');
    expect(
      h.edit((ctx) => {
        ctx.draft.setChecked(itemId, true);
        return insertParagraph(ctx, { nodeId: p.handle(p.nodes()[0]), from: 2 });
      }, undefined).status,
    ).toBe('applied');
    oracle.check(p.document, p.genesis);
    expect(h.undo().state).toBe('applied');
    expect(h.redo().state).toBe('applied');
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});
