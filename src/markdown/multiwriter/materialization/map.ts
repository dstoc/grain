/** Private immutable AVL roots. Updating one key copies only its search path. */
export interface MapRoot<T> {
  readonly key: string;
  readonly value: T;
  readonly left?: MapRoot<T>;
  readonly right?: MapRoot<T>;
  readonly height: number;
}
export function get<T>(root: MapRoot<T> | undefined, key: string): T | undefined {
  while (root) {
    if (key === root.key) return root.value;
    root = key < root.key ? root.left : root.right;
  }
}
const height = <T>(root: MapRoot<T> | undefined) => root?.height ?? 0;
function node<T>(key: string, value: T, left?: MapRoot<T>, right?: MapRoot<T>): MapRoot<T> {
  return { key, value, left, right, height: 1 + Math.max(height(left), height(right)) };
}
function rotateLeft<T>(root: MapRoot<T>): MapRoot<T> {
  const right = root.right!;
  return node(
    right.key,
    right.value,
    node(root.key, root.value, root.left, right.left),
    right.right,
  );
}
function rotateRight<T>(root: MapRoot<T>): MapRoot<T> {
  const left = root.left!;
  return node(left.key, left.value, left.left, node(root.key, root.value, left.right, root.right));
}
export function set<T>(root: MapRoot<T> | undefined, key: string, value: T): MapRoot<T> {
  if (!root) return node(key, value);
  if (key === root.key)
    return Object.is(value, root.value) ? root : node(key, value, root.left, root.right);
  let result =
    key < root.key
      ? node(root.key, root.value, set(root.left, key, value), root.right)
      : node(root.key, root.value, root.left, set(root.right, key, value));
  if (height(result.left) - height(result.right) > 1) {
    if (height(result.left!.right) > height(result.left!.left))
      result = node(result.key, result.value, rotateLeft(result.left!), result.right);
    return rotateRight(result);
  }
  if (height(result.right) - height(result.left) > 1) {
    if (height(result.right!.left) > height(result.right!.right))
      result = node(result.key, result.value, result.left, rotateRight(result.right!));
    return rotateLeft(result);
  }
  return result;
}

function* orderedEntries<T>(root: MapRoot<T> | undefined): Generator<readonly [string, T]> {
  if (!root) return;
  yield* orderedEntries(root.left);
  yield [root.key, root.value];
  yield* orderedEntries(root.right);
}
/** Insertion-ordered persistent roots with an action-local mutable wrapper.
 * Forking shares both roots; replacing a value preserves its original iteration rank.
 */
export class PersistentMap<T> implements Iterable<[string, T]> {
  private data?: MapRoot<T>;
  private order?: MapRoot<string>;
  private count = 0;
  get size(): number {
    return this.count;
  }
  get(key: string): T | undefined {
    return get(this.data, key);
  }
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
  set(key: string, value: T): this {
    if (!this.has(key)) {
      this.order = set(this.order, String(this.count).padStart(16, '0'), key);
      this.count++;
    }
    this.data = set(this.data, key, value);
    return this;
  }
  fork(): PersistentMap<T> {
    const copy = new PersistentMap<T>();
    copy.data = this.data;
    copy.order = this.order;
    copy.count = this.count;
    return copy;
  }
  *keys(): Generator<string> {
    for (const [, key] of orderedEntries(this.order)) yield key;
  }
  *values(): Generator<T> {
    for (const key of this.keys()) yield this.get(key)!;
  }
  *[Symbol.iterator](): Generator<[string, T]> {
    for (const key of this.keys()) yield [key, this.get(key)!];
  }
}
