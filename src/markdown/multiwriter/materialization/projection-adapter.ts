import type { FlowId, NodeId, RunId, TapeId } from '../contracts.js';
import { compareActions } from '../contracts.js';
import { actionKey } from '../actions/references.js';
import { readySource } from '../authoring/ready-source.js';
import type { ReadySequence, ReadySource } from '../authoring/ready-source.js';
import { countWork } from '../diagnostics.js';
import type { NativeView } from '../ingest/publication.js';
import { resourceKey } from '../layout/index.js';
import { sameSlot } from '../layout/occurrences.js';
import { sameId } from '../ownership/cells.js';
import type { OwnershipResult } from '../ownership/ownership.js';
import type { BirthContent } from '../projection/types.js';
import type { Activity, EffectRef } from '../visibility/activity.js';
import type { StructuralProjectionChange } from './projection-changes.js';
import type { StructuralChanges } from './subdivision.js';

type Projection = StructuralProjectionChange['base'];
export type ProducerBinding = StructuralChanges['base'];
interface Readers<T> {
  get(key: string): T | undefined;
}
interface AdapterBase {
  readonly value: Projection;
  readonly producerBase?: ProducerBinding;
  readonly source?: ReadySource;
  readonly tapeNodes: Readers<readonly string[]>;
  readonly nodeAllocations: Readers<{ readonly id: NodeId }>;
  readonly nodeRequirements: Readers<readonly EffectRef[]>;
  readonly flowHomes: Readers<NodeId>;
}
const sameIds = <T>(a: readonly T[], b: readonly T[], equal: (a: T, b: T) => boolean) =>
  a.length === b.length &&
  a.every((value, i) => {
    countWork('projection.adapterSequenceEntriesCompared');
    return equal(value, b[i]);
  });
const sameOrigin = (a: { run: RunId; occurrence: Parameters<typeof sameId>[0] }, b: typeof a) =>
  sameId(a.run, b.run) && sameId(a.occurrence, b.occurrence);
const effectKey = (ref: EffectRef) => `${actionKey(ref.action)}:${ref.ordinal}`;

/** Adapt exact persistent-root deltas. Selected raw readers include private-home
 * headers and ghosts as well as their effective destinations. No full inventory
 * or snapshot comparison is part of this path. */
