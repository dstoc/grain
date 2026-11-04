import { afterEach, describe, expect, test } from 'vitest';
import { parseBlocks } from '../../block-parser/api.js';
import { contractCorpus } from '../../../../test/multiwriter/corpus.js';
import type { Intent, SeedBlock } from '../../../../test/multiwriter/trace.js';
import type { Allocation, InterpretationPacket, SemanticEffect } from '../contracts.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { resourceKey } from '../layout/index.js';
import { nativeView } from '../ingest/publication.js';
import {
  bindParserConversion,
  prepareParserConversion,
  deletionTargets,
  nativePointIndex,
  projectMarkdown,
  requestEmptyRootEdit,
  resolveAddress,
  selectionRanges,
  serializeProjection,
  textPoint,
  wrapperBoundary,
} from './index.js';
import type { ViewNode } from './index.js';

const fixtures: NativeFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.destroy()));
const paragraph = (id: string, text: string, parent = 'root'): SeedBlock => ({
  id,
  parent,
  role: 'inline',
  flow: `f${id}`,
  run: `r${id}`,
  tape: `t${id}`,
  cells: [...text].map((text, i) => ({ id: `${id}${i}`, text })),
});
function fixture(
  seed: readonly SeedBlock[] = [
    { id: 'root', parent: null, role: 'root' },
    paragraph('P', '# x😀'),
    paragraph('Q', '# x😀'),
  ],
) {
  const f = new NativeFixture(seed);
  fixtures.push(f);
  return f;
}
function author(
  f: NativeFixture,
  name: string,
  build: (f: NativeFixture) => readonly SemanticEffect[],
  deps: readonly string[] = [],
  lamport = 1n,
) {
  const entry = f.author(name, build, deps, lamport);
  const extra: Allocation[] = entry.action.effects.flatMap((effect): Allocation[] => {
    if (effect.type === 'Interpret') return [{ type: 'interpretation', id: effect.packet.id }];
    if (
      (effect.type === 'DeleteText' || effect.type === 'DeleteSubtree') &&
      !entry.action.allocations.some((a) => resourceKey(a.id) === resourceKey(effect.tag))
    )
      return [{ type: 'deletion', id: effect.tag }];
    return [];
  });
  f.actions.set(name, {
    ...entry,
    action: { ...entry.action, allocations: [...entry.action.allocations, ...extra] },
  });
  for (const [alias, range] of f.ranges) {
    try {
      const text = f.peers.get(name[0])!.range(range);
      if (text.length === 1) f.aliases.set(alias, text[0]!.range);
    } catch {
      /* A different peer may own the range's unreceived allocation. */
    }
  }
}
function packet(
  f: NativeFixture,
  name: string,
  source = 'Q',
  presentation: 'section' | 'code' | 'paragraph' = 'section',
  extra: Partial<InterpretationPacket> = {},
): SemanticEffect {
  return {
    type: 'Interpret',
    packet: {
      id: f.allocate(name, 'interpretation'),
      source: f.id(source, 'node'),
      properties: { presentation, marker: presentation === 'section' ? '#' : null, info: null },
      wrappers: [],
      placements: [],
      syntaxMask:
        presentation === 'section'
          ? [f.aliases.get(`${source}0`)!, f.aliases.get(`${source}1`)!]
          : [],
      synthesizedText: [],
      ...extra,
    },
  };
}
function control(
  f: NativeFixture,
  target: string,
  active: boolean,
  previous: string | null = null,
): SemanticEffect {
  const envelope = f.envelope(target);
  return {
    type: 'SetGroupActive',
    group: envelope.groupId,
    actions: [envelope.id],
    active,
    previousControl: previous ? f.envelope(previous).id : null,
  };
}
function projectionInput(
  f: NativeFixture,
  peer = 'C',
  initialProperties: Parameters<typeof projectMarkdown>[0]['initialProperties'] = [],
) {
  const actions = f
    .ready(peer)
    .map((name) => ({ action: f.envelope(name), births: f.actions.get(name)!.births }));
  const allocations = [
    ...f.genesis.allocations,
    ...actions.flatMap(({ action }) => action.allocations),
  ];
  // Fixture births retain their exact author-captured source/home intervals. No query
  // derives inherited deletion coverage from the merged owner of a character.
  const birthContent = allocations
    .filter((entry) => entry.type === 'node')
    .map((entry) => ({
      node: entry.id,
      intervals: entry.flow
        ? (
            allocations.find(
              (a) => a.type === 'run' && resourceKey(a.flow) === resourceKey(entry.flow!),
            ) as Extract<Allocation, { type: 'run' }>
          ).skeleton
        : [],
    }));
  return {
    genesis: f.genesis,
    genesisManifest: f.bodies.get('G')!.nativeManifest,
    actions,
    native: nativeView(f.peers.get(peer)!),
    birthContent,
    initialProperties,
  };
}
function project(...args: Parameters<typeof projectionInput>) {
  return projectMarkdown(projectionInput(...args));
}
function flatten(node: ViewNode): ViewNode[] {
  return [node, ...node.children.flatMap(flatten)];
}
function node(result: ReturnType<typeof project>, f: NativeFixture, name: string) {
  return flatten(result.view.root).find(
    (node) => resourceKey(node.origin.representative) === resourceKey(f.id(name, 'node')),
  )!;
}
function output(result: ReturnType<typeof project>) {
  return serializeProjection(result.view);
}
function snapshot(f: NativeFixture, peer = 'C') {
  return {
    actions: structuredClone([...f.actions]),
    bodies: structuredClone([...f.bodies]),
    native: [
      ...f.genesis.allocations,
      ...f.ready(peer).flatMap((name) => f.envelope(name).allocations),
    ]
      .filter((entry) => entry.type === 'tape')
      .map((entry) => f.peers.get(peer)!.snapshot(entry.id)),
  };
}

