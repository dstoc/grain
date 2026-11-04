import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  decodeNetworkTrace,
  encodeNetworkTrace,
  ReplicaNetwork,
  replicaTraceAdapter,
  replayNetworkTrace,
  SeededRandom,
} from '../../../test/multiwriter/network.js';
import type {
  Equal,
  NetworkStep,
  ReplicaFactory,
  ReplicaPort,
} from '../../../test/multiwriter/network.js';
import { transportProbe } from '../../../test/multiwriter/transport-probe.js';
import { runContractTrace } from '../../../test/multiwriter/trace.js';
import type { ContractTrace, Observation, TraceAction } from '../../../test/multiwriter/trace.js';

const contract: ContractTrace = {
  version: 3,
  id: 'network-instrument',
  genesis: 'G',
  peers: ['A', 'B', 'C'],
  sections: ['9.2', '13', '14 MW-07'],
  purpose:
    'Exercise the scheduler with real independent Yjs stores; not the integrated reducer gate',
  seed: [
    { id: 'root', parent: null, role: 'root' },
    { id: 'P', parent: 'root', role: 'inline', flow: 'fP', run: 'rP', tape: 'tP', cells: [] },
  ],
  steps: [],
};
const equal: Equal = (actual, expected, context) => expect(actual, context).toEqual(expected);
function insert(
  peer: string,
  sequence: number,
  dependencies: string[] = [],
  lamport = sequence,
): TraceAction {
  const id = `${peer}${sequence}`;
  return {
    id,
    peer,
    sequence: BigInt(sequence),
    lamport: BigInt(lamport),
    dependencies,
    group: id,
    intents: [
      { type: 'insert', cell: `${id}:text`, text: peer.toLowerCase(), tape: 'tP', slot: 'P:end' },
    ],
  };
}
const link = (from: string, to: string, reverseControl = false): NetworkStep => ({
  type: 'link',
  from,
  to,
  enabled: true,
  reverseControl,
});
async function send(
  network: ReplicaNetwork,
  from: string,
  to: string,
  actions: string[],
  id: string,
  route: 'peer' | 'catch-up' | 'self-echo' | 'cross-tab' = 'peer',
): Promise<void> {
  await network.step({ type: 'send', from, to, actions, id, route });
  await network.step({ type: 'deliver', id });
}
async function withNetwork(
  run: (network: ReplicaNetwork) => Promise<void>,
  factory = transportProbe(),
): Promise<void> {
  const network = await ReplicaNetwork.open(factory, contract, equal, 88);
  try {
    await run(network);
  } finally {
    await network.dispose();
  }
}

