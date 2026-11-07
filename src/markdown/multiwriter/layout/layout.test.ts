import { describe, expect, it } from 'vitest';
import { contractCorpus } from '../../../../test/multiwriter/corpus.js';
import type { ContractTrace, SeedBlock, TraceAction } from '../../../../test/multiwriter/trace.js';
import { actorId, compareActions } from '../contracts.js';
import type {
  ActionId,
  Allocation,
  BlockSlot,
  InlineSlot,
  NodeId,
  OccurrenceId,
  RawRole,
  ResourceId,
  ResourceKind,
  RunId,
  SemanticEffect,
} from '../contracts.js';
import { LayoutPrefix, allowsRawChild, reduceLayout } from './layout.js';
import type { BirthPlacement, LayoutActionInput, LayoutGenesis } from './layout.js';
import { resourceKey } from './occurrences.js';

/** Converts symbolic fixture inputs to logical allocations only. Expected states
 * never enter this builder. Native ownership and projection are not implemented.
 */
class Fixture {
  readonly ids = new Map<string, ResourceId<ResourceKind>>();
  private ordinal = 0;
  private actionAlias = 'genesis';
  private birth: ResourceId<ResourceKind>['birth'] = { type: 'genesis', genesisId: 'G' };
  private allocations: Allocation[] = [];
  private births: BirthPlacement[] = [];
  private readonly nodeFlows = new Map<string, string>();
  readonly slots = new Map<string, InlineSlot>();
  readonly genesis: LayoutGenesis;
  constructor(
    seed: readonly SeedBlock[] = [
      { id: 'root', parent: null, role: 'root' },
      { id: 'P', parent: 'root', role: 'inline', flow: 'fP', run: 'rP', tape: 'tP' },
      { id: 'Q', parent: 'root', role: 'inline', flow: 'fQ', run: 'rQ', tape: 'tQ' },
    ],
  ) {
    const previous = new Map<string, string>();
    for (const block of seed) {
      this.addBlock(block, block.parent === null ? null : (previous.get(block.parent) ?? null));
      if (block.parent !== null) previous.set(block.parent, `${block.id}:birth`);
    }
    this.genesis = { allocations: this.allocations, births: this.births };
  }
  id<K extends ResourceKind>(alias: string, kind: K): ResourceId<K> {
    const id = this.ids.get(alias);
    if (!id || id.kind !== kind) throw new Error(`Missing ${kind} alias ${alias}`);
    return id as ResourceId<K>;
  }
  alias(id: ResourceId<ResourceKind>): string {
    const found = [...this.ids].find(([, candidate]) => resourceKey(candidate) === resourceKey(id));
    if (!found) throw new Error('Missing alias');
    return found[0];
  }
  private allocateId<K extends ResourceKind>(alias: string, kind: K): ResourceId<K> {
    if (this.ids.has(alias)) throw new Error(`Duplicate alias ${alias}`);
    const id: ResourceId<K> = { kind, birth: this.birth, ordinal: this.ordinal++ };
    this.ids.set(alias, id);
    return id;
  }
  private occurrence(alias: string, slot: BlockSlot | InlineSlot): OccurrenceId {
    const id = this.allocateId(alias, 'occurrence');
    this.allocations.push({ type: 'occurrence', id, slot });
    return id;
  }
  private blockSlot(parent: string, predecessor: string | null): BlockSlot {
    return {
      parent: this.id(parent, 'node'),
      predecessor: predecessor === null ? null : this.id(predecessor, 'occurrence'),
    };
  }
  private addBlock(block: SeedBlock, predecessor: string | null): void {
    const id = this.allocateId(block.id, 'node');
    const slot = block.parent === null ? null : this.blockSlot(block.parent, predecessor);
    const flow = block.flow ? this.allocateId(block.flow, 'flow') : null;
    this.allocations.push({ type: 'node', id, role: block.role, flow, birthSlot: slot });
    if (slot)
      this.births.push({ node: id, occurrence: this.occurrence(`${block.id}:birth`, slot) });
    if (flow) {
      this.nodeFlows.set(block.id, block.flow!);
      this.allocations.push({ type: 'flow', id: flow, home: id });
      const tape = this.allocateId(block.tape!, 'tape');
      const start = this.allocateId(`${block.id}:start`, 'marker');
      const end = this.allocateId(`${block.id}:end`, 'marker');
      this.allocations.push({ type: 'tape', id: tape, start, end });
      const run = this.allocateId(block.run!, 'run');
      this.allocations.push({ type: 'run', id: run, flow, skeleton: [{ tape, start, end }] });
      this.slots.set(`${block.id}:start`, {
        run,
        boundary: start,
        side: 'right',
        predecessor: null,
      });
      this.slots.set(`${block.id}:end`, { run, boundary: end, side: 'left', predecessor: null });
    }
  }
  action(
    alias: string,
    build: (fixture: Fixture) => readonly SemanticEffect[],
    dependencies: readonly ActionId[] = [],
    lamport = 1n,
  ): LayoutActionInput {
    const id = {
      actor: actorId(alias[0].charCodeAt(0).toString(16).padStart(32, '0')),
      sequence: BigInt(alias.slice(1)),
    };
    this.birth = { type: 'action', action: id };
    this.actionAlias = alias;
    this.ordinal = 0;
    this.allocations = [];
    this.births = [];
    const effects = build(this);
    return {
      action: { id, lamport, dependencies, allocations: this.allocations, effects },
      births: this.births,
    };
  }
  move(node: string, parent: string, predecessor: string | null = null): SemanticEffect {
    const slot = this.blockSlot(parent, predecessor);
    return {
      type: 'MoveBlock',
      node: this.id(node, 'node'),
      slot,
      occurrence: this.occurrence(`move:${this.actionAlias}:${node}:${this.ordinal}`, slot),
      standaloneFlow: this.nodeFlows.has(node) ? this.id(this.nodeFlows.get(node)!, 'flow') : null,
    };
  }
  join(
    source: string,
    destination: string,
    predecessor: OccurrenceId | null = null,
  ): SemanticEffect {
    const slot = { ...this.slots.get(destination)!, predecessor };
    return {
      type: 'JoinFlow',
      source: this.id(source, 'flow'),
      destination: slot,
      occurrence: this.occurrence(`join:${this.actionAlias}:${source}:${this.ordinal}`, slot),
      liftedChildren: [],
    };
  }
  create(block: SeedBlock, predecessor: string | null = null): void {
    this.addBlock(block, predecessor);
  }
  nonHomeRun(
    alias: string,
    flow: string,
    skeleton: readonly import('../contracts.js').RangeRef[] = [],
  ): RunId {
    const id = this.allocateId(alias, 'run');
    this.allocations.push({ type: 'run', id, flow: this.id(flow, 'flow'), skeleton });
    return id;
  }
  transfer(sourceRun: string, destination: string, alias: string): SemanticEffect {
    const source = this.genesis.allocations.find(
      (allocation) =>
        allocation.type === 'run' &&
        resourceKey(allocation.id) === resourceKey(this.id(sourceRun, 'run')),
    );
    if (source?.type !== 'run') throw new Error('Missing source run');
    const slot = this.slots.get(destination)!;
    const destinationRun = this.genesis.allocations.find(
      (allocation) =>
        allocation.type === 'run' && resourceKey(allocation.id) === resourceKey(slot.run),
    );
    if (destinationRun?.type !== 'run') throw new Error('Missing destination run');
    const run = this.nonHomeRun(alias, this.alias(destinationRun.flow), source.skeleton);
    return {
      type: 'TransferRange',
      ranges: source.skeleton,
      destination: slot,
      run,
      occurrence: this.occurrence(`transfer:${this.actionAlias}`, slot),
    };
  }
  parents(layout: LayoutPrefix): Record<string, string | null> {
    return Object.fromEntries(
      layout.nodeAllocations.map((node) => [
        this.alias(node.id),
        layout.blockPlacement(node.id)
          ? this.alias(layout.blockPlacement(node.id)!.slot.parent)
          : null,
      ]),
    );
  }
  flowParents(layout: LayoutPrefix): Record<string, string> {
    return Object.fromEntries(
      layout.flowPlacements.map((placement) => [
        this.alias(placement.flow),
        placement.parent.type === 'block'
          ? `block:${this.alias(placement.parent.node)}`
          : `flow:${this.alias(layout.runLayout(placement.parent.slot.run).flow)}@${this.alias(placement.parent.slot.boundary)}`,
      ]),
    );
  }
  preorder(layout: LayoutPrefix, parent: NodeId = layout.root): string[] {
    return layout
      .children(parent)
      .flatMap((node) => [this.alias(node), ...this.preorder(layout, node)]);
  }
}
const active = () => true;
function invariants(layout: LayoutPrefix): void {
  const effective = new Set<string>();
  for (const node of layout.nodeAllocations) {
    const placement = layout.blockPlacement(node.id);
    if (node.role === 'root') {
      expect(placement).toBeNull();
      continue;
    }
    expect(placement).not.toBeNull();
    const key = resourceKey(placement!.occurrence);
    expect(effective.has(key)).toBe(false);
    effective.add(key);
    expect(layout.occurrence(placement!.occurrence).slot).toEqual(placement!.slot);
    const seen = new Set<string>([resourceKey(node.id)]);
    let parent: NodeId | null = placement!.slot.parent;
    while (parent) {
      expect(seen.has(resourceKey(parent))).toBe(false);
      seen.add(resourceKey(parent));
      parent = layout.blockPlacement(parent)?.slot.parent ?? null;
    }
  }
  for (const flow of layout.flowPlacements) expect(layout.flowBlock(flow.flow).kind).toBe('node');
}

