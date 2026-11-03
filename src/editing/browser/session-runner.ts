import { CanonicalWriter } from '../../markdown/canonical/writer.js';
import type {
  AcceptedAction,
  ActionOptions,
  HistoryResult,
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

/** Owns one editor binding's session attribution and action/history grouping. */
export class BrowserSessionRunner {
  private document?: CanonicalDocument;
  private writer?: CanonicalWriter;
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
  ): void {
    if (this.document === document && this.writer === writer && this.sessionId === sessionId) {
      return;
    }
    this.sealTypingGroup();
    this.generation_++;
    this.document = document;
    this.writer = writer;
    this.sessionId = sessionId;
    writer?.admitSession(sessionId);
  }

  disconnect(): void {
    this.sealTypingGroup();
    this.generation_++;
    this.document = undefined;
    this.writer = undefined;
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
    this.writer?.sealTextGroup(this.sessionId);
  }

  undo(): HistoryResult | undefined {
    this.sealTypingGroup();
    return this.writer?.undo(this.sessionId);
  }

  redo(): HistoryResult | undefined {
    this.sealTypingGroup();
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
        const result = writer.apply(prepared.request, {
          sessionId,
          authorityEpoch: prepared.request.authorityEpoch,
          sessionSequence: prepared.request.sessionSequence,
        });
        if (result.status === 'pending')
          callbacks.onAccepted(writer.publish(result.pending), prepared.selection);
        else if (result.status === 'duplicate')
          callbacks.onAccepted(result.accepted, prepared.selection);
        else if (result.status === 'rejected') callbacks.onRejected(result.reason);
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
        const result = writer.apply(request, {
          sessionId: this.sessionId,
          authorityEpoch: request.authorityEpoch,
          sessionSequence: request.sessionSequence,
        });
        if (result.status === 'pending') callbacks.onAccepted(writer.publish(result.pending));
        else if (result.status === 'duplicate') callbacks.onAccepted(result.accepted);
        else if (result.status === 'rejected') callbacks.onRejected(result.reason);
      });
    } catch (error) {
      callbacks.onRejected(error);
    }
  }

  private nextActionId(): string {
    const random = globalThis.crypto?.randomUUID?.();
    return random ? `browser:${random}` : `browser:${Date.now()}:${fallbackActionOrdinal++}`;
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
