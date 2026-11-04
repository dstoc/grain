import { afterEach, expect, test } from 'vitest';
import type { ActionEnvelope, RangeRef } from './contracts.js';
import { ActionStore } from './actions/store.js';
import { encodeEnvelope } from './actions/codec.js';
import { createIngestValidator } from './ingest/validator.js';
import { IngestPublication } from './ingest/publication.js';
import type { NativeView } from './ingest/publication.js';
import type { BirthPlacement, LayoutGenesis } from './layout/index.js';
import { resourceKey } from './layout/index.js';
import { sameSlot } from './layout/occurrences.js';
import { reduceOwnership } from './ownership/index.js';
import { NativeFixture } from './ownership/test-fixtures.js';
import {
  createProjectionAuthorValidator,
  projectMarkdown,
  serializeProjection,
} from './projection/index.js';
import type { BirthContent } from './projection/index.js';
import type { NativeBody } from './text/cache.js';

// A reduced contract-decision witness, NOT the MW-08 ReplicaFactory. NativeFixture
// only prepares envelopes. Receivers use retained allocations, never its birth map.
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const paragraph = (id: string, text: string, parent = 'root') => ({
  id,
  parent,
  role: 'inline' as const,
  flow: `f${id}`,
  run: `r${id}`,
  tape: `t${id}`,
  cells: [...text].map((text, i) => ({ id: `${id}${i}`, text })),
});

/** This witness has one ordinary birth per slot, or an explicit SplitFlow binding.
 * No allocation-order or shared alias convention is needed to recover its bindings.
 */
function births(action: ActionEnvelope): readonly BirthPlacement[] {
  return action.allocations.flatMap((node) => {
    if (node.type !== 'node' || !node.birthSlot) return [];
    const split = action.effects.find(
      (effect) =>
        effect.type === 'SplitFlow' && resourceKey(effect.newNode) === resourceKey(node.id),
    );
    if (split?.type === 'SplitFlow') return [{ node: node.id, occurrence: split.occurrence }];
    const candidates = action.allocations.filter(
      (entry) => entry.type === 'occurrence' && sameSlot(entry.slot, node.birthSlot!),
    );
    if (candidates.length !== 1) throw new Error('Witness requires a unique birth occurrence');
    return [{ node: node.id, occurrence: candidates[0].id as BirthPlacement['occurrence'] }];
  });
}

/** Candidate interpretations only. The prefix parameter is intentionally NOT derived:
 * the witness asks the contract owner which prefix constitutes ordinary construction.
 */
function coverage(
  genesis: LayoutGenesis,
  actions: readonly ActionEnvelope[],
  native: NativeView,
  prefix: number,
): readonly BirthContent[] {
  const allocating = actions.find((action) => action.allocations.some((a) => a.type === 'node'));
  const allocations = [...genesis.allocations, ...actions.flatMap((a) => a.allocations)];
  return allocations
    .filter((a) => a.type === 'node')
    .map((node) => {
      if (!node.flow) return { node: node.id, intervals: [] };
      if (node.id.birth.type === 'genesis') {
        const root = genesis.allocations.find(
          (a) => a.type === 'run' && resourceKey(a.flow) === resourceKey(node.flow!),
        );
        if (root?.type !== 'run') throw new Error('Missing genesis root run');
        return { node: node.id, intervals: root.skeleton };
      }
      if (!allocating) throw new Error('Missing allocating action');
      // Reconstruct the exact allocating closure, not the merged current owner.
      expect(allocating.dependencies).toEqual([]);
      const authorAllocations = [...genesis.allocations, ...allocating.allocations];
      const ownership = reduceOwnership({
        genesis,
        actions: [{ action: allocating, births: births(allocating) }],
        snapshots: authorAllocations
          .filter((a) => a.type === 'tape')
          .map((a) => native.snapshot(a.id)),
        isActive: ({ ordinal }) => ordinal < prefix,
      });
      const intervals = ownership.assignments.flatMap((assignment): RangeRef[] => {
        const flow = ownership.runLayouts.find(
          (run) => resourceKey(run.run) === resourceKey(assignment.run),
        )!.flow;
        return resourceKey(ownership.flowBlock(flow)) === resourceKey(node.id)
          ? [assignment.cell]
          : [];
      });
      return { node: node.id, intervals };
    });
}

function open(genesis: LayoutGenesis, body: NativeBody, prefix: number) {
  // Each receiver owns cloned inputs and separate store, native caches and validator.
  genesis = structuredClone(genesis);
  body = structuredClone(body);
  const validate = createIngestValidator({
    genesis: body,
    validateAuthor: createProjectionAuthorValidator({ genesis, births }),
  });
  const store = new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: genesis.allocations,
    validate,
  });
  const publication = new IngestPublication(store, body, function* (actions, native) {
    yield;
    return projectMarkdown({
      genesis,
      genesisManifest: body.nativeManifest,
      actions: actions.map((action) => ({ action, births: births(action) })),
      native,
      birthContent: coverage(genesis, actions, native, prefix),
    });
  });
  cleanup.push(() => {
    publication.destroy();
    store.destroy();
    validate.destroy();
  });
  return {
    store,
    publish() {
      const result = publication.refresh();
      if (result.state !== 'complete') throw new Error('Unexpected deferred witness');
      return result.value;
    },
  };
}

