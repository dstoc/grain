import type { CanonicalDocument } from '../../markdown/canonical/document.js';
import type { CanonicalNode } from '../../markdown/canonical/node-projection.js';
import type { CanonicalWriter } from '../../markdown/canonical/writer.js';
import type { NodeId } from '../../markdown/semantic/types.js';
import {
  createCanonicalTextAnchor,
  resolveCanonicalTextAnchor,
} from '../../markdown/canonical-selection.js';
import type { CanonicalTextAnchor } from '../../markdown/canonical-selection.js';
import { CanonicalNode as CanonicalNodeProjection } from '../../markdown/canonical/node-projection.js';
import type { Bookmark } from '../../markdown/canonical/action-types.js';
import type { MarkdownInline } from '../../markdown/inline-render.js';
import type { MarkdownRenderer } from '../../markdown/block-render.js';
import type { SelectionController } from './selection-controller.js';
import type { BrowserSessionRunner } from './session-runner.js';

interface CompositionDraft {
  readonly inline: MarkdownInline;
  readonly node: CanonicalNode;
  readonly content: string;
  readonly version: number;
  readonly selection: { readonly anchor: number; readonly focus: number };
  readonly selectionAnchor: CanonicalTextAnchor;
  readonly selectionFocus: CanonicalTextAnchor;
  readonly blockSelection?: readonly NodeId[];
  readonly generation: number;
  invalidate: () => void;
}

interface PendingRecovery {
  readonly session: CompositionDraft;
  readonly source: MarkdownInline;
  readonly inlines: Set<MarkdownInline>;
  cancelled: boolean;
}

interface CompositionEnvironment {
  document(): CanonicalDocument | undefined;
  writer(): CanonicalWriter | undefined;
  sessionId(): string;
  renderer(): MarkdownRenderer | undefined;
  updateComplete(): Promise<unknown>;
  isConnected(): boolean;
  readonly session: BrowserSessionRunner;
  readonly selection: SelectionController;
  blockSelection(inline: MarkdownInline): readonly CanonicalNode[];
  replaceBlocks(selection: readonly CanonicalNode[], text: string): void;
  runTextInput(
    node: CanonicalNode,
    from: number,
    to: number,
    insert: string,
    isolated: boolean,
  ): void;
}

/** Owns native composition invalidation, recovery, and its one queued-input handoff. */
export class CompositionController {
  private composition?: CompositionDraft;
  private readonly pendingRecoveries = new Set<PendingRecovery>();

  constructor(private readonly environment: CompositionEnvironment) {}

  start(inline: MarkdownInline): void {
    const node = inline.nodeView;
    const selection = inline.getTextSelection();
    const document = this.environment.document();
    if (
      !(node instanceof CanonicalNodeProjection) ||
      !selection ||
      !document ||
      inline.textContent !== node.content
    ) {
      return;
    }
    const blockSelection = this.environment.blockSelection(inline).map((item) => item.sharedId);
    const selectionAnchor = createCanonicalTextAnchor(document, {
      nodeId: node.sharedId,
      offset: selection.anchor,
      affinity: selection.anchor <= selection.focus ? 'left' : 'right',
    });
    const selectionFocus = createCanonicalTextAnchor(document, {
      nodeId: node.sharedId,
      offset: selection.focus,
      affinity: selection.focus >= selection.anchor ? 'right' : 'left',
    });
    const session: CompositionDraft = {
      inline,
      node,
      content: node.content ?? '',
      version: node.version,
      selection,
      selectionAnchor,
      selectionFocus,
      generation: this.environment.session.generation,
      ...(blockSelection.length ? { blockSelection } : {}),
      invalidate: () => this.invalidate(session),
    };
    this.composition = session;
    inline.addEventListener('composition-invalidated', session.invalidate);
    this.environment.session.sealTypingGroup();
  }