// These execute the five frozen MW-06 facets through real native caches and reducers.
// They are not the general MW-08 replica factory or MW-09 command/history adapter.
describe('frozen corpus projection facets', () => {
  const names = [
    'losing-interpretation-restores-only-own-mask',
    'joined-interpretation-keeps-lineage-mask',
    'normalized-wrapper-addresses',
    'empty-root-creates-two-independent-paragraphs',
    'undone-wrapper-scaffolds-peer-child',
  ];
  for (const trace of contractCorpus.filter((trace) => names.includes(trace.id)))
    test(trace.id, () => {
      const f = fixture(trace.seed);
      function lower(intent: Intent): readonly SemanticEffect[] {
        switch (intent.type) {
          case 'interpret':
            return [
              packet(f, intent.packet, intent.source, intent.presentation, {
                syntaxMask: intent.mask.map((id) => f.aliases.get(id)!),
                wrappers: intent.wrappers.map((id) => f.id(id, 'node')),
              }),
            ];
          case 'join':
            return [f.join(intent.source, intent.destinationSlot)];
          case 'create':
            f.createBlock(intent.block, intent.predecessor);
            return [];
          case 'delete-subtree':
            return [
              f.deleteSubtree(
                intent.target,
                intent.coveredCells.map((id) => f.ranges.get(id)!),
                [],
              ),
            ];
          case 'control':
            return [control(f, intent.group, intent.active, intent.previous)];
          default:
            throw new Error(`Unsupported MW-06 facet intent ${intent.type}`);
        }
      }
      for (const step of trace.steps) {
        if (step.type === 'author')
          author(
            f,
            step.action.id,
            () => step.action.intents.flatMap(lower),
            step.action.dependencies,
            step.action.lamport,
          );
        else if (step.type === 'deliver') f.deliver(step.from, step.to, step.actions);
        else if (step.type === 'expect') {
          const before = snapshot(f, step.peer);
          const result = project(f, step.peer);
          const viewNodes = flatten(result.view.root).slice(1);
          const visible = Object.fromEntries(
            viewNodes
              .filter((n) => ['paragraph', 'section', 'code-block'].includes(n.type))
              .map((n) => [
                f.alias(n.origin.representative),
                n.fragments
                  .filter((fragment) => fragment.visible)
                  .map(
                    (fragment) =>
                      [...f.aliases].find(
                        ([, range]) =>
                          resourceKey(range.tape) === resourceKey(fragment.range.tape) &&
                          range.client === fragment.range.client &&
                          range.clock === fragment.range.clock,
                      )![0],
                  ),
              ]),
          );
          const actual: Record<string, unknown> = {
            view: viewNodes.map((n) => ({
              id: f.alias(n.origin.representative),
              parent: f.alias(
                flatten(result.view.root).find((parent) => parent.children.includes(n))!.origin
                  .representative,
              ),
              kind: n.type,
            })),
            rawParents: Object.fromEntries(
              result.ownership.nodeAllocations.map((n) => [
                f.alias(n.id),
                result.ownership.blockPlacement(n.id)?.slot.parent
                  ? f.alias(result.ownership.blockPlacement(n.id)!.slot.parent)
                  : null,
              ]),
            ),
            visible,
            hidden: [...f.aliases.keys()]
              .filter((id) => !Object.values(visible).flat().includes(id))
              .sort(),
            deletedNodes: result.visibility.nodes
              .filter((n) => n.deleted)
              .map((n) => f.alias(n.node)),
            activePackets: result.interpretations.packets.map((packet) => f.alias(packet.id)),
            nativeText: Object.fromEntries(
              [...f.aliases].map(([id, range]) => [
                id,
                f.peers
                  .get(step.peer)!
                  .lookup(range)
                  .map((part) => part.text)
                  .join(''),
              ]),
            ),
            flowParents: Object.fromEntries(
              result.ownership.flowPlacements.map((flow) => [
                f.alias(flow.flow),
                flow.parent.type === 'block'
                  ? `block:${f.alias(flow.parent.node)}`
                  : `flow:${f.alias(result.ownership.runLayouts.find((run) => resourceKey(run.run) === resourceKey(flow.parent.type === 'flow' ? flow.parent.slot.run : null!))!.flow)}@P:end`,
              ]),
            ),
            markdown: output(result),
            genesis:
              result.view.root.origin.representative.birth.type === 'genesis'
                ? result.view.root.origin.representative.birth.genesisId
                : '',
            emittedActions: [],
            held: f.ready(step.peer),
            heads: [],
          };
          if (step.state.addresses) {
            const addresses: Record<string, unknown> = {};
            for (const n of viewNodes) {
              if (n.wrappers.length)
                addresses[f.alias(n.origin.representative)] = {
                  type: 'group',
                  representative: f.alias(n.origin.representative),
                  constituents: n.origin.constituents.map((id) => f.alias(id)),
                };
              for (const boundary of n.boundaries) {
                const alias = [...f.slots].find(
                  ([, slot]) =>
                    resourceKey(slot.run) === resourceKey(boundary.address.slot.run) &&
                    resourceKey(slot.boundary) === resourceKey(boundary.address.slot.boundary) &&
                    slot.side === boundary.address.slot.side,
                )?.[0];
                if (alias?.endsWith(':start'))
                  addresses[alias] = {
                    type: 'slot',
                    run: f.alias(boundary.address.slot.run),
                    slot: alias,
                  };
              }
            }
            if (result.view.emptyRoot)
              addresses.caret = {
                type: 'empty-root',
                parent: f.alias(result.view.emptyRoot.slot.parent),
                predecessor: null,
              };
            for (const [key, expected] of Object.entries(step.state.addresses))
              expect(addresses[key], key).toEqual(expected);
          }
          for (const [key, expected] of Object.entries(step.state))
            if (key !== 'addresses') expect(actual[key], key).toEqual(expected);
          expect(snapshot(f, step.peer)).toEqual(before);
        }
      }
    });
});

