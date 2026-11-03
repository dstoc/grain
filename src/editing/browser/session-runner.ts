import { CanonicalWriter } from '../../markdown/canonical/writer.js';
import type {
  ActionRequest,
  AdmittedContext,
  AcceptedAction,
  ApplyResult,
  ActionOptions,
  HistoryResult,
  PendingCommit,
} from '../../markdown/canonical/action-types.js';
import type { CanonicalDocument } from '../../markdown/canonical/document.js';
import type { EditSelection } from '../../markdown/semantic/selection.js';
import type { NodeId } from '../../markdown/semantic/types.js';
import { prepareEdit } from '../prepare-edit.js';
import type { Edit } from '../outcomes.js';

let fallbackActionOrdinal = 0;

export interface SessionActionCallbacks {
  readonly onAccepted: (
    accepted: AcceptedAction,
    selection?: import('../../markdown/semantic/selection.js').SelectionIntent,
  ) => void;
  readonly onRejected: (error: unknown) => void;
  readonly withLocalCommit: (action: () => void) => void;
}

/** Routes one pane's prepared actions and history through its connected authority. */
export interface BrowserSessionTransport {
  isReady(): boolean;
  apply(writer: CanonicalWriter, request: ActionRequest, context: AdmittedContext): ApplyResult;
  publish(writer: CanonicalWriter, request: ActionRequest, pending: PendingCommit): AcceptedAction;
  canUndo(sessionId: string): boolean;
  canRedo(sessionId: string): boolean;
  sealTextGroup(sessionId: string): void;
  undo(sessionId: string): HistoryResult;
  redo(sessionId: string): HistoryResult;
}

/** Owns one editor binding's session attribution and action/history grouping. */
export class BrowserSessionRunner {
  private document?: CanonicalDocument;
  private writer?: CanonicalWriter;
  private transport?: BrowserSessionTransport;
  private sessionId = 'local';
  private generation_ = 0;
  private textGroup?: { readonly id: string; readonly nodeId: NodeId; lastInputAt: number };

  get generation(): number {
    return this.generation_;
  }

  get hasTypingGroup(): boolean {
    return this.textGroup !== undefined;
  }

  isCurrentGeneration(generation: number): boolean {
    return generation === this.generation_;
  }

  bind(
    document: CanonicalDocument | undefined,
    writer: CanonicalWriter | undefined,
    sessionId: string,
    transport?: BrowserSessionTransport,
  ): void {
    if (
      this.document === document &&
      this.writer === writer &&
      this.sessionId === sessionId &&
      this.transport === transport
    ) {
      return;
    }
    this.sealTypingGroup();
    this.generation_++;
    this.document = document;
    this.writer = writer;
    this.sessionId = sessionId;
    this.transport = transport;
    writer?.admitSession(sessionId);
  }

  disconnect(): void {
    this.sealTypingGroup();
    this.generation_++;
    this.document = undefined;
    this.writer = undefined;
    this.transport = undefined;
  }

  isCurrent(
    generation: number,
    document = this.document,
    writer = this.writer,
    sessionId = this.sessionId,
  ): boolean {
    return (
      generation === this.generation_ &&
      this.document === document &&
      this.writer === writer &&
      this.sessionId === sessionId
    );
  }

  sealTypingGroup(): void {
    this.textGroup = undefined;
    if (this.transport) this.transport.sealTextGroup(this.sessionId);
    else this.writer?.sealTextGroup(this.sessionId);
  }

  canUndo(): boolean {
    if (this.transport) return this.transport.canUndo(this.sessionId);
    return this.writer?.canUndo(this.sessionId) ?? false;
  }

  canRedo(): boolean {
    if (this.transport) return this.transport.canRedo(this.sessionId);
    return this.writer?.canRedo(this.sessionId) ?? false;
  }

  undo(): HistoryResult | undefined {
    this.sealTypingGroup();
    if (this.transport) return this.transport.undo(this.sessionId);
    return this.writer?.undo(this.sessionId);
  }

  redo(): HistoryResult | undefined {
    this.sealTypingGroup();
    if (this.transport) return this.transport.redo(this.sessionId);
    return this.writer?.redo(this.sessionId);
  }

