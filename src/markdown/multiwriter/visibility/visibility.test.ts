import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { actorId } from '../contracts.js';
import type {
  ActionEnvelope,
  ActionId,
  Allocation,
  DeletionId,
  NativeTextRange,
  NodeId,
  RangeRef,
  ResourceId,
  ResourceKind,
  SemanticEffect,
} from '../contracts.js';
import { reduceActivity, reduceVisibility } from './index.js';
import type { EffectRef, TextToken, VisibilityLayout, VisibilityNode } from './index.js';

const actors = {
  A: actorId('00000000000000000000000000000001'),
  B: actorId('00000000000000000000000000000002'),
  C: actorId('00000000000000000000000000000003'),
};
function genesis<K extends ResourceKind>(kind: K, ordinal: number): ResourceId<K> {
  return { kind, birth: { type: 'genesis', genesisId: 'G' }, ordinal };
}
function born<K extends ResourceKind>(
  kind: K,
  action: ActionEnvelope,
  ordinal: number,
): ResourceId<K> {
  return { kind, birth: { type: 'action', action: action.id }, ordinal };
}
function action(
  actor: keyof typeof actors,
  sequence: bigint,
  dependencies: readonly ActionEnvelope[] = [],
  effects: readonly SemanticEffect[] = [],
  options: Partial<ActionEnvelope> = {},
): ActionEnvelope {
  const id = { actor: actors[actor], sequence };
  return {
    protocolVersion: 3,
    documentId: 'D',
    genesisId: 'G',
    id,
    lamport: 1n + dependencies.reduce((max, d) => (d.lamport > max ? d.lamport : max), 0n),
    dependencies: dependencies.map((d) => d.id),
    groupId: { session: { actor: id.actor, local: 'editor' }, sequence },
    allocations: [],
    nativeManifest: [],
    nativeInsertUpdates: [],
    effects,
    ...options,
  };
}
function control(
  actor: keyof typeof actors,
  sequence: bigint,
  targets: readonly ActionEnvelope[],
  active: boolean,
  previous: ActionEnvelope | null = null,
  dependencies = [...targets, ...(previous ? [previous] : [])],
): ActionEnvelope {
  return action(actor, sequence, dependencies, [
    {
      type: 'SetGroupActive',
      group: targets[0].groupId,
      actions: targets.map((target) => target.id),
      active,
      previousControl: previous?.id ?? null,
    },
  ]);
}
function permutations<T>(items: readonly T[]): T[][] {
  return items.length
    ? items.flatMap((item, i) => permutations(items.toSpliced(i, 1)).map((rest) => [item, ...rest]))
    : [[]];
}
const root = genesis('node', 0);
const P = genesis('node', 1);
const Q = genesis('node', 2);
const tape = genesis('tape', 3);
const otherTape = genesis('tape', 4);
const interval: RangeRef = { tape, start: genesis('marker', 5), end: genesis('marker', 6) };
const suffix: RangeRef = { tape, start: genesis('marker', 7), end: interval.end };
const pText: TextToken[] = Array.from({ length: 6 }, (_, clock) => ({
  tape,
  native: { client: 1, clock },
  birth: null,
}));
const exact = (clock: number, length = 1): NativeTextRange => ({ tape, client: 1, clock, length });
const properties: SemanticEffect = { type: 'SetProperties', node: P, values: { marker: '#' } };
function node(id: NodeId, parent: NodeId | null): VisibilityNode {
  return {
    type: 'node',
    id,
    role: parent ? 'inline' : 'root',
    flow: null,
    birthSlot: parent ? { parent, predecessor: null } : null,
  };
}
function same(left: unknown, right: unknown): boolean {
  // IDs contain bigint counters. Object identity is deliberately not required.
  return (
    JSON.stringify(left, (_, value) => (typeof value === 'bigint' ? `${value}n` : value)) ===
    JSON.stringify(right, (_, value) => (typeof value === 'bigint' ? `${value}n` : value))
  );
}
function subtree(
  tag: DeletionId,
  target = P,
  observedNodes: readonly NodeId[] = [target],
  ownedIntervals: readonly RangeRef[] = [interval],
  heads: readonly ActionId[] = [],
): SemanticEffect {
  return {
    type: 'DeleteSubtree',
    tag,
    scope: { target, observedNodes, ownedIntervals, joinedFlows: [], heads },
  };
}
function deletion(
  actor: keyof typeof actors,
  sequence = 1n,
  dependencies: ActionEnvelope[] = [],
): ActionEnvelope {
  const a = action(actor, sequence, dependencies);
  return { ...a, effects: [subtree(born('deletion', a, 0), P, [P], [interval], a.dependencies)] };
}
function fixture(
  actions: readonly ActionEnvelope[],
  options: {
    nodes?: readonly VisibilityNode[];
    tokens?: readonly TextToken[];
    parent?: VisibilityLayout['parent'];
    owner?: VisibilityLayout['owner'];
    requirements?: VisibilityLayout['requirements'];
    contains?: VisibilityLayout['contains'];
    containsBirthContent?: VisibilityLayout['containsBirthContent'];
  } = {},
) {
  const nodes = options.nodes ?? [node(root, null), node(P, root), node(Q, root)];
  const layout: VisibilityLayout = {
    nodes,
    parent:
      options.parent ?? ((id) => nodes.find((n) => same(n.id, id))!.birthSlot?.parent ?? null),
    owner: options.owner ?? (() => P),
    requirements: options.requirements ?? (() => []),
    // Synthetic converged marker membership for this unit fixture. MW-02/04
    // must supply real native order and ownership at the composition gate.
    contains:
      options.contains ??
      ((range, token) =>
        same(range.tape, token.tape) &&
        (same(range, interval) || (same(range, suffix) && token.native.clock >= 3))),
    containsBirthContent: options.containsBirthContent ?? (() => false),
  };
  return reduceVisibility(reduceActivity(actions), layout, options.tokens ?? pText);
}

