import { html, LitElement } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

import type { CanonicalWriter } from '../markdown/canonical/writer.js';
import { hasStructuralEffects } from '../markdown/canonical/action-types.js';
import type { AcceptedAction, HistoryResult } from '../markdown/canonical/action-types.js';
import type { AcceptedUpdate } from '../markdown/canonical/document-types.js';
import { CanonicalNode } from '../markdown/canonical/node-projection.js';
import type { CanonicalDocument } from '../markdown/canonical/document.js';
import '../markdown/block-render.js';
import type { NodeId } from '../markdown/semantic/types.js';
import { createCanonicalTextAnchor } from '../markdown/canonical-selection.js';
import {
  readClipboardPayload,
  serializeBlockSelection,
  writeMarkdownClipboard,
} from './browser/clipboard.js';
import { deleteBackwardAtStart } from './commands/delete-backward.js';
import { indent } from './commands/indent.js';
import { outdent } from './commands/outdent.js';
import { insertLineBreak } from './commands/insert-line-break.js';
import { insertMarkdown } from './commands/insert-markdown.js';
import { insertParagraph } from './commands/insert-paragraph.js';
import { replaceBlocks as replaceBlocksCommand } from './commands/replace-blocks.js';
import { deleteBlocks as deleteBlocksCommand } from './commands/delete-blocks.js';
import type { Edit } from './outcomes.js';
import type { EditSelection } from '../markdown/semantic/selection.js';
import { BrowserSessionRunner } from './browser/session-runner.js';
import type { BrowserSessionTransport } from './browser/session-runner.js';
import type { SessionActionCallbacks } from './browser/session-runner.js';
import { translateInlineInput, translateInlineKey } from './browser/input.js';
import { SelectionController } from './browser/selection-controller.js';
import { CompositionController } from './browser/composition-controller.js';
import {
  MarkdownInline,
  type FocusRestoreGuard,
  type InlineInput,
  type InlineKeyDown,
} from '../markdown/inline-render.js';
import type { MarkdownRenderer } from '../markdown/block-render.js';
import type { HostContext } from '../markdown/host-context.js';
import type { MarkdownRenderDelegate } from '../markdown/render-delegate.js';
import type { TaskStateIntent } from '../markdown/render-intents.js';
import { cycleTaskState } from './commands/cycle-task-state.js';
import './mobile-keyboard-toolbar.js';

export type AcceptedUpdateRelay = (
  envelope: AcceptedUpdate | undefined,
  callbackErrors: readonly unknown[],
) => boolean;

/** Browser editing over the canonical Yjs model and its single history coordinator. */
@customElement('md-canonical-editor')
export class CanonicalEditor extends LitElement {
  @property({ attribute: false }) accessor document: CanonicalDocument | undefined;
  @property({ attribute: false }) accessor writer: CanonicalWriter | undefined;
  @property({ attribute: false }) accessor sessionTransport: BrowserSessionTransport | undefined;
  @property({ attribute: false }) accessor renderDelegate: MarkdownRenderDelegate | undefined;
  @property({ type: String, attribute: 'session-id' }) accessor sessionId = 'local';
  @property({ attribute: false }) accessor acceptedUpdateRelay: AcceptedUpdateRelay | undefined;
  @property({ type: Boolean, reflect: true }) accessor disabled = false;

  @query('md-block-render') private accessor renderer!: MarkdownRenderer;

  private unsubscribeProjection?: () => void;
  private readonly sessionRunner = new BrowserSessionRunner();
  private readonly selectionController = new SelectionController(
    {
      document: () => this.document,
      renderer: () => this.renderer,
      isConnected: () => this.isConnected,
      requestUpdate: () => this.requestUpdate(),
      updateComplete: () => this.updateComplete,
    },
    this.sessionRunner,
  );
  private readonly compositionController = new CompositionController({
    document: () => this.document,
    writer: () => this.writer,
    sessionId: () => this.sessionId,
    renderer: () => this.renderer,
    updateComplete: () => this.updateComplete,
    isConnected: () => this.isConnected,
    focusRestoreGuard: (inline) =>
      this.acceptedUpdateRelay ? this.focusRestoreGuard(inline) : undefined,
    session: this.sessionRunner,
    selection: this.selectionController,
    blockSelection: (inline) => {
      const selectedIds = new Set(
        [...(inline.hostContext?.selection ?? [])]
          .filter((node) => node instanceof CanonicalNode)
          .map((node) => node.sharedId),
      );
      return this.selectionController
        .visibleInlineNodes(
          inline.hostContext?.root instanceof CanonicalNode ? inline.hostContext.root : undefined,
        )
        .filter((node) => selectedIds.has(node.sharedId));
    },
    replaceBlocks: (selection, text, hostContext) =>
      this.replaceBlocks(selection, text, hostContext),
    runTextInput: (node, from, to, insert, isolated, hostContext) =>
      this.runTextInput(node, from, to, insert, isolated, hostContext),
  });
  private localCommit = false;
  private focusIntentEpoch = 0;

