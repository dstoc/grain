import type { FocusRestoreGuard, MarkdownInline } from '../../markdown/inline-render.js';
import type { MarkdownRenderer } from '../../markdown/block-render.js';

interface CompositionNode {
  readonly connected: boolean;
  readonly content?: string;
  readonly version: number;
}
type ResolvedAnchor = { readonly nodeId: string; readonly offset: number };

interface CompositionDraft<Node extends CompositionNode, Anchor> {
  readonly inline: MarkdownInline;
  readonly node: Node;
  readonly content: string;
  readonly version: unknown;
  readonly selection: { readonly anchor: number; readonly focus: number };
  readonly selectionAnchor: Anchor;
  readonly selectionFocus: Anchor;
  readonly blockSelection?: readonly string[];
  readonly generation: number;
  readonly shouldRestoreFocus?: FocusRestoreGuard;
  invalidate: () => void;
}

interface PendingRecovery<Node extends CompositionNode, Anchor> {
  readonly session: CompositionDraft<Node, Anchor>;
  readonly source: MarkdownInline;
  readonly inlines: Set<MarkdownInline>;
  cancelled: boolean;
}

interface CompositionEnvironment<Node extends CompositionNode, Anchor> {
  node(inline: MarkdownInline): Node | undefined;
  id(node: Node): string;
  revision(node: Node): unknown;
  lookup(id: string): Node | undefined;
  capture(node: Node, offset: number, affinity: 'left' | 'right', inline: MarkdownInline): Anchor;
  resolve(anchor: Anchor): ResolvedAnchor;
  generation(): number;
  isCurrent(generation: number): boolean;
  restore(
    anchor: Anchor,
    focus: Anchor,
    context: MarkdownInline['hostContext'],
    guard?: FocusRestoreGuard,
  ): Promise<unknown>;
  renderer(): MarkdownRenderer | undefined;
  updateComplete(): Promise<unknown>;
  isConnected(): boolean;
  focusRestoreGuard(inline: MarkdownInline): FocusRestoreGuard | undefined;
  blockSelection(inline: MarkdownInline): readonly Node[];
  replaceBlocks(
    selection: readonly Node[],
    text: string,
    hostContext?: MarkdownInline['hostContext'],
  ): void;
  runTextInput(
    node: Node,
    from: number,
    to: number,
    insert: string,
    isolated: boolean,
    hostContext?: MarkdownInline['hostContext'],
  ): void;
}

/** Owns native composition invalidation, recovery, and its one queued-input handoff. */
export class CompositionController<Node extends CompositionNode, Anchor> {
  private composition?: CompositionDraft<Node, Anchor>;
  private readonly pendingRecoveries = new Set<PendingRecovery<Node, Anchor>>();

  constructor(private readonly environment: CompositionEnvironment<Node, Anchor>) {}

