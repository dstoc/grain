import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { markers, firstTape } from '../../../../benchmarks/multiwriter/structural-refinement.js';
import { captureDiagnostics } from '../diagnostics.js';
import { compareBytes } from '../actions/cbor.js';
import { textPoint, resolveAddress } from '../projection/addresses.js';
import type { ActionEnvelope, ActionId, NodeId } from '../contracts.js';
import type { OwnershipResult } from '../ownership/ownership.js';

const publication = (p: CommandReplica) => p.document.publication.status().publication!;
function selected(ownership: OwnershipResult, parents: readonly NodeId[]) {
  return parents.map((parent) => ({
    children: ownership.children(parent),
    order: ownership.occurrenceOrder({ parent, predecessor: null }),
  }));
}
function check(p: CommandReplica) {
  const canonical = p.document.store.encodeUpdate(),
    current = publication(p),
    cold = commandReplica(p.genesis, canonical, 'reference');
  try {
    const expected = publication(cold),
      parents = current.value.ownership.nodeAllocations.map((n) => n.id);
    expect(current.value.view).toEqual(expected.value.view);
    expect(current.value.visibility).toEqual(expected.value.visibility);
    expect(current.value.ownership.assignments).toEqual(expected.value.ownership.assignments);
    expect(current.value.ownership.destinationRequirements).toEqual(
      expected.value.ownership.destinationRequirements,
    );
    const read = () => selected(current.value.ownership, parents);
    const beforeExport = captureDiagnostics(read);
    expect(beforeExport.report.work['driver/ownership.cohortExportCalls'] ?? 0).toBe(0);
    expect(beforeExport.value).toEqual(selected(expected.value.ownership, parents));
    expect(current.value.ownership.buckets).toEqual(expected.value.ownership.buckets);
    const afterExport = captureDiagnostics(read);
    expect(afterExport.report.work['driver/ownership.cohortExportCalls'] ?? 0).toBe(0);
    expect(afterExport.value).toEqual(beforeExport.value);
    expect(compareBytes(current.native.encodeState(), expected.native.encodeState())).toBe(0);
    expect(compareBytes(p.document.store.encodeUpdate(), canonical)).toBe(0);
  } finally {
    cold.close();
  }
}

for (const depth of [0, 4, 12])
  describe(`fixed root with unrelated nested cohort inventory (${depth})`, () => {
    let p: CommandReplica;
    beforeAll(() => {
      p = commandReplica(
        commandGenesis(`localabcdef\n\n> ${'x'.repeat(40)}\n\ntail`),
        undefined,
        'materialized',
      );
      const setup = p.editor.session('nested');
      for (let i = 0; i < depth; i++) {
        const paragraph = p.view().root.children[1].children.at(-1)!;
        expect(setup.edit(insertParagraph, { nodeId: p.handle(paragraph), from: 1 }).status).toBe(
          'applied',
        );
      }
    });
    afterAll(() => p?.close());
    test('split uses selected readers and preserves complete old/new observations', () => {
      const held = publication(p),
        heldView = structuredClone(held.value.view),
        heldVisibility = structuredClone(held.value.visibility),
        heldNative = held.native.encodeState(),
        root = held.value.view.root.origin.representative,
        quote = p.view().root.children[1],
        parents = [root, quote.origin.representative],
        heldSelected = selected(held.value.ownership, parents),
        address = textPoint(p.nodes().at(-1)!, 1, 'right').address;
      expect(p.view().root.children).toHaveLength(3);
      const { value, report } = captureDiagnostics(() =>
        p.editor.session('local').edit(insertParagraph, {
          nodeId: p.handle(p.nodes()[0]),
          from: 3,
        }),
      );
      expect(value.status).toBe('applied');
      expect(p.view().root.children).toHaveLength(4);
      expect(p.view().root.children[2]).toBe(quote);
      expect(report.work['publication/projection.localStructuralCandidates']).toBe(1);
      for (const counter of [
        'projection.fullProjectors',
        'provenance.fullReconstructions',
        'ownership.cohortExportCalls',
        'ownership.cohortsExported',
      ])
        expect(report.work[`publication/${counter}`] ?? 0, counter).toBe(0);
      for (const counter of [
        'cohortSelectedEntriesVisited',
        'cohortSelectedBucketsCopied',
        'cohortSelectedRootsCopied',
      ])
        expect(report.work[`publication/ownership.${counter}`] ?? 0, counter).toBe(0);
      for (let repeat = 0; repeat < 3; repeat++) {
        const reads = captureDiagnostics(() => selected(publication(p).value.ownership, parents));
        expect(reads.report.work['driver/ownership.cohortExportCalls'] ?? 0).toBe(0);
      }
      const uncached = captureDiagnostics(() => publication(p).value.ownership.buckets);
      expect(uncached.report.work['driver/ownership.cohortsExported']).toBe(depth + 1);
      check(p);
      expect(held.value.view).toEqual(heldView);
      expect(held.value.visibility).toEqual(heldVisibility);
      expect(selected(held.value.ownership, parents)).toEqual(heldSelected);
      expect(compareBytes(held.native.encodeState(), heldNative)).toBe(0);
      expect(resolveAddress(address, held.value.ownership, held.value.visibility).state).toBe(
        'available',
      );
      const full = captureDiagnostics(() => publication(p).value.ownership.buckets);
      expect(full.report.work['driver/ownership.cohortExportCalls']).toBe(1);
      expect(full.report.work['driver/ownership.cohortsExported'] ?? 0).toBe(0); // Already cached by check().
    });
  });