// These are harness controls, not claims that the absent MW-08 composition passes.
describe('independent Yjs transport instrument', () => {
  it('holds a control before its target, permits unrelated ready work, and bootstraps on strict one-way links', async () => {
    await withNetwork(async (network) => {
      await network.step(link('A', 'B'));
      await network.step(link('C', 'B'));
      await network.step({ type: 'mode', peer: 'A', mode: 'outbound-only' });
      await network.step({ type: 'author', action: insert('A', 1) });
      const control: TraceAction = {
        ...insert('A', 2, ['A1']),
        intents: [{ type: 'control', group: 'A1', actions: ['A1'], active: false, previous: null }],
      };
      await network.step({ type: 'author', action: control });
      await send(network, 'A', 'B', ['A2'], 'control-first');
      await network.step({
        type: 'expect',
        peer: 'B',
        state: { held: ['A2'], ready: [], pending: ['A2'], nativeText: {}, markdown: '\n' },
      });
      await network.step({ type: 'author', action: insert('C', 1) });
      await send(network, 'C', 'B', ['C1'], 'independent');
      await network.step({
        type: 'expect',
        peer: 'B',
        state: { ready: ['C1'], pending: ['A2'], markdown: 'c\n' },
      });
      await send(network, 'A', 'B', ['A1', 'A2'], 'bootstrap');
      await network.step({ type: 'duplicate', source: 'bootstrap', id: 'retry' });
      await network.step({ type: 'deliver', id: 'retry' });
      await network.step({
        type: 'expect',
        peer: 'B',
        state: { ready: ['A1', 'C1', 'A2'], pending: [], hidden: ['A1:text'], markdown: 'c\n' },
      });
      await expect(network.step({ type: 'ack', id: 'bootstrap' })).rejects.toThrow(
        'Reverse control traffic disabled',
      );
      await network.step({ type: 'replay', peer: 'B' });
    });
  });
  it('keeps outbound-only state equal to an isolated control across every route and optional acknowledgments', async () => {
    const network = await ReplicaNetwork.open(transportProbe(), contract, equal, 1);
    const isolated = await ReplicaNetwork.open(transportProbe(), contract, equal, 1);
    try {
      for (const target of [network, isolated]) {
        await target.step({ type: 'mode', peer: 'A', mode: 'outbound-only' });
        await target.step({ type: 'author', action: insert('A', 1) });
      }
      await network.step(link('A', 'B', true));
      await network.step(link('B', 'A', true));
      await send(network, 'A', 'B', ['A1'], 'out');
      await network.step({ type: 'author', action: insert('B', 1, ['A1'], 2) });
      for (const route of ['peer', 'catch-up', 'self-echo', 'cross-tab'] as const)
        await send(network, 'B', 'A', ['A1', 'B1'], route, route);
      await network.step({ type: 'ack', id: 'out' });
      for (const target of [network, isolated])
        await target.step({ type: 'author', action: insert('A', 2, ['A1']) });
      equal(
        await network.observe('A'),
        await isolated.observe('A'),
        'isolated outbound-only control',
      );
      await network.step({ type: 'mode', peer: 'A', mode: 'bidirectional' });
      await send(network, 'B', 'A', ['A1', 'B1'], 'enabled-catch-up');
      await send(network, 'A', 'B', ['A1', 'B1', 'A2'], 'full-closure');
      expect((await network.observe('A')).undo).toEqual(['A1', 'A2']);
      expect((await network.observe('B')).undo).toEqual(['B1']);
    } finally {
      await network.dispose();
      await isolated.dispose();
    }
  });
  it('relays other actors prerequisites after switching outbound-only and keeps unsent edits through mode changes', async () => {
    await withNetwork(async (network) => {
      await network.step(link('B', 'A'));
      await network.step(link('A', 'C'));
      await network.step({ type: 'author', action: insert('B', 1) });
      await send(network, 'B', 'A', ['B1'], 'prior');
      await network.step({ type: 'mode', peer: 'A', mode: 'inbound-only' });
      await network.step({ type: 'author', action: insert('A', 1, ['B1'], 2) });
      await network.step({
        type: 'send',
        id: 'unsent',
        from: 'A',
        to: 'C',
        actions: ['A1'],
        route: 'peer',
      });
      await expect(network.step({ type: 'deliver', id: 'unsent' })).rejects.toThrow(
        'Unknown message',
      );
      expect((await network.observe('C')).held).toEqual([]);
      await network.step({ type: 'mode', peer: 'A', mode: 'disconnected' });
      expect((await network.observe('A')).undo).toEqual(['A1']);
      await network.step({ type: 'mode', peer: 'A', mode: 'outbound-only' });
      await send(network, 'A', 'C', ['B1', 'A1'], 'relay');
      expect((await network.observe('C')).ready).toEqual(['B1', 'A1']);
      expect((await network.observe('C')).undo).toEqual([]);
    });
  });
  it('does not recall in-flight sends and permits retry after a partition', async () => {
    await withNetwork(async (network) => {
      await network.step({ type: 'author', action: insert('A', 1) });
      await network.step({
        type: 'send',
        from: 'A',
        to: 'B',
        actions: ['A1'],
        id: 'in-flight',
        route: 'peer',
      });
      await network.step({ type: 'deliver', id: 'in-flight' }); // No link yet: remains queued.
      expect((await network.observe('B')).held).toEqual([]);
      await network.step({ type: 'mode', peer: 'A', mode: 'disconnected' });
      await network.step(link('A', 'B'));
      await network.step({ type: 'duplicate', source: 'in-flight', id: 'lost' });
      await network.step({ type: 'drop', id: 'lost' });
      await network.step({ type: 'deliver', id: 'in-flight' });
      expect((await network.observe('B')).held).toEqual(['A1']);
    });
  });
  it('resets navigation on restart while retaining controls, native identities and old-prefix references after maintenance', async () => {
    await withNetwork(async (network) => {
      await network.step(link('A', 'B'));
      await network.step({ type: 'author', action: insert('A', 1) });
      await send(network, 'A', 'B', ['A1'], 'prefix');
      const deletion: TraceAction = {
        ...insert('B', 1, ['A1'], 2),
        intents: [{ type: 'delete-text', tag: 'dB', cells: ['A1:text'] }],
      };
      await network.step({ type: 'author', action: deletion });
      for (const operation of ['evict-history', 'drop-caches', 'checkpoint-reload'] as const)
        await network.step({ type: 'maintain', peer: 'B', operation });
      await network.step({ type: 'restart', peer: 'B' });
      expect((await network.observe('B')).undo).toEqual([]);
      await network.step({ type: 'author', action: insert('A', 2, ['A1']) });
      await send(network, 'A', 'B', ['A1', 'A2'], 'old-prefix');
      await network.step({
        type: 'expect',
        peer: 'B',
        state: { hidden: ['A1:text'], markdown: 'a\n', ready: ['A1', 'A2', 'B1'] },
      });
      await network.step({ type: 'replay', peer: 'B' });
    });
  });
});