test('exact masks survive joins, partial transfers and checkpoint reconstruction', () => {
  const f = fixture();
  author(f, 'A1', (f) => [packet(f, 'heading')]);
  author(f, 'A2', (f) => [f.transfer(['Q0', 'Q1', 'Q2'], 'P:end', 'transfer')], ['A1'], 2n);
  f.deliver('A', 'C', ['A1', 'A2']);
  const first = project(f);
  expect(node(first, f, 'P').content).toBe('# x😀x');
  expect(node(first, f, 'Q').content).toBe('😀');
  expect(selectionRanges(node(first, f, 'P'), 5, 6)).toEqual([f.aliases.get('Q2')]);
  expect(first.interpretations.masks).toEqual([f.aliases.get('Q0'), f.aliases.get('Q1')]);
  const before = snapshot(f);
  f.fresh('C', ['A2', 'A1', 'A1']);
  expect(project(f).view).toEqual(first.view);
  expect(snapshot(f)).toEqual(before);
});

test('concurrent insertion inside syntax stays literal; properties do not retract masks', () => {
  const f = fixture();
  author(f, 'A1', (f) => [packet(f, 'heading')]);
  author(f, 'B1', (f) => f.insert('Q0', '!', 'Q:after-#'));
  author(
    f,
    'A2',
    (f) => [
      {
        type: 'SetProperties',
        node: f.id('Q', 'node'),
        values: { presentation: 'paragraph', checked: true },
      },
    ],
    ['A1'],
    2n,
  );
  f.deliver('A', 'C', ['A1', 'A2']);
  f.deliver('B', 'C', ['B1']);
  const result = project(f);
  expect(node(result, f, 'Q').content).toBe('!x😀');
  expect(node(result, f, 'Q').type).toBe('paragraph');
  expect(node(result, f, 'Q').checked).toBe(true);
  expect(result.interpretations.packets.map((packet) => f.alias(packet.id))).toEqual(['heading']);
  f.fresh('C', ['B1', 'A1', 'A2']);
  expect(project(f).view).toEqual(result.view);
});

