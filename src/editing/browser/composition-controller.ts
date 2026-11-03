import type { CanonicalDocument, CanonicalNode } from '../../markdown/canonical-model.js';
import type { CanonicalWriter } from '../../markdown/canonical-actions.js';
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

interface CompositionEnvironment {
  document(): CanonicalDocument | undefined;
  writer(): CanonicalWriter | undefined;
  sessionId(): string;
  renderer(): MarkdownRenderer | undefined;
  updateComplete(): Promise<unknown>;
  isConnected(): boolean;
  readonly session: BrowserSessionRunner;
  readonly selection: SelectionController;
  blockSelection(): readonly CanonicalNode[];
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
    const blockSelection = this.environment.blockSelection().map((item) => item.sharedId);
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
      if (inline.isConnected)
        void inline.recoverComposition(inline.getTextSelection() ?? { anchor: 0, focus: 0 });
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
        void inline.recoverComposition(session.selection);
        return;
      }
      void inline.recoverComposition(session.selection, false).then(() => {
        if (!this.isCurrent(session)) return;
        this.environment.replaceBlocks(selected, data ?? '');
        void this.replayQueuedInputs(session.node.sharedId, session.generation);
      });
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
      void inline.recoverComposition(session.selection);
      return;
    }
    void inline.recoverComposition(session.selection, false).then(() => {
      if (!this.isCurrent(session)) return;
      this.environment.runTextInput(session.node, from, to, insert, true);
      this.findInline(session.node.sharedId)?.replayRecoveryEvents();
    });
  }

  cancel(restore: boolean): void {
    const session = this.composition;
    if (!session) return;
    this.composition = undefined;
    session.inline.removeEventListener('composition-invalidated', session.invalidate);
    session.inline.composing = false;
    if (restore && session.inline.isConnected) {
      void session.inline.recoverComposition(session.selection);
    }
  }

  private invalidate(session: CompositionDraft): void {
    if (this.composition !== session) return;
    this.composition = undefined;
    session.inline.removeEventListener('composition-invalidated', session.invalidate);
    session.inline.composing = false;
    if (session.inline.isConnected) void this.recoverInvalidatedComposition(session);
  }

  private async recoverInvalidatedComposition(session: CompositionDraft): Promise<void> {
    const document = this.environment.document();
    if (!document) return;
    if (!this.isCurrent(session)) {
      await session.inline.recoverComposition(session.selection);
      return;
    }
    let anchor: Bookmark;
    let focus: Bookmark;
    try {
      anchor = resolveCanonicalTextAnchor(document, session.selectionAnchor);
      focus = resolveCanonicalTextAnchor(document, session.selectionFocus);
    } catch {
      await session.inline.recoverComposition(session.selection);
      return;
    }
    const sameInline =
      anchor.nodeId === session.node.sharedId && focus.nodeId === session.node.sharedId;
    const selection = sameInline
      ? { anchor: anchor.offset, focus: focus.offset }
      : session.selection;
    await session.inline.recoverComposition(selection, sameInline);
    if (!this.isCurrent(session) || sameInline) return;
    await this.environment.selection.restoreAnchors(
      session.selectionAnchor,
      session.selectionFocus,
    );
    await this.replayQueuedInputs(session.node.sharedId, session.generation);
  }

  private async replayQueuedInputs(nodeId: NodeId, generation: number): Promise<void> {
    const renderer = this.environment.renderer();
    const document = this.environment.document();
    const writer = this.environment.writer();
    const sessionId = this.environment.sessionId();
    if (
      !renderer ||
      !document ||
      !this.environment.session.isCurrent(generation, document, writer, sessionId)
    ) {
      return;
    }
    await this.environment.updateComplete();
    await renderer.updateComplete;
    if (!this.environment.session.isCurrent(generation, document, writer, sessionId)) return;
    const recovered = this.findInline(nodeId);
    const target = renderer.getInlineSelection().inline;
    if (recovered && target && recovered !== target) {
      target.holdRecoveryEventsFrom(recovered.takeRecoveryEvents());
    }
    target?.replayRecoveryEvents();
    recovered?.replayRecoveryEvents();
  }

  private findInline(nodeId: NodeId): MarkdownInline | undefined {
    const renderer = this.environment.renderer();
    return [...(renderer?.shadowRoot?.querySelectorAll<MarkdownInline>('md-inline') ?? [])].find(
      (candidate) =>
        candidate.nodeView instanceof CanonicalNodeProjection &&
        candidate.nodeView.sharedId === nodeId,
    );
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