function retract(target: ActionEnvelope): ActionEnvelope {
  return {
    ...structuredClone(target),
    id: { ...target.id, sequence: 2n },
    lamport: 2n,
    dependencies: [target.id],
    groupId: { ...target.groupId, sequence: 2n },
    allocations: [],
    nativeManifest: [],
    nativeInsertUpdates: [],
    effects: [
      {
        type: 'SetGroupActive',
        group: target.groupId,
        actions: [target.id],
        active: false,
        previousControl: null,
      },
    ],
  };
}

function witness(split: boolean, visitExtra = false) {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    { id: 'W', parent: 'root', role: 'quote' },
    paragraph('P', 'abc'),
    paragraph('Q', ''),
  ]);
  cleanup.push(() => f.destroy());
  f.author('A1', (f) => {
    const initial = split ? [f.split('P', 'N', 'P0', 'left', 'W', null)] : [];
    if (!split) {
      f.createBlock(paragraph('N', '', 'W'), null);
      initial.push(f.transfer(['P1', 'P2'], 'N:home-end', 'intoN'));
    }
    return [
      ...initial,
      f.transfer(['P1', 'P2'], 'Q:home-end', 'outOfN'),
      ...(visitExtra
        ? [f.transfer(['P0'], 'N:home-end', 'visitN'), f.transfer(['P0'], 'Q:home-end', 'leaveN')]
        : []),
    ];
  });
  f.author('B1', (f) => [f.deleteSubtree('W', [], [])]);
  const genesis = structuredClone(f.genesis);
  const body = { ...f.bodies.get('G')!, allocations: genesis.allocations };
  const a = f.envelope('A1');
  const b = f.envelope('B1');
  // Separate original carrier documents, not replacement encodings of subset facts.
  const senderA = open(genesis, body, 0);
  const senderB = open(genesis, body, 0);
  senderA.store.append(a);
  senderB.store.append(b);
  expect(senderA.store.snapshot().ready).toEqual([a]);
  expect(senderB.store.snapshot().ready).toEqual([b]);
  const updates = [senderA.store.encodeUpdate(), senderB.store.encodeUpdate()];
  const vectorA = senderA.store.encodeStateVector();
  const vectorB = senderB.store.encodeStateVector();
  senderA.store.append(retract(a));
  senderB.store.append(retract(b));
  expect(senderA.store.snapshot().ready).toHaveLength(2);
  expect(senderB.store.snapshot().ready).toHaveLength(2);
  return {
    genesis,
    body,
    a,
    b,
    updates,
    undoA: senderA.store.encodeUpdate(vectorA),
    undoB: senderB.store.encodeUpdate(vectorB),
    n: f.id('N', 'node'),
    aText: f.aliases.get('P0')!,
    text: [f.aliases.get('P1')!, f.aliases.get('P2')!],
  };
}

