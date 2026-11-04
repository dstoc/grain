import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ActionStore } from '../actions/store.js';
import { action, A, B, C } from '../actions/test-fixtures.js';
import { SYNC_DIRECTIONS } from '../contracts.js';
import type { DeliveryRoute, SyncMode } from '../contracts.js';
import { IngestCapacityError, IngestDataError } from '../ingest/work.js';
import type { ProviderLimits } from './adapter.js';
import { DirectionalActionProvider } from './adapter.js';
import type { ActionJournal, OutboundMessage } from './types.js';

const modes = Object.keys(SYNC_DIRECTIONS) as SyncMode[];
const routes: DeliveryRoute[] = ['peer', 'catch-up', 'self-echo', 'cross-tab'];
const stores: ActionStore[] = [];
const providers: DirectionalActionProvider[] = [];
function store() {
  const value = new ActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: [],
    validate: () => null,
  });
  stores.push(value);
  return value;
}
class MemoryJournal implements ActionJournal {
  readonly entries: Uint8Array[] = [];
  closed = false;
  fail: unknown;
  delay?: Promise<void>;
  async read() {
    return this.entries.map((entry) => entry.slice());
  }
  async append(update: Uint8Array) {
    await this.delay;
    if (this.fail) throw this.fail;
    this.entries.push(update.slice());
  }
  close() {
    this.closed = true;
  }
}
async function open(
  mode: SyncMode = 'bidirectional',
  journal = new MemoryJournal(),
  value = store(),
  limits?: Partial<ProviderLimits>,
) {
  const errors: unknown[] = [];
  const provider = await DirectionalActionProvider.open({
    store: value,
    journal,
    mode,
    limits,
    onError: (error) => errors.push(error),
  });
  providers.push(provider);
  return { provider, journal, value, errors };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function source() {
  const value = store();
  const updates: Uint8Array[] = [];
  value.onUpdate((update) => updates.push(update));
  const a1 = action();
  value.append(a1);
  value.append(action(A, 2n, [a1]));
  return updates;
}
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close().catch(() => {});
  for (const value of stores.splice(0)) value.destroy();
});

