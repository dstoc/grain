import './resolve-ts.mjs';
import assert from 'node:assert/strict';
const { NativeTapeCache } = await import('../../../src/markdown/multiwriter/text/cache.ts');
const { actorId, compareActions, compareEffects } =
  await import('../../../src/markdown/multiwriter/contracts.ts');
const { LayoutPrefix, resourceKey } =
  await import('../../../src/markdown/multiwriter/layout/index.ts');
const { CellIndex, cellKey } = await import('../../../src/markdown/multiwriter/ownership/cells.ts');
const { cutPosition } = await import('../../../src/markdown/multiwriter/ownership/cohorts.ts');

// Proposal-local ordering model, NOT production ownership or author certification.
// Real independent native bodies feed CellIndex and LayoutPrefix. No cell owners
// or expected block orders are supplied to the ordering model.
const caches = [];
const cache = () => {
  const value = new NativeTapeCache();
  caches.push(value);
  return value;
};
const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};
const publish = (target, key, operations) => {
  const prepared = target.prepare(key, operations);
  prepared.commit();
  return prepared.body;
};
const actor = (number) => actorId(number.toString(16).padStart(32, '0'));
const id = (kind, ordinal, birth) => ({ kind, ordinal, birth });
const same = (a, b) => resourceKey(a) === resourceKey(b);
const permutations = (items) =>
  items.length < 2
    ? [items]
    : items.flatMap((item, i) =>
        permutations(items.filter((_, j) => i !== j)).map((tail) => [item, ...tail]),
      );

function emptyFlow(target, birth, slot, base, key) {
  const node = id('node', base, birth);
  const flow = id('flow', base + 1, birth);
  const run = id('run', base + 2, birth);
  const tape = id('tape', base + 3, birth);
  const start = id('marker', base + 4, birth);
  const end = id('marker', base + 5, birth);
  const occurrence = id('occurrence', base + 6, birth);
  const range = { tape, start, end };
  const body = publish(target, key, [{ type: 'createTape', ...range }]);
  return {
    node,
    flow,
    run,
    range,
    occurrence,
    body,
    allocations: [
      { type: 'node', id: node, role: 'inline', flow, birthSlot: slot },
      { type: 'flow', id: flow, home: node },
      { type: 'run', id: run, flow, skeleton: [range] },
      ...body.allocations,
      { type: 'occurrence', id: occurrence, slot },
    ],
  };
}

function split(
  target,
  root,
  source,
  actorNumber,
  sequence,
  predecessor,
  retainedSide,
  key,
  dependencies = [],
) {
  const aid = { actor: actor(actorNumber), sequence: BigInt(sequence) };
  const slot = { parent: root, predecessor };
  const created = emptyFlow(target, { type: 'action', action: aid }, slot, 0, key);
  const effect = {
    type: 'SplitFlow',
    basis: { ranges: [] },
    cut: { run: source.run, boundary: source.range.end, side: 'left', predecessor: null },
    retainedSide,
    newNode: created.node,
    newFlow: created.flow,
    newRun: created.run,
    occurrence: created.occurrence,
    outerSlot: slot,
  };
  const action = {
    id: aid,
    lamport: BigInt(sequence),
    dependencies,
    allocations: created.allocations,
    effects: [effect],
  };
  return {
    key,
    created,
    effect,
    order: { action, ordinal: 0 },
    input: { action, births: [{ node: created.node, occurrence: created.occurrence }] },
  };
}