function alter(
  factory: ReplicaFactory,
  change: (port: ReplicaPort, peer: string) => ReplicaPort,
): ReplicaFactory {
  return {
    async open(input) {
      return change(await factory.open(input), input.peer);
    },
  };
}

/** Use original action-store structs, including the prior array item's native origin.
 * The ordinary probe repackages subsets into independent carrier arrays instead.
 */
function incrementalTransport(): ReplicaFactory {
  return alter(transportProbe(), (port) => {
    let sent: Uint8Array = new Uint8Array([0]); // Empty Yjs state vector.
    return {
      ...port,
      exportUpdate() {
        const doc = port.handles.actionStore as Doc;
        const update = encodeStateAsUpdate(doc, sent);
        sent = encodeStateVector(doc);
        return update;
      },
    };
  });
}

it('continues original native incremental exchange after checkpoint reconstruction', async () => {
  await withNetwork(async (network) => {
    await network.step(link('A', 'B'));
    await network.step({ type: 'author', action: insert('A', 1) });
    await send(network, 'A', 'B', ['A1'], 'original-prefix');
    await network.step({ type: 'author', action: insert('A', 2, ['A1']) });
    await network.step({
      type: 'send',
      id: 'original-tail',
      from: 'A',
      to: 'B',
      actions: ['A2'],
      route: 'peer',
    });
    await network.step({ type: 'replay', peer: 'B' });
    await network.step({ type: 'restart', peer: 'B' });
    await network.step({ type: 'deliver', id: 'original-tail' });
    expect((await network.observe('B')).ready).toEqual(['A1', 'A2']);
    expect((await network.observe('B')).markdown).toBe('aa\n');
    await network.step({ type: 'replay', peer: 'B' });
  }, incrementalTransport());
});

async function pendingOuterPrefix(network: ReplicaNetwork): Promise<void> {
  await network.step(link('A', 'B'));
  await network.step({ type: 'author', action: insert('A', 1) });
  await network.step({
    type: 'send',
    id: 'missing-prefix',
    from: 'A',
    to: 'B',
    actions: ['A1'],
    route: 'peer',
  });
  await network.step({ type: 'drop', id: 'missing-prefix' });
  await network.step({ type: 'author', action: insert('A', 2, ['A1']) });
  await send(network, 'A', 'B', ['A2'], 'pending-outer');
  // The second native array item cannot integrate yet; neither envelope is visible.
  expect((await network.observe('B')).held).toEqual([]);
}

