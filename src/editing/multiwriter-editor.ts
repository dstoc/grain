import { html, LitElement } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import {
  MarkdownInline,
  type FocusRestoreGuard,
  type InlineInput,
  type InlineKeyDown,
} from '../markdown/inline-render.js';
import type { MarkdownRenderer } from '../markdown/block-render.js';
import '../markdown/block-render.js';
import type { HostContext } from '../markdown/host-context.js';
import type { MarkdownRenderDelegate } from '../markdown/render-delegate.js';
import type { TaskStateIntent } from '../markdown/render-intents.js';
import type { EditSelection } from '../markdown/semantic/selection.js';
import type { Edit } from './outcomes.js';
import type { MobileToolbarAction } from './mobile-keyboard-toolbar.js';
import { capturePoint, resolveSelection } from '../markdown/multiwriter/history/index.js';
import type {
  StablePoint,
  StableSelection,
  SelectionRestoration,
} from '../markdown/multiwriter/history/index.js';
import type { ProjectionAddress } from '../markdown/multiwriter/contracts.js';
import type { Replica } from '../markdown/multiwriter/replica/index.js';
import { ReplicaNodeView, ReplicaRenderTree } from '../markdown/multiwriter/replica/render.js';
import {
  insertText,
  insertParagraph,
  insertLineBreak,
  deleteBackwardAtStart,
  indent,
  outdent,
  deleteBlocks,
  replaceBlocks,
  insertMarkdown,
  cycleTaskState,
  RetainedEditError,
} from '../markdown/multiwriter/authoring/index.js';
import { SelectionController, type SelectionDocument } from './browser/selection-controller.js';
import { CompositionController } from './browser/composition-controller.js';
import { translateInlineInput, translateInlineKey } from './browser/input.js';
import {
  readClipboardPayload,
  serializeBlockSelection,
  writeMarkdownClipboard,
} from './browser/clipboard.js';

type Anchor = StablePoint | { readonly empty: true };

