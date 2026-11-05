import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { MaterializedPublication } from './publication.js';
import { IndexedActionStore } from './readiness.js';
import { readySource } from '../authoring/ready-source.js';
import { actionKey } from '../actions/references.js';
import { compareBytes } from '../actions/cbor.js';

const open = () => commandReplica(commandGenesis('abc'), undefined, 'materialized');
function type(p: CommandReplica, group: number, text = 'x') {
  const result = p.editor.edit({ local: 'writer-index', group: BigInt(group) }, insertText, {
    nodeId: p.handle(p.nodes()[0]),
    from: 1,
    text,
  });
  if (result.status !== 'applied') throw new Error('Expected applied command');
  return result;
}
function publication(p: CommandReplica) {
  if (!(p.document.publication instanceof MaterializedPublication)) throw new Error();
  return p.document.publication;
}
function store(p: CommandReplica) {
  if (!(p.document.store instanceof IndexedActionStore)) throw new Error();
  return p.document.store;
}
for (const depth of [10, 150, 1000])
  test(`ordinary input synchronizes changed ready paths after ${depth} retained actions`, () => {
    const p = open();
    try {
      for (let i = 1; i <= depth; i++) type(p, i);
      const before = p.editor.writerDiagnostics(),
        native = publication(p).diagnostics();
      const edit = type(p, depth + 1, '!');
      const after = p.editor.writerDiagnostics(),
        next = publication(p).diagnostics();
      expect(after.readyActionsScanned).toBe(before.readyActionsScanned);
      expect(after.frontierActionsScanned).toBe(0);
      expect(after.readyIndexNodesVisited - before.readyIndexNodesVisited).toBeLessThan(200);
      expect(next.nativeMembershipScanned).toBe(native.nativeMembershipScanned);
      expect(next.nativeReadyActionsVisited - native.nativeReadyActionsVisited).toBe(1);
      expect(next.readyIndexNodesVisited - native.readyIndexNodesVisited).toBeLessThan(200);
      expect(edit.envelope.id.sequence).toBe(BigInt(depth + 1));
      expect(edit.envelope.lamport).toBe(BigInt(depth + 1));
      expect(p.nodes()[0].content).toBe(`a!${'x'.repeat(depth)}bc`);
      const cold = commandReplica(p.genesis, p.document.store.encodeUpdate());
      try {
        expect(p.observe()).toEqual(cold.observe());
      } finally {
        cold.close();
      }
    } finally {
      p.close();
    }
  }, 120000);

test('withdrawn remote bodies rebuild a warm writer before independent continued input', () => {
  const p = open(),
    q = commandReplica(p.genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  try {
    const edit = type(q, 1, 'Q');
    p.receive(q.document.store.encodeUpdate());
    p.editor.edit({ local: 'probe', group: 1n }, () => ({ status: 'not-applicable' }), undefined);
    const before = p.editor.writerDiagnostics();
    p.document.store.append({
      ...edit.envelope,
      groupId: { ...edit.envelope.groupId, sequence: 999n },
    });
    p.editor.refresh();
    const continued = type(p, 1, 'P');
    expect(p.editor.writerDiagnostics().nativeRebuilds).toBe(before.nativeRebuilds + 1);
    expect(continued.envelope.lamport).toBe(1n);
    expect(p.nodes()[0].content).toBe('aPbc');
    oracle.check(p.document, p.genesis);
  } finally {
    oracle.destroy();
    q.close();
    p.close();
  }
});

for (const completeNative of [false, true])
  test(`cancelled ${completeNative ? 'complete' : 'partial'} native integration cannot retain a withdrawn body`, () => {
    const p = open(),
      q = commandReplica(p.genesis, undefined, 'materialized'),
      oracle = createMaterializationOracle();
    try {
      const first = type(q, 1, 'Q');
      type(q, 2, 'R');
      const old = p.document.publication.status().publication!,
        bytes = old.native.encodeState(),
        native = publication(p).diagnostics();
      p.document.store.applyUpdate(q.document.store.encodeUpdate());
      let work = publication(p).refresh(0);
      const target = native.nativeBodiesIntegrated + (completeNative ? 2 : 1);
      for (
        let i = 0;
        publication(p).diagnostics().nativeBodiesIntegrated < target && i < 100000;
        i++
      ) {
        if (work.state !== 'deferred') throw new Error('Published before cancellation probe');
        work = work.continuation.resume(1);
      }
      expect(publication(p).diagnostics().nativeBodiesIntegrated).toBe(target);
      expect(p.document.publication.status().publication).toBe(old);
      p.document.store.append({
        ...first.envelope,
        groupId: { ...first.envelope.groupId, sequence: 999n },
      });
      if (work.state !== 'deferred') throw new Error('Expected suspended publication');
      expect(() => work.continuation.resume(1)).toThrow(/invalidated/);
      p.editor.refresh();
      type(p, 1, 'P');
      expect(publication(p).diagnostics().nativeRebuilds).toBe(native.nativeRebuilds + 1);
      expect(p.nodes()[0].content).toBe('aPbc');
      expect(compareBytes(old.native.encodeState(), bytes)).toBe(0);
      oracle.check(p.document, p.genesis);
    } finally {
      oracle.destroy();
      q.close();
      p.close();
    }
  });

test('cancelled readiness does not publish index membership or author frontiers', () => {
  const p = open(),
    q = commandReplica(p.genesis, undefined, 'materialized');
  try {
    const old = store(p).readReady(),
      before = readySource(old.ready)!;
    const first = type(q, 1, 'Q'),
      second = type(q, 2, 'R');
    p.document.store.applyUpdate(q.document.store.encodeUpdate());
    const evaluated = store(p).readinessDiagnostics().entriesEvaluated;
    let work = store(p).computeReady(0);
    for (
      let i = 0;
      store(p).readinessDiagnostics().entriesEvaluated === evaluated && i < 100000;
      i++
    ) {
      if (work.state !== 'deferred') throw new Error('Unexpected readiness completion');
      work = work.continuation.resume(1);
    }
    expect(before.has(actionKey(first.action))).toBe(false);
    if (work.state !== 'deferred') throw new Error();
    work.continuation.cancel();
    const current = readySource(store(p).readReady().ready)!;
    expect(current.additions(before)!.actions.map((a) => a.id)).toEqual([
      first.action,
      second.action,
    ]);
    expect(current.sequence(first.action.actor)).toBe(2n);
    expect(before.sequence(first.action.actor)).toBe(0n);
    expect(before.maxLamport).toBe(0n);
  } finally {
    q.close();
    p.close();
  }
});
