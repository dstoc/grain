import { projectWithActivity } from '../projection/project.js';
import { reconstructProvenance } from '../reference/provenance.js';
import { resolveAddress } from '../projection/addresses.js';
import { capturePoint, resolveSelection, viewNodes } from '../history/selection.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { action as makeAction } from '../actions/test-fixtures.js';
import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import {
  replay,
  markers,
  firstTape,
  contentTape,
  refinementMap,
  rawObservation,
  emptyHomeCounterexample,
} from '../../../../test/multiwriter/structural-refinement.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { deleteBlocks, insertParagraph, insertText, joinWithPrevious } from '../authoring/index.js';
import type { LocalEditResult } from '../authoring/editor.js';

function applied(result: LocalEditResult) {
  expect(result.status).toBe('applied');
  if (result.status !== 'applied') throw new Error('Command failed');
  return result;
}
function split(p: CommandReplica, at = 2) {
  return applied(
    p.editor.session('split').edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: at }),
  );
}
function compare(p: CommandReplica, prior: ReturnType<typeof replay>) {
  const candidate = replay(p, prior.state);
  const independent = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'reference', {
    nativeDecodeOperations: 10_000_000,
  });
  try {
    const expected = independent.document.publication.status().publication!;
    expect(rawObservation(candidate.value)).toEqual(rawObservation(expected.value.ownership));
    const input = {
      genesis: p.genesis.layout,
      genesisManifest: p.genesis.body.nativeManifest,
      initialProperties: p.genesis.initialProperties,
      ...reconstructProvenance(p.genesis.layout, p.document.store.snapshot().ready),
      native: expected.native,
    };
    const projection = projectWithActivity(input, expected.value.activity, {
      ownership: candidate.value,
      snapshots: candidate.snapshots,
    });
    expect(projection.view).toEqual(expected.value.view);
    expect(projection.visibility).toEqual(expected.value.visibility);
    const candidatePublication = { ...expected, value: projection };
    const before = prior.publication;
    const oldAddresses = viewNodes(before.value.view.root).flatMap((n) => [
      ...n.boundaries.map((b) => b.address),
      ...n.fragments.map((f) => f.address),
    ]);
    const newAddresses = viewNodes(projection.view.root).flatMap((n) =>
      n.boundaries.map((b) => b.address),
    );
    for (const address of [...oldAddresses, ...newAddresses]) {
      expect(resolveAddress(address, candidate.value, projection.visibility)).toEqual(
        resolveAddress(address, expected.value.ownership, expected.value.visibility),
      );
      // Each new marker retains its native tape, containing old interval and
      // explicit side. Equal visible offsets do not collapse distinct gaps.
      if (address.type === 'text')
        expect(
          prior.index
            .tape(address.origin.tape)
            .some((c) => candidate.index.containsBoundary(c.range, address.slot.boundary)),
        ).toBe(true);
    }
    for (const node of viewNodes(before.value.view.root).filter((n) => n.boundaries.length))
      for (const affinity of ['left', 'right'] as const) {
        const point = capturePoint(before, node, 0, affinity);
        const saved = { anchor: point, focus: point };
        expect(resolveSelection(candidatePublication, saved)).toEqual(
          resolveSelection(expected, saved),
        );
      }
    const mapping = refinementMap(prior, candidate);
    for (const entry of mapping)
      for (const next of entry.next) expect(next.owner).toBe(entry.owner);
    return mapping;
  } finally {
    independent.close();
  }
}
for (const affinity of ['left', 'right'] as const)
  for (const position of [
    'interior',
    'leading-reserved',
    'trailing-reserved',
    'cut-boundary',
  ] as const)
    test(`native subdivision ${position}, affinity=${affinity}`, () => {
      const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized'),
        oracle = createMaterializationOracle();
      try {
        split(p, 3);
        const before = replay(p),
          tape = firstTape(p);
        const snapshot = p.document.publication.status().publication!.native.snapshot(tape);
        const cut = p.document.store
          .snapshot()
          .ready[0].effects.find((e) => e.type === 'SplitFlow');
        if (!cut || cut.type !== 'SplitFlow') throw new Error('Missing split');
        const native = p.document.publication.status().publication!.native;
        const index =
          position === 'interior'
            ? snapshot.parts.find((e) => e.type === 'text')!.index
            : position === 'leading-reserved'
              ? 1
              : position === 'trailing-reserved'
                ? snapshot.length - 1
                : native.marker(cut.cut.boundary).index + (affinity === 'right' ? 1 : 0);
        markers(p, tape, index, 1, affinity);
        compare(p, before);
        oracle.check(p.document, p.genesis);
      } finally {
        oracle.destroy();
        p.close();
      }
    });

