import { DEFAULT_INGEST_LIMITS, IngestCapacityError, assertLimit } from '../ingest/work.js';
import { ActionStore } from '../actions/store.js';
import { SYNC_DIRECTIONS } from '../contracts.js';
import type { DeliveryRoute, PublicationStatus, SyncMode } from '../contracts.js';
import type { ActionJournal, PeerTransport, ProviderFailure } from './types.js';

export interface ProviderOptions {
  readonly store: ActionStore;
  readonly journal: ActionJournal;
  readonly mode: SyncMode;
  readonly limits?: Partial<ProviderLimits>;
  readonly restoreOperations?: number;
  readonly onError?: (failure: ProviderFailure) => void;
}

export interface ProviderLimits {
  readonly messageBytes: number;
  readonly persistenceBytes: number;
}
export type ReceiveResult =
  | { readonly state: 'admitted' }
  | { readonly state: 'disabled' }
  | { readonly state: 'backpressured'; readonly error: IngestCapacityError };

/** Captured after a successful host publication, never inferred from remote receipt. */
export interface LocalPublication {
  status(peer?: string): PublicationStatus;
}
interface Peer {
  readonly transport: PeerTransport;
  readonly sent: Map<string, number>;
  acknowledged: number;
  vector?: Uint8Array;
  automaticCoverage?: Uint8Array;
  work: Promise<void>;
}
const equal = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a?.length === b.length && a.every((value, index) => value === b[index]);

/** Owns IO only. The caller retains its ActionStore, writer, sessions and history. */
export class DirectionalActionProvider {
  private mode: SyncMode;
  private readonly peers = new Map<string, Peer>();
  private readonly queue: { position: number; update: Uint8Array }[] = [];
  private tail = 0;
  private durable = 0;
  private write?: Promise<void>;
  private writeFailure?: { error: unknown };
  private remoteEvents?: Uint8Array[];
  private readonly unsubscribe: () => void;
  private stopped = false;
  private journalClosed = false;
  private nextMessage = 0;
  private queuedBytes = 0;
  private limits: ProviderLimits;
  private readonly instanceId = crypto.randomUUID();

  /** Host must suspend authoring until open resolves. Failed replay fails opening. */
  static async open(options: ProviderOptions): Promise<DirectionalActionProvider> {
    try {
      const operations = options.restoreOperations ?? DEFAULT_INGEST_LIMITS.operations;
      assertLimit(operations);
      if (!operations) throw new IngestCapacityError('validation', 'restoreOperations', 1);
      for (const update of await options.journal.read()) options.store.applyUpdate(update);
      let readiness = options.store.compute(operations);
      while (readiness.state === 'deferred') {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        readiness = readiness.continuation.resume(operations);
      }
      return new DirectionalActionProvider(options);
    } catch (error) {
      options.journal.close();
      throw error;
    }
  }

  private constructor(private readonly options: ProviderOptions) {
    this.mode = options.mode;
    this.limits = {
      messageBytes: DEFAULT_INGEST_LIMITS.messageBytes,
      persistenceBytes: DEFAULT_INGEST_LIMITS.persistenceBytes,
      ...options.limits,
    };
    assertLimit(this.limits.messageBytes);
    assertLimit(this.limits.persistenceBytes);
    // No await between subscription, full unresolved seed, and returning to the host.
    this.unsubscribe = options.store.onUpdate((update) => {
      if (this.remoteEvents) this.remoteEvents.push(update);
      else {
        this.enqueue(update);
        this.automaticallyPublish();
      }
    });
    this.enqueue(options.store.encodeUpdate());
  }

  /** All network/catch-up/echo/cross-tab callbacks must use this entry point. */
  receive(route: DeliveryRoute, update: Uint8Array): boolean {
    return this.receiveResult(route, update).state === 'admitted';
  }

  receiveResult(route: DeliveryRoute, update: Uint8Array): ReceiveResult {
    this.assertOpen();
    // route is deliberately policy-neutral: every route has the same gate.
    void route;
    if (!SYNC_DIRECTIONS[this.mode].receive) return { state: 'disabled' };
    if (update.byteLength > this.limits.messageBytes)
      return {
        state: 'backpressured',
        error: new IngestCapacityError('carrier', 'messageBytes', update.byteLength),
      };
    const required = this.queuedBytes + this.options.store.persistenceReservation(update);
    if (required > this.limits.persistenceBytes)
      return {
        state: 'backpressured',
        error: new IngestCapacityError('persistence', 'persistenceBytes', required),
      };
    const copy = update.slice();
    const staged: Uint8Array[] = [];
    this.remoteEvents = staged;
    try {
      this.options.store.applyUpdate(copy);
    } catch (error) {
      if (!(error instanceof IngestCapacityError)) throw error;
      return { state: 'backpressured', error };
    } finally {
      this.remoteEvents = undefined;
    }
    // If apply throws, neither its events nor ingress enter persistence/publication.
    for (const event of staged) this.enqueue(event);
    this.enqueue(copy);
    this.automaticallyPublish();
    return { state: 'admitted' };
  }

  setLimits(limits: Partial<ProviderLimits>): void {
    this.assertOpen();
    const next = { ...this.limits, ...limits };
    assertLimit(next.messageBytes);
    assertLimit(next.persistenceBytes);
    this.limits = next;
  }