// These are pure algebra tests, not a replica adapter or the MW-08 gate.
describe('group activity and immutable effect order', () => {
  it('retracts a complete multi-action group and reactivates at its original priority', () => {
    const first = action('A', 1n, [], [properties, properties]);
    const second = action('A', 2n, [first], [properties], { groupId: first.groupId });
    const peer = action('B', 1n, [second], [properties]);
    const undo = control('A', 3n, [first, second], false, null, [peer]);
    const redo = control('A', 4n, [first, second], true, undo);
    const inactive = reduceActivity([peer, undo, second, first]);
    expect(inactive.effects.map((e) => e.action)).toEqual([peer.id]);
    expect(inactive.actions).toHaveLength(4);
    for (const order of permutations([first, second, peer, undo, redo])) {
      const result = reduceActivity(order);
      expect(result.effects.map(({ action, ordinal }) => [action, ordinal])).toEqual([
        [first.id, 0],
        [first.id, 1],
        [second.id, 0],
        [peer.id, 0],
      ]);
      expect(result.isEffectActive({ action: undo.id, ordinal: 0 })).toBe(false);
      expect(result.isActive(undo.id)).toBe(true);
    }
  });

  it('retains allocations and insertion bodies after undo without copying them', () => {
    const a = action('A', 1n);
    const allocation: Allocation = node(born('node', a, 0), root);
    const body = new Uint8Array([1, 2, 3]);
    const created = { ...a, allocations: [allocation], nativeInsertUpdates: [body] };
    const undo = control('A', 2n, [created], false);
    const result = reduceActivity([undo, created]);
    expect(result.isActive(a.id)).toBe(false);
    expect(result.actions[0].allocations[0]).toBe(allocation);
    expect(result.actions[0].nativeInsertUpdates[0]).toBe(body);
  });

  it('uses causal closure rather than Lamport or arrival order for concurrency', () => {
    const a = action('A', 1n);
    const b = action('B', 1n);
    const c = action('C', 1n, [a, b]);
    const result = reduceActivity([c, b, a]);
    expect(result.concurrent(a.id, b.id)).toBe(true);
    expect(result.concurrent(a.id, a.id)).toBe(false);
    expect(result.concurrent(a.id, c.id)).toBe(false);
    expect(result.observes(c.id, a.id)).toBe(true);
    expect(result.observes(a.id, c.id)).toBe(false);
  });

  it('rejects incomplete ready sets, duplicate IDs and unknown queries', () => {
    const a = action('A', 1n);
    const undo = control('A', 2n, [a], false);
    expect(() => reduceActivity([undo])).toThrow('dependency');
    expect(() => reduceActivity([a, a])).toThrow('Duplicate');
    const result = reduceActivity([a]);
    expect(() => result.isActive(action('B', 1n).id)).toThrow('ready closure');
    expect(() => result.isEffectActive({ action: a.id, ordinal: 0 })).toThrow('ordinal');
  });

  it('rejects controls from another actor or another local session', () => {
    const a = action('A', 1n);
    expect(() => reduceActivity([a, control('B', 1n, [a], false)])).toThrow('owning session');
    const wrongSession = {
      ...control('A', 2n, [a], false),
      groupId: {
        session: { actor: actors.A, local: 'second-pane' },
        sequence: 2n,
      },
    };
    expect(() => reduceActivity([a, wrongSession])).toThrow('owning session');
  });

  it('requires the exact target group, observes targets, and seals membership', () => {
    const a = action('A', 1n);
    const b = action('A', 2n, [a], [], { groupId: a.groupId });
    expect(() => reduceActivity([a, b, control('A', 3n, [a], false, null, [b])])).toThrow(
      'every action',
    );
    expect(() => reduceActivity([a, control('A', 2n, [a, a], false)])).toThrow('every action');
    const unseen = { ...control('A', 2n, [a], false), dependencies: [] };
    expect(() => reduceActivity([a, unseen])).toThrow('observe all target');
    const undo = control('A', 2n, [a], false);
    const lateMember = action('A', 3n, [undo], [], { groupId: a.groupId });
    expect(() => reduceActivity([lateMember, undo, a])).toThrow('sealed');
    const otherGroup = action('B', 1n);
    expect(() => reduceActivity([a, otherGroup, control('A', 2n, [a, otherGroup], false)])).toThrow(
      'every action',
    );
  });

  it('requires a causal owner chain, and controls are not recursively undoable', () => {
    const a = action('A', 1n);
    const undo = control('A', 2n, [a], false);
    const badRedo = control('A', 3n, [a], true, null, [undo]);
    expect(() => reduceActivity([a, undo, badRedo])).toThrow('previous owner');
    const unseenUndo = control('A', 3n, [a], true, undo, [a]);
    expect(() => reduceActivity([a, undo, unseenUndo])).toThrow('observe the previous');
    const recursive = control('A', 3n, [undo], false);
    expect(() => reduceActivity([a, undo, recursive])).toThrow('nonempty sealed group');
  });

  it.each(['effects', 'allocations', 'nativeManifest', 'nativeInsertUpdates'] as const)(
    'rejects editable %s inside a control',
    (field) => {
      const a = action('A', 1n);
      const undo = control('A', 2n, [a], false);
      const changes: Partial<ActionEnvelope> =
        field === 'effects'
          ? { effects: [...undo.effects, properties] }
          : field === 'allocations'
            ? { allocations: [node(P, root)] }
            : field === 'nativeManifest'
              ? { nativeManifest: [{ type: 'text', tape, native: exact(0), text: 'x' }] }
              : { nativeInsertUpdates: [new Uint8Array([1])] };
      expect(() => reduceActivity([a, { ...undo, ...changes }])).toThrow('editable effects');
    },
  );

  it('retracts all editable effect kinds without reordering surviving peer effects', () => {
    // The activity layer treats every non-control effect atomically. Its payload
    // references are validated by ingest/layout, not interpreted by this filter.
    const kinds: SemanticEffect['type'][] = [
      'InsertText',
      'MoveBlock',
      'JoinFlow',
      'SplitFlow',
      'TransferRange',
      'DeleteText',
      'DeleteSubtree',
      'Interpret',
      'SetProperties',
      'LiftChildren',
    ];
    const effects = kinds.map((type) => ({ type }) as SemanticEffect);
    const a = action('A', 1n, [], effects);
    const b = action('B', 1n, [], [properties]);
    const undo = control('A', 2n, [a], false);
    expect(reduceActivity([b, undo, a]).effects.map((e) => e.action)).toEqual([b.id]);
    const redo = control('A', 3n, [a], true, undo);
    expect(reduceActivity([redo, b, undo, a]).effects.map((e) => e.effect.type)).toEqual([
      ...kinds,
      'SetProperties',
    ]);
  });
});

