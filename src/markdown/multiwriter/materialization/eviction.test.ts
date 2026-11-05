import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { compareBytes } from '../actions/cbor.js';
import { MaterializedPublication } from './publication.js';
import { openMaterializedDocument } from './document.js';

function materialized(p: ReturnType<typeof commandReplica>) {
  if (
    !('cacheDiagnostics' in p.document) ||
    !(p.document.publication instanceof MaterializedPublication)
  )
    throw new Error();
  return p.document;
}
const historyBytes = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item));

test('publication eviction releases readiness and author preimages while preserving active views and live history', () => {
  const genesis = commandGenesis('abcdef\n\ntail'),
    p = commandReplica(genesis, undefined, 'materialized'),
    peer = commandReplica(genesis, undefined, 'materialized'),
    oracle = createMaterializationOracle();
  const h = p.editor.session('eviction'),
    nodeId = p.handle(p.nodes()[0]);
  try {
    for (let i = 0; i < 16; i++)
      expect(h.edit(insertText, { nodeId, from: 1, to: 2, text: i % 2 ? 'b' : 'x' }).status).toBe(
        'applied',
      );
    const document = materialized(p),
      before = document.publication.status().publication!,
      canonical = document.store.encodeUpdate(),
      native = before.native.encodeState(),
      owners = before.value.ownership.assignments,
      history = historyBytes(h.groups());
    peer.receive(canonical);
    expect(document.cacheDiagnostics().author).toMatchObject({
      nativeBranch: true,
      certificates: 16,
      preimages: 16,
    });
    expect(document.cacheDiagnostics().author.encodedBytes).toBeGreaterThan(0);
    expect(document.cacheDiagnostics().author.preimageNativeBytes).toBeGreaterThan(0);
    expect(document.cacheDiagnostics().readiness.certificates).toBe(16);
    const events: Uint8Array[] = [];
    const off = document.store.onUpdate((bytes) => events.push(bytes));
    try {
      document.publication.evict();
      expect(events).toHaveLength(0);
    } finally {
      off();
    }
    expect(document.cacheDiagnostics()).toMatchObject({
      author: {
        nativeBranch: false,
        busy: false,
        certificates: 0,
        preimages: 0,
        encodedBytes: 0,
        preimageNativeBytes: 0,
      },
      readiness: {
        certificates: 0,
        stagedCertificates: 0,
        records: 0,
        ready: 0,
        dependencySources: 0,
      },
    });
    expect(document.publication.status().publication).toBe(before);
    expect(document.publication.status().canAuthor).toBe(true);
    expect(compareBytes(document.store.encodeUpdate(), canonical)).toBe(0);
    expect(compareBytes(before.native.encodeState(), native)).toBe(0);
    expect(before.value.ownership.assignments).toEqual(owners);
    expect(historyBytes(h.groups())).toBe(history);
    // Catch up into the same writer/history instance after an old-prefix peer edit.
    expect(
      peer.editor.edit({ local: 'peer', group: 1n }, insertText, {
        nodeId: peer.handle(peer.nodes()[0]),
        from: 0,
        text: 'P',
      }).status,
    ).toBe('applied');
    p.receive(peer.document.store.encodeUpdate());
    expect(p.nodes()[0].content).toBe('Pabcdef');
    expect(h.undo().state).toBe('applied');
    expect(p.nodes()[0].content).toBe('Paxcdef');
    expect(h.redo().state).toBe('applied');
    expect(p.nodes()[0].content).toBe('Pabcdef');
    expect(h.edit(insertText, { nodeId, from: 2, to: 3, text: '!' }).status).toBe('applied');
    oracle.check(document, genesis);
    const cold = commandReplica(genesis, document.store.encodeUpdate(), 'materialized');
    try {
      expect(cold.observe()).toEqual(p.observe());
    } finally {
      cold.close();
    }
  } finally {
    oracle.destroy();
    peer.close();
    p.close();
  }
});

test('eviction cancels a suspended ingest validator and preserves old native reads through recertification', () => {
  const genesis = commandGenesis('abc'),
    source = commandReplica(genesis, undefined, 'materialized'),
    document = openMaterializedDocument(genesis),
    oracle = createMaterializationOracle();
  const refresh = () => {
    let result = document.publication.refresh();
    while (result.state === 'deferred') result = result.continuation.resume();
    return result.value;
  };
  try {
    const before = refresh(),
      native = before.native.encodeState();
    expect(
      source.editor.edit({ local: 'source', group: 1n }, insertText, {
        nodeId: source.handle(source.nodes()[0]),
        from: 1,
        text: '😀',
      }).status,
    ).toBe('applied');
    document.store.applyUpdate(source.document.store.encodeUpdate());
    const canonical = document.store.encodeUpdate();
    let work = document.publication.refresh(0);
    for (let i = 0; !document.cacheDiagnostics().author.busy && i < 100000; i++) {
      if (work.state !== 'deferred') throw new Error('Published before validator suspension');
      work = work.continuation.resume(1);
    }
    expect(document.cacheDiagnostics().author.busy).toBe(true);
    document.publication.evict();
    expect(document.cacheDiagnostics().author).toMatchObject({
      busy: false,
      certificates: 0,
      preimages: 0,
      nativeBranch: false,
    });
    if (work.state !== 'deferred') throw new Error('Missing suspended validator');
    expect(() => work.continuation.resume(1)).toThrow(/invalidated/);
    expect(document.publication.status().publication).toBe(before);
    expect(compareBytes(before.native.encodeState(), native)).toBe(0);
    refresh();
    oracle.check(document, genesis);
    expect(compareBytes(document.store.encodeUpdate(), canonical)).toBe(0);
    expect(compareBytes(before.native.encodeState(), native)).toBe(0);
  } finally {
    oracle.destroy();
    document.destroy();
    source.close();
  }
});