describe('directional actionDoc transport', () => {
  it.each(
    modes.flatMap((from) => modes.flatMap((to) => routes.map((route) => ({ from, to, route })))),
  )('$from → $to via $route gates all data before application', async ({ from, to, route }) => {
    const sender = await open(from);
    const receiver = await open(to);
    sender.value.append(action());
    await receiver.provider.flush();
    const before = receiver.value.encodeUpdate();
    const snapshot = receiver.value.snapshot();
    const count = receiver.journal.entries.length;
    sender.provider.attachPeer('receiver', {
      send: ({ update }) => {
        receiver.provider.receive(route, update);
      },
    });
    await sender.provider.publish();
    await receiver.provider.flush();
    if (SYNC_DIRECTIONS[from].send && SYNC_DIRECTIONS[to].receive) {
      expect(receiver.value.encodeUpdate()).toEqual(sender.value.encodeUpdate());
      expect(receiver.value.snapshot().ready).toHaveLength(1);
    } else {
      expect(receiver.value.encodeUpdate()).toEqual(before);
      expect(receiver.value.snapshot()).toEqual(snapshot);
      expect(receiver.journal.entries).toHaveLength(count);
    }
  });

  it('checks receive policy after a delayed host callback and send policy after queued work', async () => {
    const target = await open();
    const updates = source();
    const gate = deferred();
    const receive = gate.promise.then(() => target.provider.receive('catch-up', updates[0]));
    target.provider.setMode('outbound-only');
    gate.resolve();
    expect(await receive).toBe(false);
    expect(target.value.snapshot().actions).toHaveLength(0);

    const sendGate = deferred();
    const sent: OutboundMessage[] = [];
    target.provider.attachPeer('B', {
      send: async (message) => {
        sent.push(message);
        await sendGate.promise;
      },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    target.value.append(action());
    const queued = target.provider.publish();
    target.provider.setMode('disconnected');
    sendGate.resolve();
    await queued;
    expect(sent).toHaveLength(1);
  });

  it('repairs a dropped strict one-way bootstrap with another actor prerequisite and controls', async () => {
    const upstream = await open();
    const relay = await open();
    const receiver = await open('inbound-only');
    const b1 = action(B);
    upstream.value.append(b1);
    relay.provider.receive('peer', upstream.value.encodeUpdate());
    relay.provider.setMode('outbound-only');
    const a1 = action(A, 1n, [b1]);
    relay.value.append(a1);
    const control = {
      ...action(A, 2n, [a1]),
      effects: [
        {
          type: 'SetGroupActive' as const,
          group: a1.groupId,
          actions: [a1.id],
          active: false,
          previousControl: null,
        },
      ],
    };
    relay.value.append(control);
    receiver.value.append(action(C));
    const scheduled: OutboundMessage[] = [];
    relay.provider.attachPeer('C', {
      send: (message) => {
        scheduled.push(message);
      },
    });
    await relay.provider.publish();
    // Drop all initial sends. Host reconnect/periodic scheduler explicitly retries, no feedback.
    scheduled.length = 0;
    await relay.provider.publish();
    const retry = scheduled[0];
    receiver.provider.receive('peer', retry.update);
    receiver.provider.receive('peer', retry.update);
    expect(receiver.value.snapshot().ready.map((entry) => entry.id)).toEqual([
      b1.id,
      action(C).id,
      a1.id,
      control.id,
    ]);
    const expected = store();
    expected.applyUpdate(receiver.value.encodeUpdate());
    expect(expected.encodeUpdate()).toEqual(receiver.value.encodeUpdate());
  });

  it('enables catch-up on the existing store and publishes work accumulated while disconnected', async () => {
    const target = await open('disconnected');
    const remote = store();
    remote.append(action(B));
    const catchUp = vi.fn(() => {
      target.provider.receive('catch-up', remote.encodeUpdate());
    });
    const sent: OutboundMessage[] = [];
    target.provider.attachPeer('B', {
      send: (message) => {
        sent.push(message);
      },
      requestCatchUp: catchUp,
    });
    target.value.append(action());
    target.provider.setMode('bidirectional');
    await target.provider.publish();
    expect(catchUp).toHaveBeenCalledTimes(1);
    expect(target.value.snapshot().ready).toHaveLength(2);
    const received = store();
    received.applyUpdate(sent.at(-1)!.update);
    expect(received.encodeUpdate()).toEqual(target.value.encodeUpdate());
  });

  it('bounds automatic duplicate/self-echo publication without suppressing raw persistence', async () => {
    const left = await open();
    const right = await open();
    let sends = 0;
    left.provider.attachPeer('right', {
      send: ({ update }) => {
        sends++;
        right.provider.receive('peer', update);
        left.provider.receive('self-echo', update);
      },
    });
    right.provider.attachPeer('left', {
      send: ({ update }) => {
        sends++;
        left.provider.receive('peer', update);
      },
    });
    left.value.append(action());
    await left.provider.publish();
    await right.provider.publish();
    await vi.waitFor(() => expect(right.value.snapshot().ready).toHaveLength(1));
    const settled = sends;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sends).toBe(settled);
    expect(sends).toBeLessThan(10);
    await left.provider.flush();
    const count = left.journal.entries.length;
    left.provider.receive('self-echo', right.value.encodeUpdate());
    await left.provider.flush();
    expect(left.journal.entries).toHaveLength(count + 1);
    expect(sends).toBe(settled);
  });

  it('uses optional copied state vectors without importing facts or requiring a handshake', async () => {
    const target = await open('outbound-only');
    target.value.append(action());
    const known = store();
    known.applyUpdate(target.value.encodeUpdate());
    const vector = known.encodeStateVector();
    const sent: OutboundMessage[] = [];
    target.provider.attachPeer('B', {
      send: (message) => {
        sent.push(message);
      },
    });
    target.provider.setPeerStateVector('B', vector);
    vector.fill(0);
    const before = target.value.encodeUpdate();
    await target.provider.publish();
    expect(target.value.encodeUpdate()).toEqual(before);
    expect(Y.decodeUpdate(sent.at(-1)!.update).structs).toHaveLength(0);
    const a1 = action();
    target.value.append(action(A, 2n, [a1]));
    await target.provider.publish();
    known.applyUpdate(sent.at(-1)!.update);
    expect(known.encodeUpdate()).toEqual(target.value.encodeUpdate());
  });

  it('keeps send failures separate from applied/persisted status and retries explicitly', async () => {
    const target = await open();
    const failure = new Error('offline');
    target.provider.attachPeer('B', {
      send: () => {
        throw failure;
      },
    });
    target.value.append(action());
    const publication = target.provider.capturePublication();
    await expect(target.provider.publish()).rejects.toThrow('offline');
    await target.provider.flush();
    expect(publication.status('B')).toEqual({ applied: true, persisted: true });
    expect(target.errors).toContainEqual({ operation: 'send', peer: 'B', error: failure });
  });
});

describe('durability and publication fences', () => {
  it.each(modes)('persists and restores own journal in %s mode', async (mode) => {
    const target = await open(mode);
    target.value.append(action());
    await target.provider.close();
    const restored = await open(mode, target.journal);
    expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
  });

  it.each(
    routes.flatMap((route) => ['no-event', 'mixed-message'].map((kind) => ({ route, kind }))),
  )(
    'journals copied $kind raw ingress via $route before prerequisites across reordered replay',
    async ({ route, kind }) => {
      const updates = source();
      const independent = store();
      independent.append(action(C));
      const incoming =
        kind === 'no-event'
          ? updates[1].slice()
          : Y.mergeUpdates([updates[1], independent.encodeUpdate()]);
      const target = await open();
      const events: Uint8Array[] = [];
      target.value.onUpdate((update) => events.push(update));
      const vector = target.value.encodeStateVector();
      target.provider.receive(route, incoming);
      expect(events).toHaveLength(kind === 'no-event' ? 0 : 1);
      if (kind === 'no-event') expect(target.value.encodeStateVector()).toEqual(vector);
      incoming.fill(0);
      target.value.append(action(B));
      await target.provider.flush();
      const replays = [
        target.journal.entries,
        [...target.journal.entries].reverse(),
        [...target.journal.entries, ...target.journal.entries].reverse(),
      ];
      const restoredStores: ActionStore[] = [];
      for (const entries of replays) {
        const journal = new MemoryJournal();
        journal.entries.push(...entries);
        const restored = await open('disconnected', journal);
        expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
        expect(restored.value.snapshot()).toEqual(target.value.snapshot());
        restoredStores.push(restored.value);
      }
      target.provider.receive('peer', updates[0]);
      for (const restored of restoredStores) {
        restored.applyUpdate(updates[0]);
        expect(restored.encodeUpdate()).toEqual(target.value.encodeUpdate());
        expect(restored.snapshot()).toEqual(target.value.snapshot());
      }
    },
  );

  it('seeds preexisting unresolved structs and fails open on corrupt restoration', async () => {
    const updates = source();
    const value = store();
    value.applyUpdate(updates[1]);
    const target = await open('disconnected', new MemoryJournal(), value);
    await target.provider.flush();
    const restored = await open('disconnected', target.journal);
    expect(restored.value.encodeUpdate()).toEqual(value.encodeUpdate());
    restored.value.applyUpdate(updates[0]);
    value.applyUpdate(updates[0]);
    expect(restored.value.encodeUpdate()).toEqual(value.encodeUpdate());
    const corrupt = new MemoryJournal();
    corrupt.entries.push(new Uint8Array([255]));
    await expect(open('disconnected', corrupt)).rejects.toThrow();
    expect(corrupt.closed).toBe(true);
  });

  it.each(['no-event', 'mixed-message'])(
    'flush and close wait for $kind raw ingress, reject failure, then retry without peer resend',
    async (kind) => {
      const target = await open();
      await target.provider.flush();
      const updates = source();
      const other = store();
      other.append(action(C));
      const gate = deferred();
      target.journal.delay = gate.promise;
      target.provider.receive(
        'peer',
        kind === 'no-event' ? updates[1] : Y.mergeUpdates([updates[1], other.encodeUpdate()]),
      );
      const failure = new Error('quota');
      target.journal.fail = failure;
      let settled = false;
      const closing = target.provider.close().finally(() => {
        settled = true;
      });
      const rejection = expect(closing).rejects.toThrow('quota');
      await Promise.resolve();
      expect(settled).toBe(false);
      gate.resolve();
      await rejection;
      expect(target.journal.closed).toBe(false);
      expect(() => target.provider.receive('peer', updates[0])).toThrow('closed');
      target.journal.fail = undefined;
      await target.provider.retryPersistence();
      await target.provider.close();
      const restored = await open('disconnected', target.journal);
      expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
      restored.value.applyUpdate(updates[0]);
      target.value.applyUpdate(updates[0]);
      expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
    },
  );

  it('preserves applied work and a contiguous durable prefix across failures and later edits', async () => {
    const target = await open();
    await target.provider.flush();
    target.value.append(action());
    const first = target.provider.capturePublication();
    await target.provider.flush();
    target.journal.fail = new Error('abort');
    const a1 = action();
    target.value.append(action(A, 2n, [a1]));
    const second = target.provider.capturePublication();
    await expect(target.provider.flush()).rejects.toThrow('abort');
    expect(first.status()).toEqual({ applied: true, persisted: true });
    expect(second.status()).toEqual({ applied: true, persisted: false });
    target.value.append(action(B));
    const third = target.provider.capturePublication();
    expect(target.value.snapshot().ready).toHaveLength(3);
    expect(third.status().persisted).toBe(false);
    target.journal.fail = undefined;
    await target.provider.retryPersistence();
    expect(second.status().persisted).toBe(true);
    expect(third.status().persisted).toBe(true);
  });

  it('fences capture their own tail rather than waiting for later edits', async () => {
    const target = await open();
    await target.provider.flush();
    const gate = deferred();
    target.journal.delay = gate.promise;
    target.value.append(action());
    const fence = target.provider.flush();
    const next = deferred();
    target.journal.append = async (update) => {
      await (target.journal.entries.length === 1 ? gate.promise : next.promise);
      target.journal.entries.push(update.slice());
    };
    target.value.append(action(B));
    gate.resolve();
    await fence;
    expect(target.provider.capturePublication().status().persisted).toBe(false);
    next.resolve();
    await target.provider.flush();
  });

  it('qualifies acknowledgment coverage by message, peer and attachment, independently of persistence', async () => {
    const target = await open();
    await target.provider.flush();
    const gate = deferred();
    target.journal.delay = gate.promise;
    const sent: OutboundMessage[] = [];
    const detach = target.provider.attachPeer('B', {
      acknowledgments: true,
      send: (message) => {
        sent.push(message);
      },
    });
    target.provider.attachPeer('C', { acknowledgments: true, send: () => {} });
    target.value.append(action());
    const first = target.provider.capturePublication();
    await target.provider.publish();
    const old = sent.at(-1)!.id;
    expect(first.status('B')).toEqual({ applied: true, persisted: false, delivered: false });
    target.value.append(action(B));
    const second = target.provider.capturePublication();
    await target.provider.publish();
    target.provider.acknowledge('C', old);
    expect(first.status('C').delivered).toBe(false);
    target.provider.acknowledge('B', old);
    expect(first.status('B').delivered).toBe(true);
    expect(second.status('B').delivered).toBe(false);
    target.provider.acknowledge('B', sent.at(-1)!.id);
    target.provider.acknowledge('B', old);
    expect(second.status('B').delivered).toBe(true);
    detach();
    target.provider.attachPeer('B', { acknowledgments: true, send: () => {} });
    const fresh = target.provider.capturePublication();
    target.provider.acknowledge('B', old);
    expect(fresh.status('B').delivered).toBe(false);
    gate.resolve();
    await target.provider.flush();
  });

  it('does not journal blocked or rejected updates, including staged events on rejection', async () => {
    const target = await open();
    await target.provider.flush();
    const count = target.journal.entries.length;
    const updates = source();
    target.provider.setMode('outbound-only');
    target.provider.receive('cross-tab', updates[1]);
    target.provider.setMode('bidirectional');
    const apply = vi.spyOn(target.value, 'applyUpdate').mockImplementation(() => {
      target.value.append(action()); // Simulate a synchronous callback before a failing apply.
      throw new Error('rejected');
    });
    expect(() => target.provider.receive('peer', updates[1])).toThrow('rejected');
    apply.mockRestore();
    await target.provider.flush();
    expect(target.journal.entries).toHaveLength(count);
    expect(() => target.provider.receive('peer', new Uint8Array([255]))).toThrow();
    await target.provider.flush();
    expect(target.journal.entries).toHaveLength(count);
  });
});

it('publishes newly admitted unresolved native coverage even when no update event fires', async () => {
  const target = await open();
  const receiver = store();
  const sent: OutboundMessage[] = [];
  target.provider.attachPeer('B', {
    send: (message) => {
      sent.push(message);
      receiver.applyUpdate(message.update);
    },
  });
  await target.provider.publish();
  const before = sent.length;
  const updates = source();
  const vector = target.value.encodeStateVector();
  target.provider.receive('catch-up', updates[1]);
  expect(target.value.encodeStateVector()).toEqual(vector);
  await vi.waitFor(() => expect(sent.length).toBe(before + 1));
  expect(receiver.encodeUpdate()).toEqual(target.value.encodeUpdate());
  receiver.applyUpdate(updates[0]);
  expect(receiver.snapshot().ready).toHaveLength(2);
});

it('re-enabling sending retries unchanged coverage and asynchronous catch-up failure is reported', async () => {
  const target = await open();
  const messages: OutboundMessage[] = [];
  target.value.append(action());
  const failure = new Error('catch-up unavailable');
  target.provider.attachPeer('B', {
    send: (message) => {
      messages.push(message);
    },
    requestCatchUp: async () => {
      throw failure;
    },
  });
  await target.provider.publish();
  await vi.waitFor(() =>
    expect(target.errors).toContainEqual({ operation: 'catch-up', peer: 'B', error: failure }),
  );
  const before = messages.length;
  target.provider.setMode('inbound-only');
  target.provider.setMode('bidirectional');
  await vi.waitFor(() => expect(messages.length).toBe(before + 1));
  expect(messages.at(-1)!.update).toEqual(messages[0].update);
});

it('ignores acknowledgments from a closed process instance after reopening the same durable replica', async () => {
  const target = await open();
  const messages: OutboundMessage[] = [];
  target.provider.attachPeer('B', {
    acknowledgments: true,
    send: (message) => {
      messages.push(message);
    },
  });
  target.value.append(action());
  await target.provider.publish();
  const stale = messages.at(-1)!.id;
  await target.provider.close();
  const restored = await open('bidirectional', target.journal);
  const restartedMessages: OutboundMessage[] = [];
  restored.provider.attachPeer('B', {
    acknowledgments: true,
    send: (message) => {
      restartedMessages.push(message);
    },
  });
  const publication = restored.provider.capturePublication();
  await restored.provider.publish();
  expect(restartedMessages.every((message) => message.id !== stale)).toBe(true);
  restored.provider.acknowledge('B', stale);
  expect(publication.status('B').delivered).toBe(false);
});

it('exports unsent retraction controls with full prerequisites after mode changes and reordered retries', async () => {
  const upstream = store();
  const b1 = action(B);
  upstream.append(b1);
  const sender = await open();
  sender.provider.receive('peer', upstream.encodeUpdate());
  sender.provider.setMode('outbound-only');
  const a1 = action(A, 1n, [b1]);
  sender.value.append(a1);
  const packets: OutboundMessage[] = [];
  sender.provider.attachPeer('C', {
    send: (message) => {
      packets.push(message);
    },
  });
  await sender.provider.publish();
  const old = packets.at(-1)!;
  sender.provider.setMode('disconnected');
  const control = {
    ...action(A, 2n, [a1]),
    effects: [
      {
        type: 'SetGroupActive' as const,
        group: a1.groupId,
        actions: [a1.id],
        active: false,
        previousControl: null,
      },
    ],
  };
  sender.value.append(control);
  await sender.provider.publish();
  expect(packets.at(-1)).toBe(old);
  sender.provider.setMode('outbound-only');
  await sender.provider.publish();
  const latest = packets.at(-1)!;
  // Initial bootstrap was lost. A later retry arrives before an older packet.
  const receiver = await open('inbound-only');
  for (const packet of [latest, old, latest]) receiver.provider.receive('peer', packet.update);
  expect(receiver.value.snapshot().ready.map((entry) => entry.id)).toEqual([
    b1.id,
    a1.id,
    control.id,
  ]);
  expect(receiver.value.encodeUpdate()).toEqual(sender.value.encodeUpdate());
});

it('rejects native delete sets without journaling rejected bytes', async () => {
  const target = await open();
  await target.provider.flush();
  const count = target.journal.entries.length;
  const corrupt = new Y.Doc({ gc: false });
  try {
    const array = corrupt.getArray('envelopes');
    array.push([new Uint8Array([0])]);
    array.delete(0, 1);
    expect(() => target.provider.receive('peer', Y.encodeStateAsUpdate(corrupt))).toThrow(
      'deletion',
    );
    await target.provider.flush();
    expect(target.journal.entries).toHaveLength(count);
  } finally {
    corrupt.destroy();
  }
});

describe('MW-15 remote admission', () => {
  it.each(modes.flatMap((mode) => routes.map((route) => ({ mode, route }))))(
    '$mode/$route checks direction and size before copying, decoding or persistence',
    async ({ mode, route }) => {
      const sender = store();
      sender.append(action());
      const update = sender.encodeUpdate();
      const receiver = await open(mode, new MemoryJournal(), store(), {
        messageBytes: update.length - 1,
      });
      await receiver.provider.flush();
      const before = receiver.value.encodeUpdate();
      const vector = receiver.value.encodeStateVector();
      const snapshot = receiver.value.snapshot();
      const journal = receiver.journal.entries.map((entry) => entry.slice());
      const copy = vi.spyOn(update, 'slice');
      const result = receiver.provider.receiveResult(route, update);
      expect(result.state).toBe(SYNC_DIRECTIONS[mode].receive ? 'backpressured' : 'disabled');
      if (result.state === 'backpressured')
        expect(result.error).toBeInstanceOf(IngestCapacityError);
      expect(copy).not.toHaveBeenCalled();
      expect(receiver.value.encodeUpdate()).toEqual(before);
      expect(receiver.value.encodeStateVector()).toEqual(vector);
      expect(receiver.value.snapshot()).toEqual(snapshot);
      await receiver.provider.flush();
      expect(receiver.journal.entries).toEqual(journal);
      receiver.provider.setLimits({ messageBytes: update.length });
      expect(receiver.provider.receive(route, update)).toBe(SYNC_DIRECTIONS[mode].receive);
      if (SYNC_DIRECTIONS[mode].receive)
        expect(receiver.value.snapshot()).toEqual(sender.snapshot());
    },
  );

  it('leaves rejected carrier bytes out of canonical storage and persistence', async () => {
    const receiver = await open();
    await receiver.provider.flush();
    const before = receiver.value.encodeUpdate();
    const journal = receiver.journal.entries.map((entry) => entry.slice());
    expect(() => receiver.provider.receive('peer', new Uint8Array([1, 255]))).toThrow(
      IngestDataError,
    );
    expect(receiver.value.encodeUpdate()).toEqual(before);
    await receiver.provider.flush();
    expect(receiver.journal.entries).toEqual(journal);
  });

  it('backpressures remote ingress when failed local writes fill capacity, keeping local edits unsaved', async () => {
    const journal = new MemoryJournal();
    const receiver = await open('bidirectional', journal);
    await receiver.provider.flush();
    journal.fail = new Error('disk full');
    receiver.value.append(action());
    const publication = receiver.provider.capturePublication();
    await expect(receiver.provider.flush()).rejects.toThrow('disk full');
    receiver.provider.setLimits({ persistenceBytes: 0 });
    const sender = store();
    sender.append(action(B));
    const update = sender.encodeUpdate();
    const before = receiver.value.encodeUpdate();
    const result = receiver.provider.receiveResult('cross-tab', update);
    expect(result.state).toBe('backpressured');
    expect(receiver.value.encodeUpdate()).toEqual(before);
    expect(publication.status()).toEqual({ applied: true, persisted: false });
    journal.fail = undefined;
    await receiver.provider.retryPersistence();
    receiver.provider.setLimits({ persistenceBytes: 32 * 1024 * 1024 });
    expect(receiver.provider.receive('cross-tab', update)).toBe(true);
    await receiver.provider.flush();
    expect(publication.status()).toEqual({ applied: true, persisted: true });
  });

  it('reserves events unlocked from already-held pending structs before admitting a small prefix', async () => {
    const sender = store();
    const updates: Uint8Array[] = [];
    sender.onUpdate((update) => updates.push(update));
    const first = action();
    sender.append(first);
    const second = action(A, 2n, [first]);
    sender.append({
      ...second,
      groupId: {
        ...second.groupId,
        session: { ...second.groupId.session, local: 'x'.repeat(40_000) },
      },
    });
    const receiver = await open();
    await receiver.provider.flush();
    expect(receiver.provider.receive('peer', updates[1])).toBe(true);
    await receiver.provider.flush();
    expect(receiver.value.snapshot().ready).toEqual([]);
    const held = receiver.value.encodeUpdate();
    receiver.provider.setLimits({ persistenceBytes: updates[0].length * 2 + 2048 });
    const result = receiver.provider.receiveResult('catch-up', updates[0]);
    expect(result.state).toBe('backpressured');
    if (result.state === 'backpressured')
      expect(result.error.required).toBeGreaterThan(updates[1].length);
    expect(receiver.value.encodeUpdate()).toEqual(held);
    receiver.provider.setLimits({ persistenceBytes: 32 * 1024 * 1024 });
    expect(receiver.provider.receive('catch-up', updates[0])).toBe(true);
    const pending = receiver.value.compute(1);
    expect(pending.state).toBe('deferred');
    await receiver.provider.flush();
    const restart = await open('disconnected', receiver.journal);
    expect(restart.value.encodeUpdate()).toEqual(sender.encodeUpdate());
    expect(restart.value.snapshot()).toEqual(sender.snapshot());
  });

  it('journals unresolved raw ingress while envelope computation is deferred and persistence retries', async () => {
    const updates = source();
    const journal = new MemoryJournal();
    const receiver = await open('bidirectional', journal);
    await receiver.provider.flush();
    journal.fail = new Error('temporarily unavailable');
    expect(receiver.provider.receive('peer', updates[1])).toBe(true);
    const held = receiver.value.encodeUpdate();
    expect(receiver.value.compute(0).state).toBe('deferred');
    await expect(receiver.provider.close()).rejects.toThrow('temporarily unavailable');
    journal.fail = undefined;
    await receiver.provider.retryPersistence();
    await receiver.provider.close();
    const replacement = new MemoryJournal();
    replacement.entries.push(...journal.entries);
    const restart = await open('disconnected', replacement);
    expect(restart.value.encodeUpdate()).toEqual(held);
    restart.provider.setMode('bidirectional');
    restart.provider.receive('peer', updates[0]);
    expect(restart.value.snapshot().ready).toHaveLength(2);
  });

  it('fails journal restoration instead of opening a successful partial document under decode capacity', async () => {
    const sender = store();
    sender.append(action());
    const journal = new MemoryJournal();
    journal.entries.push(sender.encodeUpdate());
    const receiver = store();
    receiver.setDecodeLimits({ operations: 1 });
    await expect(
      DirectionalActionProvider.open({ store: receiver, journal, mode: 'disconnected' }),
    ).rejects.toThrow(IngestCapacityError);
    expect(journal.closed).toBe(true);
    expect(receiver.snapshot().ready).toEqual([]);
    receiver.setDecodeLimits({ operations: 100_000 });
    const retry = new MemoryJournal();
    retry.entries.push(...journal.entries);
    const restored = await open('disconnected', retry, receiver);
    expect(restored.value.snapshot()).toEqual(sender.snapshot());
  });
});

it('resumes journal readiness in small slices before returning an open provider', async () => {
  const sender = store();
  const first = action();
  sender.append(first);
  sender.append(action(A, 2n, [first]));
  const journal = new MemoryJournal();
  journal.entries.push(sender.encodeUpdate());
  const receiver = store();
  const provider = await DirectionalActionProvider.open({
    store: receiver,
    journal,
    mode: 'disconnected',
    restoreOperations: 7,
  });
  providers.push(provider);
  expect(receiver.snapshot()).toEqual(sender.snapshot());
  const noProgress = new MemoryJournal();
  await expect(
    DirectionalActionProvider.open({
      store: store(),
      journal: noProgress,
      mode: 'disconnected',
      restoreOperations: 0,
    }),
  ).rejects.toThrow(IngestCapacityError);
  expect(noProgress.closed).toBe(true);
});

it('durably holds admitted bytes when envelope decode needs more capacity than carrier admission', async () => {
  const sender = store();
  const large = action();
  sender.append({
    ...large,
    dependencies: Array.from({ length: 1000 }, (_, index) => ({
      ...action(B).id,
      sequence: BigInt(index + 1),
    })),
  });
  const receiver = await open();
  receiver.value.setDecodeLimits({ operations: 100 });
  expect(receiver.provider.receive('peer', sender.encodeUpdate())).toBe(true);
  expect(() => receiver.value.snapshot()).toThrow(IngestCapacityError);
  await receiver.provider.flush();
  const held = receiver.value.encodeUpdate();
  await receiver.provider.close();
  const replacement = new MemoryJournal();
  replacement.entries.push(...receiver.journal.entries);
  const restored = await open('disconnected', replacement);
  expect(restored.value.encodeUpdate()).toEqual(held);
  expect(restored.value.snapshot()).toEqual(sender.snapshot());
});
