import * as Y from 'yjs';
import { encodeEnvelope } from '../actions/codec.js';
import { afterEach, expect, test, vi } from 'vitest';
import { createGenesis, decodeBundle, openBootstrap } from '../bootstrap/index.js';
import { compareBytes } from '../actions/cbor.js';
import { insertText, insertParagraph, RetainedEditError } from '../authoring/index.js';
import { serializeProjection } from '../projection/index.js';
import { SYNC_DIRECTIONS } from '../contracts.js';
import type { SyncMode } from '../contracts.js';
import type { ViewNode } from '../projection/types.js';
import { openReplica } from './index.js';
import type { Replica, ReplicaOptions } from './index.js';
import { ReplicaNetwork } from './network.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0).reverse()) await close();
});
function memory() {
  const entries: Uint8Array[] = [];
  const state = { failed: false, closed: 0 };
  return {
    entries,
    state,
    open: () => ({
      read: async () => entries.map((u) => u.slice()),
      append: async (u: Uint8Array) => {
        if (state.failed) throw new Error('disk failed');
        entries.push(u.slice());
      },
      close: () => {
        state.closed++;
      },
    }),
  };
}
async function peer(bytes: Uint8Array, options: Partial<ReplicaOptions> = {}, disk = memory()) {
  const replica = await openReplica({
    genesis: bytes,
    persistedGenesis: bytes,
    journal: disk.open(),
    mode: 'bidirectional',
    ...options,
  });
  closes.push(async () => {
    disk.state.failed = false;
    await replica.retryPersistence();
    await replica.close();
  });
  return replica;
}
const nodes = (replica: Replica) => {
  const visit = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(visit)];
  return visit(replica.publication().value.view.root).filter((n) => n.boundaries.length);
};
function type(
  replica: Replica,
  text: string,
  index = 0,
  at = nodes(replica)[index].content.length,
) {
  const nodeId = replica.handle(nodes(replica)[index].origin.representative);
  return replica.edit(
    insertText,
    { nodeId, from: at, text },
    {
      typing: true,
      selectionBefore: {
        anchor: { nodeId, offset: at, affinity: 'right' },
        focus: { nodeId, offset: at, affinity: 'right' },
      },
    },
  );
}
const markdown = (r: Replica) => serializeProjection(r.publication().value.view);
const modes: SyncMode[] = ['bidirectional', 'outbound-only', 'inbound-only', 'disconnected'];
for (const from of modes)
  for (const to of modes)
    test(`replica scheduler ${from} -> ${to}`, async () => {
      const bytes = createGenesis('replica-modes', 'base');
      const a = await peer(bytes, { mode: from }),
        b = await peer(bytes, { mode: to });
      const network = new ReplicaNetwork();
      network.add('a', a);
      network.add('b', b);
      network.connect('a', 'b');
      await network.retry('a');
      for (const m of network.queue()) network.drop(m.id);
      type(a, 'A');
      type(b, 'B');
      await network.retry('a');
      expect(network.queue().length > 0).toBe(SYNC_DIRECTIONS[from].send);
      const held = b.retainedUpdate();
      for (const message of network.queue()) {
        expect(network.deliver(message.id).state).toBe(
          SYNC_DIRECTIONS[to].receive ? 'admitted' : 'disabled',
        );
      }
      if (!SYNC_DIRECTIONS[from].send || !SYNC_DIRECTIONS[to].receive)
        expect(compareBytes(held, b.retainedUpdate())).toBe(0);
      expect(markdown(a)).toBe('baseA\n');
      expect(markdown(b)).toContain('B');
      expect(b.status().history.undo).toBe(1);
      network.dispose();
    });

test('outbound-only engine retains independent history and forwards a peer prerequisite without reverse delivery', async () => {
  const bytes = createGenesis('replica-one-way', 'base');
  const a = await peer(bytes),
    b = await peer(bytes),
    c = await peer(bytes, { mode: 'inbound-only' });
  type(b, 'B');
  a.receiveBundle('peer', b.captureBundle());
  a.setMode('outbound-only');
  const p = a.publication();
  type(a, 'A');
  const action = decodeBundle(a.captureBundle()).actionUpdate;
  expect(action.length).toBeGreaterThan(0);
  const net = new ReplicaNetwork();
  net.add('a', a);
  net.add('c', c);
  net.connect('a', 'c');
  await net.retry('a');
  for (const m of net.queue()) net.deliver(m.id);
  expect(markdown(c)).toBe(markdown(a));
  type(b, 'C');
  expect(a.receiveBundle('peer', b.captureBundle()).state).toBe('disabled');
  expect(a.undo().state).toBe('applied');
  expect(markdown(a)).toBe('baseB\n');
  a.setMode('bidirectional');
  a.receiveBundle('peer', b.captureBundle());
  expect(a.redo().state).toBe('applied');
  expect(a.publication()).not.toBe(p);
  expect(markdown(a)).toContain('A');
  expect(markdown(a)).toContain('C');
  expect(b.status().history.undo).toBe(1);
  net.dispose();
});

