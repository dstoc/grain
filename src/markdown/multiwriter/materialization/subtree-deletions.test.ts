import { expect, test } from 'vitest';
import { action, resource, A, B, C } from '../actions/test-fixtures.js';
import type { ActionEnvelope, NodeId, RangeRef, SemanticEffect } from '../contracts.js';
import { reduceActivity } from '../visibility/activity.js';
import { reduceVisibility } from '../visibility/visibility.js';
import type { VisibilityNode, TextToken, VisibilityLayout } from '../visibility/visibility.js';
import { resourceKey } from '../layout/index.js';
import { captureDiagnostics } from '../diagnostics.js';
import { SubtreeDeletions } from './subtree-deletions.js';

const root = resource('node', 0),
  p = resource('node', 1),
  q = resource('node', 2);
const tape = resource('tape', 0),
  inheritedTape = resource('tape', 1);
const range: RangeRef = { tape, start: resource('marker', 0), end: resource('marker', 4) };
const inherited: RangeRef = { ...range, tape: inheritedTape };
const node = (id: NodeId, parent: NodeId | null): VisibilityNode => ({
  type: 'node',
  id,
  role: parent ? 'inline' : 'root',
  flow: null,
  birthSlot: parent ? { parent, predecessor: null } : null,
});
const contains: VisibilityLayout['contains'] = (interval, token) =>
  resourceKey(interval.tape) === resourceKey(token.tape) &&
  interval.start.ordinal < token.native.clock &&
  token.native.clock < interval.end.ordinal;
const tokens: TextToken[] = [tape, inheritedTape].flatMap((tape) =>
  [1, 2, 3].map((clock) => ({ tape, native: { client: 1, clock }, birth: null })),
);
const birth = action(A),
  child = resource('node', 0, birth.id),
  grandchild = resource('node', 1, birth.id);
const nodes = [
  node(root, null),
  node(p, root),
  node(q, root),
  node(child, p),
  node(grandchild, child),
];
const content = nodes.map((n) => ({
  node: n.id,
  intervals: resourceKey(n.id) === resourceKey(child) ? [inherited] : [],
}));
function deletion(
  a: ActionEnvelope,
  target = p,
  intervals: readonly RangeRef[] = [range],
  tag = resource('deletion', 0, a.id),
): ActionEnvelope {
  return {
    ...a,
    effects: [
      {
        type: 'DeleteSubtree',
        tag,
        scope: {
          target,
          observedNodes: [target],
          ownedIntervals: intervals,
          joinedFlows: [],
          heads: a.dependencies,
        },
      },
    ],
  };
}
function control(target: ActionEnvelope, active: boolean): ActionEnvelope {
  const a = action(target.id.actor, target.id.sequence + 1n, [target]);
  return {
    ...a,
    groupId: { ...target.groupId, sequence: 100n },
    effects: [
      {
        type: 'SetGroupActive',
        group: target.groupId,
        actions: [target.id],
        active,
        previousControl: null,
      },
    ],
  };
}
function check(
  index: SubtreeDeletions,
  actions: readonly ActionEnvelope[],
  allocations = nodes,
  coverage = content,
  textTokens = tokens,
) {
  const activity = reduceActivity(actions);
  const layout: VisibilityLayout = {
    nodes: allocations,
    parent: (id) =>
      allocations.find((n) => resourceKey(n.id) === resourceKey(id))!.birthSlot?.parent ?? null,
    owner: () => q,
    requirements: () => [],
    contains,
    containsBirthContent: (node, token) =>
      coverage
        .find((c) => resourceKey(c.node) === resourceKey(node))!
        .intervals.some((range) => contains(range, token)),
  };
  const full = reduceVisibility(activity, layout, textTokens);
  for (const entry of full.nodes) expect(index.nodeTags(entry.node)).toEqual(entry.tags);
  for (const entry of full.text)
    expect(index.matches(entry.token, contains).map((d) => d.tag)).toEqual(entry.tags);
}

test('captured and inherited tag groups match the independent reducer through control, withdrawal and reactivation', () => {
  const first = deletion(action(B)),
    tag = first.effects[0].type === 'DeleteSubtree' ? first.effects[0].tag : null;
  if (!tag) throw new Error('Expected deletion');
  const second = deletion(
    { ...action(B, 2n, [first]), groupId: { ...first.groupId, sequence: 2n } },
    q,
    [],
    tag,
  );
  const initial = [birth, first, second],
    activity = reduceActivity(initial);
  let index = SubtreeDeletions.create(initial, nodes, content, activity);
  check(index, initial);
  // Last active reused-tag declaration has no inherited children. Its predecessor
  // still tags the child node, but must not tag the child's original text.
  expect(index.nodeTags(child)).toEqual([tag]);
  expect(index.matches(tokens[3], contains)).toEqual([]);
  const held = index,
    off = control(second, false),
    disabled = [...initial, off];
  index = index.update([second], [], [], reduceActivity(disabled)).index;
  check(index, disabled);
  expect(index.matches(tokens[3], contains).map((d) => d.tag)).toEqual([tag]);
  expect(held.matches(tokens[3], contains)).toEqual([]);
  const removed = index.update([], [], [], reduceActivity([birth, first]), [
    { action: second.id, ordinal: 0 },
  ]);
  check(removed.index, [birth, first]);
  index = removed.index.update([second], [], [], activity).index;
  check(index, initial);
});