for (const reverse of [false, true])
  test(`nonempty cohorts at two parents survive retraction, history, refinement and cold reseeding (${reverse})`, () => {
    const f = new NativeFixture([
      { id: 'root', parent: null, role: 'root' },
      {
        id: 'P',
        parent: 'root',
        role: 'inline',
        flow: 'fP',
        run: 'rP',
        tape: 'tP',
        cells: [...'abcdef'].map((text, i) => ({ id: `P${i}`, text })),
      },
      { id: 'Q', parent: 'root', role: 'quote' },
      {
        id: 'S',
        parent: 'Q',
        role: 'inline',
        flow: 'fS',
        run: 'rS',
        tape: 'tS',
        cells: [...'uvwxyz'].map((text, i) => ({ id: `S${i}`, text })),
      },
    ]);
    f.author('A1', (f) => [f.split('P', 'R', 'P3')]);
    f.author('B1', (f) => [f.split('P', 'L', 'P1')]);
    f.author('C1', (f) => [f.split('S', 'T', 'S3', 'left', 'Q')]);
    f.author('A2', (f) => [f.split('S', 'U', 'S1', 'left', 'Q')], ['A1'], 2n);
    const genesis = {
        documentId: 'D',
        genesisId: 'G',
        layout: f.genesis,
        body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
        initialProperties: [],
      },
      p = commandReplica(genesis, undefined, 'materialized');
    try {
      for (const name of reverse ? ['C1', 'B1', 'A1', 'A2'] : ['A1', 'B1', 'C1', 'A2']) {
        const envelope = f.envelope(name);
        p.document.certifyLocal(envelope);
        p.document.store.append(envelope);
        p.editor.refresh();
        check(p);
      }
      expect(publication(p).value.ownership.buckets).toHaveLength(2);
      const held = publication(p),
        parents = held.value.ownership.nodeAllocations.map((n) => n.id),
        oldSelected = selected(held.value.ownership, parents),
        oldBuckets = held.value.ownership.buckets,
        quote = p.view().root.children.find((n) => n.type === 'block-quote')!;
      const destination = quote.origin.representative;
      const allocation = held.value.ownership.nodeAllocation(f.id('L', 'node'));
      check(p);
      const read = captureDiagnostics(() => selected(held.value.ownership, [destination]));
      expect(read.report.work['driver/ownership.cohortSelectedEntriesVisited']).toBe(2);
      expect(read.report.work['driver/ownership.cohortSelectedRootsCopied']).toBe(4);
      const h = p.editor.session('move');
      expect(
        h.edit((ctx) => {
          ctx.draft.place(p.editor.handle(allocation.id), p.editor.handle(destination), null);
          return { status: 'handled' };
        }, undefined).status,
      ).toBe('applied');
      expect(publication(p).value.ownership.buckets).toHaveLength(1);
      check(p);
      expect(h.undo().state).toBe('applied');
      expect(publication(p).value.ownership.buckets).toHaveLength(2);
      check(p);
      expect(h.redo().state).toBe('applied');
      check(p);
      expect(
        p.editor.session('text').edit(insertText, {
          nodeId: p.handle(p.nodes().at(-1)!),
          from: 1,
          text: 'X',
        }).status,
      ).toBe('applied');
      check(p); // Native text-refinement constructor.
      markers(p, firstTape(p), 2);
      check(p); // Marker-only native refinement.
      expect(selected(held.value.ownership, parents)).toEqual(oldSelected);
      expect(held.value.ownership.buckets).toEqual(oldBuckets);
      if (!('evict' in p.document.publication))
        throw new Error('Expected materialized publication');
      p.document.publication.evict();
      p.editor.refresh();
      check(p);
      expect(selected(held.value.ownership, parents)).toEqual(oldSelected);
    } finally {
      p.close();
      f.destroy();
    }
  });

