/** Test instrument only: real independent Yjs stores plus a deliberately small text/tag model.
 * This is NOT a schema-3 codec, ownership reducer, production transport, or MW-08 adapter.
 * Unsupported semantic intents fail explicitly. Do not run the semantic corpus against it.
 */
import * as Y from 'yjs';
import { SYNC_DIRECTIONS } from '../../src/markdown/multiwriter/contracts.js';
import type { NativeRange, SyncMode } from '../../src/markdown/multiwriter/contracts.js';
import type { Observation, TraceAction } from './trace.js';
import type { ReplicaFactory, ReplicaPort } from './network.js';

interface RecordBody {
  readonly action: TraceAction;
  readonly update: number[];
  readonly cells: Record<string, NativeRange & { text: string }>;
}
const encode = (value: unknown) =>
  new TextEncoder().encode(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? { counter: item.toString() } : item,
    ),
  );
const decode = <T>(value: Uint8Array): T =>
  JSON.parse(new TextDecoder().decode(value), (_key, item) =>
    item && typeof item === 'object' && 'counter' in item ? BigInt(item.counter) : item,
  );
const rank = (a: TraceAction, b: TraceAction) =>
  a.lamport < b.lamport
    ? -1
    : a.lamport > b.lamport
      ? 1
      : a.peer < b.peer
        ? -1
        : a.peer > b.peer
          ? 1
          : a.sequence < b.sequence
            ? -1
            : a.sequence > b.sequence
              ? 1
              : 0;