it('replays opposing joins, retains ineffective anchors and exposes standalone state', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => [f.join('fQ', 'P:end')]);
  const b = f.action('B1', (f) => [f.join('fP', 'Q:end')]);
  for (const inputs of [
    [a, b],
    [b, a, b],
  ]) {
    const layout = reduceLayout(f.genesis, structuredClone(inputs), active);
    expect(f.parents(layout)).toEqual({ root: null, P: 'root', Q: 'root' });
    expect(f.flowParents(layout)).toEqual({ fP: 'block:P', fQ: 'flow:fP@P:end' });
    expect(layout.flowBlock(f.id('fQ', 'flow'))).toEqual(f.id('P', 'node'));
    expect(layout.joinedFlows(f.slots.get('P:end')!)).toEqual([f.id('fQ', 'flow')]);
    expect(layout.joinedFlows(f.slots.get('Q:end')!)).toEqual([]);
    expect(layout.occurrenceOrder(f.slots.get('Q:end')!)).toHaveLength(1);
    invariants(layout);
  }
});

it('catches a flow cycle through a transferred non-home run', () => {
  const f = new Fixture();
  const allocation = f.action('A1', (f) => {
    const run = f.nonHomeRun('transfer', 'fQ');
    f.slots.set('ghost', {
      run,
      boundary: f.id('P:end', 'marker'),
      side: 'left',
      predecessor: null,
    });
    return [];
  });
  const a = f.action('B1', (f) => [f.join('fQ', 'P:end')]);
  const b = f.action('C1', (f) => [f.join('fP', 'ghost')], [allocation.action.id], 2n);
  const layout = reduceLayout(f.genesis, [b, a, allocation], active);
  expect(layout.flowPlacement(f.id('fP', 'flow')).parent.type).toBe('block');
  expect(layout.flowBlock(f.id('fQ', 'flow'))).toEqual(f.id('P', 'node'));
  invariants(layout);
});