/** Experimental schema-3 browser adapter. Each mount receives its own live replica. */
@customElement('md-multiwriter-editor')
export class MultiwriterEditor extends LitElement {
  @property({ attribute: false }) accessor replica: Replica | undefined;
  @property({ attribute: false }) accessor renderDelegate: MarkdownRenderDelegate | undefined;
  @property({ type: Boolean, reflect: true }) accessor disabled = false;
  @property({ attribute: false }) accessor scopeRoot: ProjectionAddress | undefined;
  @query('md-block-render') private accessor renderer!: MarkdownRenderer;
  private tree = new ReplicaRenderTree();
  private root?: ReplicaNodeView;
  private bound?: Replica;
  private unsubscribe?: () => void;
  private binding = 0;
  private focusEpoch = 0;
  private selectionEpoch = 0;
  private local = false;
  private savedContext?: HostContext;
  private lastInline?: MarkdownInline;
  private pendingSelection?: { saved: StableSelection };
  private blockSelection?: StableSelection;
  private readonly selection = new SelectionController<ReplicaNodeView, Anchor>(
    {
      document: () => this.selectionDocument(),
      renderer: () => this.renderer,
      isConnected: () => this.isConnected,
      requestUpdate: () => this.requestUpdate(),
      updateComplete: () => this.updateComplete,
    },
    {
      generation: () => this.generation,
      hasTypingGroup: () => true,
      isCurrentGeneration: (generation) => generation === this.generation && this.isConnected,
      sealTypingGroup: () => this.seal(),
    },
  );
  private readonly composition = new CompositionController<ReplicaNodeView, Anchor>({
    node: (inline) => this.activeNode(inline),
    id: (node) => this.rendererId(node),
    revision: (node) => node.version,
    lookup: (id) => this.byId(id),
    capture: (node, offset, affinity, inline) =>
      this.captureNative(node, offset, affinity, inline.hostContext),
    resolve: (anchor) => this.resolve(anchor),
    generation: () => this.binding,
    isCurrent: (generation) =>
      generation === this.binding &&
      this.isConnected &&
      this.replica?.status().lifecycle === 'open',
    restore: (anchor, focus, context, guard) =>
      this.selection.restoreAnchors(anchor, focus, false, false, context, true, guard),
    renderer: () => this.renderer,
    updateComplete: () => this.updateComplete,
    isConnected: () => this.isConnected,
    focusRestoreGuard: (inline) => this.focusGuard(inline),
    blockSelection: (inline) => this.selection.currentBlockSelection(inline.hostContext),
    replaceBlocks: (selected, text, context) => this.replace(selected, text, context),
    runTextInput: (node, from, to, text, isolated, context) =>
      this.text(node, from, to, text, isolated, context),
  });
  private get generation() {
    return this.selectionEpoch;
  }
  private rendererId(node: ReplicaNodeView) {
    return `view:${node.id}`;
  }
  private all(node = this.root): ReplicaNodeView[] {
    return node ? [node, ...node.children.flatMap((child) => this.all(child))] : [];
  }
  private byId(id: string) {
    return this.all().find((node) => this.rendererId(node) === id);
  }
  private activeNode(inline: MarkdownInline): ReplicaNodeView | undefined {
    return inline.nodeView && this.tree.owns(inline.nodeView) ? inline.nodeView : undefined;
  }
  private capture(
    node: ReplicaNodeView,
    offset: number,
    affinity: 'left' | 'right',
    context?: HostContext,
  ): Anchor {
    if (node === this.tree.emptyCaret) return { empty: true };
    const host =
      context?.root && this.tree.owns(context.root) ? context.root.projection : undefined;
    return capturePoint(this.replica!.publication(), node.projection!, offset, affinity, host);
  }
  private captureNative(
    node: ReplicaNodeView,
    offset: number,
    affinity: 'left' | 'right',
    context?: HostContext,
  ): Anchor {
    const inline = this.focusedInline(),
      native = inline?.getTextSelection();
    // A collapsed native caret follows adjacent text when it changes owner.
    // Use one affinity for BOTH endpoints; a range retains its direction.
    if (inline?.nodeView === node && native?.anchor === offset && native.focus === offset)
      affinity = offset > 0 && offset === node.content?.length ? 'left' : 'right';
    return this.capture(node, offset, affinity, context);
  }
  private resolve(anchor: Anchor) {
    const p = this.replica!.publication();
    const result =
      'empty' in anchor
        ? resolveSelection(p, undefined, p.value.view.root.origin, true)
        : resolveSelection(p, { anchor, focus: anchor }, anchor.host);
    if (result.state === 'empty-root')
      return {
        nodeId: this.rendererId(this.tree.emptyCaret),
        offset: 0,
        affinity: 'right' as const,
      };
    if (result.state === 'unavailable') throw new Error('Selection host is unavailable');
    const node = this.tree.node(result.focus.origin.representative);
    if (!node) throw new Error('Selection node is unavailable');
    return {
      nodeId: this.rendererId(node),
      offset: result.focus.offset,
      affinity: result.focus.affinity,
    };
  }
  private selectionDocument(): SelectionDocument<ReplicaNodeView, Anchor> | undefined {
    if (!this.root || !this.replica) return;
    return {
      root: this.root,
      id: (node) => this.rendererId(node),
      node: (id) => {
        const node = this.byId(id);
        if (!node) throw new Error('Missing renderer node');
        return node;
      },
      isNode: (node): node is ReplicaNodeView => !!node && this.tree.owns(node),
      capture: (point, context) => {
        const node = this.byId(point.nodeId);
        if (!node) throw new Error('Missing renderer node');
        return this.captureNative(node, point.offset, point.affinity, context);
      },
      resolve: (anchor) => this.resolve(anchor),
    };
  }
  override connectedCallback() {
    super.connectedCallback();
    this.ownerDocument.addEventListener('focusin', this.onFocusIntent, true);
    this.ownerDocument.addEventListener('pointerdown', this.onFocusIntent, true);
    this.ownerDocument.addEventListener('keydown', this.onFocusIntent, true);
    this.selection.connect(this.ownerDocument);
    this.bind();
  }
  override disconnectedCallback() {
    this.ownerDocument.removeEventListener('focusin', this.onFocusIntent, true);
    this.ownerDocument.removeEventListener('pointerdown', this.onFocusIntent, true);
    this.ownerDocument.removeEventListener('keydown', this.onFocusIntent, true);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.bound = undefined;
    this.selection.disconnect();
    this.composition.cancel(false);
    this.binding++;
    this.selectionEpoch++;
    super.disconnectedCallback();
  }
  protected override updated(changed: Map<PropertyKey, unknown>) {
    if (changed.has('replica')) this.bind();
    if (changed.has('renderDelegate')) {
      for (const node of this.all()) if (node.type === 'code-block') node.renderSignal.value++;
    }
    if (this.renderer?.hostContext) this.renderer.hostContext.root = this.root;
  }
  private bind() {
    if (!this.isConnected || this.bound === this.replica) return;
    this.unsubscribe?.();
    this.binding++;
    this.selectionEpoch++;
    this.composition.cancel(false);
    this.selection.resetDocument();
    this.blockSelection = undefined;
    this.bound = this.replica;
    this.tree = new ReplicaRenderTree();
    this.root = undefined;
    if (!this.replica) {
      this.requestUpdate();
      return;
    }
    this.root = this.tree.refresh(this.replica.publication().value.view);
    this.unsubscribe = this.replica.subscribe((event) => {
      const focused = this.focusedInline(),
        guard = this.focusGuard(focused);
      if (event === 'closing') {
        this.composition.cancel(false);
        this.binding++;
        this.selectionEpoch++;
      }
      if (event === 'publication') {
        this.selectionEpoch++;
        try {
          this.root = this.tree.refresh(this.replica!.publication().value.view);
        } catch (error) {
          this.disabled = true;
          this.error(error);
        }
        if (!this.local && focused && !focused.composing) {
          const saved = this.pendingSelection?.saved ?? this.blockSelection;
          if (saved) void this.restoreStable(saved, this.savedContext, guard);
          else void this.selection.restoreSavedSelection(this.savedContext, guard);
        } else if (!this.local && !focused) {
          const anchor = this.selection.selectionAnchor,
            focus = this.selection.selectionFocus ?? anchor;
          const saved =
            this.blockSelection ??
            (anchor && focus && !('empty' in anchor) && !('empty' in focus)
              ? { anchor, focus }
              : undefined);
          if (saved)
            this.reconcilePassiveSelection(saved, this.savedContext ?? this.renderer?.hostContext);
        }
      }
      this.requestUpdate();
      this.dispatchEvent(new CustomEvent('replica-change', { bubbles: true, composed: true }));
    });
    this.requestUpdate();
  }
  private ready() {
    return !this.disabled && !!this.replica?.status().canAuthor;
  }
  override render() {
    return this.root
      ? html`<md-block-render
          .block=${this.root}
          .renderDelegate=${this.renderDelegate}
          ?inert=${!this.ready()}
          @inline-input=${this.onInput}
          @inline-keydown=${this.onKey}
          @inline-composition-start=${this.onCompositionStart}
          @inline-composition-end=${this.onCompositionEnd}
          @task-state-intent=${this.onTask}
          @copy=${this.onClipboard}
          @cut=${this.onClipboard}
          @paste=${this.onPaste}
          @pointerdown=${this.onPointer}
          @focusin=${this.onInlineFocus}
        ></md-block-render>`
      : html``;
  }
  private seal() {
    if (this.replica?.status().lifecycle === 'open') this.replica.sealGroup();
  }
  private onPointer = () => {
    this.blockSelection = undefined;
    this.seal();
  };
  private onInlineFocus = () => {
    const inline = this.focusedInline();
    if (inline) {
      this.savedContext = inline.hostContext;
      this.lastInline = inline;
      this.rememberBlocks(inline.hostContext);
    }
    this.selection.captureSelection();
  };
  private onFocusIntent = (event: Event) => {
    if (event.type === 'keydown') {
      const inline = event.composedPath().find((node) => node instanceof MarkdownInline);
      if (
        (event as KeyboardEvent).isComposing ||
        (inline instanceof MarkdownInline && !inline.mobileToolbarInputReady)
      )
        return;
    }
    this.focusEpoch++;
    if (event.type === 'pointerdown' || event.type === 'keydown') this.pendingSelection = undefined;
    if (event.type === 'focusin' && !event.composedPath().includes(this)) this.seal();
  };
  private focusedInline(): MarkdownInline | undefined {
    let active = this.shadowRoot?.activeElement ?? null;
    while (active instanceof HTMLElement && active.shadowRoot?.activeElement)
      active = active.shadowRoot.activeElement;
    return active instanceof MarkdownInline ? active : undefined;
  }
  private focusGuard(
    original = this.focusedInline(),
    allowCurrentControl = false,
  ): FocusRestoreGuard {
    let epoch = this.focusEpoch,
      owner = original;
    const binding = this.binding;
    let control = this.ownerDocument.activeElement;
    while (control instanceof HTMLElement && control.shadowRoot?.activeElement)
      control = control.shadowRoot.activeElement;
    const guard = (() => {
      if (binding !== this.binding || epoch !== this.focusEpoch || !this.isConnected) return false;
      const focused = this.focusedInline();
      if (focused) return focused === owner || (!!owner && !owner.isConnected);
      let active = this.ownerDocument.activeElement;
      while (active instanceof HTMLElement && active.shadowRoot?.activeElement)
        active = active.shadowRoot.activeElement;
      return (
        (allowCurrentControl && active === control) ||
        (active === this.ownerDocument.body && !!owner && !owner.isConnected)
      );
    }) as FocusRestoreGuard;
    guard.markRestored = () => {
      epoch = this.focusEpoch;
      owner = this.focusedInline();
    };
    return guard;
  }
  private error(error: unknown) {
    this.dispatchEvent(
      new CustomEvent('replica-edit-error', { detail: error, bubbles: true, composed: true }),
    );
  }
  private commandId(node: ReplicaNodeView) {
    if (!node.projection || !this.tree.owns(node))
      throw new Error('Mutation target is unavailable');
    return this.replica!.handle(node.projection.origin.representative);
  }
  private lowerSelection(selection?: EditSelection): EditSelection | undefined {
    if (!selection) return;
    const lower = (id: string) => {
      const node = this.byId(id);
      if (!node) throw new Error('Selection is unavailable');
      return this.commandId(node);
    };
    return {
      ...selection,
      ...('nodeIds' in selection ? { nodeIds: selection.nodeIds.map(lower) } : {}),
      anchor: { ...selection.anchor, nodeId: lower(selection.anchor.nodeId) },
      focus: { ...selection.focus, nodeId: lower(selection.focus.nodeId) },
    };
  }
  private rememberBlocks(context?: HostContext) {
    const selected = this.selection.currentBlockSelection(context);
    const range = this.selection.blockSelectionBefore(selected, context);
    if (!range) {
      this.blockSelection = undefined;
      return;
    }
    const anchor = this.byId(range.anchor.nodeId),
      focus = this.byId(range.focus.nodeId);
    if (!anchor?.projection || !focus?.projection) return;
    const a = this.capture(anchor, range.anchor.offset, range.anchor.affinity, context),
      f = this.capture(focus, range.focus.offset, range.focus.affinity, context);
    if ('empty' in a || 'empty' in f) return;
    this.savedContext = context;
    this.blockSelection = {
      anchor: a,
      focus: f,
      blocks: selected.flatMap((node) => (node.projection ? [node.projection.origin] : [])),
    };
  }
  private reconcilePassiveSelection(saved: StableSelection, context?: HostContext) {
    const result = resolveSelection(this.replica!.publication(), saved, saved.focus.host);
    this.blockSelection = undefined;
    if (result.state === 'unavailable') {
      context?.clearSelection();
      this.selection.resetDocument();
      return;
    }
    if (result.state === 'empty-root') {
      context?.clearSelection();
      this.selection.rememberAnchors({ empty: true }, { empty: true });
      return;
    }
    const anchor = this.tree.node(result.anchor.origin.representative),
      focus = this.tree.node(result.focus.origin.representative);
    if (!anchor || !focus) return;
    const a = this.capture(anchor, result.anchor.offset, result.anchor.affinity, context),
      f = this.capture(focus, result.focus.offset, result.focus.affinity, context);
    this.selection.rememberAnchors(a, f);
    if (result.state === 'exact' && result.blocks && !('empty' in a) && !('empty' in f)) {
      this.blockSelection = { anchor: a, focus: f, blocks: result.blocks };
      const nodes = Array.from(
        new Set(
          result.blocks.flatMap((address) =>
            address.type === 'node'
              ? [this.tree.node(address.representative)].filter(
                  (node): node is ReplicaNodeView => !!node,
                )
              : [],
          ),
        ),
      );
      this.selection.setBlockSelection(nodes, anchor, focus, context);
    } else context?.clearSelection();
  }
  private scopedNode(host: ReplicaNodeView): ReplicaNodeView {
    if (!this.scopeRoot) return host;
    if (this.scopeRoot.type !== 'node') throw new Error('Scope must name a visible node');
    const node = this.tree.node(this.scopeRoot.representative);
    if (!node) throw new Error('Scope is unavailable');
    return node;
  }
  private run<Input>(
    command: Edit<Input>,
    input: Input,
    before?: EditSelection,
    context?: HostContext,
    typing = false,
    promote?: string,
  ) {
    if (!this.ready()) return;
    const guard = this.focusGuard();
    this.local = true;
    try {
      const host = context?.root && this.tree.owns(context.root) ? context.root : this.root!;
      const result = this.replica!.edit(command, input, {
        hostRoot: this.commandId(host),
        scopeRoot: this.commandId(this.scopedNode(host)),
        selectionBefore: this.lowerSelection(before),
        typing,
        ...(promote ? { promote } : {}),
      });
      if (result.applied && result.selectionAfter)
        void this.restoreStable(result.selectionAfter, context, guard);
    } catch (error) {
      this.recoverError(error, context, guard);
    } finally {
      this.local = false;
    }
  }
  private recoverError(error: unknown, context?: HostContext, guard = this.focusGuard()) {
    this.error(error);
    if (!(error instanceof RetainedEditError)) return;
    try {
      this.replica!.retryPublication(100_000);
      const host =
        context?.root && this.tree.owns(context.root) ? context.root.projection?.origin : undefined;
      const restoration = this.replica!.retainedRestoration(error.action, host);
      if (restoration) void this.restoreResult(restoration, context, guard);
      else void this.selection.restoreSavedSelection(context, guard);
    } catch (refreshError) {
      this.error(refreshError);
    }
  }
  private async restoreStable(
    saved: StableSelection,
    context?: HostContext,
    guard?: FocusRestoreGuard,
  ) {
    const pending = { saved };
    this.pendingSelection = pending;
    this.blockSelection = saved.blocks?.length ? saved : undefined;
    try {
      const p = this.replica!.publication();
      const result = resolveSelection(p, saved, saved.focus.host);
      await this.restoreResult(result, context, guard);
    } finally {
      if (this.pendingSelection === pending) this.pendingSelection = undefined;
    }
  }