test('new concurrent descendant coverage uses birth parents, including dormant declarations and same-batch grandchildren', () => {
  const d = deletion(action(B)),
    initialNodes = nodes.slice(0, 3),
    initialContent = content.slice(0, 3);
  let index = SubtreeDeletions.create([d], initialNodes, initialContent, reduceActivity([d]));
  const off = control(d, false);
  index = index.update([d], [], [], reduceActivity([d, off])).index;
  const added = index.update([], nodes.slice(3), content.slice(3), reduceActivity([birth, d, off]));
  check(added.index, [birth, d, off]);
  const restored = added.index.update([d], [], [], reduceActivity([birth, d]));
  check(restored.index, [birth, d]);
  expect(restored.index.nodeTags(grandchild)).toHaveLength(1);
  // A birth causally after deletion does not inherit its tag.
  const later = action(A, 2n, [d, birth]),
    laterNode = node(resource('node', 0, later.id), p);
  const extendedNodes = [...nodes, laterNode],
    extendedContent = [...content, { node: laterNode.id, intervals: [range] }];
  const extended = restored.index.update(
    [],
    [laterNode],
    [extendedContent.at(-1)!],
    reduceActivity([birth, d, later]),
  );
  check(extended.index, [birth, d, later], extendedNodes, extendedContent);
  expect(extended.index.nodeTags(laterNode.id)).toEqual([]);
});

test('earlier arrivals retain first-covering declaration order and inspect only affected groups', () => {
  const early = deletion(action(C), p, [{ ...range, start: resource('marker', 2) }]);
  const lateBase = action(B),
    secondTag = resource('deletion', 0, lateBase.id);
  const late = {
    ...lateBase,
    effects: [
      {
        type: 'DeleteSubtree',
        tag: secondTag,
        scope: {
          target: q,
          observedNodes: [],
          ownedIntervals: [range],
          joinedFlows: [],
          heads: [],
        },
      },
      ...early.effects,
    ] as SemanticEffect[],
  };
  const initial = [birth, late];
  const index = SubtreeDeletions.create(initial, nodes, content, reduceActivity(initial));
  const { value, report } = captureDiagnostics(() =>
    index.update([early], [], [], reduceActivity([birth, early, late])),
  );
  check(value.index, [birth, early, late]);
  expect(report.work['driver/subtree.fullIndexesConstructed'] ?? 0).toBe(0);
  expect(report.work['driver/subtree.tagGroupsUpdated']).toBe(1);
});

for (const size of [8, 32, 128])
  test(`birth append charges ${size} retained siblings in its changed parent`, () => {
    const siblings = Array.from({ length: size }, (_, i) => node(resource('node', 100 + i), root)),
      allocations = [node(root, null), ...siblings],
      coverage = allocations.map((n) => ({ node: n.id, intervals: [] })),
      index = SubtreeDeletions.create([], allocations, coverage, reduceActivity([])),
      addition = node(child, root);
    const { value, report } = captureDiagnostics(() =>
      index.update([birth], [addition], [{ node: child, intervals: [] }], reduceActivity([birth])),
    );
    expect(report.work['driver/subtree.birthsIndexed']).toBe(1);
    expect(report.work['driver/subtree.birthSiblingEntriesCopied']).toBe(size);
    expect(report.work['driver/subtree.birthEdgesVisited'] ?? 0).toBe(0);
    // The copy is real changed-parent work; it neither mutates the held graph
    // nor changes the captured/inherited semantics of a subsequent deletion.
    const d = deletion(action(B), root, []),
      updatedNodes = [...allocations, addition],
      updatedContent = [...coverage, { node: child, intervals: [] }];
    check(
      value.index.update([d], [], [], reduceActivity([birth, d])).index,
      [birth, d],
      updatedNodes,
      updatedContent,
      [],
    );
    expect(index.nodeTags(child)).toEqual([]);
    for (const sibling of siblings) expect(index.nodeTags(sibling.id)).toEqual([]);
  });