for (const width of [1, 4, 12])
  describe(`fixed root beside ${width} nonempty quote cohorts`, () => {
    let f: NativeFixture, p: CommandReplica;
    beforeAll(() => {
      f = new NativeFixture([
        { id: 'root', parent: null, role: 'root' },
        {
          id: 'P',
          parent: 'root',
          role: 'inline',
          flow: 'fP',
          run: 'rP',
          tape: 'tP',
          cells: [...'localabcdef'].map((text, i) => ({ id: `P${i}`, text })),
        },
        { id: 'Q', parent: 'root', role: 'quote' },
        ...Array.from({ length: width }, (_, i) => ({
          id: `S${i}`,
          parent: 'Q',
          role: 'inline' as const,
          flow: `fS${i}`,
          run: `rS${i}`,
          tape: `tS${i}`,
          cells: [...'uvwxyz'].map((text, j) => ({ id: `S${i}:${j}`, text })),
        })),
        {
          id: 'Z',
          parent: 'root',
          role: 'inline',
          flow: 'fZ',
          run: 'rZ',
          tape: 'tZ',
          cells: [{ id: 'Z0', text: 'tail' }],
        },
      ]);
      for (const [name, prefix, cut] of [
        ['A1', 'R', 3],
        ['B1', 'L', 1],
      ] as const)
        f.author(name, (f) =>
          Array.from({ length: width }, (_, i) =>
            f.split(`S${i}`, `${prefix}${i}`, `S${i}:${cut}`, 'left', 'Q'),
          ),
        );
      const genesis = {
        documentId: 'D',
        genesisId: 'G',
        layout: f.genesis,
        body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
        initialProperties: [],
      };
      p = commandReplica(genesis, undefined, 'materialized');
      for (const name of ['A1', 'B1']) {
        const envelope = f.envelope(name);
        p.document.certifyLocal(envelope);
        p.document.store.append(envelope);
        p.editor.refresh();
      }
    });
    afterAll(() => {
      p?.close();
      f?.destroy();
    });
    test('selected work follows its parent and local publication visits no unrelated cohort', () => {
      const held = publication(p),
        root = f.id('root', 'node'),
        quote = f.id('Q', 'node'),
        saved = selected(held.value.ownership, [root, quote]),
        quoteView = p.view().root.children[1];
      expect(p.view().root.children).toHaveLength(3);
      const rootReads = captureDiagnostics(() => selected(held.value.ownership, [root]));
      expect(rootReads.report.work['driver/ownership.cohortSelectedEntriesVisited'] ?? 0).toBe(0);
      const quoteReads = captureDiagnostics(() => selected(held.value.ownership, [quote]));
      expect(quoteReads.report.work['driver/ownership.cohortSelectedEntriesVisited']).toBe(
        2 * width,
      );
      expect(quoteReads.report.work['driver/ownership.cohortSelectedBucketsCopied']).toBe(
        2 * width,
      );
      expect(quoteReads.report.work['driver/ownership.cohortSelectedRootsCopied']).toBe(4 * width);
      expect(quoteReads.report.work['driver/ownership.cohortExportCalls'] ?? 0).toBe(0);
      const { value, report } = captureDiagnostics(() =>
        p.editor.session('local').edit(insertParagraph, {
          nodeId: p.handle(p.nodes()[0]),
          from: 3,
        }),
      );
      expect(value.status).toBe('applied');
      expect(p.view().root.children).toHaveLength(4);
      expect(p.view().root.children[2]).toBe(quoteView);
      for (const name of [
        'cohortExportCalls',
        'cohortsExported',
        'cohortSelectedEntriesVisited',
        'cohortSelectedRootsCopied',
      ])
        expect(report.work[`publication/ownership.${name}`] ?? 0, name).toBe(0);
      expect(report.work['publication/projection.fullProjectors'] ?? 0).toBe(0);
      expect(report.work['publication/provenance.fullReconstructions'] ?? 0).toBe(0);
      expect(publication(p).value.ownership.buckets).toHaveLength(width);
      check(p);
      expect(selected(held.value.ownership, [root, quote])).toEqual(saved);
    });
  });