it('applies the reviewed standalone assertion when a locally safe raw move becomes cyclic after merge', () => {
  const f = new Fixture();
  const join = f.action('A1', (f) => [f.join('fP', 'Q:end')]);
  const opposing = f.action('B1', (f) => [f.move('Q', 'P')]);
  const move = f.action('C1', (f) => [f.move('P', 'Q')], [join.action.id], 2n);
  const authorView = reduceLayout(f.genesis, [join, move], active);
  expect(f.parents(authorView).P).toBe('Q');
  expect(f.flowParents(authorView).fP).toBe('block:P');
  for (const disabled of [false, true, false]) {
    const layout = reduceLayout(
      f.genesis,
      [move, opposing, join],
      (order) => !disabled || order.action.id.actor !== move.action.id.actor,
    );
    expect(f.parents(layout)).toEqual({ root: null, P: 'root', Q: 'P' });
    expect(f.flowParents(layout).fP).toBe(disabled ? 'flow:fQ@Q:end' : 'block:P');
    invariants(layout);
  }
});

it('supports ownership interleaving at the exact flow prefix rather than final-join state', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => [
    f.join('fQ', 'P:end'),
    f.move('Q', 'root'),
    f.join('fP', 'Q:end'),
  ]);
  const prefix = new LayoutPrefix(f.genesis);
  prefix.beginAction(a);
  expect(prefix.flowBlock(f.id('fQ', 'flow'))).toEqual(f.id('Q', 'node'));
  prefix.step(0, true);
  expect(prefix.flowBlock(f.id('fQ', 'flow'))).toEqual(f.id('P', 'node')); // MW-04 split sees this.
  prefix.step(1, true);
  expect(prefix.flowBlock(f.id('fQ', 'flow'))).toEqual(f.id('Q', 'node'));
  prefix.step(2, true);
  expect(prefix.flowBlock(f.id('fP', 'flow'))).toEqual(f.id('Q', 'node'));
  invariants(prefix);
  expect(() => prefix.step(2, true)).toThrow('prefix order');
});

it('keeps action births and fallback placements when effects are inactive', () => {
  const f = new Fixture();
  const birth = f.action('A1', (f) => {
    f.create({ id: 'W', parent: 'root', role: 'quote' });
    f.create({ id: 'N', parent: 'W', role: 'inline', flow: 'fN', run: 'rN', tape: 'tN' });
    return [f.move('N', 'root')];
  });
  const later = f.action('B1', (f) => [f.move('P', 'W')], [birth.action.id], 2n);
  const layout = reduceLayout(
    f.genesis,
    [later, birth],
    (order) => order.action.id.actor !== birth.action.id.actor,
  );
  expect(f.parents(layout)).toEqual({ root: null, P: 'W', Q: 'root', W: 'root', N: 'W' });
  invariants(layout);
});

it('preserves logical IDs and immutable input allocations, skeletons and slots', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => [f.join('fQ', 'P:end'), f.move('Q', 'P')]);
  const snapshot = structuredClone({ genesis: f.genesis, a });
  const layout = reduceLayout(f.genesis, [a], active);
  const slot = structuredClone(f.slots.get('Q:end')!);
  const before = layout.resolveInlineSlot(slot);
  expect(before.membership).toBe('unavailable');
  expect(before.run.run).toEqual(f.id('rQ', 'run'));
  expect(layout.resolveInlineSlot(slot, { containsBoundary: () => true }).membership).toBe(
    'available',
  );
  expect(() => layout.resolveInlineSlot(slot, { containsBoundary: () => false })).toThrow(
    'outside',
  );
  expect(layout.blockPlacement(structuredClone(f.id('Q', 'node')))?.slot.parent).toEqual(
    f.id('P', 'node'),
  );
  const birth = layout.occurrence(f.id('Q:birth', 'occurrence'));
  expect(layout.resolveBlockSlot(birth.slot as BlockSlot)).toEqual(birth.slot);
  expect({ genesis: f.genesis, a }).toEqual(snapshot);
});