// This is the proposed disjoint key/ranking rule. Runtime cohorts.ts remains
// unchanged and still rejects empty bases. Native order is compared ONLY within
// one domain. MW-03 ranks units against one another; no global tape sort exists.
function proposedBuckets(births, layout, index) {
  const groups = new Map();
  for (const birth of births) {
    const { effect } = birth;
    if (!same(layout.blockPlacement(effect.newNode).occurrence, effect.occurrence)) continue;
    const gap = [
      resourceKey(effect.outerSlot.parent),
      effect.outerSlot.predecessor && resourceKey(effect.outerSlot.predecessor),
    ];
    let key, position;
    if (effect.basis.ranges.length) {
      key = [
        'content',
        effect.basis.ranges.map(({ range, occurrence }) => [
          cellKey(range),
          resourceKey(occurrence),
        ]),
        ...gap,
      ];
      position = cutPosition(effect, index);
    } else {
      const run = layout.runLayout(effect.cut.run);
      const home = run.skeleton.at(-1);
      assert(home);
      assert.deepEqual(home.tape.birth, effect.cut.run.birth);
      const cells = index.tape(home.tape);
      assert(same(cells[0].range.start, home.start));
      assert(same(cells.at(-1).range.end, home.end));
      assert(same(effect.cut.boundary, home.end));
      assert.equal(effect.cut.side, 'left');
      assert.equal(effect.cut.predecessor, null);
      assert.equal(layout.resolveInlineSlot(effect.cut, index).membership, 'available');
      key = ['empty-home', resourceKey(effect.cut.run), ...gap];
      position = index.position(home.tape, effect.cut.boundary);
    }
    const encoded = JSON.stringify(key);
    const group = groups.get(encoded) ?? [];
    group.push({ ...birth, position });
    groups.set(encoded, group);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      roots: group
        .sort((a, b) => a.position - b.position || compareEffects(a.order, b.order))
        .map((birth) => birth.effect.occurrence),
    }));
}

function layoutOf(genesis, actions, inactive = new Set()) {
  const layout = new LayoutPrefix(genesis);
  for (const entry of [...actions].sort((a, b) => compareActions(a.input.action, b.input.action))) {
    layout.beginAction(entry.input);
    layout.step(0, !inactive.has(entry.key));
  }
  return layout;
}