  runCommand<Input>(
    command: Edit<Input>,
    input: Input,
    selectionBefore: EditSelection | undefined,
    callbacks: SessionActionCallbacks,
  ): void {
    const document = this.document;
    const writer = this.writer;
    const sessionId = this.sessionId;
    const generation = this.generation_;
    if (!document || !writer) return;
    if (
      writer.deferLocalEdit(() => {
        if (this.isCurrent(generation, document, writer, sessionId))
          this.runCommand(command, input, selectionBefore, callbacks);
      })
    ) {
      return;
    }

    try {
      const prepared = prepareEdit(
        writer,
        this.options(),
        document.root.sharedId,
        selectionBefore,
        command,
        input,
      );
      if (!prepared) return;
      this.sealTypingGroup();
      callbacks.withLocalCommit(() => {
        this.submit(writer, prepared.request, sessionId, callbacks, prepared.selection);
      });
    } catch (error) {
      callbacks.onRejected(error);
    }
  }

  runTextInput(
    nodeId: NodeId,
    from: number,
    to: number,
    insert: string,
    isolated: boolean,
    callbacks: SessionActionCallbacks,
    onPrepared: (caretOffset: number) => void,
    selectionBefore?: { readonly anchor: number; readonly focus: number },
  ): void {
    const document = this.document;
    const writer = this.writer;
    if (!document || !writer) return;
    const group = this.inputHistoryGroup(nodeId, isolated);
    const start = { nodeId, offset: from, affinity: 'left' as const };
    const end = { nodeId, offset: from + insert.length, affinity: 'right' as const };
    const focus = {
      start,
      end,
      ...(selectionBefore
        ? {
            selection: {
              anchor: {
                nodeId,
                offset: selectionBefore.anchor,
                affinity:
                  selectionBefore.anchor <= selectionBefore.focus
                    ? ('left' as const)
                    : ('right' as const),
              },
              focus: {
                nodeId,
                offset: selectionBefore.focus,
                affinity:
                  selectionBefore.focus >= selectionBefore.anchor
                    ? ('right' as const)
                    : ('left' as const),
              },
              kind: 'text' as const,
            },
          }
        : {}),
    };
    onPrepared(end.offset);
    try {
      const request = writer.prepareTextInput(
        nodeId,
        { from, to, insert },
        { ...this.options(group), focus },
      );
      callbacks.withLocalCommit(() => {
        this.submit(writer, request, this.sessionId, callbacks);
      });
    } catch (error) {
      callbacks.onRejected(error);
    }
  }

  private nextActionId(): string {
    const random = globalThis.crypto?.randomUUID?.();
    return random ? `browser:${random}` : `browser:${Date.now()}:${fallbackActionOrdinal++}`;
  }

  private submit(
    writer: CanonicalWriter,
    request: ActionRequest,
    sessionId: string,
    callbacks: SessionActionCallbacks,
    selection?: import('../../markdown/semantic/selection.js').SelectionIntent,
  ): void {
    const transport = this.transport;
    let tracked = false;
    let authorityPending = false;
    try {
      if (transport) {
        writer.trackPreparedAction(request);
        tracked = true;
      }
      const context: AdmittedContext = {
        sessionId,
        authorityEpoch: request.authorityEpoch,
        sessionSequence: request.sessionSequence,
      };
      const result = transport
        ? transport.apply(writer, request, context)
        : writer.apply(request, context);
      if (result.status === 'pending') {
        authorityPending = !!transport;
        const accepted = transport
          ? transport.publish(writer, request, result.pending)
          : writer.publish(result.pending);
        tracked = false;
        callbacks.onAccepted(accepted, selection);
      } else if (result.status === 'duplicate') {
        tracked = false;
        callbacks.onAccepted(result.accepted, selection);
      } else if (result.status === 'rejected') {
        if (tracked) writer.releasePreparedAction(request);
        tracked = false;
        callbacks.onRejected(result.reason);
      } else if (result.status === 'queued') {
        if (tracked) writer.releasePreparedAction(request);
        tracked = false;
        callbacks.onRejected(
          new Error('Connected actions cannot be queued while a pane is bound.'),
        );
      }
    } catch (error) {
      if (!authorityPending && (tracked || transport)) writer.releasePreparedAction(request);
      callbacks.onRejected(error);
    }
  }

  private options(historyGroupId?: string): ActionOptions {
    const actionId = this.nextActionId();
    return {
      actionId,
      sessionId: this.sessionId,
      historyGroupId: historyGroupId ?? actionId,
    };
  }

  private inputHistoryGroup(nodeId: NodeId, isolated: boolean): string {
    if (isolated) {
      this.sealTypingGroup();
      return this.nextActionId();
    }
    const now = performance.now();
    if (
      !this.textGroup ||
      this.textGroup.nodeId !== nodeId ||
      now - this.textGroup.lastInputAt > 1000
    ) {
      this.sealTypingGroup();
      this.textGroup = { id: this.nextActionId(), nodeId, lastInputAt: now };
    } else {
      this.textGroup.lastInputAt = now;
    }
    return this.textGroup.id;
  }
}
