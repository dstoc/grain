import type { ActionEnvelope } from '../contracts.js';
import type { MapRoot } from './map.js';
import { set, remove } from './map.js';
import type { ReadySequence } from '../authoring/ready-source.js';

// Counters are certified uint64 values and actor IDs are fixed-width hex. This
// private key has exactly compareActions order; it is never a wire encoding.
const key = (action: ActionEnvelope) =>
  `${action.lamport.toString().padStart(20, '0')}:${action.id.actor}:${action.id.sequence.toString().padStart(20, '0')}`;
const sizes = new WeakMap<object, number>();
function size(root: MapRoot<ActionEnvelope> | undefined): number {
  if (!root) return 0;
  let count = sizes.get(root);
  if (count === undefined) {
    count = 1 + size(root.left) + size(root.right);
    sizes.set(root, count);
  }
  return count;
}
function* values(root: MapRoot<ActionEnvelope> | undefined): Generator<ActionEnvelope> {
  if (!root) return;
  yield* values(root.left);
  yield root.value;
  yield* values(root.right);
}
/** Ordered roots share unchanged paths without a previous-array or delta chain. */
export class OrderedActions implements ReadySequence {
  readonly length: number;
  constructor(private readonly root?: MapRoot<ActionEnvelope>) {
    this.length = size(root);
  }
  replace(before: ActionEnvelope | undefined, after: ActionEnvelope | undefined): OrderedActions {
    if (before === after) return this;
    const root = before ? remove(this.root, key(before)) : this.root;
    return new OrderedActions(after ? set(root, key(after), after) : root);
  }
  at(index: number): ActionEnvelope | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    let root = this.root;
    while (root) {
      const left = size(root.left);
      if (index === left) return root.value;
      if (index < left) root = root.left;
      else {
        index -= left + 1;
        root = root.right;
      }
    }
    return undefined;
  }
  [Symbol.iterator](): Iterator<ActionEnvelope> {
    return values(this.root);
  }
}