  end(inline: MarkdownInline, event: CompositionEvent): void {
    const session = this.composition;
    this.composition = undefined;
    const data = event.data;
    if (session) {
      session.inline.removeEventListener('composition-invalidated', session.invalidate);
      session.inline.composing = false;
    }
    if (!session || session.inline !== inline || !this.isCurrent(session)) {
      if (!inline.isConnected) return;
      if (session) {
        this.recoverAndReplay(
          session,
          inline,
          inline.getTextSelection() ?? { anchor: 0, focus: 0 },
        );
      } else {
        void inline
          .recoverComposition(inline.getTextSelection() ?? { anchor: 0, focus: 0 }, false)
          .then((recovered) => {
            inline.discardRecoveryEvents();
            recovered?.discardRecoveryEvents();
          });
      }
      return;
    }
    const nativeText = inline.textContent ?? '';
    let from: number;
    let to: number;
    let insert: string;
    if (session.blockSelection?.length) {
      const document = this.environment.document()!;
      const selected = session.blockSelection
        .map((id) => document.node(id))
        .filter((node) => node.connected);
      if (!selected.length || selected.length !== session.blockSelection.length) {
        this.recoverAndReplay(session, inline, session.selection);
        return;
      }
      const recovery = this.beginRecovery(session, inline);
      void this.recoverProjection(recovery, session.selection)
        .then(async (current) => {
          if (!current) {
            this.finishRecovery(recovery, false);
            return;
          }
          this.environment.replaceBlocks(selected, data ?? '');
          recovery.source.hostContext?.clearSelection();
          const replayed = await this.replayQueuedInputs(
            session.blockSelection?.[0] ?? session.node.sharedId,
            recovery,
            recovery.source.hostContext,
            true,
          );
          this.finishRecovery(recovery, !replayed);
        })
        .catch(() => this.finishRecovery(recovery, false));
      return;
    }
    if (nativeText === session.content && data) {
      from = Math.min(session.selection.anchor, session.selection.focus);
      to = Math.max(session.selection.anchor, session.selection.focus);
      insert = data;
    } else {
      let prefix = 0;
      while (
        prefix < session.content.length &&
        prefix < nativeText.length &&
        session.content[prefix] === nativeText[prefix]
      ) {
        prefix++;
      }
      let suffix = 0;
      while (
        suffix < session.content.length - prefix &&
        suffix < nativeText.length - prefix &&
        session.content[session.content.length - 1 - suffix] ===
          nativeText[nativeText.length - 1 - suffix]
      ) {
        suffix++;
      }
      while (
        prefix > 0 &&
        (!isUtf16Boundary(session.content, prefix) || !isUtf16Boundary(nativeText, prefix))
      ) {
        prefix--;
      }
      while (
        suffix > 0 &&
        (!isUtf16Boundary(session.content, session.content.length - suffix) ||
          !isUtf16Boundary(nativeText, nativeText.length - suffix))
      ) {
        suffix--;
      }
      from = prefix;
      to = session.content.length - suffix;
      insert = nativeText.slice(prefix, nativeText.length - suffix);
    }
    if (
      !data ||
      !session.node.connected ||
      session.node.version !== session.version ||
      session.node.content !== session.content ||
      session.content.slice(0, from) + insert + session.content.slice(to) !== nativeText
    ) {
      this.recoverAndReplay(session, inline, session.selection);
      return;
    }
    const recovery = this.beginRecovery(session, inline);
    void this.recoverProjection(recovery, session.selection)
      .then(async (current) => {
        if (!current) {
          this.finishRecovery(recovery, false);
          return;
        }
        this.environment.runTextInput(session.node, from, to, insert, true);
        const replayed = await this.replayQueuedInputs(session.node.sharedId, recovery);
        this.finishRecovery(recovery, !replayed);
      })
      .catch(() => this.finishRecovery(recovery, false));
  }

  cancel(restore: boolean): void {
    for (const recovery of this.pendingRecoveries) this.discardRecovery(recovery);
    const session = this.composition;
    if (!session) return;
    this.composition = undefined;
    session.inline.removeEventListener('composition-invalidated', session.invalidate);
    session.inline.composing = false;
    if (restore && session.inline.isConnected) {
      this.recoverAndReplay(session, session.inline, session.selection);
    }
  }

  private invalidate(session: CompositionDraft): void {
    if (this.composition !== session) return;
    this.composition = undefined;
    session.inline.removeEventListener('composition-invalidated', session.invalidate);
    session.inline.composing = false;
    if (session.inline.isConnected) {
      const recovery = this.beginRecovery(session, session.inline);
      void this.recoverInvalidatedComposition(recovery).catch(() =>
        this.finishRecovery(recovery, false),
      );
    }
  }

  private async recoverInvalidatedComposition(recovery: PendingRecovery): Promise<void> {
    const session = recovery.session;
    const document = this.environment.document();
    if (!document || !this.isRecoveryCurrent(recovery)) {
      this.finishRecovery(recovery, false);
      return;
    }
    let anchor: Bookmark;
    let focus: Bookmark;
    try {
      anchor = resolveCanonicalTextAnchor(document, session.selectionAnchor);
      focus = resolveCanonicalTextAnchor(document, session.selectionFocus);
    } catch {
      const current = await this.recoverProjection(recovery, session.selection);
      this.finishRecovery(recovery, current);
      return;
    }
    const sameInline =
      anchor.nodeId === session.node.sharedId && focus.nodeId === session.node.sharedId;
    const selection = sameInline
      ? { anchor: anchor.offset, focus: focus.offset }
      : session.selection;
    const current = await this.recoverProjection(recovery, selection);
    if (!current) {
      this.finishRecovery(recovery, false);
      return;
    }
    if (sameInline) {
      this.finishRecovery(recovery, true);
      return;
    }
    await this.environment.selection.restoreAnchors(
      session.selectionAnchor,
      session.selectionFocus,
    );
    if (!this.isRecoveryCurrent(recovery)) {
      this.finishRecovery(recovery, false);
      return;
    }
    const replayed = await this.replayQueuedInputs(session.node.sharedId, recovery);
    this.finishRecovery(recovery, !replayed);
  }

