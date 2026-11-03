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
  replaceBlocks(
    selection: readonly CanonicalNode[],
    text: string,
    hostContext?: MarkdownInline['hostContext'],
  ): void;
  runTextInput(
    node: CanonicalNode,
    from: number,
    to: number,
    insert: string,
    isolated: boolean,
    hostContext?: MarkdownInline['hostContext'],
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
    if (session.blockSelection?.length) {
      const document = this.environment.document()!;
      const selected = session.blockSelection
        .map((id) => document.node(id))
        .filter((node) => node.connected);
      if (!selected.length || selected.length !== session.blockSelection.length) {
        this.recoverAndReplay(session, inline, session.selection);
        return;
      }
      if (!data) {
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
          this.environment.replaceBlocks(selected, data, recovery.source.hostContext);
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
    const replacement = data
      ? findCompositionEnvelope(session.content, nativeText, data, session.selection)
      : undefined;
    if (
      !replacement ||
      !session.node.connected ||
      session.node.version !== session.version ||
      session.node.content !== session.content
    ) {
      this.recoverAndReplay(session, inline, session.selection);
      return;
    }
    const { from, to } = replacement;
    const insert = replacement.insert;
    if (session.content.slice(0, from) + insert + session.content.slice(to) === session.content) {
      const caret = from + insert.length;
      const recovery = this.beginRecovery(session, inline);
      void this.recoverProjection(recovery, { anchor: caret, focus: caret })
        .then(async (current) => {
          if (!current) {
            this.finishRecovery(recovery, false);
            return;
          }
          const replayed = await this.replayQueuedInputs(
            session.node.sharedId,
            recovery,
            recovery.source.hostContext,
          );
          this.finishRecovery(recovery, !replayed);
        })
        .catch(() => this.finishRecovery(recovery, false));
      return;
    }
    const recovery = this.beginRecovery(session, inline);
    void this.recoverProjection(recovery, session.selection)
      .then(async (current) => {
        if (!current) {
          this.finishRecovery(recovery, false);
          return;
        }
        this.environment.runTextInput(
          session.node,
          from,
          to,
          insert,
          true,
          recovery.source.hostContext,
        );
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
    const isCurrent = () =>
      this.isRecoveryCurrent(recovery) &&
      this.environment.session.isCurrent(recovery.session.generation, document, writer, sessionId);
    if (pending.length && replayTarget) {
      if (focusAtEnd) {
        await replayTarget.updateComplete;
        if (!replayTarget.isConnected || !isCurrent()) return false;
        replayTarget.focus();
        if (!isCurrent()) return false;
        const offset = replayTarget.nodeView?.content?.length ?? 0;
        replayTarget.setSelectionOffsets(offset, offset);
      }
      if (!replayTarget.isConnected || !isCurrent()) return false;
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

// Find an envelope containing the original selection whose native text includes the full payload.
function findCompositionEnvelope(
  content: string,
  nativeText: string,
  data: string,
  selection: { readonly anchor: number; readonly focus: number },
): { readonly from: number; readonly to: number; readonly insert: string } | undefined {
  const selectionFrom = Math.min(selection.anchor, selection.focus);
  const selectionTo = Math.max(selection.anchor, selection.focus);
  let commonPrefix = 0;
  while (
    commonPrefix < content.length &&
    commonPrefix < nativeText.length &&
    content[commonPrefix] === nativeText[commonPrefix]
  ) {
    commonPrefix++;
  }
  let commonSuffix = 0;
  while (
    commonSuffix < content.length &&
    commonSuffix < nativeText.length &&
    content[content.length - 1 - commonSuffix] === nativeText[nativeText.length - 1 - commonSuffix]
  ) {
    commonSuffix++;
  }

  let replacement:
    | { from: number; to: number; insert: string; score: number; leftExpansion: number }
    | undefined;
  for (
    let dataFrom = nativeText.indexOf(data);
    dataFrom >= 0;
    dataFrom = nativeText.indexOf(data, dataFrom + 1)
  ) {
    const outputTo = dataFrom + data.length;
    for (
      let from = dataFrom;
      from >= 0 && /^\s*$/u.test(nativeText.slice(from, dataFrom));
      from--
    ) {
      const insert = nativeText.slice(from, outputTo);
      const leadingText = insert.slice(0, insert.length - data.length);
      if (leadingText && !/^\s*$/u.test(leadingText)) break;
      const suffixLength = nativeText.length - outputTo;
      const to = content.length - suffixLength;
      if (
        from > selectionFrom ||
        to < selectionTo ||
        from > to ||
        from > commonPrefix ||
        suffixLength > commonSuffix ||
        !isUtf16Boundary(content, from) ||
        !isUtf16Boundary(content, to) ||
        !isUtf16Boundary(nativeText, from) ||
        !isUtf16Boundary(nativeText, outputTo) ||
        content.slice(0, from) + insert + content.slice(to) !== nativeText
      ) {
        continue;
      }
      const leftExpansion = selectionFrom - from;
      const rightExpansion = to - selectionTo;
      const score = Math.max(leftExpansion, rightExpansion);
      if (
        !replacement ||
        score < replacement.score ||
        (score === replacement.score && leftExpansion < replacement.leftExpansion)
      ) {
        replacement = { from, to, insert, score, leftExpansion };
      }
    }
  }
  return replacement;
}
