import type { ActionEnvelope } from '../contracts.js';
import { compareBytes } from './cbor.js';

/** Exact positive precheck for canonical envelope encoding. Unsupported object
 * shapes decline to the encoder. This never substitutes a hash or action ID for
 * payload equality, and never consults another reader's certificates.
 */
export function sameEnvelopeData(left: ActionEnvelope, right: ActionEnvelope): boolean {
  return same(left, right, 0);
}
function same(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right) && (left === null || typeof left !== 'object')) return true;
  if (depth > 64 || !left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (left instanceof Uint8Array || right instanceof Uint8Array)
    return (
      left instanceof Uint8Array && right instanceof Uint8Array && compareBytes(left, right) === 0
    );
  const array = Array.isArray(left);
  const prototype = array ? Array.prototype : Object.prototype;
  if (
    Array.isArray(right) !== array ||
    Object.getPrototypeOf(left) !== prototype ||
    Object.getPrototypeOf(right) !== prototype
  )
    return false;
  const keys = Reflect.ownKeys(left);
  if (keys.length !== Reflect.ownKeys(right).length) return false;
  for (const key of keys) {
    if (typeof key !== 'string') return false;
    const a = Object.getOwnPropertyDescriptor(left, key),
      b = Object.getOwnPropertyDescriptor(right, key);
    if (
      !a ||
      !b ||
      !('value' in a) ||
      !('value' in b) ||
      (!(array && key === 'length') && (!a.enumerable || !b.enumerable)) ||
      !same(a.value, b.value, depth + 1)
    )
      return false;
  }
  return true;
}
