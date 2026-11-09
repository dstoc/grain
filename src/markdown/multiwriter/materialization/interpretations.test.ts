import { expect, test } from 'vitest';
import { action, resource, A, B } from '../actions/test-fixtures.js';
import type { ActionEnvelope, InterpretationPacket, NodeId } from '../contracts.js';
import { reduceActivity } from '../visibility/activity.js';
import { selectInterpretations } from '../projection/interpretation.js';
import { captureDiagnostics } from '../diagnostics.js';
import { MaterializedInterpretations } from './interpretations.js';

const p = resource('node', 0),
  q = resource('node', 1),
  w = resource('node', 2),
  d = resource('node', 3),
  tape = resource('tape', 0);
const initial = [{ node: p, values: { info: 'initial', checked: null } }];
function packet(a: ActionEnvelope, source = p, marker = '#'): InterpretationPacket {
  return {
    id: resource('interpretation', 0, a.id),
    source,
    properties: { presentation: 'section', marker, info: null },
    wrappers: [w],
    derivedInlineOutputs: [d],
    effectOrdinals: [1],
    placements: [],
    syntaxMask: [{ tape, client: 1, clock: a.id.actor === A ? 0 : 3, length: 2 }],
    synthesizedText: [],
  };
}
function interpret(a: ActionEnvelope, source = p, marker = '#'): ActionEnvelope {
  return {
    ...a,
    effects: [
      { type: 'Interpret', packet: packet(a, source, marker) },
      { type: 'SetProperties', node: source, values: { checked: a.id.actor === A } },
      { type: 'SetProperties', node: source, values: { info: a.id.actor === A ? 'A' : 'B' } },
    ],
  };
}
function control(
  target: ActionEnvelope,
  active: boolean,
  previous: ActionEnvelope | null = null,
): ActionEnvelope {
  const a = action(target.id.actor, (previous?.id.sequence ?? target.id.sequence) + 1n, [
    target,
    ...(previous ? [previous] : []),
  ]);
  return {
    ...a,
    groupId: { ...target.groupId, sequence: 100n + a.id.sequence },
    effects: [
      {
        type: 'SetGroupActive',
        group: target.groupId,
        actions: [target.id],
        active,
        previousControl: previous?.id ?? null,
      },
    ],
  };
}
function equal(
  index: MaterializedInterpretations,
  actions: readonly ActionEnvelope[],
  nodes: readonly NodeId[] = [p, q, w, d],
) {
  const activity = reduceActivity(actions),
    full = selectInterpretations(activity, initial),
    value = index.value();
  expect(value.packets).toEqual(full.packets);
  expect(value.masks).toEqual(full.masks);
  for (const node of nodes) {
    expect(value.properties(node)).toEqual(full.properties(node));
    expect(value.birthEnabled(node)).toBe(full.birthEnabled(node));
  }
  for (const action of actions)
    for (let ordinal = 0; ordinal < action.effects.length; ordinal++) {
      const ref = { action: action.id, ordinal };
      expect(value.eligible(ref)).toBe(full.eligible(ref));
      expect(value.effectEligible(ref)).toBe(full.effectEligible(ref));
    }
  for (let clock = 0; clock < 7; clock++)
    for (const length of [0, 1, 2]) {
      const range = { tape, client: 1, clock, length };
      expect(value.masked(range)).toBe(full.masked(range));
    }
}

test('winner controls retain losing packets, membership, independent properties, masks and held reads', () => {
  const a = interpret(action(A)),
    b = interpret(action(B), p, '##'),
    initialActions = [a, b];
  let index = MaterializedInterpretations.create(
    initialActions,
    reduceActivity(initialActions),
    initial,
  );
  equal(index, initialActions);
  const held = index.value(),
    heldPackets = structuredClone(held.packets),
    off = control(b, false),
    disabled = [...initialActions, off];
  index = index.update([b], reduceActivity(disabled)).index;
  equal(index, disabled);
  expect(index.value().properties(p).checked).toBe(true);
  expect(held.packets).toEqual(heldPackets);
  expect(held.properties(p).checked).toBe(false);
  const on = control(b, true, off),
    restored = [...disabled, on];
  index = index.update([b], reduceActivity(restored)).index;
  equal(index, restored);
  expect(index.value().properties(p).checked).toBe(false);
  const removed = index.update(
    [],
    reduceActivity([a]),
    b.effects.map((_, ordinal) => ({ action: b.id, ordinal })),
  ).index;
  equal(removed, [a]);
  equal(index, restored);
});

