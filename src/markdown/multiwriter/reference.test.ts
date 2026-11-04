import { expect, test } from 'vitest';
import { contractCorpus } from '../../../test/multiwriter/corpus.js';
import { replicaTraceAdapter } from '../../../test/multiwriter/network.js';
import { runContractTrace } from '../../../test/multiwriter/trace.js';
import { referenceFactory } from '../../../test/multiwriter/reference/factory.js';

const equal = (actual: unknown, expected: unknown, context: string) =>
  expect(actual, context).toEqual(expected);
for (const trace of contractCorpus)
  test(
    `independent reference: ${trace.id}`,
    async () => {
      await runContractTrace(
        replicaTraceAdapter(
          referenceFactory(trace, (action) => {
            if (action.sequence % 50n === 0n) console.info(`${trace.id}: ${action.id} published`);
          }),
          equal,
        ),
        trace,
        equal,
      );
    },
    trace.id === 'history-limit-retains-canonical-facts' ? 2700000 : 60000,
  );

test('reference local certification aborts an ambiguous birth before canonical publication', async () => {
  const trace = contractCorpus.find((trace) => trace.id === 'shared-empty-genesis')!;
  const action = {
    id: 'A1',
    peer: 'A',
    sequence: 1n,
    lamport: 1n,
    dependencies: [],
    group: 'A1',
    intents: [
      {
        type: 'create' as const,
        block: {
          id: 'N',
          parent: 'root',
          role: 'inline' as const,
          flow: 'fN',
          run: 'rN',
          tape: 'tN',
          cells: [{ id: 'N0', text: 'n' }],
        },
        predecessor: null,
      },
      {
        type: 'create' as const,
        block: {
          id: 'M',
          parent: 'root',
          role: 'inline' as const,
          flow: 'fM',
          run: 'rM',
          tape: 'tM',
          cells: [{ id: 'M0', text: 'm' }],
        },
        predecessor: null,
      },
    ],
  };
  const factory = referenceFactory({ ...trace, steps: [{ type: 'author', action }] });
  const port = await factory.open({ peer: 'A', genesis: trace });
  try {
    const before = await port.isolationState();
    await expect(port.author(action)).rejects.toThrow('ambiguous');
    expect(await port.isolationState()).toEqual(before);
    expect((await port.observe()).held).toEqual([]);
    expect((await port.observe()).undo).toEqual([]);
  } finally {
    await port.dispose();
  }
});

test('a local command cannot type through a known deleted projection address', async () => {
  const base = contractCorpus.find((trace) => trace.id === 'shared-empty-genesis')!;
  const first = {
    id: 'A1',
    peer: 'A',
    sequence: 1n,
    lamport: 1n,
    dependencies: [],
    group: 'A1',
    intents: [
      {
        type: 'delete-subtree' as const,
        tag: 'dA',
        target: 'P',
        observedNodes: ['P'],
        coveredCells: [],
        joinedFlows: [],
      },
    ],
  };
  const second = {
    id: 'A2',
    peer: 'A',
    sequence: 2n,
    lamport: 2n,
    dependencies: ['A1'],
    group: 'A2',
    intents: [{ type: 'insert' as const, cell: 'AX', text: 'x', tape: 'tP', slot: 'P:end' }],
  };
  const trace = {
    ...base,
    steps: [
      { type: 'author' as const, action: first },
      { type: 'author' as const, action: second },
    ],
  };
  const port = await referenceFactory(trace).open({ peer: 'A', genesis: trace });
  try {
    await port.author(first);
    const before = await port.isolationState();
    await expect(port.author(second)).rejects.toThrow('Unavailable projected insertion address');
    expect(await port.isolationState()).toEqual(before);
  } finally {
    await port.dispose();
  }
});

test('a reopened writer authors with a fresh actor and a reset runtime sequence', async () => {
  const base = contractCorpus.find((trace) => trace.id === 'shared-empty-genesis')!;
  const first = {
    id: 'A1',
    peer: 'A',
    sequence: 1n,
    lamport: 1n,
    dependencies: [],
    group: 'A1',
    intents: [{ type: 'insert' as const, cell: 'AX', text: 'x', tape: 'tP', slot: 'P:end' }],
  };
  const second = {
    id: 'A2',
    peer: 'A',
    sequence: 2n,
    lamport: 2n,
    dependencies: ['A1'],
    group: 'A2',
    intents: [{ type: 'insert' as const, cell: 'AY', text: 'y', tape: 'tP', slot: 'P:end' }],
  };
  const trace = {
    ...base,
    steps: [
      { type: 'author' as const, action: first },
      { type: 'restart' as const, peer: 'A' },
      { type: 'author' as const, action: second },
    ],
  };
  const factory = referenceFactory(trace);
  const initial = await factory.open({ peer: 'A', genesis: trace });
  await initial.author(first);
  const prior = (initial.handles.actionStore as import('./actions/store.js').ActionStore).snapshot()
    .ready[0].id;
  const checkpoint = await initial.checkpoint();
  await initial.dispose();
  const reopened = await factory.open({ peer: 'A', genesis: trace, checkpoint });
  try {
    await reopened.author(second);
    const actions = (
      reopened.handles.actionStore as import('./actions/store.js').ActionStore
    ).snapshot().ready;
    expect(actions[1].id.actor).not.toBe(prior.actor);
    expect(actions[1].id.sequence).toBe(1n);
    expect((await reopened.observe()).held).toEqual(['A1', 'A2']);
    expect((await reopened.observe()).undo).toEqual(['A2']);
  } finally {
    await reopened.dispose();
  }
});
