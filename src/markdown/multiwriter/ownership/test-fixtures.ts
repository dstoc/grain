import { actorId } from '../contracts.js';
import type {
  ActionId,
  ActionEnvelope,
  Allocation,
  FlowId,
  InlineSlot,
  NativeTextRange,
  NodeId,
  OccurrenceId,
  RangeRef,
  ResourceId,
  ResourceKind,
  RunId,
  SemanticEffect,
} from '../contracts.js';
import type { LayoutActionInput, LayoutGenesis } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { NativeTapeCache } from '../text/cache.js';
import type { NativeBody, NativeInsertion } from '../text/cache.js';
import { reduceOwnership } from './index.js';
import { CellIndex } from './cells.js';
import { HomeIndex } from './homes.js';
import type { HomeBinding, OwnershipResult } from './index.js';
import type { SeedBlock } from '../../../../test/multiwriter/trace.js';

export class NativeFixture {
  readonly ids = new Map<string, ResourceId<ResourceKind>>();
  readonly slots = new Map<string, InlineSlot>();
  readonly aliases = new Map<string, NativeTextRange>();
  readonly emptyAliases = new Map<string, RangeRef>();
  readonly ranges = new Map<string, RangeRef>();
  readonly bodies = new Map<string, NativeBody>();
  readonly actions = new Map<string, LayoutActionInput>();
  readonly homes: HomeBinding[] = [];
  readonly contentRanges = new Map<string, RangeRef[]>();
  readonly genesis: LayoutGenesis;
  readonly peers = new Map<string, NativeTapeCache>();
  readonly held = new Map<string, Set<string>>();
  private batch: Allocation[] = [];
  private births: { node: NodeId; occurrence: OccurrenceId }[] = [];
  private operations: NativeInsertion[] = [];
  private ordinal = 0;
  private actionName = 'G';
  private birth: ResourceId<'node'>['birth'] = { type: 'genesis', genesisId: 'G' };
  private target: NativeTapeCache;
  constructor(
    seed: readonly SeedBlock[] = [
      { id: 'root', parent: null, role: 'root' },
      {
        id: 'P',
        parent: 'root',
        role: 'inline',
        flow: 'fP',
        run: 'rP',
        tape: 'tP',
        cells: [...'abcdef'].map((text, index) => ({ id: `P${index}`, text })),
      },
    ],
    private readonly nativeDecodeOperations?: number,
  ) {
    this.target = new NativeTapeCache(nativeDecodeOperations);
    const previous = new Map<string, OccurrenceId>();
    for (const block of seed) {
      const predecessor = block.parent ? (previous.get(block.parent) ?? null) : null;
      this.create(block, predecessor);
      if (block.parent) previous.set(block.parent, this.id(`${block.id}:birth`, 'occurrence'));
    }
    const prepared = this.target.prepare('G', this.operations);
    prepared.commit();
    this.batch.push(...prepared.body.allocations);
    this.genesis = { allocations: this.batch, births: this.births };
    this.bodies.set('G', prepared.body);
    for (const block of seed)
      for (const cell of block.cells ?? []) {
        const range = this.ranges.get(cell.id)!;
        if (!cell.text.length) {
          this.emptyAliases.set(cell.id, range);
          continue;
        }
        const text = this.target.range(range);
        if (text.length !== 1) throw new Error('Fixture cell must have one native text range');
        this.aliases.set(cell.id, text[0].range);
      }
    const clients = Array.from(
      { length: 3 },
      () => new NativeTapeCache(nativeDecodeOperations),
    ).sort((a, b) => a.clientId - b.clientId);
    for (const [i, name] of ['A', 'B', 'C'].entries()) {
      const cache = clients[i];
      cache.apply('G', prepared.body);
      this.peers.set(name, cache);
      this.held.set(name, new Set());
    }
    this.target.destroy();
  }
  id<K extends ResourceKind>(name: string, kind: K): ResourceId<K> {
    const id = this.ids.get(name);
    if (!id || id.kind !== kind) throw new Error(`Missing ${kind} alias ${name}`);
    return id as ResourceId<K>;
  }
  alias(id: ResourceId<ResourceKind>): string {
    return (
      [...this.ids].find(([, value]) => resourceKey(value) === resourceKey(id))?.[0] ??
      resourceKey(id)
    );
  }
  allocate<K extends ResourceKind>(name: string, kind: K): ResourceId<K> {
    if (this.ids.has(name)) throw new Error(`Duplicate fixture alias ${name}`);
    const id: ResourceId<K> = { kind, birth: this.birth, ordinal: this.ordinal++ };
    this.ids.set(name, id);
    return id;
  }
  private create(block: SeedBlock, predecessor: OccurrenceId | null): void {
    const node = this.allocate(block.id, 'node');
    const flow = block.flow ? this.allocate(block.flow, 'flow') : null;
    const slot = block.parent ? { parent: this.id(block.parent, 'node'), predecessor } : null;
    this.batch.push({ type: 'node', id: node, role: block.role, flow, birthSlot: slot });
    if (slot) {
      const occurrence = this.allocate(`${block.id}:birth`, 'occurrence');
      this.batch.push({ type: 'occurrence', id: occurrence, slot });
      this.births.push({ node, occurrence });
    }
    if (flow) {
      const run = this.allocate(block.run!, 'run');
      const tape = this.allocate(block.tape!, 'tape');
      const start = this.allocate(`${block.id}:start`, 'marker');
      const end = this.allocate(`${block.id}:end`, 'marker');
      this.operations.push({ type: 'createTape', tape, start, end });
      // Empty permanent guards retain source insertion locations after full text transfer.
      const first = block.cells?.length ? this.allocate(`${block.id}:guard`, 'marker') : start;
      if (block.cells?.length)
        this.operations.push({ type: 'marker', tape, index: 1, marker: first, affinity: 'left' });
      let before = first;
      let offset = 2;
      for (const cell of block.cells ?? []) {
        this.operations.push({ type: 'text', tape, index: offset, text: cell.text });
        offset += cell.text.length;
        const after = this.allocate(`${cell.id}:after`, 'marker');
        this.operations.push({
          type: 'marker',
          tape,
          index: offset++,
          marker: after,
          affinity: 'right',
        });
        this.ranges.set(cell.id, { tape, start: before, end: after });
        before = after;
      }
      this.contentRanges.set(
        block.id,
        block.cells?.length ? [{ tape, start: first, end: before }] : [],
      );
      const range = { tape, start, end };
      this.batch.push(
        { type: 'flow', id: flow, home: node },
        { type: 'run', id: run, flow, skeleton: [range] },
      );
      this.homes.push({ cell: range, run, occurrence: this.id(`${block.id}:birth`, 'occurrence') });
      for (const [name, boundary, side] of [
        [`${block.id}:start`, start, 'right'],
        [`${block.id}:end`, end, 'left'],
      ] as const)
        this.slots.set(name, { run, boundary, side, predecessor: null });
      this.slots.set(`${block.id}:home-end`, {
        run,
        boundary: end,
        side: 'left',
        predecessor: null,
      });
      for (const cell of block.cells ?? [])
        this.slots.set(`${block.id}:after-${cell.text}`, {
          run,
          boundary: this.ranges.get(cell.id)!.end,
          side: 'right',
          predecessor: null,
        });
    }
  }
  author(
    name: string,
    build: (fixture: NativeFixture) => readonly SemanticEffect[],
    dependencies: readonly string[] = [],
    lamport = 1n,
  ): LayoutActionInput {
    this.actionName = name;
    this.batch = [];
    this.births = [];
    this.operations = [];
    this.ordinal = 0;
    const id: ActionId = {
      actor: actorId((['A', 'B', 'C'].indexOf(name[0]) + 1).toString(16).padStart(32, '0')),
      sequence: BigInt(name.slice(1)),
    };
    this.birth = { type: 'action', action: id };
    this.target = this.peers.get(name[0])!;
    const effects = build(this);
    const prepared = this.target.prepare(name, this.operations);
    prepared.commit();
    this.batch.push(...prepared.body.allocations);
    const action = {
      action: {
        id,
        lamport,
        dependencies: dependencies.map((dependency) => this.actions.get(dependency)!.action.id),
        allocations: this.batch,
        effects,
      },
      births: this.births,
    };
    this.actions.set(name, action);
    this.bodies.set(name, prepared.body);
    this.held.get(name[0])!.add(name);
    return action;
  }
  split(
    source: string,
    node: string,
    after: string | null,
    retainedSide: 'left' | 'right' = 'left',
    parent = 'root',
    predecessor: string | null = retainedSide === 'left' ? `${source}:birth` : null,
    basisRanges?: readonly { range: RangeRef; occurrence: OccurrenceId }[],
  ): SemanticEffect {
    const sourceRun = this.id(`r${source}`, 'run');
    const captured =
      basisRanges ??
      (this.contentRanges.get(source) ?? []).map((range) => ({
        range,
        occurrence: this.id(`${source}:birth`, 'occurrence'),
      }));
    const full = captured[0]?.range;
    const sourceHome = this.homes.find((home) => resourceKey(home.run) === resourceKey(sourceRun))!;
    const marker = full ? this.allocate(`cut:${node}`, 'marker') : sourceHome.cell.end;
    if (full) {
      const index =
        after === null
          ? this.target.marker(full.start).index + 1
          : this.target.locate(this.aliases.get(after)!.tape, this.aliases.get(after)!) +
            this.aliases.get(after)!.length;
      this.operations.push({ type: 'marker', tape: full.tape, index, marker, affinity: 'right' });
    }
    const newNode = this.allocate(node, 'node');
    const newFlow = this.allocate(`f${node}`, 'flow');
    const newRun = this.allocate(`r${node}`, 'run');
    const occurrence = this.allocate(`${node}:birth`, 'occurrence');
    const outerSlot = {
      parent: this.id(parent, 'node'),
      predecessor: predecessor ? this.id(predecessor, 'occurrence') : null,
    };
    const content = full
      ? [
          { ...full, ...(retainedSide === 'left' ? { start: marker } : { end: marker }) },
          ...(retainedSide === 'left' ? captured.slice(1).map((entry) => entry.range) : []),
        ]
      : [];
    const homeTape = this.allocate(`t${node}`, 'tape');
    const homeStart = this.allocate(`${node}:home-start`, 'marker');
    const homeEnd = this.allocate(`${node}:home-end`, 'marker');
    const homeRange = { tape: homeTape, start: homeStart, end: homeEnd };
    this.operations.push({ type: 'createTape', tape: homeTape, start: homeStart, end: homeEnd });
    const skeleton = [...content, homeRange];
    this.homes.push({ cell: homeRange, run: newRun, occurrence });
    this.contentRanges.set(node, content);
    this.slots.set(`${node}:home-end`, {
      run: newRun,
      boundary: homeEnd,
      side: 'left',
      predecessor: null,
    });
    this.batch.push(
      { type: 'node', id: newNode, role: 'inline', flow: newFlow, birthSlot: outerSlot },
      { type: 'flow', id: newFlow, home: newNode },
      { type: 'run', id: newRun, flow: newFlow, skeleton },
      { type: 'occurrence', id: occurrence, slot: outerSlot },
    );
    this.births.push({ node: newNode, occurrence });
    this.slots.set(`${node}:end`, {
      run: newRun,
      boundary: full ? (retainedSide === 'left' ? full.end : marker) : homeEnd,
      side: 'left',
      predecessor: null,
    });
    this.slots.set(`${node}:start`, {
      run: newRun,
      boundary: full ? (retainedSide === 'left' ? marker : full.start) : homeStart,
      side: 'right',
      predecessor: null,
    });
    return {
      type: 'SplitFlow',
      basis: { ranges: captured },
      cut: { run: sourceRun, boundary: marker, side: full ? 'right' : 'left', predecessor: null },
      retainedSide,
      newNode,
      newFlow,
      newRun,
      occurrence,
      outerSlot,
    };
  }
  transfer(cells: readonly string[], destination: string, name: string): SemanticEffect {
    const ranges = cells.map((cell) => this.ranges.get(cell)!);
    return this.transferRanges(ranges, this.slots.get(destination)!, name);
  }
  transferRanges(
    ranges: readonly RangeRef[],
    destination: InlineSlot,
    name: string,
  ): SemanticEffect {
    const run = this.allocate(name, 'run');
    const occurrence = this.allocate(`${name}:attachment`, 'occurrence');
    const flow = this.runFlow(destination.run);
    this.batch.push(
      { type: 'run', id: run, flow, skeleton: ranges },
      { type: 'occurrence', id: occurrence, slot: destination },
    );
    return { type: 'TransferRange', ranges, destination, run, occurrence };
  }
  runFlow(run: RunId): FlowId {
    const allocation = [
      ...this.genesis.allocations,
      ...[...this.actions.values()].flatMap((entry) => entry.action.allocations),
      ...this.batch,
    ].find(
      (allocation) => allocation.type === 'run' && resourceKey(allocation.id) === resourceKey(run),
    );
    if (!allocation || allocation.type !== 'run') throw new Error('Missing fixture run');
    return allocation.flow;
  }
  join(source: string, destination: string): SemanticEffect {
    const occurrence = this.allocate(
      `join:${this.actionName}:${source}:${this.ordinal}`,
      'occurrence',
    );
    const slot = this.slots.get(destination)!;
    this.batch.push({ type: 'occurrence', id: occurrence, slot });
    return {
      type: 'JoinFlow',
      source: this.id(source, 'flow'),
      destination: slot,
      occurrence,
      liftedChildren: [],
    };
  }
  move(node: string, parent: string, predecessor: string | null = null): SemanticEffect {
    const occurrence = this.allocate(
      `move:${this.actionName}:${node}:${this.ordinal}`,
      'occurrence',
    );
    const slot = {
      parent: this.id(parent, 'node'),
      predecessor: predecessor ? this.id(predecessor, 'occurrence') : null,
    };
    this.batch.push({ type: 'occurrence', id: occurrence, slot });
    const allocation = [
      ...this.genesis.allocations,
      ...[...this.actions.values()].flatMap((entry) => entry.action.allocations),
    ].find(
      (entry) =>
        entry.type === 'node' && resourceKey(entry.id) === resourceKey(this.id(node, 'node')),
    )!;
    if (allocation.type !== 'node') throw new Error('Missing fixture node');
    return {
      type: 'MoveBlock',
      node: allocation.id,
      occurrence,
      slot,
      standaloneFlow: allocation.flow,
    };
  }
  deleteSubtree(
    node: string,
    intervals: readonly RangeRef[],
    heads: readonly string[],
  ): SemanticEffect {
    const tag = this.allocate(`delete:${this.actionName}:${node}`, 'deletion');
    this.batch.push({ type: 'deletion', id: tag });
    const target = this.id(node, 'node');
    return {
      type: 'DeleteSubtree',
      tag,
      scope: {
        target,
        observedNodes: [target],
        ownedIntervals: intervals,
        joinedFlows: [],
        heads: heads.map((name) => this.actions.get(name)!.action.id),
      },
    };
  }
  insert(_cell: string, text: string, slot: string): readonly SemanticEffect[] {
    const target = this.slots.get(slot)!;
    const homes = this.homes.filter((home) => {
      try {
        this.target.marker(home.cell.start);
        return true;
      } catch {
        return false;
      }
    });
    const index = new CellIndex(homes.map((home) => this.target.snapshot(home.cell.tape)));
    this.operations.push(
      ...new HomeIndex(homes, index).planTextInsertion(target, text, () =>
        this.allocate(`typing:${this.actionName}:${this.ordinal}`, 'marker'),
      ),
    );
    // Native ranges are bound after publication, when the cache exposes exact identities.
    return [];
  }
  native(operations: readonly NativeInsertion[]): void {
    this.operations.push(...operations);
  }
  createBlock(block: SeedBlock, predecessor: string | null): void {
    this.create(block, predecessor ? this.id(predecessor, 'occurrence') : null);
  }
  bindInserted(name: string, action: string): void {
    const body = this.bodies.get(action)!;
    const birth = body.nativeManifest.find((entry) => entry.type === 'text');
    if (!birth || birth.type !== 'text') throw new Error('Missing inserted fixture text');
    this.aliases.set(name, { tape: birth.tape, ...birth.native });
  }
  deliver(_from: string, to: string, names: readonly string[]): void {
    for (const name of names) {
      this.peers.get(to)!.apply(name, this.bodies.get(name)!);
      this.held.get(to)!.add(name);
    }
  }
  ready(peer: string): string[] {
    const ready = new Set<string>();
    const held = [...this.held.get(peer)!];
    let changed = true;
    while (changed) {
      changed = false;
      for (const name of held) {
        const action = this.actions.get(name)!.action;
        if (
          !ready.has(name) &&
          action.dependencies.every((id) =>
            [...ready].some((other) => {
              const previous = this.actions.get(other)!.action.id;
              return previous.actor === id.actor && previous.sequence === id.sequence;
            }),
          )
        ) {
          ready.add(name);
          changed = true;
        }
      }
    }
    return [...ready];
  }
  envelope(name: string): ActionEnvelope {
    const action = this.actions.get(name)!.action;
    const body = this.bodies.get(name)!;
    return {
      ...structuredClone(action),
      protocolVersion: 3,
      documentId: 'D',
      genesisId: 'G',
      groupId: {
        session: { actor: action.id.actor, local: 'editor' },
        sequence: action.id.sequence,
      },
      nativeManifest: structuredClone(body.nativeManifest),
      nativeInsertUpdates: body.nativeInsertUpdates.map((bytes) => bytes.slice()),
      effects: [
        ...structuredClone(action.effects),
        ...(body.nativeManifest.some((birth) => birth.type === 'text')
          ? [
              {
                type: 'InsertText' as const,
                ranges: body.nativeManifest.flatMap((birth) =>
                  birth.type === 'text' ? [{ tape: birth.tape, ...birth.native }] : [],
                ),
              },
            ]
          : []),
      ],
    };
  }
  reduce(peer = 'C', inactive: readonly string[] = []): OwnershipResult {
    const held = this.ready(peer);
    const tapes = [
      ...this.genesis.allocations,
      ...held.flatMap((name) => this.actions.get(name)!.action.allocations),
    ].filter((entry) => entry.type === 'tape');
    return reduceOwnership({
      genesis: this.genesis,
      actions: held.map((name) => this.actions.get(name)!),
      snapshots: tapes.map((entry) => this.peers.get(peer)!.snapshot(entry.id)),
      homes: this.homes.filter((home) =>
        tapes.some((tape) => resourceKey(tape.id) === resourceKey(home.cell.tape)),
      ),
      isActive: (order) =>
        !inactive.some((name) => {
          const action = this.actions.get(name)!.action;
          return (
            order.action.id.actor === action.id.actor &&
            order.action.id.sequence === action.id.sequence
          );
        }),
    });
  }
  text(result: OwnershipResult, flow: string): string {
    return result
      .raw(this.id(flow, 'flow'))
      .flatMap((entry) =>
        entry.type === 'cell' ? entry.fragments.map((fragment) => fragment.text) : [],
      )
      .join('');
  }
  cellRuns(result: OwnershipResult): Record<string, string> {
    return {
      ...Object.fromEntries(
        [...this.emptyAliases].map(([alias, range]) => {
          const cells = result.cells(range);
          if (cells.length !== 1) throw new Error('Empty alias must name one cell');
          return [alias, this.alias(cells[0].run)];
        }),
      ),
      ...Object.fromEntries(
        [...this.aliases]
          .filter(([, token]) => {
            try {
              return result.tokenOwners(token).length > 0;
            } catch {
              return false;
            }
          })
          .map(([alias, token]) => {
            const owners = result.tokenOwners(token);
            if (new Set(owners.map((owner) => resourceKey(owner.run))).size !== 1)
              throw new Error('Alias spans owners');
            return [alias, this.alias(owners[0].run)];
          }),
      ),
    };
  }
  fresh(peer: string, order: readonly string[]): void {
    this.peers.get(peer)!.destroy();
    const cache = new NativeTapeCache(this.nativeDecodeOperations);
    cache.apply('G', this.bodies.get('G')!);
    for (const name of order) cache.apply(name, this.bodies.get(name)!);
    this.peers.set(peer, cache);
    this.held.set(peer, new Set(order));
  }
  destroy(): void {
    for (const peer of this.peers.values()) peer.destroy();
  }
}
