import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ActionStore } from '../actions/store.js';
import { action, A, B, C, validateStorageAction } from '../actions/test-fixtures.js';
import { SYNC_DIRECTIONS } from '../contracts.js';
import type { DeliveryRoute, SyncMode } from '../contracts.js';
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
    validate: validateStorageAction,
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
) {
  const errors: unknown[] = [];
  const provider = await DirectionalActionProvider.open({
    store: value,
    journal,
    mode,
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

/** Transactional host adapter: its inherited read refuses a partial replay source. */
class CheckpointMemoryJournal extends MemoryJournal {
  declare checkpoint?: Uint8Array;
  replacementGate?: Promise<void>;
  replacementFailure?: Error;
  replacements = 0;
  attempts = 0;
  async readCheckpoint() {
    return {
      ...('checkpoint' in this ? { checkpoint: this.checkpoint?.slice() } : {}),
      updates: this.entries.map((entry) => entry.slice()),
    };
  }
  override async read() {
    if ('checkpoint' in this) throw new Error('Checkpoint-aware read required');
    return super.read();
  }
  async replaceWithCheckpoint(checkpoint: Uint8Array) {
    const copy = checkpoint.slice();
    this.attempts++;
    await this.replacementGate;
    if (this.replacementFailure) throw this.replacementFailure;
    this.checkpoint = copy;
    this.entries.length = 0;
    this.replacements++;
  }
}

describe('lossless checkpoint persistence barriers', () => {
  it.each(modes)(
    'captures before later appends/raw ingress, with delayed prior writes in %s',
    async (mode) => {
      const journal = new CheckpointMemoryJournal();
      const target = await open(mode, journal);
      const prior = deferred();
      journal.delay = prior.promise;
      const a1 = action();
      target.value.append(a1);
      const before = target.value.encodeUpdate();
      const consolidation = target.provider.consolidate();
      const a2 = action(A, 2n, [a1]);
      target.value.append(a2);
      const updates = source();
      const admitted = target.provider.receive('cross-tab', updates[1]);
      expect(admitted).toBe(SYNC_DIRECTIONS[mode].receive);
      let settled = false;
      void consolidation.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(journal.replacements).toBe(0);
      prior.resolve();
      await consolidation;
      await target.provider.flush();
      const { decodeCheckpoint } = await import('../checkpoints/index.js');
      expect(decodeCheckpoint(journal.checkpoint!).update).toEqual(before);
      expect(journal.entries.length).toBeGreaterThan(0);
      await expect(journal.read()).rejects.toThrow('Checkpoint-aware');
      await target.provider.close();
      const loaded = await open(mode, journal);
      expect(loaded.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
      expect(loaded.value.snapshot()).toEqual(target.value.snapshot());
      if (admitted) {
        target.value.applyUpdate(updates[0]);
        loaded.value.applyUpdate(updates[0]);
        expect(loaded.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
      }
    },
  );

  it.each(modes)(
    'keeps a failed replacement and later tail retryable without regressing durability in %s',
    async (mode) => {
      const journal = new CheckpointMemoryJournal();
      const target = await open(mode, journal);
      const a1 = action();
      target.value.append(a1);
      await target.provider.flush();
      const publication = target.provider.capturePublication();
      const old = journal.entries.map((entry) => entry.slice());
      const gate = deferred();
      journal.replacementGate = gate.promise;
      journal.replacementFailure = new Error('replacement quota');
      const consolidation = target.provider.consolidate();
      const rejection = expect(consolidation).rejects.toThrow('replacement quota');
      target.value.append(action(A, 2n, [a1]));
      const later = target.provider.capturePublication();
      const updates = source();
      expect(target.provider.receive('peer', updates[1])).toBe(SYNC_DIRECTIONS[mode].receive);
      const closing = target.provider.close();
      const closeRejection = expect(closing).rejects.toThrow('replacement quota');
      await vi.waitFor(() => expect(journal.attempts).toBe(1));
      expect(later.status().persisted).toBe(false);
      expect(publication.status().persisted).toBe(true);
      expect(journal.closed).toBe(false);
      gate.resolve();
      await rejection;
      await closeRejection;
      expect(journal.entries).toEqual(old);
      expect(journal.checkpoint).toBeUndefined();
      expect(journal.replacements).toBe(0);
      expect(publication.status().persisted).toBe(true);
      expect(target.errors).toContainEqual({
        operation: 'persistence',
        error: journal.replacementFailure,
      });
      journal.replacementFailure = undefined;
      await target.provider.retryPersistence();
      await target.provider.close();
      expect(journal.replacements).toBe(1);
      expect(later.status().persisted).toBe(true);
      const loaded = await open(mode, journal);
      expect(loaded.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
      expect(loaded.value.snapshot()).toEqual(target.value.snapshot());
    },
  );

  it('serializes concurrent consolidations and flushes through both barriers without losing tails', async () => {
    const journal = new CheckpointMemoryJournal();
    const target = await open('bidirectional', journal);
    const a1 = action();
    target.value.append(a1);
    const gate = deferred();
    journal.replacementGate = gate.promise;
    const first = target.provider.consolidate();
    target.value.append(action(A, 2n, [a1]));
    const secondBytes = target.value.encodeUpdate();
    const second = target.provider.consolidate();
    target.value.append(action(B));
    const flush = target.provider.flush();
    await vi.waitFor(() => expect(journal.attempts).toBe(1));
    expect(journal.replacements).toBe(0);
    gate.resolve();
    await Promise.all([first, second, flush]);
    expect(journal.replacements).toBe(2);
    const { decodeCheckpoint } = await import('../checkpoints/index.js');
    expect(decodeCheckpoint(journal.checkpoint!).update).toEqual(secondBytes);
    expect(journal.entries).toHaveLength(1);
    await target.provider.close();
    const loaded = await open('disconnected', journal);
    expect(loaded.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
  });

  it('rejects unsupported consolidation before changing an append-only journal', async () => {
    const target = await open();
    await target.provider.flush();
    const before = target.journal.entries.map((entry) => entry.slice());
    await expect(target.provider.consolidate()).rejects.toThrow('does not support');
    expect(target.journal.entries).toEqual(before);
    target.value.append(action());
    await target.provider.flush();
  });

  it.each([false, true])(
    'fences inherited old-provider reads with nonempty tail=%s',
    async (tail) => {
      const journal = new CheckpointMemoryJournal();
      const target = await open('disconnected', journal);
      target.value.append(action());
      await target.provider.consolidate();
      if (tail) {
        target.value.append(action(B));
        await target.provider.flush();
      }
      // Model the unchanged old provider's complete-read startup path before subscription/seed.
      const append = vi.spyOn(journal, 'append');
      append.mockClear();
      const value = store();
      const subscribe = vi.spyOn(value, 'onUpdate');
      const legacy: ActionJournal = {
        read: () => journal.read(),
        append: (update) => journal.append(update),
        close: () => journal.close(),
      };
      await expect(
        DirectionalActionProvider.open({ store: value, journal: legacy, mode: 'disconnected' }),
      ).rejects.toThrow('Checkpoint-aware');
      expect(subscribe).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'fails startup on corrupt/unsupported checkpoint before authoring with tail=%s',
    async (tail) => {
      const journal = new CheckpointMemoryJournal();
      journal.checkpoint = new Uint8Array([255]);
      if (tail) journal.entries.push(source()[0]);
      const value = store();
      const subscribe = vi.spyOn(value, 'onUpdate');
      const append = vi.spyOn(journal, 'append');
      await expect(open('disconnected', journal, value)).rejects.toThrow();
      expect(journal.closed).toBe(true);
      expect(subscribe).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(value.snapshot().actions).toHaveLength(0);
    },
  );

  it('retains checkpoint state through strict one-way retransmission, state-vector suffix and old dependencies', async () => {
    const journal = new CheckpointMemoryJournal();
    const sender = await open('outbound-only', journal);
    const a1 = action();
    sender.value.append(a1);
    await sender.provider.consolidate();
    await sender.provider.close();
    const resumed = await open('outbound-only', journal);
    const receiver = await open('inbound-only');
    const offline = await open('disconnected');
    offline.provider.setMode('bidirectional');
    offline.provider.receive('peer', sender.value.encodeUpdate());
    offline.provider.setMode('disconnected');
    const messages: OutboundMessage[] = [];
    resumed.provider.attachPeer('receiver', {
      send: (message) => {
        messages.push(message);
      },
    });
    await resumed.provider.publish();
    messages.length = 0; // lost bootstrap, no acknowledgment or return channel
    resumed.value.append(action(A, 2n, [a1]));
    await resumed.provider.publish();
    const retry = messages.at(-1)!;
    receiver.provider.receive('peer', retry.update);
    receiver.provider.receive('peer', retry.update);
    offline.value.append(action(C, 1n, [a1]));
    offline.provider.setMode('outbound-only');
    offline.provider.attachPeer('receiver', {
      send: ({ update }) => {
        receiver.provider.receive('peer', update);
      },
    });
    await offline.provider.publish();
    expect(receiver.value.snapshot().ready).toHaveLength(3);
    resumed.provider.setMode('bidirectional');
    const vector = resumed.value.encodeStateVector();
    resumed.provider.receive('peer', receiver.value.encodeUpdate(vector));
    expect(resumed.value.encodeUpdate()).toEqual(receiver.value.encodeUpdate());
    await resumed.provider.consolidate();
    await resumed.provider.close();
    const loaded = await open('disconnected', journal);
    expect(loaded.value.encodeUpdate()).toEqual(receiver.value.encodeUpdate());
    expect(loaded.value.snapshot()).toEqual(receiver.value.snapshot());
  });
});

it('reserves replacement before delayed hashing and rejects a present undefined in-memory checkpoint', async () => {
  const journal = new CheckpointMemoryJournal();
  const target = await open('bidirectional', journal);
  target.value.append(action());
  await target.provider.flush();
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const gate = deferred();
  let first = true;
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    if (first) {
      first = false;
      await gate.promise;
    }
    return original(algorithm, data);
  });
  const oldEntries = journal.entries.map((entry) => entry.slice());
  const consolidating = target.provider.consolidate();
  target.value.append(action(B));
  let settled = false;
  const flush = target.provider.flush().then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(journal.entries).toEqual(oldEntries);
  expect(settled).toBe(false);
  gate.resolve();
  await consolidating;
  await flush;
  spy.mockRestore();
  expect(journal.entries).toHaveLength(1);
  const invalid = new CheckpointMemoryJournal();
  invalid.checkpoint = undefined;
  await expect(invalid.read()).rejects.toThrow('Checkpoint-aware');
  await expect(open('disconnected', invalid)).rejects.toThrow('Invalid journal checkpoint');
});

it('retries a failed hash from the original detached prefix before persisting later tail work', async () => {
  const journal = new CheckpointMemoryJournal();
  const target = await open('bidirectional', journal);
  target.value.append(action());
  await target.provider.flush();
  const captured = target.value.encodeUpdate();
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi
    .spyOn(crypto.subtle, 'digest')
    .mockRejectedValueOnce(new Error('temporary digest failure'));
  const consolidating = target.provider.consolidate();
  target.value.append(action(B));
  await expect(consolidating).rejects.toThrow('temporary digest failure');
  expect(journal.checkpoint).toBeUndefined();
  spy.mockImplementation(original);
  await target.provider.retryPersistence();
  spy.mockRestore();
  const { decodeCheckpoint } = await import('../checkpoints/index.js');
  expect(decodeCheckpoint(journal.checkpoint!).update).toEqual(captured);
  expect(journal.entries).toHaveLength(1);
  await target.provider.close();
  const restored = await open('disconnected', journal);
  expect(restored.value.encodeUpdate()).toEqual(target.value.encodeUpdate());
});