describe('native insertion and exact text deletion', () => {
  it('undoes only the insertion birth and preserves a peer insertion and its identity', () => {
    const a = action('A', 1n, [], [{ type: 'InsertText', ranges: [{ ...exact(0), client: 2 }] }]);
    const b = action('B', 1n, [], [{ type: 'InsertText', ranges: [{ ...exact(0), client: 3 }] }]);
    const ta = { tape, native: { client: 2, clock: 0 }, birth: a.id };
    const tb = { tape, native: { client: 3, clock: 0 }, birth: b.id };
    const undo = control('A', 2n, [a], false);
    const tokens = [pText[0], ta, tb];
    const result = fixture([b, undo, a], { tokens });
    expect(result.text.map((t) => t.visible)).toEqual([true, false, true]);
    expect(result.text[2].token).toBe(tb);
    expect(
      fixture([a, b, undo, control('A', 3n, [a], true, undo)], { tokens }).text.map(
        (t) => t.visible,
      ),
    ).toEqual([true, true, true]);
  });

  it('keeps a duplicate-deleted character hidden until both tags are retracted, then reveals the same token once', () => {
    const a = action('A', 1n);
    const b = action('B', 1n);
    const da = born('deletion', a, 0);
    const db = born('deletion', b, 0);
    const aDelete = {
      ...a,
      effects: [{ type: 'DeleteText', tag: da, observed: [exact(2)] } as const],
    };
    const bDelete = {
      ...b,
      effects: [{ type: 'DeleteText', tag: db, observed: [exact(2)] } as const],
    };
    const ua = control('A', 2n, [aDelete], false);
    const ub = control('B', 2n, [bDelete], false);
    const rb = control('B', 3n, [bDelete], true, ub);
    const stages = [
      { actions: [aDelete, bDelete], tags: [da, db] },
      { actions: [aDelete, bDelete, ua], tags: [db] },
      { actions: [aDelete, bDelete, ua, ub], tags: [] },
      { actions: [aDelete, bDelete, ua, ub, rb], tags: [db] },
    ];
    for (const stage of stages)
      for (const order of [stage.actions, [...stage.actions].reverse()]) {
        const result = fixture(order);
        expect(result.text[2].tags).toEqual(stage.tags);
        expect(result.text[2].visible).toBe(stage.tags.length === 0);
        expect(result.text[2].token).toBe(pText[2]);
        expect(result.text.filter((t) => t.visible && t.token === pText[2])).toHaveLength(
          stage.tags.length ? 0 : 1,
        );
      }
  });

  it('does not expand exact deletion to unseen insertions, another client, or another tape', () => {
    const a = action('A', 1n);
    const d = {
      ...a,
      effects: [
        { type: 'DeleteText', tag: born('deletion', a, 0), observed: [exact(1, 2)] } as const,
      ],
    };
    const tokens = [
      pText[0],
      pText[1],
      { tape, native: { client: 2, clock: 1 }, birth: null },
      pText[2],
      pText[3],
      { ...pText[1], tape: otherTape },
    ];
    expect(fixture([d], { tokens }).text.map((t) => t.visible)).toEqual([
      true,
      false,
      true,
      false,
      true,
      true,
    ]);
  });
});

