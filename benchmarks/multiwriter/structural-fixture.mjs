import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { commandReplica } from '../../test/multiwriter/commands/replica.js';
import {
  deleteBlocks,
  insertParagraph,
  insertText,
  joinWithPrevious,
} from '../../src/markdown/multiwriter/authoring/index.js';
import { resourceKey } from '../../src/markdown/multiwriter/layout/index.js';
import { compareBytes } from '../../src/markdown/multiwriter/actions/cbor.js';
import { captureDiagnostics } from '../../src/markdown/multiwriter/diagnostics.js';
import { encodeEnvelope } from '../../src/markdown/multiwriter/actions/codec.js';
import { observePhases } from './phases.mjs';

export const limits = { nativeDecodeOperations: 10_000_000 };
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const json = (value) =>
  JSON.stringify(value, (_k, v) =>
    typeof v === 'bigint'
      ? `${v}n`
      : v instanceof Uint8Array
        ? { bytes: Buffer.from(v).toString('base64') }
        : v,
  );
export function observation(p) {
  const current = p.document.publication.status().publication;
  const v = current.value,
    o = v.ownership;
  return {
    ready: p.document.store.snapshot(),
    heads: current.heads,
    view: v.view,
    visibility: v.visibility,
    activity: v.activity.effects,
    masks: v.interpretations.masks,
    assignments: o.assignments,
    buckets: o.buckets,
    homes: o.homeBindings,
    flows: o.flowPlacements,
    runs: o.runLayouts,
    requirements: o.destinationRequirements,
    nodes: o.nodeAllocations.map((n) => [
      n,
      o.blockPlacement(n.id),
      o.children(n.id),
      n.flow ? o.raw(n.flow) : null,
      v.interpretations.properties(n.id),
    ]),
  };
}
export function independentCheck(p, retainedOracle) {
  const bytes = p.document.store.encodeUpdate();
  const cold = retainedOracle ?? commandReplica(p.genesis, bytes, 'reference', limits);
  if (retainedOracle) {
    const delta = p.document.store.encodeUpdate(cold.document.store.encodeStateVector());
    // An unchanged canonical set already has its independently reconstructed
    // publication. Every nonempty update still runs full reference publication.
    // Complete canonical equality below also covers pending carrier bytes.
    if (delta.length !== 2 || delta[0] !== 0 || delta[1] !== 0) cold.receive(delta);
  }
  try {
    assert.equal(
      compareBytes(bytes, cold.document.store.encodeUpdate()),
      0,
      'complete canonical bytes',
    );
    assert.equal(
      compareBytes(
        p.document.publication.status().publication.native.encodeState(),
        cold.document.publication.status().publication.native.encodeState(),
      ),
      0,
      'native bytes',
    );
    assert.deepEqual(observation(p), observation(cold));
  } finally {
    if (!retainedOracle) cold.close();
  }
}
export function runStructuralFixture(
  genesis,
  initial,
  { instrumented = false, deleted = false, onStep = () => {}, onSetup = () => {} } = {},
) {
  const coldStart = performance.now();
  const p = commandReplica(genesis, initial, 'materialized', limits);
  const coldLoadMs = performance.now() - coldStart;
  onSetup({ phase: 'candidate-cold', wallMs: coldLoadMs });
  const initialHeads = p.document.publication.status().publication.heads;
  const initialSchedule = p.document.store.snapshot().ready.map((a) => ({
    id: a.id,
    lamport: a.lamport,
    dependencies: a.dependencies,
    effects: a.effects.map((e) => e.type),
    payloadSha256: hash(encodeEnvelope(a)),
  }));
  const phases = instrumented ? observePhases(p.document) : undefined;
  const oracleStart = performance.now();
  const oracle = commandReplica(genesis, initial, 'reference', limits);
  const oracleColdMs = performance.now() - oracleStart;
  onSetup({ phase: 'reference-cold', wallMs: oracleColdMs });
  const check = () => independentCheck(p, oracle);
  const trace = [],
    carriers = [];
  const off = p.document.store.onUpdate((u) => carriers.push(u.slice()));
  const structural = p.editor.session('structural'),
    other = p.editor.session('unrelated');
  const identity = (n) => resourceKey(n.origin.representative);
  const find = (id) => {
    const node = p
      .nodes()
      .find((n) => n.origin.constituents.some((part) => resourceKey(part) === id));
    assert(node, `missing origin ${id}`);
    return node;
  };
  const selection = (node, offset) => ({
    anchor: { nodeId: p.handle(node), offset, affinity: 'right' },
    focus: { nodeId: p.handle(node), offset, affinity: 'right' },
  });
  const step = (name, operation) => {
    const before = phases?.snapshot();
    const start = performance.now();
    const result = instrumented ? captureDiagnostics(operation) : { value: operation() };
    const wallMs = performance.now() - start;
    const row = {
      name,
      action: result.value?.action ?? null,
      state: result.value?.status ?? result.value?.state,
      wallMs,
      exclusive: result.report ?? null,
      inclusive: phases?.since(before) ?? null,
      diagnostics: p.document.projectionDiagnostics(),
      writer: p.editor.writerDiagnostics(),
    };
    trace.push(row);
    // Fresh native/provenance/semantic reconstruction is outside all edit timers.
    const oracleStart = performance.now();
    check();
    row.oracleMs = performance.now() - oracleStart;
    onStep(row, { genesis, initial, carriers });
    return result.value;
  };
  const edit = (session, command, node, extra) =>
    session.edit(
      command,
      { nodeId: p.handle(node), ...extra },
      { typing: false, selectionBefore: selection(node, extra.from ?? 0) },
    );
  try {
    assert.equal(p.nodes().length, 150);
    const first = identity(p.nodes()[0]),
      distant = identity(p.nodes()[148]),
      removed = identity(p.nodes()[149]);
    const distantText = find(distant).content;
    if (deleted) {
      const target = find(removed),
        targetId = target.origin.representative;
      const deletion = p.editor
        .session('deletion')
        .edit(deleteBlocks, { nodeIds: [p.handle(target)] });
      assert.equal(deletion.status, 'applied');
      const effect = deletion.envelope.effects.find((e) => e.type === 'DeleteSubtree');
      assert(effect);
      assert.deepEqual(effect.scope.target, targetId);
      const current = p.document.publication.status().publication.value;
      const ordinal = deletion.envelope.effects.indexOf(effect);
      assert(current.activity.isEffectActive({ action: deletion.action, ordinal }));
      const tagged = current.visibility.nodes.find(
        (entry) => resourceKey(entry.node) === resourceKey(targetId),
      );
      assert(tagged?.deleted);
      assert(tagged.tags.some((tag) => resourceKey(tag) === resourceKey(effect.tag)));

      assert(!p.nodes().some((n) => identity(n) === removed));
      check();
    }
    const prior = p.document.publication.status().publication;
    const priorState = json({
      view: prior.value.view,
      assignments: prior.value.ownership.assignments,
      raw: prior.value.ownership.nodeAllocations
        .filter((n) => n.flow)
        .map((n) => prior.value.ownership.raw(n.flow)),
    });
    const priorNative = prior.native.encodeState();
    assert.equal(
      step('split', () => edit(structural, insertParagraph, find(first), { from: 2 })).status,
      'applied',
    );
    const right = identity(p.nodes()[1]);
    for (const [id, text, name] of [
      [first, 'L', 'type-left'],
      [right, 'R', 'type-right'],
    ])
      assert.equal(
        step(name, () => edit(structural, insertText, find(id), { from: 0, text })).status,
        'applied',
      );
    const leftText = find(first).content,
      rightText = find(right).content;
    const join = step('join', () => edit(structural, joinWithPrevious, find(right), {}));
    assert.equal(join.status, 'applied');
    assert(join.selectionBefore);
    assert(join.selectionAfter);
    assert.equal(find(first).content, leftText + rightText);
    assert.equal(
      step('unrelated-edit', () => edit(other, insertText, find(distant), { from: 0, text: 'U' }))
        .status,
      'applied',
    );
    const undo = step('undo-join', () => structural.undo());
    assert.equal(undo.state, 'applied');
    assert.equal(undo.restoration.state, 'exact');
    assert.equal(undo.restoration.anchor.offset, 0);
    assert.equal(undo.restoration.focus.offset, 0);
    assert.equal(find(first).content, leftText);
    assert.equal(find(right).content, rightText);
    const redo = step('redo-join', () => structural.redo());
    assert.equal(redo.state, 'applied');
    assert.equal(redo.restoration.state, 'exact');
    assert.equal(redo.restoration.anchor.offset, leftText.length);
    assert.equal(redo.restoration.focus.offset, leftText.length);
    assert.equal(find(first).content, leftText + rightText);
    assert.equal(find(distant).content, 'U' + distantText);
    assert.equal(
      step('continued-typing', () =>
        edit(structural, insertText, find(first), { from: 0, text: '!' }),
      ).status,
      'applied',
    );
    const bytes = p.document.store.encodeUpdate();
    const evictStart = performance.now();
    p.document.publication.evict();
    p.editor.refresh();
    const evictionReopenMs = performance.now() - evictStart;
    check();
    assert.equal(compareBytes(bytes, p.document.store.encodeUpdate()), 0);
    assert.equal(compareBytes(priorNative, prior.native.encodeState()), 0);
    assert.equal(
      json({
        view: prior.value.view,
        assignments: prior.value.ownership.assignments,
        raw: prior.value.ownership.nodeAllocations
          .filter((n) => n.flow)
          .map((n) => prior.value.ownership.raw(n.flow)),
      }),
      priorState,
    );
    if (deleted) assert(!p.nodes().some((n) => identity(n) === removed));
    assert.equal(
      step('post-eviction-typing', () =>
        edit(structural, insertText, find(first), { from: 0, text: '?' }),
      ).status,
      'applied',
    );
    return {
      complete: true,
      coldLoadMs,
      oracleColdMs,
      initialHeads,
      initialSchedule,
      evictionReopenMs,
      trace,
      carriers,
      canonical: p.document.store.encodeUpdate(),
      markdown: p.markdown(),
      persistence: { measured: false, reason: 'no journal attached' },
      history: structural.status(),
    };
  } finally {
    phases?.restore();
    off();
    oracle.close();
    p.close();
  }
}

