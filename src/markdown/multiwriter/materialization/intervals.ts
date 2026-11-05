import type { MarkerId, RangeRef } from '../contracts.js';

type Position = (marker: MarkerId) => number;
interface Read {
  readonly range: RangeRef;
  readonly count: number;
}
interface Root extends Read {
  readonly left?: Root;
  readonly right?: Root;
  readonly height: number;
  readonly maxEnd: MarkerId;
  readonly first: number;
}
const height = (root: Root | undefined) => root?.height ?? 0;
function node(read: Read, position: Position, left?: Root, right?: Root): Root {
  let maxEnd = read.range.end;
  for (const child of [left, right])
    if (child && position(child.maxEnd) > position(maxEnd)) maxEnd = child.maxEnd;
  return {
    range: read.range,
    count: read.count,
    left,
    right,
    height: 1 + Math.max(height(left), height(right)),
    maxEnd,
    first: Math.min(read.count, left?.first ?? Infinity, right?.first ?? Infinity),
  };
}
function left(root: Root, position: Position): Root {
  const next = root.right!;
  return node(next, position, node(root, position, root.left, next.left), next.right);
}
function right(root: Root, position: Position): Root {
  const next = root.left!;
  return node(next, position, next.left, node(root, position, next.right, root.right));
}
function insert(root: Root | undefined, read: Read, position: Position): Root {
  if (!root) return node(read, position);
  const order =
    position(read.range.start) - position(root.range.start) ||
    position(read.range.end) - position(root.range.end);
  if (!order)
    return node(
      { ...read, count: Math.min(root.count, read.count) },
      position,
      root.left,
      root.right,
    );
  let result =
    order < 0
      ? node(root, position, insert(root.left, read, position), root.right)
      : node(root, position, root.left, insert(root.right, read, position));
  if (height(result.left) - height(result.right) > 1) {
    if (height(result.left!.right) > height(result.left!.left))
      result = node(result, position, left(result.left!, position), result.right);
    return right(result, position);
  }
  if (height(result.right) - height(result.left) > 1) {
    if (height(result.right!.left) > height(result.right!.right))
      result = node(result, position, result.left, right(result.right!, position));
    return left(result, position);
  }
  return result;
}

/** Tape-local immutable reverse reads. Permanent marker order, rather than stored
 * numeric positions, keeps these roots valid through text insertion and subdivision.
 * The caller must reject marker withdrawal/reordering before querying a retained root.
 */
export class NativeReadIntervals {
  private constructor(private readonly root?: Root) {}
  static empty(): NativeReadIntervals {
    return new NativeReadIntervals();
  }
  add(range: RangeRef, count: number, position: Position): NativeReadIntervals {
    // Replay counts are monotone. A covering earlier observation already owns
    // this dependency; retain no duplicate chain of repeated traversal reads.
    if (this.find(position(range.start), position(range.end), true, position, count + 1) <= count)
      return this;
    return new NativeReadIntervals(insert(this.root, { range, count }, position));
  }
  /** Earliest action reading strictly across a newly inserted marker. */
  first(point: number, position: Position, visit: () => void = () => {}): number | undefined {
    const found = this.find(point, point, false, position, Infinity, visit);
    return found === Infinity ? undefined : found;
  }
  private find(
    start: number,
    end: number,
    inclusive: boolean,
    position: Position,
    limit: number,
    visit: () => void = () => {},
  ): number {
    const walk = (root: Root | undefined): void => {
      if (!root) return;
      visit();
      if (root.first >= limit) return;
      const last = position(root.maxEnd);
      if (inclusive ? last < end : last <= end) return;
      const from = position(root.range.start);
      if (inclusive ? from > start : from >= start) {
        walk(root.left);
        return;
      }
      const to = position(root.range.end);
      if (inclusive ? to >= end : to > end) limit = Math.min(limit, root.count);
      // Search the earliest possible reader first. Its minimum count then prunes
      // later overlapping reads without enumerating them.
      const children =
        (root.left?.first ?? Infinity) <= (root.right?.first ?? Infinity)
          ? [root.left, root.right]
          : [root.right, root.left];
      for (const child of children) walk(child);
    };
    walk(this.root);
    return limit;
  }
}
