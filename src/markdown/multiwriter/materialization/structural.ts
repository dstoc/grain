import type { CellAssignment, SemanticEffect, TapeId } from '../contracts.js';
import type { EffectOrder, OccurrenceBucket } from '../layout/index.js';
import { compareEffects } from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import { actionKey } from '../actions/references.js';
import { countWork } from '../diagnostics.js';
import { assignmentKey, cellKey, sameId } from '../ownership/cells.js';
import { splitBuckets } from '../ownership/cohorts.js';
import type { SplitBirth } from '../ownership/cohorts.js';
import type { DestinationRequirement } from '../ownership/ownership.js';
import type { MaterializedLayout } from './layout.js';
import type { MaterializedCells } from './cells.js';
import type { OwnershipResources } from './resources.js';
import { PersistentMap } from './map.js';

interface Candidate {
  readonly order: EffectOrder;
  readonly effect: SemanticEffect;
}
const effectKey = (order: EffectOrder) => `${actionKey(order.action.id)}:${order.ordinal}`;
const dependency = (kind: string, id: Parameters<typeof resourceKey>[0]) =>
  `${kind}:${resourceKey(id)}`;
function cohortKey({ effect }: SplitBirth): string {
  return JSON.stringify([
    effect.basis.ranges.length
      ? [
          'content',
          effect.basis.ranges.map(({ range, occurrence }) => [
            cellKey(range),
            resourceKey(occurrence),
          ]),
        ]
      : ['empty-home', resourceKey(effect.cut.run)],
    resourceKey(effect.outerSlot.parent),
    effect.outerSlot.predecessor && resourceKey(effect.outerSlot.predecessor),
  ]);
}

/** Checkpoint-owned dependency tables. Entries are retained semantic facts;
 * dirty sets name only decisions affected by this suffix. No activity/native
 * callback or prior preparation is retained. Full exports are lazy read costs.
 */
