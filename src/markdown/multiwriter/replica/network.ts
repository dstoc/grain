import type { DeliveryRoute } from '../contracts.js';
import type { ReceiveResult } from '../providers/index.js';
import type { Replica } from './index.js';

export interface Delivery {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly messageId: string;
  readonly update: Uint8Array;
}
/** Host-owned development scheduler. It retains opaque original carrier bytes.
 * Queueing is handoff, never a receipt. Disabled deliveries are consumed; retry
 * requests fresh complete sender coverage rather than saving a hidden inbox.
 */
export class ReplicaNetwork {
  private readonly replicas = new Map<string, Replica>();
  private readonly removals = new Map<string, () => void>();
  private readonly links = new Map<string, () => void>();
  private readonly messages: Delivery[] = [];
  private sequence = 0;
  private automatic = false;
  private scheduled = false;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly onError: (error: unknown) => void = () => {}) {}
  add(id: string, replica: Replica): () => void {
    if (this.replicas.has(id)) throw new Error('Replica already registered');
    this.replicas.set(id, replica);
    const stop = replica.subscribe((event) => {
      if (event === 'closing') remove();
    });
    const remove = () => {
      if (this.replicas.get(id) !== replica) return;
      stop();
      this.removals.delete(id);
      this.replicas.delete(id);
      for (const [key, detach] of this.links) {
        const [from, to] = JSON.parse(key) as [string, string];
        if (from === id || to === id) {
          detach();
          this.links.delete(key);
        }
      }
      this.changed();
    };
    this.removals.set(id, remove);
    return remove;
  }
  connect(from: string, to: string): () => void {
    if (from === to) throw new Error('Use explicit self-echo ingress for a self delivery');
    const sender = this.replica(from);
    this.replica(to);
    const key = JSON.stringify([from, to]);
    if (this.links.has(key)) throw new Error('Link already connected');
    const detach = sender.attachPeer(`scheduler:${to}`, {
      send: (message) => {
        this.messages.push({
          id: ++this.sequence,
          from,
          to,
          messageId: message.id,
          update: message.update.slice(),
        });
        this.changed();
        this.schedule();
      },
      requestCatchUp: () => this.replica(to).publish(),
    });
    const remove = () => {
      if (this.links.get(key) !== remove) return;
      detach();
      this.links.delete(key);
    };
    this.links.set(key, remove);
    return remove;
  }
  queue(): readonly Delivery[] {
    return this.messages.map((m) => ({ ...m, update: m.update.slice() }));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setAutomatic(automatic: boolean): void {
    this.automatic = automatic;
    this.schedule();
    this.changed();
  }
  deliver(id: number, route: DeliveryRoute = 'peer'): ReceiveResult {
    const index = this.index(id);
    const message = this.messages.splice(index, 1)[0];
    this.changed();
    return this.replica(message.to).receive(route, message.update.slice());
  }
  duplicate(id: number): number {
    const message = this.messages[this.index(id)];
    const copy = { ...message, id: ++this.sequence, update: message.update.slice() };
    this.messages.push(copy);
    this.changed();
    this.schedule();
    return copy.id;
  }
  drop(id: number): void {
    this.messages.splice(this.index(id), 1);
    this.changed();
  }
  move(id: number, before: number | null): void {
    if (id === before) return;
    if (before !== null) this.index(before);
    const message = this.messages.splice(this.index(id), 1)[0];
    this.messages.splice(before === null ? this.messages.length : this.index(before), 0, message);
    this.changed();
  }
  retry(from: string): Promise<void> {
    return this.replica(from).publish();
  }
  dispose(): void {
    this.automatic = false;
    for (const detach of Array.from(this.links.values())) detach();
    for (const remove of Array.from(this.removals.values())) remove();
    this.messages.length = 0;
    this.listeners.clear();
  }
  private index(id: number): number {
    const index = this.messages.findIndex((m) => m.id === id);
    if (index < 0) throw new Error('Unknown delivery');
    return index;
  }
  private replica(id: string): Replica {
    const replica = this.replicas.get(id);
    if (!replica) throw new Error('Replica is not attached');
    return replica;
  }
  private schedule() {
    if (!this.automatic || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.automatic) return;
      for (const message of Array.from(this.messages)) {
        try {
          this.deliver(message.id);
        } catch (error) {
          this.onError(error);
        }
      }
    });
  }
  private changed() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.onError(error);
      }
    }
  }
}