  setMode(mode: SyncMode): void {
    this.assertOpen();
    const before = SYNC_DIRECTIONS[this.mode];
    this.mode = mode;
    const after = SYNC_DIRECTIONS[mode];
    if (!before.send && after.send) {
      for (const peer of this.peers.values()) peer.automaticCoverage = undefined;
      this.automaticallyPublish();
    }
    if (!before.receive && after.receive)
      for (const [id, peer] of this.peers) this.requestCatchUp(id, peer);
  }

  attachPeer(id: string, transport: PeerTransport): () => void {
    this.assertOpen();
    if (this.peers.has(id)) throw new Error('Peer already attached');
    const peer: Peer = { transport, sent: new Map(), acknowledged: -1, work: Promise.resolve() };
    this.peers.set(id, peer);
    this.scheduleSend(id, peer, false);
    if (SYNC_DIRECTIONS[this.mode].receive) this.requestCatchUp(id, peer);
    return () => {
      if (this.peers.get(id) === peer) this.peers.delete(id);
    };
  }

  /** Control feedback imports no document facts, even when receiving is disabled. */
  setPeerStateVector(id: string, vector: Uint8Array): void {
    this.assertOpen();
    this.peer(id).vector = vector.slice();
  }

  acknowledge(id: string, messageId: string): void {
    this.assertOpen();
    const peer = this.peer(id);
    if (!peer.transport.acknowledgments) return;
    const position = peer.sent.get(messageId);
    if (position === undefined) return;
    peer.acknowledged = Math.max(peer.acknowledged, position);
    for (const [token, coverage] of peer.sent)
      if (coverage <= peer.acknowledged) peer.sent.delete(token);
  }

  /** Explicit retry always exports coverage, including after accepted-but-lost sends. */
  async publish(): Promise<void> {
    this.assertOpen();
    await Promise.all([...this.peers].map(([id, peer]) => this.scheduleSend(id, peer, true)));
  }

  capturePublication(): LocalPublication {
    this.assertOpen();
    const position = this.tail;
    // Bind delivery to this attachment, so peer ID reuse cannot acknowledge old work.
    const peers = new Map(this.peers);
    return {
      status: (id) => {
        const peer = id === undefined ? undefined : peers.get(id);
        return {
          applied: true,
          persisted: this.durable >= position,
          ...(peer?.transport.acknowledgments ? { delivered: peer.acknowledged >= position } : {}),
        };
      },
    };
  }

  /** Captures a contiguous prefix; later appends do not delay this fence. */
  async flush(): Promise<void> {
    const target = this.tail;
    while (this.durable < target) {
      if (this.writeFailure) throw this.writeFailure.error;
      this.startWrite();
      await this.write;
    }
  }

  async retryPersistence(): Promise<void> {
    this.writeFailure = undefined;
    await this.flush();
  }

  /** Stop authoring first. A failed close retains queued bytes for retry/close again. */
  async close(): Promise<void> {
    if (this.journalClosed) return;
    this.stopped = true;
    this.peers.clear();
    this.unsubscribe();
    await this.flush();
    this.options.journal.close();
    this.journalClosed = true;
  }

  private enqueue(update: Uint8Array): void {
    this.queuedBytes += update.byteLength;
    this.queue.push({ position: ++this.tail, update: update.slice() });
    this.startWrite();
  }

  private startWrite(): void {
    if (this.write || this.writeFailure || !this.queue.length) return;
    const entry = this.queue[0];
    // One transaction per entry makes the acknowledged prefix explicit.
    this.write = Promise.resolve()
      .then(() => this.options.journal.append(entry.update.slice()))
      .then(() => {
        this.durable = entry.position;
        this.queue.shift();
        this.queuedBytes -= entry.update.byteLength;
      })
      .catch((error: unknown) => {
        this.writeFailure = { error };
        this.report({ operation: 'persistence', error });
      })
      .finally(() => {
        this.write = undefined;
        this.startWrite();
      });
  }

  private automaticallyPublish(): void {
    for (const [id, peer] of this.peers) void this.scheduleSend(id, peer, false);
  }

  private scheduleSend(id: string, peer: Peer, explicit: boolean): Promise<void> {
    const task = peer.work.then(async () => {
      // Check after queued waits, immediately before invoking host transport.
      if (this.stopped || this.peers.get(id) !== peer || !SYNC_DIRECTIONS[this.mode].send) return;
      const coverage = this.options.store.encodeUpdate();
      if (!explicit && equal(peer.automaticCoverage, coverage)) return;
      const messageId = `${this.instanceId}:${++this.nextMessage}`;
      const position = this.tail;
      const update = peer.vector ? this.options.store.encodeUpdate(peer.vector) : coverage.slice();
      peer.automaticCoverage = coverage;
      if (peer.transport.acknowledgments) peer.sent.set(messageId, position);
      await peer.transport.send({ id: messageId, update });
    });
    // Keep subsequent attempts usable while explicit callers still observe failure.
    peer.work = task.catch((error: unknown) => {
      this.report({ operation: 'send', peer: id, error });
    });
    return explicit ? task : peer.work;
  }

  private requestCatchUp(id: string, peer: Peer): void {
    try {
      void Promise.resolve(peer.transport.requestCatchUp?.()).catch((error: unknown) => {
        this.report({ operation: 'catch-up', peer: id, error });
      });
    } catch (error) {
      this.report({ operation: 'catch-up', peer: id, error });
    }
  }

  private report(failure: ProviderFailure): void {
    this.options.onError?.(failure);
  }

  private peer(id: string): Peer {
    const peer = this.peers.get(id);
    if (!peer) throw new Error('Unknown peer');
    return peer;
  }

  private assertOpen(): void {
    if (this.stopped) throw new Error('Provider is closed');
  }
}