export function transportProbe(): ReplicaFactory {
  return {
    open({ peer, genesis, checkpoint }): ReplicaPort {
      if (genesis.seed.some((block) => (block.cells?.length ?? 0) > 0))
        throw new Error('Probe supports only empty seed text');
      const actionDoc = new Y.Doc({ gc: false });
      let textDoc = new Y.Doc({ gc: false });
      const reducer = { ready: [] as RecordBody[], applied: new Set<string>() };
      const history = { undo: [] as string[], redo: [] as string[] };
      const envelopes = actionDoc.getArray<Uint8Array>('envelopes');
      let mode: SyncMode = 'bidirectional';
      const emitted: string[] = [];
      if (checkpoint) Y.applyUpdate(actionDoc, checkpoint);
      function records(): RecordBody[] {
        const records = new Map<string, RecordBody>();
        for (const bytes of envelopes.toArray()) {
          const record = decode<RecordBody>(bytes);
          const previous = records.get(record.action.id);
          if (previous && JSON.stringify(encode(previous)) !== JSON.stringify(encode(record)))
            throw new Error('Probe does not implement forks');
          records.set(record.action.id, record);
        }
        return [...records.values()].sort((a, b) => rank(a.action, b.action));
      }
      function materialize(): void {
        const all = records();
        const ready = new Set<string>();
        let progress = true;
        while (progress) {
          progress = false;
          for (const record of all)
            if (
              !ready.has(record.action.id) &&
              record.action.dependencies.every((id) => ready.has(id))
            ) {
              ready.add(record.action.id);
              progress = true;
            }
        }
        reducer.ready = all.filter((record) => ready.has(record.action.id));
        for (const record of reducer.ready)
          if (!reducer.applied.has(record.action.id)) {
            if (record.update.length) Y.applyUpdate(textDoc, Uint8Array.from(record.update));
            reducer.applied.add(record.action.id);
          }
      }
      function observe(): Observation {
        materialize();
        const all = records();
        const ready = reducer.ready.map((record) => record.action.id);
        const cells = Object.assign({}, ...reducer.ready.map((record) => record.cells)) as Record<
          string,
          NativeRange & { text: string }
        >;
        const active = new Map(reducer.ready.map((record) => [record.action.group, true]));
        for (const { action } of reducer.ready)
          for (const intent of action.intents)
            if (intent.type === 'control') active.set(intent.group, intent.active);
        const hidden = new Set<string>();
        for (const { action } of reducer.ready) {
          if (!active.get(action.group)) {
            for (const intent of action.intents)
              if (intent.type === 'insert') hidden.add(intent.cell);
            continue;
          }
          for (const intent of action.intents)
            if (intent.type === 'delete-text') for (const cell of intent.cells) hidden.add(cell);
        }
        const text = textDoc.getText('tP');
        const order: string[] = [];
        for (let index = 0; index < text.length; index++) {
          const id = Y.createRelativePositionFromTypeIndex(text, index).item!;
          const entry = Object.entries(cells).find(
            ([, cell]) => cell.client === id.client && cell.clock === id.clock,
          );
          if (entry) order.push(entry[0]);
        }
        const visible = order.filter((id) => !hidden.has(id));
        const resource = <K extends 'node' | 'flow' | 'run'>(kind: K, ordinal: number) => ({
          kind,
          ordinal,
          birth: { type: 'genesis' as const, genesisId: genesis.genesis },
        });
        return {
          nativeIds: Object.fromEntries(
            Object.entries(cells).map(([id, { client, clock, length }]) => [
              id,
              { client, clock, length },
            ]),
          ),
          resources: {
            root: resource('node', 0),
            P: resource('node', 1),
            fP: resource('flow', 2),
            rP: resource('run', 3),
          },
          held: all.map((record) => record.action.id),
          ready,
          pending: all
            .filter((record) => !ready.includes(record.action.id))
            .map((record) => record.action.id),
          quarantined: [],
          variants: Object.fromEntries(all.map((record) => [record.action.id, 1])),
          heads: ready.filter(
            (id) => !reducer.ready.some((record) => record.action.dependencies.includes(id)),
          ),
          rawParents: { root: null, P: 'root' },
          flowParents: { fP: 'block:P' },
          runFlows: { rP: 'fP' },
          cellRuns: Object.fromEntries(Object.keys(cells).map((id) => [id, 'rP'])),
          nativeText: Object.fromEntries(
            Object.entries(cells).map(([id, cell]) => [id, cell.text]),
          ),
          skeletons: { rP: order },
          slots: { 'P:end': 'rP' },
          visible: { P: visible },
          hidden: [...hidden].sort(),
          deletedNodes: [],
          view: [{ id: 'P', parent: 'root', kind: 'paragraph' }],
          addresses: {},
          undo: [...history.undo],
          redo: [...history.redo],
          retainedActions: all.map((record) => record.action.id),
          genesis: genesis.genesis,
          emittedActions: [...emitted],
          activePackets: [],
          markdown: visible.map((id) => cells[id].text).join('') + '\n',
        };
      }
      materialize();
      textDoc.clientID =
        10 +
        genesis.peers.indexOf(peer as 'A' | 'B' | 'C') +
        records().filter((record) => record.action.peer === peer).length * 10;
      return {
        get handles() {
          return { actionStore: actionDoc, textCache: textDoc, reducer, history };
        },
        author(action) {
          materialize();
          for (const intent of action.intents)
            if (!['insert', 'delete-text', 'control'].includes(intent.type))
              throw new Error(`Unsupported probe intent ${intent.type}`);
          const state = observe();
          if (action.peer !== peer || action.dependencies.some((id) => !state.ready.includes(id)))
            throw new Error('Invalid probe causal authoring');
          const update: number[] = [];
          const cells: RecordBody['cells'] = {};
          const capture = (bytes: Uint8Array) => update.push(...bytes);
          textDoc.on('update', capture);
          try {
            textDoc.transact(() => {
              for (const intent of action.intents)
                if (intent.type === 'insert') {
                  if (intent.text.length !== 1 || intent.tape !== 'tP')
                    throw new Error('Probe inserts one UTF-16 unit on tP');
                  const text = textDoc.getText('tP');
                  const index = text.length;
                  text.insert(index, intent.text);
                  const id = Y.createRelativePositionFromTypeIndex(text, index).item!;
                  cells[intent.cell] = {
                    client: id.client,
                    clock: id.clock,
                    length: 1,
                    text: intent.text,
                  };
                }
            });
          } finally {
            textDoc.off('update', capture);
          }
          reducer.applied.add(action.id);
          envelopes.push([encode({ action, update, cells })]);
          emitted.push(action.id);
          const control = action.intents.find((intent) => intent.type === 'control');
          if (control?.type === 'control') {
            if (control.active) {
              history.redo = history.redo.filter((group) => group !== control.group);
              history.undo.push(control.group);
            } else {
              history.undo = history.undo.filter((group) => group !== control.group);
              history.redo.push(control.group);
            }
          } else {
            history.undo.push(action.group);
            history.redo = [];
          }
        },
        setMode(value) {
          mode = value;
        },
        exportUpdate(ids, mutation) {
          if (mutation) throw new Error('Probe has no schema-3 fault validator');
          const carrierDoc = new Y.Doc({ gc: false });
          try {
            const all = records();
            carrierDoc
              .getArray<Uint8Array>('envelopes')
              .push(ids.map((id) => encode(all.find((record) => record.action.id === id)!)));
            return Y.encodeStateAsUpdate(carrierDoc);
          } finally {
            carrierDoc.destroy();
          }
        },
        receive(bytes) {
          if (SYNC_DIRECTIONS[mode].receive) {
            Y.applyUpdate(actionDoc, bytes);
            materialize();
          }
        },
        control() {
          return Y.encodeStateVector(actionDoc);
        },
        receiveControl(bytes) {
          Y.decodeStateVector(bytes);
        },
        observe,
        isolationState() {
          return {
            canonical: Y.encodeStateAsUpdate(actionDoc),
            native: Y.encodeStateAsUpdate(textDoc),
          };
        },
        checkpoint() {
          return Y.encodeStateAsUpdate(actionDoc);
        },
        maintain(operation) {
          if (operation === 'evict-history') {
            history.undo = [];
            history.redo = [];
          } else if (operation === 'drop-caches') {
            textDoc.destroy();
            textDoc = new Y.Doc({ gc: false });
            reducer.ready = [];
            reducer.applied.clear();
            materialize();
          } else {
            // Exercise lossless Yjs checkpoint exchange without claiming a crash-safe host adapter.
            const copy = new Y.Doc({ gc: false });
            try {
              Y.applyUpdate(copy, Y.encodeStateAsUpdate(actionDoc));
              Y.applyUpdate(actionDoc, Y.encodeStateAsUpdate(copy));
            } finally {
              copy.destroy();
            }
          }
        },
        dispose() {
          actionDoc.destroy();
          textDoc.destroy();
        },
      };
    },
  };
}
