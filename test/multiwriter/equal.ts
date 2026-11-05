// @ts-expect-error Node APIs are supplied by Vitest; Grain has no @types/node dependency.
import { isDeepStrictEqual } from 'node:util';
import { expect } from 'vitest';

/** Fast exact positive comparison for detached trace data, including nested native
 * bytes. Keep Vitest's original toEqual matcher and diagnostics for every mismatch
 * (including values for which strict equality is more restrictive than toEqual).
 * This does not memoize a prior observation or omit any compared field.
 */
export function equal(actual: unknown, expected: unknown, context?: string): void {
  if (!isDeepStrictEqual(actual, expected)) expect(actual, context).toEqual(expected);
}