test('close fences command/history/ingress before unsubscription and preserves failed durable work for retry and restart', async () => {
  const bytes = createGenesis('replica-close', 'base'),
    disk = memory();
  const a = await peer(bytes, { mode: 'disconnected' }, disk);
  await a.flush();
  type(a, 'A');
  const id = a.handle(nodes(a)[0].origin.representative);
  disk.state.failed = true;
  await expect(a.close()).rejects.toThrow('disk failed');
  expect(a.status().lifecycle).toBe('closing');
  expect(disk.state.closed).toBe(0);
  expect(() => a.edit(insertText, { nodeId: id, from: 0, text: 'lost' })).toThrow('closing');
  expect(() => a.editEmptyRoot('lost')).toThrow('closing');
  expect(() => a.undo()).toThrow('closing');
  expect(() => a.redo()).toThrow('closing');
  expect(() => a.receive('self-echo', a.retainedUpdate())).toThrow('closing');
  expect(() => a.setMode('bidirectional')).toThrow('closing');
  expect(() => a.publish()).toThrow('closing');
  disk.state.failed = false;
  await a.retryPersistence();
  await a.close();
  expect(disk.state.closed).toBe(1);
  const reopened = await peer(bytes, { mode: 'disconnected' }, disk);
  expect(markdown(reopened)).toBe('baseA\n');
  expect(reopened.status().history).toMatchObject({ reset: true, undo: 0, redo: 0 });
  const edit = type(reopened, 'R');
  expect(edit.applied).toBe(true);
  if (edit.applied) expect(edit.action.sequence).toBe(1n);
});

test('deferred publication retains the complete view and blocks authoring until explicitly resumed', async () => {
  const bytes = createGenesis('replica-deferred', 'base');
  const a = await peer(bytes),
    b = await peer(bytes, { publicationOperations: 0 });
  const before = b.publication();
  type(a, 'A');
  expect(b.receiveBundle('cross-tab', a.captureBundle()).state).toBe('admitted');
  expect(b.publication()).toBe(before);
  expect(b.status()).toMatchObject({ deferred: true, canAuthor: false });
  expect(() => type(b, 'B')).toThrow('not authorable');
  b.retryPublication(100_000);
  expect(b.status()).toMatchObject({ deferred: false, canAuthor: true });
  expect(markdown(b)).toBe('baseA\n');
  type(b, 'B');
  expect(markdown(b)).toBe('baseAB\n');
});

test('a second receive invalidates deferred work without losing either exact carrier', async () => {
  const bytes = createGenesis('replica-deferred-receive', 'base');
  const a = await peer(bytes),
    b = await peer(bytes, { publicationOperations: 0 });
  type(a, 'A');
  b.receiveBundle('peer', a.captureBundle());
  type(a, 'B');
  b.receiveBundle('catch-up', a.captureBundle());
  b.retryPublication(100_000);
  expect(markdown(b)).toBe(markdown(a));
  const cold = await openBootstrap({
    genesis: bytes,
    persistedGenesis: bytes,
    journal: { read: async () => [b.retainedUpdate()], append: async () => {}, close() {} },
    mode: 'disconnected',
  });
  expect(serializeProjection(cold.document.publication.status().publication!.value.view)).toBe(
    markdown(a),
  );
  await cold.close();
});

test('reorder, duplicate, drop and one-way retry preserve exact facts and converge', async () => {
  const bytes = createGenesis('replica-queue', 'base\n\nnext');
  const a = await peer(bytes),
    b = await peer(bytes);
  const net = new ReplicaNetwork();
  net.add('a', a);
  net.add('b', b);
  net.connect('a', 'b');
  type(a, 'A');
  await net.retry('a');
  for (const m of net.queue()) net.drop(m.id);
  a.edit(insertParagraph, { nodeId: a.handle(nodes(a)[0].origin.representative), from: 2 });
  await net.retry('a');
  const original = net.queue().at(-1)!;
  const copy = net.duplicate(original.id);
  net.move(copy, original.id);
  const detached = net.queue();
  detached[0].update.fill(0);
  net.deliver(copy);
  net.deliver(original.id);
  await net.retry('a');
  for (const m of net.queue()) net.deliver(m.id);
  expect(markdown(b)).toBe(markdown(a));
  expect(compareBytes(a.retainedUpdate(), b.retainedUpdate())).toBe(0);
  expect(a.status().history.undo).toBe(2);
  expect(b.status().history.undo).toBe(0);
  net.dispose();
});

