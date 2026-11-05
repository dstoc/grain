import { expect, test } from 'vitest';
import { replica, type, cleanup } from '../../../../test/multiwriter/history.js';
import { DirectionalActionProvider } from '../providers/adapter.js';
import type { CommandReplica } from '../../../../test/multiwriter/commands/replica.js';
import type { SyncMode } from '../contracts.js';
import { insertText, insertParagraph, indent, cycleTaskState } from '../authoring/index.js';
import { compareBytes } from '../actions/cbor.js';

async function provider(
  peer: CommandReplica,
  mode: SyncMode = 'bidirectional',
  journal: Uint8Array[] = [],
) {
  const io = await DirectionalActionProvider.open({
    store: peer.document.store,
    mode,
    journal: {
      read: async () => journal.map((b) => b.slice()),
      append: async (b) => {
        journal.push(b.slice());
      },
      close() {},
    },
  });
  peer.editor.refresh();
  cleanup(() => io.close());
  return io;
}

test('strict A→B controls need no reverse acknowledgment; remote edits and controls preserve redo', async () => {
  const a = replica(),
    b = replica('', a.genesis),
    c = replica('', a.genesis);
  const ai = await provider(a, 'outbound-only'),
    bi = await provider(b),
    ci = await provider(c);
  const h = a.editor.session(),
    bh = b.editor.session();
  ai.attachPeer('B', {
    acknowledgments: false,
    send: async (m) => {
      bi.receive('peer', m.update);
      b.editor.refresh();
    },
  });
  ai.attachPeer('C', {
    acknowledgments: false,
    send: async (m) => {
      ci.receive('peer', m.update);
      c.editor.refresh();
    },
  });
  type(a, 'A');
  h.undo();
  await ai.publish();
  await ai.flush();
  expect(b.markdown()).toBe('abcdef\n');
  expect(c.markdown()).toBe('abcdef\n');
  expect(bh.status().undo).toBe(0);
  type(b, 'B', 0);
  bh.undo();
  expect(ai.receive('peer', b.document.store.encodeUpdate())).toBe(false);
  expect(h.status()).toMatchObject({ undo: 0, redo: 1 });
  h.redo();
  await ai.publish();
  expect(b.markdown()).toBe('abcdefA\n');
  expect(bh.status().redo).toBe(1);
  ai.setMode('bidirectional');
  ai.receive('catch-up', b.document.store.encodeUpdate());
  a.editor.refresh();
  expect(h.status().undo).toBe(1);
  expect(h.status().redo).toBe(0);
  expect(a.observe()).toEqual(b.observe());
  bh.redo();
  ai.receive('peer', b.document.store.encodeUpdate());
  a.editor.refresh();
  h.undo();
  await ai.publish();
  expect(a.markdown()).toBe('Babcdef\n');
  expect(a.observe()).toEqual(b.observe());
});

for (const mode of ['bidirectional', 'outbound-only', 'inbound-only', 'disconnected'] as const)
  test(`${mode} mode and reconnect preserve live history; own-journal restart resets navigation`, async () => {
    const a = replica(),
      b = replica('', a.genesis),
      journal: Uint8Array[] = [];
    const ai = await provider(a, mode, journal),
      bi = await provider(b),
      h = a.editor.session();
    const updates: Uint8Array[] = [];
    ai.attachPeer('B', {
      acknowledgments: false,
      send: async (m) => {
        updates.push(m.update);
        bi.receive('peer', m.update);
        b.editor.refresh();
      },
    });
    type(a, 'A');
    h.undo();
    type(b, 'B', 0);
    const receive = ai.receive('catch-up', b.document.store.encodeUpdate());
    expect(receive).toBe(mode === 'bidirectional' || mode === 'inbound-only');
    a.editor.refresh();
    expect(h.status()).toMatchObject({ undo: 0, redo: 1 });
    ai.setMode('disconnected');
    h.redo();
    expect(h.status().undo).toBe(1);
    ai.setMode('bidirectional');
    await ai.publish();
    ai.receive('cross-tab', b.document.store.encodeUpdate());
    a.editor.refresh();
    await ai.publish();
    await ai.flush();
    expect(updates.length).toBeGreaterThan(0);
    expect(a.observe()).toEqual(b.observe());
    const cold = replica('', a.genesis),
      coldio = await provider(cold, 'disconnected', journal);
    expect(cold.observe()).toEqual(a.observe());
    expect(cold.editor.session().status()).toMatchObject({ undo: 0, redo: 0, reset: true });
    expect(coldio.receive('self-echo', a.document.store.encodeUpdate())).toBe(false);
    expect(cold.editor.session().status().undo).toBe(0);
  });

