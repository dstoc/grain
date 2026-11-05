import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertText, cycleTaskState } from '../authoring/index.js';
import { DirectionalActionProvider } from '../providers/adapter.js';
import type { CheckpointActionJournal } from '../providers/types.js';
import { journalBytes, decodeCheckpoint } from '../checkpoints/index.js';
import { compareBytes } from '../actions/cbor.js';
import { MaterializedPublication } from './publication.js';
import { IndexedActionStore } from './readiness.js';

class Journal implements CheckpointActionJournal {
  checkpoint?: Uint8Array;
  updates: Uint8Array[] = [];
  async read() {
    if (this.checkpoint) throw new Error('Checkpoint requires a capable reader');
    return this.updates.map((u) => u.slice());
  }
  async readCheckpoint() {
    return {
      ...(this.checkpoint ? { checkpoint: this.checkpoint.slice() } : {}),
      updates: this.updates.map((u) => u.slice()),
    };
  }
  async append(update: Uint8Array) {
    this.updates.push(update.slice());
  }
  async replaceWithCheckpoint(checkpoint: Uint8Array) {
    this.checkpoint = checkpoint.slice();
    this.updates = [];
  }
  close() {}
}
const bytesOf = (value: unknown) =>
  new TextEncoder().encode(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  ).byteLength;

