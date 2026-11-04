import { compareActions } from '../contracts.js';
import type {
  ActionId,
  CellAssignment,
  FlowId,
  InlineSlot,
  NativeTextRange,
  NativeId,
  TapeId,
  NodeId,
  RangeRef,
  RunId,
  SemanticEffect,
} from '../contracts.js';
import { LayoutPrefix, resourceKey } from '../layout/index.js';
import type {
  EffectOrder,
  LayoutActionInput,
  LayoutGenesis,
  OccurrenceBucket,
} from '../layout/index.js';
import type { TapeSnapshot } from '../text/cache.js';
import { CellIndex, assignmentKey, cellKey, sameId } from './cells.js';
import { cutPosition, splitBuckets } from './cohorts.js';
import { deriveHomes, HomeIndex } from './homes.js';
import type { HomeBinding } from './homes.js';
export type { HomeBinding } from './homes.js';
import type { SplitBirth } from './cohorts.js';
import { traverse } from './traversal.js';
import type { RawInlineEntry, RunAttachment, RunOrigin } from './traversal.js';

export interface OwnershipInput {
  readonly genesis: LayoutGenesis;
  readonly actions: readonly LayoutActionInput[];
  readonly snapshots: readonly TapeSnapshot[];
  readonly homes?: readonly HomeBinding[];
  readonly isActive: (order: EffectOrder) => boolean;
}
export interface DestinationRequirement {
  readonly order: EffectOrder;
  readonly nodes: readonly NodeId[];
}

/** Read-only facade over a completed replay. Queries return detached values.
 * This is raw ownership, not visibility or normalization. containsBirthContent for
 * MW-05 must be derived separately from each node's birth-causal intervals.
 */
export class OwnershipResult {
  constructor(
    private readonly layout: LayoutPrefix,
    private readonly index: CellIndex,
    private readonly owners: ReadonlyMap<string, CellAssignment>,
    private readonly roots: ReadonlyMap<string, readonly RunOrigin[]>,
    private readonly attachments: ReadonlyMap<string, RunAttachment>,
    private readonly cohorts: readonly OccurrenceBucket[],
    private readonly requirements: readonly DestinationRequirement[],
    private readonly homes: readonly HomeBinding[],
  ) {}
  get homeBindings(): readonly HomeBinding[] {
    return structuredClone(this.homes);
  }
  get assignments(): readonly CellAssignment[] {
    return structuredClone([...this.owners.values()]);
  }
  get runLayouts() {
    return structuredClone(this.layout.runLayouts);
  }
  get flowPlacements() {
    return structuredClone(this.layout.flowPlacements);
  }
  get nodeAllocations() {
    return structuredClone(this.layout.nodeAllocations);
  }
  get buckets(): readonly OccurrenceBucket[] {
    return structuredClone(this.cohorts);
  }
  get destinationRequirements(): readonly DestinationRequirement[] {
    return structuredClone(this.requirements);
  }
  blockPlacement(node: NodeId) {
    return structuredClone(this.layout.blockPlacement(node));
  }
  flowBlock(flow: FlowId): NodeId {
    return structuredClone(this.layout.flowBlock(flow));
  }
  children(parent: NodeId): readonly NodeId[] {
    // Layout orders one parent at a time; buckets for other sequences must not enter it.
    const buckets = this.cohorts.filter((bucket) => {
      const slot = this.layout.occurrence(bucket.roots[0]).slot;
      return 'parent' in slot && sameId(slot.parent, parent);
    });
    return structuredClone(this.layout.children(parent, buckets));
  }
  resolveSlot(slot: InlineSlot) {
    return structuredClone(this.layout.resolveInlineSlot(slot, this.index));
  }
  containsBoundary(range: RangeRef, boundary: InlineSlot['boundary']): boolean {
    return this.index.containsBoundary(range, boundary);
  }
  cells(range: RangeRef): readonly CellAssignment[] {
    return structuredClone(this.index.range(range).map((cell) => this.ownerOfCell(cell.range)));
  }
  /** Scalar UTF-16 identity lookup does not slice a Unicode character. */
  owner(token: { readonly tape: TapeId; readonly native: NativeId }): CellAssignment {
    return structuredClone(
      this.ownerOfCell(this.index.locateToken(token.tape, token.native).range),
    );
  }
  contains(range: RangeRef, token: { readonly tape: TapeId; readonly native: NativeId }): boolean {
    if (!sameId(range.tape, token.tape)) return false;
    const cell = this.index.locateToken(token.tape, token.native);
    return this.index.range(range).some((member) => cellKey(member.range) === cellKey(cell.range));
  }
  tokenOwners(token: NativeTextRange): readonly CellAssignment[] {
    return structuredClone(this.index.token(token).map((cell) => this.ownerOfCell(cell.range)));
  }
  inlineOwner(token: NativeTextRange): readonly NodeId[] {
    return structuredClone([
      ...new Map(
        this.tokenOwners(token).map((owner) => {
          const node = this.layout.flowBlock(this.layout.runLayout(owner.run).flow);
          return [resourceKey(node), node];
        }),
      ).values(),
    ]);
  }
  raw(flow: FlowId): readonly RawInlineEntry[] {
    return structuredClone(
      traverse(flow, this.layout, this.index, this.owners, this.roots, this.attachments),
    );
  }
  private ownerOfCell(range: RangeRef): CellAssignment {
    const owner = this.owners.get(cellKey(range));
    if (!owner) throw new Error('Cell is not available at this prefix');
    return owner;
  }
}

