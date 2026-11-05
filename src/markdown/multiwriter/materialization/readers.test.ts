import { expect, test, vi } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { C, action, resource } from '../actions/test-fixtures.js';
import { actionKey } from '../actions/references.js';
import { compareBytes } from '../actions/cbor.js';
import type { NativeTextRange } from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import { NativeTapeCache } from '../text/cache.js';
import * as projector from '../projection/project.js';
import { MaterializedPublication } from './publication.js';

const open = (markdown: string) =>
  commandReplica(commandGenesis(markdown), undefined, 'materialized');
function diagnostics(p: CommandReplica) {
  if (!('projectionDiagnostics' in p.document)) throw new Error('Expected materialized reader');
  return p.document.projectionDiagnostics();
}
function applied(result: ReturnType<CommandReplica['editor']['edit']>) {
  if (result.status !== 'applied') throw new Error('Expected an applied command');
  return result;
}
function split(p: CommandReplica, at = 1) {
  return applied(
    p.editor.edit({ local: 'split', group: 1n }, insertParagraph, {
      nodeId: p.handle(p.nodes()[0]),
      from: at,
    }),
  );
}
function tapeText(p: CommandReplica, text: string): NativeTextRange {
  const birth = p.genesis.body.nativeManifest.find(
    (entry) => entry.type === 'text' && entry.text === text,
  );
  if (!birth || birth.type !== 'text') throw new Error('Missing native text');
  return { tape: birth.tape, ...birth.native };
}
function markerBody(p: CommandReplica, text: NativeTextRange) {
  const ready = p.document.store.snapshot().ready;
  const sequence =
    ready
      .filter((a) => a.id.actor === C)
      .reduce((n, a) => (a.id.sequence > n ? a.id.sequence : n), 0n) + 1n;
  const envelope = action(C, sequence, ready);
  const writer = new NativeTapeCache();
  try {
    writer.apply('G', p.genesis.body);
    for (const a of ready) writer.apply(actionKey(a.id), a);
    const prepared = writer.prepare('new-marker', [
      {
        type: 'marker',
        tape: text.tape,
        index: writer.locate(text.tape, text),
        marker: resource('marker', 0, envelope.id),
        affinity: 'right',
      },
    ]);
    prepared.commit();
    return { ...envelope, groupId: { ...envelope.groupId, sequence }, ...prepared.body };
  } finally {
    writer.destroy();
  }
}
function addMarker(p: CommandReplica, text: NativeTextRange) {
  const body = markerBody(p, text);
  p.document.certifyLocal(body);
  p.document.store.append(body);
  p.editor.refresh();
  return body;
}
function coldEqual(p: CommandReplica) {
  const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'materialized');
  try {
    expect(cold.observe()).toEqual(p.observe());
  } finally {
    cold.close();
  }
}