const scenarios = [];
try {
  for (const semanticAFirst of [true, false])
    for (const nativeAFirst of [true, false]) {
      const label = `semantic A${semanticAFirst ? '<' : '>'}B/native A${nativeAFirst ? '<' : '>'}B`;
      const genesisBirth = { type: 'genesis', genesisId: `empty-cohort-${scenarios.length}` };
      const root = id('node', 0, genesisBirth);
      const writer = cache();
      const p = emptyFlow(writer, genesisBirth, { parent: root, predecessor: null }, 1, 'G');
      const genesis = {
        allocations: [
          { type: 'node', id: root, role: 'root', flow: null, birthSlot: null },
          ...p.allocations,
        ],
        births: [{ node: p.node, occurrence: p.occurrence }],
      };
      const nativeAuthors = [cache(), cache()].sort((a, b) => a.clientId - b.clientId);
      assert.notEqual(nativeAuthors[0].clientId, nativeAuthors[1].clientId);
      const [a, b] = nativeAFirst ? nativeAuthors : nativeAuthors.toReversed();
      const actorA = semanticAFirst ? 1 : 2;
      const actorB = semanticAFirst ? 2 : 1;
      a.apply('G', p.body);
      b.apply('G', p.body);
      const a1 = split(a, root, p, actorA, 1, p.occurrence, 'left', 'A1');
      const b1 = split(b, root, p, actorB, 1, p.occurrence, 'left', 'B1');
      const a2 = split(a, root, a1.created, actorA, 2, p.occurrence, 'right', 'A2', [
        a1.input.action.id,
      ]);
      const b2 = split(b, root, b1.created, actorB, 2, p.occurrence, 'right', 'B2', [
        b1.input.action.id,
      ]);
      const actions = [a1, b1, a2, b2];
      const flows = [p, ...actions.map((entry) => entry.created)];
      const names = new Map(
        flows.map((flow, i) => [resourceKey(flow.node), ['P', 'SA', 'SB', 'TA', 'TB'][i]]),
      );
      const orderOf = (
        peer,
        included = actions,
        inactive = new Set(),
        buckets = proposedBuckets,
      ) => {
        const layout = layoutOf(genesis, included, inactive);
        const tapes = [p, ...included.map((entry) => entry.created)];
        const index = new CellIndex(tapes.map((flow) => peer.snapshot(flow.range.tape)));
        return layout
          .children(
            root,
            buckets(
              included.filter((entry) => !inactive.has(entry.key)),
              layout,
              index,
            ),
          )
          .map((node) => names.get(resourceKey(node)));
      };
      check(`${label}: independent common-genesis native and semantic orders`, () => {
        assert.equal(a.clientId < b.clientId, nativeAFirst);
        assert.equal(compareEffects(a1.order, b1.order) < 0, semanticAFirst);
        assert.deepEqual(a1.effect.cut, b1.effect.cut);
        assert.notDeepEqual(a2.effect.cut.run, b2.effect.cut.run);
      });
      check(`${label}: isolated start-right/end-left preserve full author order`, () => {
        assert.deepEqual(orderOf(a, [a1]), ['P', 'SA']);
        assert.deepEqual(orderOf(a, [a1, a2]), ['P', 'TA', 'SA']);
        assert.deepEqual(orderOf(b, [b1, b2]), ['P', 'TB', 'SB']);
        assert.deepEqual(a.snapshot(p.range.tape), b.snapshot(p.range.tape));
      });
      const readyOrders = permutations(actions).filter(
        (order) => order.indexOf(a1) < order.indexOf(a2) && order.indexOf(b1) < order.indexOf(b2),
      );
      assert.equal(readyOrders.length, 6);
      let expectedSnapshots;
      for (const delivery of readyOrders) {
        const peer = cache();
        peer.apply('G', p.body);
        for (const entry of delivery) peer.apply(entry.key, entry.created.body);
        const snapshots = flows.map((flow) => peer.snapshot(flow.range.tape));
        expectedSnapshots ??= snapshots;
        const expected = semanticAFirst
          ? ['P', 'TB', 'TA', 'SA', 'SB']
          : ['P', 'TA', 'TB', 'SB', 'SA'];
        check(
          `${label}: ${delivery.map((entry) => entry.key).join('/')} complete order and reconstruction`,
          () => {
            assert.deepEqual(snapshots, expectedSnapshots);
            assert.deepEqual(orderOf(peer, delivery), expected);
            assert.deepEqual(
              orderOf(peer, [a1, b1]),
              semanticAFirst ? ['P', 'SA', 'SB'] : ['P', 'SB', 'SA'],
            );
            for (const field of ['node', 'flow', 'run', 'occurrence'])
              assert.equal(new Set(flows.map((flow) => resourceKey(flow[field]))).size, 5);
            assert.equal(new Set(flows.map((flow) => resourceKey(flow.range.tape))).size, 5);
            const index = new CellIndex(snapshots);
            const layout = layoutOf(genesis, actions);
            const buckets = proposedBuckets(actions, layout, index);
            assert.equal(buckets.length, 1);
            assert.deepEqual(
              buckets[0].roots,
              (semanticAFirst ? [a1, b1] : [b1, a1]).map((entry) => entry.effect.occurrence),
            );
            const futureSlots = [];
            for (const flow of flows) {
              const snapshot = peer.snapshot(flow.range.tape);
              assert.equal(snapshot.parts.length, 2);
              assert.equal(index.range(flow.range).length, 1);
              assert.deepEqual(layout.runLayout(flow.run).skeleton, [flow.range]);
              const slot = {
                run: flow.run,
                boundary: flow.range.end,
                side: 'left',
                predecessor: null,
              };
              assert.equal(layout.resolveInlineSlot(slot, index).membership, 'available');
              futureSlots.push(
                JSON.stringify(slot, (_key, value) =>
                  typeof value === 'bigint' ? value.toString() : value,
                ),
              );
            }
            assert.equal(new Set(futureSlots).size, 5);
          },
        );
        check(
          `${label}: ${delivery.map((entry) => entry.key).join('/')} retraction/reactivation changes no native facts`,
          () => {
            const retracted = semanticAFirst
              ? ['P', 'TB', 'TA', 'SB', 'SA']
              : ['P', 'TA', 'TB', 'SA', 'SB'];
            assert.deepEqual(orderOf(peer, actions, new Set(['A1'])), retracted);
            assert.deepEqual(orderOf(peer), expected);
            // Every activity combination is a fresh replay over the same retained
            // births. Inactive allocations remain raw anchors, not visible headers.
            for (let mask = 0; mask < 16; mask++) {
              const inactive = new Set(
                actions.filter((_, i) => mask & (1 << i)).map((entry) => entry.key),
              );
              const ordinary = semanticAFirst
                ? ['P', 'TB', 'TA', 'SB', 'SA']
                : ['P', 'TA', 'TB', 'SA', 'SB'];
              assert.deepEqual(orderOf(peer, actions, inactive), mask & 3 ? ordinary : expected);
            }
            for (const entry of delivery) peer.apply(entry.key, entry.created.body);
            assert.deepEqual(orderOf(peer, delivery.toReversed()), expected);
            assert.deepEqual(
              flows.map((flow) => peer.snapshot(flow.range.tape)),
              snapshots,
            );
          },
        );
      }
      // The original review key produces one cross-tape cohort. Guard the exact
      // bug independently from the proposed grouping's successful observations.
      check(`${label}: regression has four colliding old keys but three source domains`, () => {
        assert(actions.every((entry) => entry.effect.basis.ranges.length === 0));
        const oldKeys = actions.map(({ effect }) =>
          JSON.stringify([
            effect.basis.ranges,
            resourceKey(effect.outerSlot.parent),
            resourceKey(effect.outerSlot.predecessor),
          ]),
        );
        assert.equal(new Set(oldKeys).size, 1);
        assert.equal(new Set(actions.map((entry) => resourceKey(entry.effect.cut.run))).size, 3);
      });
      const refined = cache();
      refined.apply('G', p.body);
      actions.forEach((entry) => refined.apply(entry.key, entry.created.body));
      const beforeRefinement = orderOf(refined);
      const typingBirth = { type: 'action', action: { actor: actor(9), sequence: 1n } };
      const bracketStart = id('marker', 0, typingBirth);
      const bracketEnd = id('marker', 1, typingBirth);
      const typedBody = publish(refined, 'T', [
        { type: 'marker', tape: p.range.tape, index: 1, marker: bracketStart, affinity: 'left' },
        { type: 'text', tape: p.range.tape, index: 2, text: '😀' },
        { type: 'marker', tape: p.range.tape, index: 4, marker: bracketEnd, affinity: 'right' },
      ]);
      check(
        `${label}: later native home text does not reclassify the authored empty domain`,
        () => {
          assert.deepEqual(orderOf(refined), beforeRefinement);
          const peer = cache();
          peer.apply('G', p.body);
          actions.forEach((entry) => peer.apply(entry.key, entry.created.body));
          peer.apply('T', typedBody);
          assert.deepEqual(orderOf(peer), beforeRefinement);
          assert.deepEqual(peer.snapshot(p.range.tape), refined.snapshot(p.range.tape));
          assert.equal(new CellIndex([peer.snapshot(p.range.tape)]).tape(p.range.tape).length, 3);
        },
      );
      // Same-source concurrent START splits use the same reusable trailing home
      // slot but put their new nodes before P. Test each native order explicitly.
      const startAuthors = [cache(), cache()].sort((x, y) => x.clientId - y.clientId);
      const [startA, startB] = nativeAFirst ? startAuthors : startAuthors.toReversed();
      assert.notEqual(startA.clientId, startB.clientId);
      startA.apply('G', p.body);
      startB.apply('G', p.body);
      const sa = split(startA, root, p, semanticAFirst ? 11 : 12, 1, null, 'right', 'startA');
      const sb = split(startB, root, p, semanticAFirst ? 12 : 11, 1, null, 'right', 'startB');
      for (const delivery of [
        [sa, sb],
        [sb, sa],
      ]) {
        check(
          `${label}: ${delivery.map((entry) => entry.key).join('/')} same-source start-right cohort`,
          () => {
            const peer = cache();
            peer.apply('G', p.body);
            delivery.forEach((entry) => peer.apply(entry.key, entry.created.body));
            const layout = layoutOf(genesis, delivery);
            const index = new CellIndex(
              [p, sa.created, sb.created].map((flow) => peer.snapshot(flow.range.tape)),
            );
            const expected = (semanticAFirst ? [sa, sb] : [sb, sa]).map(
              (entry) => entry.created.node,
            );
            assert.deepEqual(layout.children(root, proposedBuckets(delivery, layout, index)), [
              ...expected,
              p.node,
            ]);
            assert.deepEqual(sa.effect.cut, sb.effect.cut);
            assert.equal(startA.clientId < startB.clientId, nativeAFirst);
            assert.deepEqual(peer.snapshot(p.range.tape), writer.snapshot(p.range.tape));
          },
        );
      }
      scenarios.push({
        label,
        clients: { A: a.clientId, B: b.clientId },
        genesis,
        inputs: actions.map((entry) => entry.input),
        nativeBodies: {
          G: p.body,
          ...Object.fromEntries(actions.map((entry) => [entry.key, entry.created.body])),
        },
        laterTypingBody: typedBody,
        concurrentStart: {
          inputs: [sa.input, sb.input],
          bodies: [sa.created.body, sb.created.body],
          clients: [startA.clientId, startB.clientId],
        },
        completeRawOrder: semanticAFirst
          ? ['P', 'TB', 'TA', 'SA', 'SB']
          : ['P', 'TA', 'TB', 'SB', 'SA'],
      });
    }

  // Ordinary repeated Enter follows the newly created empty flow, rather than
  // allocating new cut markers or changing the original home's cut identity.
  for (const retainedSide of ['left', 'right']) {
    const writer = cache();
    const birth = { type: 'genesis', genesisId: `repeated-${retainedSide}` };
    const root = id('node', 0, birth);
    const p = emptyFlow(writer, birth, { parent: root, predecessor: null }, 1, 'G');
    const genesis = {
      allocations: [
        { type: 'node', id: root, role: 'root', flow: null, birthSlot: null },
        ...p.allocations,
      ],
      births: [{ node: p.node, occurrence: p.occurrence }],
    };
    let source = p;
    const actions = [];
    for (let i = 1; i <= 3; i++) {
      const predecessor = retainedSide === 'left' ? source.occurrence : null;
      const next = split(
        writer,
        root,
        source,
        3,
        i,
        predecessor,
        retainedSide,
        `E${i}`,
        actions.length ? [actions.at(-1).input.action.id] : [],
      );
      actions.push(next);
      source = next.created;
    }
    const flows = [p, ...actions.map((entry) => entry.created)];
    const expected = retainedSide === 'left' ? flows : flows.toReversed();
    check(
      `repeated ${retainedSide}: three distinct empty splits reconstruct with exact block/slot IDs`,
      () => {
        const peer = cache();
        peer.apply('G', p.body);
        actions.forEach((entry) => peer.apply(entry.key, entry.created.body));
        const snapshots = flows.map((flow) => peer.snapshot(flow.range.tape));
        const index = new CellIndex(snapshots);
        const layout = layoutOf(genesis, actions);
        assert.deepEqual(
          layout.children(root, proposedBuckets(actions, layout, index)),
          expected.map((flow) => flow.node),
        );
        assert.deepEqual(
          snapshots,
          flows.map((flow) => writer.snapshot(flow.range.tape)),
        );
        assert(actions.every((entry) => entry.created.body.nativeManifest.length === 2));
        assert.equal(new Set(actions.map((entry) => resourceKey(entry.effect.cut.run))).size, 3);
      },
    );
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        scope:
          'real native encoding and LayoutPrefix with proposal-local cohort model; no ownership, certified authoring, history navigation, visibility or MW-08 proof',
        checks: checks.length,
        passed: checks,
        scenarios,
      },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ),
  );
} finally {
  caches.forEach((value) => value.destroy());
}
