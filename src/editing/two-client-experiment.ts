import { CanonicalDocument } from '../markdown/canonical/document.js';
import type { AcceptedUpdate } from '../markdown/canonical/document-types.js';

export type TwoClientStatus = 'ready' | 'delivering' | 'failed' | 'closed';

export interface TwoClientState {
  readonly status: TwoClientStatus;
  readonly revision: number;
  readonly error?: string;
}

export interface TwoClientReplica {
  readonly label: 'Client A' | 'Client B';
  readonly sessionId: 'client-a' | 'client-b';
  readonly document: CanonicalDocument;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Delivers one authority's accepted native updates to two validated client replicas. */
export class TwoClientExperiment {
  readonly clients: readonly [TwoClientReplica, TwoClientReplica];
  private status_: TwoClientStatus = 'ready';
  private revision_: number;
  private error_: string | undefined;
  private delivering = false;
  private lastEnvelope?: AcceptedUpdate;

  constructor(
    private readonly authority: CanonicalDocument,
    private readonly onStateChange: (state: TwoClientState) => void = () => {},
  ) {
    const checkpoint = authority.checkpoint();
    this.revision_ = checkpoint.acceptedRevision;
    this.clients = Object.freeze([
      Object.freeze({
        label: 'Client A' as const,
        sessionId: 'client-a' as const,
        document: CanonicalDocument.open(checkpoint),
      }),
      Object.freeze({
        label: 'Client B' as const,
        sessionId: 'client-b' as const,
        document: CanonicalDocument.open(checkpoint),
      }),
    ]);
  }

  get state(): TwoClientState {
    return Object.freeze({
      status: this.status_,
      revision: this.revision_,
      ...(this.error_ ? { error: this.error_ } : {}),
    });
  }

  reportPublicationErrors(callbackErrors: readonly unknown[]): boolean {
    if (this.status_ === 'closed' || this.status_ === 'failed') return false;
    if (callbackErrors.length) {
      this.fail(`Authority publication callback failed: ${describeError(callbackErrors[0])}`);
      return false;
    }
    return this.status_ === 'ready';
  }

  /** Returns false when delivery or an authority callback made the experiment unsafe to continue. */
  receiveAccepted(envelope: AcceptedUpdate, callbackErrors: readonly unknown[] = []): boolean {
    if (this.status_ === 'closed' || this.status_ === 'failed') return false;
    if (this.delivering) {
      this.fail('A later accepted update arrived before the current delivery finished.');
      return false;
    }
    if (callbackErrors.length) {
      return this.reportPublicationErrors(callbackErrors);
    }
    if (
      envelope.revision === this.revision_ &&
      this.lastEnvelope &&
      equalBytes(envelope.update, this.lastEnvelope.update)
    ) {
      return true;
    }
    if (envelope.revision !== this.revision_ + 1) {
      this.fail(`Expected accepted revision ${this.revision_ + 1}, received ${envelope.revision}.`);
      return false;
    }
    if (envelope.revision !== this.authority.acceptedRevision) {
      this.fail(
        `Authority is at revision ${this.authority.acceptedRevision}, but delivery was ${envelope.revision}.`,
      );
      return false;
    }

    this.delivering = true;
    this.status_ = 'delivering';
    const copy = Object.freeze({
      revision: envelope.revision,
      update: Uint8Array.from(envelope.update),
    });
    try {
      this.notifyState();
      if (!this.isDelivering()) return false;
      for (const client of this.clients) {
        const errors = client.document.applyAccepted(copy);
        if (errors.length) {
          throw new Error(
            `${client.label} projection callback failed: ${describeError(errors[0])}`,
          );
        }
      }
      if (this.isClosed()) return false;
      if (this.clients.some((client) => client.document.acceptedRevision !== envelope.revision)) {
        throw new Error('Client revisions diverged after accepted update delivery.');
      }
      this.revision_ = envelope.revision;
      this.lastEnvelope = copy;
      if (!this.isDelivering()) return false;
      if (this.authority.acceptedRevision !== envelope.revision) {
        this.fail(
          `Authority advanced to revision ${this.authority.acceptedRevision} during delivery of ${envelope.revision}.`,
        );
        return false;
      }
      this.status_ = 'ready';
      return true;
    } catch (error) {
      this.fail(`Accepted update delivery failed: ${describeError(error)}`);
      return false;
    } finally {
      this.delivering = false;
      this.notifyState();
    }
  }

  close(): void {
    if (this.status_ === 'closed') return;
    for (const client of this.clients) client.document.close();
    this.status_ = 'closed';
    this.notifyState();
  }

  private fail(message: string): void {
    if (this.status_ === 'closed' || this.status_ === 'failed') return;
    this.status_ = 'failed';
    this.error_ = message;
    this.notifyState();
  }

  private isDelivering(): boolean {
    return this.status_ === 'delivering';
  }

  private isClosed(): boolean {
    return this.status_ === 'closed';
  }

  private notifyState(): void {
    try {
      this.onStateChange(this.state);
    } catch {
      // The experiment state remains authoritative even if its view cannot refresh.
    }
  }
}