  private async restoreResult(
    result: SelectionRestoration,
    context?: HostContext,
    guard?: FocusRestoreGuard,
  ) {
    this.blockSelection = undefined;
    if (result.state === 'unavailable') return;
    if (result.state === 'empty-root') {
      await this.selection.restoreAnchors(
        { empty: true },
        { empty: true },
        false,
        false,
        context,
        true,
        guard,
      );
      return;
    }
    const anchor = this.tree.node(result.anchor.origin.representative),
      focus = this.tree.node(result.focus.origin.representative);
    if (!anchor || !focus) return;
    const a = this.capture(anchor, result.anchor.offset, result.anchor.affinity, context),
      f = this.capture(focus, result.focus.offset, result.focus.affinity, context);
    if (result.state === 'exact' && result.blocks && !('empty' in a) && !('empty' in f))
      this.blockSelection = { anchor: a, focus: f, blocks: result.blocks };
    await this.selection.restoreAnchors(
      a,
      f,
      result.state === 'exact' && !!result.blocks?.length,
      false,
      context,
      true,
      guard,
    );
  }
  private text(
    node: ReplicaNodeView,
    from: number,
    to: number,
    text: string,
    isolated = false,
    context?: HostContext,
  ) {
    if (!this.ready()) return;
    if (node === this.tree.emptyCaret) {
      if (!text) return;
      const guard = this.focusGuard();
      this.local = true;
      try {
        const result = this.replica!.editEmptyRoot(text);
        if (result.applied && result.selectionAfter)
          void this.restoreStable(result.selectionAfter, context, guard);
      } catch (error) {
        this.recoverError(error, context, guard);
      } finally {
        this.local = false;
      }
      return;
    }
    const inline = this.focusedInline();
    const before = inline
      ? this.selection.textSelectionBefore(this.rendererId(node), inline, from, to)
      : undefined;
    const nodeId = this.commandId(node);
    this.run(
      insertText,
      { nodeId, from, to, text },
      before,
      context,
      !isolated && from === to,
      node.type !== 'code-block' && text ? nodeId : undefined,
    );
  }
  private replace(nodes: readonly ReplicaNodeView[], text: string, context?: HostContext) {
    this.run(
      replaceBlocks,
      { nodeIds: nodes.map((n) => this.commandId(n)), text },
      this.selection.blockSelectionBefore(nodes, context),
      context,
    );
  }
  private delete(nodes: readonly ReplicaNodeView[], context?: HostContext) {
    this.run(
      deleteBlocks,
      { nodeIds: nodes.map((n) => this.commandId(n)) },
      this.selection.blockSelectionBefore(nodes, context),
      context,
    );
  }
  private onInput = (event: CustomEvent<InlineInput>) => {
    if (!this.ready()) return;
    const { inline } = event.detail,
      node = this.activeNode(inline),
      context = inline.hostContext;
    if (!node) return;
    this.savedContext = context;
    const selected = this.selection.currentBlockSelection(context),
      intent = translateInlineInput(event.detail, selected.length > 0);
    if (intent.type === 'ignored') return;
    if (intent.type === 'replace-blocks') {
      this.replace(selected, intent.text, context);
      return;
    }
    if (intent.type === 'delete-blocks') {
      this.delete(selected, context);
      return;
    }
    if (intent.type === 'command') {
      if (node === this.tree.emptyCaret) return;
      const nodeId = this.commandId(node),
        before = this.selection.textSelectionBefore(
          this.rendererId(node),
          inline,
          intent.from,
          intent.to,
        );
      if (intent.command === 'delete-backward-at-start')
        this.run(deleteBackwardAtStart, { nodeId }, before, context);
      else
        this.run(
          intent.command === 'insert-paragraph' ? insertParagraph : insertLineBreak,
          { nodeId, from: intent.from, to: intent.to },
          before,
          context,
        );
      return;
    }
    let from = intent.from;
    if (intent.type === 'delete-word-backward') {
      inline.moveCaret('move', 'backward', 'word');
      from = inline.getTextSelection()?.focus ?? from;
    }
    this.text(
      node,
      from,
      intent.to,
      intent.type === 'text' ? intent.insert : '',
      intent.type !== 'text' || intent.isolated,
      context,
    );
  };
  private onKey = (event: CustomEvent<InlineKeyDown>) => {
    const { inline, keyboardEvent: key } = event.detail;
    if (!this.ready()) {
      key.preventDefault();
      return;
    }
    const node = this.activeNode(inline);
    if (!node) return;
    const context = inline.hostContext,
      selected = this.selection.currentBlockSelection(context);
    this.savedContext = context;
    if (
      node.type === 'code-block' &&
      selected.length === 0 &&
      key.key === 'Enter' &&
      !key.shiftKey &&
      !key.ctrlKey &&
      !key.metaKey &&
      !key.altKey &&
      !key.isComposing
    ) {
      key.preventDefault();
      const native = inline.getTextSelection();
      if (native)
        this.text(
          node,
          Math.min(native.anchor, native.focus),
          Math.max(native.anchor, native.focus),
          '\n',
          true,
          context,
        );
      return;
    }
    const intent = translateInlineKey(key, selected.length > 0);
    if (intent.type === 'history') {
      key.preventDefault();
      this.navigate(intent.direction, context);
    } else if (intent.type === 'move-caret') {
      this.seal();
      void this.selection
        .moveAcrossBlocks(inline, inline.nodeView!, key)
        .then(() => this.rememberBlocks(context));
    } else if (intent.type === 'delete-block-selection') {
      key.preventDefault();
      this.delete(selected, context);
    } else if (intent.type === 'indent') {
      key.preventDefault();
      if (node === this.tree.emptyCaret) return;
      this.run(
        intent.direction === 'indent' ? indent : outdent,
        { nodeId: this.commandId(node) },
        selected.length
          ? this.selection.blockSelectionBefore(selected, context)
          : this.selection.textSelectionStartBefore(this.rendererId(node), inline, 0, 0),
        context,
      );
    } else if (intent.type === 'select-all') {
      key.preventDefault();
      this.seal();
      const native = inline.getTextSelection();
      if (selected.length) {
        const expanded = this.selection.expandBlockSelection(selected, context);
        this.selection.setBlockSelection(expanded, expanded[0], expanded.at(-1), context);
      } else if (
        native &&
        Math.min(native.anchor, native.focus) === 0 &&
        Math.max(native.anchor, native.focus) === node.content?.length
      )
        this.selection.setBlockSelection([node], node, node, context);
      else inline.setSelectionOffsets(0, node.content?.length ?? 0);
    } else if (intent.type === 'seal-typing') this.seal();
    if (intent.type === 'select-all') this.rememberBlocks(context);
  };
  navigate(direction: 'undo' | 'redo', context = this.savedContext) {
    if (!this.ready()) return;
    const guard = this.focusGuard();
    this.local = true;
    try {
      const host =
        context?.root && this.tree.owns(context.root)
          ? context.root.projection?.origin
          : this.replica!.publication().value.view.root.origin;
      const result = this.replica![direction]({ host, scope: this.scopeRoot });
      if (result.state === 'applied') void this.restoreResult(result.restoration, context, guard);
    } catch (error) {
      this.recoverError(error, context, guard);
    } finally {
      this.local = false;
    }
  }
  /** Toolbar actions keep the initiating pane and its current stable selection. */
  async toolbarAction(action: MobileToolbarAction): Promise<void> {
    if (!this.ready() || !this.lastInline) return;
    const binding = this.binding,
      guard = this.focusGuard(this.lastInline, true);
    const anchor = this.selection.selectionAnchor,
      focus = this.selection.selectionFocus ?? anchor;
    if (anchor && focus)
      await this.selection.restoreAnchors(
        anchor,
        focus,
        false,
        this.savedContext?.hasSelection,
        this.savedContext,
        true,
        guard,
      );
    if (binding !== this.binding || !guard() || !this.ready()) return;
    const inline = this.focusedInline(),
      node = inline && this.activeNode(inline);
    if (!inline || !node) return;
    if (action === 'undo' || action === 'redo') {
      this.navigate(action);
      return;
    }
    if (action === 'split') {
      const native = inline.getTextSelection();
      if (!native) return;
      const from = Math.min(native.anchor, native.focus),
        to = Math.max(native.anchor, native.focus);
      if (node.type === 'code-block' || node === this.tree.emptyCaret)
        this.text(node, from, to, '\n', true, inline.hostContext);
      else
        this.run(
          insertParagraph,
          { nodeId: this.commandId(node), from, to },
          this.selection.textSelectionBefore(this.rendererId(node), inline, from, to),
          inline.hostContext,
        );
      return;
    }
    const keys: Partial<Record<MobileToolbarAction, string>> = {
      indent: 'Tab',
      unindent: 'Tab',
      'select-all': 'a',
      left: 'ArrowLeft',
      right: 'ArrowRight',
      up: 'ArrowUp',
      down: 'ArrowDown',
      'extend-up': 'ArrowUp',
      'extend-down': 'ArrowDown',
    };
    const key = keys[action];
    if (!key) return;
    inline.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        ctrlKey: action === 'select-all',
        shiftKey: action === 'unindent' || action.startsWith('extend-'),
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  }
  private onTask = (event: CustomEvent<TaskStateIntent>) => {
    const node = event.detail.node;
    if (this.ready() && this.tree.owns(node) && event.detail.operation === 'cycle')
      this.run(
        cycleTaskState,
        { nodeId: this.commandId(node) },
        undefined,
        (
          event
            .composedPath()
            .find((target) => target instanceof HTMLElement && 'hostContext' in target) as
            | { hostContext?: HostContext }
            | undefined
        )?.hostContext,
      );
  };
  private onCompositionStart = (event: CustomEvent<{ inline: MarkdownInline }>) => {
    if (this.ready()) {
      this.seal();
      this.composition.start(event.detail.inline);
    }
  };
  private onCompositionEnd = (
    event: CustomEvent<{ inline: MarkdownInline; event: CompositionEvent }>,
  ) => this.composition.end(event.detail.inline, event.detail.event);
  private onClipboard = (event: ClipboardEvent) => {
    if (!this.ready() && event.type !== 'copy') {
      event.preventDefault();
      return;
    }
    const inline = event.composedPath().find((target) => target instanceof MarkdownInline);
    const context = inline instanceof MarkdownInline ? inline.hostContext : undefined;
    const selected = this.selection.currentBlockSelection(context);
    if (!selected.length || !this.root) return;
    if (
      writeMarkdownClipboard(event, serializeBlockSelection({ root: this.root }, selected)) &&
      event.type === 'cut'
    )
      this.delete(selected, context);
  };
  private onPaste = (event: ClipboardEvent) => {
    if (!this.ready()) {
      event.preventDefault();
      return;
    }
    const inline = event.composedPath().find((target) => target instanceof MarkdownInline);
    if (!(inline instanceof MarkdownInline)) return;
    const node = this.activeNode(inline);
    if (!node || !event.clipboardData) return;
    event.preventDefault();
    const context = inline.hostContext,
      selected = this.selection.currentBlockSelection(context),
      native = inline.getTextSelection();
    const { markdown, text } = readClipboardPayload(event.clipboardData);
    if (node === this.tree.emptyCaret) {
      this.text(node, 0, 0, markdown || text, true, context);
      return;
    }
    if (markdown) {
      this.run(
        insertMarkdown,
        {
          contextId: this.commandId(node),
          markdown,
          replaceActiveEmptyTarget: !selected.length && !!native && native.anchor === native.focus,
        },
        selected.length
          ? this.selection.blockSelectionBefore(selected, context)
          : native
            ? this.selection.textSelectionBefore(
                this.rendererId(node),
                inline,
                native.anchor,
                native.focus,
              )
            : undefined,
        context,
      );
    } else if (selected.length) this.replace(selected, text, context);
    else if (native)
      this.text(
        node,
        Math.min(native.anchor, native.focus),
        Math.max(native.anchor, native.focus),
        node.type === 'code-block' ? text : text.replace(/\n/g, ' '),
        true,
        context,
      );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'md-multiwriter-editor': MultiwriterEditor;
  }
}