describe('captured subtree coverage and deleted destinations', () => {
  it('masks captured identities at their final owner without tombstoning a sibling', () => {
    const d = deletion('A');
    // Layout already applied the structural intention. Ownership is independent
    // of this visibility reduction and is never rolled back by a delete.
    const result = fixture([d], { owner: (token) => (token.native.clock < 3 ? P : Q) });
    expect(result.text.every((t) => !t.visible)).toBe(true);
    expect(result.text.slice(3).every((t) => t.tags.length === 1 && !t.deletedDestination)).toBe(
      true,
    );
    expect(result.nodes.find((n) => same(n.node, Q))).toMatchObject({
      deleted: false,
      available: true,
    });
  });

  it('preserves causally escaped text and does not tombstone a stale split sibling by historical source', () => {
    const earlierMove = action(
      'A',
      1n,
      [],
      [
        {
          type: 'TransferRange',
          ranges: [suffix],
          destination: {
            run: genesis('run', 20),
            boundary: genesis('marker', 21),
            side: 'right',
            predecessor: null,
          },
          run: genesis('run', 22),
          occurrence: genesis('occurrence', 23),
        },
      ],
    );
    const d = deletion('A', 2n, [earlierMove]);
    const prefix = { ...interval, end: genesis('marker', 8) };
    const scoped = {
      ...d,
      effects: [subtree(born('deletion', d, 0), P, [P], [prefix], [earlierMove.id])],
    };
    const staleSplit = action('B', 1n);
    const sibling = born('node', staleSplit, 0);
    const created = { ...staleSplit, allocations: [node(sibling, root)] };
    const result = fixture([created, scoped, earlierMove], {
      nodes: [node(root, null), node(P, root), node(Q, root), node(sibling, root)],
      owner: (token) => (token.native.clock < 3 ? sibling : Q),
      contains: (range, token) => same(range, prefix) && token.native.clock < 3,
    });
    expect(result.text.map((t) => t.visible)).toEqual([false, false, false, true, true, true]);
    expect(result.nodes.filter((n) => n.tags.length).map((n) => n.node)).toEqual([P]);
    expect(result.nodes.find((n) => same(n.node, sibling))!.deleted).toBe(false);
  });

  it('expands captured marker intervals to later unseen native insertions', () => {
    const d = deletion('A');
    const b = action('B', 1n);
    const inserted = { tape, native: { client: 2, clock: 0 }, birth: b.id };
    const result = fixture([d, b], { tokens: [...pText, inserted], owner: () => Q });
    expect(result.text.at(-1)).toMatchObject({ insertionActive: true, visible: false });
    expect(result.text.at(-1)!.tags).toHaveLength(1);
  });

  it('uses all captured intervals for joined content, not final flow membership', () => {
    const d = deletion('A');
    const joinedRange = {
      tape: otherTape,
      start: genesis('marker', 9),
      end: genesis('marker', 10),
    };
    const effect = subtree(born('deletion', d, 0), P, [P], [interval, joinedRange]);
    if (effect.type !== 'DeleteSubtree') throw new Error('fixture');
    const scoped = {
      ...d,
      effects: [{ ...effect, scope: { ...effect.scope, joinedFlows: [genesis('flow', 11)] } }],
    };
    const joinedToken = { ...pText[0], tape: otherTape };
    const result = fixture([scoped], {
      tokens: [joinedToken],
      owner: () => Q,
      contains: () => true,
    });
    expect(result.text[0]).toMatchObject({ visible: false, deletedDestination: false });
    expect(result.text[0].tags).toHaveLength(1);
  });

  it('hides a transfer into a deleted destination without rescuing it to its source', () => {
    const d = action('A', 1n);
    const scoped = { ...d, effects: [subtree(born('deletion', d, 0), Q, [Q], [])] };
    const owner = () => Q;
    const result = fixture([scoped], { owner });
    expect(result.text.every((t) => !t.visible && t.deletedDestination && !t.tags.length)).toBe(
      true,
    );
    expect(result.nodes.find((n) => same(n.node, P))!.available).toBe(true);
    expect(owner()).toBe(Q);
  });

  it('unions independent subtree and exact text tags; undoing either cannot clear the other', () => {
    const d = deletion('A');
    const b = action('B', 1n);
    const textDelete = {
      ...b,
      effects: [{ type: 'DeleteText', tag: born('deletion', b, 0), observed: [exact(2)] } as const],
    };
    const ud = control('A', 2n, [d], false);
    const result = fixture([d, textDelete, ud]);
    expect(result.text.map((t) => t.visible)).toEqual([true, true, false, true, true, true]);
    expect(result.nodes.find((n) => same(n.node, P))!.deleted).toBe(false);
  });
});