test('empty home subdivision preserves distinct gaps through split, undo, redo and typing', () => {
  const p = commandReplica(commandGenesis('<!-- -->\n\ntail'), undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    const history = p.editor.session('split');
    split(p, 0);
    const before = replay(p),
      tape = firstTape(p);
    markers(p, tape, 1, 3);
    compare(p, before);
    oracle.check(p.document, p.genesis);
    expect(history.undo().state).toBe('applied');
    const dormant = replay(p);
    markers(p, tape, 2);
    compare(p, dormant);
    oracle.check(p.document, p.genesis);
    expect(history.redo().state).toBe('applied');
    oracle.check(p.document, p.genesis);
    applied(
      p.editor
        .session('typing')
        .edit(insertText, { nodeId: p.handle(p.nodes()[0]), from: 0, text: 'x' }),
    );
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('joined and transferred ranges retain ghost ordering under interior subdivision', () => {
  const p = commandReplica(commandGenesis('abc\n\nx\n\ny\n\ntail'), undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    applied(
      p.editor.session('transfer').edit(
        (
          ctx,
          input: { source: ReturnType<typeof p.handle>; destination: ReturnType<typeof p.handle> },
        ) => {
          ctx.draft.transferInlineRange({ ...input, from: 1, to: 2, at: 0, affinity: 'right' });
          return { status: 'handled' };
        },
        { source: p.handle(p.nodes()[0]), destination: p.handle(p.nodes()[1]) },
      ),
    );
    applied(p.editor.session('join').edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[2]) }));
    const before = replay(p),
      tape = contentTape(p, 'b'),
      native = p.document.publication.status().publication!.native;
    const text = p.genesis.body.nativeManifest.find((e) => e.type === 'text' && e.text === 'b')!;
    if (text.type !== 'text') throw new Error('Missing text');
    markers(p, tape, native.locate(tape, text.native));
    compare(p, before);
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

for (const markerCount of [1, 2])
  test(`joined empty home: ${markerCount} new markers exposes reserved classification`, () => {
    const result = emptyHomeCounterexample(markerCount),
      { p, before, candidate, source, split } = result;
    const oracle = createMaterializationOracle();
    try {
      expect(result.beforeText).toEqual(['a', 'bc']);
      const prefixReference = commandReplica(p.genesis, result.beforeCanonical, 'reference');
      try {
        expect(rawObservation(before.value)).toEqual(
          rawObservation(
            prefixReference.document.publication.status().publication!.value.ownership,
          ),
        );
      } finally {
        prefixReference.close();
      }
      oracle.check(p.document, p.genesis);
      const expected = p.document.publication.status().publication!.value.ownership;
      const text = (ownership: typeof expected, flow: NonNullable<typeof source.flow>) =>
        ownership
          .raw(flow)
          .flatMap((e) => (e.type === 'cell' ? e.fragments.map((f) => f.text) : []))
          .join('');
      const splitFlow = split.envelope.effects.find((e) => e.type === 'SplitFlow');
      if (splitFlow?.type !== 'SplitFlow' || !source.flow) throw new Error('No split');
      expect(text(candidate.value, source.flow)).toBe('a');
      expect(text(candidate.value, splitFlow.newFlow)).toBe('bc');
      if (markerCount === 1) {
        expect(p.nodes().map((n) => n.content)).toEqual(['a', 'bc']);
        compare(p, before);
      } else {
        // Expected failure of the commuting hypothesis, not a production regression.
        expect(p.nodes().map((n) => n.content)).toEqual(['ac', 'b']);
        expect(text(expected, source.flow)).toBe('ac');
        expect(text(expected, splitFlow.newFlow)).toBe('b');
        expect(rawObservation(candidate.value)).not.toEqual(rawObservation(expected));
        const c = p.genesis.body.nativeManifest.find((e) => e.type === 'text' && e.text === 'c');
        if (c?.type !== 'text') throw new Error('No c');
        expect(candidate.value.owner({ tape: c.tape, native: c.native }).run).toEqual(
          splitFlow.newRun,
        );
        expect(expected.owner({ tape: c.tape, native: c.native }).run).not.toEqual(
          splitFlow.newRun,
        );
        const oldInline = viewNodes(before.publication.value.view.root).find(
          (node) => node.content === 'bc',
        )!;
        const point = capturePoint(before.publication, oldInline, 1, 'right');
        const saved = { anchor: point, focus: point };
        const publication = p.document.publication.status().publication!;
        const input = {
          genesis: p.genesis.layout,
          genesisManifest: p.genesis.body.nativeManifest,
          initialProperties: p.genesis.initialProperties,
          ...reconstructProvenance(p.genesis.layout, p.document.store.snapshot().ready),
          native: publication.native,
        };
        const refinedProjection = projectWithActivity(input, publication.value.activity, {
          ownership: candidate.value,
          snapshots: candidate.snapshots,
        });
        expect(
          resolveAddress(point.address, candidate.value, refinedProjection.visibility).state,
        ).toBe('available');
        expect(resolveAddress(point.address, expected, publication.value.visibility).state).toBe(
          'available',
        );
        const actualCaret = resolveSelection(publication, saved);
        const refinedCaret = resolveSelection({ ...publication, value: refinedProjection }, saved);
        expect(actualCaret.state).toBe('exact');
        expect(refinedCaret.state).toBe('exact');
        if (actualCaret.state !== 'exact' || refinedCaret.state !== 'exact')
          throw new Error('Missing old caret');
        expect(actualCaret.anchor.origin.representative).toEqual(source.id);
        expect(refinedCaret.anchor.origin.representative).toEqual(splitFlow.newNode);
      }
    } finally {
      oracle.destroy();
      p.close();
    }
  });

test('marker-stable input and exact deletion preserve ownership while changing visibility', () => {
  const p = commandReplica(commandGenesis('abcdef\n\ntail'), undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    split(p, 3);
    const prior = replay(p);
    const edit = p.editor
      .session('replace')
      .edit(insertText, { nodeId: p.handle(p.nodes()[1]), from: 1, to: 2, text: 'X' });
    applied(edit);
    expect(
      edit.status === 'applied' && edit.envelope.allocations.some((a) => a.type === 'marker'),
    ).toBe(false);
    compare(p, prior);
    oracle.check(p.document, p.genesis);
    expect(p.nodes().map((n) => n.content)).toEqual(['abc', 'dXf', 'tail']);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('native cohort ranking, tied cuts and anchored followers survive subdivision in both deliveries', () => {
  const f = new NativeFixture(),
    oracle = createMaterializationOracle();
  try {
    f.author('A1', (f) => [f.split('P', 'R', 'P3')]);
    f.author('B1', (f) => [f.split('P', 'L', 'P1')]);
    f.author('C1', (f) => [f.split('P', 'M', 'P1')]);
    f.author(
      'B2',
      (f) => {
        f.createBlock({ id: 'F', parent: 'root', role: 'quote' }, 'L:birth');
        return [];
      },
      ['B1'],
      2n,
    );
    const genesis = {
      documentId: 'D',
      genesisId: 'G',
      layout: f.genesis,
      body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
      initialProperties: [],
    };
    const envelopes = new Map(
      [...f.actions].map(([name, entry]) => [
        name,
        {
          ...makeAction(entry.action.id.actor, entry.action.id.sequence),
          ...entry.action,
          ...f.bodies.get(name)!,
          allocations: entry.action.allocations,
          groupId: {
            session: { actor: entry.action.id.actor, local: 'cohort' },
            sequence: entry.action.id.sequence,
          },
        },
      ]),
    );
    for (const order of [
      ['A1', 'B1', 'B2', 'C1'],
      ['C1', 'B1', 'B2', 'A1'],
    ]) {
      const p = commandReplica(genesis, undefined, 'materialized');
      try {
        for (const name of order) {
          const envelope = envelopes.get(name)!;
          p.document.certifyLocal(envelope);
          p.document.store.append(envelope);
          p.editor.refresh();
        }
        oracle.check(p.document, p.genesis);
        expect(
          p.document.publication.status().publication!.value.ownership.buckets[0].roots,
        ).toHaveLength(3);
        const before = replay(p),
          tape = firstTape(p),
          snapshot = p.document.publication.status().publication!.native.snapshot(tape);
        markers(p, tape, snapshot.parts.find((e) => e.type === 'text')!.index, 2);
        compare(p, before);
        oracle.check(p.document, p.genesis);
        applied(
          p.editor.session('move').edit(
            (ctx, input: { nodeId: ReturnType<typeof p.handle> }) => {
              ctx.draft.place(input.nodeId, ctx.scopeRoot, null);
              return { status: 'handled' };
            },
            { nodeId: p.handle(p.nodes()[1]) },
          ),
        );
        oracle.check(p.document, p.genesis);
        const moved = replay(p);
        markers(p, tape, snapshot.parts.find((e) => e.type === 'text')!.index);
        compare(p, moved);
        oracle.check(p.document, p.genesis);
      } finally {
        p.close();
      }
    }
  } finally {
    oracle.destroy();
    f.destroy();
  }
});

test('a genuinely earlier concurrent join changes a historical component and cannot reuse its old decisions', () => {
  const genesis = commandGenesis('abcdef\n\nxyz\n\ntail');
  const p = commandReplica(genesis, undefined, 'materialized'),
    q = commandReplica(genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    applied(
      p.editor
        .session('prior')
        .edit(insertText, { nodeId: p.handle(p.nodes()[2]), from: 0, text: '!' }),
    );
    split(p, 2);
    const before = replay(p);
    applied(q.editor.session('join').edit(joinWithPrevious, { nodeId: q.handle(q.nodes()[1]) }));
    p.receive(q.document.store.encodeUpdate());
    oracle.check(p.document, p.genesis);
    expect(() => replay(p, before.state)).toThrow('Actions must enter in semantic order');
    q.receive(p.document.store.encodeUpdate());
    oracle.check(q.document, q.genesis);
    expect(q.markdown()).toBe(p.markdown());
  } finally {
    oracle.destroy();
    p.close();
    q.close();
  }
});

test('old invalid addresses stay invalid; new gaps preserve native meaning and Unicode rejection', () => {
  const p = commandReplica(commandGenesis('a😀b\n\n<!-- -->\n\ntail'), undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    const deletedNode = p.nodes()[1],
      deletedAddress = deletedNode.boundaries[0].address;
    applied(p.editor.session('delete').edit(deleteBlocks, { nodeIds: [p.handle(deletedNode)] }));
    const before = replay(p),
      tape = firstTape(p),
      native = before.publication.native;
    const allocation = p.genesis.layout.allocations.find((a) => a.type === 'tape')!;
    if (allocation.type !== 'tape') throw new Error('Missing tape');
    const good = p.nodes()[0].boundaries[0].address;
    const outside = {
      ...good,
      slot: { ...good.slot, boundary: deletedAddress.slot.boundary, side: 'left' as const },
    };
    const resolve = () => ({
      deleted: resolveAddress(
        deletedAddress,
        p.document.publication.status().publication!.value.ownership,
        p.document.publication.status().publication!.value.visibility,
      ).state,
      outside: resolveAddress(
        outside,
        p.document.publication.status().publication!.value.ownership,
        p.document.publication.status().publication!.value.visibility,
      ).state,
    });
    expect(resolve()).toEqual({ deleted: 'unavailable', outside: 'unavailable' });
    expect(() => before.index.adjacent(allocation.start, 'left')).toThrow(
      'outside permanent tape endpoints',
    );
    const part = native.snapshot(tape).parts.find((e) => e.type === 'text' && e.text === '😀');
    if (part?.type !== 'text') throw new Error('Missing emoji');
    expect(() => markers(p, tape, part.index + 1)).toThrow();
    expect(p.document.store.snapshot().ready).toHaveLength(1);
    markers(p, tape, part.index, 2);
    compare(p, before);
    expect(() => replay(p).index.adjacent(allocation.start, 'left')).toThrow(
      'outside permanent tape endpoints',
    );
    expect(resolve()).toEqual({ deleted: 'unavailable', outside: 'unavailable' });
    applied(
      p.editor
        .session('new-gap')
        .edit(insertText, { nodeId: p.handle(p.nodes()[0]), from: 1, text: 'X' }),
    );
    expect(p.nodes()[0].content).toBe('aX😀b');
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('two-marker subdivision without the interior join preserves the old selected component', () => {
  const p = commandReplica(commandGenesis('abc\n\n<!-- -->'), undefined, 'materialized');
  try {
    split(p, 1);
    const before = replay(p);
    const tape = p.genesis.layout.allocations.filter((a) => a.type === 'tape')[1];
    if (tape.type !== 'tape') throw new Error('No empty home');
    markers(p, tape.id, 1, 2);
    compare(p, before);
    expect(p.nodes().map((n) => n.content)).toEqual(['a', 'bc', '']);
  } finally {
    p.close();
  }
});