test('three providers retain reordered/duplicate controls before targets and converge on cold replay', async () => {
  const a = replica(),
    b = replica('', a.genesis),
    c = replica('', a.genesis),
    peers = [a, b, c];
  const ios = [await provider(a), await provider(b), await provider(c)];
  const deltas: Uint8Array[][] = peers.map(() => []);
  peers.forEach((peer, i) =>
    cleanup(peer.document.store.onUpdate((bytes) => deltas[i].push(bytes.slice()))),
  );
  type(a, 'A');
  a.editor.session().undo();
  b.editor.session().edit(insertParagraph, { nodeId: b.handle(b.nodes()[0]), from: 3 });
  type(b, 'B', 0);
  b.editor.session().undo();
  c.editor.session().edit(indent, { nodeId: c.handle(c.nodes()[0]) });
  const original = deltas.map((updates) => updates.slice());
  ios[2].receive('peer', original[0].at(-1)!);
  c.editor.refresh();
  expect(c.document.store.snapshot().ready).toHaveLength(1);
  for (let i = 0; i < peers.length; i++)
    for (const source of [2, 0, 1])
      if (i !== source)
        for (const bytes of original[source].slice().reverse()) {
          ios[i].receive('peer', bytes);
          ios[i].receive('self-echo', bytes);
          peers[i].editor.refresh();
        }
  for (const peer of peers) {
    expect(peer.observe()).toEqual(a.observe());
    const cold = replica('', a.genesis, peer.document.store.encodeUpdate());
    expect(cold.observe()).toEqual(peer.observe());
  }
  expect(a.editor.session().status()).toMatchObject({ undo: 0, redo: 1 });
  expect(b.editor.session().status()).toMatchObject({ undo: 1, redo: 1 });
  expect(c.editor.session().status()).toMatchObject({ undo: 1, redo: 0 });
});

test('persistence failure does not roll back managed edit or control and retries append no action', async () => {
  const a = replica(),
    h = a.editor.session(),
    journal: Uint8Array[] = [];
  let fail = true;
  const io = await DirectionalActionProvider.open({
    store: a.document.store,
    mode: 'disconnected',
    journal: {
      read: async () => [],
      append: async (b) => {
        if (fail) throw new Error('disk');
        journal.push(b.slice());
      },
      close() {},
    },
  });
  cleanup(async () => {
    fail = false;
    await io.retryPersistence();
    await io.close();
  });
  type(a, 'kept');
  h.undo();
  const publication = io.capturePublication(),
    bytes = a.document.store.encodeUpdate();
  await expect(io.flush()).rejects.toThrow('disk');
  expect(publication.status()).toMatchObject({ applied: true, persisted: false });
  expect(h.status()).toMatchObject({ undo: 0, redo: 1 });
  fail = false;
  await io.retryPersistence();
  await io.flush();
  expect(publication.status()).toMatchObject({ applied: true, persisted: true });
  expect(compareBytes(a.document.store.encodeUpdate(), bytes)).toBe(0);
  h.redo();
  expect(a.markdown()).toBe('abcdefkept\n');
});