  start(inline: MarkdownInline): void {
    const node = this.environment.node(inline);
    const selection = inline.getTextSelection();
    if (!node || !selection || inline.textContent !== node.content) {
      return;
    }
    const blockSelection = this.environment
      .blockSelection(inline)
      .map((item) => this.environment.id(item));
    const selectionAnchor = this.environment.capture(
      node,
      selection.anchor,
      selection.anchor <= selection.focus ? 'left' : 'right',
      inline,
    );
    const selectionFocus = this.environment.capture(
      node,
      selection.focus,
      selection.focus >= selection.anchor ? 'right' : 'left',
      inline,
    );
    const shouldRestoreFocus = this.environment.focusRestoreGuard(inline);
    const session: CompositionDraft<Node, Anchor> = {
      inline,
      node,
      content: node.content ?? '',
      version: this.environment.revision(node),
      selection,
      selectionAnchor,
      selectionFocus,
      generation: this.environment.generation(),
      ...(shouldRestoreFocus ? { shouldRestoreFocus } : {}),
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
          .recoverComposition(
            inline.getTextSelection() ?? { anchor: 0, focus: 0 },
            false,
            this.environment.focusRestoreGuard(inline),
          )
          .then((recovered) => {
            inline.discardRecoveryEvents();
            recovered?.discardRecoveryEvents();
          });
      }
      return;
    }
    const nativeText = inline.textContent ?? '';
    if (session.blockSelection?.length) {
      const selected = session.blockSelection
        .map((id) => this.environment.lookup(id))
        .filter((node): node is Node => !!node?.connected);
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
            session.blockSelection?.[0] ?? this.environment.id(session.node),
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
      this.environment.revision(session.node) !== session.version ||
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
            this.environment.id(session.node),
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
        if (
          !session.node.connected ||
          this.environment.revision(session.node) !== session.version
        ) {
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
        const replayed = await this.replayQueuedInputs(this.environment.id(session.node), recovery);
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

  private invalidate(session: CompositionDraft<Node, Anchor>): void {
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

  private async recoverInvalidatedComposition(
    recovery: PendingRecovery<Node, Anchor>,
  ): Promise<void> {
    const session = recovery.session;
    if (!this.isRecoveryCurrent(recovery)) {
      this.finishRecovery(recovery, false);
      return;
    }
    let anchor: ResolvedAnchor;
    let focus: ResolvedAnchor;
    try {
      anchor = this.environment.resolve(session.selectionAnchor);
      focus = this.environment.resolve(session.selectionFocus);
    } catch {
      const current = await this.recoverProjection(recovery, session.selection);
      this.finishRecovery(recovery, current);
      return;
    }
    const sameInline =
      anchor.nodeId === this.environment.id(session.node) &&
      focus.nodeId === this.environment.id(session.node);
    const selection = sameInline
      ? { anchor: anchor.offset, focus: focus.offset }
      : session.selection;
    const current = await this.recoverProjection(recovery, selection);
    if (!current || !this.mayRestoreFocus(session)) {
      this.finishRecovery(recovery, false);
      return;
    }
    if (sameInline) {
      this.finishRecovery(recovery, true);
      return;
    }
    await this.environment.restore(
      session.selectionAnchor,
      session.selectionFocus,
      recovery.source.hostContext,
      session.shouldRestoreFocus,
    );
    if (!this.isRecoveryCurrent(recovery) || !this.mayRestoreFocus(session)) {
      this.finishRecovery(recovery, false);
      return;
    }
    const replayed = await this.replayQueuedInputs(this.environment.id(session.node), recovery);
    this.finishRecovery(recovery, !replayed);
  }

  private async replayQueuedInputs(
    nodeId: string,
    recovery: PendingRecovery<Node, Anchor>,
    hostContext?: MarkdownInline['hostContext'],
    focusAtEnd = false,
  ): Promise<boolean> {
    const renderer = this.environment.renderer();
    if (
      !renderer ||
      !this.isRecoveryCurrent(recovery) ||
      !this.environment.isCurrent(recovery.session.generation)
    ) {
      return false;
    }
    if (!this.mayRestoreFocus(recovery.session)) {
      this.discardRecovery(recovery);
      return true;
    }
    await this.environment.updateComplete();
    await renderer.updateComplete;
    if (
      !this.isRecoveryCurrent(recovery) ||
      !this.environment.isCurrent(recovery.session.generation)
    ) {
      return false;
    }
    if (!this.mayRestoreFocus(recovery.session)) {
      this.discardRecovery(recovery);
      return true;
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
      this.isRecoveryCurrent(recovery) && this.environment.isCurrent(recovery.session.generation);
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
    session: CompositionDraft<Node, Anchor>,
    source: MarkdownInline,
    selection: { readonly anchor: number; readonly focus: number },
  ): void {
    const recovery = this.beginRecovery(session, source);
    void this.recoverProjection(recovery, selection)
      .then((current) => this.finishRecovery(recovery, current))
      .catch(() => this.finishRecovery(recovery, false));
  }

  private beginRecovery(
    session: CompositionDraft<Node, Anchor>,
    source: MarkdownInline,
  ): PendingRecovery<Node, Anchor> {
    const recovery: PendingRecovery<Node, Anchor> = {
      session,
      source,
      inlines: new Set([source]),
      cancelled: false,
    };
    this.pendingRecoveries.add(recovery);
    return recovery;
  }

  private async recoverProjection(
    recovery: PendingRecovery<Node, Anchor>,
    selection: { readonly anchor: number; readonly focus: number },
  ): Promise<boolean> {
    if (!recovery.source.isConnected || !recovery.source.nodeView?.connected) {
      // The native branch has gone with its block. Restore its stable selection
      // in the live tree rather than remounting and focusing a detached block.
      await this.environment.updateComplete();
      return this.isRecoveryCurrent(recovery);
    }
    const recoveredInline = await recovery.source.recoverComposition(
      selection,
      false,
      recovery.session.shouldRestoreFocus,
    );
    if (recoveredInline) this.trackRecoveryInline(recovery, recoveredInline);
    return this.isRecoveryCurrent(recovery);
  }

  private trackRecoveryInline(
    recovery: PendingRecovery<Node, Anchor>,
    inline: MarkdownInline,
  ): void {
    recovery.inlines.add(inline);
    if (recovery.cancelled) inline.discardRecoveryEvents();
  }

  private isRecoveryCurrent(recovery: PendingRecovery<Node, Anchor>): boolean {
    if (!recovery.cancelled && this.isCurrent(recovery.session)) return true;
    this.discardRecovery(recovery);
    return false;
  }

  private discardRecovery(recovery: PendingRecovery<Node, Anchor>): void {
    recovery.cancelled = true;
    for (const inline of recovery.inlines) inline.discardRecoveryEvents();
  }

  private finishRecovery(recovery: PendingRecovery<Node, Anchor>, replayEvents: boolean): void {
    if (
      replayEvents &&
      this.isRecoveryCurrent(recovery) &&
      this.mayRestoreFocus(recovery.session)
    ) {
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
    nodeId: string,
    hostContext?: MarkdownInline['hostContext'],
  ): MarkdownInline | undefined {
    const renderer = this.environment.renderer();
    const root = renderer?.shadowRoot;
    if (!hostContext) {
      return [...(root?.querySelectorAll<MarkdownInline>('md-inline') ?? [])].find(
        (candidate) =>
          !!this.environment.node(candidate) &&
          this.environment.id(this.environment.node(candidate)!) === nodeId,
      );
    }
    if (!root) return;
    const pending: globalThis.Node[] = [...root.childNodes].reverse();
    while (pending.length) {
      const current = pending.pop()!;
      if (current instanceof HTMLElement && current.localName === 'md-inline') {
        const candidate = current as MarkdownInline;
        if (
          candidate.hostContext === hostContext &&
          !!this.environment.node(candidate) &&
          this.environment.id(this.environment.node(candidate)!) === nodeId
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

  private isCurrent(session: CompositionDraft<Node, Anchor>): boolean {
    return this.environment.isConnected() && this.environment.isCurrent(session.generation);
  }

  private mayRestoreFocus(session: CompositionDraft<Node, Anchor>): boolean {
    return !session.shouldRestoreFocus || session.shouldRestoreFocus();
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
