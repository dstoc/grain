import { expect, test } from 'vitest';
import { resource } from '../actions/test-fixtures.js';
import { captureDiagnostics } from '../diagnostics.js';
import { MarkerIntervals } from './marker-intervals.js';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { deleteBlocks } from '../../../editing/commands/delete-blocks.js';
import { reconstructProvenance } from '../reference/provenance.js';
import { SubtreeDeletions } from './subtree-deletions.js';
import { resourceKey } from '../layout/index.js';

const tape = resource('tape', 0),
  position = (marker: { readonly ordinal: number }) => marker.ordinal * 2;
const interval = (i: number) => ({
  id: `r${i}`,
  range: { tape, start: resource('marker', i * 2), end: resource('marker', i * 2 + 1) },
  value: i,
});
test('dense native coverage queries and one contribution update follow persistent search paths', () => {
  let index = new MarkerIntervals<number>();
  const entries = Array.from({ length: 4096 }, (_, i) => interval(i));
  for (const entry of entries) index = index.add(entry, position);
  const held = index,
    target = entries[2048];
  const { value, report } = captureDiagnostics(() => {
    expect(index.at(position(target.range.start), position)).toEqual([2048]);
    return index.remove(target, position);
  });
  expect(report.work['driver/subtree.intervalQueryNodesVisited']).toBeLessThan(30);
  expect(report.work['driver/subtree.intervalNodesUpdated']).toBeLessThan(40);
  expect(value.at(position(target.range.start), position)).toEqual([]);
  expect(held.at(position(target.range.start), position)).toEqual([2048]);
  for (let i = 0; i < entries.length; i += 3) index = index.remove(entries[i], position);
  for (let i = 0; i < entries.length; i += 17)
    expect(index.at(position(entries[i].range.start), position)).toEqual(i % 3 ? [i] : []);
});

test('overlapping intervals keep gap endpoints and old roots across native subdivision', () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({
    ...interval(i),
    range: { tape, start: resource('marker', i), end: resource('marker', 80 - i) },
  }));
  let index = new MarkerIntervals<number>();
  for (const entry of entries.toReversed()) index = index.add(entry, position);
  const held = index;
  for (let point = 0; point <= 160; point++)
    expect(index.at(point, position).toSorted((a, b) => a - b)).toEqual(
      entries
        .filter((e) => position(e.range.start) <= point && point < position(e.range.end))
        .map((e) => e.value),
    );
  const middle = resource('marker', 1000),
    refined = (marker: { readonly ordinal: number }) =>
      marker.ordinal === middle.ordinal ? 41 : position(marker);
  const entry = {
    id: 'new',
    range: { tape, start: middle, end: resource('marker', 21) },
    value: 1000,
  };
  index = index.add(entry, refined);
  expect(index.at(41, refined)).toContain(1000);
  expect(held.at(41, refined)).not.toContain(1000);
  expect(index.at(42, refined)).not.toContain(1000);
  expect(index.remove(entry, refined).at(41, refined)).toEqual(held.at(41, refined));
});

test('indexed captured Unicode coverage matches independent tags without scalar native-position reads', () => {
  const p = commandReplica(commandGenesis('abc😀def\n\ntail'), undefined, 'materialized');
  try {
    expect(
      p.editor.edit({ local: 'split', group: 1n }, insertParagraph, {
        nodeId: p.handle(p.nodes()[0]),
        from: 3,
      }).status,
    ).toBe('applied');
    expect(
      p.editor.edit({ local: 'delete', group: 1n }, deleteBlocks, {
        nodeIds: [p.handle(p.nodes()[1])],
      }).status,
    ).toBe('applied');
    const publication = p.document.publication.status().publication!,
      value = publication.value,
      ownership = value.ownership,
      native = publication.native;
    const actions = [...value.activity.actions],
      coverage = reconstructProvenance(p.genesis.layout, actions).birthContent;
    const index = SubtreeDeletions.create(
      actions,
      ownership.nodeAllocations,
      coverage,
      value.activity,
      (marker) => native.marker(marker).index,
    );
    const { report } = captureDiagnostics(() => {
      for (const entry of value.visibility.text) {
        const tags = index
          .matches(entry.token, (range, token) => ownership.contains(range, token), {
            gap: () => native.marker(ownership.owner(entry.token).cell.start).index,
            position: (marker) => native.marker(marker).index,
          })
          .map((d) => d.tag);
        expect(tags).toEqual(entry.tags);
        expect(tags).toEqual(
          index
            .matches(entry.token, (range, token) => ownership.contains(range, token))
            .map((d) => d.tag),
        );
      }
    });
    expect(report.work['driver/subtree.intervalQueryNodesVisited']).toBeGreaterThan(0);
    expect(
      value.visibility.text.some(
        (e) =>
          e.tags.length &&
          resourceKey(e.token.tape) ===
            resourceKey(p.genesis.body.nativeManifest.find((b) => b.type === 'text')!.tape),
      ),
    ).toBe(true);
  } finally {
    p.close();
  }
});
