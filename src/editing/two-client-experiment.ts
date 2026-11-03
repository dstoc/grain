import { CanonicalDocument } from '../markdown/canonical/document.js';
import type { AcceptedUpdate } from '../markdown/canonical/document-types.js';
import type {
  AcceptedAction,
  ActionRequest,
  AdmittedContext,
  ApplyResult,
  HistoryResult,
  PendingCommit,
} from '../markdown/canonical/action-types.js';
import { CanonicalWriter } from '../markdown/canonical/writer.js';
import type { BrowserSessionTransport } from './browser/session-runner.js';

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
  readonly writer?: CanonicalWriter;
}

interface PendingPaneAction {
  readonly writer: CanonicalWriter;
  readonly request: ActionRequest;
  readonly pending: PendingCommit;
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
  private readonly pendingActions = new Map<string, PendingPaneAction>();
  private readonly transports = new Map<string, BrowserSessionTransport>();

  constructor(
    private readonly authority: CanonicalDocument,
    private readonly onStateChange: (state: TwoClientState) => void = () => {},
    private readonly authorityWriter?: CanonicalWriter,
  ) {
    const checkpoint = authority.checkpoint();
    this.revision_ = checkpoint.acceptedRevision;
    const makeClient = (
      label: TwoClientReplica['label'],
      sessionId: TwoClientReplica['sessionId'],
    ) => {
      const document = CanonicalDocument.open(checkpoint);
      if (!authorityWriter) return Object.freeze({ label, sessionId, document });
      authorityWriter.admitSession(sessionId);
      const writer = new CanonicalWriter(document);
      writer.admitSession(sessionId);
      return Object.freeze({ label, sessionId, document, writer });
    };
    this.clients = Object.freeze([
      makeClient('Client A', 'client-a'),
      makeClient('Client B', 'client-b'),
    ]);
  }

  get state(): TwoClientState {
    return Object.freeze({
      status: this.status_,
      revision: this.revision_,
      ...(this.error_ ? { error: this.error_ } : {}),
    });
  }

  sessionTransport(sessionId: TwoClientReplica['sessionId']): BrowserSessionTransport | undefined {
    if (!this.authorityWriter) return undefined;
    let transport = this.transports.get(sessionId);
    if (transport) return transport;
    transport = {
      isReady: () => this.status_ === 'ready',
      apply: (writer, request, context) =>
        this.applyPaneAction(sessionId, writer, request, context),
      publish: (writer, request, pending) =>
        this.publishPaneAction(sessionId, writer, request, pending),
      canUndo: (session) => this.authorityWriter!.canUndo(session),
      canRedo: (session) => this.authorityWriter!.canRedo(session),
      sealTextGroup: (session) => this.authorityWriter!.sealTextGroup(session),
      undo: (session) => this.applyHistory('undo', session),
      redo: (session) => this.applyHistory('redo', session),
    };
    this.transports.set(sessionId, transport);
    return transport;
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
    for (const [sessionId, pending] of this.pendingActions) {
      pending.writer.releasePreparedAction(pending.request);
      this.pendingActions.delete(sessionId);
    }
    for (const client of this.clients) client.writer?.close();
    for (const client of this.clients) client.document.close();
    this.transports.clear();
    this.status_ = 'closed';
    this.notifyState();
  }

  private applyPaneAction(
    sessionId: TwoClientReplica['sessionId'],
    writer: CanonicalWriter,
    request: ActionRequest,
    context: AdmittedContext,
  ): ApplyResult {
    const client = this.clients.find((candidate) => candidate.sessionId === sessionId);
    if (
      this.status_ !== 'ready' ||
      !client ||
      client.writer !== writer ||
      request.sessionId !== sessionId ||
      context.sessionId !== sessionId
    ) {
      throw new Error('Connected pane is not ready to submit this action.');
    }
    if (this.pendingActions.has(sessionId))
      throw new Error(`Session ${sessionId} already has an outstanding authority action.`);
    const result = this.authorityWriter!.apply(request, context);
    if (result.status === 'duplicate') {
      try {
        writer.acknowledgePreparedAction(request, result.accepted);
      } catch (error) {
        this.fail(`Accepted duplicate acknowledgement failed: ${describeError(error)}`);
        throw error;
      }
    } else if (result.status === 'pending') {
      if (result.pending.actionId !== request.actionId)
        throw new Error('Authority prepared a different action than the pane submitted.');
      this.pendingActions.set(sessionId, { writer, request, pending: result.pending });
    }
    return result;
  }

  private publishPaneAction(
    sessionId: TwoClientReplica['sessionId'],
    writer: CanonicalWriter,
    request: ActionRequest,
    pending: PendingCommit,
  ): AcceptedAction {
    const staged = this.pendingActions.get(sessionId);
    if (
      this.status_ !== 'ready' ||
      !staged ||
      staged.writer !== writer ||
      staged.request.actionId !== request.actionId ||
      staged.request.sessionId !== request.sessionId ||
      staged.request.sessionSequence !== request.sessionSequence ||
      staged.pending !== pending
    ) {
      throw new Error('Connected action does not match the authority pending commit.');
    }
    const accepted = this.authorityWriter!.publish(pending);
    if (!this.receiveAccepted(accepted, accepted.callbackErrors)) {
      throw new Error(this.state.error ?? 'Authority update delivery failed.');
    }
    try {
      writer.acknowledgePreparedAction(request, accepted);
      this.pendingActions.delete(sessionId);
    } catch (error) {
      this.fail(`Accepted action acknowledgement failed: ${describeError(error)}`);
      throw error;
    }
    return accepted;
  }

  private applyHistory(direction: 'undo' | 'redo', sessionId: string): HistoryResult {
    if (this.status_ !== 'ready') throw new Error('Connected experiment is not ready for history.');
    const result =
      direction === 'undo'
        ? this.authorityWriter!.undo(sessionId)
        : this.authorityWriter!.redo(sessionId);
    if (result.update && result.revision !== undefined) {
      this.receiveAccepted(
        { revision: result.revision, update: result.update },
        result.callbackErrors ?? [],
      );
    } else if (result.callbackErrors?.length) {
      this.reportPublicationErrors(result.callbackErrors);
    }
    return result;
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
