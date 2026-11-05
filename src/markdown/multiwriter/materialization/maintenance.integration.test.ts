import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { indent } from '../../../editing/commands/indent.js';
import { compareBytes } from '../actions/cbor.js';
import { DirectionalActionProvider } from '../providers/adapter.js';
import type { CheckpointActionJournal } from '../providers/types.js';
import { decodeCheckpoint, journalBytes } from '../checkpoints/index.js';
import { MaterializedPublication } from './publication.js';

class Journal implements CheckpointActionJournal {
  checkpoint?: Uint8Array;
  updates: Uint8Array[] = [];
  fail = false;
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
  async replaceWithCheckpoint(input: Uint8Array) {
    const copy = input.slice();
    if (this.fail) throw new Error('checkpoint storage unavailable');
    this.checkpoint = copy;
    this.updates = [];
  }
  close() {}
}
function applied(result: ReturnType<ReturnType<typeof commandReplica>['editor']['edit']>) {
  if (result.status !== 'applied') throw new Error('Expected an applied command');
  return result;
}
function check(p: ReturnType<typeof commandReplica>) {
  const bytes = p.document.store.encodeUpdate(),
    cold = commandReplica(p.genesis, bytes);
  try {
    expect(p.observe()).toEqual(cold.observe());
    expect(compareBytes(p.document.store.encodeUpdate(), bytes)).toBe(0);
  } finally {
    cold.close();
  }
}

test('real MW-18 consolidation, failed-prefix retry, cache eviction, restart and old-prefix input retain schema-3 facts', async () => {
  const genesis = commandGenesis('abcdef\n\ntail');
  const p = commandReplica(genesis, undefined, 'materialized');
  const offline = commandReplica(genesis, undefined, 'materialized');
  const journal = new Journal();
  const provider = await DirectionalActionProvider.open({
    store: p.document.store,
    journal,
    mode: 'bidirectional',
  });
  try {
    const splitHistory = p.editor.session('split');
    const history = p.editor.session('P');
    applied(
      splitHistory.edit(insertParagraph, {
        nodeId: p.handle(p.nodes()[0]),
        from: 3,
      }),
    );
    applied(history.edit(indent, { nodeId: p.handle(p.nodes()[1]) }));
    applied(
      history.edit(insertText, {
        nodeId: p.handle(p.nodes()[0]),
        from: 1,
        to: 2,
        text: '',
      }),
    );
    expect(splitHistory.undo().state).toBe('applied');
    expect(splitHistory.redo().state).toBe('applied');
    const historyBefore = splitHistory.groups();
    check(p);
    const canonical = p.document.store.encodeUpdate();
    const canonicalAtConsolidation = p.document.store.retainedBytes();
    const old = p.document.publication.status().publication!;
    const oldNative = old.native.encodeState();
    const beforeView = p.view();
    for (let i = 0; i < 3; i++) expect(provider.receive('self-echo', canonical)).toBe(true);
    p.editor.refresh();
    await provider.flush();
    const before = journalBytes(await journal.readCheckpoint());
    await provider.consolidate();
    const after = journalBytes(await journal.readCheckpoint());
    expect(after.totalBytes).toBeLessThan(before.totalBytes);
    expect(after.batchCount).toBe(0);
    expect(compareBytes(decodeCheckpoint(journal.checkpoint!).update, canonical)).toBe(0);
    expect(compareBytes(p.document.store.encodeUpdate(), canonical)).toBe(0);
    expect(p.document.store.retainedBytes()).toEqual(canonicalAtConsolidation);
    expect(p.view()).toEqual(beforeView);
    expect(splitHistory.groups()).toEqual(historyBefore);
    const materializer = p.document.publication;
    if (!(materializer instanceof MaterializedPublication)) throw new Error();
    materializer.evict();
    expect(compareBytes(old.native.encodeState(), oldNative)).toBe(0);
    applied(
      history.edit(insertText, {
        nodeId: p.handle(p.nodes()[0]),
        from: 0,
        text: 'next',
      }),
    );
    check(p);
    const prefix = p.document.store.encodeUpdate();
    await provider.flush();
    const storage = await journal.readCheckpoint();
    journal.fail = true;
    await expect(provider.consolidate()).rejects.toThrow('storage unavailable');
    expect(await journal.readCheckpoint()).toEqual(storage);
    applied(
      history.edit(insertText, {
        nodeId: p.handle(p.nodes()[0]),
        from: 1,
        text: 'late',
      }),
    );
    journal.fail = false;
    await provider.retryPersistence();
    expect(compareBytes(decodeCheckpoint(journal.checkpoint!).update, prefix)).toBe(0);
    expect(journal.updates.length).toBeGreaterThan(0);
    await provider.close();
    const restarted = commandReplica(genesis, undefined, 'materialized');
    const attachment = await DirectionalActionProvider.open({
      store: restarted.document.store,
      journal,
      mode: 'bidirectional',
    });
    try {
      restarted.editor.refresh();
      expect(restarted.observe()).toEqual(p.observe());
      expect(restarted.editor.session('split').status()).toMatchObject({
        undo: 0,
        redo: 0,
        reset: true,
      });
      // This writer still owns its original pre-maintenance native branch and anchors.
      const edit = applied(
        offline.editor.edit({ local: 'offline', group: 1n }, insertText, {
          nodeId: offline.handle(offline.nodes()[0]),
          from: 4,
          text: 'Ω',
        }),
      );
      expect(attachment.receive('catch-up', offline.document.store.encodeUpdate())).toBe(true);
      restarted.editor.refresh();
      check(restarted);
      const insertion = edit.envelope.nativeManifest.find((entry) => entry.type === 'text')!;
      if (insertion.type !== 'text') throw new Error();
      expect(
        restarted.document.publication
          .status()
          .publication!.native.lookup({ tape: insertion.tape, ...insertion.native })
          .map((v) => v.text)
          .join(''),
      ).toBe('Ω');
      expect(compareBytes(old.native.encodeState(), oldNative)).toBe(0);
      console.info(
        JSON.stringify({
          kind: 'mw13-mw18-native-integration',
          before,
          after,
          canonicalAtConsolidation,
          canonicalAfterContinuedEditing: p.document.store.retainedBytes(),
          genesisSeparate: true,
          productionHistory: 'MW-10 managed sessions',
          fullMW13Acceptance: false,
        }),
      );
    } finally {
      await attachment.close();
      restarted.close();
    }
  } finally {
    journal.fail = false;
    await provider.retryPersistence();
    await provider.close();
    p.close();
    offline.close();
  }
}, 120000);