it('keeps an empty ghost run addressable and reports unavailable native membership explicitly', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => {
    f.nonHomeRun('empty', 'fP');
    return [];
  });
  const layout = reduceLayout(f.genesis, [a], active);
  const slot: InlineSlot = {
    run: f.id('empty', 'run'),
    boundary: f.id('Q:end', 'marker'),
    side: 'right',
    predecessor: null,
  };
  expect(layout.resolveInlineSlot(slot).run.skeleton).toEqual([]);
  expect(layout.resolveInlineSlot(slot).membership).toBe('unavailable');
  expect(layout.runLayout(f.id('rQ', 'run')).skeleton).toEqual(
    new LayoutPrefix(f.genesis).runLayout(f.id('rQ', 'run')).skeleton,
  );
});

it('orders inline followers after ineffective and inactive joins without rendering duplicates', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => [f.join('fP', 'P:end')]); // self-flow cycle
  const first = (a.action.effects[0] as Extract<SemanticEffect, { type: 'JoinFlow' }>).occurrence;
  const b = f.action('B1', (f) => [f.join('fQ', 'P:end', first)], [a.action.id], 2n);
  for (const disabled of [true, false]) {
    const layout = reduceLayout(
      f.genesis,
      [b, a],
      (order) => !disabled || order.action.id.actor !== a.action.id.actor,
    );
    expect(layout.occurrenceOrder(f.slots.get('P:end')!)).toHaveLength(2);
    expect(layout.joinedFlows(f.slots.get('P:end')!)).toEqual([f.id('fQ', 'flow')]);
    invariants(layout);
  }
});

describe('raw roles', () => {
  const roles: RawRole[] = ['root', 'inline', 'list', 'list-item', 'quote'];
  for (const parentRole of roles)
    for (const childRole of roles) {
      it(`${parentRole} ← ${childRole} has immutable role constraints`, () => {
        const allowed =
          childRole !== 'root' &&
          (parentRole === 'list'
            ? childRole === 'list-item'
            : ['inline', 'list', 'quote'].includes(childRole));
        expect(allowsRawChild(parentRole, childRole)).toBe(allowed);
        // Make all nodes initially legal, including list items in a list.
        const seed: SeedBlock[] = [
          { id: 'root', parent: null, role: 'root' },
          { id: 'L', parent: 'root', role: 'list' },
        ];
        const add = (id: string, role: RawRole) => {
          if (role === 'root') return;
          seed.push({
            id,
            role,
            parent: role === 'list-item' ? 'L' : 'root',
            ...(role === 'inline' ? { flow: `f${id}`, run: `r${id}`, tape: `t${id}` } : {}),
          });
        };
        add('parent', parentRole);
        add('child', childRole);
        const f = new Fixture(seed);
        const child = childRole === 'root' ? 'root' : 'child';
        const parent = parentRole === 'root' ? 'root' : 'parent';
        const a = f.action('A1', (f) => [f.move(child, parent)]);
        const prefix = new LayoutPrefix(f.genesis);
        const before = prefix.blockPlacement(f.id(child, 'node'));
        prefix.beginAction(a);
        expect(prefix.step(0, true).blocks[0].result).toBe(allowed ? 'applied' : 'role');
        if (!allowed) expect(prefix.blockPlacement(f.id(child, 'node'))).toEqual(before);
        expect(
          prefix.nodeAllocations.find(
            (node) => resourceKey(node.id) === resourceKey(f.id(child, 'node')),
          )!.role,
        ).toBe(childRole);
        invariants(prefix);
      });
    }
  it.each(['paragraph', 'section', 'code'] as const)(
    '%s presentation preserves inline children',
    (presentation) => {
      const f = new Fixture();
      const a = f.action('A1', (f) => [
        f.move('Q', 'P'),
        { type: 'SetProperties', node: f.id('P', 'node'), values: { presentation } },
      ]);
      const layout = reduceLayout(f.genesis, [a], active);
      expect(f.parents(layout).Q).toBe('P');
      expect(layout.children(f.id('P', 'node'))).toEqual([f.id('Q', 'node')]);
    },
  );
});

/** Executes real layout reductions at corpus checkpoints. This intentionally checks
 * only raw parents, flow parents, run parents, and ordinary block occurrence order.
 * No visible-text/native-cell observation is synthesized for the full trace runner.
 */