test('a split on another tape does not force full replay or projection for bracketed input', () => {
  const p = open('abc\n\n<!-- -->\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    split(p);
    const before = p.document.publication.status().publication!;
    const full = vi.spyOn(projector, 'projectWithActivity');
    let edit;
    try {
      edit = applied(
        p.editor.edit({ local: 'edge', group: 1n }, insertText, {
          nodeId: p.handle(p.nodes()[2]),
          from: 0,
          text: 'x',
        }),
      );
      expect(edit.envelope.allocations.some((a) => a.type === 'marker')).toBe(true);
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
    }
    const after = p.document.publication.status().publication!;
    expect(after.value.view.root.children[0]).toBe(before.value.view.root.children[0]);
    expect(after.value.view.root.children[1]).toBe(before.value.view.root.children[1]);
    expect(after.value.view.root.children[3]).toBe(before.value.view.root.children[3]);
    expect(diagnostics(p).ownership).toMatchObject({
      lastReplayFrom: 1,
      lastReplayLength: 1,
      nativeMarkerFallbacks: 0,
      nativeReaderInvalidations: 0,
    });
    oracle.check(p.document, p.genesis);
    const undo = control(p, edit, false);
    oracle.check(p.document, p.genesis);
    control(p, edit, true, undo);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('marker refinement updates joined and transferred ghost addresses, not only current cell owners', () => {
  const p = open('abc\n\nx\n\ny\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    const text = tapeText(p, 'b');
    for (const [source, destination, from] of [
      [0, 1, 1],
      [1, 2, 0],
    ])
      applied(
        p.editor.edit(
          { local: 'transfer', group: BigInt(destination) },
          (ctx, args) => {
            ctx.draft.transferInlineRange({ ...args, to: args.from + 1, at: 0, affinity: 'right' });
            return { status: 'handled' };
          },
          {
            source: p.handle(p.nodes()[source]),
            destination: p.handle(p.nodes()[destination]),
            from,
          },
        ),
      );
    expect(p.nodes().map((n) => n.content)).toEqual(['ac', 'x', 'by', 'tail']);
    const before = p.document.publication.status().publication!;
    const raw = before.value.ownership.assignments;
    const full = vi.spyOn(projector, 'projectWithActivity');
    try {
      addMarker(p, text);
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
    }
    const after = p.document.publication.status().publication!;
    expect(after.value.view.root.children[1].boundaries.length).toBe(
      before.value.view.root.children[1].boundaries.length + 2,
    );
    expect(after.value.view.root.children[3]).toBe(before.value.view.root.children[3]);
    expect(before.value.ownership.assignments).toEqual(raw);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
    applied(
      p.editor.edit({ local: 'join', group: 1n }, joinWithPrevious, {
        nodeId: p.handle(p.nodes()[2]),
      }),
    );
    addMarker(p, text);
    expect(p.nodes().map((n) => n.content)).toEqual(['ac', 'xby', 'tail']);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('changed split inputs replay from a compatible checkpoint before their first reader', () => {
  const p = open('abc\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    for (let i = 0; i < 128; i++)
      applied(
        p.editor.edit({ local: 'prefix', group: BigInt(i + 1) }, insertText, {
          nodeId: p.handle(p.nodes()[1]),
          from: 1,
          text: 'x',
        }),
      );
    const edit = split(p);
    const before = p.document.publication.status().publication!;
    const oldNative = before.native.encodeState(),
      oldOwners = before.value.ownership.assignments;
    addMarker(p, tapeText(p, 'b'));
    expect(diagnostics(p).ownership).toMatchObject({
      lastReplayFrom: 128,
      lastReplayLength: 2,
      nativeMarkerFallbacks: 0,
      nativeReaderInvalidations: 1,
    });
    expect(compareBytes(before.native.encodeState(), oldNative)).toBe(0);
    expect(before.value.ownership.assignments).toEqual(oldOwners);
    oracle.check(p.document, p.genesis);
    const undo = control(p, edit, false);
    oracle.check(p.document, p.genesis);
    control(p, edit, true, undo);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
}, 120000);

test('split adjacency readers include concurrently joined tapes outside the authored basis', () => {
  const p = open('abc\n\nxyz'),
    peer = commandReplica(p.genesis),
    oracle = createMaterializationOracle();
  try {
    // Force the unseen join (lamport 1) before the split (lamport 2), independent
    // of the fresh random actor identities used by the command writers.
    applied(
      p.editor.edit({ local: 'before-split', group: 1n }, insertText, {
        nodeId: p.handle(p.nodes()[0]),
        from: 1,
        text: '!',
      }),
    );
    const splitEdit = split(p);
    const text = tapeText(p, 'y');
    expect(
      splitEdit.envelope.effects.flatMap((e) =>
        e.type === 'SplitFlow' ? e.basis.ranges.map((r) => resourceKey(r.range.tape)) : [],
      ),
    ).not.toContain(resourceKey(text.tape));
    applied(
      peer.editor.edit({ local: 'join', group: 1n }, joinWithPrevious, {
        nodeId: peer.handle(peer.nodes()[1]),
      }),
    );
    p.receive(peer.document.store.encodeUpdate());
    oracle.check(p.document, p.genesis);
    const invalidations = diagnostics(p).ownership.nativeReaderInvalidations;
    addMarker(p, text);
    expect(diagnostics(p).ownership.nativeReaderInvalidations).toBe(invalidations + 1);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});

test('inactive split readers are removed and rejected candidates cannot install reader refinements', () => {
  const p = open('abc\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    const edit = split(p);
    control(p, edit, false);
    const before = p.document.publication.status().publication!;
    const body = markerBody(p, tapeText(p, 'b'));
    p.document.certifyLocal(body);
    p.document.store.append(body);
    let work = p.document.publication.refresh(0);
    expect(work.state).toBe('deferred');
    expect(p.document.publication.status().publication).toBe(before);
    const publication = p.document.publication;
    if (!(publication instanceof MaterializedPublication)) throw new Error();
    publication.evict();
    if (work.state === 'deferred') expect(() => work.continuation.resume(1)).toThrow(/invalidated/);
    p.editor.refresh();
    oracle.check(p.document, p.genesis);
    const counts = diagnostics(p).ownership;
    addMarker(p, tapeText(p, 'b'));
    expect(diagnostics(p).ownership).toMatchObject({
      lastReplayFrom: 3,
      lastReplayLength: 1,
      nativeReaderInvalidations: counts.nativeReaderInvalidations,
      nativeMarkerFallbacks: 0,
    });
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('historical checkpoints keep their own transfer assignments during later local refinement', () => {
  const p = open('abc\n\nxyz\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    for (let i = 0; i < 128; i++)
      applied(
        p.editor.edit({ local: 'prefix', group: BigInt(i + 1) }, insertText, {
          nodeId: p.handle(p.nodes()[2]),
          from: 1,
          text: 'x',
        }),
      );
    const transfer = applied(
      p.editor.edit(
        { local: 'transfer', group: 1n },
        (ctx, args) => {
          ctx.draft.transferInlineRange({ ...args, from: 1, to: 2, at: 1, affinity: 'right' });
          return { status: 'handled' };
        },
        { source: p.handle(p.nodes()[0]), destination: p.handle(p.nodes()[1]) },
      ),
    );
    const before = p.document.publication.status().publication!;
    const full = vi.spyOn(projector, 'projectWithActivity');
    try {
      addMarker(p, tapeText(p, 'b'));
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
    }
    expect(
      p
        .nodes()
        .slice(0, 2)
        .map((n) => n.content),
    ).toEqual(['ac', 'xbyz']);
    expect(before.value.view.root.children[0].content).toBe('ac');
    oracle.check(p.document, p.genesis);
    const counts = diagnostics(p).ownership;
    const undo = control(p, transfer, false);
    expect(diagnostics(p).ownership).toMatchObject({
      lastReplayFrom: 128,
      nativeTapeReads: counts.nativeTapeReads,
      cellTapesIndexed: counts.cellTapesIndexed,
    });
    expect(
      p
        .nodes()
        .slice(0, 2)
        .map((n) => n.content),
    ).toEqual(['abc', 'xyz']);
    oracle.check(p.document, p.genesis);
    control(p, transfer, true, undo);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
}, 120000);

test('refining a home born after a checkpoint does not install its ownership into the older prefix', () => {
  const p = open('abc\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    for (let i = 0; i < 128; i++)
      applied(
        p.editor.edit({ local: 'prefix', group: BigInt(i + 1) }, insertText, {
          nodeId: p.handle(p.nodes()[1]),
          from: 1,
          text: 'x',
        }),
      );
    const edit = split(p);
    const tape = edit.envelope.allocations.find((a) => a.type === 'tape');
    if (!tape || tape.type !== 'tape') throw new Error();
    const endpoint = p.document.publication.status().publication!.native.marker(tape.end);
    addMarker(p, { tape: tape.id, ...endpoint.native, length: 0 });
    expect(diagnostics(p).ownership.lastReplayFrom).toBe(129);
    oracle.check(p.document, p.genesis);
    const undo = control(p, edit, false);
    expect(diagnostics(p).ownership.lastReplayFrom).toBe(128);
    oracle.check(p.document, p.genesis);
    control(p, edit, true, undo);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
}, 120000);

test('a suspended native-reader refinement stays private when a new receipt cancels it', () => {
  const p = open('abc\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    split(p);
    const before = p.document.publication.status().publication!;
    const owners = before.value.ownership.assignments,
      native = before.native.encodeState();
    const initial = diagnostics(p).ownership;
    const first = markerBody(p, tapeText(p, 'b'));
    p.document.certifyLocal(first);
    p.document.store.append(first);
    let work = p.document.publication.refresh(0);
    for (
      let i = 0;
      diagnostics(p).ownership.nativeMarkerRefinements === initial.nativeMarkerRefinements &&
      i < 100000;
      i++
    ) {
      if (work.state !== 'deferred') throw new Error('Published before the reader probe');
      work = work.continuation.resume(1);
    }
    expect(diagnostics(p).ownership.nativeMarkerRefinements).toBeGreaterThan(
      initial.nativeMarkerRefinements,
    );
    expect(diagnostics(p).ownership.lastReplayFrom).toBe(initial.lastReplayFrom);
    expect(p.document.publication.status().publication).toBe(before);
    const second = markerBody(p, tapeText(p, 'c'));
    p.document.certifyLocal(second);
    p.document.store.append(second);
    if (work.state !== 'deferred') throw new Error('Reader candidate escaped before cancellation');
    expect(() => work.continuation.resume(1)).toThrow(/invalidated/);
    p.editor.refresh();
    expect(before.value.ownership.assignments).toEqual(owners);
    expect(compareBytes(before.native.encodeState(), native)).toBe(0);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('withdrawing a retained marker uses conservative replay and leaves old publications intact', () => {
  const p = open('abc\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    split(p);
    const marker = addMarker(p, tapeText(p, 'b'));
    oracle.check(p.document, p.genesis);
    const before = p.document.publication.status().publication!;
    const owners = before.value.ownership.assignments,
      native = before.native.encodeState();
    const fallbacks = diagnostics(p).ownership.nativeMarkerFallbacks;
    p.document.store.append({ ...marker, groupId: { ...marker.groupId, sequence: 999n } });
    p.editor.refresh();
    expect(diagnostics(p).ownership).toMatchObject({
      lastReplayFrom: 0,
      nativeMarkerFallbacks: fallbacks + 1,
    });
    expect(before.value.ownership.assignments).toEqual(owners);
    expect(compareBytes(before.native.encodeState(), native)).toBe(0);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
});

for (const size of [10, 150])
  test(`structural suffix replay reads only changed native tapes among ${size} paragraphs`, () => {
    const p = open(Array.from({ length: size }, () => 'abc').join('\n\n'));
    try {
      const before = diagnostics(p).ownership;
      const edit = split(p);
      const after = diagnostics(p).ownership;
      expect(after.nativeTapeReads - before.nativeTapeReads).toBe(2);
      expect(after.cellTapesIndexed - before.cellTapesIndexed).toBe(2);
      const undo = control(p, edit, false);
      expect(diagnostics(p).ownership).toMatchObject({
        nativeTapeReads: after.nativeTapeReads,
        cellTapesIndexed: after.cellTapesIndexed,
      });
      control(p, edit, true, undo);
      expect(diagnostics(p).ownership).toMatchObject({
        nativeTapeReads: after.nativeTapeReads,
        cellTapesIndexed: after.cellTapesIndexed,
      });
      coldEqual(p);
    } finally {
      p.close();
    }
  }, 60000);

test('marker births outside transferred split-read intervals keep the committed prefix on the same tape', () => {
  const p = open('abcdef\n\nXYZ\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    applied(
      p.editor.edit(
        { local: 'transfer', group: 1n },
        (ctx, args) => {
          ctx.draft.transferInlineRange({ ...args, from: 2, to: 4, at: 1, affinity: 'right' });
          return { status: 'handled' };
        },
        { source: p.handle(p.nodes()[0]), destination: p.handle(p.nodes()[1]) },
      ),
    );
    applied(
      p.editor.edit({ local: 'interval-split', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[1]),
        from: 2,
      }),
    );
    expect(p.nodes().map((n) => n.content)).toEqual(['abef', 'Xc', 'dYZ', 'tail']);
    const before = p.document.publication.status().publication!,
      counts = diagnostics(p).ownership;
    const owners = before.value.ownership.assignments;
    const full = vi.spyOn(projector, 'projectWithActivity');
    try {
      addMarker(p, tapeText(p, 'a'));
      expect(full).not.toHaveBeenCalled();
      expect(diagnostics(p).ownership).toMatchObject({
        lastReplayFrom: 2,
        lastReplayLength: 1,
        nativeReaderInvalidations: counts.nativeReaderInvalidations,
      });
      expect(diagnostics(p).ownership.nativeIntervalSkips).toBeGreaterThan(
        counts.nativeIntervalSkips,
      );
    } finally {
      full.mockRestore();
    }
    expect(before.value.ownership.assignments).toEqual(owners);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
    const invalidations = diagnostics(p).ownership.nativeReaderInvalidations;
    const visits = diagnostics(p).ownership.nativeIntervalNodesVisited;
    addMarker(p, tapeText(p, 'd'));
    expect(diagnostics(p).ownership.nativeReaderInvalidations).toBe(invalidations + 1);
    expect(diagnostics(p).ownership.nativeIntervalNodesVisited).toBeGreaterThan(visits);
    expect(p.nodes().map((n) => n.content)).toEqual(['abef', 'Xc', 'dYZ', 'tail']);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
});
