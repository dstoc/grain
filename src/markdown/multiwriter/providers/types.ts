import type { PROTOCOL_VERSION } from '../contracts.js';

/** One durable replica owns a namespace. Independent writers must never share it. */
export interface JournalIdentity {
  readonly namespace: string;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentId: string;
  readonly genesisId: string;
}

/** Implementations resolve append only after durable transaction completion. */
export interface ActionJournal {
  read(): Promise<readonly Uint8Array[]>;
  append(update: Uint8Array): Promise<void>;
  close(): void;
}

export interface OutboundMessage {
  /** Opaque token: acknowledge only this exact message on this peer attachment. */
  readonly id: string;
  readonly update: Uint8Array;
}

/** The host owns callback wiring, reconnect and periodic strict one-way retries. */
export interface PeerTransport {
  readonly acknowledgments?: boolean;
  /** Resolution means handed off, never acknowledged or semantically ready. */
  send(message: OutboundMessage): void | Promise<void>;
  requestCatchUp?(): void | Promise<void>;
}

export interface ProviderFailure {
  readonly operation: 'persistence' | 'send' | 'catch-up';
  readonly error: unknown;
  readonly peer?: string;
}