function checkCorpusLayout(trace: ContractTrace): number {
  const f = new Fixture(trace.seed);
  const actions = new Map<string, { trace: TraceAction; input: LayoutActionInput }>();
  const held = new Map<string, string[]>(trace.peers.map((peer) => [peer, []]));
  let assertions = 0;
  for (const step of trace.steps) {
    if (step.type === 'author') {
      const authored = step.action;
      const dependencies = authored.dependencies.map((id) => actions.get(id)!.input.action.id);
      const input = f.action(
        authored.id,
        (fixture) => {
          const effects: SemanticEffect[] = [];
          for (const intent of authored.intents) {
            switch (intent.type) {
              case 'move':
                effects.push(fixture.move(intent.node, intent.parent, intent.predecessor));
                break;
              case 'join':
                effects.push(fixture.join(intent.source, intent.destinationSlot));
                break;
              case 'split':
                // MW-03 tests only this birth's authored outer slot, not split ownership/cohorts.
                fixture.create(
                  {
                    id: intent.node,
                    parent: intent.parent,
                    role: 'inline',
                    flow: intent.flow,
                    run: intent.run,
                    tape: `t${intent.node}`,
                  },
                  intent.predecessor,
                );
                break;
              case 'delete-subtree':
                effects.push({
                  type: 'DeleteSubtree',
                  tag: {
                    kind: 'deletion',
                    birth: {
                      type: 'action',
                      action: { actor: actorId('00'.repeat(16)), sequence: 1n },
                    },
                    ordinal: 0,
                  },
                  scope: {
                    target: fixture.id(intent.target, 'node'),
                    observedNodes: intent.observedNodes.map((node) => fixture.id(node, 'node')),
                    ownedIntervals: [],
                    joinedFlows: [],
                    heads: dependencies,
                  },
                });
                break;
              case 'control':
                // The caller supplies activity separately below; layout does not resolve controls.
                break;
              default:
                throw new Error(`Unsupported layout facet input ${intent.type}`);
            }
          }
          return effects;
        },
        dependencies,
        authored.lamport,
      );
      actions.set(authored.id, { trace: authored, input });
      held.get(authored.peer)!.push(authored.id);
    } else if (step.type === 'deliver') {
      held.get(step.to)!.push(...step.actions);
    } else if (step.type === 'expect') {
      const entries = held.get(step.peer)!.map((id) => actions.get(id)!);
      const ordered = [...new Map(entries.map((entry) => [entry.trace.id, entry])).values()].sort(
        (a, b) => compareActions(a.input.action, b.input.action),
      );
      const activity = new Map<string, boolean>();
      for (const entry of ordered)
        for (const intent of entry.trace.intents) {
          if (intent.type === 'control')
            for (const target of intent.actions) {
              const action = actions.get(target)!.input.action;
              activity.set(`${action.id.actor}:${action.id.sequence}`, intent.active);
            }
        }
      const layout = reduceLayout(
        structuredClone(f.genesis),
        structuredClone(entries.map((entry) => entry.input)),
        (order) => activity.get(`${order.action.id.actor}:${order.action.id.sequence}`) ?? true,
      );
      invariants(layout);
      if (step.state.rawParents) {
        expect(f.parents(layout), trace.id).toEqual(step.state.rawParents);
        assertions++;
      }
      if (step.state.flowParents) {
        expect(f.flowParents(layout), trace.id).toEqual(step.state.flowParents);
        assertions++;
      }
      if (step.state.runFlows) {
        expect(
          Object.fromEntries(layout.runLayouts.map((run) => [f.alias(run.run), f.alias(run.flow)])),
          trace.id,
        ).toEqual(step.state.runFlows);
        assertions++;
      }
      if (
        step.state.view &&
        (trace.id.startsWith('split-sibling-') || trace.id === 'move-overrides-join')
      ) {
        expect(f.preorder(layout), trace.id).toEqual(step.state.view.map((node) => node.id));
        assertions++;
      }
    } else throw new Error(`Unexpected layout trace step ${step.type}`);
  }
  return assertions;
}
const layoutTraces = [
  'opposing-joins',
  'move-overrides-join',
  'delete-does-not-make-raw-cycle-safe',
  'redo-old-move-keeps-old-priority',
  'split-sibling-keeps-authored-outer-context',
  'split-sibling-keeps-authored-outer-context-reverse',
];
it.each(layoutTraces)('checks actual corpus layout facets: %s', (id) => {
  const trace = contractCorpus.find((trace) => trace.id === id)!;
  expect(trace).toBeDefined();
  expect(checkCorpusLayout(trace)).toBeGreaterThan(0);
});