test('501 actual groups evict metadata only and accept an old-prefix peer edit after cold replay', async () => {
  const a = replica('- [ ] keep'),
    b = replica('', a.genesis),
    h = a.editor.session();
  const ai = await provider(a, 'outbound-only'),
    bi = await provider(b, 'outbound-only');
  const baselineIds = a.observe().identities;
  for (let i = 0; i < 501; i++)
    h.edit(cycleTaskState, { nodeId: a.handle(a.view().root.children[0].children[0]) });
  expect(h.status()).toMatchObject({ undo: 500, redo: 0, limit: 500 });
  expect(a.document.store.snapshot().ready).toHaveLength(501);
  const bytes = a.document.store.encodeUpdate(),
    native = a.observe().native;
  h.setLimit(2);
  h.reset();
  expect(compareBytes(a.document.store.encodeUpdate(), bytes)).toBe(0);
  expect(compareBytes(a.observe().native, native)).toBe(0);
  expect(a.observe().identities).toEqual(baselineIds);
  const cold = replica('', a.genesis),
    ci = await provider(cold);
  ci.receive('catch-up', bytes);
  cold.editor.refresh();
  expect(cold.observe()).toEqual(a.observe());
  expect(cold.editor.session().status().reset).toBe(true);
  b.editor.session().edit(insertText, { nodeId: b.handle(b.nodes()[0]), from: 2, text: 'old' });
  ci.receive('peer', b.document.store.encodeUpdate());
  cold.editor.refresh();
  ai.setMode('bidirectional');
  ai.receive('peer', b.document.store.encodeUpdate());
  a.editor.refresh();
  bi.setMode('bidirectional');
  bi.receive('catch-up', a.document.store.encodeUpdate());
  b.editor.refresh();
  expect(cold.observe()).toEqual(a.observe());
  expect(b.observe()).toEqual(a.observe());
  expect(a.nodes()[0].content).toBe('keoldep');
}, 600_000);

test('peer typing after a split survives undo and redo with the same native identities', async () => {
  const a = replica(),
    b = replica('', a.genesis),
    ai = await provider(a),
    bi = await provider(b),
    h = a.editor.session();
  h.edit(insertParagraph, { nodeId: a.handle(a.nodes()[0]), from: 3 });
  bi.receive('peer', a.document.store.encodeUpdate());
  b.editor.refresh();
  b.editor.session().edit(insertText, { nodeId: b.handle(b.nodes()[1]), from: 1, text: 'X' });
  ai.receive('peer', b.document.store.encodeUpdate());
  a.editor.refresh();
  const native = a.observe().native,
    ids = a.observe().identities;
  h.undo();
  expect(a.nodes().map((n) => n.content)).toEqual(['abcdXef']);
  expect(a.observe().identities).toEqual(ids);
  expect(compareBytes(a.observe().native, native)).toBe(0);
  h.redo();
  expect(a.nodes().map((n) => n.content)).toEqual(['abc', 'dXef']);
  bi.receive('peer', a.document.store.encodeUpdate());
  b.editor.refresh();
  expect(a.observe()).toEqual(b.observe());
});

test('an independently authored peer child keeps an undone wrapper as a scaffold', async () => {
  const a = replica(),
    b = replica('', a.genesis),
    ai = await provider(a),
    bi = await provider(b),
    h = a.editor.session();
  h.edit(indent, { nodeId: a.handle(a.nodes()[0]) });
  bi.receive('peer', a.document.store.encodeUpdate());
  b.editor.refresh();
  const item = b.view().root.children[0].children[0];
  b.editor.session().edit(({ draft }, parent) => {
    const child = draft.create({ type: 'paragraph', content: 'peer' });
    draft.place(child, parent, null);
    return { status: 'handled' };
  }, b.handle(item));
  ai.receive('peer', b.document.store.encodeUpdate());
  a.editor.refresh();
  h.undo();
  expect(a.nodes().map((n) => n.content)).toEqual(expect.arrayContaining(['abcdef', 'peer']));
  expect(a.markdown()).toContain('- peer');
  h.redo();
  bi.receive('peer', a.document.store.encodeUpdate());
  b.editor.refresh();
  expect(a.observe()).toEqual(b.observe());
});

test('two independent deletion tags need two local controls; remote deletion never enters the stack', async () => {
  const { deleteBlocks } = await import('../authoring/index.js');
  const a = replica('first\n\nsecond'),
    b = replica('', a.genesis),
    ai = await provider(a),
    bi = await provider(b),
    h = a.editor.session();
  for (const p of [a, b])
    p.editor.session().edit(deleteBlocks, { nodeIds: [p.handle(p.nodes()[0])] });
  ai.receive('peer', b.document.store.encodeUpdate());
  a.editor.refresh();
  bi.receive('peer', a.document.store.encodeUpdate());
  b.editor.refresh();
  h.undo();
  expect(a.markdown()).toBe('second\n');
  expect(h.status()).toMatchObject({ undo: 0, redo: 1 });
  bi.receive('peer', a.document.store.encodeUpdate());
  b.editor.refresh();
  b.editor.session().undo();
  ai.receive('peer', b.document.store.encodeUpdate());
  a.editor.refresh();
  expect(a.markdown()).toBe('first\n\nsecond\n');
  expect(a.observe()).toEqual(b.observe());
});

