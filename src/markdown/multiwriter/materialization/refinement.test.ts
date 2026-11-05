import { expect, test, vi } from 'vitest';
import { nativeView } from '../ingest/publication.js';
import { commandGenesis } from '../../../../test/multiwriter/commands/replica.js';
import { NativeTapeCache } from '../text/cache.js';
import { action, resource } from '../actions/test-fixtures.js';
import * as layout from '../layout/index.js';
import { historyLimitTrace } from '../../../../test/multiwriter/corpus.js';
import type { ContractTrace, Step } from '../../../../test/multiwriter/trace.js';
import { runContractTrace } from '../../../../test/multiwriter/trace.js';
import { replicaTraceAdapter } from '../../../../test/multiwriter/network.js';
import { referenceFactory } from '../../../../test/multiwriter/reference/factory.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { equal } from '../../../../test/multiwriter/equal.js';
import { openMaterializedDocument } from './document.js';

test('refines checkpoint cell roots through later brackets before undo, redo and cold replay', async () => {
  const control = (sequence: number, active: boolean): Step => ({
    type: 'author',
    action: {
      id: `B${sequence}`,
      peer: 'B',
      sequence: BigInt(sequence),
      lamport: BigInt(sequence),
      group: `B${sequence}`,
      dependencies: [`B${sequence - 1}`],
      intents: [
        {
          type: 'control',
          group: 'B130',
          actions: ['B130'],
          active,
          previous: active ? 'B133' : null,
        },
      ],
    },
  });
  const trace: ContractTrace = {
    ...historyLimitTrace,
    id: 'native-refinement-checkpoint-control',
    steps: [
      ...historyLimitTrace.steps.slice(0, 132),
      control(133, false),
      { type: 'expect', peer: 'B', state: { markdown: `abcdef${'x'.repeat(131)}\n` } },
      control(134, true),
      { type: 'expect', peer: 'B', state: { markdown: `abcdef${'x'.repeat(132)}\n` } },
    ],
  };
  const oracle = createMaterializationOracle();
  const initial = new WeakSet<object>();
  const counters = new Map<
    number,
    ReturnType<ReturnType<typeof openMaterializedDocument>['ownershipDiagnostics']>
  >();
  try {
    await runContractTrace(
      replicaTraceAdapter(
        referenceFactory(trace, undefined, {
          openDocument: openMaterializedDocument,
          onPublication(document, genesis) {
            oracle.check(document, genesis);
            const value = document as ReturnType<typeof openMaterializedDocument>;
            const count = value.publication.status().publication!.value.activity.actions.length;
            if (!count) initial.add(document);
            if (initial.has(document)) counters.set(count, value.ownershipDiagnostics());
          },
        }),
        equal,
      ),
      trace,
      equal,
    );
    expect(counters.get(132)).toMatchObject({
      lastReplayFrom: 131,
      nativeMarkerRefinements: 132,
      nativeMarkerFallbacks: 0,
    });
    expect(counters.get(133)).toMatchObject({
      lastReplayFrom: 132,
      lastReplayLength: 1,
      nativeMarkerFallbacks: 0,
    });
    expect(counters.get(134)).toMatchObject({
      lastReplayFrom: 133,
      lastReplayLength: 1,
      nativeMarkerFallbacks: 0,
    });
  } finally {
    oracle.destroy();
  }
}, 120000);

test('marker-only refinement updates addresses while preserving text and old publications', () => {
  const genesis = commandGenesis('abc\n\ntail');
  const document = openMaterializedDocument(genesis);
  const writer = new NativeTapeCache();
  const oracle = createMaterializationOracle();
  const refresh = () => {
    let result = document.publication.refresh();
    while (result.state === 'deferred') result = result.continuation.resume();
    return result.value;
  };
  try {
    writer.apply('G', genesis.body);
    const before = refresh();
    const inline = before.value.view.root.children[0],
      tail = before.value.view.root.children[1];
    const nativeTape = genesis.layout.allocations.find((allocation) => allocation.type === 'tape')!;
    if (nativeTape.type !== 'tape') throw new Error('Missing tape');
    const text = writer.snapshot(nativeTape.id).parts.find((part) => part.type === 'text')!;
    const envelope = action();
    const marker = resource('marker', 0, envelope.id);
    const prepared = writer.prepare('marker-only', [
      { type: 'marker', tape: nativeTape.id, index: text.index, marker, affinity: 'right' },
    ]);
    prepared.commit();
    const body = { ...envelope, ...prepared.body };
    document.certifyLocal(body);
    const reads = vi.fn(writer.snapshot.bind(writer));
    const staged = document.stageLocalText(body, { ...nativeView(writer), snapshot: reads });
    expect(staged?.value.view.root.children[0].boundaries.length).toBe(
      inline.boundaries.length + 2,
    );
    expect(reads.mock.calls.length).toBeLessThanOrEqual(3);
    expect(document.publication.status().publication!.value).toBe(before.value);
    document.store.append(body);
    const after = refresh();
    expect(after.value.view.root.children[0].content).toBe(inline.content);
    expect(after.value.view.root.children[0].boundaries.length).toBe(inline.boundaries.length + 2);
    expect(after.value.view.root.children[1]).toBe(tail);
    expect(before.value.view.root.children[0]).toBe(inline);
    expect(
      before.native
        .snapshot(nativeTape.id)
        .parts.some(
          (part) =>
            part.type === 'marker' &&
            layout.resourceKey(part.marker) === layout.resourceKey(marker),
        ),
    ).toBe(false);
    expect(document.projectionDiagnostics().fullProjections).toBe(1);
    oracle.check(document, genesis);
  } finally {
    oracle.destroy();
    writer.destroy();
    document.destroy();
  }
});
