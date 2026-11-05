import { expect, test } from 'vitest';
import { action, A, B } from '../actions/test-fixtures.js';
import { actionKey } from '../actions/references.js';
import type { ActionEnvelope } from '../contracts.js';
import { MaterializedReadyIndex } from './ready-index.js';

test('ready index provides exact additive differences and actor frontiers across map rotations', () => {
  const owner = {},
    empty = new MaterializedReadyIndex(owner);
  let current = empty;
  for (let i = 1; i <= 1000; i++) {
    const envelope = action(i % 2 ? A : B, BigInt(Math.ceil(i / 2)));
    const next = current.refine(new Map([[actionKey(envelope.id), envelope]]), BigInt(i));
    const changes = next.additions(current)!;
    expect(changes.actions).toEqual([envelope]);
    expect(changes.nodesVisited).toBeLessThan(150);
    expect(next.sequence(envelope.id.actor)).toBe(envelope.id.sequence);
    expect(current.has(actionKey(envelope.id))).toBe(false);
    current = next;
  }
  expect(current.maxLamport).toBe(1000n);
  expect(current.sequence(A)).toBe(500n);
  expect(current.sequence(B)).toBe(500n);
  expect(current.additions(empty)!.actions).toHaveLength(1000);
  expect(current.refine(new Map(), 1000n).additions(current)).toEqual({
    actions: [],
    nodesVisited: 0,
  });
});

test('withdrawals, replacement and unrelated owners decline additive reuse', () => {
  const owner = {},
    a = action(),
    b = action(B),
    empty = new MaterializedReadyIndex(owner);
  const initial = empty.refine(new Map([a, b].map((a) => [actionKey(a.id), a])), 1n);
  expect(initial.additions(new MaterializedReadyIndex({}))).toBeUndefined();
  const next = initial.refine(new Map([[actionKey(a.id), undefined]]), 1n);
  expect(next.additions(initial)).toBeUndefined();
  expect(next.sequence(A)).toBe(0n);
  expect(next.sequence(B)).toBe(1n);
  expect(initial.sequence(A)).toBe(1n);
  const changed = initial.refine(new Map([[actionKey(a.id), { ...a, lamport: 2n }]]), 2n);
  expect(changed.additions(initial)).toBeUndefined();
});

test('removing a suffix finds the retained actor frontier without keeping prior wrapper objects', () => {
  const owner = {},
    initial = new MaterializedReadyIndex(owner);
  const changes = new Map<string, ActionEnvelope | undefined>();
  for (let i = 1; i <= 128; i++) {
    const a = action(A, BigInt(i));
    changes.set(actionKey(a.id), a);
  }
  const all = initial.refine(changes, 128n);
  changes.clear();
  for (let i = 128; i >= 10; i--)
    changes.set(actionKey({ actor: A, sequence: BigInt(i) }), undefined);
  const next = all.refine(changes, 9n);
  expect(next.sequence(A)).toBe(9n);
  expect(next.maxLamport).toBe(9n);
  expect(all.sequence(A)).toBe(128n);
  expect(next.additions(all)).toBeUndefined();
});
