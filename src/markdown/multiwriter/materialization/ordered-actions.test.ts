import { expect, test } from 'vitest';
import { A, B, C, action } from '../actions/test-fixtures.js';
import { compareActions, MAX_COUNTER } from '../contracts.js';
import type { ActionEnvelope } from '../contracts.js';
import { OrderedActions } from './ordered-actions.js';

test('persistent ordered reads equal full sorting across arrivals, replacement and withdrawal', () => {
  let index = new OrderedActions(),
    seed = 94130;
  const current = new Map<string, ActionEnvelope>(),
    held: { index: OrderedActions; actions: readonly ActionEnvelope[] }[] = [];
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let step = 0; step < 1500; step++) {
    const id = String(random() % 300),
      before = current.get(id);
    if (before) current.delete(id);
    const after =
      step % 5
        ? {
            ...action([A, B, C][random() % 3], BigInt(id) + 1n),
            lamport: step % 7 ? BigInt(random() % 500) : MAX_COUNTER,
          }
        : undefined;
    if (after) current.set(id, after);
    index = index.replace(before, after);
    const sorted = [...current.values()].sort(compareActions);
    expect([...index]).toEqual(sorted);
    expect(index.length).toBe(sorted.length);
    for (const at of [-sorted.length - 1, -1, 0, Math.floor(sorted.length / 2), sorted.length])
      expect(index.at(at)).toBe(sorted.at(at));
    if (step % 103 === 0) held.push({ index, actions: sorted });
  }
  for (const prior of held) expect([...prior.index]).toEqual(prior.actions);
  expect(index.at(Infinity)).toBeUndefined();
  expect(index.at(-Infinity)).toBeUndefined();
  expect(index.at(NaN)).toBe(index.at(0));
});

test('uint64 counter ordering, actor ties and retained same-key replacements match the contract', () => {
  const actions = [
    { ...action(A, MAX_COUNTER), lamport: MAX_COUNTER },
    { ...action(B, 1n), lamport: MAX_COUNTER },
    { ...action(A, 9n), lamport: MAX_COUNTER },
    { ...action(C, 10n), lamport: 10n },
    { ...action(C, 1n), lamport: 9n },
  ];
  let index = new OrderedActions();
  for (const entry of actions.toReversed()) index = index.replace(undefined, entry);
  expect([...index]).toEqual(actions.toSorted(compareActions));
  const held = index,
    replacement = { ...actions[0], effects: [] };
  index = index.replace(actions[0], replacement);
  expect(index.at(-2)).toBe(replacement);
  expect(held.at(-2)).toBe(actions[0]);
  expect(index.replace(replacement, replacement)).toBe(index);
});
