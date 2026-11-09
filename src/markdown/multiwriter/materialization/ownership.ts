import { OwnershipValidationError } from '../ownership/errors.js';
import { countWork } from '../diagnostics.js';
import { measure } from '../diagnostics.js';
import { compareActions } from '../contracts.js';
import type {
  ActionId,
  CellAssignment,
  FlowId,
  InlineSlot,
  RangeRef,
  RunId,
  SemanticEffect,
} from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import type { EffectOrder, LayoutActionInput, LayoutGenesis } from '../layout/index.js';
import { assignmentKey, cellKey, sameId } from '../ownership/cells.js';
import { cutPosition } from '../ownership/cohorts.js';
import type { HomeBinding } from '../ownership/homes.js';
import { traverse } from '../ownership/traversal.js';
import type { RunAttachment, RunOrigin } from '../ownership/traversal.js';

import { OwnershipResult } from '../ownership/ownership.js';
import type { OwnershipInput } from '../ownership/ownership.js';
import type { Activity } from '../visibility/activity.js';
import { PersistentMap } from './map.js';
import { MaterializedLayout } from './layout.js';
import { MaterializedCells } from './cells.js';
import { OwnershipResources } from './resources.js';
import { NativeReadIntervals } from './intervals.js';
import { OwnershipCoverage } from './coverage.js';
import { StructuralIndex, structuralReads } from './structural.js';
export interface OwnershipCheckpoint {
  readonly count: number;
  readonly index: MaterializedCells;
  readonly layout: MaterializedLayout;
  readonly owners: PersistentMap<CellAssignment>;
  readonly roots: PersistentMap<readonly RunOrigin[]>;
  readonly attachments: PersistentMap<RunAttachment>;
  readonly structural: StructuralIndex;
  readonly assignmentCounts: PersistentMap<number>;
  readonly flowIntentions: PersistentMap<EffectOrder>;
  readonly installedTapes: PersistentMap<true>;
  /** First active split whose result depends on each native tape's cell topology. */
  readonly nativeReaders: PersistentMap<number>;
  /** Retained marker intervals read by split adjacency, with their first action. */
  readonly nativeIntervals: PersistentMap<NativeReadIntervals>;
  readonly coverage: OwnershipCoverage;
}
/** Match full replay's home-install/native-cell order independently of the edit
 * order of the persistent assignment map. Refinement can insert cells between
 * retained keys; changing a map key must not reorder the public raw result.
 */