it('equal ready sets converge across three independent reducers, duplicate deliveries and fresh replay', () => {
  const f = new Fixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'P', parent: 'root', role: 'quote' },
    { id: 'Q', parent: 'root', role: 'quote' },
    { id: 'R', parent: 'root', role: 'quote' },
  ]);
  const a = f.action('A1', (f) => [f.move('P', 'Q'), f.move('R', 'P')]);
  const b = f.action('B1', (f) => [f.move('Q', 'R')]);
  const c = f.action('C1', (f) => [f.move('R', 'root')]);
  const schedules = [
    [a, b, c],
    [c, a, b],
    [b, c, a],
  ];
  const peers = schedules.map(() => [] as LayoutActionInput[]);
  for (let i = 0; i < 3; i++) {
    for (let peer = 0; peer < 3; peer++) {
      peers[peer].push(structuredClone(schedules[peer][i]));
      const layout = reduceLayout(structuredClone(f.genesis), peers[peer], active);
      invariants(layout);
    }
  }
  for (const disabled of [false, true, false]) {
    const layouts = peers.map((inputs) =>
      reduceLayout(
        structuredClone(f.genesis),
        [...inputs, structuredClone(inputs[0])],
        (order) => !disabled || order.action.id.actor !== b.action.id.actor,
      ),
    );
    expect(layouts.map((layout) => f.parents(layout))).toEqual([
      f.parents(layouts[0]),
      f.parents(layouts[0]),
      f.parents(layouts[0]),
    ]);
    expect(layouts.map((layout) => f.preorder(layout))).toEqual([
      f.preorder(layouts[0]),
      f.preorder(layouts[0]),
      f.preorder(layouts[0]),
    ]);
    for (const layout of layouts) invariants(layout);
  }
});

it('reclassifies late block moves in both safety directions and restores original effect priority', () => {
  const f = new Fixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'P', parent: 'root', role: 'quote' },
    { id: 'Q', parent: 'P', role: 'quote' },
  ]);
  const earlier = f.action('A1', (f) => [f.move('Q', 'root')]);
  const later = f.action('B1', (f) => [f.move('P', 'Q')]);
  expect(f.parents(reduceLayout(f.genesis, [later], active))).toEqual({
    root: null,
    P: 'root',
    Q: 'P',
  });
  for (const disabled of [false, true, false]) {
    const layout = reduceLayout(
      f.genesis,
      [later, earlier],
      (order) => !disabled || order.action.id.actor !== earlier.action.id.actor,
    );
    expect(f.parents(layout)).toEqual(
      disabled ? { root: null, P: 'root', Q: 'P' } : { root: null, P: 'Q', Q: 'root' },
    );
    invariants(layout);
  }
  const g = new Fixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'P', parent: 'root', role: 'quote' },
    { id: 'Q', parent: 'root', role: 'quote' },
  ]);
  const first = g.action('A1', (f) => [f.move('Q', 'P')]);
  const second = g.action('B1', (f) => [f.move('P', 'Q')]);
  expect(g.parents(reduceLayout(g.genesis, [second], active)).P).toBe('Q');
  expect(g.parents(reduceLayout(g.genesis, [second, first], active)).P).toBe('root');
});

it('same-parent reorder replaces only the effective occurrence and preserves the birth anchor', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => [f.move('Q', 'root')]);
  const layout = reduceLayout(f.genesis, [a], active);
  expect(f.preorder(layout)).toEqual(['Q', 'P']);
  expect(
    layout
      .occurrenceOrder({ parent: layout.root, predecessor: null })
      .map((entry) => f.alias(entry.id)),
  ).toEqual(['move:A1:Q:0', 'P:birth', 'Q:birth']);
  expect(f.preorder(reduceLayout(f.genesis, [a], () => false))).toEqual(['P', 'Q']);
});

it('rejects missing and noncausal predecessors rather than repairing them to the beginning', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => [f.move('P', 'root')]);
  const predecessor = (a.action.effects[0] as Extract<SemanticEffect, { type: 'MoveBlock' }>)
    .occurrence;
  const b = f.action('B1', (f) => [f.move('Q', 'root', f.alias(predecessor))]);
  expect(() => reduceLayout(f.genesis, [a, b], active)).toThrow('causally available');
  expect(() => reduceLayout(f.genesis, [b], active)).toThrow('Missing occurrence');
  const causal = { ...b, action: { ...b.action, lamport: 2n, dependencies: [a.action.id] } };
  const layout = reduceLayout(f.genesis, [causal, a], active);
  expect(f.preorder(layout)).toEqual(['P', 'Q']);
  invariants(layout);
  const wrongSequence = {
    ...causal,
    action: {
      ...causal.action,
      allocations: causal.action.allocations.map((allocation): Allocation =>
        allocation.type === 'occurrence'
          ? { ...allocation, slot: { parent: f.id('P', 'node'), predecessor } }
          : allocation,
      ),
    },
  };
  expect(() => reduceLayout(f.genesis, [a, wrongSequence], active)).toThrow('another slot');
});

it('rejects changed authored slots, missing references and wrong standalone flow IDs', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => [f.move('P', 'Q')]);
  const effect = a.action.effects[0] as Extract<SemanticEffect, { type: 'MoveBlock' }>;
  const withEffect = (changed: SemanticEffect): LayoutActionInput => ({
    ...a,
    action: { ...a.action, effects: [changed] },
  });
  expect(() =>
    reduceLayout(
      f.genesis,
      [withEffect({ ...effect, slot: { parent: f.id('root', 'node'), predecessor: null } })],
      active,
    ),
  ).toThrow('immutable');
  expect(() =>
    reduceLayout(
      f.genesis,
      [withEffect({ ...effect, node: { ...effect.node, ordinal: 999 } })],
      active,
    ),
  ).toThrow('Missing node');
  expect(() =>
    reduceLayout(
      f.genesis,
      [withEffect({ ...effect, standaloneFlow: f.id('fQ', 'flow') })],
      active,
    ),
  ).toThrow('own standalone');
  expect(() =>
    reduceLayout(f.genesis, [withEffect({ ...effect, standaloneFlow: null })], active),
  ).toThrow('own standalone');
});