/** Separate local and remote obligations; remote authors never see the split. */
export function runRemoteFixture(genesis, { instrumented = false } = {}) {
  const p = commandReplica(genesis, undefined, 'materialized', limits),
    q = commandReplica(genesis, undefined, 'materialized', limits);
  const localCarriers = [],
    remoteCarriers = [],
    samples = [];
  const offP = p.document.store.onUpdate((u) => localCarriers.push(u.slice()));
  const offQ = q.document.store.onUpdate((u) => remoteCarriers.push(u.slice()));
  const initialNodes = p.nodes();
  try {
    const local = p.editor.session('local'),
      remote = q.editor.session('remote');
    assert.equal(
      local.edit(insertText, { nodeId: p.handle(initialNodes[2]), from: 0, text: '!' }).status,
      'applied',
    );
    const split = local.edit(insertParagraph, { nodeId: p.handle(p.nodes()[0]), from: 2 });
    assert.equal(split.status, 'applied');
    const join = remote.edit(joinWithPrevious, { nodeId: q.handle(q.nodes()[1]) });
    assert.equal(join.status, 'applied');
    assert(join.envelope.lamport < split.envelope.lamport);
    assert.equal(
      remote.edit(insertText, { nodeId: q.handle(q.nodes().at(-1)), from: 0, text: 'U' }).status,
      'applied',
    );
    const localBytes = p.document.store.encodeUpdate(),
      remoteBytes = q.document.store.encodeUpdate();
    // Same facts, both carrier orders, an unresolved-prefix delivery and duplicates.
    for (const order of ['local-first', 'remote-first']) {
      const receiver = commandReplica(genesis, undefined, 'materialized', limits);
      try {
        const source =
          order === 'local-first'
            ? [localCarriers, remoteCarriers]
            : [remoteCarriers, localCarriers];
        const sequence = [...source[0], ...source[1].toReversed(), ...source[1]];
        for (const [i, bytes] of sequence.entries()) {
          const operation = () => receiver.receive(bytes);
          const start = performance.now();
          const result = instrumented ? captureDiagnostics(operation) : { value: operation() };
          samples.push({
            order,
            index: i,
            wallMs: performance.now() - start,
            exclusive: result.report ?? null,
            diagnostics: receiver.document.projectionDiagnostics(),
          });
          independentCheck(receiver);
        }
        const final = commandReplica(genesis, localBytes, 'materialized', limits);
        try {
          final.receive(remoteBytes);
          assert.deepEqual(observation(final), observation(receiver));
          assert.equal(
            compareBytes(
              final.document.store.encodeUpdate(),
              receiver.document.store.encodeUpdate(),
            ),
            0,
          );
        } finally {
          final.close();
        }
      } finally {
        receiver.close();
      }
    }
    p.receive(remoteBytes);
    q.receive(localBytes);
    assert.deepEqual(observation(p), observation(q));
    independentCheck(p);
    independentCheck(q);
    return {
      complete: true,
      samples,
      localCarriers,
      remoteCarriers,
      genesis,
      canonical: p.document.store.encodeUpdate(),
      description:
        'new independent public-authoring replicas; real unrelated local edit orders the concurrent peer join before the split; both deliveries and duplicates',
      persistence: { measured: false, reason: 'no journal attached' },
    };
  } finally {
    offP();
    offQ();
    p.close();
    q.close();
  }
}