it('retains pending outer structs across reconstruction and integrates their delayed prefix', async () => {
  await withNetwork(async (network) => {
    await pendingOuterPrefix(network);
    await network.step({ type: 'replay', peer: 'B' });
    await network.step({ type: 'restart', peer: 'B' });
    await network.step({ type: 'duplicate', source: 'missing-prefix', id: 'retry-prefix' });
    await network.step({ type: 'deliver', id: 'retry-prefix' });
    expect((await network.observe('B')).ready).toEqual(['A1', 'A2']);
    expect((await network.observe('B')).markdown).toBe('aa\n');
  }, incrementalTransport());
});

describe('harness negative controls', () => {
  it.each(['restart', 'replay'] as const)(
    'rejects %s that drops unintegrated outer structs while preserving the empty observation',
    async (type) => {
      const factory = alter(incrementalTransport(), (port, peer) => ({
        ...port,
        checkpoint: () => (peer === 'B' ? new Uint8Array([0, 0]) : port.checkpoint()),
      }));
      await expect(
        withNetwork(async (network) => {
          await pendingOuterPrefix(network);
          await network.step({ type, peer: 'B' });
        }, factory),
      ).rejects.toThrow('canonical native state');
    },
  );

  it('rejects losing a previously pending action while authoring independent local work', async () => {
    const factory = alter(transportProbe(), (port, peer) => ({
      ...port,
      async observe() {
        const state = await port.observe();
        if (peer !== 'B' || !state.held.includes('B1')) return state;
        return {
          ...state,
          held: state.held.filter((id) => id !== 'A2'),
          retainedActions: state.retainedActions.filter((id) => id !== 'A2'),
          pending: state.pending.filter((id) => id !== 'A2'),
          variants: Object.fromEntries(
            Object.entries(state.variants).filter(([id]) => id !== 'A2'),
          ),
        };
      },
    }));
    await expect(
      withNetwork(async (network) => {
        await network.step(link('A', 'B'));
        await network.step({ type: 'author', action: insert('A', 1) });
        await network.step({ type: 'author', action: insert('A', 2, ['A1']) });
        await send(network, 'A', 'B', ['A2'], 'pending');
        await network.step({ type: 'author', action: insert('B', 1) });
      }, factory),
    ).rejects.toThrow('retains prior canonical action A2');
  });

  it('rejects loss of an independent previously held action during delivery', async () => {
    const base = transportProbe();
    const factory: ReplicaFactory = {
      async open(input) {
        let port = await base.open(input);
        let received = false;
        return {
          get handles() {
            return port.handles;
          },
          author: (action) => port.author(action),
          setMode: (mode) => port.setMode(mode),
          exportUpdate: (ids, mutation) => port.exportUpdate(ids, mutation),
          async receive(bytes, route) {
            if (input.peer === 'B' && received) {
              await port.dispose();
              port = await base.open(input);
            }
            await port.receive(bytes, route);
            received = true;
          },
          control: () => port.control(),
          receiveControl: (bytes) => port.receiveControl(bytes),
          observe: () => port.observe(),
          isolationState: () => port.isolationState(),
          checkpoint: () => port.checkpoint(),
          maintain: (operation) => port.maintain(operation),
          dispose: () => port.dispose(),
        };
      },
    };
    await expect(
      withNetwork(async (network) => {
        await network.step(link('A', 'B'));
        await network.step(link('C', 'B'));
        await network.step({ type: 'author', action: insert('A', 1) });
        await send(network, 'A', 'B', ['A1'], 'first');
        await network.step({ type: 'author', action: insert('C', 1) });
        await send(network, 'C', 'B', ['C1'], 'independent');
      }, factory),
    ).rejects.toThrow('retains prior canonical action A1');
  });

  it.each(['restart', 'replay'] as const)(
    'rejects %s that re-encodes the same envelopes with new outer native identities',
    async (type) => {
      const base = incrementalTransport();
      const factory: ReplicaFactory = {
        async open(input) {
          if (!input.checkpoint) return base.open(input);
          const original = new Doc({ gc: false });
          const rewritten = new Doc({ gc: false });
          try {
            applyUpdate(original, input.checkpoint);
            rewritten
              .getArray<Uint8Array>('envelopes')
              .push(original.getArray<Uint8Array>('envelopes').toArray());
            return await base.open({ ...input, checkpoint: encodeStateAsUpdate(rewritten) });
          } finally {
            original.destroy();
            rewritten.destroy();
          }
        },
      };
      await expect(
        withNetwork(async (network) => {
          await network.step(link('A', 'B'));
          await network.step({ type: 'author', action: insert('A', 1) });
          await send(network, 'A', 'B', ['A1'], 'prefix');
          await network.step({ type, peer: 'B' });
        }, factory),
      ).rejects.toThrow('canonical native state');
    },
  );

  it('rejects loss of payload variants even when the action identity remains held', async () => {
    let loseVariant = false;
    const factory = alter(transportProbe(), (port, peer) => ({
      ...port,
      async observe() {
        const state = await port.observe();
        if (peer !== 'B' || !state.held.includes('A1')) return state;
        return { ...state, variants: { ...state.variants, A1: loseVariant ? 1 : 2 } };
      },
      async receive(bytes, route) {
        await port.receive(bytes, route);
        if (peer === 'B' && (await port.observe()).held.includes('C1')) loseVariant = true;
      },
    }));
    await expect(
      withNetwork(async (network) => {
        await network.step(link('A', 'B'));
        await network.step(link('C', 'B'));
        await network.step({ type: 'author', action: insert('A', 1) });
        await network.step({ type: 'author', action: insert('A', 2, ['A1']) });
        await send(network, 'A', 'B', ['A1'], 'first');
        await network.step({ type: 'author', action: insert('C', 1) });
        await send(network, 'C', 'B', ['C1'], 'variant-loss');
      }, factory),
    ).rejects.toThrow('retains prior payload variants A1');
  });
  it('rejects shared state handles and disposes every opened replica', async () => {
    let disposed = 0;
    const shared = {};
    const factory = alter(transportProbe(), (port) => ({
      ...port,
      handles: { ...port.handles, history: shared },
      dispose() {
        disposed++;
        return port.dispose();
      },
    }));
    await expect(ReplicaNetwork.open(factory, contract, equal)).rejects.toThrow(
      'separate action store',
    );
    expect(disposed).toBe(3);
  });
  it('rejects a receive gate that applies remote updates in outbound-only mode', async () => {
    const factory = alter(transportProbe(), (port, peer) => ({
      ...port,
      setMode(mode) {
        return port.setMode(peer === 'A' ? 'bidirectional' : mode);
      },
    }));
    await expect(
      withNetwork(async (network) => {
        await network.step(link('B', 'A'));
        await network.step({ type: 'mode', peer: 'A', mode: 'outbound-only' });
        await network.step({ type: 'author', action: insert('B', 1) });
        await send(network, 'B', 'A', ['B1'], 'leak');
      }, factory),
    ).rejects.toThrow('A isolated during deliver');
  });
  it('rejects unclosed ready sets even if the projection stays empty', async () => {
    const factory = alter(transportProbe(), (port, peer) => ({
      ...port,
      async observe() {
        const state = await port.observe();
        return peer === 'B' && state.pending.length
          ? { ...state, ready: state.held, pending: [] }
          : state;
      },
    }));
    await expect(
      withNetwork(async (network) => {
        await network.step(link('A', 'B'));
        await network.step({ type: 'author', action: insert('A', 1) });
        await network.step({ type: 'author', action: insert('A', 2, ['A1']) });
        await send(network, 'A', 'B', ['A2'], 'partial');
      }, factory),
    ).rejects.toThrow('ready dependency A1');
  });
  it('rejects acknowledgments that import document actions', async () => {
    const factory = alter(transportProbe(), (port, peer) => ({
      ...port,
      async receiveControl(bytes) {
        await port.receiveControl(bytes);
        if (peer === 'A') await port.author(insert('A', 1));
      },
    }));
    await expect(
      withNetwork(async (network) => {
        await network.step(link('A', 'B', true));
        await send(network, 'A', 'B', [], 'empty');
        await network.step({ type: 'ack', id: 'empty' });
      }, factory),
    ).rejects.toThrow('A isolated during ack');
  });
  it('rejects checkpoint data loss and disposes fresh replay instances after failure', async () => {
    let disposed = 0;
    const base = transportProbe();
    const factory: ReplicaFactory = {
      async open(input) {
        const port = await base.open({ ...input, checkpoint: undefined });
        return {
          ...port,
          dispose() {
            disposed++;
            return port.dispose();
          },
        };
      },
    };
    await withNetwork(async (network) => {
      await network.step({ type: 'author', action: insert('A', 1) });
      await expect(network.step({ type: 'replay', peer: 'A' })).rejects.toThrow('fresh replay');
      expect(disposed).toBe(1);
    }, factory);
    expect(disposed).toBe(4);
  });
});