export function orderedOwners(
  index: MaterializedCells,
  owners: PersistentMap<CellAssignment>,
  homes: () => readonly HomeBinding[],
) {
  return {
    get: (key: string) => owners.get(key),
    *values(): Generator<CellAssignment, undefined, unknown> {
      for (const home of homes())
        for (const cell of index.range(home.cell)) {
          countWork('ownership.cellsInstalled');
          const owner = owners.get(cellKey(cell.range));
          if (!owner) throw new OwnershipValidationError('Native cell lacks a refined assignment');
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
  work: { coverageFlowsTraversed: number; coverageCellsVisited: number },
  /** The caller certified the exact ordered prefix and suffix. The reference
   * audit seam omits this and still deduplicates/sorts its complete input. */
  ordered?: { readonly length: number; at(index: number): LayoutActionInput | undefined },
  author?: ActionId,
) {
  return measure('coupled-replay', () =>
    replayOwnershipSuffixMeasured(
      input,
      activity,
      resume,
      save,
      nativeIndex,
      resources,
      work,
      ordered,
      author,
    ),
  );
}
function replayOwnershipSuffixMeasured(
  input: OwnershipInput,
  activity: Activity,
  resume: OwnershipCheckpoint | undefined,
  save: (checkpoint: OwnershipCheckpoint) => void,
  nativeIndex: MaterializedCells,
  resources: OwnershipResources,
  work: { coverageFlowsTraversed: number; coverageCellsVisited: number },
  ordered:
    | { readonly length: number; at(index: number): LayoutActionInput | undefined }
    | undefined,
  author?: ActionId,
) {
  const genesis = input.genesis;
  const actions = ordered ?? orderedLayoutInputs(input.actions);
  if (input.homes) resources.assertHomes(input.homes);
  const index = nativeIndex;
  const nativeReaders = resume?.nativeReaders.fork() ?? new PersistentMap<number>();
  const nativeIntervals =
    resume?.nativeIntervals.fork() ?? new PersistentMap<NativeReadIntervals>();
  const layout = resume ? resume.layout.fork() : new MaterializedLayout(genesis);
  const owners = resume?.owners.fork() ?? new PersistentMap<CellAssignment>();
  const roots = resume?.roots.fork() ?? new PersistentMap<readonly RunOrigin[]>();
  const attachments = resume?.attachments.fork() ?? new PersistentMap<RunAttachment>();
  const structural = resume?.structural.fork() ?? new StructuralIndex();
  const assignmentCounts = resume?.assignmentCounts.fork() ?? new PersistentMap<number>();
  const flowIntentions = resume?.flowIntentions.fork() ?? new PersistentMap<EffectOrder>();
  const installedTapes = resume?.installedTapes.fork() ?? new PersistentMap<true>();
  const homeIndex = resources.homeDomain;
  const coverage = resume?.coverage.fork() ?? new OwnershipCoverage();
  function component(flow: FlowId): FlowId {
    let placement = layout.flowPlacement(flow);
    countWork('ownership.flowAncestorVisits');
    while (placement.parent.type === 'flow') {
      placement = layout.flowPlacement(layout.runLayout(placement.parent.slot.run).flow);
      countWork('ownership.flowAncestorVisits');
    }
    return placement.flow;
  }
  function dirtyRun(run: RunId): void {
    coverage.invalidate(component(layout.runLayout(run).flow));
  }
  function install(batch: LayoutGenesis, effects: readonly SemanticEffect[]): void {
    for (const allocation of batch.allocations) {
      countWork('ownership.allocationsInspected');
      if (allocation.type === 'flow') coverage.invalidate(component(allocation.id));
      else if (allocation.type === 'run') dirtyRun(allocation.id);
      else if (allocation.type === 'occurrence' && !('parent' in allocation.slot))
        dirtyRun(allocation.slot.run);
    }
    const transfers = effects.filter((effect) => effect.type === 'TransferRange');
    // Retained occurrence locations are ghost traversal paths, even when inactive.
    // Installing an address does not assign cells or assert a flow containment edge.
    for (const transfer of transfers) {
      dirtyRun(transfer.destination.run);
      layout.resolveInlineSlot(transfer.destination, index);
      const occurrence = layout.occurrence(transfer.occurrence);
      const run = layout.runLayout(transfer.run);
      if ('parent' in occurrence.slot || !sameInlineSlot(occurrence.slot, transfer.destination))
        throw new OwnershipValidationError('Transfer occurrence slot is immutable');
      if (!sameId(run.flow, layout.runLayout(transfer.destination.run).flow))
        throw new OwnershipValidationError(
          'Transfer run has a different immutable destination flow',
        );
      if (
        run.skeleton.length !== transfer.ranges.length ||
        run.skeleton.some((range, i) => cellKey(range) !== cellKey(transfer.ranges[i]))
      )
        throw new OwnershipValidationError('Transfer skeleton must retain authored range order');
      attachments.set(resourceKey(transfer.occurrence), {
        run: transfer.run,
        occurrence: transfer.occurrence,
        destination: transfer.destination,
      });
    }
    for (const home of resources.batchHomes(batch.allocations)) {
      const tapeKey = resourceKey(home.cell.tape);
      if (installedTapes.has(tapeKey)) throw new OwnershipValidationError('Duplicate tape birth');
      installedTapes.set(tapeKey, true);
      const flowKey = resourceKey(layout.runLayout(home.run).flow);
      if (roots.has(flowKey)) throw new OwnershipValidationError('Ambiguous home run order');
      roots.set(flowKey, [{ run: home.run, occurrence: home.occurrence }]);
      for (const cell of index.range(home.cell)) {
        const key = cellKey(cell.range);
        if (owners.has(key)) throw new OwnershipValidationError('Conflicting home coverage');
        owners.set(key, { cell: cell.range, run: home.run, occurrence: home.occurrence });
        countAssignment(home, 1);
      }
    }
  }
  function rawCells(flow: FlowId, cells = index) {
    countWork('ownership.flowTraversals');
    return traverse(flow, layout, cells, owners, roots, attachments).flatMap((entry) =>
      entry.type === 'cell' ? [entry.assignment] : [],
    );
  }
  function assertCoverage(): void {
    coverage.check(
      owners.size,
      (flow) => {
        if (layout.flowPlacement(flow).parent.type !== 'block') return undefined;
        return rawCells(flow).map((assignment) => {
          work.coverageCellsVisited++;
          if (
            homeIndex.isReserved(assignment.cell) &&
            assignmentKey(assignment) !== assignmentKey(homeIndex.binding(assignment.cell.tape))
          )
            throw new OwnershipValidationError('Reserved home cell lost its root assignment');
          return cellKey(assignment.cell);
        });
      },
      () => work.coverageFlowsTraversed++,
    );
  }
  function countAssignment(owner: Pick<CellAssignment, 'run' | 'occurrence'>, delta: number): void {
    const key = assignmentKey(owner);
    assignmentCounts.set(key, (assignmentCounts.get(key) ?? 0) + delta);
    structural.changedAssignment(owner);
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
        const before = owners.get(key);
        if (!before)
          throw new OwnershipValidationError('Structural range uses an unavailable tape');
        if (!skeleton.has(key))
          throw new OwnershipValidationError('Assignment outside retained run skeleton');
        if (selected.has(key))
          throw new OwnershipValidationError('Repeated cell in structural assignment');
        selected.add(key);
        dirtyRun(before.run);
        dirtyRun(run);
        countAssignment(before, -1);
        countAssignment({ run, occurrence }, 1);
        owners.set(key, { cell: cell.range, run, occurrence });
      }
  }
  if (!resume) {
    install(genesis, []);
    assertCoverage();
  }
  let count = resume?.count ?? 0;
  const checkpoint = (): OwnershipCheckpoint => {
    structural.refresh(layout, index, resources, assignmentCounts, flowIntentions);
    return {
      count,
      index,
      layout: layout.fork(),
      owners: owners.fork(),
      roots: roots.fork(),
      attachments: attachments.fork(),
      structural: structural.fork(),
      assignmentCounts: assignmentCounts.fork(),
      flowIntentions: flowIntentions.fork(),
      installedTapes: installedTapes.fork(),
      nativeReaders: nativeReaders.fork(),
      nativeIntervals: nativeIntervals.fork(),
      coverage: coverage.fork(),
    };
  };
  for (let at = count; at < actions.length; at++) {
    const entry = actions.at(at)!;
    countWork('ownership.suffixActions');
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
      countWork('ownership.effectsInspected');
      const order = { action: { id: entry.action.id, lamport: entry.action.lamport }, ordinal };
      const active = input.isActive(order);
      if (author) countWork('authorProof.candidateOrdinals');
      if (author && sameAction(author, entry.action.id) && active && effect.type === 'SplitFlow') {
        countWork('authorProof.splitPredicates');
        const sourceRun = layout.runLayout(effect.cut.run);
        const laterBirth = entry.action.effects.findIndex(
          (candidate) => candidate.type === 'SplitFlow' && sameId(candidate.newRun, effect.cut.run),
        );
        if (laterBirth >= ordinal)
          throw new OwnershipValidationError(
            'Split source is not yet available at its effect prefix',
          );
        if (!effect.basis.ranges.length) {
          if (layout.flowPlacement(sourceRun.flow).parent.type !== 'block')
            throw new OwnershipValidationError('Empty split source must be standalone');
          if (rawCells(sourceRun.flow).some((cell) => !homeIndex.isReserved(cell.cell)))
            throw new OwnershipValidationError('Empty split omits author-visible content cells');
        } else {
          const basis = effect.basis.ranges.flatMap((member) => {
            const cells = index.range(member.range);
            for (const cell of cells) {
              const owner = owners.get(cellKey(cell.range));
              if (!owner || !sameId(owner.occurrence, member.occurrence))
                throw new OwnershipValidationError(
                  'Basis occurrence differs from author ownership',
                );
            }
            return cells;
          });
          const current = rawCells(component(sourceRun.flow)).filter(
            (assignment) => !homeIndex.isReserved(assignment.cell),
          );
          const positions = new Map(current.map((cell, i) => [cellKey(cell.cell), i]));
          let previous: number | undefined;
          for (const cell of basis) {
            const position = positions.get(cellKey(cell.range));
            if (position === undefined || (previous !== undefined && position !== previous + 1))
              throw new OwnershipValidationError(
                'Basis is not contiguous in author source flow traversal',
              );
            previous = position;
          }
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
            throw new OwnershipValidationError(
              'Split skeleton differs from authored captured component',
            );
        }
      }
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
          if (!reference)
            throw new OwnershipValidationError('Split needs an addressable basis cell');
          const referenceOwner = owners.get(cellKey(reference.range));
          if (!referenceOwner)
            throw new OwnershipValidationError('Split basis uses an unavailable tape');
          const flow = component(layout.runLayout(referenceOwner.run).flow);
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
        const node = layout.nodeAllocation(effect.newNode);
        const birth = layout.blockPlacement(effect.newNode);
        if (
          !node?.flow ||
          !sameId(node.flow, effect.newFlow) ||
          !sameId(run.flow, effect.newFlow) ||
          !birth ||
          !sameId(birth.occurrence, effect.occurrence)
        )
          throw new OwnershipValidationError('Split allocation does not match retained birth');
        if (
          !sameId(birth.slot.parent, effect.outerSlot.parent) ||
          !sameNullableId(birth.slot.predecessor, effect.outerSlot.predecessor)
        )
          throw new OwnershipValidationError('Split outer slot differs from retained birth');
      }
      const eligible = effect.type !== 'Interpret' || !!input.interpretationEligible?.(order);
      const changedFlow =
        active && effect.type === 'JoinFlow'
          ? effect.source
          : active && effect.type === 'MoveBlock'
            ? effect.standaloneFlow
            : null;
      if (changedFlow) coverage.invalidate(component(changedFlow));
      const result = layout.step(ordinal, active, eligible);
      if (changedFlow) coverage.invalidate(component(changedFlow));
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
        structural.add({ order, effect }, resources);
      for (const changed of result.flows)
        if (changed.result === 'applied') {
          flowIntentions.set(resourceKey(changed.flow), order);
          structural.changedFlow(changed.flow);
        }
      for (const changed of result.blocks)
        if (changed.result === 'applied') structural.changedBlock(changed.node);
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
    // Retained inline occurrences/attachments can enter even when their effect
    // is inactive. Certify those dirty paths before saving the completed prefix.
    assertCoverage();
    count++;
    if (count % 128 === 0) save(checkpoint());
  }
  const final = checkpoint();
  if (installedTapes.size !== resources.tapeCount)
    throw new OwnershipValidationError('Home binding references an unavailable tape');
  const { requirements, cohorts, homes, homeLookup, cohortLookup } = structuralReads(
    final.structural,
    resources,
  );
  return {
    state: final,
    retained: resources,
    homes,
    cohorts,
    requirements,
    value: new OwnershipResult(
      final.layout,
      index,
      orderedOwners(index, owners, homes),
      roots,
      attachments,
      cohorts,
      requirements,
      homes,
      homeLookup,
      cohortLookup,
    ),
  };
}
export function orderedLayoutInputs<T extends LayoutActionInput>(input: readonly T[]): T[] {
  countWork('ownership.fullInputEnumerated', input.length);
  countWork('ownership.fullInputMaterialized', input.length);
  countWork('ownership.fullInputDeduplicated', input.length);
  countWork('ownership.sortInputs', input.length);
  return [...new Map(input.map((entry) => [actionKey(entry), entry])).values()].sort(
    (a, b) => (countWork('ownership.sortComparisons'), compareActions(a.action, b.action)),
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

function sameAction(a: ActionId, b: ActionId): boolean {
  return a.actor === b.actor && a.sequence === b.sequence;
}
