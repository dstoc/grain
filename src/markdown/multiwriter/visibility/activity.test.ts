import { expect, test } from 'vitest';
import { action, A, B, C } from '../actions/test-fixtures.js';
import type { ActionEnvelope, ActionId } from '../contracts.js';
import { reduceActivity, reduceActivitySteps } from './activity.js';
import { compute } from '../ingest/work.js';
const key = (id: ActionId) => `${id.actor}:${id.sequence}`;

test('fresh causal word matrices match independent graph searches across word boundaries and controls', () => {
  const actors = [A, B, C];
  const actions: ActionEnvelope[] = [];
  const last = new Map<string, ActionEnvelope>();
  for (let i = 0; i < 99; i++) {
    const actor = actors[i % actors.length];
    const own = last.get(actor);
    const dependencies = [
      ...new Set(
        [own, actions[Math.floor(i / 2)]].filter(
          (value): value is ActionEnvelope => value !== undefined,
        ),
      ),
    ];
    const next = action(actor, (own?.id.sequence ?? 0n) + 1n, dependencies);
    actions.push(next);
    last.set(actor, next);
  }
  const members = actions.filter((entry) => entry.id.actor === A);
  const undo: ActionEnvelope = {
    ...action(A, 34n, [...last.values()]),
    effects: [
      {
        type: 'SetGroupActive',
        group: members[0].groupId,
        actions: members.map((entry) => entry.id),
        active: false,
        previousControl: null,
      },
    ],
  };
  const redone: ActionEnvelope = {
    ...action(A, 35n, [undo]),
    effects: [
      {
        type: 'SetGroupActive',
        group: members[0].groupId,
        actions: members.map((entry) => entry.id),
        active: true,
        previousControl: undo.id,
      },
    ],
  };
  const undone = reduceActivity([...actions, undo].reverse());
  for (const entry of actions) expect(undone.isActive(entry.id)).toBe(entry.id.actor !== A);
  actions.push(undo, redone);
  const byId = new Map(actions.map((entry) => [key(entry.id), entry]));
  const past = new Map(
    actions.map((entry) => {
      const seen = new Set<string>();
      const pending = [...entry.dependencies];
      while (pending.length) {
        const id = key(pending.pop()!);
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(...byId.get(id)!.dependencies);
      }
      return [key(entry.id), seen];
    }),
  );
  let result = compute(reduceActivitySteps([...actions].reverse()), 0);
  while (result.state === 'deferred') result = result.continuation.resume(1);
  for (const left of actions) {
    expect(result.value.isActive(left.id)).toBe(true);
    for (const right of actions) {
      const observes = past.get(key(left.id))!.has(key(right.id));
      expect(result.value.observes(left.id, right.id)).toBe(observes);
      expect(result.value.concurrent(left.id, right.id)).toBe(
        key(left.id) !== key(right.id) && !observes && !past.get(key(right.id))!.has(key(left.id)),
      );
    }
  }
});