test('policy is checked at actual delivery; enabling send publishes held disconnected work', async () => {
  const bytes = createGenesis('replica-held', 'base');
  const a = await peer(bytes, { mode: 'disconnected' }),
    b = await peer(bytes);
  const net = new ReplicaNetwork();
  net.add('a', a);
  net.add('b', b);
  net.connect('a', 'b');
  type(a, 'A');
  await net.retry('a');
  expect(net.queue()).toHaveLength(0);
  a.setMode('outbound-only');
  await net.retry('a');
  b.setMode('disconnected');
  for (const m of net.queue()) expect(net.deliver(m.id).state).toBe('disabled');
  expect(net.queue()).toHaveLength(0);
  expect(markdown(b)).toBe('base\n');
  b.setMode('inbound-only');
  await net.retry('a');
  for (const m of net.queue()) net.deliver(m.id);
  expect(markdown(b)).toBe(markdown(a));
  net.dispose();
});

test('observer failure and reentrant calls cannot lose input or bypass lifecycle guards', async () => {
  const bytes = createGenesis('replica-observer', 'base');
  const a = await peer(bytes);
  const events: string[] = [];
  a.subscribe(() => {
    throw new Error('observer failed');
  });
  a.subscribe((event) => {
    events.push(event);
    if (event === 'publication') expect(() => a.undo()).toThrow('Recursive');
  });
  const result = type(a, 'A');
  expect(result.applied).toBe(true);
  expect(events).toContain('publication');
  expect(a.status().observerErrors.length).toBeGreaterThan(0);
  expect(a.status().canAuthor).toBe(true);
  expect(markdown(a)).toBe('baseA\n');
  expect(a.undo().state).toBe('applied');
  expect(markdown(a)).toBe('base\n');
});

test('retained publication failure is recoverable without repeating input', async () => {
  const bytes = createGenesis('replica-retained', 'base');
  const a = await peer(bytes);
  // Fault at the real writer's post-append publication, not a replacement command.
  const refresh = vi.spyOn((a as unknown as { editor: { refresh(): unknown } }).editor, 'refresh');
  refresh.mockImplementationOnce(() => {
    throw new Error('publication failed');
  });
  expect(() => type(a, 'A')).toThrow(RetainedEditError);
  refresh.mockRestore();
  a.retryPublication(100_000);
  expect(markdown(a)).toBe('baseA\n');
  expect(a.status().history.undo).toBe(1);
  expect(a.undo().state).toBe('applied');
  expect(markdown(a)).toBe('base\n');
});

test('unresolved no-event carrier ingress survives replica close/restart and prerequisite catch-up', async () => {
  const bytes = createGenesis('replica-pending', 'base'),
    disk = memory();
  const donor = await peer(bytes),
    a = await peer(bytes, {}, disk);
  const one = type(donor, '1'),
    two = type(donor, '2');
  if (!one.applied || !two.applied) throw new Error('Expected edits');
  const carrier = new Y.Doc({ gc: false }),
    updates: Uint8Array[] = [];
  carrier.on('update', (u: Uint8Array) => updates.push(u.slice()));
  carrier.getArray('envelopes').push([encodeEnvelope(one.envelope)]);
  carrier.getArray('envelopes').push([encodeEnvelope(two.envelope)]);
  expect(a.receive('peer', updates[1]).state).toBe('admitted');
  expect(markdown(a)).toBe('base\n');
  const held = a.retainedUpdate();
  await a.close();
  const reopened = await peer(bytes, {}, disk);
  expect(compareBytes(reopened.retainedUpdate(), held)).toBe(0);
  expect(reopened.receive('catch-up', updates[0]).state).toBe('admitted');
  expect(markdown(reopened)).toBe('base12\n');
  expect(
    compareBytes(
      reopened.publication().native.encodeState(),
      donor.publication().native.encodeState(),
    ),
  ).toBe(0);
  expect(reopened.status().history.undo).toBe(0);
  carrier.destroy();
});