test('property and allocating-action controls keep selected nonempty roots coherent', () => {
  const f = new NativeFixture();
  f.author('A1', (f) => [f.split('P', 'R', 'P3')]);
  f.author('B1', (f) => [f.split('P', 'L', 'P1')]);
  const genesis = {
    documentId: 'D',
    genesisId: 'G',
    layout: f.genesis,
    body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
    initialProperties: [{ node: f.id('P', 'node'), values: { presentation: 'code' as const } }],
  };
  const p = commandReplica(genesis, undefined, 'materialized');
  try {
    for (const name of ['A1', 'B1']) {
      const envelope = f.envelope(name);
      p.document.certifyLocal(envelope);
      p.document.store.append(envelope);
      p.editor.refresh();
    }
    const held = publication(p),
      root = f.id('root', 'node'),
      saved = selected(held.value.ownership, [root]);
    expect(held.value.ownership.buckets).toHaveLength(1);
    const { value, report } = captureDiagnostics(() =>
      p.editor.session('property').edit((ctx) => {
        ctx.draft.setInfo(p.editor.handle(f.id('P', 'node')), 'js');
        return { status: 'handled' };
      }, undefined),
    );
    expect(value.status).toBe('applied');
    expect(report.work['publication/ownership.cohortExportCalls'] ?? 0).toBe(0);
    check(p);
    let previousControl: ActionId | null = null;
    const target = f.envelope('A1');
    for (const active of [false, true]) {
      const ready = p.document.store.snapshot().ready,
        sequence =
          ready
            .filter((a) => a.id.actor === target.id.actor)
            .reduce((n, a) => (a.id.sequence > n ? a.id.sequence : n), 0n) + 1n;
      const envelope: ActionEnvelope = {
        ...target,
        id: { ...target.id, sequence },
        lamport: ready.reduce((n, a) => (a.lamport > n ? a.lamport : n), 0n) + 1n,
        dependencies: ready.map((a) => a.id),
        groupId: { ...target.groupId, sequence: sequence + 1000n },
        allocations: [],
        nativeInsertUpdates: [],
        nativeManifest: [],
        effects: [
          {
            type: 'SetGroupActive' as const,
            group: target.groupId,
            actions: [target.id],
            active,
            previousControl,
          },
        ],
      };
      p.document.certifyLocal(envelope);
      p.document.store.append(envelope);
      p.editor.refresh();
      previousControl = envelope.id;
      check(p);
      expect(selected(held.value.ownership, [root])).toEqual(saved);
    }
  } finally {
    p.close();
    f.destroy();
  }
});