function actionKey(input: LayoutActionInput): string {
  return JSON.stringify([input.action.id.actor, input.action.id.sequence.toString()]);
}

/** Full reference reduction over a validated dependency-closed ready set. Readiness,
 * author-closure certification and history activity remain caller obligations.
 */
export function reduceOwnership(input: OwnershipInput): OwnershipResult {
  return replayOwnership(input);
}

/** Exact author closure only; concurrent merge must never re-run these author-local checks. */
export function certifyOwnership(input: OwnershipInput, author: ActionId): void {
  if (
    !input.actions.some(
      (entry) =>
        entry.action.id.actor === author.actor && entry.action.id.sequence === author.sequence,
    )
  )
    throw new Error('Certification requires the candidate action');
  replayOwnership(input, author);
}

function replayOwnership(input: OwnershipInput, author?: ActionId): OwnershipResult {
  const genesis = structuredClone(input.genesis);
  const actions = [
    ...new Map(input.actions.map((entry) => [actionKey(entry), structuredClone(entry)])).values(),
  ].sort((a, b) => compareActions(a.action, b.action));
  const homes = [
    ...deriveHomes(genesis),
    ...actions.flatMap((entry) =>
      deriveHomes(
        { allocations: entry.action.allocations, births: entry.births },
        entry.action.effects,
      ),
    ),
  ];
  if (input.homes) {
    const keys = (values: readonly HomeBinding[]) =>
      values.map((home) => `${cellKey(home.cell)}:${assignmentKey(home)}`).sort();
    const supplied = keys(input.homes);
    if (new Set(supplied).size !== supplied.length) throw new Error('Conflicting home bindings');
    if (supplied.length !== homes.length) throw new Error('Incomplete home bindings');
    if (JSON.stringify(supplied) !== JSON.stringify(keys(homes)))
      throw new Error('Home endpoints or binding differ from retained births');
  }
  const index = new CellIndex(input.snapshots);
  const layout = new LayoutPrefix(genesis);
  const owners = new Map<string, CellAssignment>();
  const roots = new Map<string, RunOrigin[]>();
  const attachments = new Map<string, RunAttachment>();
  const splits: SplitBirth[] = [];
  const candidates: { order: EffectOrder; effect: SemanticEffect }[] = [];
  const flowIntentions = new Map<string, EffectOrder>();
  const installedTapes = new Set<string>();
  const allAllocations = [
    ...genesis.allocations,
    ...actions.flatMap((entry) => entry.action.allocations),
  ];
  const tapeAllocations = allAllocations.filter((allocation) => allocation.type === 'tape');
  if (tapeAllocations.length !== input.snapshots.length)
    throw new Error('Native snapshots must cover exactly the ready tapes');
  const markerAllocations = allAllocations.filter((allocation) => allocation.type === 'marker');
  for (const snapshot of input.snapshots) {
    const tape = tapeAllocations.find((entry) => sameId(entry.id, snapshot.tape));
    const markers = snapshot.parts.filter((part) => part.type === 'marker');
    if (
      !tape ||
      !sameId(markers[0].marker, tape.start) ||
      !sameId(markers.at(-1)!.marker, tape.end)
    )
      throw new Error('Snapshot does not match retained tape endpoints');
    for (const marker of markers) {
      const allocation = markerAllocations.find((entry) => sameId(entry.id, marker.marker));
      if (
        !allocation ||
        !sameId(allocation.tape, snapshot.tape) ||
        allocation.native.client !== marker.native.client ||
        allocation.native.clock !== marker.native.clock
      )
        throw new Error('Snapshot marker does not match retained allocation');
    }
  }
  if (
    markerAllocations.length !==
    input.snapshots.reduce(
      (sum, snapshot) => sum + snapshot.parts.filter((part) => part.type === 'marker').length,
      0,
    )
  )
    throw new Error('Native snapshots must cover exactly the ready markers');

  const homeIndex = new HomeIndex(homes, index);
  for (const allocation of allAllocations) {
    if (allocation.type !== 'run') continue;
    const home = homes.find((home) => sameId(home.run, allocation.id));
    const captures = home ? allocation.skeleton.slice(0, -1) : allocation.skeleton;
    const seen = new Set<string>();
    for (const range of allocation.skeleton)
      for (const cell of index.range(range)) {
        const key = cellKey(cell.range);
        if (seen.has(key)) throw new Error('Overlapping retained run skeleton');
        seen.add(key);
      }
    for (const range of captures) homeIndex.assertCapture(range);
  }
  for (const entry of actions)
    for (const effect of entry.action.effects) {
      if (effect.type === 'SplitFlow') {
        for (const member of effect.basis.ranges) homeIndex.assertCapture(member.range);
        const newHome = homeIndex.home(effect.newRun);
        if (!sameId(newHome.occurrence, effect.occurrence))
          throw new Error('Split root occurrence differs from retained home');
        if (!effect.basis.ranges.length) {
          const home = homeIndex.home(effect.cut.run);
          if (
            !sameId(effect.cut.boundary, home.cell.end) ||
            effect.cut.side !== 'left' ||
            effect.cut.predecessor !== null
          )
            throw new Error('Empty split needs the canonical trailing home cut');
          if (layoutRun(effect.newRun).skeleton.length !== 1)
            throw new Error('Empty split must capture no source content');
        }
      } else if (effect.type === 'TransferRange')
        for (const range of effect.ranges) homeIndex.assertCapture(range);
    }
  function layoutRun(run: RunId) {
    const allocation = allAllocations.find(
      (entry) => entry.type === 'run' && sameId(entry.id, run),
    );
    if (!allocation || allocation.type !== 'run') throw new Error('Missing retained run');
    return allocation;
  }
  function install(batch: LayoutGenesis, effects: readonly SemanticEffect[]): void {
    const transfers = effects.filter((effect) => effect.type === 'TransferRange');
    // Retained occurrence locations are ghost traversal paths, even when inactive.
    // Installing an address does not assign cells or assert a flow containment edge.
    for (const transfer of transfers) {
      layout.resolveInlineSlot(transfer.destination, index);
      const occurrence = layout.occurrence(transfer.occurrence);
      const run = layout.runLayout(transfer.run);
      if ('parent' in occurrence.slot || !sameInlineSlot(occurrence.slot, transfer.destination))
        throw new Error('Transfer occurrence slot is immutable');
      if (!sameId(run.flow, layout.runLayout(transfer.destination.run).flow))
        throw new Error('Transfer run has a different immutable destination flow');
      if (
        run.skeleton.length !== transfer.ranges.length ||
        run.skeleton.some((range, i) => cellKey(range) !== cellKey(transfer.ranges[i]))
      )
        throw new Error('Transfer skeleton must retain authored range order');
      attachments.set(resourceKey(transfer.occurrence), {
        run: transfer.run,
        occurrence: transfer.occurrence,
        destination: transfer.destination,
      });
    }
    for (const home of homes.filter((home) =>
      batch.allocations.some((entry) => entry.type === 'tape' && sameId(entry.id, home.cell.tape)),
    )) {
      const tapeKey = resourceKey(home.cell.tape);
      if (installedTapes.has(tapeKey)) throw new Error('Duplicate tape birth');
      installedTapes.add(tapeKey);
      const flowKey = resourceKey(layout.runLayout(home.run).flow);
      if (roots.has(flowKey)) throw new Error('Ambiguous home run order');
      roots.set(flowKey, [{ run: home.run, occurrence: home.occurrence }]);
      for (const cell of index.range(home.cell)) {
        const key = cellKey(cell.range);
        if (owners.has(key)) throw new Error('Conflicting home coverage');
        owners.set(key, { cell: cell.range, run: home.run, occurrence: home.occurrence });
      }
    }
  }
  function rawCells(flow: FlowId) {
    return traverse(flow, layout, index, owners, roots, attachments).flatMap((entry) =>
      entry.type === 'cell' ? [entry.assignment] : [],
    );
  }
  function assertCoverage(): void {
    const visited = new Set<string>();
    for (const placement of layout.flowPlacements) {
      if (placement.parent.type !== 'block') continue;
      for (const assignment of rawCells(placement.flow)) {
        const key = cellKey(assignment.cell);
        if (visited.has(key)) throw new Error('Cell emitted more than once');
        visited.add(key);
      }
    }
    if (visited.size !== owners.size) throw new Error('Owned cell is unreachable in raw traversal');
    for (const home of homes) {
      if (!installedTapes.has(resourceKey(home.cell.tape))) continue;
      for (const cell of index.range(home.cell)) {
        if (!homeIndex.isReserved(cell.range)) continue;
        const owner = owners.get(cellKey(cell.range));
        if (!owner || assignmentKey(owner) !== assignmentKey(home))
          throw new Error('Reserved home cell lost its root assignment');
      }
    }
  }
  function assign(
    ranges: readonly RangeRef[],
    run: RunId,
    occurrence: CellAssignment['occurrence'],
  ): void {
    const skeleton = new Set(
      layout
        .runLayout(run)
        .skeleton.flatMap((range) => index.range(range))
        .map((cell) => cellKey(cell.range)),
    );
    const selected = new Set<string>();
    for (const range of ranges)
      for (const cell of index.range(range)) {
        const key = cellKey(cell.range);
        if (!owners.has(key)) throw new Error('Structural range uses an unavailable tape');
        if (!skeleton.has(key)) throw new Error('Assignment outside retained run skeleton');
        if (selected.has(key)) throw new Error('Repeated cell in structural assignment');
        selected.add(key);
        owners.set(key, { cell: cell.range, run, occurrence });
      }
  }
  install(genesis, []);
  assertCoverage();
  for (const entry of actions) {
    layout.beginAction(entry);
    install({ allocations: entry.action.allocations, births: entry.births }, entry.action.effects);
    for (const [ordinal, effect] of entry.action.effects.entries()) {
      const order = { action: { id: entry.action.id, lamport: entry.action.lamport }, ordinal };
      const active = input.isActive(order);
      const certifying =
        author &&
        author.actor === entry.action.id.actor &&
        author.sequence === entry.action.id.sequence;
      if (certifying && effect.type === 'SplitFlow') {
        const sourceRun = layout.runLayout(effect.cut.run);
        const laterBirth = entry.action.effects.findIndex(
          (candidate) => candidate.type === 'SplitFlow' && sameId(candidate.newRun, effect.cut.run),
        );
        if (laterBirth >= ordinal)
          throw new Error('Split source is not yet available at its effect prefix');
        if (!effect.basis.ranges.length) {
          const source = layout.flowPlacement(sourceRun.flow);
          if (source.parent.type !== 'block')
            throw new Error('Empty split source must be standalone');
          if (rawCells(sourceRun.flow).some((cell) => !homeIndex.isReserved(cell.cell)))
            throw new Error('Empty split omits author-visible content cells');
        } else {
          for (const member of effect.basis.ranges)
            for (const cell of index.range(member.range)) {
              const owner = owners.get(cellKey(cell.range));
              if (!owner || !sameId(owner.occurrence, member.occurrence))
                throw new Error('Basis occurrence differs from author ownership');
            }
          const basis = effect.basis.ranges.flatMap((member) => index.range(member.range));
          const cut = cutPosition(effect, index, homeIndex);
          const expected = (
            effect.retainedSide === 'left' ? basis.slice(cut) : basis.slice(0, cut)
          ).map((cell) => cellKey(cell.range));
          const actual = layout
            .runLayout(effect.newRun)
            .skeleton.slice(0, -1)
            .flatMap((range) => index.range(range))
            .map((cell) => cellKey(cell.range));
          if (JSON.stringify(actual) !== JSON.stringify(expected))
            throw new Error('Split skeleton differs from authored captured component');
        }
      }
      if (active && effect.type === 'TransferRange') {
        // Resolve all source ranges before installing the destination attachment.
        for (const range of effect.ranges) index.range(range);
        assign(effect.ranges, effect.run, effect.occurrence);
      } else if (active && effect.type === 'SplitFlow') {
        layout.resolveInlineSlot(effect.cut, index);
        for (const range of effect.basis.ranges) layout.occurrence(range.occurrence);
        const basis = effect.basis.ranges.flatMap((range) => index.range(range.range));
        const cut = cutPosition(effect, index, homeIndex);
        if (basis.length) {
          const left = effect.retainedSide === 'left';
          const reference = basis[left ? Math.max(0, cut - 1) : Math.min(cut, basis.length - 1)];
          if (!reference) throw new Error('Split needs an addressable basis cell');
          const referenceOwner = owners.get(cellKey(reference.range));
          if (!referenceOwner) throw new Error('Split basis uses an unavailable tape');
          const block = layout.flowBlock(layout.runLayout(referenceOwner.run).flow);
          const flow = layout.flowPlacements.find(
            (placement) =>
              placement.parent.type === 'block' && sameId(placement.parent.node, block),
          )!.flow;
          const current = rawCells(flow).filter(
            (assignment) => !homeIndex.isReserved(assignment.cell),
          );
          const positions = new Map(
            current.map((assignment, position) => [cellKey(assignment.cell), position]),
          );
          const candidates = left ? basis.slice(cut) : basis.slice(0, cut).reverse();
          const selected: RangeRef[] = [];
          let previous: number | undefined = left
            ? cut > 0
              ? positions.get(cellKey(reference.range))
              : undefined
            : cut < basis.length
              ? positions.get(cellKey(reference.range))
              : undefined;
          for (const cell of candidates) {
            const position = positions.get(cellKey(cell.range));
            if (
              position === undefined ||
              (previous !== undefined && position !== previous + (left ? 1 : -1))
            )
              break;
            selected.push(cell.range);
            previous = position;
          }
          assign(selected, effect.newRun, effect.occurrence);
        }
        const run = layout.runLayout(effect.newRun);
        const node = layout.nodeAllocations.find((node) => sameId(node.id, effect.newNode));
        const birth = layout.blockPlacement(effect.newNode);
        if (
          !node?.flow ||
          !sameId(node.flow, effect.newFlow) ||
          !sameId(run.flow, effect.newFlow) ||
          !birth ||
          !sameId(birth.occurrence, effect.occurrence)
        )
          throw new Error('Split allocation does not match retained birth');
        if (
          !sameId(birth.slot.parent, effect.outerSlot.parent) ||
          !sameNullableId(birth.slot.predecessor, effect.outerSlot.predecessor)
        )
          throw new Error('Split outer slot differs from retained birth');
        splits.push({ effect, order });
      }
      const result = layout.step(ordinal, active);
      if (active) candidates.push({ order, effect });
      for (const changed of result.flows)
        if (changed.result === 'applied') flowIntentions.set(resourceKey(changed.flow), order);
      assertCoverage();
    }
  }
  if (homes.some((home) => !installedTapes.has(resourceKey(home.cell.tape))))
    throw new Error('Home binding references an unavailable tape');
  const flowHome = (flow: FlowId): NodeId => {
    const allocation = allAllocations.find(
      (entry) => entry.type === 'flow' && sameId(entry.id, flow),
    );
    if (!allocation || allocation.type !== 'flow') throw new Error('Missing flow home');
    return allocation.home;
  };
  const requirements: DestinationRequirement[] = [];
  for (const { order, effect } of candidates) {
    const nodes: NodeId[] = [];
    switch (effect.type) {
      case 'TransferRange':
        if (
          [...owners.values()].some(
            (owner) => sameId(owner.run, effect.run) && sameId(owner.occurrence, effect.occurrence),
          )
        )
          nodes.push(flowHome(layout.runLayout(effect.destination.run).flow));
        break;
      case 'JoinFlow': {
        const placement = layout.flowPlacement(effect.source);
        if (
          placement.parent.type === 'flow' &&
          sameId(placement.parent.occurrence, effect.occurrence)
        )
          nodes.push(flowHome(layout.runLayout(effect.destination.run).flow));
        break;
      }
      case 'SplitFlow': {
        nodes.push(effect.newNode);
        if (sameId(layout.blockPlacement(effect.newNode)!.occurrence, effect.occurrence))
          nodes.push(effect.outerSlot.parent);
        break;
      }
      case 'MoveBlock':
        if (sameId(layout.blockPlacement(effect.node)!.occurrence, effect.occurrence))
          nodes.push(effect.slot.parent);
        if (
          effect.standaloneFlow &&
          flowIntentions.get(resourceKey(effect.standaloneFlow)) === order
        )
          nodes.push(flowHome(effect.standaloneFlow));
        break;
      case 'LiftChildren':
        for (const placement of effect.placements)
          if (sameId(layout.blockPlacement(placement.node)!.occurrence, placement.occurrence))
            nodes.push(placement.slot.parent);
        break;
      default:
        break;
    }
    if (nodes.length)
      requirements.push({
        order,
        nodes: [...new Map(nodes.map((node) => [resourceKey(node), node])).values()],
      });
  }
  return new OwnershipResult(
    layout,
    index,
    owners,
    roots,
    attachments,
    splitBuckets(splits, layout, index, homeIndex),
    requirements,
    homes,
  );
}
function sameNullableId(a: InlineSlot['predecessor'], b: InlineSlot['predecessor']): boolean {
  return a === null ? b === null : b !== null && sameId(a, b);
}
function sameInlineSlot(a: InlineSlot, b: InlineSlot): boolean {
  return (
    sameId(a.run, b.run) &&
    sameId(a.boundary, b.boundary) &&
    a.side === b.side &&
    sameNullableId(a.predecessor, b.predecessor)
  );
}