export class StructuralIndex {
  private candidates = new PersistentMap<Candidate>();
  private readers = new PersistentMap<PersistentMap<true>>();
  private requirements = new PersistentMap<DestinationRequirement | null>();
  private groups = new PersistentMap<readonly SplitBirth[]>();
  private groupReaders = new PersistentMap<PersistentMap<true>>();
  private buckets = new PersistentMap<{
    readonly bucket: OccurrenceBucket;
    readonly first: EffectOrder;
  } | null>();
  private dirty = new Set<string>();
  private dirtyGroups = new Set<string>();
  private exportedRequirements?: readonly DestinationRequirement[];
  private exportedBuckets?: readonly OccurrenceBucket[];
  fork(): StructuralIndex {
    const next = new StructuralIndex();
    next.candidates = this.candidates.fork();
    next.readers = this.readers.fork();
    next.requirements = this.requirements.fork();
    next.groups = this.groups.fork();
    next.groupReaders = this.groupReaders.fork();
    next.buckets = this.buckets.fork();
    next.dirty = new Set(this.dirty);
    next.dirtyGroups = new Set(this.dirtyGroups);
    next.exportedRequirements = this.exportedRequirements;
    next.exportedBuckets = this.exportedBuckets;
    return next;
  }
  private bind(table: PersistentMap<PersistentMap<true>>, resource: string, key: string) {
    const keys = table.get(resource)?.fork() ?? new PersistentMap<true>();
    keys.set(key, true);
    table.set(resource, keys);
  }
  changed(resource: string): void {
    for (const key of this.readers.get(resource)?.keys() ?? []) {
      countWork('ownership.dependencyReaders');
      this.dirty.add(key);
    }
    for (const key of this.groupReaders.get(resource)?.keys() ?? []) {
      countWork('ownership.cohortReaders');
      this.dirtyGroups.add(key);
    }
  }
  changedBlock(id: Parameters<typeof resourceKey>[0]): void {
    this.changed(dependency('block', id));
  }
  changedFlow(id: Parameters<typeof resourceKey>[0]): void {
    this.changed(dependency('flow', id));
  }
  changedAssignment(owner: Pick<CellAssignment, 'run' | 'occurrence'>): void {
    this.changed(`assignment:${assignmentKey(owner)}`);
  }
  changedTapes(tapes: readonly TapeId[]): void {
    for (const tape of tapes) this.changed(dependency('tape', tape));
  }
  add(candidate: Candidate, resources: OwnershipResources): void {
    const { effect, order } = candidate,
      key = effectKey(order);
    if (this.candidates.has(key)) throw new Error('Repeated structural decision');
    this.candidates.set(key, candidate);
    this.dirty.add(key);
    const reads: string[] = [];
    switch (effect.type) {
      case 'TransferRange':
        reads.push(`assignment:${assignmentKey(effect)}`);
        break;
      case 'JoinFlow':
        reads.push(dependency('flow', effect.source));
        break;
      case 'SplitFlow': {
        reads.push(dependency('block', effect.newNode));
        const birth = { effect, order },
          group = cohortKey(birth);
        this.groups.set(group, [...(this.groups.get(group) ?? []), birth]);
        this.dirtyGroups.add(group);
        // Original basis/occurrence keys remain the group identity. Native cuts
        // are ranked again when their tapes change, including empty-home cuts.
        const tapes = effect.basis.ranges.length
          ? effect.basis.ranges.map((entry) => entry.range.tape)
          : [resources.homeDomain.home(effect.cut.run).cell.tape];
        for (const tape of tapes) this.bind(this.groupReaders, dependency('tape', tape), group);
        this.bind(this.groupReaders, dependency('block', effect.newNode), group);
        break;
      }
      case 'MoveBlock':
        reads.push(dependency('block', effect.node));
        if (effect.standaloneFlow) reads.push(dependency('flow', effect.standaloneFlow));
        break;
      case 'Interpret':
      case 'LiftChildren':
        for (const placement of effect.type === 'Interpret'
          ? effect.packet.placements
          : effect.placements)
          reads.push(dependency('block', placement.node));
        break;
      default:
        throw new Error('Nonstructural candidate');
    }
    for (const read of reads) this.bind(this.readers, read, key);
  }
  refresh(
    layout: MaterializedLayout,
    index: MaterializedCells,
    resources: OwnershipResources,
    counts: PersistentMap<number>,
    intentions: PersistentMap<EffectOrder>,
  ): void {
    if (this.dirty.size) this.exportedRequirements = undefined;
    if (this.dirtyGroups.size) this.exportedBuckets = undefined;
    for (const key of this.dirty) {
      countWork('ownership.retainedStructuralCandidates');
      const { effect, order } = this.candidates.get(key)!;
      const nodes: DestinationRequirement['nodes'][number][] = [];
      switch (effect.type) {
        case 'TransferRange':
          if ((counts.get(assignmentKey(effect)) ?? 0) > 0)
            nodes.push(resources.flowHome(layout.runLayout(effect.destination.run).flow));
          break;
        case 'JoinFlow': {
          const placement = layout.flowPlacement(effect.source);
          if (
            placement.parent.type === 'flow' &&
            sameId(placement.parent.occurrence, effect.occurrence)
          )
            nodes.push(resources.flowHome(layout.runLayout(effect.destination.run).flow));
          break;
        }
        case 'SplitFlow':
          nodes.push(effect.newNode);
          if (sameId(layout.blockPlacement(effect.newNode)!.occurrence, effect.occurrence))
            nodes.push(effect.outerSlot.parent);
          break;
        case 'MoveBlock':
          if (sameId(layout.blockPlacement(effect.node)!.occurrence, effect.occurrence))
            nodes.push(effect.slot.parent);
          if (effect.standaloneFlow && intentions.get(resourceKey(effect.standaloneFlow)) === order)
            nodes.push(resources.flowHome(effect.standaloneFlow));
          break;
        case 'Interpret':
        case 'LiftChildren':
          for (const placement of effect.type === 'Interpret'
            ? effect.packet.placements
            : effect.placements)
            if (sameId(layout.blockPlacement(placement.node)!.occurrence, placement.occurrence))
              nodes.push(placement.slot.parent);
          break;
      }
      this.requirements.set(
        key,
        nodes.length
          ? {
              order,
              nodes: [...new Map(nodes.map((node) => [resourceKey(node), node])).values()],
            }
          : null,
      );
    }
    for (const key of this.dirtyGroups) {
      const group = this.groups.get(key)!;
      countWork('ownership.cohortCandidates', group.length);
      const bucket = splitBuckets(group, layout, index, resources.homeDomain)[0];
      const first = group.find(({ effect }) =>
        sameId(layout.blockPlacement(effect.newNode)!.occurrence, effect.occurrence),
      )?.order;
      this.buckets.set(key, bucket && first ? { bucket, first } : null);
    }
    this.dirty.clear();
    this.dirtyGroups.clear();
  }
  exportRequirements(): readonly DestinationRequirement[] {
    if (this.exportedRequirements) return this.exportedRequirements;
    countWork('ownership.requirementsExported', this.requirements.size);
    return (this.exportedRequirements = [...this.requirements.values()].flatMap((entry) =>
      entry ? [entry] : [],
    ));
  }
  exportBuckets(): readonly OccurrenceBucket[] {
    if (this.exportedBuckets) return this.exportedBuckets;
    countWork('ownership.cohortsExported', this.buckets.size);
    return (this.exportedBuckets = [...this.buckets.values()]
      .flatMap((entry) => (entry ? [entry] : []))
      .sort((a, b) => compareEffects(a.first, b.first))
      .map((entry) => entry.bucket));
  }
}

/** Construct escaping readers outside the preparation's lexical scope. A lazy
 * read must not share the commit closure's context (old state, source, native,
 * candidate, or input). Only these completed immutable resource roots escape. */
export function structuralReads(structural: StructuralIndex, resources: OwnershipResources) {
  return {
    cohorts: () => structural.exportBuckets(),
    requirements: () => structural.exportRequirements(),
    homes: () => resources.homes,
    homeLookup: {
      tape: (tape: TapeId) => resources.homeForTape(tape),
      flow: (flow: Parameters<OwnershipResources['homeForFlow']>[0]) => resources.homeForFlow(flow),
    },
  };
}