test('explicit demotion deletion remains hidden when incompatible packet wins and can retract', () => {
  const f = fixture();
  author(f, 'A1', (f) => [packet(f, 'heading')]);
  author(
    f,
    'A2',
    (f) => [
      {
        type: 'DeleteText',
        tag: f.allocate('syntax-delete', 'deletion'),
        observed: [f.aliases.get('Q0')!, f.aliases.get('Q1')!],
      },
    ],
    ['A1'],
    2n,
  );
  author(f, 'B1', (f) => [packet(f, 'code', 'Q', 'code')], [], 3n);
  f.deliver('A', 'C', ['A1', 'A2']);
  f.deliver('B', 'C', ['B1']);
  expect(node(project(f), f, 'Q').content).toBe('x😀');
  author(f, 'A3', (f) => [control(f, 'A2', false)], ['A2'], 4n);
  f.deliver('A', 'C', ['A3']);
  expect(node(project(f), f, 'Q').content).toBe('# x😀');
});

test('reactivated packet retains original priority and original placement ordinal', () => {
  const f = fixture();
  author(f, 'A1', (f) => [packet(f, 'heading')]);
  author(f, 'B1', (f) => [packet(f, 'code', 'Q', 'code')]);
  f.deliver('B', 'A', ['B1']);
  author(f, 'A2', (f) => [control(f, 'A1', false)], ['A1', 'B1'], 2n);
  author(f, 'A3', (f) => [control(f, 'A1', true, 'A2')], ['A2'], 3n);
  f.deliver('A', 'C', ['A1', 'A2', 'A3']);
  f.deliver('B', 'C', ['B1']);
  expect(node(project(f), f, 'Q').type).toBe('code-block');
  expect(node(project(f), f, 'Q').content).toBe('# x😀');
});

test('losing packet wrappers are dormant but scaffold an independently surviving child', () => {
  const f = fixture();
  author(f, 'A1', (f) => {
    f.createBlock({ id: 'W', parent: 'root', role: 'quote' }, null);
    const move = f.move('Q', 'W');
    if (move.type !== 'MoveBlock') throw new Error();
    return [
      packet(f, 'wrapped', 'Q', 'section', {
        wrappers: [f.id('W', 'node')],
        placements: [{ node: move.node, occurrence: move.occurrence, slot: move.slot }],
      }),
    ];
  });
  f.deliver('A', 'B', ['A1']);
  author(f, 'B1', (f) => [packet(f, 'code', 'Q', 'code')], ['A1'], 2n);
  f.deliver('A', 'C', ['A1']);
  f.deliver('B', 'C', ['B1']);
  const losing = project(f);
  expect(losing.visibility.nodes.find((entry) => f.alias(entry.node) === 'W')).toMatchObject({
    suppressed: true,
    available: false,
  });
  expect(f.alias(losing.ownership.blockPlacement(f.id('Q', 'node'))!.slot.parent)).toBe('root');
  author(
    f,
    'B2',
    (f) => {
      f.createBlock(paragraph('N', 'peer', 'W'), null);
      return [];
    },
    ['B1'],
    3n,
  );
  f.deliver('B', 'C', ['B2']);
  const scaffold = project(f);
  expect(scaffold.visibility.nodes.find((entry) => f.alias(entry.node) === 'W')).toMatchObject({
    scaffold: true,
    available: true,
  });
  expect(
    node(scaffold, f, 'W').children.map((child) => f.alias(child.origin.representative)),
  ).toEqual(['N']);
  expect(node(scaffold, f, 'Q').content).toBe('# x😀');
});

test('winning conversion placements use the shared cycle kernel and effective destinations', () => {
  const f = fixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'U', parent: 'root', role: 'quote' },
    { id: 'V', parent: 'U', role: 'quote' },
    paragraph('P', '# x'),
  ]);
  author(f, 'A1', (f) => {
    const cycle = f.move('U', 'V');
    if (cycle.type !== 'MoveBlock') throw new Error();
    f.ids.set('cycle-slot', cycle.occurrence);
    const move = f.move('P', 'V', 'cycle-slot');
    if (cycle.type !== 'MoveBlock' || move.type !== 'MoveBlock') throw new Error();
    return [packet(f, 'heading', 'P', 'section', { placements: [cycle, move] })];
  });
  f.deliver('A', 'C', ['A1']);
  const result = project(f);
  expect(f.alias(result.ownership.blockPlacement(f.id('U', 'node'))!.slot.parent)).toBe('root');
  expect(f.alias(result.ownership.blockPlacement(f.id('P', 'node'))!.slot.parent)).toBe('V');
  expect(
    result.ownership.destinationRequirements.flatMap((entry) =>
      entry.nodes.map((id) => f.alias(id)),
    ),
  ).toEqual(['V']);
  expect(node(result, f, 'P').content).toBe('x');
});