test('redoing an older move preserves the priority of a newer peer move', async () => {
  const a = replica('one\n\ntwo\n\nthree'),
    b = replica('', a.genesis),
    ai = await provider(a),
    bi = await provider(b),
    h = a.editor.session();
  const move = (p: CommandReplica) =>
    p.editor.session().edit(
      ({ draft, scopeRoot }, [node, before]) => {
        draft.place(node, scopeRoot, before);
        return { status: 'handled' };
      },
      [p.handle(p.nodes()[0]), p.handle(p.nodes()[2])],
    );
  move(a);
  bi.receive('peer', a.document.store.encodeUpdate());
  b.editor.refresh();
  // B has observed A's move; place one after three with a strictly later intention.
  b.editor.session().edit(({ draft, scopeRoot }, node) => {
    draft.place(node, scopeRoot, null);
    return { status: 'handled' };
  }, b.handle(b.nodes()[1]));
  ai.receive('peer', b.document.store.encodeUpdate());
  a.editor.refresh();
  const before = a.markdown();
  h.undo();
  h.redo();
  expect(a.markdown()).toBe(before);
  expect(a.nodes().map((n) => n.content)).toEqual(['two', 'three', 'one']);
  bi.receive('peer', a.document.store.encodeUpdate());
  b.editor.refresh();
  expect(a.observe()).toEqual(b.observe());
});

for (const seed of [9, 90, 34064])
  test(`managed command histories converge through seeded provider partitions (${seed})`, async () => {
    const { SeededRandom } = await import('../../../../test/multiwriter/network.js');
    const { outdent, joinWithPrevious } = await import('../authoring/index.js');
    const random = new SeededRandom(seed),
      a = replica('alpha\n\nbeta'),
      peers = [a, replica('', a.genesis), replica('', a.genesis)];
    const ios = [await provider(peers[0]), await provider(peers[1]), await provider(peers[2])];
    const queued: { to: number; update: Uint8Array }[] = [];
    for (let step = 0; step < 36; step++) {
      const index = random.next(3),
        p = peers[index],
        h = p.editor.session(),
        choice = random.next(7);
      if (choice === 0) h.undo();
      else if (choice === 1) h.redo();
      else if (choice === 2 && p.nodes().length < 7)
        h.edit(insertParagraph, {
          nodeId: p.handle(p.nodes()[0]),
          from: Math.min(1, p.nodes()[0].content.length),
        });
      else if (choice === 3 && p.nodes().length > 1)
        h.edit(joinWithPrevious, { nodeId: p.handle(p.nodes()[1]) });
      else if (choice === 4) h.edit(indent, { nodeId: p.handle(p.nodes()[0]) });
      else if (choice === 5) h.edit(outdent, { nodeId: p.handle(p.nodes()[0]) });
      else type(p, String(step % 10), 0);
      for (let target = 0; target < peers.length; target++)
        if (target !== index) queued.push({ to: target, update: p.document.store.encodeUpdate() });
      if (step % 6 === 0)
        ios[random.next(3)].setMode(step % 12 === 0 ? 'disconnected' : 'outbound-only');
      if (queued.length && step % 2 === 0) {
        const [message] = queued.splice(random.next(queued.length), 1),
          before = peers[message.to].editor.session().groups();
        ios[message.to].receive('peer', message.update);
        ios[message.to].receive('self-echo', message.update);
        peers[message.to].editor.refresh();
        expect(peers[message.to].editor.session().groups()).toEqual(before);
      }
    }
    ios.forEach((io) => io.setMode('bidirectional'));
    for (let from = 0; from < peers.length; from++)
      for (let to = 0; to < peers.length; to++)
        if (from !== to) {
          ios[to].receive('catch-up', peers[from].document.store.encodeUpdate());
          peers[to].editor.refresh();
        }
    for (const p of peers) {
      expect(p.observe()).toEqual(a.observe());
      const cold = replica('', a.genesis, p.document.store.encodeUpdate());
      expect(cold.observe()).toEqual(p.observe());
    }
  }, 60_000);
