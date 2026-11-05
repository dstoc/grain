import { compareActions } from '../contracts.js';
import type {
  Allocation,
  BlockSlot,
  FlowId,
  FlowPlacement,
  InlineSlot,
  NodeId,
  OccurrenceId,
  RunId,
  RunLayout,
  SemanticEffect,
} from '../contracts.js';
import { replaceEdge } from '../layout/forest.js';
import type { ForestEdge, MoveResult } from '../layout/forest.js';
import { orderOccurrences, resourceKey, sameSlot, slotSequence } from '../layout/occurrences.js';
import type { EffectOrder, OccurrenceBucket, OrderedOccurrence } from '../layout/occurrences.js';

import type {
  LayoutGenesis,
  LayoutAction,
  LayoutActionInput,
  LayoutStepResult,
  BlockPlacement,
  BoundaryIndex,
  InlineSlotResolution,
} from '../layout/layout.js';
import { allowsRawChild, copyLayoutAction } from '../layout/layout.js';
import { PersistentMap } from './map.js';
import type { ActionId } from '../contracts.js';
interface SequenceLink {
  readonly occurrence: OrderedOccurrence;
  readonly previous?: SequenceLink;
}
type NodeAllocation = Extract<Allocation, { type: 'node' }>;
type FlowAllocation = Extract<Allocation, { type: 'flow' }>;
function actionKey(action: LayoutAction['id']): string {
  return JSON.stringify([action.actor, action.sequence.toString()]);
}
function effectOccurrences(effect: SemanticEffect): readonly OccurrenceId[] {
  switch (effect.type) {
    case 'MoveBlock':
    case 'JoinFlow':
    case 'SplitFlow':
    case 'TransferRange':
      return [effect.occurrence];
    case 'LiftChildren':
      return effect.placements.map((placement) => placement.occurrence);
    case 'Interpret':
      return effect.packet.placements.map((placement) => placement.occurrence);
    default:
      return [];
  }
}

/** Persistent coupled-replay layout state. Publish only after a complete replay.
 * beginAction installs permanent births even for inactive effects. MW-04 interleaves
 * step with ownership work at each effect prefix. Fork persistent roots before preparing a suffix.
 */
export class MaterializedLayout {
  private nodes = new PersistentMap<NodeAllocation>();
  private flows = new PersistentMap<FlowAllocation>();
  private runs = new PersistentMap<RunLayout>();
  private occurrences = new PersistentMap<OrderedOccurrence>();
  private sequences = new PersistentMap<SequenceLink>();
  private joined = new PersistentMap<readonly FlowId[]>();
  private flowRanks = new PersistentMap<number>();
  private blockOwners = new PersistentMap<string>();
  private blocks = new PersistentMap<ForestEdge<string, BlockPlacement | null>>();
  // Run → immutable flow, flow → run or own block terminal; block terminals end ancestry.
  private inline = new PersistentMap<ForestEdge<string, FlowPlacement | null>>();
  private actions = new PersistentMap<true>();
  private observes?: (id: ActionId) => boolean;
  private current: LayoutAction | null = null;
  private nextOrdinal = 0;
  private rootId: NodeId | null = null;