test.each(['paragraph', 'code'] as const)(
  'demotion to %s lifts children with original edge origins',
  (presentation) => {
    const f = fixture([
      { id: 'root', parent: null, role: 'root' },
      paragraph('P', '# x'),
      paragraph('N', 'body', 'P'),
    ]);
    author(f, 'A1', (f) => [packet(f, 'heading', 'P')]);
    author(f, 'A2', (f) => [packet(f, 'demotion', 'P', presentation)], ['A1'], 2n);
    f.deliver('A', 'C', ['A1', 'A2']);
    const result = project(f);
    expect(result.view.root.children.map((child) => f.alias(child.origin.representative))).toEqual([
      'P',
      'N',
    ]);
    expect(f.alias(node(result, f, 'N').edge!.slot.parent)).toBe('P');
    expect(f.alias(result.ownership.blockPlacement(f.id('N', 'node'))!.slot.parent)).toBe('P');
  },
);

test('absorbed section lifts concurrent children once and never revives deleted descendants', () => {
  const f = fixture([
    { id: 'root', parent: null, role: 'root' },
    paragraph('P', 'before'),
    paragraph('Q', '# x'),
    paragraph('N', 'body', 'Q'),
  ]);
  author(f, 'A1', (f) => [packet(f, 'heading')]);
  author(f, 'A2', (f) => [f.join('fQ', 'P:end')], ['A1'], 2n);
  author(f, 'B1', (f) => {
    f.createBlock(paragraph('C', 'concurrent', 'Q'), 'N:birth');
    return [];
  });
  f.deliver('A', 'C', ['A1', 'A2']);
  f.deliver('B', 'C', ['B1']);
  let result = project(f);
  expect(result.view.root.children.map((child) => f.alias(child.origin.representative))).toEqual([
    'P',
    'N',
    'C',
  ]);
  expect(node(result, f, 'P').content).toBe('beforex');
  f.deliver('B', 'A', ['B1']);
  author(f, 'A3', (f) => [f.deleteSubtree('N', f.contentRanges.get('N')!, [])], ['A2', 'B1'], 3n);
  f.deliver('A', 'C', ['A3']);
  result = project(f);
  expect(result.view.root.children.map((child) => f.alias(child.origin.representative))).toEqual([
    'P',
    'C',
  ]);
});

test('group boundary sides and deletions preserve the observed constituent IDs', () => {
  const trace = contractCorpus.find((trace) => trace.id === 'normalized-wrapper-addresses')!;
  const f = fixture(trace.seed);
  const result = project(f);
  const group = node(result, f, 'U');
  expect(deletionTargets(group).map((id) => f.alias(id))).toEqual(['U', 'V']);
  expect(f.alias(wrapperBoundary(group, 1, 'left').container)).toBe('U');
  expect(f.alias(wrapperBoundary(group, 1, 'right').container)).toBe('V');
  expect(f.alias(wrapperBoundary(group, 1, 'left').slot.predecessor!)).toBe('P:birth');
  expect(f.alias(wrapperBoundary(group, 1, 'right').slot.parent)).toBe('V');
  expect(f.alias(node(result, f, 'Q').edge!.slot.parent)).toBe('V');
  expect(result.view.root.children).toHaveLength(1);
  expect(Object.isFrozen(group)).toBe(true);
});

test('native selections cross hidden masks; empty and evacuated runs retain home insertion slots', () => {
  const f = fixture();
  author(f, 'A1', (f) => [packet(f, 'heading')]);
  author(f, 'A2', (f) => [f.transfer(['Q0', 'Q1', 'Q2', 'Q3'], 'P:end', 'all')], ['A1'], 2n);
  f.deliver('A', 'C', ['A1', 'A2']);
  const result = project(f);
  const p = node(result, f, 'P');
  const q = node(result, f, 'Q');
  expect(q.content).toBe('');
  const point = textPoint(q, 0, 'right');
  expect(point.native).toBeNull();
  expect(resolveAddress(point.address, result.ownership, result.visibility).state).toBe(
    'available',
  );
  const cache = f.peers.get('C')!;
  const ranges = selectionRanges(p, 3, p.content.length);
  expect(
    ranges
      .map((range) =>
        cache
          .lookup(range)
          .map((part) => part.text)
          .join(''),
      )
      .join(''),
  ).toBe('😀x😀');
  expect(() => selectionRanges(p, 4, p.content.length)).toThrow(/surrogate/);
  const afterSurrogate = textPoint(p, 5, 'left');
  expect(nativePointIndex(afterSurrogate, nativeView(cache))).toBe(
    cache.locate(f.id('tP', 'tape'), f.aliases.get('P3')!) + 2,
  );
  f.slots.set('captured-home', point.address.slot);
  author(f, 'A3', (f) => f.insert('new', 'new', 'captured-home'), ['A2'], 3n);
  const inserted = f.bodies.get('A3')!.nativeManifest;
  expect(inserted.map((birth) => birth.type)).toEqual(['marker', 'text', 'marker']);
  expect(
    inserted.every((birth) => resourceKey(birth.tape) === resourceKey(f.id('tQ', 'tape'))),
  ).toBe(true);
  f.deliver('A', 'C', ['A3']);
  expect(node(project(f), f, 'Q').content).toBe('new');
  expect(node(project(f), f, 'P').content).toBe(p.content);
});

