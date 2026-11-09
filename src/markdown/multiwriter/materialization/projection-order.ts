import type { ActionEnvelope, Allocation, NodeId, TapeId } from '../contracts.js';
import { countWork } from '../diagnostics.js';
import { set } from './map.js';
import type { MapRoot } from './map.js';

interface Resources {
  readonly nodes: readonly NodeId[];
  readonly tapes: readonly TapeId[];
}
function resources(allocations: readonly Allocation[]): Resources {
  const nodes: NodeId[] = [],
    tapes: TapeId[] = [];
  for (const allocation of allocations) {
    countWork('projection.orderAllocationsIndexed');
    if (allocation.type === 'node') nodes.push(allocation.id);
    else if (allocation.type === 'tape') tapes.push(allocation.id);
  }
  return { nodes, tapes };
}
function* entries(root: MapRoot<Resources> | undefined): Generator<Resources> {
  if (!root) return;
  yield* entries(root.left);
  countWork('projection.orderGroupsExported');
  yield root.value;
  yield* entries(root.right);
}
/** Full exports follow semantic action/allocation order, including earlier
 * arrivals. Preparation indexes only new allocations; readers retain current
 * immutable roots rather than an earlier ready array or a source callback.
 */
export class ProjectionOrder {
  private constructor(
    private readonly genesis: Resources,
    private readonly actions?: MapRoot<Resources>,
  ) {}
  static create(genesis: readonly Allocation[], actions: Iterable<ActionEnvelope>) {
    return new ProjectionOrder(resources(genesis)).add(actions);
  }
  add(actions: Iterable<ActionEnvelope>): ProjectionOrder {
    let root = this.actions;
    for (const action of actions) {
      const group = resources(action.allocations);
      if (!group.nodes.length && !group.tapes.length) continue;
      // Certified uint64 counters and fixed-width actors have compareActions
      // order. Within an action preserve allocation-array order, not ID order.
      const key = `${action.lamport.toString().padStart(20, '0')}:${action.id.actor}:${action.id.sequence.toString().padStart(20, '0')}`;
      root = set(root, key, group);
      countWork('projection.orderGroupsIndexed');
    }
    return root === this.actions ? this : new ProjectionOrder(this.genesis, root);
  }
  *nodes(): Generator<NodeId> {
    yield* this.genesis.nodes;
    for (const group of entries(this.actions)) yield* group.nodes;
  }
  *tapes(): Generator<TapeId> {
    yield* this.genesis.tapes;
    for (const group of entries(this.actions)) yield* group.tapes;
  }
}