it('allows readiness changes and additional variants without losing canonical inventory', async () => {
  const factory = alter(transportProbe(), (port, peer) => ({
    ...port,
    async observe() {
      const state = await port.observe();
      if (peer !== 'B' || !state.held.includes('C1')) return state;
      return {
        ...state,
        pending: [],
        quarantined: ['A2'],
        variants: { ...state.variants, A2: 2 },
      };
    },
  }));
  await withNetwork(async (network) => {
    await network.step(link('A', 'B'));
    await network.step(link('C', 'B'));
    await network.step({ type: 'author', action: insert('A', 1) });
    await network.step({ type: 'author', action: insert('A', 2, ['A1']) });
    await send(network, 'A', 'B', ['A2'], 'pending');
    expect((await network.observe('B')).pending).toEqual(['A2']);
    await network.step({ type: 'author', action: insert('C', 1) });
    await send(network, 'C', 'B', ['C1'], 'quarantine');
    const state = await network.observe('B');
    expect(state.quarantined).toEqual(['A2']);
    expect(state.variants.A2).toBe(2);
    expect(state.held).toEqual(['C1', 'A2']);
    await network.step({ type: 'restart', peer: 'B' });
    await network.step({ type: 'replay', peer: 'B' });
  }, factory);
});

function localActions() {
  // Metadata for authored inputs, never expected projection outcomes.
  const generatedLamports = new Map<string, number>();
  return (
    peer: string,
    state: Observation,
    random: SeededRandom,
  ): NetworkStep & { type: 'author' } => {
    const own = state.held.filter((id) => id.startsWith(peer));
    const sequence = Math.max(0, ...own.map((id) => Number(id.slice(1)))) + 1;
    // All generated actions must observe the actual ready heads, including after restart.
    const dependencies = [...state.heads];
    const lamport = 1 + Math.max(0, ...state.ready.map((id) => generatedLamports.get(id) ?? 0));
    const action = insert(peer, sequence, dependencies, lamport);
    const visible = Object.values(state.visible).flat();
    let result = action;
    if (state.undo.length && random.next(4) === 0) {
      const group = state.undo.at(-1)!;
      result = {
        ...action,
        intents: [{ type: 'control', group, actions: [group], active: false, previous: null }],
      };
    } else if (visible.length && random.next(4) === 0)
      result = {
        ...action,
        intents: [
          {
            type: 'delete-text',
            tag: `d${action.id}`,
            cells: [visible[random.next(visible.length)]],
          },
        ],
      };
    generatedLamports.set(action.id, lamport);
    return { type: 'author', action: result };
  };
}
// Each seed generates the full 80-step trace twice and replays it on fresh replicas.
// Allow slower CI runners to finish all convergence and identity assertions.
it.each([0, 1, 88, 0xffff_ffff])(
  'records and replays seeded partitions, local deletes and undo (%s)',
  async (seed) => {
    const generate = async () => {
      const network = await ReplicaNetwork.open(transportProbe(), contract, equal, seed);
      try {
        for (const from of contract.peers)
          for (const to of contract.peers) if (from !== to) await network.step(link(from, to));
        await network.generate(80, localActions());
        for (const peer of contract.peers)
          await network.step({ type: 'mode', peer, mode: 'bidirectional' });
        for (const from of contract.peers)
          for (const to of contract.peers)
            if (from !== to)
              await send(
                network,
                from,
                to,
                [...(await network.observe(from)).held],
                `final-${from}-${to}`,
              );
        const converged = (await network.observe('A')).held;
        for (const peer of contract.peers) {
          expect((await network.observe(peer)).held).toEqual(converged);
          await network.step({ type: 'replay', peer });
        }
        const trace = network.trace();
        return encodeNetworkTrace(trace);
      } finally {
        await network.dispose();
      }
    };
    const first = await generate();
    expect(await generate()).toBe(first);
    const decoded = decodeNetworkTrace(first);
    expect(
      decoded.steps.some(
        (step) =>
          step.type === 'author' &&
          step.action.intents.some((intent) => intent.type === 'delete-text'),
      ),
    ).toBe(true);
    expect(
      decoded.steps.some(
        (step) =>
          step.type === 'author' && step.action.intents.some((intent) => intent.type === 'control'),
      ),
    ).toBe(true);
    await replayNetworkTrace(transportProbe(), decoded, equal);
  },
  60_000,
);
it('round trips exact uint64 counters and rejects bad trace versions, seeds and counters', () => {
  const trace = {
    version: 1 as const,
    seed: 0,
    contract,
    steps: [
      {
        type: 'author' as const,
        action: { ...insert('A', 1), sequence: (1n << 64n) - 1n, lamport: (1n << 64n) - 1n },
      },
    ],
  };
  expect(decodeNetworkTrace(encodeNetworkTrace(trace))).toEqual(trace);
  expect(() => decodeNetworkTrace(encodeNetworkTrace({ ...trace, version: 2 } as never))).toThrow(
    'Unsupported',
  );
  expect(() => decodeNetworkTrace(encodeNetworkTrace({ ...trace, seed: -1 }))).toThrow('Seed');
  expect(() =>
    decodeNetworkTrace(
      encodeNetworkTrace(trace).replace('18446744073709551615', '18446744073709551616'),
    ),
  ).toThrow('overflow');
  expect(() =>
    decodeNetworkTrace(encodeNetworkTrace(trace).replace('18446744073709551615', '1.5')),
  ).toThrow('Invalid trace counter');
  expect(() => new SeededRandom(-1)).toThrow('Seed');
  expect(() => new SeededRandom(1).next(0)).toThrow('limit');
});

