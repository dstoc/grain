import { expect, it } from 'vitest';
import { actorId } from '../contracts.js';
import type { ActionId, NodeId, OccurrenceId } from '../contracts.js';
import { orderOccurrences, resourceKey } from './occurrences.js';
import type { OrderedOccurrence } from './occurrences.js';
const root: NodeId = { kind: 'node', birth: { type: 'genesis', genesisId: 'G' }, ordinal: 0 };
function occurrence(
  ordinal: number,
  predecessor: OccurrenceId | null,
  rank?: number,
): OrderedOccurrence {
  const id: OccurrenceId = {
    kind: 'occurrence',
    birth: { type: 'genesis', genesisId: 'G' },
    ordinal,
  };
  const action: ActionId = { actor: actorId('01'.repeat(16)), sequence: BigInt(rank ?? 0) };
  return {
    id,
    slot: { parent: root, predecessor },
    order:
      rank === undefined ? null : { action: { id: action, lamport: BigInt(rank) }, ordinal: 0 },
  };
}
it('visits followers of ghosts and uses semantic priority, not resource ordinal or input order', () => {
  const a = occurrence(99, null);
  const b = occurrence(2, a.id);
  const older = occurrence(98, a.id, 1);
  const newer = occurrence(1, a.id, 2);
  const nested = occurrence(3, older.id, 3);
  const expected = [a, newer, older, nested, b];
  expect(orderOccurrences([b, nested, newer, a, older])).toEqual(expected);
  expect(orderOccurrences([...expected].reverse())).toEqual(expected);
  // Filtering out a moved/inactive occurrence must happen after visiting its subtree.
  expect(orderOccurrences(expected).filter((entry) => entry !== a && entry !== older)).toEqual([
    newer,
    nested,
    b,
  ]);
});
it('accepts same-effect chains but rejects ambiguous same-effect followers', () => {
  const a = occurrence(1, null, 1);
  const b = occurrence(2, a.id, 1);
  expect(orderOccurrences([b, a])).toEqual([a, b]);
  expect(() => orderOccurrences([a, occurrence(2, null, 1)])).toThrow('Equal-priority');
});
it('rejects missing, cross-sequence, future, duplicate and cyclic predecessors', () => {
  const a = occurrence(1, null);
  const b = occurrence(2, a.id);
  expect(() => orderOccurrences([b])).toThrow('missing');
  expect(() => orderOccurrences([a, a])).toThrow('Duplicate');
  expect(() =>
    orderOccurrences([a, { ...b, slot: { parent: { ...root, ordinal: 9 }, predecessor: a.id } }]),
  ).toThrow('sequence');
  const late = occurrence(3, null, 3);
  expect(() => orderOccurrences([late, occurrence(2, late.id, 2)])).toThrow('earlier');
  expect(() => orderOccurrences([{ ...a, slot: { parent: root, predecessor: b.id } }, b])).toThrow(
    'Cyclic',
  );
  expect(() => orderOccurrences([a, occurrence(2, null)])).toThrow('Genesis');
});
it('handles a 30,000-occurrence genesis chain without recursive traversal', () => {
  const entries: OrderedOccurrence[] = [];
  for (let i = 0; i < 30000; i++) entries.push(occurrence(i + 1, entries.at(-1)?.id ?? null));
  expect(orderOccurrences([...entries].reverse())).toEqual(entries);
});
it('uses logical equality for decoded IDs and separates delimiter-containing genesis names', () => {
  expect(resourceKey(root)).toBe(resourceKey(structuredClone(root)));
  expect(resourceKey(root)).not.toBe(
    resourceKey({ ...root, birth: { type: 'genesis', genesisId: 'G:0' } }),
  );
});
it('accepts a derived cut-order bucket, ranks it by earliest birth and preserves anchored followers', () => {
  const anchor = occurrence(1, null);
  const lateCut = occurrence(2, anchor.id, 4);
  const earlyCut = occurrence(3, anchor.id, 1);
  const ordinary = occurrence(4, anchor.id, 2);
  const follower = occurrence(5, lateCut.id, 5);
  const entries = [lateCut, ordinary, anchor, follower, earlyCut];
  expect(orderOccurrences(entries)).toEqual([anchor, lateCut, follower, ordinary, earlyCut]);
  expect(orderOccurrences(entries, [{ roots: [lateCut.id, earlyCut.id] }])).toEqual([
    anchor,
    ordinary,
    lateCut,
    follower,
    earlyCut,
  ]);
  expect(() => orderOccurrences(entries, [{ roots: [anchor.id] }])).toThrow('action occurrence');
  expect(() => orderOccurrences(entries, [{ roots: [] }])).toThrow('Empty');
  expect(() => orderOccurrences(entries, [{ roots: [earlyCut.id, follower.id] }])).toThrow(
    'sibling gap',
  );
  expect(() => orderOccurrences(entries, [{ roots: [earlyCut.id, earlyCut.id] }])).toThrow(
    'multiple',
  );
});