test('stale deleted text address is unavailable and is never redirected to transferred content', () => {
  const f = fixture();
  const before = project(f);
  const address = textPoint(node(before, f, 'Q'), 0, 'right').address;
  author(f, 'A1', (f) => [f.deleteSubtree('Q', f.contentRanges.get('Q')!, [])]);
  f.deliver('A', 'C', ['A1']);
  const after = project(f);
  expect(resolveAddress(address, after.ownership, after.visibility)).toEqual({
    state: 'unavailable',
    address,
  });
});

test('post-deletion caret requests allocate nothing; independent edits create separate native homes', () => {
  const f = fixture([{ id: 'root', parent: null, role: 'root' }, paragraph('P', '')]);
  const initial = project(f);
  expect(initial.view.emptyRoot).toBeNull();
  expect(initial.view.root.children).toHaveLength(1);
  author(f, 'A1', (f) => [f.deleteSubtree('P', [], [])]);
  f.deliver('A', 'B', ['A1']);
  f.deliver('A', 'C', ['A1']);
  const before = snapshot(f);
  const empty = project(f);
  const a = requestEmptyRootEdit(empty.view, 'a');
  const b = requestEmptyRootEdit(project(f, 'B').view, 'b');
  expect(snapshot(f)).toEqual(before);
  expect(project(f).view).toEqual(empty.view);
  expect(a.address).toEqual(b.address);
  author(
    f,
    'A2',
    (f) => {
      f.createBlock(paragraph('N', a.text), null);
      return [];
    },
    ['A1'],
    2n,
  );
  author(
    f,
    'B1',
    (f) => {
      f.createBlock(paragraph('M', b.text), null);
      return [];
    },
    ['A1'],
    2n,
  );
  f.deliver('A', 'C', ['A2']);
  f.deliver('B', 'C', ['B1']);
  const final = project(f);
  expect(final.view.root.children.map((child) => child.content)).toEqual(['b', 'a']);
  expect(final.ownership.homeBindings).toHaveLength(3);
  expect(final.view.emptyRoot).toBeNull();
  expect(final.visibility.nodes.find((entry) => f.alias(entry.node) === 'P')?.deleted).toBe(true);
});

test('initial empty genesis typing shares one lineage across independent native replicas', () => {
  const f = fixture([{ id: 'root', parent: null, role: 'root' }, paragraph('P', '')]);
  author(f, 'A1', (f) => f.insert('a', 'a', 'P:start'));
  author(f, 'B1', (f) => f.insert('b', 'b', 'P:start'));
  f.deliver('A', 'C', ['A1']);
  f.deliver('B', 'C', ['B1']);
  const first = project(f);
  expect(first.view.root.children).toHaveLength(1);
  expect([...node(first, f, 'P').content].sort()).toEqual(['a', 'b']);
  expect(first.ownership.homeBindings).toHaveLength(1);
  const identities = selectionRanges(node(first, f, 'P'), 0, 2);
  expect(new Set(identities.map((range) => range.client)).size).toBe(2);
  f.fresh('C', ['B1', 'A1']);
  expect(project(f).view).toEqual(first.view);
});