it('merges real outer updates without manufacturing semantic prerequisites', async () => {
  await withNetwork(async (network) => {
    await network.step(link('A', 'B'));
    await network.step({ type: 'author', action: insert('A', 1) });
    await network.step({ type: 'author', action: insert('A', 2, ['A1']) });
    for (const [id, actions] of [
      ['first', ['A1']],
      ['second', ['A2']],
    ] as const)
      await network.step({ type: 'send', id, from: 'A', to: 'B', actions, route: 'peer' });
    await network.step({ type: 'merge', id: 'merged', sources: ['second', 'first', 'second'] });
    await network.step({ type: 'deliver', id: 'merged' });
    expect((await network.observe('B')).ready).toEqual(['A1', 'A2']);
    await network.step({ type: 'replay', peer: 'B' });
  });
});

const modes = ['bidirectional', 'outbound-only', 'inbound-only', 'disconnected'] as const;
it.each(modes.flatMap((source) => modes.map((target) => ({ source, target }))))(
  'gates $source → $target on every route while local editing remains available',
  async ({ source, target }) => {
    await withNetwork(async (network) => {
      await network.step({ type: 'mode', peer: 'A', mode: source });
      await network.step({ type: 'mode', peer: 'B', mode: target });
      await network.step({ type: 'author', action: insert('A', 1) });
      await network.step({ type: 'author', action: insert('B', 1) });
      for (const route of ['peer', 'catch-up', 'self-echo', 'cross-tab'] as const)
        await network.executeContractStep({
          type: 'deliver',
          from: 'A',
          to: 'B',
          actions: ['A1'],
          route,
        });
      const received =
        (source === 'bidirectional' || source === 'outbound-only') &&
        (target === 'bidirectional' || target === 'inbound-only');
      expect((await network.observe('B')).held).toEqual(received ? ['A1', 'B1'] : ['B1']);
      expect((await network.observe('B')).undo).toEqual(['B1']);
      expect((await network.observe('A')).held).toEqual(['A1']);
    });
  },
);