it('checks root, immutable flow home, containing flow, and birth fallback invariants', () => {
  const f = new Fixture();
  const change = (modify: (allocation: Allocation) => Allocation) => ({
    ...f.genesis,
    allocations: f.genesis.allocations.map(modify),
  });
  expect(() => new LayoutPrefix({ allocations: [], births: [] })).toThrow('root');
  expect(() => new LayoutPrefix({ ...f.genesis, births: [] })).toThrow('cover exactly');
  expect(
    () =>
      new LayoutPrefix(
        change((allocation) =>
          allocation.type === 'flow' ? { ...allocation, home: f.id('root', 'node') } : allocation,
        ),
      ),
  ).toThrow('home');
  expect(
    () =>
      new LayoutPrefix(
        change((allocation) =>
          allocation.type === 'run'
            ? { ...allocation, flow: { ...allocation.flow, ordinal: 999 } }
            : allocation,
        ),
      ),
  ).toThrow('Missing flow');
  expect(
    () =>
      new LayoutPrefix(
        change((allocation) =>
          allocation.type === 'node' && allocation.role === 'inline'
            ? { ...allocation, flow: null }
            : allocation,
        ),
      ),
  ).toThrow('own flows');
  expect(
    () =>
      new LayoutPrefix(
        change((allocation) =>
          allocation.type === 'node' && allocation.role === 'root'
            ? { ...allocation, birthSlot: { parent: f.id('P', 'node'), predecessor: null } }
            : allocation,
        ),
      ),
  ).toThrow('root');
  const cyclic = change((allocation) => {
    if (allocation.type === 'node' && allocation.role === 'inline') {
      return {
        ...allocation,
        birthSlot: {
          parent: f.id(f.alias(allocation.id) === 'P' ? 'Q' : 'P', 'node'),
          predecessor: null,
        },
      };
    }
    if (allocation.type === 'occurrence' && 'parent' in allocation.slot) {
      return {
        ...allocation,
        slot: {
          parent: f.id(f.alias(allocation.id) === 'P:birth' ? 'Q' : 'P', 'node'),
          predecessor: null,
        },
      };
    }
    return allocation;
  });
  expect(() => new LayoutPrefix(cyclic)).toThrow('Invalid fallback');
});

it('enforces prefix sequencing and complete dependency closure', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => [f.move('P', 'Q')]);
  const b = f.action('B1', (f) => [f.move('Q', 'root')], [a.action.id], 2n);
  expect(() => reduceLayout(f.genesis, [b], active)).toThrow('Missing action dependency');
  const prefix = new LayoutPrefix(f.genesis);
  expect(() => prefix.step(0, true)).toThrow('prefix order');
  prefix.beginAction(a);
  expect(() => prefix.beginAction(b)).toThrow('incomplete');
  expect(() => prefix.step(1, true)).toThrow('prefix order');
  prefix.step(0, true);
  expect(() => prefix.beginAction(a)).toThrow('semantic order');
  prefix.beginAction(b);
  prefix.step(0, true);
  invariants(prefix);
});

it('accepts deeply frozen inputs and returns original ghost slots without writes', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => [f.join('fQ', 'P:end'), f.move('P', 'Q')]);
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  freeze(f.genesis);
  freeze(a);
  const layout = reduceLayout(f.genesis, [a], active);
  const slot = f.slots.get('Q:end')!;
  freeze(slot);
  expect(layout.resolveInlineSlot(slot).slot).toEqual(slot);
  expect(
    layout.resolveBlockSlot({
      parent: f.id('root', 'node'),
      predecessor: f.id('P:birth', 'occurrence'),
    }).predecessor,
  ).toEqual(f.id('P:birth', 'occurrence'));
});

