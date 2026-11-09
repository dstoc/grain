/** Copy elision for proven immutable plain observation data only. A cached object
 * cannot gain a mutable field later because it and every reachable object are
 * frozen. Accessors, mutable internal-slot objects and unsupported shapes decline.
 */
export function isImmutableData(value: unknown, known: WeakSet<object>, depth = 0): boolean {
  if (value === null || typeof value !== 'object')
    return typeof value !== 'function' && typeof value !== 'symbol';
  if (known.has(value)) return true;
  if (depth > 64 || !Object.isFrozen(value)) return false;
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      !('value' in field) ||
      (!(array && key === 'length') && !field.enumerable) ||
      !isImmutableData(field.value, known, depth + 1)
    )
      return false;
  }
  known.add(value);
  return true;
}