it('connects the existing semantic trace runner to three ports without passing expected states to the factory', async () => {
  const factory = transportProbe();
  let opened = 0;
  const guarded: ReplicaFactory = {
    async open(input) {
      expect(Object.keys(input.genesis).sort()).toEqual(['genesis', 'peers', 'seed', 'version']);
      opened++;
      return factory.open(input);
    },
  };
  const trace: ContractTrace = {
    ...contract,
    steps: [
      { type: 'author', action: insert('A', 1) },
      { type: 'deliver', from: 'A', to: 'B', actions: ['A1'], route: 'peer' },
      { type: 'expect', peer: 'B', state: { ready: ['A1'], markdown: 'a\n', undo: [] } },
      { type: 'restart', peer: 'B' },
      { type: 'expect', peer: 'B', state: { ready: ['A1'], markdown: 'a\n', undo: [] } },
    ],
  };
  await runContractTrace(replicaTraceAdapter(guarded, equal), trace, equal);
  expect(opened).toBe(4);
});

it('preserves local redo across remote edits and restores the same native identities once', async () => {
  await withNetwork(async (network) => {
    await network.step(link('A', 'B'));
    await network.step({ type: 'author', action: insert('A', 1) });
    await network.step({ type: 'author', action: insert('B', 1) });
    const native = (await network.observe('B')).nativeIds['B1:text'];
    await network.step({
      type: 'author',
      action: {
        ...insert('B', 2, ['B1']),
        intents: [{ type: 'control', group: 'B1', actions: ['B1'], active: false, previous: null }],
      },
    });
    await send(network, 'A', 'B', ['A1'], 'remote');
    expect((await network.observe('B')).redo).toEqual(['B1']);
    await network.step({
      type: 'author',
      action: {
        ...insert('B', 3, ['A1', 'B2']),
        intents: [{ type: 'control', group: 'B1', actions: ['B1'], active: true, previous: 'B2' }],
      },
    });
    const after = await network.observe('B');
    expect(after.nativeIds['B1:text']).toEqual(native);
    expect(after.visible.P.filter((id) => id === 'B1:text')).toHaveLength(1);
    expect(after.undo).toEqual(['B1']);
    expect(after.redo).toEqual([]);
  });
});