test.each([false, true])(
  'ordinary create/transfer has observable prefix choices; reverse receipt=%s',
  (reverse) => {
    const w = witness(false);
    const before = encodeEnvelope(w.a);
    const results = [0, 1, 2].map((prefix) => {
      const peer = open(w.genesis, w.body, prefix);
      for (const update of reverse ? w.updates.toReversed() : w.updates)
        peer.store.applyUpdate(update);
      expect(peer.store.snapshot().ready).toEqual([w.a, w.b]);
      const canonical = peer.store.encodeUpdate();
      const p = peer.publish();
      const markdown = serializeProjection(p.value.view);
      // Capture complete canonical bytes; derived prefix choice authors no facts.
      expect(peer.store.encodeUpdate()).toEqual(canonical);
      expect(p.native.lookup(w.text[0]).map((s) => s.range)).toEqual([w.text[0]]);
      expect(p.native.lookup(w.text[1]).map((s) => s.range)).toEqual([w.text[1]]);
      const fresh = open(w.genesis, w.body, prefix);
      fresh.store.applyUpdate(canonical);
      const reconstructed = fresh.publish();
      expect(reconstructed.value.view).toEqual(p.value.view);
      expect(reconstructed.value.ownership.assignments).toEqual(p.value.ownership.assignments);
      expect(reconstructed.value.visibility).toEqual(p.value.visibility);
      expect(fresh.store.encodeUpdate()).toEqual(canonical);
      const n = coverage(w.genesis, [w.a], p.native, prefix).find(
        (entry) => resourceKey(entry.node) === resourceKey(w.n),
      )!;
      const ownsBC = w.text.map((range) =>
        n.intervals.some((interval) =>
          p.value.ownership.contains(interval, {
            tape: range.tape,
            native: { client: range.client, clock: range.clock },
          }),
        ),
      );
      peer.store.applyUpdate(w.undoB);
      expect(peer.store.snapshot().ready).toHaveLength(3);
      // Undo removes only B's deletion, independent of the candidate birth rule.
      expect(peer.publish().value.visibility.text.every((t) => t.visible)).toBe(true);
      peer.store.applyUpdate(w.undoA);
      expect(peer.store.snapshot().ready).toHaveLength(4);
      const retracted = peer.publish();
      expect(retracted.value.visibility.text.every((t) => t.visible)).toBe(true);
      expect(retracted.value.ownership.inlineOwner(w.text[0])).toEqual([
        w.genesis.allocations.find((a) => a.type === 'node' && a.flow !== null)!.id,
      ]);
      expect(retracted.native.lookup(w.text[0]).map((s) => s.range)).toEqual([w.text[0]]);
      const afterUndo = open(w.genesis, w.body, prefix);
      afterUndo.store.applyUpdate(peer.store.encodeUpdate());
      const undoReplay = afterUndo.publish();
      expect(undoReplay.value.view).toEqual(retracted.value.view);
      expect(undoReplay.value.visibility).toEqual(retracted.value.visibility);
      return { markdown, ownsBC, assignments: p.value.ownership.assignments };
    });
    expect(results.map((r) => r.ownsBC)).toEqual([
      [false, false],
      [true, true],
      [false, false],
    ]);
    expect(results.map((r) => r.markdown)).toEqual(['a\n\nbc\n', 'a\n\n<!-- -->\n', 'a\n\nbc\n']);
    expect(results[0].assignments).toEqual(results[1].assignments);
    expect(results[1].assignments).toEqual(results[2].assignments);
    expect(encodeEnvelope(w.a)).toEqual(before);
    expect(w.a.effects.map((e) => e.type)).toEqual(['TransferRange', 'TransferRange']);
    expect(w.a.effects.some((e) => e.type === 'SplitFlow')).toBe(false);
  },
);

test('union of all same-action visits overcovers an explicit split birth', () => {
  const w = witness(true, true);
  const peer = open(w.genesis, w.body, 1);
  for (const update of w.updates) peer.store.applyUpdate(update);
  expect(peer.store.snapshot().ready).toEqual([w.a, w.b]);
  const p = peer.publish();
  const atBirth = coverage(w.genesis, [w.a], p.native, 1).find(
    (entry) => resourceKey(entry.node) === resourceKey(w.n),
  )!;
  const visit = coverage(w.genesis, [w.a], p.native, 3).find(
    (entry) => resourceKey(entry.node) === resourceKey(w.n),
  )!;
  const containsA = (interval: RangeRef) =>
    p.value.ownership.contains(interval, {
      tape: w.aText.tape,
      native: { client: w.aText.client, clock: w.aText.clock },
    });
  expect(atBirth.intervals.some(containsA)).toBe(false);
  expect(visit.intervals.some(containsA)).toBe(true);
  const a = p.value.visibility.text.find(
    (entry) =>
      entry.token.native.client === w.aText.client && entry.token.native.clock === w.aText.clock,
  )!;
  expect(a.visible).toBe(true);
  expect(a.tags).toEqual([]);
  const broad = projectMarkdown({
    genesis: w.genesis,
    genesisManifest: w.body.nativeManifest,
    actions: [w.a, w.b].map((action) => ({ action, births: births(action) })),
    native: p.native,
    birthContent: coverage(w.genesis, [w.a, w.b], p.native, 1).map((entry) =>
      resourceKey(entry.node) === resourceKey(w.n)
        ? { node: entry.node, intervals: [...entry.intervals, ...visit.intervals] }
        : entry,
    ),
  });
  expect(broad.ownership.assignments).toEqual(p.value.ownership.assignments);
  const incorrectlyHidden = broad.visibility.text.find(
    (entry) =>
      entry.token.native.client === w.aText.client && entry.token.native.clock === w.aText.clock,
  )!;
  expect(incorrectlyHidden.visible).toBe(false);
  expect(incorrectlyHidden.tags).toHaveLength(1);
});

test.each([false, true])(
  'explicit SplitFlow selects its birth prefix; reverse receipt=%s',
  (reverse) => {
    const w = witness(true);
    const splitOrdinal = w.a.effects.findIndex((effect) => effect.type === 'SplitFlow');
    expect(splitOrdinal).toBe(0);
    const peer = open(w.genesis, w.body, splitOrdinal + 1);
    for (const update of reverse ? w.updates.toReversed() : w.updates)
      peer.store.applyUpdate(update);
    expect(peer.store.snapshot().ready).toEqual([w.a, w.b]);
    const p = peer.publish();
    expect(serializeProjection(p.value.view)).toBe('a\n\n<!-- -->\n');
    const fresh = open(w.genesis, w.body, splitOrdinal + 1);
    fresh.store.applyUpdate(peer.store.encodeUpdate());
    expect(fresh.publish().value.visibility).toEqual(p.value.visibility);
  },
);
