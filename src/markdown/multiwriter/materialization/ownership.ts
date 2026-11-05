import { compareActions } from '../contracts.js';
import type {
  CellAssignment,
  FlowId,
  InlineSlot,
  NodeId,
  RangeRef,
  RunId,
  SemanticEffect,
} from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import type { EffectOrder, LayoutActionInput, LayoutGenesis } from '../layout/index.js';
import { assignmentKey, cellKey, sameId } from '../ownership/cells.js';
import { cutPosition, splitBuckets } from '../ownership/cohorts.js';
import type { HomeBinding } from '../ownership/homes.js';
import type { SplitBirth } from '../ownership/cohorts.js';
import { traverse } from '../ownership/traversal.js';
import type { RunAttachment, RunOrigin } from '../ownership/traversal.js';

import { OwnershipResult } from '../ownership/ownership.js';
import type { OwnershipInput, DestinationRequirement } from '../ownership/ownership.js';
import type { Activity } from '../visibility/activity.js';
import { PersistentMap } from './map.js';
import { MaterializedLayout } from './layout.js';
import { MaterializedCells } from './cells.js';
import { OwnershipResources } from './resources.js';
import { NativeReadIntervals } from './intervals.js';
export interface OwnershipCheckpoint {
  readonly count: number;
  readonly index: MaterializedCells;
  readonly layout: MaterializedLayout;
  readonly owners: PersistentMap<CellAssignment>;
  readonly roots: PersistentMap<readonly RunOrigin[]>;
  readonly attachments: PersistentMap<RunAttachment>;
  readonly splits: readonly SplitBirth[];
  readonly candidates: readonly { readonly order: EffectOrder; readonly effect: SemanticEffect }[];
  readonly flowIntentions: PersistentMap<EffectOrder>;
  readonly installedTapes: PersistentMap<true>;
  /** First active split whose result depends on each native tape's cell topology. */
  readonly nativeReaders: PersistentMap<number>;
  /** Retained marker intervals read by split adjacency, with their first action. */
  readonly nativeIntervals: PersistentMap<NativeReadIntervals>;
}
/** Match full replay's home-install/native-cell order independently of the edit
 * order of the persistent assignment map. Refinement can insert cells between
 * retained keys; changing a map key must not reorder the public raw result.
 */
export function orderedOwners(
  index: MaterializedCells,
  owners: PersistentMap<CellAssignment>,
  homes: readonly HomeBinding[],
) {
  return {
    get: (key: string) => owners.get(key),
    *values(): Generator<CellAssignment, undefined, unknown> {
      for (const home of homes)
        for (const cell of index.range(home.cell)) {
          const owner = owners.get(cellKey(cell.range));
          if (!owner) throw new Error('Native cell lacks a refined assignment');
          yield owner;
        }
      return undefined;
    },
  };
}
function actionKey(input: LayoutActionInput): string {
  return JSON.stringify([input.action.id.actor, input.action.id.sequence.toString()]);
}

/** Coupled suffix replay. Checkpoints fork placement and ownership roots together.
 * Author-local certification stays in the independent full reference implementation.
 */