it('rejects remote navigation leaks even when document convergence is correct', async () => {
  const factory = alter(transportProbe(), (port, peer) => ({
    ...port,
    async observe() {
      const state = await port.observe();
      return peer === 'B' && state.held.includes('A1') ? { ...state, undo: ['A1'] } : state;
    },
  }));
  await expect(
    withNetwork(async (network) => {
      await network.step(link('A', 'B'));
      await network.step({ type: 'author', action: insert('A', 1) });
      await send(network, 'A', 'B', ['A1'], 'history-leak');
    }, factory),
  ).rejects.toThrow('remote delivery preserves local undo');
});

it('rejects unsupported saved commands instead of silently treating them as no-ops', async () => {
  const trace = decodeNetworkTrace(
    JSON.stringify({ version: 1, seed: 0, contract, steps: [{ type: 'unknown' }] }),
  );
  await expect(replayNetworkTrace(transportProbe(), trace, equal)).rejects.toThrow(
    'Unsupported network step',
  );
});

it('detects raw canonical contamination hidden from the semantic observation', async () => {
  const factory = alter(transportProbe(), (port, peer) => ({
    ...port,
    async receive(bytes, route) {
      await port.receive(bytes, route);
      if (peer === 'A')
        (port.handles.actionStore as Doc).getMap('unexpected-remote-data').set('value', true);
    },
  }));
  await expect(
    withNetwork(async (network) => {
      await network.step(link('B', 'A'));
      await network.step({ type: 'mode', peer: 'A', mode: 'outbound-only' });
      await network.step({ type: 'author', action: insert('B', 1) });
      await send(network, 'B', 'A', ['B1'], 'raw-leak');
    }, factory),
  ).rejects.toThrow('A raw canonical/native isolation during deliver');
});
