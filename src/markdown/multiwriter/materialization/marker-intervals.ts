import type { MarkerId, RangeRef } from '../contracts.js';
import { countWork } from '../diagnostics.js';

export interface MarkerInterval<T> {
  readonly id: string;
  readonly range: RangeRef;
  readonly value: T;
}
type Position = (marker: MarkerId) => number;
interface Root<T> {
  readonly entry: MarkerInterval<T>;
  readonly left?: Root<T>;
  readonly right?: Root<T>;
  readonly height: number;
  readonly maximum: MarkerId;
}
const height = <T>(root?: Root<T>) => root?.height ?? 0;
function node<T>(
  entry: MarkerInterval<T>,
  position: Position,
  left?: Root<T>,
  right?: Root<T>,
): Root<T> {
  let maximum = entry.range.end;
  for (const child of [left, right])
    if (child && position(child.maximum) > position(maximum)) maximum = child.maximum;
  countWork('subtree.intervalNodesUpdated');
  return { entry, left, right, maximum, height: 1 + Math.max(height(left), height(right)) };
}
function rotateLeft<T>(root: Root<T>, position: Position): Root<T> {
  const next = root.right!;
  return node(next.entry, position, node(root.entry, position, root.left, next.left), next.right);
}
function rotateRight<T>(root: Root<T>, position: Position): Root<T> {
  const next = root.left!;
  return node(next.entry, position, next.left, node(root.entry, position, next.right, root.right));
}
function balance<T>(root: Root<T>, position: Position): Root<T> {
  if (height(root.left) - height(root.right) > 1) {
    if (height(root.left!.right) > height(root.left!.left))
      root = node(root.entry, position, rotateLeft(root.left!, position), root.right);
    return rotateRight(root, position);
  }
  if (height(root.right) - height(root.left) > 1) {
    if (height(root.right!.left) > height(root.right!.right))
      root = node(root.entry, position, root.left, rotateRight(root.right!, position));
    return rotateLeft(root, position);
  }
  return root;
}
function order<T>(a: MarkerInterval<T>, b: MarkerInterval<T>, position: Position): number {
  return (
    position(a.range.start) - position(b.range.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
function insert<T>(
  root: Root<T> | undefined,
  entry: MarkerInterval<T>,
  position: Position,
): Root<T> {
  if (!root) return node(entry, position);
  const compare = order(entry, root.entry, position);
  if (!compare) return node(entry, position, root.left, root.right);
  return balance(
    compare < 0
      ? node(root.entry, position, insert(root.left, entry, position), root.right)
      : node(root.entry, position, root.left, insert(root.right, entry, position)),
    position,
  );
}
function remove<T>(
  root: Root<T> | undefined,
  entry: MarkerInterval<T>,
  position: Position,
): Root<T> | undefined {
  if (!root) return undefined;
  const compare = order(entry, root.entry, position);
  if (compare < 0)
    return balance(
      node(root.entry, position, remove(root.left, entry, position), root.right),
      position,
    );
  if (compare > 0)
    return balance(
      node(root.entry, position, root.left, remove(root.right, entry, position)),
      position,
    );
  if (!root.left) return root.right;
  if (!root.right) return root.left;
  let successor = root.right;
  while (successor.left) successor = successor.left;
  return balance(
    node(successor.entry, position, root.left, remove(root.right, successor.entry, position)),
    position,
  );
}
/** Persistent open native intervals queried at the gap immediately after a cell
 * start marker. Marker order, not numeric offsets, owns the search tree and max
 * summaries. Insert-only native refinement preserves every retained root.
 */
export class MarkerIntervals<T> {
  constructor(private readonly root?: Root<T>) {}
  get empty(): boolean {
    return this.root === undefined;
  }
  add(entry: MarkerInterval<T>, position: Position): MarkerIntervals<T> {
    if (position(entry.range.start) >= position(entry.range.end))
      throw new Error('Unordered retained visibility interval');
    return new MarkerIntervals(insert(this.root, entry, position));
  }
  remove(entry: MarkerInterval<T>, position: Position): MarkerIntervals<T> {
    return new MarkerIntervals(remove(this.root, entry, position));
  }
  at(gap: number, position: Position): readonly T[] {
    const result: T[] = [];
    const visit = (root?: Root<T>) => {
      if (!root || position(root.maximum) <= gap) return;
      countWork('subtree.intervalQueryNodesVisited');
      visit(root.left);
      if (position(root.entry.range.start) > gap) return;
      if (gap < position(root.entry.range.end)) result.push(root.entry.value);
      visit(root.right);
    };
    visit(this.root);
    return result;
  }
}