it('interleaves actual split/transfer effect prefixes while retaining allocation skeletons', () => {
  const f = new Fixture();
  const a = f.action('A1', (f) => {
    f.create(
      { id: 'S', parent: 'root', role: 'inline', flow: 'fS', run: 'rS', tape: 'tS' },
      'P:birth',
    );
    return [
      f.join('fQ', 'P:end'),
      {
        type: 'SplitFlow',
        basis: { ranges: [] },
        cut: f.slots.get('P:end')!,
        retainedSide: 'left',
        newNode: f.id('S', 'node'),
        newFlow: f.id('fS', 'flow'),
        newRun: f.id('rS', 'run'),
        occurrence: f.id('S:birth', 'occurrence'),
        outerSlot: { parent: f.id('root', 'node'), predecessor: f.id('P:birth', 'occurrence') },
      },
      f.transfer('rQ', 'P:end', 'rT'),
    ];
  });
  const prefix = new LayoutPrefix(f.genesis);
  prefix.beginAction(a);
  expect(prefix.flowPlacement(f.id('fS', 'flow')).parent.type).toBe('block');
  prefix.step(0, true);
  expect(prefix.flowBlock(f.id('fQ', 'flow'))).toEqual(f.id('P', 'node'));
  // MW-04 can resolve the split using this prefix. MW-03 performs no cell assignment.
  prefix.step(1, true);
  expect(f.preorder(prefix)).toEqual(['P', 'S', 'Q']);
  prefix.step(2, true);
  expect(prefix.runLayout(f.id('rT', 'run')).flow).toEqual(f.id('fP', 'flow'));
  expect(prefix.runLayout(f.id('rT', 'run')).skeleton).toEqual(
    prefix.runLayout(f.id('rQ', 'run')).skeleton,
  );
  expect(prefix.resolveInlineSlot(f.slots.get('Q:end')!).run.run).toEqual(f.id('rQ', 'run'));
  expect(prefix.occurrenceOrder(f.slots.get('P:end')!)).toHaveLength(2);
  invariants(prefix);
});

it('keeps invariants and converges after generated locally safe partitioned block moves', () => {
  let random = 0x8403;
  const next = (limit: number) => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random % limit;
  };
  for (let trial = 0; trial < 16; trial++) {
    const names = ['P', 'Q', 'R', 'S'];
    const seed: SeedBlock[] = [
      { id: 'root', parent: null, role: 'root' },
      ...names.map((id): SeedBlock => ({ id, parent: 'root', role: 'quote' })),
    ];
    const f = new Fixture(seed);
    const localParents = ['A', 'B', 'C'].map(() => new Map(names.map((id) => [id, 'root'])));
    const ownActions: LayoutActionInput[][] = [[], [], []];
    const actions: LayoutActionInput[] = [];
    for (let i = 0; i < 18; i++) {
      const author = next(3);
      const node = names[next(names.length)];
      const parents = localParents[author];
      const legal = ['root', ...names].filter((candidate) => {
        let ancestor: string | undefined = candidate;
        while (ancestor !== undefined) {
          if (ancestor === node) return false;
          ancestor = parents.get(ancestor);
        }
        return true;
      });
      const parent = legal[next(legal.length)];
      const prior = ownActions[author].at(-1);
      const action = f.action(
        `${['A', 'B', 'C'][author]}${ownActions[author].length + 1}`,
        (f) => [f.move(node, parent)],
        prior ? [prior.action.id] : [],
        BigInt(ownActions[author].length + 1),
      );
      parents.set(node, parent);
      ownActions[author].push(action);
      actions.push(action);
      const local = reduceLayout(
        structuredClone(f.genesis),
        structuredClone(ownActions[author]),
        active,
      );
      expect(f.parents(local)).toEqual({ root: null, ...Object.fromEntries(parents) });
      invariants(local);
      // Every authored prefix is dependency closed; reordering/duplicates still replay it.
      invariants(
        reduceLayout(
          structuredClone(f.genesis),
          structuredClone([...actions].reverse().concat(action)),
          active,
        ),
      );
    }
    const peers = [
      actions,
      [...actions].reverse(),
      [...actions.slice(7), ...actions.slice(0, 7), ...actions],
    ].map((held) => reduceLayout(structuredClone(f.genesis), structuredClone(held), active));
    for (const peer of peers) {
      invariants(peer);
      expect(f.parents(peer)).toEqual(f.parents(peers[0]));
      expect(f.preorder(peer)).toEqual(f.preorder(peers[0]));
    }
  }
});

it.each([31, 32, 63, 64, 95, 96])(
  'keeps causal predecessor availability across word boundary %s',
  (size) => {
    const f = new Fixture();
    const prefix: LayoutActionInput[] = [];
    for (let i = 0; i < size; i++)
      prefix.push(
        f.action(`C${i + 1}`, () => [], i ? [prefix[i - 1].action.id] : [], BigInt(i + 1)),
      );
    const tail = prefix.at(-1)!.action.id;
    const a = f.action('A1', (f) => [f.move('P', 'root')], [tail], BigInt(size + 1));
    const predecessor = (a.action.effects[0] as Extract<SemanticEffect, { type: 'MoveBlock' }>)
      .occurrence;
    const bridge = f.action(`C${size + 1}`, () => [], [a.action.id], BigInt(size + 2));
    const b = f.action(
      'B1',
      (f) => [f.move('Q', 'root', f.alias(predecessor))],
      [bridge.action.id],
      BigInt(size + 3),
    );
    const layout = reduceLayout(f.genesis, [...prefix, a, bridge, b].reverse(), active);
    expect(f.preorder(layout)).toEqual(['P', 'Q']);
    invariants(layout);
    const unrelated = { ...bridge, action: { ...bridge.action, dependencies: [tail] } };
    expect(() => reduceLayout(f.genesis, [...prefix, a, unrelated, b], active)).toThrow(
      'causally available',
    );
  },
);