  private async replayQueuedInputs(
    nodeId: NodeId,
    recovery: PendingRecovery,
    hostContext?: MarkdownInline['hostContext'],
    focusAtEnd = false,
  ): Promise<boolean> {
    const renderer = this.environment.renderer();
    const document = this.environment.document();
    const writer = this.environment.writer();
    const sessionId = this.environment.sessionId();
    if (
      !renderer ||
      !document ||
      !this.isRecoveryCurrent(recovery) ||
      !this.environment.session.isCurrent(recovery.session.generation, document, writer, sessionId)
    ) {
      return false;
    }
    await this.environment.updateComplete();
    await renderer.updateComplete;
    if (
      !this.isRecoveryCurrent(recovery) ||
      !this.environment.session.isCurrent(recovery.session.generation, document, writer, sessionId)
    ) {
      return false;
    }
    const recovered = this.findInline(nodeId, hostContext);
    const target = (hostContext && recovered) || renderer.getInlineSelection().inline || recovered;
    const participants = new Set(recovery.inlines);
    if (recovered) participants.add(recovered);
    if (target) participants.add(target);
    for (const participant of participants) this.trackRecoveryInline(recovery, participant);
    if (!this.isRecoveryCurrent(recovery)) return false;
    const pending = [...participants].flatMap((participant) => participant.takeRecoveryEvents());
    const replayTarget = target?.isConnected
      ? target
      : recovered?.isConnected
        ? recovered
        : undefined;
    if (pending.length && replayTarget) {
      if (focusAtEnd) {
        await replayTarget.updateComplete;
        replayTarget.focus();
        const offset = replayTarget.nodeView?.content?.length ?? 0;
        replayTarget.setSelectionOffsets(offset, offset);
      }
      replayTarget.replayRecoveryEvents(pending);
    }
    return this.isRecoveryCurrent(recovery);
  }

  private recoverAndReplay(
    session: CompositionDraft,
    source: MarkdownInline,
    selection: { readonly anchor: number; readonly focus: number },
  ): void {
    const recovery = this.beginRecovery(session, source);
    void this.recoverProjection(recovery, selection)
      .then((current) => this.finishRecovery(recovery, current))
      .catch(() => this.finishRecovery(recovery, false));
  }

  private beginRecovery(session: CompositionDraft, source: MarkdownInline): PendingRecovery {
    const recovery: PendingRecovery = {
      session,
      source,
      inlines: new Set([source]),
      cancelled: false,
    };
    this.pendingRecoveries.add(recovery);
    return recovery;
  }

  private async recoverProjection(
    recovery: PendingRecovery,
    selection: { readonly anchor: number; readonly focus: number },
  ): Promise<boolean> {
    const recoveredInline = await recovery.source.recoverComposition(selection, false);
    if (recoveredInline) this.trackRecoveryInline(recovery, recoveredInline);
    return this.isRecoveryCurrent(recovery);
  }

  private trackRecoveryInline(recovery: PendingRecovery, inline: MarkdownInline): void {
    recovery.inlines.add(inline);
    if (recovery.cancelled) inline.discardRecoveryEvents();
  }

  private isRecoveryCurrent(recovery: PendingRecovery): boolean {
    if (!recovery.cancelled && this.isCurrent(recovery.session)) return true;
    this.discardRecovery(recovery);
    return false;
  }

  private discardRecovery(recovery: PendingRecovery): void {
    recovery.cancelled = true;
    for (const inline of recovery.inlines) inline.discardRecoveryEvents();
  }

  private finishRecovery(recovery: PendingRecovery, replayEvents: boolean): void {
    if (replayEvents && this.isRecoveryCurrent(recovery)) {
      for (const inline of recovery.inlines) {
        if (!this.isRecoveryCurrent(recovery)) break;
        inline.replayRecoveryEvents();
      }
    } else {
      this.discardRecovery(recovery);
    }
    this.pendingRecoveries.delete(recovery);
  }

  private findInline(
    nodeId: NodeId,
    hostContext?: MarkdownInline['hostContext'],
  ): MarkdownInline | undefined {
    const renderer = this.environment.renderer();
    const root = renderer?.shadowRoot;
    if (!hostContext) {
      return [...(root?.querySelectorAll<MarkdownInline>('md-inline') ?? [])].find(
        (candidate) =>
          candidate.nodeView instanceof CanonicalNodeProjection &&
          candidate.nodeView.sharedId === nodeId,
      );
    }
    if (!root) return;
    const pending: Node[] = [...root.childNodes].reverse();
    while (pending.length) {
      const current = pending.pop()!;
      if (current instanceof HTMLElement && current.localName === 'md-inline') {
        const candidate = current as MarkdownInline;
        if (
          candidate.hostContext === hostContext &&
          candidate.nodeView instanceof CanonicalNodeProjection &&
          candidate.nodeView.sharedId === nodeId
        ) {
          return candidate;
        }
      }
      if (current instanceof Element && current.shadowRoot) {
        pending.push(...[...current.shadowRoot.childNodes].reverse());
      }
      pending.push(...[...current.childNodes].reverse());
    }
  }

  private isCurrent(session: CompositionDraft): boolean {
    const document = this.environment.document();
    return (
      this.environment.isConnected() &&
      this.environment.session.isCurrent(
        session.generation,
        document,
        this.environment.writer(),
        this.environment.sessionId(),
      )
    );
  }
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}