describe('causal birth context', () => {
  it('carries inherited birth-content deletion through transfers and later native insertions', () => {
    const d = deletion('A');
    const birth = action('B', 1n);
    const N = born('node', birth, 0);
    const newTape = born('tape', birth, 1);
    const created = { ...birth, allocations: [node(N, P)] };
    const later = action('B', 2n, [created]);
    const tokens = [
      { tape: newTape, native: { client: 2, clock: 0 }, birth: birth.id },
      { tape: newTape, native: { client: 2, clock: 1 }, birth: later.id },
      pText[0],
    ];
    const options = {
      nodes: [node(root, null), node(P, root), node(Q, root), node(N, P)],
      parent: (id: NodeId) => (same(id, root) ? null : root),
      tokens,
      owner: () => Q,
      contains: () => false,
      containsBirthContent: (id: NodeId, token: TextToken) =>
        same(id, N) && same(token.tape, newTape),
    };
    const result = fixture([d, created, later], options);
    expect(result.text.map((t) => t.visible)).toEqual([false, false, true]);
    expect(result.text.map((t) => t.deletedDestination)).toEqual([false, false, false]);
    expect(result.nodes.find((n) => same(n.node, N))!.tags).toHaveLength(1);
    expect(
      fixture([d, created, later, control('A', 2n, [d], false)], options).text.every(
        (t) => t.visible,
      ),
    ).toBe(true);
  });

  it('propagates through concurrent birth parents after all children move out, in arbitrary allocation order', () => {
    const d = deletion('A');
    const child = action('B', 1n);
    const N = born('node', child, 0);
    const grandchild = action('B', 2n, [child]);
    const M = born('node', grandchild, 0);
    const createdChild = { ...child, allocations: [node(N, P)] };
    const createdGrandchild = { ...grandchild, allocations: [node(M, N)] };
    const tokens = [{ tape, native: { client: 2, clock: 0 }, birth: grandchild.id }];
    for (const order of permutations([d, createdChild, createdGrandchild])) {
      const result = fixture(order, {
        nodes: [node(M, N), node(root, null), node(N, P), node(P, root)],
        parent: (id) => (same(id, root) ? null : root),
        tokens,
        owner: () => M,
        contains: () => false,
      });
      expect(result.nodes.filter((n) => n.tags.length).map((n) => n.node)).toEqual([M, N, P]);
      expect(result.text[0]).toMatchObject({ visible: false, deletedDestination: true });
    }
  });

  it('does not inherit a permanent tombstone when birth observes the delete undo, even after redo', () => {
    const d = deletion('A');
    const undo = control('A', 2n, [d], false);
    const child = action('B', 1n, [undo]);
    const N = born('node', child, 0);
    const created = { ...child, allocations: [node(N, P)] };
    const redo = control('A', 3n, [d], true, undo, [created]);
    const options = {
      nodes: [node(root, null), node(P, root), node(N, P)],
      parent: (id: NodeId) => (same(id, root) ? null : root),
      tokens: [{ tape: otherTape, native: { client: 2, clock: 0 }, birth: child.id }],
      owner: () => N,
    };
    for (const actions of [
      [d, undo, created],
      [d, undo, created, redo],
    ]) {
      const result = fixture(actions, options);
      expect(result.nodes.find((n) => same(n.node, N))).toMatchObject({
        tags: [],
        deleted: false,
        available: true,
      });
      expect(result.text[0].visible).toBe(true);
    }
  });

  it('covers a causally prior birth only when captured, and respects later moves of observed nodes', () => {
    const child = action('B', 1n);
    const N = born('node', child, 0);
    const created = { ...child, allocations: [node(N, P)] };
    const d = deletion('A', 1n, [created]);
    const options = {
      nodes: [node(root, null), node(P, root), node(N, P)],
      parent: (id: NodeId) => (same(id, root) ? null : root),
      tokens: [],
    };
    expect(fixture([created, d], options).nodes.find((n) => same(n.node, N))!.deleted).toBe(false);
    const captured = { ...d, effects: [subtree(born('deletion', d, 0), P, [P, N], [])] };
    expect(fixture([created, captured], options).nodes.find((n) => same(n.node, N))!.deleted).toBe(
      true,
    );
  });
});