test('earlier arrivals and independent later properties update only their source contributions', () => {
  const a = interpret(action(A)),
    b = interpret(action(B), p, '##');
  let index = MaterializedInterpretations.create([b], reduceActivity([b]), initial);
  index = index.update([a], reduceActivity([b, a])).index;
  equal(index, [b, a]);
  const later = {
    ...action(A, 2n, [a, b]),
    groupId: { ...a.groupId, sequence: 2n },
    effects: [{ type: 'SetProperties' as const, node: p, values: { marker: '###' } }],
  };
  const { value: change, report } = captureDiagnostics(() =>
    index.update([later], reduceActivity([a, b, later])),
  );
  index = change.index;
  equal(index, [a, b, later]);
  expect(report.work['driver/interpretation.fullIndexesConstructed'] ?? 0).toBe(0);
  expect(report.work['driver/interpretation.sourceCandidatesInspected'] ?? 0).toBe(0);
  expect(index.value().properties(p).marker).toBe('###');
  const { report: reads } = captureDiagnostics(() => {
    const value = index.value();
    value.properties(p);
    value.birthEnabled(w);
    value.masked({ tape, client: 1, clock: 1, length: 0 });
  });
  expect(reads.work['driver/interpretation.sourcesExported'] ?? 0).toBe(0);
});

test('source export order follows the first active packet', () => {
  const a = interpret(action(A)),
    b = interpret(action(B), p, '##');
  const cBase = action(B, 2n, [a, b]),
    c = interpret({ ...cBase, groupId: { ...cBase.groupId, sequence: 2n } }, q);
  let index = MaterializedInterpretations.create([a, b, c], reduceActivity([a, b, c]), initial);
  equal(index, [a, b, c]);
  const off = control(a, false),
    disabled = [a, b, c, off];
  index = index.update([a], reduceActivity(disabled)).index;
  equal(index, disabled);
});

test('source export order changes when its first active declaration is retracted', () => {
  const a = interpret(action(A)),
    b = interpret(action(B), q),
    lastBase = action(A, 2n, [a, b]);
  const last = interpret({ ...lastBase, groupId: { ...lastBase.groupId, sequence: 2n } }, p, '###');
  const before = [a, b, last],
    index = MaterializedInterpretations.create(before, reduceActivity(before), initial),
    off = {
      ...control(a, false),
      id: { actor: A, sequence: 3n },
      lamport: last.lamport + 1n,
      dependencies: [last.id, b.id, a.id],
      groupId: { ...a.groupId, sequence: 103n },
    },
    after = [...before, off];
  const changed = index.update([a], reduceActivity(after)).index;
  equal(changed, after);
  expect(changed.value().packets.map((packet) => packet.source)).toEqual([q, p]);
  expect(index.value().packets.map((packet) => packet.source)).toEqual([p, q]);
});

test('property and packet winner updates do not scan retained source history', () => {
  const actions: ActionEnvelope[] = [];
  for (let i = 0; i < 500; i++) {
    const base = action(A, BigInt(i + 1), actions.length ? [actions.at(-1)!] : []);
    actions.push({
      ...base,
      groupId: { ...base.groupId, sequence: BigInt(i + 1) },
      effects: [{ type: 'SetProperties', node: p, values: { info: `${i}` } }],
    });
  }
  const index = MaterializedInterpretations.create(actions, reduceActivity(actions), initial),
    nextBase = action(A, 501n, [actions.at(-1)!]),
    next = {
      ...nextBase,
      groupId: { ...nextBase.groupId, sequence: 501n },
      effects: [{ type: 'SetProperties' as const, node: p, values: { info: 'next' } }],
    };
  const activity = reduceActivity([...actions, next]),
    { value: candidate, report } = captureDiagnostics(() => index.update([next], activity));
  expect(report.work['driver/interpretation.propertyContributionsInspected']).toBeLessThanOrEqual(
    2,
  );
  expect(report.work['driver/interpretation.sourceCandidateNodesRead'] ?? 0).toBe(0);
  expect(report.work['driver/interpretation.propertyOrderNodesRead']).toBeLessThan(20);
  equal(candidate.index, [...actions, next]);
  expect(index.value().properties(p).info).toBe('499');
});

test('a selected packet identity invalidates dormant birth readers from other declarations', () => {
  const a = interpret(action(A)),
    b0 = interpret(action(B), p, '##');
  const withoutBirths = (
    body: ActionEnvelope,
    id?: InterpretationPacket['id'],
  ): ActionEnvelope => ({
    ...body,
    effects: body.effects.map((effect) =>
      effect.type === 'Interpret'
        ? {
            ...effect,
            packet: {
              ...effect.packet,
              ...(id ? { id } : {}),
              wrappers: [],
              derivedInlineOutputs: [],
            },
          }
        : effect,
    ),
  });
  const b = withoutBirths(b0),
    initialActions = [a, b],
    first = MaterializedInterpretations.create(
      initialActions,
      reduceActivity(initialActions),
      initial,
    );
  expect(first.value().birthEnabled(w)).toBe(false);
  const cBase = action(B, 2n, [a, b]),
    c = withoutBirths(
      interpret({ ...cBase, groupId: { ...cBase.groupId, sequence: 2n } }, q),
      (a.effects[0] as Extract<ActionEnvelope['effects'][number], { type: 'Interpret' }>).packet.id,
    ),
    actions = [...initialActions, c];
  const candidate = first.update([c], reduceActivity(actions));
  equal(candidate.index, actions);
  expect(candidate.births).toContainEqual(w);
  expect(candidate.births).toContainEqual(d);
  expect(candidate.index.value().birthEnabled(w)).toBe(true);
  expect(first.value().birthEnabled(w)).toBe(false);
});