export function replayOwnershipSuffix(
  input: OwnershipInput,
  activity: Activity,
  resume: OwnershipCheckpoint | undefined,
  save: (checkpoint: OwnershipCheckpoint) => void,
  nativeIndex: MaterializedCells,
  resources: OwnershipResources,
) {
  const genesis = input.genesis;
  const actions = [
    ...new Map(input.actions.map((entry) => [actionKey(entry), entry])).values(),
  ].sort((a, b) => compareActions(a.action, b.action));
  const homes = resources.homes;
  if (input.homes) resources.assertHomes(input.homes);
  const index = nativeIndex;
  const nativeReaders = resume?.nativeReaders.fork() ?? new PersistentMap<number>();
  const nativeIntervals =
    resume?.nativeIntervals.fork() ?? new PersistentMap<NativeReadIntervals>();
  const layout = resume ? resume.layout.fork() : new MaterializedLayout(genesis);
  const owners = resume?.owners.fork() ?? new PersistentMap<CellAssignment>();
  const roots = resume?.roots.fork() ?? new PersistentMap<readonly RunOrigin[]>();
  const attachments = resume?.attachments.fork() ?? new PersistentMap<RunAttachment>();
  let splits = resume?.splits ?? [];
  let candidates = resume?.candidates ?? [];
  const flowIntentions = resume?.flowIntentions.fork() ?? new PersistentMap<EffectOrder>();
  const installedTapes = resume?.installedTapes.fork() ?? new PersistentMap<true>();
  const homeIndex = resources.homeDomain;
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
    for (const home of resources.batchHomes(batch.allocations)) {
      const tapeKey = resourceKey(home.cell.tape);
      if (installedTapes.has(tapeKey)) throw new Error('Duplicate tape birth');
      installedTapes.set(tapeKey, true);
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
  function rawCells(flow: FlowId, cells = index) {
    return traverse(flow, layout, cells, owners, roots, attachments).flatMap((entry) =>
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
  if (!resume) {
    install(genesis, []);
    assertCoverage();
  }
  let count = resume?.count ?? 0;
  const checkpoint = (): OwnershipCheckpoint => ({
    count,
    index,
    layout: layout.fork(),
    owners: owners.fork(),
    roots: roots.fork(),
    attachments: attachments.fork(),
    splits,
    candidates,
    flowIntentions: flowIntentions.fork(),
    installedTapes: installedTapes.fork(),
    nativeReaders: nativeReaders.fork(),
    nativeIntervals: nativeIntervals.fork(),
  });
  for (const entry of actions.slice(count)) {
    layout.beginAction(entry, (prior) => activity.observes(entry.action.id, prior));
    install({ allocations: entry.action.allocations, births: entry.births }, entry.action.effects);
    if (
      entry.action.allocations.some(
        (allocation) =>
          allocation.type === 'node' || allocation.type === 'flow' || allocation.type === 'run',
      )
    )
      assertCoverage();
    for (const [ordinal, effect] of entry.action.effects.entries()) {
      const order = { action: { id: entry.action.id, lamport: entry.action.lamport }, ordinal };
      const active = input.isActive(order);
      if (active && effect.type === 'TransferRange') {
        // Resolve all source ranges before installing the destination attachment.
        for (const range of effect.ranges) index.range(range);
        assign(effect.ranges, effect.run, effect.occurrence);
      } else if (active && effect.type === 'SplitFlow') {
        // Fixed range assignments, joins and placements commute with subdivision.
        // Splits additionally inspect current component adjacency, including tapes
        // reached through retained transfers/joins beyond the authored basis.
        const reader = index.observing((range) => {
          const key = resourceKey(range.tape);
          if (!nativeReaders.has(key)) nativeReaders.set(key, count);
          const previous = nativeIntervals.get(key) ?? NativeReadIntervals.empty();
          nativeIntervals.set(
            key,
            previous.add(range, count, (marker) => index.position(range.tape, marker)),
          );
        });
        layout.resolveInlineSlot(effect.cut, reader);
        for (const range of effect.basis.ranges) layout.occurrence(range.occurrence);
        const basis = effect.basis.ranges.flatMap((range) => reader.range(range.range));
        const cut = cutPosition(effect, reader, homeIndex);
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
          const current = rawCells(flow, reader).filter(
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
        splits = [...splits, { effect, order }];
      }
      const eligible = effect.type !== 'Interpret' || !!input.interpretationEligible?.(order);
      const result = layout.step(ordinal, active, eligible);
      if (
        active &&
        eligible &&
        [
          'TransferRange',
          'JoinFlow',
          'SplitFlow',
          'MoveBlock',
          'Interpret',
          'LiftChildren',
        ].includes(effect.type)
      )
        candidates = [...candidates, { order, effect }];
      for (const changed of result.flows)
        if (changed.result === 'applied') flowIntentions.set(resourceKey(changed.flow), order);
      // Native refinement is already installed in the initial cell index. Text,
      // visibility, properties and controls cannot change these raw assignments.
      // Recheck the invariant at structural births and after layout/ownership edits.
      if (
        active &&
        eligible &&
        (effect.type === 'TransferRange' ||
          effect.type === 'SplitFlow' ||
          effect.type === 'JoinFlow' ||
          effect.type === 'MoveBlock' ||
          effect.type === 'LiftChildren' ||
          effect.type === 'Interpret')
      )
        assertCoverage();
    }
    count++;
    if (count % 128 === 0) save(checkpoint());
  }
  const final = checkpoint();
  if (installedTapes.size !== resources.tapeCount)
    throw new Error('Home binding references an unavailable tape');
  const flowHome = (flow: FlowId): NodeId => resources.flowHome(flow);
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
      case 'Interpret':
      case 'LiftChildren':
        for (const placement of effect.type === 'Interpret'
          ? effect.packet.placements
          : effect.placements)
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
  const cohorts = splitBuckets(splits, layout, index, homeIndex);
  return {
    state: final,
    retained: resources,
    homes,
    cohorts,
    requirements,
    value: new OwnershipResult(
      layout,
      index,
      orderedOwners(index, owners, homes),
      roots,
      attachments,
      cohorts,
      requirements,
      homes,
    ),
  };
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