describe('weak suppression of undone births', () => {
  function createdNode() {
    const birth = action('A', 1n);
    const W = born('node', birth, 0);
    const created = { ...birth, allocations: [node(W, root)] };
    return { W, created, undo: control('A', 2n, [created], false) };
  }

  it('suppresses an unused undone birth but retains its allocation', () => {
    const { W, created, undo } = createdNode();
    const nodes = [node(root, null), node(W, root)];
    const result = fixture([created, undo], { nodes, tokens: [] });
    expect(result.nodes[1]).toMatchObject({ suppressed: true, scaffold: false, available: false });
    expect(created.allocations[0]).toBeDefined();
    expect(
      fixture([created, undo, control('A', 3n, [created], true, undo)], { nodes, tokens: [] })
        .nodes[1].available,
    ).toBe(true);
  });

  it('retains an undone wrapper for surviving independent children and removes the scaffold after their undo', () => {
    const { W, created, undo } = createdNode();
    const peer = action('B', 1n, [created]);
    const N = born('node', peer, 0);
    const child = { ...peer, allocations: [node(N, W)] };
    const nodes = [node(root, null), node(W, root), node(N, W)];
    const result = fixture([created, child, undo], { nodes, tokens: [] });
    expect(result.nodes[1]).toMatchObject({ scaffold: true, available: true });
    expect(result.nodes[2].available).toBe(true);
    const childUndo = control('B', 2n, [child], false);
    expect(
      fixture([created, child, undo, childUndo], { nodes, tokens: [] })
        .nodes.slice(1)
        .every((n) => n.suppressed),
    ).toBe(true);
  });

  it('retains independent visible content but not inactive or explicitly deleted content', () => {
    const { W, created, undo } = createdNode();
    const peer = action('B', 1n, [created]);
    const token = { tape, native: { client: 2, clock: 0 }, birth: peer.id };
    const options = { nodes: [node(root, null), node(W, root)], tokens: [token], owner: () => W };
    expect(fixture([created, peer, undo], options).nodes[1].scaffold).toBe(true);
    expect(
      fixture([created, peer, undo, control('B', 2n, [peer], false)], options).nodes[1].suppressed,
    ).toBe(true);
    const d = action(
      'C',
      1n,
      [peer],
      [
        {
          type: 'DeleteText',
          tag: genesis('deletion', 12),
          observed: [{ ...exact(0), client: 2 }],
        },
      ],
    );
    expect(fixture([created, peer, undo, d], options).nodes[1].suppressed).toBe(true);
  });

  it('keeps an independent effective placement, but ignores inactive placement and obsolete anchors', () => {
    const { W, created, undo } = createdNode();
    const peer = action('B', 1n, [created], [properties]);
    const ref: EffectRef = { action: peer.id, ordinal: 0 };
    const options = {
      nodes: [node(root, null), node(W, root)],
      tokens: [],
      requirements: (id: NodeId) => (same(id, W) ? [ref] : []),
    };
    expect(fixture([created, peer, undo], options).nodes[1].scaffold).toBe(true);
    expect(
      fixture([created, peer, undo, control('B', 2n, [peer], false)], options).nodes[1].suppressed,
    ).toBe(true);
    expect(
      fixture([created, peer, undo], { ...options, requirements: () => [] }).nodes[1].suppressed,
    ).toBe(true);
  });

  it('never weakens explicit deletion to save an undone scaffold or its active child', () => {
    const { W, created, undo } = createdNode();
    const peer = action('B', 1n, [created]);
    const N = born('node', peer, 0);
    const child = { ...peer, allocations: [node(N, W)] };
    const d = action('C', 1n, [created], [subtree(genesis('deletion', 12), W, [W], [])]);
    const result = fixture([created, child, undo, d], {
      nodes: [node(root, null), node(W, root), node(N, W)],
      tokens: [{ tape, native: { client: 2, clock: 0 }, birth: child.id }],
      owner: () => N,
    });
    expect(result.nodes.slice(1).every((n) => n.deleted && !n.available && !n.scaffold)).toBe(true);
    expect(result.text[0].visible).toBe(false);
  });
});