test('reactivating a winning packet replays its placement before a later independent move', () => {
  const f = fixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'U', parent: 'root', role: 'quote' },
    { id: 'V', parent: 'root', role: 'quote' },
    paragraph('P', '# x'),
  ]);
  author(f, 'A1', (f) => {
    const move = f.move('P', 'U');
    if (move.type !== 'MoveBlock') throw new Error();
    return [
      packet(f, 'heading', 'P', 'section', {
        placements: [{ node: move.node, occurrence: move.occurrence, slot: move.slot }],
      }),
    ];
  });
  f.deliver('A', 'B', ['A1']);
  author(f, 'B1', (f) => [f.move('P', 'V')], ['A1'], 2n);
  f.deliver('B', 'A', ['B1']);
  author(f, 'A2', (f) => [control(f, 'A1', false)], ['A1', 'B1'], 3n);
  author(f, 'A3', (f) => [control(f, 'A1', true, 'A2')], ['A2'], 4n);
  f.deliver('A', 'C', ['A1', 'A2', 'A3']);
  f.deliver('B', 'C', ['B1']);
  const result = project(f);
  expect(node(result, f, 'P').type).toBe('section');
  expect(f.alias(result.ownership.blockPlacement(f.id('P', 'node'))!.slot.parent)).toBe('V');
  expect(
    result.ownership.destinationRequirements.flatMap((entry) =>
      entry.nodes.map((id) => f.alias(id)),
    ),
  ).toEqual(['V', 'P']);
});

test.each(['# repeated repeated😀\n', '```ts\ncode😀\n```', '- [x] task😀\n'])(
  'parser plans bind real packets and project exact output: %j',
  (text) => {
    const f = fixture([{ id: 'root', parent: null, role: 'root' }, paragraph('P', text)]);
    const plan = parseBlocks(text, { provenance: true }).provenance!;
    author(f, 'A1', (f) => {
      const task = text.startsWith('- ');
      if (task) {
        f.createBlock({ id: 'W', parent: 'root', role: 'list' }, null);
        f.createBlock({ id: 'I', parent: 'W', role: 'list-item' }, null);
      }
      const move = f.move('P', task ? 'I' : 'root');
      if (move.type !== 'MoveBlock') throw new Error();
      f.ids.set('parser-occurrence', move.occurrence);
      return [
        packet(f, 'parsed', 'P', 'paragraph', {
          syntaxMask: [],
          placements: [{ node: move.node, occurrence: move.occurrence, slot: move.slot }],
        }),
      ];
    });
    const task = text.startsWith('- ');
    const rootSlot = { parent: f.id('root', 'node'), predecessor: null };
    const bindings = [
      ...(task
        ? [
            {
              key: '0',
              node: f.id('W', 'node'),
              occurrence: f.id('W:birth', 'occurrence'),
              slot: rootSlot,
            },
            {
              key: '0.0',
              node: f.id('I', 'node'),
              occurrence: f.id('I:birth', 'occurrence'),
              slot: { parent: f.id('W', 'node'), predecessor: null },
            },
          ]
        : []),
      {
        key: task ? '0.0.0' : '0',
        node: f.id('P', 'node'),
        flow: f.id('fP', 'flow'),
        run: f.id('rP', 'run'),
        occurrence: f.id('parser-occurrence', 'occurrence'),
        slot: { parent: task ? f.id('I', 'node') : f.id('root', 'node'), predecessor: null },
      },
    ];
    const cache = f.peers.get('A')!;
    const prepared = prepareParserConversion({
      source: f.id('P', 'node'),
      text,
      fragments: cache.range(f.homes[0]!.cell).map(({ text, range }) => ({ text, range })),
      plan,
      bindings,
    });
    const bound = bindParserConversion(
      prepared,
      f.id('parsed', 'interpretation'),
      f.envelope('A1'),
      [],
      (range) =>
        cache
          .lookup(range)
          .map((part) => part.text)
          .join(''),
      f.genesis.allocations,
    );
    const entry = f.actions.get('A1')!;
    f.actions.set('A1', {
      ...entry,
      action: {
        ...entry.action,
        effects: [
          { type: 'Interpret', packet: bound.packet },
          ...bound.outputs
            .filter(({ output }) => output.type === 'list-item')
            .map(({ output }): SemanticEffect => ({
              type: 'SetProperties',
              node: output.binding.node,
              values: { marker: output.properties.marker, checked: output.properties.checked },
            })),
        ],
      },
    });
    f.deliver('A', 'C', ['A1']);
    const result = project(f);
    expect(node(result, f, 'P').content).toBe(
      task ? 'task😀' : text.startsWith('#') ? 'repeated repeated😀' : 'code😀',
    );
    if (task) expect(node(result, f, 'I').checked).toBe(true);
    else if (text.startsWith('```'))
      expect(node(result, f, 'P')).toMatchObject({ type: 'code-block', info: 'ts' });
    const sourceVisible = selectionRanges(
      node(result, f, 'P'),
      0,
      node(result, f, 'P').content.length,
    );
    expect(
      sourceVisible.every((range) =>
        prepared.syntaxMask.every(
          (mask) =>
            mask.client !== range.client ||
            resourceKey(mask.tape) !== resourceKey(range.tape) ||
            mask.clock + mask.length <= range.clock ||
            range.clock + range.length <= mask.clock,
        ),
      ),
    ).toBe(true);
    expect(output(result)).toBe(
      text.startsWith('#')
        ? '# repeated repeated😀\n'
        : task
          ? '- [x] task😀\n'
          : '```ts\ncode😀\n```\n',
    );
  },
);