test('501 managed groups, strict one-way history, MW-18 consolidation and old-prefix catch-up preserve every fact', async () => {
  const genesis = commandGenesis('- [ ] keep');
  const a = commandReplica(genesis, undefined, 'materialized');
  const b = commandReplica(genesis, undefined, 'materialized');
  const c = commandReplica(genesis, undefined, 'materialized');
  const journals = [new Journal(), new Journal(), new Journal()];
  const peers = [a, b, c];
  const ios: DirectionalActionProvider[] = [];
  const oracle = createMaterializationOracle();
  let restarted: ReturnType<typeof commandReplica> | undefined;
  let restartedIo: DirectionalActionProvider | undefined;
  try {
    for (let i = 0; i < peers.length; i++)
      ios.push(
        await DirectionalActionProvider.open({
          store: peers[i].document.store,
          journal: journals[i],
          mode: i === 0 ? 'outbound-only' : 'bidirectional',
        }),
      );
    const h = a.editor.session('A'),
      bh = b.editor.session('B');
    const bNative = b.editor.nativeClientId;
    const identities = a.observe().identities;
    const materializer = a.document.publication;
    if (!(materializer instanceof MaterializedPublication))
      throw new Error('Expected materializer');
    const indexedStore = a.document.store;
    if (!(indexedStore instanceof IndexedActionStore))
      throw new Error('Expected indexed readiness');
    const initial = a.document.store.encodeUpdate();
    let receivedMessages = 0,
      receivedBytes = 0;
    ios[0].attachPeer('C', {
      acknowledgments: false,
      send: async (message) => {
        receivedMessages++;
        receivedBytes += message.update.byteLength;
        expect(ios[2].receive('peer', message.update)).toBe(true);
        c.editor.refresh();
      },
    });
    let previousChecked = a.view().root.children[0].children[0].checked;
    for (let i = 0; i < 501; i++) {
      if (i === 500) previousChecked = a.view().root.children[0].children[0].checked;
      expect(
        h.edit(cycleTaskState, { nodeId: a.handle(a.view().root.children[0].children[0]) }).status,
      ).toBe('applied');
      oracle.check(a.document, genesis);
      if ((i + 1) % 50 === 0) console.info(`actual managed history: ${i + 1} groups`);
    }
    expect(h.status()).toMatchObject({ undo: 500, redo: 0, limit: 500 });
    expect(h.groups().undo[0].group.sequence).toBe(2n);
    expect(a.document.store.snapshot().ready).toHaveLength(501);
    expect(a.observe().identities).toEqual(identities);
    const metadata500 = bytesOf(h.groups());
    const canonical501 = a.document.store.encodeUpdate(),
      native501 = a.observe().native;
    h.setLimit(2);
    expect(h.status()).toMatchObject({ undo: 2, redo: 0 });
    expect(compareBytes(a.document.store.encodeUpdate(), canonical501)).toBe(0);
    expect(compareBytes(a.observe().native, native501)).toBe(0);
    const metadata2 = bytesOf(h.groups());
    expect(metadata2).toBeLessThan(metadata500);
    expect(h.undo().state).toBe('applied');
    expect(a.view().root.children[0].children[0].checked).toBe(previousChecked);
    oracle.check(a.document, genesis);
    expect(h.redo().state).toBe('applied');
    oracle.check(a.document, genesis);
    // B is still the same writer opened at the original prefix, with its own stack.
    expect(compareBytes(b.document.store.encodeUpdate(), initial)).toBe(0);
    const isolatedA = a.document.store.encodeUpdate(),
      aHistory = h.groups();
    expect(
      bh.edit(insertText, { nodeId: b.handle(b.nodes()[0]), from: 2, text: 'old' }).status,
    ).toBe('applied');
    expect(bh.undo().state).toBe('applied');
    expect(bh.redo().state).toBe('applied');
    expect(b.editor.nativeClientId).toBe(bNative);
    // No reverse receive call, reverse link or acknowledgment occurs in this phase.
    expect(compareBytes(a.document.store.encodeUpdate(), isolatedA)).toBe(0);
    expect(h.groups()).toEqual(aHistory);
    await ios[0].publish();
    // A has no incoming link or acknowledgments. Repeated send retains the same controls.
    await ios[0].publish();
    expect(receivedMessages).toBeGreaterThan(0);
    expect(c.observe()).toEqual(a.observe());
    expect(c.editor.session('C').status().undo).toBe(0);
    await ios[0].flush();
    const canonical = a.document.store.encodeUpdate(),
      retained = a.document.store.retainedBytes();
    const beforeJournal = journalBytes(await journals[0].readCheckpoint());
    const liveHistory = h.groups();
    const old = a.document.publication.status().publication!,
      oldNative = old.native.encodeState();
    await ios[0].consolidate();
    const afterJournal = journalBytes(await journals[0].readCheckpoint());
    expect(compareBytes(decodeCheckpoint(journals[0].checkpoint!).update, canonical)).toBe(0);
    expect(a.document.store.retainedBytes()).toEqual(retained);
    expect(h.groups()).toEqual(liveHistory);
    materializer.evict();
    expect(compareBytes(old.native.encodeState(), oldNative)).toBe(0);
    expect(h.undo().state).toBe('applied');
    oracle.check(a.document, genesis);
    expect(h.redo().state).toBe('applied');
    oracle.check(a.document, genesis);
    // Remote history never becomes a local navigation group. Catch-up does not replace B.
    ios[0].setMode('bidirectional');
    expect(ios[0].receive('catch-up', b.document.store.encodeUpdate())).toBe(true);
    a.editor.refresh();
    oracle.check(a.document, genesis);
    expect(a.nodes()[0].content).toBe('keoldep');
    expect(h.status()).toMatchObject({ undo: 2, redo: 0 });
    expect(ios[1].receive('catch-up', a.document.store.encodeUpdate())).toBe(true);
    b.editor.refresh();
    expect(b.editor.nativeClientId).toBe(bNative);
    expect(bh.status()).toMatchObject({ undo: 1, redo: 0 });
    expect(b.observe()).toEqual(a.observe());
    // The old-prefix insertion identity survives original-anchor authoring and merge.
    const insertion = b.document.store
      .snapshot()
      .ready.find((entry) => entry.effects.some((e) => e.type === 'InsertText'))!
      .nativeManifest.find((entry) => entry.type === 'text')!;
    if (insertion.type !== 'text') throw new Error('Missing original insertion');
    expect(
      a.document.publication
        .status()
        .publication!.native.lookup({ tape: insertion.tape, ...insertion.native })
        .map((part) => part.text)
        .join(''),
    ).toBe('old');
    await ios[0].flush();
    await ios[0].close();
    restarted = commandReplica(genesis, undefined, 'materialized');
    restartedIo = await DirectionalActionProvider.open({
      store: restarted.document.store,
      journal: journals[0],
      mode: 'disconnected',
    });
    restarted.editor.refresh();
    oracle.check(restarted.document, genesis);
    expect(restarted.observe()).toEqual(a.observe());
    expect(restarted.editor.session('A').status()).toMatchObject({ undo: 0, redo: 0, reset: true });
    expect(compareBytes(old.native.encodeState(), oldNative)).toBe(0);
    console.info(
      JSON.stringify({
        kind: 'mw13-actual-mw10-mw18-501',
        groupsAuthored: 501,
        canonical: retained,
        storageJournal: {
          before: beforeJournal,
          after: afterJournal,
          afterTail: journalBytes(await journals[0].readCheckpoint()),
        },
        history: {
          method: 'serialized navigation metadata, not heap',
          groups500Bytes: metadata500,
          groups2Bytes: metadata2,
        },
        caches: {
          method: 'work counters only; heap not measured',
          work: materializer.diagnostics(),
          readiness: indexedStore.readinessDiagnostics(),
          activity: 'activityDiagnostics' in a.document ? a.document.activityDiagnostics() : null,
        },
        transport: {
          forwardMessages: receivedMessages,
          forwardBytes: receivedBytes,
          reverseMessagesDuringOneWay: 0,
        },
        genesisSeparate: true,
        fullMW13Acceptance: false,
      }),
    );
  } finally {
    await restartedIo?.close();
    restarted?.close();
    for (const io of ios) await io.close();
    for (const p of peers) p.close();
    oracle.destroy();
  }
}, 3600000);