  override render() {
    const root = this.document?.root;
    if (!root) return html``;
    return html`<md-block-render
      ?inert=${this.disabled}
      .block=${root}
      .renderDelegate=${this.renderDelegate}
      @inline-input=${this.onInlineInput}
      @inline-keydown=${this.onInlineKeyDown}
      @inline-composition-start=${this.onCompositionStart}
      @inline-composition-end=${this.onCompositionEnd}
      @task-state-intent=${this.onTaskStateIntent}
      @copy=${this.onClipboard}
      @cut=${this.onClipboard}
      @paste=${this.onPaste}
      @pointerdown=${this.onPointerDown}
    ></md-block-render>`;
  }

  protected override updated(changed: Map<PropertyKey, unknown>) {
    const bindingChanged =
      changed.has('document') ||
      changed.has('writer') ||
      changed.has('sessionId') ||
      changed.has('sessionTransport');
    if (bindingChanged) {
      this.sessionRunner.bind(this.document, this.writer, this.sessionId, this.sessionTransport);
      this.compositionController.cancel(true);
      if (changed.has('document')) {
        this.selectionController.resetDocument();
      }
    }
    if (changed.has('document')) {
      this.unsubscribeProjection?.();
      this.unsubscribeProjection = this.document?.subscribeProjection(() => {
        if (this.document) {
          this.dispatchEvent(
            new CustomEvent('canonical-change', {
              detail: { document: this.document },
              bubbles: true,
              composed: true,
            }),
          );
        }
        if (!this.localCommit) this.sealTypingGroup();
        if (this.localCommit || !this.selectionController.selectionAnchor) return;
        if (!this.acceptedUpdateRelay) {
          void this.selectionController.restoreSavedSelection();
          return;
        }
        if (!this.focusedInline()) return;
        void this.selectionController.restoreSavedSelection(undefined, this.focusRestoreGuard());
      });
    }
    const context = this.renderer?.hostContext;
    if (context) {
      context.root = this.document?.root;
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.ownerDocument.addEventListener('focusin', this.onFocusIntent, true);
    this.ownerDocument.addEventListener('pointerdown', this.onFocusIntent, true);
    this.ownerDocument.addEventListener('keydown', this.onFocusIntent, true);
    this.sessionRunner.bind(this.document, this.writer, this.sessionId, this.sessionTransport);
    this.selectionController.connect(this.ownerDocument);
  }

  override disconnectedCallback() {
    this.ownerDocument.removeEventListener('focusin', this.onFocusIntent, true);
    this.ownerDocument.removeEventListener('pointerdown', this.onFocusIntent, true);
    this.ownerDocument.removeEventListener('keydown', this.onFocusIntent, true);
    this.unsubscribeProjection?.();
    this.unsubscribeProjection = undefined;
    this.selectionController.disconnect();
    this.compositionController.cancel(false);
    this.sessionRunner.disconnect();
    super.disconnectedCallback();
  }

  private get hostContext(): HostContext | undefined {
    return this.renderer?.hostContext;
  }

  private activeInline(inline: MarkdownInline): CanonicalNode | undefined {
    const node = inline.nodeView;
    return node instanceof CanonicalNode ? node : undefined;
  }

  private onPointerDown = () => {
    this.sealTypingGroup();
  };

  private sealTypingGroup() {
    this.sessionRunner.sealTypingGroup();
  }

  canUndo(): boolean {
    return this.sessionRunner.canUndo();
  }

  canRedo(): boolean {
    return this.sessionRunner.canRedo();
  }

  private onAccepted(
    accepted: AcceptedAction,
    selectionIntent?: import('../markdown/semantic/selection.js').SelectionIntent,
    hostContext?: HostContext,
  ) {
    this.selectionController.captureSelection();
    const shouldRestoreFocus = this.acceptedUpdateRelay ? this.focusRestoreGuard() : undefined;
    if (this.sessionTransport && !this.sessionTransport.isReady()) return;
    if (
      !this.sessionTransport &&
      !this.relayAcceptedUpdate(
        { revision: accepted.revision, update: accepted.update },
        accepted.callbackErrors,
      )
    )
      return;
    if (hasStructuralEffects(accepted.receipt.structuralPatch)) this.sealTypingGroup();
    const selection = accepted.receipt.focus?.selection;
    if (selectionIntent?.type === 'preserve-block-selection' && selection && this.document) {
      try {
        const anchor = createCanonicalTextAnchor(this.document, selection.anchor);
        const focus = createCanonicalTextAnchor(this.document, selection.focus);
        void this.selectionController.restoreAnchors(
          anchor,
          focus,
          true,
          false,
          hostContext,
          false,
          shouldRestoreFocus,
        );
        return;
      } catch {
        // A selection endpoint can be hidden by the structural action.
      }
    }
    if (selectionIntent?.type === 'clear') (hostContext ?? this.hostContext)?.clearSelection();
    const focus = accepted.receipt.focus?.end;
    if (focus) void this.selectionController.focusBookmark(focus, hostContext, shouldRestoreFocus);
    else void this.selectionController.restoreSavedSelection(hostContext, shouldRestoreFocus);
  }

  private relayAcceptedUpdate(
    envelope: AcceptedUpdate | undefined,
    callbackErrors: readonly unknown[] = [],
  ): boolean {
    if (!this.acceptedUpdateRelay) return true;
    const previousLocalCommit = this.localCommit;
    this.localCommit = true;
    try {
      return this.acceptedUpdateRelay(envelope, callbackErrors);
    } catch (error) {
      this.disabled = true;
      this.dispatchEditError(error);
      return false;
    } finally {
      this.localCommit = previousLocalCommit;
    }
  }

  private focusedInline(): MarkdownInline | undefined {
    let active = this.shadowRoot?.activeElement ?? null;
    while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active instanceof MarkdownInline ? active : undefined;
  }

  private focusRestoreGuard(originalInline = this.focusedInline()): FocusRestoreGuard {
    let focusIntentEpoch = this.focusIntentEpoch;
    let focusOwner = originalInline;
    const guard = (() => {
      if (this.focusIntentEpoch !== focusIntentEpoch) return false;
      const currentInline = this.focusedInline();
      if (currentInline) {
        return currentInline === focusOwner || (!!focusOwner && !focusOwner.isConnected);
      }
      let active = this.ownerDocument.activeElement;
      while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      let current: Node | null = active;
      while (current && current !== this) {
        if (current.parentNode) current = current.parentNode;
        else {
          const root = current.getRootNode();
          current = root instanceof ShadowRoot ? root.host : null;
        }
      }
      if (current === this) return true;
      return active === this.ownerDocument.body && !!focusOwner && !focusOwner.isConnected;
    }) as FocusRestoreGuard;
    guard.markRestored = () => {
      focusIntentEpoch = this.focusIntentEpoch;
      focusOwner = this.focusedInline();
    };
    return guard;
  }

  private onFocusIntent = (event: Event) => {
    if (event.type === 'keydown' && (event as KeyboardEvent).isComposing) return;
    this.focusIntentEpoch++;
  };

  private sessionCallbacks(hostContext?: HostContext): SessionActionCallbacks {
    return {
      onAccepted: (accepted, selection) => this.onAccepted(accepted, selection, hostContext),
      onRejected: (error) => this.dispatchEditError(error),
      withLocalCommit: (action) => {
        this.localCommit = true;
        try {
          action();
        } finally {
          this.localCommit = false;
        }
      },
    };
  }

  private onTaskStateIntent = (event: CustomEvent<TaskStateIntent>) => {
    if (this.disabled) return;
    if (event.detail.operation !== 'cycle') return;
    const document = this.document;
    const node = event.detail.node;
    if (
      !document ||
      !(node instanceof CanonicalNode) ||
      !node.connected ||
      document.node(node.sharedId) !== node
    ) {
      return;
    }
    this.runEdit(cycleTaskState, { nodeId: node.sharedId });
  };

  private runEdit<Input>(
    command: Edit<Input>,
    input: Input,
    selectionBefore?: EditSelection,
    hostContext?: HostContext,
  ) {
    if (this.disabled) return;
    this.sessionRunner.runCommand(
      command,
      input,
      selectionBefore,
      this.sessionCallbacks(hostContext),
    );
  }

  private textSelectionBefore(
    nodeId: NodeId,
    inline: MarkdownInline,
    fallbackAnchor: number,
    fallbackFocus: number,
  ): EditSelection {
    return this.selectionController.textSelectionBefore(
      nodeId,
      inline,
      fallbackAnchor,
      fallbackFocus,
    );
  }

  private blockSelectionBefore(
    selection: readonly CanonicalNode[],
    hostContext?: HostContext,
  ): EditSelection | undefined {
    return this.selectionController.blockSelectionBefore(selection, hostContext);
  }

  private runTextInput(
    node: CanonicalNode,
    from: number,
    to: number,
    insert: string,
    isolated = false,
    hostContext?: HostContext,
    selectionBefore?: { readonly anchor: number; readonly focus: number },
  ) {
    if (this.disabled) return;
    this.sessionRunner.runTextInput(
      node.sharedId,
      from,
      to,
      insert,
      isolated,
      this.sessionCallbacks(hostContext),
      (caretOffset) => {
        this.selectionController.expectInputSelection(node.sharedId, caretOffset);
      },
      selectionBefore,
    );
  }

  private dispatchEditError(error: unknown) {
    this.dispatchEvent(
      new CustomEvent('canonical-edit-error', {
        detail: error,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onInlineInput = (event: CustomEvent<InlineInput>) => {
    if (this.disabled) return;
    const { inline } = event.detail;
    const hostContext = inline.hostContext;
    const node = this.activeInline(inline);
    const document = this.document;
    if (!node || !document) return;
    const selection = this.selectionController.currentBlockSelection(hostContext);
    const intent = translateInlineInput(event.detail, selection.length > 0);
    const inputType = event.detail.inputEvent.inputType;
    const selectionBefore =
      inputType === 'insertReplacementText' ||
      (node.type === 'code-block' && inputType === 'insertFromPaste')
        ? inline.getTextSelection()
        : undefined;
    if (intent.type === 'ignored') return;
    if (intent.type === 'delete-blocks') {
      this.deleteBlocks(selection, hostContext);
      return;
    }
    if (intent.type === 'replace-blocks') {
      this.replaceBlocks(selection, intent.text, hostContext);
      return;
    }
    if (intent.type === 'command') {
      if (intent.command === 'delete-backward-at-start') {
        this.runEdit(
          deleteBackwardAtStart,
          { nodeId: node.sharedId },
          this.textSelectionBefore(node.sharedId, inline, 0, 0),
          hostContext,
        );
      } else {
        this.runEdit(
          intent.command === 'insert-paragraph' ? insertParagraph : insertLineBreak,
          { nodeId: node.sharedId, from: intent.from, to: intent.to },
          this.textSelectionBefore(node.sharedId, inline, intent.from, intent.to),
          hostContext,
        );
      }
      return;
    }
    let from = intent.from;
    const to = intent.to;
    if (intent.type === 'delete-word-backward') {
      inline.moveCaret('move', 'backward', 'word');
      from = inline.getTextSelection()?.focus ?? from;
    }
    if (from === 0 && to === 0 && intent.type === 'delete-word-backward') {
      this.runEdit(
        deleteBackwardAtStart,
        { nodeId: node.sharedId },
        this.textSelectionBefore(node.sharedId, inline, 0, 0),
        hostContext,
      );
      return;
    }
    if (intent.type === 'text' && from === 0 && to === 0 && intent.insert === '') {
      this.runEdit(
        deleteBackwardAtStart,
        { nodeId: node.sharedId },
        this.textSelectionBefore(node.sharedId, inline, 0, 0),
        hostContext,
      );
      return;
    }
    const insert = intent.type === 'delete-word-backward' ? '' : intent.insert;
    const isolated = intent.type === 'delete-word-backward' || intent.isolated;
    hostContext?.clearSelection();
    this.runTextInput(node, from, to, insert, isolated, hostContext, selectionBefore);
  };

  private replaceBlocks(
    selection: readonly CanonicalNode[],
    text: string,
    hostContext?: HostContext,
  ) {
    this.runEdit(
      replaceBlocksCommand,
      { nodeIds: selection.map((node) => node.sharedId), text },
      this.blockSelectionBefore(selection, hostContext),
      hostContext,
    );
  }

  private deleteBlocks(selection: readonly CanonicalNode[], hostContext?: HostContext) {
    this.runEdit(
      deleteBlocksCommand,
      { nodeIds: selection.map((node) => node.sharedId) },
      this.blockSelectionBefore(selection, hostContext),
      hostContext,
    );
  }

  private onInlineKeyDown = (event: CustomEvent<InlineKeyDown>) => {
    const { inline, node: projectedNode, keyboardEvent } = event.detail;
    if (this.disabled) {
      keyboardEvent.preventDefault();
      return;
    }
    const hostContext = inline.hostContext;
    const node = projectedNode as unknown as CanonicalNode;
    const document = this.document;
    const writer = this.writer;
    if (!document || !writer) return;
    const selected = this.selectionController.currentBlockSelection(hostContext);
    if (
      node instanceof CanonicalNode &&
      node.type === 'code-block' &&
      selected.length === 0 &&
      keyboardEvent.key === 'Enter' &&
      !keyboardEvent.shiftKey &&
      !keyboardEvent.ctrlKey &&
      !keyboardEvent.metaKey &&
      !keyboardEvent.altKey &&
      !keyboardEvent.isComposing
    ) {
      keyboardEvent.preventDefault();
      const selection = inline.getTextSelection();
      if (selection) {
        this.runTextInput(
          node,
          Math.min(selection.anchor, selection.focus),
          Math.max(selection.anchor, selection.focus),
          '\n',
          true,
          hostContext,
        );
      }
      return;
    }
    const intent = translateInlineKey(keyboardEvent, selected.length > 0);
    if (intent.type === 'move-caret') {
      this.sealTypingGroup();
      if (inline.nodeView) {
        void this.selectionController.moveAcrossBlocks(inline, inline.nodeView, keyboardEvent);
      }
      return;
    }
    if (!(node instanceof CanonicalNode)) return;
    if (intent.type === 'history') {
      keyboardEvent.preventDefault();
      const result =
        intent.direction === 'undo' ? this.sessionRunner.undo() : this.sessionRunner.redo();
      if (result) this.restoreHistoryFocus(result, hostContext);
      return;
    }
    if (intent.type === 'delete-block-selection') {
      keyboardEvent.preventDefault();
      this.deleteBlocks(selected, hostContext);
      return;
    }
    if (intent.type === 'indent') {
      keyboardEvent.preventDefault();
      const command = intent.direction === 'outdent' ? outdent : indent;
      this.runEdit(
        command,
        { nodeId: node.sharedId, nodeIds: selected.map((item) => item.sharedId) },
        selected.length
          ? this.blockSelectionBefore(selected, hostContext)
          : this.selectionController.textSelectionStartBefore(node.sharedId, inline, 0, 0),
        hostContext,
      );
      return;
    }
    if (intent.type === 'select-all') {
      keyboardEvent.preventDefault();
      const selected = this.selectionController.currentBlockSelection(hostContext);
      const textSelection = inline.getTextSelection();
      if (selected.length) {
        const expanded = this.selectionController.expandBlockSelection(selected, hostContext);
        this.selectionController.setBlockSelection(
          expanded,
          expanded[0],
          expanded.at(-1),
          hostContext,
        );
      } else if (
        textSelection &&
        Math.min(textSelection.anchor, textSelection.focus) === 0 &&
        Math.max(textSelection.anchor, textSelection.focus) === node.content?.length
      ) {
        this.selectionController.setBlockSelection([node], node, node, hostContext);
      } else {
        inline.setSelectionOffsets(0, node.content?.length ?? 0);
      }
      return;
    }
    if (intent.type === 'seal-typing') this.sealTypingGroup();
  };

  private restoreHistoryFocus(result: HistoryResult, hostContext?: HostContext) {
    if (this.acceptedUpdateRelay && result.status === 'applied')
      this.selectionController.captureSelection();
    const shouldRestoreFocus = this.acceptedUpdateRelay ? this.focusRestoreGuard() : undefined;
    const envelope =
      result.revision !== undefined && result.update
        ? { revision: result.revision, update: result.update }
        : undefined;
    if (this.sessionTransport) {
      if (!this.sessionTransport.isReady()) return;
    } else if (!this.relayAcceptedUpdate(envelope, result.callbackErrors ?? [])) return;
    if (result.status === 'history-reset') {
      this.sealTypingGroup();
      this.dispatchEvent(
        new CustomEvent('canonical-history-reset', {
          detail: { sessionId: this.sessionId },
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }
    if (result.status !== 'applied' && result.status !== 'no-effect') return;
    if (result.selectionAnchors) {
      void this.selectionController.restoreAnchors(
        result.selectionAnchors.anchor,
        result.selectionAnchors.focus,
        result.selectionAnchors.kind !== 'text',
        false,
        hostContext,
        result.selectionAnchors.kind === 'text',
        shouldRestoreFocus,
      );
      return;
    }
    const anchor = result.focusAnchor;
    if (anchor)
      void this.selectionController.restoreAnchors(
        anchor,
        anchor,
        false,
        false,
        hostContext,
        false,
        shouldRestoreFocus,
      );
    else if (result.focus)
      void this.selectionController.focusBookmark(result.focus, hostContext, shouldRestoreFocus);
    else void this.selectionController.restoreSavedSelection(hostContext, shouldRestoreFocus);
  }

  private onCompositionStart = (event: CustomEvent<{ inline: MarkdownInline }>) => {
    this.compositionController.start(event.detail.inline);
  };

  private onCompositionEnd = (
    event: CustomEvent<{ inline: MarkdownInline; event: CompositionEvent }>,
  ) => {
    this.compositionController.end(event.detail.inline, event.detail.event);
  };

  private onClipboard = (event: ClipboardEvent) => {
    if (this.disabled && event.type !== 'copy') {
      event.preventDefault();
      return;
    }
    const inline = event.composedPath().find((target) => target instanceof MarkdownInline);
    const hostContext = inline instanceof MarkdownInline ? inline.hostContext : undefined;
    const selection = this.selectionController.currentBlockSelection(hostContext);
    const document = this.document;
    if (!selection.length) return;
    if (!document) {
      event.preventDefault();
      return;
    }
    const written = writeMarkdownClipboard(event, serializeBlockSelection(document, selection));
    if (!written) return;
    if (event.type === 'cut') this.deleteBlocks(selection, hostContext);
  };

  private onPaste = (event: ClipboardEvent) => {
    if (this.disabled) {
      event.preventDefault();
      return;
    }
    const inline = event.composedPath().find((target) => target instanceof MarkdownInline);
    if (!(inline instanceof MarkdownInline)) return;
    const node = this.activeInline(inline);
    if (!node || !event.clipboardData) return;
    const hostContext = inline.hostContext;
    const blockSelection = this.selectionController.currentBlockSelection(hostContext);
    const { markdown, text } = readClipboardPayload(event.clipboardData);
    if (markdown) {
      event.preventDefault();
      const native = inline.getTextSelection();
      const selectionBefore =
        blockSelection.length > 0
          ? this.blockSelectionBefore(blockSelection, hostContext)
          : native
            ? this.textSelectionBefore(node.sharedId, inline, native.anchor, native.focus)
            : undefined;
      this.runEdit(
        insertMarkdown,
        {
          contextId: node.sharedId,
          markdown,
          replaceActiveEmptyTarget:
            blockSelection.length === 0 && native !== undefined && native.anchor === native.focus,
        },
        selectionBefore,
        hostContext,
      );
      return;
    }
    event.preventDefault();
    if (blockSelection.length) {
      this.replaceBlocks(blockSelection, text, hostContext);
      return;
    }
    const native = inline.getTextSelection();
    if (native)
      this.runTextInput(
        node,
        Math.min(native.anchor, native.focus),
        Math.max(native.anchor, native.focus),
        node.type === 'code-block' ? text : text.replace(/\n/g, ' '),
        true,
        hostContext,
        node.type === 'code-block' ? native : undefined,
      );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'md-canonical-editor': CanonicalEditor;
  }
}
