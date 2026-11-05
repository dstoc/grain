import type { MarkerId, RangeRef } from '../contracts.js';

type Position = (marker: MarkerId) => number;
/** The earliest reader at this permanent marker and immediately after it.
 * Separate point/gap values preserve strictly open read endpoints.
 */
interface Root {
  readonly marker: MarkerId;
  readonly at: number;
  readonly after: number;
  readonly left?: Root;
  readonly right?: Root;
  readonly height: number;
  readonly first: MarkerId;
  readonly last: MarkerId;
  readonly maximum: number;
  /** A pending minimum applied to both values throughout this subtree. */
  readonly limit?: number;
}
const height = (root: Root | undefined) => root?.height ?? 0;
function node(value: Pick<Root, 'marker' | 'at' | 'after'>, left?: Root, right?: Root): Root {
  return {
    ...value,
    left,
    right,
    height: 1 + Math.max(height(left), height(right)),
    first: left?.first ?? value.marker,
    last: right?.last ?? value.marker,
    maximum: Math.max(
      value.at,
      value.after,
      left?.maximum ?? -Infinity,
      right?.maximum ?? -Infinity,
    ),
    limit: undefined,
  };
}
function cap(root: Root | undefined, count: number): Root | undefined {
  if (!root || root.maximum <= count) return root;
  return {
    ...root,
    at: Math.min(root.at, count),
    after: Math.min(root.after, count),
    maximum: Math.min(root.maximum, count),
    limit: Math.min(root.limit ?? Infinity, count),
  };
}
function push(root: Root): Root {
  return root.limit === undefined
    ? root
    : node(root, cap(root.left, root.limit), cap(root.right, root.limit));
}
function left(root: Root): Root {
  const next = push(root.right!);
  return node(next, node(root, root.left, next.left), next.right);
}
function right(root: Root): Root {
  const next = push(root.left!);
  return node(next, next.left, node(root, next.right, root.right));
}
function insert(root: Root | undefined, marker: MarkerId, value: number, position: Position): Root {
  if (!root) return node({ marker, at: value, after: value });
  const order = position(marker) - position(root.marker);
  if (!order) return root;
  root = push(root);
  let result =
    order < 0
      ? node(root, insert(root.left, marker, value, position), root.right)
      : node(root, root.left, insert(root.right, marker, value, position));
  if (height(result.left) - height(result.right) > 1) {
    if (height(result.left!.right) > height(result.left!.left))
      result = node(result, left(push(result.left!)), result.right);
    return right(result);
  }
  if (height(result.right) - height(result.left) > 1) {
    if (height(result.right!.left) > height(result.right!.right))
      result = node(result, result.left, right(push(result.right!)));
    return left(result);
  }
  return result;
}
/** Every endpoint is installed before updating the open interval. A complete
 * interior subtree receives one lazy minimum; only boundary paths are copied.
 */
function update(
  root: Root | undefined,
  start: number,
  end: number,
  count: number,
  position: Position,
): Root | undefined {
  if (!root || position(root.last) < start || position(root.first) >= end) return root;
  if (position(root.first) > start && position(root.last) < end) return cap(root, count);
  root = push(root);
  const at = position(root.marker);
  return node(
    {
      marker: root.marker,
      at: start < at && at < end ? Math.min(root.at, count) : root.at,
      after: start <= at && at < end ? Math.min(root.after, count) : root.after,
    },
    update(root.left, start, end, count, position),
    update(root.right, start, end, count, position),
  );
}
function point(
  root: Root | undefined,
  value: number,
  position: Position,
  after = false,
  visit: () => void = () => {},
): number {
  let found = Infinity,
    inherited = Infinity;
  while (root) {
    visit();
    const at = position(root.marker);
    if (at === value) return Math.min(after ? root.after : root.at, inherited);
    if (at < value) found = Math.min(root.after, inherited);
    inherited = Math.min(inherited, root.limit ?? Infinity);
    root = at < value ? root.right : root.left;
  }
  return found;
}
/** Largest earliest-reader value at interior endpoints/gaps. The initial gap
 * after start is checked separately, including when start is not yet indexed.
 */
function maximum(
  root: Root | undefined,
  start: number,
  end: number,
  position: Position,
  inherited = Infinity,
): number {
  if (!root || position(root.last) <= start || position(root.first) >= end) return -Infinity;
  if (position(root.first) > start && position(root.last) < end)
    return Math.min(root.maximum, inherited);
  const at = position(root.marker),
    limit = Math.min(inherited, root.limit ?? Infinity);
  return Math.max(
    start < at && at < end ? Math.min(Math.max(root.at, root.after), inherited) : -Infinity,
    maximum(root.left, start, end, position, limit),
    maximum(root.right, start, end, position, limit),
  );
}

/** Tape-local immutable earliest-reader envelope. Permanent marker order keeps
 * roots valid through native insertion/subdivision. The caller must reject marker
 * withdrawal/reordering. Retain no action callbacks or numeric marker positions.
 */
export class NativeReadIntervals {
  private constructor(private readonly root?: Root) {}
  static empty(): NativeReadIntervals {
    return new NativeReadIntervals();
  }
  add(range: RangeRef, count: number, position: Position): NativeReadIntervals {
    const start = position(range.start),
      end = position(range.end);
    if (start >= end) throw new Error('Native read interval must have ordered endpoints');
    const from = point(this.root, start, position, true);
    if (Math.max(from, maximum(this.root, start, end, position)) <= count) return this;
    let root = insert(this.root, range.start, from, position);
    root = insert(root, range.end, point(root, end, position, true), position);
    return new NativeReadIntervals(update(root, start, end, count, position));
  }
  /** Earliest action reading strictly across a newly inserted marker. */
  first(value: number, position: Position, visit: () => void = () => {}): number | undefined {
    const found = point(this.root, value, position, false, visit);
    return found === Infinity ? undefined : found;
  }
}
