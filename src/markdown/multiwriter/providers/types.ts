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
  /** Complete replay source. Checkpoint-capable adapters reject when a checkpoint exists. */
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

export interface CheckpointJournalState {
  /** Absent means legacy journal. A present invalid/undefined record must fail reading. */
  readonly checkpoint?: Uint8Array;
  readonly updates: readonly Uint8Array[];
}

/**
 * One exclusive provider owns this journal. Both reads use a consistent storage snapshot.
 * Fence unsupported readers before replacing their complete replay source. Inherited read()
 * returns all updates without a checkpoint, and rejects whenever a checkpoint is present.
 */
export interface CheckpointActionJournal extends ActionJournal {
  readCheckpoint(): Promise<CheckpointJournalState>;
  /** Copy synchronously; atomically replace checkpoint + whole persisted prefix at durable commit.
   * Failure preserves the old recoverable state. Direct writes during provider ownership are forbidden.
   */
  replaceWithCheckpoint(checkpoint: Uint8Array): Promise<void>;
}

export function isCheckpointJournal(journal: ActionJournal): journal is CheckpointActionJournal {
  return (
    'readCheckpoint' in journal &&
    typeof journal.readCheckpoint === 'function' &&
    'replaceWithCheckpoint' in journal &&
    typeof journal.replaceWithCheckpoint === 'function'
  );
}