test('rejects unready native text/markers and missing manifest content before returning a view', () => {
  const f = fixture();
  author(f, 'A1', (f) => f.insert('extra', 'unready', 'Q:after-#'));
  f.deliver('A', 'C', ['A1']);
  const complete = projectionInput(f);
  expect(() => projectMarkdown({ ...complete, actions: [] })).toThrow(/outside the ready set/);
  expect(() => projectMarkdown({ ...complete, native: nativeView(f.peers.get('B')!) })).toThrow(
    /native|Native/,
  );
  expect(() => projectMarkdown({ ...complete, genesisManifest: [] })).toThrow(
    /outside the ready set/,
  );
  expect(() => projectMarkdown({ ...complete, birthContent: [] })).toThrow(/Birth-causal coverage/);
  const before = snapshot(f);
  function freeze(value: object): void {
    Object.freeze(value);
    for (const item of Object.values(value))
      if (
        item &&
        typeof item === 'object' &&
        !(item instanceof Uint8Array) &&
        !Object.isFrozen(item)
      )
        freeze(item);
  }
  freeze(complete);
  const result = projectMarkdown(complete);
  serializeProjection(result.view);
  for (const node of flatten(result.view.root))
    if (node.boundaries.length) textPoint(node, 0, 'right');
  expect(snapshot(f)).toEqual(before);
});

test('new list scaffolds use ordinary semantic marker defaults before derived numbering', () => {
  const f = fixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'L', parent: 'root', role: 'list' },
    { id: 'I', parent: 'L', role: 'list-item' },
    paragraph('P', 'item', 'I'),
  ]);
  const result = project(f);
  expect(node(result, f, 'I').marker).toBe('- ');
  expect(output(result)).toBe('- item\n');
});

test('losing synthesis follows insertion activity without inventing native deletion', () => {
  const f = fixture([{ id: 'root', parent: null, role: 'root' }, paragraph('P', 'a')]);
  author(f, 'A1', (f) => [
    packet(f, 'synthesized', 'P', 'paragraph'),
    ...f.insert('newline', '\n', 'P:end'),
  ]);
  const entry = f.actions.get('A1')!;
  const born = f.bodies.get('A1')!.nativeManifest.find((entry) => entry.type === 'text')!;
  if (born.type !== 'text') throw new Error();
  const range = { tape: born.tape, ...born.native };
  f.actions.set('A1', {
    ...entry,
    action: {
      ...entry.action,
      effects: entry.action.effects.map((effect) =>
        effect.type === 'Interpret'
          ? { ...effect, packet: { ...effect.packet, synthesizedText: [range] } }
          : effect,
      ),
    },
  });
  author(f, 'B1', (f) => [packet(f, 'code', 'P', 'code')]);
  f.deliver('A', 'C', ['A1']);
  f.deliver('B', 'C', ['B1']);
  expect(node(project(f), f, 'P').content).toBe('a\n');
  expect(node(project(f), f, 'P').type).toBe('code-block');
  author(f, 'A2', (f) => [control(f, 'A1', false)], ['A1'], 2n);
  f.deliver('A', 'C', ['A2']);
  expect(node(project(f), f, 'P').content).toBe('a');
  expect(
    f.peers
      .get('C')!
      .lookup(range)
      .map((part) => part.text)
      .join(''),
  ).toBe('\n');
});

test('fully masked text retains an editable home address', () => {
  const f = fixture([{ id: 'root', parent: null, role: 'root' }, paragraph('P', '# ')]);
  author(f, 'A1', (f) => [packet(f, 'empty-heading', 'P')]);
  f.deliver('A', 'C', ['A1']);
  const result = project(f);
  const p = node(result, f, 'P');
  expect(p.content).toBe('');
  expect(result.view.emptyRoot).toBeNull();
  const address = textPoint(p, 0, 'right');
  expect(address.native).toBeNull();
  f.slots.set('masked-caret', address.address.slot);
  author(f, 'A2', (f) => f.insert('new', 'new', 'masked-caret'), ['A1'], 2n);
  f.deliver('A', 'C', ['A2']);
  expect(output(project(f))).toBe('# new\n');
});
