import { afterEach, expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { indent } from '../../../editing/commands/indent.js';
import { CommandCompiler } from '../authoring/compiler.js';
import { NativePlan } from '../authoring/native-plan.js';
import * as projector from '../projection/project.js';
import { resourceKey } from '../layout/index.js';
import { compareBytes } from '../actions/cbor.js';
import { MaterializedPublication } from './publication.js';

const open = (source: string) => commandReplica(commandGenesis(source), undefined, 'materialized');
function diagnostics(p: ReturnType<typeof open>) {
  if (!('commandOwnershipDiagnostics' in p.document)) throw new Error();
  return p.document.commandOwnershipDiagnostics();
}
afterEach(() => vi.restoreAllMocks());

for (const size of [10, 150])
  test(`structural compiler queries fork the committed suffix and read only participating tapes (${size})`, () => {
    const p = open(Array.from({ length: size }, () => 'abc').join('\n\n')),
      oracle = createMaterializationOracle();
    try {
      const index = Math.floor(size / 2),
        node = p.nodes()[index];
      const original = p.document.publication.status().publication!,
        native = original.native.encodeState(),
        owners = original.value.ownership.assignments,
        before = diagnostics(p);
      const run = CommandCompiler.prototype.run;
      const all = vi.spyOn(NativePlan.prototype, 'all');
      const project = vi.spyOn(projector, 'projectMarkdown');
      const reads = new Set<string>();
      vi.spyOn(CommandCompiler.prototype, 'run').mockImplementation(function (
        this: CommandCompiler,
      ) {
        const snapshot = this.native.snapshot.bind(this.native);
        const read = vi.spyOn(this.native, 'snapshot').mockImplementation((tape) => {
          reads.add(resourceKey(tape));
          return snapshot(tape);
        });
        const projects = project.mock.calls.length;
        try {
          run.call(this);
          expect(project.mock.calls.length).toBe(projects);
        } finally {
          read.mockRestore();
        }
      });
      const edit = p.editor.edit({ local: 'structural-overlay', group: 1n }, insertParagraph, {
        nodeId: p.handle(node),
        from: 1,
      });
      expect(edit.status).toBe('applied');
      expect(all).not.toHaveBeenCalled();
      const after = diagnostics(p);
      expect(after.queries).toBeGreaterThan(before.queries);
      expect(after.actionsReplayed - before.actionsReplayed).toBe(after.queries - before.queries);
      expect(after.coldReplays).toBe(before.coldReplays);
      expect(reads).toEqual(new Set([resourceKey(node.fragments[0].range.tape)]));
      vi.restoreAllMocks();
      expect(
        p
          .nodes()
          .slice(index, index + 2)
          .map((n) => n.content),
      ).toEqual(['a', 'bc']);
      expect(compareBytes(original.native.encodeState(), native)).toBe(0);
      expect(original.value.ownership.assignments).toEqual(owners);
      oracle.check(p.document, p.genesis);
      const cold = commandReplica(p.genesis, p.document.store.encodeUpdate());
      try {
        expect(cold.observe()).toEqual(p.observe());
      } finally {
        cold.close();
      }
    } finally {
      oracle.destroy();
      p.close();
    }
  }, 60000);

test('same-action text/split/indent overlays preserve native identities and managed history', () => {
  const p = open('abcd\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    const history = p.editor.session('mixed'),
      before = p.markdown();
    const nodeId = p.handle(p.nodes()[0]);
    const edit = history.edit(
      (ctx) => {
        insertText(ctx, { nodeId, from: 1, text: '😀' });
        const split = insertParagraph(ctx, { nodeId, from: 3 });
        if (split.status !== 'handled' || !split.focus) throw new Error();
        return indent(ctx, { nodeId: split.focus.nodeId });
      },
      undefined,
      {
        selectionBefore: {
          anchor: { nodeId, offset: 1, affinity: 'right' },
          focus: { nodeId, offset: 1, affinity: 'right' },
        },
      },
    );
    expect(edit.status).toBe('applied');
    const after = p.observe();
    oracle.check(p.document, p.genesis);
    expect(history.undo().state).toBe('applied');
    expect(p.markdown()).toBe(before);
    oracle.check(p.document, p.genesis);
    expect(history.redo().state).toBe('applied');
    expect(p.view()).toEqual(after.tree);
    expect(p.markdown()).toBe(after.markdown);
    expect(p.observe().native).toEqual(after.native);
    oracle.check(p.document, p.genesis);
    const publication = p.document.publication;
    if (!(publication instanceof MaterializedPublication)) throw new Error();
    publication.evict();
    // Eviction intentionally loses the reusable command root. Cold preparation
    // must still lower the exact same continued edit and preserve the history.
    const joined = history.edit(joinWithPrevious, { nodeId: p.handle(p.nodes().at(-1)!) });
    expect(joined.status).toBe('applied');
    oracle.check(p.document, p.genesis);
    expect(history.undo().state).toBe('applied');
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('unpublished ownership branches reject receipts and cannot commit into the reader', () => {
  const p = open('abc\n\ntail');
  try {
    if (!('createCommandOwnership' in p.document)) throw new Error();
    const stage = p.document.createCommandOwnership();
    if (!stage) throw new Error();
    const before = p.document.publication.status().publication!;
    const edit = p.editor.edit({ local: 'change', group: 1n }, insertText, {
      nodeId: p.handle(p.nodes()[0]),
      from: 1,
      text: 'X',
    });
    if (edit.status !== 'applied') throw new Error();
    expect(() => stage(edit.envelope, before.native, [])).toThrow(/invalidated/);
    expect(before.value.view.root.children[0].content).toBe('abc');
    expect(p.nodes()[0].content).toBe('aXbc');
  } finally {
    p.close();
  }
});

test('managed structural selection stages suffix ownership before a reentrant peer prepend', () => {
  const genesis = commandGenesis('abc\n\ndef'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis),
    oracle = createMaterializationOracle();
  let delivered = false;
  const stop = p.document.store.onUpdate(() => {
    if (delivered) return;
    delivered = true;
    p.receive(peer.document.store.encodeUpdate());
  });
  try {
    peer.editor.edit({ local: 'peer', group: 1n }, insertText, {
      nodeId: peer.handle(peer.nodes()[0]),
      from: 0,
      text: 'P',
    });
    const history = p.editor.session('join'),
      nodeId = p.handle(p.nodes()[1]);
    if (!('projectionDiagnostics' in p.document)) throw new Error();
    const before = p.document.projectionDiagnostics();
    const edit = history.edit(
      joinWithPrevious,
      { nodeId },
      {
        selectionBefore: {
          anchor: { nodeId, offset: 0, affinity: 'right' },
          focus: { nodeId, offset: 0, affinity: 'right' },
        },
      },
    );
    expect(edit.status).toBe('applied');
    expect(delivered).toBe(true);
    expect(p.nodes()[0].content).toBe('Pabcdef');
    const after = p.document.projectionDiagnostics();
    expect(after.stagedStructuralProjections - before.stagedStructuralProjections).toBe(1);
    expect(after.stagedStructureActionsReplayed - before.stagedStructureActionsReplayed).toBe(1);
    expect(after.stagedStructureTapesRead - before.stagedStructureTapesRead).toBe(1);
    oracle.check(p.document, genesis);
    expect(history.undo().state).toBe('applied');
    expect(p.nodes().map((n) => n.content)).toEqual(['Pabc', 'def']);
    const redo = history.redo();
    expect(redo).toMatchObject({
      state: 'applied',
      restoration: {
        state: 'exact',
        anchor: { offset: 4 },
        focus: { offset: 4 },
      },
    });
    oracle.check(p.document, genesis);
  } finally {
    stop();
    oracle.destroy();
    p.close();
    peer.close();
  }
});

test('failed unpublished structural queries preserve publication, native state and history', () => {
  const p = open('abcdef\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    if (!('createCommandOwnership' in p.document)) throw new Error();
    const create = p.document.createCommandOwnership.bind(p.document);
    const fail = vi.spyOn(p.document, 'createCommandOwnership').mockImplementationOnce(() => {
      const branch = create();
      if (!branch) throw new Error();
      return (...args) => {
        branch(...args);
        throw new Error('unpublished query failed');
      };
    });
    const before = p.document.publication.status().publication!,
      bytes = p.document.store.encodeUpdate();
    const owners = before.value.ownership.assignments,
      native = before.native.encodeState();
    const history = p.editor.session('failed-split'),
      nodeId = p.handle(p.nodes()[0]);
    expect(() => history.edit(insertParagraph, { nodeId, from: 3 })).toThrow(
      'unpublished query failed',
    );
    expect(p.document.publication.status().publication).toBe(before);
    expect(compareBytes(p.document.store.encodeUpdate(), bytes)).toBe(0);
    expect(compareBytes(before.native.encodeState(), native)).toBe(0);
    expect(before.value.ownership.assignments).toEqual(owners);
    expect(history.status()).toMatchObject({ undo: 0, redo: 0 });
    fail.mockRestore();
    expect(history.edit(insertParagraph, { nodeId, from: 3 }).status).toBe('applied');
    oracle.check(p.document, p.genesis);
    expect(history.undo().state).toBe('applied');
    expect(p.markdown()).toBe('abcdef\n\ntail\n');
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});
