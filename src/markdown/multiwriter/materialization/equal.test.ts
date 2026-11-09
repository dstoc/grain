import { expect, test } from 'vitest';
import { equal } from '../../../../test/multiwriter/equal.js';

test('trace comparison retains nested byte, length, structural and bigint mismatches', () => {
  const state = () => ({
    action: { sequence: 501n, update: Uint8Array.of(1, 2, 3) },
    native: [Uint8Array.of(4, 5)],
    pending: ['A1'],
  });
  equal(state(), state());
  for (const mutate of [
    (value: ReturnType<typeof state>) => {
      value.action.update[2] = 9;
    },
    (value: ReturnType<typeof state>) => {
      value.action.update = Uint8Array.of(1, 2);
    },
    (value: ReturnType<typeof state>) => {
      value.native[0][0] = 9;
    },
    (value: ReturnType<typeof state>) => {
      value.action.sequence = 502n;
    },
    (value: ReturnType<typeof state>) => {
      value.pending = [];
    },
  ]) {
    const changed = state();
    mutate(changed);
    expect(() => equal(changed, state(), 'retained facts')).toThrow('retained facts');
  }
  // The fast positive path keeps the existing toEqual semantics on its fallback.
  equal({ present: undefined }, {});
});