  constructor(genesis: LayoutGenesis, source?: MaterializedLayout) {
    if (source) {
      this.nodes = source.nodes.fork();
      this.flows = source.flows.fork();
      this.runs = source.runs.fork();
      this.occurrences = source.occurrences.fork();
      this.sequences = source.sequences.fork();
      this.joined = source.joined.fork();
      this.flowRanks = source.flowRanks.fork();
      this.blockOwners = source.blockOwners.fork();
      this.blocks = source.blocks.fork();
      this.inline = source.inline.fork();
      this.actions = source.actions.fork();
      this.observes = source.observes;
      this.current = source.current;
      this.nextOrdinal = source.nextOrdinal;
      this.rootId = source.rootId;
      return;
    }
    this.allocate(structuredClone(genesis), null);
    if (!this.rootId) throw new Error('Missing document root');
  }
  fork(): MaterializedLayout {
    return new MaterializedLayout({ allocations: [], births: [] }, this);
  }
  get root(): NodeId {
    return this.rootId!;
  }
  nodeAllocation(id: NodeId): NodeAllocation {
    return this.node(id);
  }
  get nodeAllocations(): readonly NodeAllocation[] {
    return [...this.nodes.values()];
  }
  get runLayouts(): readonly RunLayout[] {
    return [...this.runs.values()];
  }
  get flowPlacements(): readonly FlowPlacement[] {
    return [...this.flows.keys()].map((key) => this.inline.get(key)!.value!);
  }
  blockPlacement(node: NodeId): BlockPlacement | null {
    const edge = this.blocks.get(resourceKey(node));
    if (!edge) throw new Error('Missing node allocation');
    return edge.value;
  }
  flowPlacement(flow: FlowId): FlowPlacement {
    const edge = this.inline.get(resourceKey(flow));
    if (!edge?.value) throw new Error('Missing flow allocation');
    return edge.value;
  }
  runLayout(run: RunId): RunLayout {
    const layout = this.runs.get(resourceKey(run));
    if (!layout) throw new Error('Missing run allocation');
    return layout;
  }
  occurrence(id: OccurrenceId): OrderedOccurrence {
    const occurrence = this.occurrences.get(resourceKey(id));
    if (!occurrence) throw new Error('Missing occurrence allocation');
    return occurrence;
  }
  /** Complete order includes inactive and ineffective anchors. */
  occurrenceOrder(
    slot: BlockSlot | InlineSlot,
    buckets: readonly OccurrenceBucket[] = [],
  ): readonly OrderedOccurrence[] {
    this.validateSlot(slot);
    const sequence = slotSequence(slot);
    const entries: OrderedOccurrence[] = [];
    for (let link = this.sequences.get(sequence); link; link = link.previous)
      entries.push(link.occurrence);
    return orderOccurrences(entries.reverse(), buckets);
  }
  children(parent: NodeId, buckets: readonly OccurrenceBucket[] = []): readonly NodeId[] {
    return this.occurrenceOrder({ parent, predecessor: null }, buckets).flatMap((occurrence) => {
      const key = resourceKey(occurrence.id),
        owner = this.blockOwners.get(key);
      const edge = owner && this.blocks.get(owner);
      return edge && edge.value && resourceKey(edge.value.occurrence) === key
        ? [edge.value.node]
        : [];
    });
  }
  flowsAt(occurrence: OccurrenceId): readonly FlowId[] {
    return (this.joined.get(resourceKey(occurrence)) ?? [])
      .filter((flow) => {
        const placement = this.flowPlacement(flow);
        return (
          placement.parent.type === 'flow' &&
          resourceKey(placement.parent.occurrence) === resourceKey(occurrence)
        );
      })
      .sort((a, b) => this.flowRanks.get(resourceKey(a))! - this.flowRanks.get(resourceKey(b))!);
  }
  /** Flow attachments only. MW-04 uses occurrenceOrder for transferred run attachments. */
  joinedFlows(slot: InlineSlot): readonly FlowId[] {
    return this.occurrenceOrder(slot).flatMap((occurrence) =>
      this.flowPlacements.flatMap((placement) =>
        placement.parent.type === 'flow' &&
        resourceKey(placement.parent.occurrence) === resourceKey(occurrence.id)
          ? [placement.flow]
          : [],
      ),
    );
  }
  resolveBlockSlot(slot: BlockSlot): BlockSlot {
    this.validateSlot(slot);
    return structuredClone(slot);
  }
  resolveInlineSlot(slot: InlineSlot, index?: BoundaryIndex): InlineSlotResolution {
    this.validateSlot(slot);
    const run = this.runLayout(slot.run);
    const membership = run.skeleton.map((range) => index?.containsBoundary(range, slot.boundary));
    if (membership.length && membership.every((value) => value === false))
      throw new Error('Boundary is outside retained run skeleton');
    return {
      slot: structuredClone(slot),
      run,
      membership: membership.some((value) => value === true) ? 'available' : 'unavailable',
    };
  }
  /** Top-level block at this prefix, including ancestry through non-home runs. */
  flowBlock(flow: FlowId): NodeId {
    let placement = this.flowPlacement(flow);
    while (placement.parent.type === 'flow') {
      placement = this.flowPlacement(this.runLayout(placement.parent.slot.run).flow);
    }
    return placement.parent.node;
  }
  beginAction(input: LayoutActionInput, observes?: (id: ActionId) => boolean): void {
    if (this.current && this.nextOrdinal !== this.current.effects.length)
      throw new Error('Previous action prefix is incomplete');
    const action = copyLayoutAction(input.action);
    if (this.current && compareActions(this.current, action) >= 0)
      throw new Error('Actions must enter in semantic order');
    const key = actionKey(action.id);
    if (this.actions.has(key)) throw new Error('Duplicate action prefix');
    for (const dependency of action.dependencies)
      if (!this.actions.has(actionKey(dependency))) throw new Error('Missing action dependency');
    this.actions.set(key, true);
    if (!observes) throw new Error('Coupled replay requires certified causal membership');
    this.observes = observes;
    this.current = action;
    this.nextOrdinal = 0;
    this.allocate(
      { allocations: action.allocations, births: structuredClone(input.births) },
      action,
    );
  }
  /** Call once per effect, including inactive and non-layout effects, in ordinal order. */
  step(ordinal: number, active: boolean, interpretationEligible = false): LayoutStepResult {
    const action = this.current;
    if (!action || ordinal !== this.nextOrdinal || ordinal >= action.effects.length)
      throw new Error('Effects must enter in prefix order');
    const effect = action.effects[ordinal];
    this.nextOrdinal++;
    const blocks: { node: NodeId; result: MoveResult }[] = [];
    const flows: { flow: FlowId; result: MoveResult }[] = [];
    if (!active) return { blocks, flows };
    switch (effect.type) {
      case 'MoveBlock': {
        const node = this.node(effect.node);
        if (
          node.flow === null
            ? effect.standaloneFlow !== null
            : effect.standaloneFlow === null ||
              resourceKey(node.flow) !== resourceKey(effect.standaloneFlow)
        )
          throw new Error("Move must assert the inline node's own standalone flow");
        blocks.push({ node: effect.node, result: this.moveBlock(effect) });
        // Independent constituent intentions: a cycle-rejected block edge still detaches.
        if (effect.standaloneFlow)
          flows.push({
            flow: effect.standaloneFlow,
            result: this.standalone(effect.standaloneFlow),
          });
        break;
      }
      case 'JoinFlow': {
        this.validateOccurrence(effect.occurrence, effect.destination);
        const flow = this.flow(effect.source);
        const run = this.runLayout(effect.destination.run);
        const placement: FlowPlacement = {
          flow: flow.id,
          parent: { type: 'flow', slot: effect.destination, occurrence: effect.occurrence },
        };
        flows.push({
          flow: flow.id,
          result: replaceEdge(
            this.inline,
            resourceKey(flow.id),
            resourceKey(run.run),
            placement,
            true,
          ),
        });
        if (flows.at(-1)!.result === 'applied') {
          const key = resourceKey(effect.occurrence),
            previous = this.joined.get(key) ?? [];
          if (!previous.some((id) => resourceKey(id) === resourceKey(flow.id)))
            this.joined.set(key, [...previous, flow.id]);
        }
        break;
      }
      case 'Interpret':
        if (interpretationEligible)
          for (const placement of effect.packet.placements)
            blocks.push({ node: placement.node, result: this.moveBlock(placement) });
        break;
      case 'LiftChildren':
        for (const placement of effect.placements)
          blocks.push({ node: placement.node, result: this.moveBlock(placement) });
        break;
      // Split births enter through allocate. Ownership, interpretation eligibility,
      // deletion and controls are composed by their owners, never inferred here.
      default:
        break;
    }
    return { blocks, flows };
  }
  private node(id: NodeId): NodeAllocation {
    const node = this.nodes.get(resourceKey(id));
    if (!node) throw new Error('Missing node allocation');
    return node;
  }
  private flow(id: FlowId): FlowAllocation {
    const flow = this.flows.get(resourceKey(id));
    if (!flow) throw new Error('Missing flow allocation');
    return flow;
  }
  private validateSlot(slot: BlockSlot | InlineSlot): void {
    if ('parent' in slot) this.node(slot.parent);
    else this.runLayout(slot.run);
    if (slot.predecessor) {
      const previous = this.occurrence(slot.predecessor);
      if (slotSequence(slot) !== slotSequence(previous.slot))
        throw new Error('Predecessor belongs to another slot sequence');
    }
  }
  private validateOccurrence(id: OccurrenceId, slot: BlockSlot | InlineSlot): void {
    this.validateSlot(slot);
    if (!sameSlot(this.occurrence(id).slot, slot)) throw new Error('Occurrence slot is immutable');
  }
  private moveBlock(placement: BlockPlacement): MoveResult {
    const node = this.node(placement.node);
    const parent = this.node(placement.slot.parent);
    this.validateOccurrence(placement.occurrence, placement.slot);
    const occurrenceKey = resourceKey(placement.occurrence);
    const owner = this.blockOwners.get(occurrenceKey);
    if (owner && owner !== resourceKey(node.id))
      throw new Error('Occurrence already belongs to another node');
    this.blockOwners.set(occurrenceKey, resourceKey(node.id));
    return replaceEdge(
      this.blocks,
      resourceKey(node.id),
      resourceKey(parent.id),
      placement,
      node.role !== 'root' && allowsRawChild(parent.role, node.role),
    );
  }
  private standalone(id: FlowId): MoveResult {
    const flow = this.flow(id);
    const placement: FlowPlacement = { flow: id, parent: { type: 'block', node: flow.home } };
    return replaceEdge(this.inline, resourceKey(id), resourceKey(flow.home), placement, true);
  }
  private allocate(batch: LayoutGenesis, action: LayoutAction | null): void {
    const orderById = new Map<string, EffectOrder>();
    for (const [ordinal, effect] of (action?.effects ?? []).entries()) {
      for (const id of effectOccurrences(effect)) {
        const key = resourceKey(id);
        if (orderById.has(key)) throw new Error('Occurrence used by multiple intentions');
        orderById.set(key, { action: action!, ordinal });
      }
    }
    // Register all resources before following same-batch references.
    for (const allocation of batch.allocations) {
      const key = resourceKey(allocation.id);
      if (allocation.id.kind !== allocation.type) throw new Error('Allocation kind mismatch');
      if (
        allocation.id.birth.type === 'genesis'
          ? action !== null
          : action === null || actionKey(allocation.id.birth.action) !== actionKey(action.id)
      )
        throw new Error('Allocation birth does not match its batch');
      switch (allocation.type) {
        case 'node':
          if (this.nodes.has(key)) throw new Error('Duplicate node');
          this.nodes.set(key, allocation);
          this.blocks.set(key, { parent: null, value: null });
          this.inline.set(key, { parent: null, value: null });
          if (allocation.role === 'root') {
            if (this.rootId || action || allocation.birthSlot || allocation.flow)
              throw new Error('Invalid document root');
            this.rootId = allocation.id;
          } else if (!allocation.birthSlot) throw new Error('Missing birth slot');
          if ((allocation.role === 'inline') !== (allocation.flow !== null))
            throw new Error('Only inline nodes own flows');
          break;
        case 'flow':
          if (this.flows.has(key)) throw new Error('Duplicate flow');
          this.flowRanks.set(key, this.flows.size);
          this.flows.set(key, allocation);
          this.inline.set(key, { parent: null, value: null });
          break;
        case 'run':
          if (this.runs.has(key)) throw new Error('Duplicate run');
          this.runs.set(key, {
            run: allocation.id,
            flow: allocation.flow,
            skeleton: allocation.skeleton,
          });
          this.inline.set(key, { parent: null, value: null });
          break;
        case 'occurrence':
          if (this.occurrences.has(key)) throw new Error('Duplicate occurrence');
          {
            const occurrence = {
              id: allocation.id,
              slot: allocation.slot,
              order: action ? (orderById.get(key) ?? { action, ordinal: -1 }) : null,
            };
            this.occurrences.set(key, occurrence);
            const sequence = slotSequence(allocation.slot);
            this.sequences.set(sequence, { occurrence, previous: this.sequences.get(sequence) });
          }
          break;
        default:
          break;
      }
    }
    for (const allocation of batch.allocations) {
      if (allocation.type === 'flow') {
        const node = this.node(allocation.home);
        if (!node.flow || resourceKey(node.flow) !== resourceKey(allocation.id))
          throw new Error('Flow must terminate at its owning inline block');
        this.standalone(allocation.id);
      } else if (allocation.type === 'run') {
        this.flow(allocation.flow);
        replaceEdge(
          this.inline,
          resourceKey(allocation.id),
          resourceKey(allocation.flow),
          null,
          true,
        );
      } else if (allocation.type === 'node' && allocation.flow) {
        if (resourceKey(this.flow(allocation.flow).home) !== resourceKey(allocation.id))
          throw new Error('Inline flow home mismatch');
      } else if (allocation.type === 'occurrence') {
        this.validateSlot(allocation.slot);
        const previousId = allocation.slot.predecessor;
        if (previousId && action) {
          const previous = this.occurrence(previousId);
          if (
            previous.order &&
            actionKey(previous.order.action.id) !== actionKey(action.id) &&
            !this.observes!(previous.order.action.id)
          )
            throw new Error('Predecessor is not causally available');
        }
      }
    }
    const births = new Map(batch.births.map((birth) => [resourceKey(birth.node), birth]));
    if (births.size !== batch.births.length) throw new Error('Duplicate birth binding');
    const unplaced = batch.allocations.filter(
      (allocation): allocation is NodeAllocation =>
        allocation.type === 'node' && allocation.role !== 'root',
    );
    if (
      births.size !== unplaced.length ||
      unplaced.some((node) => !births.has(resourceKey(node.id)))
    )
      throw new Error('Birth bindings must cover exactly the new non-root nodes');
    for (const node of unplaced) {
      const birth = births.get(resourceKey(node.id))!;
      const occurrence = this.occurrence(birth.occurrence);
      if (
        !batch.allocations.some(
          (allocation) =>
            allocation.type === 'occurrence' &&
            resourceKey(allocation.id) === resourceKey(birth.occurrence),
        )
      )
        throw new Error('Birth occurrence must be newly allocated');
      if (!sameSlot(occurrence.slot, node.birthSlot!))
        throw new Error('Birth occurrence must use the immutable birth slot');
      if (this.moveBlock({ ...birth, slot: node.birthSlot! }) !== 'applied')
        throw new Error('Invalid fallback placement');
    }
    // Unchanged immutable sequences require no work on text-only actions.
    if (!batch.allocations.some((a) => a.type === 'occurrence')) return;
    // Validate each complete sequence now, including inactive/ineffective occurrences.
    const sequences = new Map<string, OrderedOccurrence[]>();
    for (const occurrence of this.occurrences.values()) {
      const sequence = slotSequence(occurrence.slot);
      const entries = sequences.get(sequence) ?? [];
      entries.push(occurrence);
      sequences.set(sequence, entries);
    }
    for (const entries of sequences.values()) orderOccurrences(entries);
  }
}