export function projectionChange(
  before: AdapterBase,
  prepared: {
    readonly value: {
      readonly ownership: OwnershipResult;
      readonly changes: StructuralChanges;
      readonly birthContent: readonly BirthContent[];
    };
    assertCurrent(): void;
    commit(): void;
  },
  actions: ReadySequence,
  native: NativeView,
  activity: Activity,
):
  | { readonly state: 'adapted'; readonly change: StructuralProjectionChange }
  | { readonly state: 'fallback'; readonly reason: string } {
  const { changes, ownership } = prepared.value,
    binding = before.producerBase;
  if (
    !binding ||
    binding.genesis !== changes.base.genesis ||
    binding.native !== changes.base.native ||
    binding.ready !== changes.base.ready ||
    binding.checkpoint !== changes.base.checkpoint
  )
    return { state: 'fallback', reason: 'incompatible-producer-base' };
  if (changes.candidate.genesis !== changes.base.genesis)
    return { state: 'fallback', reason: 'changed-genesis' };
  const source = readySource(actions);
  if (changes.candidate.native !== native || changes.candidate.ready !== source)
    return { state: 'fallback', reason: 'incompatible-producer-candidate' };
  if (binding.ready !== before.source)
    return { state: 'fallback', reason: 'incompatible-producer-source' };
  const additions = source && before.source && source.additions(before.source);
  if (!additions?.actions.length) return { state: 'fallback', reason: 'missing-exact-addition' };
  const fresh = additions.actions;
  const nodes = new Map<string, NodeId>(),
    containers = new Map<string, NodeId>(),
    tapes = new Map<string, TapeId>(),
    roots = new Map<string, RunId>();
  const tapeQueue: TapeId[] = [],
    nodeQueue: NodeId[] = [];
  const tape = (id: TapeId) => {
    if (!tapes.has(resourceKey(id))) {
      tapes.set(resourceKey(id), id);
      tapeQueue.push(id);
    }
  };
  const node = (id: NodeId) => {
    if (!nodes.has(resourceKey(id))) {
      nodes.set(resourceKey(id), id);
      nodeQueue.push(id);
    }
  };
  const container = (id: NodeId) => containers.set(resourceKey(id), id);
  const sides = [before.value.ownership, ownership] as const;
  const sources = [before.source, source] as const;
  const exists = (id: NodeId | RunId | FlowId | TapeId, side: number) =>
    id.birth.type === 'genesis' || sources[side]?.has(actionKey(id.birth.action));
  const freshHomes = new Map(
    fresh.flatMap((a) =>
      a.allocations.flatMap((allocation) =>
        allocation.type === 'node' && allocation.flow
          ? [[resourceKey(allocation.flow), allocation.id] as const]
          : [],
      ),
    ),
  );
  const flows = [new Set<string>(), new Set<string>()];
  const flow = (id: FlowId, side: number) => {
    if (!exists(id, side) || flows[side].has(resourceKey(id))) return;
    flows[side].add(resourceKey(id));
    countWork('projection.adapterFlowReaders');
    const owner = sides[side],
      home = owner.homeForFlow(id);
    if (home) tape(home.cell.tape);
    const header =
      before.flowHomes.get(resourceKey(id)) ??
      (side === 1 ? freshHomes.get(resourceKey(id)) : undefined);
    if (!header) throw new Error('Selected flow lacks its retained home header');
    node(header);
    const placement = owner.flowPlacement(id);
    if (placement.parent.type === 'block') node(placement.parent.node);
    else {
      // Keep the immutable home header even when this flow is joined elsewhere.
      // flowBlock follows the complete current ancestry, not the private home.
      node(owner.flowBlock(id));
      flow(owner.runLayout(placement.parent.slot.run).flow, side);
    }
  };
  const run = (id: RunId, side: number) => {
    if (!exists(id, side)) return;
    const layout = sides[side].runLayout(id);
    flow(layout.flow, side);
    for (const range of layout.skeleton) tape(range.tape);
  };
  const slot = (value: ReturnType<OwnershipResult['occurrence']>['slot'], side: number) => {
    if ('parent' in value) container(value.parent);
    else {
      run(value.run, side);
      tape(native.marker(value.boundary).tape);
    }
  };
  for (const change of changes.subdivisions) {
    tape(change.before.tape);
    for (const [side, ranges] of [[change.before], change.after].entries())
      for (const range of ranges)
        for (const assignment of sides[side].cells(range)) {
          countWork('projection.adapterSubdivisionCells');
          run(assignment.run, side);
        }
  }
  for (const change of changes.assignments) {
    countWork('projection.adapterAssignmentDeltas');
    if (
      change.before &&
      change.after &&
      sameOrigin(change.before, change.after) &&
      sameId(change.before.cell.tape, change.after.cell.tape) &&
      sameId(change.before.cell.start, change.after.cell.start) &&
      sameId(change.before.cell.end, change.after.cell.end)
    )
      continue;
    for (const [side, value] of [change.before, change.after].entries())
      if (value) {
        tape(value.cell.tape);
        run(value.run, side);
      }
  }
  for (const change of changes.layout.nodes) {
    countWork('projection.adapterAllocationDeltas');
    if (change.before && change.after) continue; // Allocations are immutable certified facts.
    for (const value of [change.before, change.after]) if (value) node(value.id);
  }
  for (const change of changes.layout.blocks) {
    countWork('projection.adapterPlacementDeltas');
    if (
      change.before &&
      change.after &&
      sameId(change.before.occurrence, change.after.occurrence) &&
      sameSlot(change.before.slot, change.after.slot)
    )
      continue;
    for (const [side, value] of [change.before, change.after].entries())
      if (value) {
        node(value.node);
        slot(value.slot, side);
      }
  }
  for (const change of changes.layout.flows) {
    countWork('projection.adapterFlowDeltas');
    const a = change.before?.parent,
      b = change.after?.parent;
    if (
      a &&
      b &&
      ((a.type === 'block' && b.type === 'block' && sameId(a.node, b.node)) ||
        (a.type === 'flow' &&
          b.type === 'flow' &&
          sameId(a.occurrence, b.occurrence) &&
          sameSlot(a.slot, b.slot)))
    )
      continue;
    for (const [side, value] of [change.before, change.after].entries())
      if (value) {
        flow(value.flow, side);
        if (value.parent.type === 'block') node(value.parent.node);
        else slot(value.parent.slot, side);
      }
  }
  for (const change of changes.layout.runs) {
    countWork('projection.adapterRunDeltas');
    if (change.before && change.after) continue;
    for (const [side, value] of [change.before, change.after].entries())
      if (value) run(value.run, side);
  }
  for (const change of changes.layout.occurrences) {
    countWork('projection.adapterOccurrenceDeltas');
    if (change.before && change.after) continue;
    for (const [side, value] of [change.before, change.after].entries())
      if (value) slot(value.slot, side);
  }
  for (const change of changes.roots) {
    countWork('projection.adapterRootDeltas');
    if (change.before && change.after && sameIds(change.before, change.after, sameOrigin)) continue;
    for (const [side, values] of [change.before, change.after].entries())
      for (const value of values ?? []) {
        run(value.run, side);
        slot(sides[side].occurrence(value.occurrence).slot, side);
      }
  }
  for (const change of changes.attachments) {
    countWork('projection.adapterAttachmentDeltas');
    if (
      change.before &&
      change.after &&
      sameOrigin(change.before, change.after) &&
      sameSlot(change.before.destination, change.after.destination)
    )
      continue;
    for (const [side, value] of [change.before, change.after].entries())
      if (value) {
        run(value.run, side);
        slot(value.destination, side);
      }
  }
  for (const change of changes.derived.cohorts) {
    countWork('projection.adapterCohortDeltas');
    if (
      change.before &&
      change.after &&
      sameIds(change.before.bucket.roots, change.after.bucket.roots, sameId)
    )
      continue;
    for (const [side, value] of [change.before, change.after].entries())
      for (const occurrence of value?.bucket.roots ?? [])
        slot(sides[side].occurrence(occurrence).slot, side);
  }
  const requirements = new Map<string, readonly EffectRef[]>();
  const refs = (id: NodeId) => {
    const key = resourceKey(id);
    if (!requirements.has(key)) requirements.set(key, before.nodeRequirements.get(key) ?? []);
    return requirements.get(key)!;
  };
  for (const change of changes.derived.requirements) {
    countWork('projection.adapterRequirementDeltas');
    if (change.before && change.after && sameIds(change.before.nodes, change.after.nodes, sameId))
      continue;
    for (const value of [change.before, change.after])
      for (const id of value?.nodes ?? []) {
        node(id);
        refs(id);
      }
    if (change.before) {
      const old = { action: change.before.order.action.id, ordinal: change.before.order.ordinal };
      for (const id of change.before.nodes)
        requirements.set(
          resourceKey(id),
          refs(id).filter((ref) => effectKey(ref) !== effectKey(old)),
        );
    }
    if (change.after) {
      const next = { action: change.after.order.action.id, ordinal: change.after.order.ordinal };
      for (const id of change.after.nodes)
        if (!refs(id).some((ref) => effectKey(ref) === effectKey(next)))
          requirements.set(resourceKey(id), [...refs(id), next]);
    }
  }
  const semantic = new Map(changes.actions.map((action) => [actionKey(action.id), action]));
  for (const action of fresh) {
    semantic.set(actionKey(action.id), action);
    for (const effect of action.effects)
      if (effect.type === 'SetGroupActive')
        for (const id of effect.actions) {
          const target = source!.get(actionKey(id));
          if (!target) return { state: 'fallback', reason: 'missing-control-target' };
          semantic.set(actionKey(id), target);
        }
  }
  // Birth activity is independent of raw placement/ownership. A controlled
  // allocation can have no effects, so B's decision strings alone do not name it.
  for (const action of semantic.values()) {
    for (const birth of action.nativeManifest) {
      countWork('projection.adapterManifestEntries');
      tape(birth.tape);
    }
    for (const allocation of action.allocations) {
      countWork('projection.adapterSemanticAllocations');
      if (allocation.type === 'node') node(allocation.id);
    }
  }
  for (const id of changes.tapes) tape(id);
  let nextTape = 0,
    nextNode = 0;
  while (nextTape < tapeQueue.length || nextNode < nodeQueue.length) {
    while (nextTape < tapeQueue.length) {
      const id = tapeQueue[nextTape++];
      for (const key of before.tapeNodes.get(resourceKey(id)) ?? []) {
        countWork('projection.adapterReverseReaders');
        node(before.nodeAllocations.get(key)!.id);
      }
      for (const [side, owner] of sides.entries())
        if (exists(id, side)) {
          const home = owner.homeForTape(id);
          if (home) flow(owner.runLayout(home.run).flow, side);
        }
    }
    while (nextNode < nodeQueue.length) {
      const id = nodeQueue[nextNode++];
      for (const [side, owner] of sides.entries()) {
        if (!exists(id, side)) continue;
        const allocation = owner.nodeAllocation(id);
        if (!allocation.flow) continue;
        flow(allocation.flow, side);
        const home = owner.homeForFlow(allocation.flow)!;
        if (side === 1) roots.set(resourceKey(id), home.run);
        tape(home.cell.tape);
        for (const entry of owner.raw(allocation.flow)) {
          countWork('projection.adapterRawEntries');
          if (entry.type === 'cell') tape(entry.assignment.cell.tape);
          else if (entry.type === 'slot') tape(native.marker(entry.slot.boundary).tape);
        }
      }
    }
  }
  for (const id of [...nodes.values(), ...containers.values()]) refs(id);
  for (const [id, values] of requirements) {
    countWork('projection.adapterWitnessEntriesCopied', values.length);
    requirements.set(
      id,
      [...values].sort(
        (a, b) => (
          countWork('projection.adapterWitnessComparisons'),
          compareActions(source!.get(actionKey(a.action))!, source!.get(actionKey(b.action))!) ||
            a.ordinal - b.ordinal
        ),
      ),
    );
  }
  const effects = changes.actions.flatMap((action) => action.effects);
  return {
    state: 'adapted',
    change: {
      base: before.value,
      actions,
      native,
      activity,
      family: effects.some((e) => e.type === 'SetGroupActive')
        ? 'control'
        : effects.some((e) => e.type === 'SplitFlow')
          ? 'split'
          : effects.some((e) => e.type === 'JoinFlow')
            ? 'join'
            : 'placement',
      replay: { from: changes.replayFrom, to: changes.replayTo, reason: changes.reason },
      action: fresh.at(-1)!,
      revision: changes.candidate,
      semanticChanges: changes.actions,
      structure: {
        value: ownership,
        assertCurrent: prepared.assertCurrent,
        commit: prepared.commit,
      },
      nodes: [...nodes.values()],
      containers: [...containers.values()],
      rootRuns: roots,
      tapes: [...tapes.values()],
      nativeTapes: changes.tapes,
      requirements,
      birthContent: prepared.value.birthContent,
    },
  };
}