it('requires a cycle-free retained layout and known coverage/owners', () => {
  expect(() => fixture([], { parent: () => P })).toThrow('cycle');
  expect(() => fixture([], { owner: () => genesis('node', 99) })).toThrow('unknown node');
  expect(() => fixture([deletion('A')], { nodes: [node(root, null)] })).toThrow('unknown node');
});

it('does not mutate envelopes, node allocations, tokens or raw placement', () => {
  const d = deletion('A');
  const nodes = [node(root, null), node(P, root), node(Q, root)];
  const before = structuredClone({ actions: [d], nodes, tokens: pText });
  const parent = (id: NodeId) => (same(id, root) ? null : root);
  fixture([d], { nodes, parent });
  expect({ actions: [d], nodes, tokens: pText }).toEqual(before);
  expect(nodes.map((n) => parent(n.id))).toEqual([null, root, root]);
});

it('filters real Yjs native IDs without deleting, restoring or copying native characters', () => {
  const seed = new Y.Doc({ gc: false });
  const aCache = new Y.Doc({ gc: false });
  const bCache = new Y.Doc({ gc: false });
  const reload = new Y.Doc({ gc: false });
  seed.clientID = 10;
  aCache.clientID = 11;
  bCache.clientID = 12;
  try {
    const text = seed.getText('tape');
    text.insertEmbed(0, { boundary: 'start' });
    text.insert(1, 'abcdef');
    text.insertEmbed(7, { boundary: 'end' });
    const genesisUpdate = Y.encodeStateAsUpdate(seed);
    for (const doc of [aCache, bCache, reload]) Y.applyUpdate(doc, genesisUpdate);
    const originalC = Y.createRelativePositionFromTypeIndex(text, 3).item!;
    const selected = { tape, client: originalC.client, clock: originalC.clock, length: 1 };
    const a = action('A', 1n);
    const aDelete = {
      ...a,
      effects: [{ type: 'DeleteText', tag: born('deletion', a, 0), observed: [selected] } as const],
    };

    const updates: Uint8Array[] = [];
    bCache.on('update', (update: Uint8Array) => updates.push(update));
    bCache.getText('tape').insert(3, 'x'); // Unseen by A, before the selected c.
    expect(updates).toHaveLength(1);
    const xId = Y.createRelativePositionFromTypeIndex(bCache.getText('tape'), 3).item!;
    const bInsert = action(
      'B',
      1n,
      [],
      [{ type: 'InsertText', ranges: [{ tape, ...xId, length: 1 }] }],
      {
        nativeInsertUpdates: updates,
        nativeManifest: [{ type: 'text', tape, native: { ...xId, length: 1 }, text: 'x' }],
      },
    );
    const b = action('B', 2n, [bInsert]);
    const bDelete = {
      ...b,
      effects: [{ type: 'DeleteText', tag: born('deletion', b, 0), observed: [selected] } as const],
    };
    for (const doc of [aCache, reload]) {
      Y.applyUpdate(doc, updates[0]);
      Y.applyUpdate(doc, updates[0]); // Native body delivery is idempotent.
    }
    const aUndo = control('A', 2n, [aDelete], false);
    const bUndo = control('B', 3n, [bDelete], false);
    const aRedo = control('A', 3n, [aDelete], true, aUndo);
    const stages = [
      { actions: [aDelete, bInsert, bDelete], visible: 'abxdef' },
      { actions: [aDelete, bInsert, bDelete, aUndo], visible: 'abxdef' },
      { actions: [aDelete, bInsert, bDelete, aUndo, bUndo], visible: 'abxcdef' },
      { actions: [aDelete, bInsert, bDelete, aUndo, bUndo, aRedo], visible: 'abxdef' },
    ];
    for (const doc of [aCache, bCache, reload]) {
      const nativeText = doc.getText('tape');
      const nativeIds = Array.from(
        { length: 7 },
        (_, i) => Y.createRelativePositionFromTypeIndex(nativeText, i + 1).item!,
      );
      const tokens = nativeIds.map((native): TextToken => ({
        tape,
        native,
        birth: native.client === 12 ? bInsert.id : null,
      }));
      for (const stage of stages)
        for (const order of [stage.actions, [...stage.actions].reverse()]) {
          const result = fixture(order, { tokens });
          expect(
            result.text
              .filter((entry) => entry.visible)
              .map(
                (entry) =>
                  nativeText.toString()[nativeIds.findIndex((id) => same(id, entry.token.native))],
              )
              .join(''),
          ).toBe(stage.visible);
          expect(nativeText.toString()).toBe('abxcdef');
          expect(nativeText.length).toBe(9); // Two boundary embeds remain addressable.
          expect(result.text.filter((entry) => same(entry.token.native, originalC))).toHaveLength(
            1,
          );
          expect(
            result.text.find((entry) => same(entry.token.native, originalC))!.token.native,
          ).toEqual(originalC);
        }
      const subtreeResult = fixture([deletion('A'), bInsert], {
        tokens,
        owner: () => Q, // Covered lineage was transferred; destination is live.
        contains: (_range, token) => {
          const index = nativeIds.findIndex((id) => same(id, token.native)) + 1;
          return index > 0 && index < nativeText.length - 1;
        },
      });
      expect(subtreeResult.text.every((entry) => !entry.visible && !entry.deletedDestination)).toBe(
        true,
      );
    }
    const stateVector = Y.encodeStateVector(aCache);
    expect(Y.encodeStateVector(bCache)).toEqual(stateVector);
    expect(Y.encodeStateVector(reload)).toEqual(stateVector);
    // A fresh native cache reconstructs the same IDs from retained insertion bodies.
    const fresh = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(fresh, Y.encodeStateAsUpdate(reload));
      expect(Y.createRelativePositionFromTypeIndex(fresh.getText('tape'), 4).item).toEqual(
        originalC,
      );
      expect(fresh.getText('tape').toString()).toBe('abxcdef');
    } finally {
      fresh.destroy();
    }
  } finally {
    for (const doc of [seed, aCache, bCache, reload]) doc.destroy();
  }
});

