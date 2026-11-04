import { afterEach, expect, test } from 'vitest';
import type { Allocation } from '../contracts.js';
import { ActionStore } from '../actions/store.js';
import { createIngestValidator } from '../ingest/index.js';
import { nativeView } from '../ingest/publication.js';
import { resourceKey } from '../layout/index.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import {
  createProjectionAuthorValidator,
  nativePointIndex,
  projectMarkdown,
  resolveAddress,
  textPoint,
} from './index.js';
import type { ViewNode } from './index.js';

const fixtures: NativeFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.destroy()));
const paragraph = (id: string, text: string) => ({
  id,
  parent: 'root',
  role: 'inline' as const,
  flow: `f${id}`,
  run: `r${id}`,
  tape: `t${id}`,
  cells: [...text].map((text, i) => ({ id: `${id}${i}`, text })),
});
function flatten(node: ViewNode): ViewNode[] {
  return [node, ...node.children.flatMap(flatten)];
}
function project(f: NativeFixture) {
  const actions = f.ready('C').map((name) => ({
    action: f.envelope(name),
    births: f.actions.get(name)!.births,
  }));
  const allocations = [
    ...f.genesis.allocations,
    ...actions.flatMap(({ action }) => action.allocations),
  ];
  return projectMarkdown({
    genesis: f.genesis,
    genesisManifest: f.bodies.get('G')!.nativeManifest,
    actions,
    native: nativeView(f.peers.get('C')!),
    // These creations have no captured content: each inline's birth coverage is its own home.
    birthContent: allocations
      .filter((a) => a.type === 'node')
      .map((a) => ({
        node: a.id,
        intervals: a.flow
          ? (
              allocations.find(
                (r) => r.type === 'run' && resourceKey(r.flow) === resourceKey(a.flow!),
              ) as Extract<Allocation, { type: 'run' }>
            ).skeleton
          : [],
      })),
  });
}
function assertReady(f: NativeFixture) {
  const validate = createIngestValidator({
    genesis: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
    validateAuthor: createProjectionAuthorValidator({
      genesis: f.genesis,
      births: (action) =>
        [...f.actions.values()].find(
          (e) =>
            e.action.id.actor === action.id.actor && e.action.id.sequence === action.id.sequence,
        )!.births,
    }),
  });
  const store = new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: f.genesis.allocations,
    validate,
  });
  try {
    for (const name of f.ready('C')) store.append(f.envelope(name));
    expect(store.snapshot().ready).toHaveLength(f.ready('C').length);
  } finally {
    store.destroy();
    validate.destroy();
  }
}

test.each([
  { undo: false, joined: false },
  { undo: false, joined: true },
  { undo: true, joined: false },
  { undo: true, joined: true },
])('fresh text address remains usable: %j', ({ undo, joined }) => {
  const f = new NativeFixture([{ id: 'root', parent: null, role: 'root' }, paragraph('P', 'a')]);
  fixtures.push(f);
  f.author('A1', (f) => {
    f.createBlock(paragraph('Q', ''), 'P:birth');
    return [];
  });
  f.deliver('A', 'B', ['A1']);
  f.author(
    'B1',
    (f) => [...f.insert('peer', 'b', 'Q:end'), ...(joined ? [f.join('fQ', 'P:end')] : [])],
    ['A1'],
    2n,
  );
  f.deliver('B', 'A', ['B1']);
  if (undo)
    f.author(
      'A2',
      () => [
        {
          type: 'SetGroupActive',
          group: f.envelope('A1').groupId,
          actions: [f.envelope('A1').id],
          active: false,
          previousControl: null,
        },
      ],
      ['A1', 'B1'],
      3n,
    );
  f.deliver('A', 'C', undo ? ['A1', 'A2'] : ['A1']);
  f.deliver('B', 'C', ['B1']);
  assertReady(f);
  const result = project(f);
  const visible = flatten(result.view.root).find(
    (n) => f.alias(n.origin.representative) === (joined ? 'P' : 'Q'),
  )!;
  expect(visible.content).toBe(joined ? 'ab' : 'b');
  const source = result.visibility.nodes.find((n) => f.alias(n.node) === 'Q')!;
  expect(source.available).toBe(!undo || !joined);
  expect(source.scaffold).toBe(undo && !joined);
  expect(source.suppressed).toBe(undo && joined);
  const point = textPoint(visible, joined ? 1 : 0, 'right');
  expect(nativePointIndex(point, nativeView(f.peers.get('C')!))).not.toBeNull();
  // The captured run is still Q's own run, not redirected to the current outer block.
  expect(f.alias(point.address.slot.run)).toBe('rQ');
  const resolution = resolveAddress(point.address, result.ownership, result.visibility);
  expect(resolution).toEqual({ state: 'available', address: point.address });
  expect(
    resolveAddress(
      { ...point.address, origin: f.contentRanges.get('P')![0]! },
      result.ownership,
      result.visibility,
    ).state,
  ).toBe('unavailable');
  f.fresh('C', undo ? ['A1', 'B1', 'A2', 'B1'] : ['A1', 'B1', 'B1']);
  const reconstructed = project(f);
  expect(reconstructed.view).toEqual(result.view);
  expect(resolveAddress(point.address, reconstructed.ownership, reconstructed.visibility)).toEqual(
    resolution,
  );
  f.slots.set('captured', point.address.slot);
  f.author(
    'C1',
    (f) => f.insert('next', '!', 'captured'),
    undo ? ['A2', 'B1'] : ['B1'],
    undo ? 4n : 3n,
  );
  assertReady(f);
  const afterResult = project(f);
  const after = flatten(afterResult.view.root).find(
    (n) => f.alias(n.origin.representative) === (joined ? 'P' : 'Q'),
  )!;
  expect(after.content).toBe(joined ? 'a!b' : '!b');
  f.fresh('C', undo ? ['A1', 'B1', 'A2', 'C1'] : ['A1', 'B1', 'C1']);
  expect(project(f).view).toEqual(afterResult.view);
});

test.each(['P', 'Q'])('joined text address is unavailable after deleting %s', (target) => {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    paragraph('P', 'a'),
    paragraph('Q', 'b'),
  ]);
  fixtures.push(f);
  f.author('A1', (f) => [f.join('fQ', 'P:end')]);
  f.deliver('A', 'C', ['A1']);
  const before = project(f);
  const point = textPoint(
    flatten(before.view.root).find((n) => n.content === 'ab')!,
    1,
    'right',
  );
  expect(resolveAddress(point.address, before.ownership, before.visibility).state).toBe(
    'available',
  );
  f.author(
    'C1',
    (f) => [f.deleteSubtree(target, f.contentRanges.get(target)!, ['A1'])],
    ['A1'],
    2n,
  );
  assertReady(f);
  const after = project(f);
  expect(resolveAddress(point.address, after.ownership, after.visibility)).toEqual({
    state: 'unavailable',
    address: point.address,
  });
  f.fresh('C', ['A1', 'C1']);
  const reconstructed = project(f);
  expect(reconstructed.view).toEqual(after.view);
  expect(
    resolveAddress(point.address, reconstructed.ownership, reconstructed.visibility).state,
  ).toBe('unavailable');
});
