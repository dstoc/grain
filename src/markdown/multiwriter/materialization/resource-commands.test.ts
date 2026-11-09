import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { control } from '../../../../test/multiwriter/commands/control.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { compareActions } from '../contracts.js';
import { compareBytes } from '../actions/cbor.js';
import { resourceKey } from '../layout/index.js';
import { MaterializedPublication } from './publication.js';

const open = (text: string) => commandReplica(commandGenesis(text), undefined, 'materialized');
function counts(p: CommandReplica) {
  if (!('ownershipDiagnostics' in p.document)) throw new Error();
  return p.document.ownershipDiagnostics();
}
function applied(result: ReturnType<CommandReplica['editor']['edit']>) {
  if (result.status !== 'applied') throw new Error('Expected applied command');
  return result;
}
function split(p: CommandReplica, group = 1n, from = 1) {
  return applied(
    p.editor.edit({ local: 'resource-split', group }, insertParagraph, {
      nodeId: p.handle(p.nodes()[0]),
      from,
    }),
  );
}
function coldEqual(p: CommandReplica) {
  const cold = commandReplica(p.genesis, p.document.store.encodeUpdate(), 'materialized');
  try {
    expect(cold.observe()).toEqual(p.observe());
  } finally {
    cold.close();
  }
}
for (const size of [10, 150])
  test(`structural resource work validates the suffix and changed tapes among ${size} paragraphs`, () => {
    const p = open(Array.from({ length: size }, () => 'abc').join('\n\n')),
      oracle = createMaterializationOracle();
    try {
      const before = counts(p),
        publication = p.document.publication.status().publication!;
      const native = publication.native.encodeState(),
        assignments = publication.value.ownership.assignments;
      const edit = split(p),
        after = counts(p);
      expect(after.allocationsIndexed - before.allocationsIndexed).toBe(
        edit.envelope.allocations.length,
      );
      expect(after.homesDerived - before.homesDerived).toBe(1);
      expect(after.homeTapesValidated - before.homeTapesValidated).toBe(2);
      expect(after.resourceRebuilds).toBe(before.resourceRebuilds);
      expect(after.snapshotMarkersValidated - before.snapshotMarkersValidated).toBeLessThan(
        before.snapshotMarkersValidated,
      );
      expect(after.skeletonCellsValidated - before.skeletonCellsValidated).toBeLessThan(
        before.skeletonCellsValidated,
      );
      oracle.check(p.document, p.genesis);
      const undo = control(p, edit, false);
      expect(counts(p)).toMatchObject({
        allocationsIndexed: after.allocationsIndexed,
        homesDerived: after.homesDerived,
        snapshotMarkersValidated: after.snapshotMarkersValidated,
        skeletonCellsValidated: after.skeletonCellsValidated,
        resourceRebuilds: after.resourceRebuilds,
        homeTapesValidated: after.homeTapesValidated,
      });
      oracle.check(p.document, p.genesis);
      control(p, edit, true, undo);
      expect(counts(p)).toMatchObject({
        snapshotMarkersValidated: after.snapshotMarkersValidated,
        resourceRebuilds: after.resourceRebuilds,
        homeTapesValidated: after.homeTapesValidated,
      });
      oracle.check(p.document, p.genesis);
      expect(compareBytes(publication.native.encodeState(), native)).toBe(0);
      expect(publication.value.ownership.assignments).toEqual(assignments);
      coldEqual(p);
    } finally {
      oracle.destroy();
      p.close();
    }
  }, 60000);

test('local text certificates remain usable by later structural replay and cache eviction', () => {
  const p = open('<!-- -->\n\ntail'),
    oracle = createMaterializationOracle();
  try {
    for (let i = 0; i < 3; i++)
      applied(
        p.editor.edit({ local: 'edge', group: BigInt(i + 1) }, insertText, {
          nodeId: p.handle(p.nodes()[0]),
          from: p.nodes()[0].content.length,
          text: '😀',
        }),
      );
    const edit = split(p, 1n, 2),
      before = counts(p);
    oracle.check(p.document, p.genesis);
    applied(
      p.editor.edit({ local: 'join', group: 1n }, joinWithPrevious, {
        nodeId: p.handle(p.nodes()[1]),
      }),
    );
    expect(counts(p).resourceRebuilds).toBe(before.resourceRebuilds);
    oracle.check(p.document, p.genesis);
    control(p, edit, false);
    oracle.check(p.document, p.genesis);
    const bytes = p.document.store.encodeUpdate();
    if (!(p.document.publication instanceof MaterializedPublication)) throw new Error();
    p.document.publication.evict();
    expect(compareBytes(bytes, p.document.store.encodeUpdate())).toBe(0);
    applied(
      p.editor.edit({ local: 'after-eviction', group: 1n }, insertText, {
        nodeId: p.handle(p.nodes()[0]),
        from: 0,
        text: 'z',
      }),
    );
    expect(counts(p).resourceRebuilds).toBe(before.resourceRebuilds + 1);
    oracle.check(p.document, p.genesis);
    coldEqual(p);
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('late earlier structural births rebuild resource order while retaining native identity', () => {
  const p = open('abc\n\ntail'),
    q = commandReplica(p.genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    const a = split(p),
      b = split(q);
    const later = compareActions(a.envelope, b.envelope) > 0 ? p : q,
      earlier = later === p ? q : p;
    const before = counts(later),
      publication = later.document.publication.status().publication!;
    const bytes = publication.native.encodeState();
    later.receive(earlier.document.store.encodeUpdate());
    expect(counts(later).resourceRebuilds).toBe(before.resourceRebuilds + 1);
    expect(compareBytes(publication.native.encodeState(), bytes)).toBe(0);
    // Addresses and ordered raw/native/visibility exports match independent full
    // replay, even though the earlier action's tape arrived after the later one.
    oracle.check(later.document, later.genesis);
    const ready = later.document.store.snapshot().ready;
    expect(
      ready.flatMap((action) =>
        action.allocations.filter((a) => a.type === 'tape').map((a) => resourceKey(a.id)),
      ),
    ).toHaveLength(2);
    coldEqual(later);
  } finally {
    oracle.destroy();
    q.close();
    p.close();
  }
});