it('matches the union-of-active-tags oracle for overlapping deletes in all retraction states and input permutations', () => {
  const spans = [
    [0, 3],
    [2, 3],
    [1, 3],
  ] as const;
  const deletes = (['A', 'B', 'C'] as const).map((actor, i) => {
    const a = action(actor, 1n);
    return {
      ...a,
      effects: [
        {
          type: 'DeleteText',
          tag: born('deletion', a, 0),
          observed: [exact(spans[i][0], spans[i][1])],
        } as const,
      ],
    };
  });
  for (let bits = 0; bits < 8; bits++) {
    const controls = deletes.flatMap((d, i) =>
      bits & (1 << i) ? [control((['A', 'B', 'C'] as const)[i], 2n, [d], false)] : [],
    );
    const expected = pText.map(
      (_, clock) =>
        !spans.some(
          ([start, length], i) => !(bits & (1 << i)) && clock >= start && clock < start + length,
        ),
    );
    for (const order of permutations([...deletes, ...controls])) {
      const result = fixture(order);
      expect(result.text.map((entry) => entry.visible)).toEqual(expected);
      expect(result.text.map((entry) => entry.token)).toEqual(pText);
    }
  }
});

it('does not retract unrelated insertion visibility when an active structural intention loses', () => {
  const a = action(
    'A',
    1n,
    [],
    [
      {
        type: 'MoveBlock',
        node: P,
        occurrence: genesis('occurrence', 30),
        slot: { parent: Q, predecessor: null },
        standaloneFlow: genesis('flow', 31),
      },
      { type: 'InsertText', ranges: [{ tape, client: 2, clock: 0, length: 1 }] },
    ],
  );
  const inserted = { tape, native: { client: 2, clock: 0 }, birth: a.id };
  // MW-03 rejected the unsafe placement; its absence from requirements does not
  // deactivate the action's independently valid native insertion.
  const result = fixture([a], { tokens: [inserted], requirements: () => [] });
  expect(result.text[0].visible).toBe(true);
});
