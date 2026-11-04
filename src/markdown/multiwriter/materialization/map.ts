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
