import { html, LitElement } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

import { CanonicalWriter } from '../markdown/canonical-actions.js';
import type {
  AcceptedAction,
  ActionFocus,
  ActionOptions,
  Bookmark,
  HistoryResult,
  TreeDraft,
} from '../markdown/canonical-actions.js';
import { CanonicalDocument, CanonicalNode } from '../markdown/canonical-model.js';
import type { MarkdownNode } from '../markdown/node.js';
import { serializeToString } from '../markdown/block-serializer.js';
import '../markdown/block-render.js';
import type { NodeId } from '../markdown/canonical-model.js';
import {
  createCanonicalTextAnchor,
  resolveCanonicalTextAnchor,
} from '../markdown/canonical-selection.js';
import type { CanonicalTextAnchor } from '../markdown/canonical-selection.js';
import {
  deleteContentBackwards,
  editIndent,
  insertLineBreak,
  insertMarkdownBlocks,
  insertParagraph,
  replaceSelectedBlocks,
} from './canonical-edits.js';
import { MarkdownInline, type InlineInput, type InlineKeyDown } from '../markdown/inline-render.js';
import { MarkdownRenderer } from '../markdown/block-render.js';
import { HostContext } from '../markdown/host-context.js';
import type { MarkdownRenderDelegate } from '../markdown/render-delegate.js';
import type { ViewModelNode } from '../markdown/view-model-node.js';
import './mobile-keyboard-toolbar.js';

interface CompositionDraft {
  readonly inline: MarkdownInline;
  readonly node: CanonicalNode;
  readonly content: string;
  readonly version: number;
  readonly selection: { readonly anchor: number; readonly focus: number };
  readonly selectionAnchor: CanonicalTextAnchor;
  readonly selectionFocus: CanonicalTextAnchor;
  readonly blockSelection?: readonly NodeId[];
  invalidate: () => void;
}

interface NativeSelectionSnapshot {
  readonly nodeId: NodeId;
  readonly anchor: number;
  readonly focus: number;
}

let fallbackActionOrdinal = 0;

/** Browser editing over the canonical Yjs model and its single history coordinator. */
@customElement('md-canonical-editor')
export class CanonicalEditor extends LitElement {
  @property({ attribute: false }) accessor document: CanonicalDocument | undefined;
  @property({ attribute: false }) accessor writer: CanonicalWriter | undefined;
  @property({ attribute: false }) accessor renderDelegate: MarkdownRenderDelegate | undefined;
  @property({ type: String, attribute: 'session-id' }) accessor sessionId = 'local';

  @query('md-block-render') private accessor renderer!: MarkdownRenderer;

  private unsubscribeProjection?: () => void;
  private composition?: CompositionDraft;
  private textGroup?: { readonly id: string; readonly nodeId: NodeId; lastInputAt: number };
  private selectionAnchor?: CanonicalTextAnchor;
  private selectionFocus?: CanonicalTextAnchor;
  private lastNativeSelection?: NativeSelectionSnapshot;
  private expectedInputSelection?: { readonly nodeId: NodeId; readonly offset: number };
  private localCommit = false;
  private restoringSelection = false;
  private selectionChangeRoot?: ShadowRoot;

  override render() {
    const root = this.document?.root;
    if (!root) return html``;
    return html`<md-block-render
      .block=${root as unknown as ViewModelNode}
      .renderDelegate=${this.renderDelegate}
      @inline-input=${this.onInlineInput}
      @inline-keydown=${this.onInlineKeyDown}
      @inline-composition-start=${this.onCompositionStart}
      @inline-composition-end=${this.onCompositionEnd}
      @copy=${this.onClipboard}
      @cut=${this.onClipboard}
      @paste=${this.onPaste}
      @pointerdown=${this.onPointerDown}
    ></md-block-render>`;
  }

  protected override updated(changed: Map<PropertyKey, unknown>) {
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
        if (this.localCommit || !this.selectionAnchor) return;
        this.restoreSavedSelection();
      });
    }
    const context = this.renderer?.hostContext;
    if (context) {
      context.root = this.document?.root as unknown as ViewModelNode | undefined;
      context.canonicalWriter = this.writer;
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.ownerDocument.addEventListener('selectionchange', this.onSelectionChange);
  }

  override disconnectedCallback() {
    this.unsubscribeProjection?.();
    this.unsubscribeProjection = undefined;
    this.ownerDocument.removeEventListener('selectionchange', this.onSelectionChange);
    this.selectionChangeRoot?.removeEventListener('selectionchange', this.onSelectionChange);
    this.selectionChangeRoot = undefined;
    if (this.composition) {
      this.composition.inline.removeEventListener(
        'composition-invalidated',
        this.composition.invalidate,
      );
      this.composition.inline.composing = false;
      this.composition = undefined;
    }
    super.disconnectedCallback();
  }

  private get hostContext(): HostContext | undefined {
    return this.renderer?.hostContext;
  }

  private nextActionId() {
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

  private activeInline(inline: MarkdownInline): CanonicalNode | undefined {
    const node = inline.node as unknown;
    return node instanceof CanonicalNode ? node : undefined;
  }

  private visibleInlineNodes(): CanonicalNode[] {
    const root = this.document?.root;
    if (!root) return [];
    const result: CanonicalNode[] = [];
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'paragraph' || node.type === 'section' || node.type === 'code-block') {
        result.push(node);
      }
      pending.push(...[...node.children].reverse());
    }
    return result;
  }

  private currentBlockSelection(): CanonicalNode[] {
    const selection = this.hostContext?.selection ?? [];
    const selected = new Set(
      [...selection].map((node) => (node as unknown as CanonicalNode).sharedId),
    );
    return this.visibleInlineNodes().filter((node) => selected.has(node.sharedId));
  }

  private captureSelection(sealChangedGroup = false) {
    if (this.restoringSelection || !this.document) return;
    const { inline } = this.renderer?.getInlineSelection() ?? {};
    const node = inline && this.activeInline(inline);
    const selection = inline?.getTextSelection();
    if (!node || !selection || !node.connected) return;
    const snapshot = { nodeId: node.sharedId, anchor: selection.anchor, focus: selection.focus };
    const previous = this.lastNativeSelection;
    if (
      sealChangedGroup &&
      this.textGroup &&
      previous &&
      (previous.nodeId !== snapshot.nodeId ||
        previous.anchor !== snapshot.anchor ||
        previous.focus !== snapshot.focus)
    ) {
      this.sealTypingGroup();
    }
    this.lastNativeSelection = snapshot;
    const root = inline.getRootNode();
    const selectionRoot = root instanceof ShadowRoot ? root : undefined;
    if (selectionRoot !== this.selectionChangeRoot) {
      this.selectionChangeRoot?.removeEventListener('selectionchange', this.onSelectionChange);
      this.selectionChangeRoot = selectionRoot;
      this.selectionChangeRoot?.addEventListener('selectionchange', this.onSelectionChange);
    }
    try {
      this.selectionAnchor = createCanonicalTextAnchor(this.document, {
        nodeId: node.sharedId,
        offset: selection.anchor,
        affinity: selection.anchor <= selection.focus ? 'left' : 'right',
      });
      this.selectionFocus = createCanonicalTextAnchor(this.document, {
        nodeId: node.sharedId,
        offset: selection.focus,
        affinity: selection.focus >= selection.anchor ? 'right' : 'left',
      });
    } catch {
      // A native selection can briefly point into a render recovery projection.
    }
  }

  private onSelectionChange = () => {
    const { inline } = this.renderer?.getInlineSelection() ?? {};
    const node = inline && this.activeInline(inline);
    const selection = inline?.getTextSelection();
    const expected = this.expectedInputSelection;
    if (
      node &&
      selection &&
      expected?.nodeId === node.sharedId &&
      selection.anchor === expected.offset &&
      selection.focus === expected.offset
    ) {
      this.expectedInputSelection = undefined;
      this.captureSelection();
      return;
    }
    this.expectedInputSelection = undefined;
    this.captureSelection(true);
  };

  private onPointerDown = () => {
    this.sealTypingGroup();
  };

  private sealTypingGroup() {
    this.textGroup = undefined;
    this.writer?.sealTextGroup(this.sessionId);
  }

  private inputHistoryGroup(nodeId: NodeId, isolated: boolean) {
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

  private async restoreSavedSelection() {
    const anchor = this.selectionAnchor;
    const focus = this.selectionFocus ?? anchor;
    if (!anchor || !focus) return;
    await this.restoreAnchors(anchor, focus);
  }

  private async restoreAnchors(
    anchor: CanonicalTextAnchor,
    focus: CanonicalTextAnchor,
    restoreAsBlockSelection = false,
    preserveBlockSelection = false,
  ): Promise<void> {
    const document = this.document;
    const renderer = this.renderer;
    if (!document || !renderer || !this.isConnected) return;
    let start: Bookmark;
    let end: Bookmark;
    try {
      start = resolveCanonicalTextAnchor(document, anchor);
      end = resolveCanonicalTextAnchor(document, focus);
    } catch {
      return;
    }
    const target = document.node(end.nodeId);
    if (!target.connected) return;
    const context = renderer.hostContext;
    if (!preserveBlockSelection && (start.nodeId !== end.nodeId || restoreAsBlockSelection)) {
      const visible = this.visibleInlineNodes();
      const startIndex = visible.findIndex((node) => node.sharedId === start.nodeId);
      const endIndex = visible.findIndex((node) => node.sharedId === end.nodeId);
      if (startIndex >= 0 && endIndex >= 0) {
        const low = Math.min(startIndex, endIndex);
        const high = Math.max(startIndex, endIndex);
        const ordered = visible.slice(low, high + 1);
        this.setBlockSelection(ordered, document.node(start.nodeId), document.node(end.nodeId));
      }
    } else if (!preserveBlockSelection) {
      context.clearSelection();
    }
    context.focusNode =
      target as unknown as import('../markdown/view-model-node.js').InlineViewModelNode;
    context.focusOffset = end.offset;
    this.restoringSelection = true;
    this.requestUpdate();
    try {
      await this.updateComplete;
      await renderer.updateComplete;
      if (!this.isConnected || this.document !== document) return;
      const inline = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].find(
        (candidate) => candidate.node === (target as unknown as ViewModelNode),
      );
      if (!inline || !inline.isConnected) return;
      await inline.updateComplete;
      inline.focus();
      inline.setSelectionOffsets(start.offset, end.offset);
      this.lastNativeSelection = {
        nodeId: target.sharedId,
        anchor: start.offset,
        focus: end.offset,
      };
      if (this.expectedInputSelection?.nodeId === target.sharedId) {
        this.expectedInputSelection = { nodeId: target.sharedId, offset: end.offset };
      }
      this.selectionAnchor = createCanonicalTextAnchor(document, start);
      this.selectionFocus = createCanonicalTextAnchor(document, end);
    } finally {
      this.restoringSelection = false;
    }
  }

  private async focusBookmark(bookmark: Bookmark | undefined) {
    if (!this.document || !bookmark) return;
    try {
      const anchor = createCanonicalTextAnchor(this.document, bookmark);
      await this.restoreAnchors(anchor, anchor);
    } catch {
      // A deleted or no longer visible result uses the saved selection fallback.
      await this.restoreSavedSelection();
    }
  }

  private onAccepted(accepted: AcceptedAction, restoreBlockSelection = false) {
    this.captureSelection();
    if (
      accepted.receipt.structuralPatch.cells.length ||
      accepted.receipt.structuralPatch.births.length
    ) {
      this.sealTypingGroup();
    }
    const selection = accepted.receipt.focus?.selection;
    if (restoreBlockSelection && selection && this.document) {
      try {
        const anchor = createCanonicalTextAnchor(this.document, selection.anchor);
        const focus = createCanonicalTextAnchor(this.document, selection.focus);
        void this.restoreAnchors(anchor, focus, true);
        return;
      } catch {
        // A selection endpoint can be hidden by the structural action.
      }
    }
    const focus = accepted.receipt.focus?.end;
    if (focus) void this.focusBookmark(focus);
    else void this.restoreSavedSelection();
  }

  private runDraft(
    callback: (draft: TreeDraft) => ActionFocus | void,
    restoreBlockSelection = false,
  ) {
    const document = this.document;
    const writer = this.writer;
    if (!document || !writer) return;
    this.sealTypingGroup();
    this.localCommit = true;
    try {
      const result = writer.edit(this.options(), callback);
      if ('receipt' in result) this.onAccepted(result, restoreBlockSelection);
      else if (result.status === 'rejected') this.dispatchEditError(result.reason);
    } catch (error) {
      this.dispatchEditError(error);
    } finally {
      this.localCommit = false;
    }
  }

  private runTextInput(
    node: CanonicalNode,
    from: number,
    to: number,
    insert: string,
    isolated = false,
  ) {
    const document = this.document;
    const writer = this.writer;
    if (!document || !writer) return;
    const group = this.inputHistoryGroup(node.sharedId, isolated);
    const start: Bookmark = { nodeId: node.sharedId, offset: from, affinity: 'left' };
    const end: Bookmark = {
      nodeId: node.sharedId,
      offset: from + insert.length,
      affinity: 'right',
    };
    this.expectedInputSelection = { nodeId: node.sharedId, offset: end.offset };
    this.localCommit = true;
    try {
      const request = writer.prepareTextInput(
        node.sharedId,
        { from, to, insert },
        { ...this.options(group), focus: { start, end } },
      );
      const result = writer.apply(request, {
        sessionId: this.sessionId,
        authorityEpoch: request.authorityEpoch,
        sessionSequence: request.sessionSequence,
      });
      if (result.status === 'pending') this.onAccepted(writer.publish(result.pending));
      else if (result.status === 'duplicate') this.onAccepted(result.accepted);
      else if (result.status === 'rejected') this.dispatchEditError(result.reason);
    } catch (error) {
      this.dispatchEditError(error);
    } finally {
      this.localCommit = false;
    }
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
    const { inline, inputEvent, inputStart, inputEnd } = event.detail;
    const node = this.activeInline(inline);
    const document = this.document;
    if (!node || !document) return;

    const selection = this.currentBlockSelection();
    if (
      selection.length &&
      ['insertText', 'insertReplacementText', 'insertFromPaste'].includes(inputEvent.inputType)
    ) {
      const value =
        inputEvent.inputType === 'insertReplacementText'
          ? (inputEvent.dataTransfer?.getData('text/plain') ?? inputEvent.data ?? '')
          : (inputEvent.data ?? '');
      this.replaceBlocks(selection, value);
      return;
    }
    if (
      selection.length &&
      ['deleteContentBackward', 'deleteContentForward', 'deleteByCut'].includes(
        inputEvent.inputType,
      )
    ) {
      this.replaceBlocks(selection, '');
      return;
    }
    this.hostContext?.clearSelection();

    if (inputEvent.inputType === 'insertParagraph') {
      this.runDraft((draft) =>
        insertParagraph(
          draft,
          document.root.sharedId,
          node.sharedId,
          inputStart.index,
          inputEnd.index,
        ),
      );
      return;
    }
    if (inputEvent.inputType === 'insertLineBreak') {
      this.runDraft((draft) =>
        insertLineBreak(
          draft,
          document.root.sharedId,
          node.sharedId,
          inputStart.index,
          inputEnd.index,
        ),
      );
      return;
    }

    let from = inputStart.index;
    const to = inputEnd.index;
    let insert: string;
    switch (inputEvent.inputType) {
      case 'insertText':
        insert = inputEvent.data ?? '';
        break;
      case 'insertReplacementText':
      case 'insertFromPaste':
        insert = inputEvent.dataTransfer?.getData('text/plain') ?? inputEvent.data ?? '';
        insert = insert.replace(/\n/g, ' ');
        this.sealTypingGroup();
        break;
      case 'deleteByCut':
        insert = '';
        this.sealTypingGroup();
        break;
      case 'deleteContentBackward':
        insert = '';
        if (from === to) from = previousCodePoint(node.content ?? '', from);
        break;
      case 'deleteWordBackward':
        inline.moveCaret('move', 'backward', 'word');
        from = inline.getTextSelection()?.focus ?? from;
        insert = '';
        break;
      default:
        return;
    }
    if (from === 0 && to === 0 && insert === '' && inputEvent.inputType.startsWith('delete')) {
      this.runDraft((draft) =>
        deleteContentBackwards(draft, document.root.sharedId, node.sharedId),
      );
      return;
    }
    this.runTextInput(node, from, to, insert, inputEvent.inputType !== 'insertText');
  };

  private replaceBlocks(selection: readonly CanonicalNode[], text: string) {
    const root = this.document?.root;
    if (!root) return;
    const first = selection[0];
    const last = selection.at(-1);
    if (!first || !last) return;
    const hostContext = this.hostContext;
    const reverse =
      !!hostContext?.selectionAnchor &&
      (hostContext.selectionAnchor as unknown as CanonicalNode).sharedId === last.sharedId;
    this.runDraft((draft) => {
      const start = draft.bookmark(
        reverse ? last.sharedId : first.sharedId,
        reverse ? (last.content ?? '').length : 0,
        reverse ? 'right' : 'left',
      );
      const focus = draft.bookmark(
        reverse ? first.sharedId : last.sharedId,
        reverse ? 0 : (last.content ?? '').length,
        reverse ? 'left' : 'right',
      );
      const actionFocus = replaceSelectedBlocks(
        draft,
        root.sharedId,
        selection.map((node) => node.sharedId),
        text,
      );
      if (!actionFocus) return;
      return { ...actionFocus, selection: { anchor: start, focus } };
    });
    this.hostContext?.clearSelection();
  }

  private serializeBlockSelection(selection: readonly CanonicalNode[]): string {
    const document = this.document;
    if (!document) return '';
    const selected = new Set(selection.map((node) => node.sharedId));
    const sectionsWithSelectedChildren = new WeakSet<MarkdownNode>();
    const hasSelectedDescendant = (node: CanonicalNode): boolean =>
      node.children.some((child) => selected.has(child.sharedId) || hasSelectedDescendant(child));
    const roots = new Set<CanonicalNode>();
    for (const node of selection) {
      if (node.previousSibling) {
        roots.add(node);
        continue;
      }
      let root = node;
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor.type === 'section') break;
        root = ancestor;
        if (ancestor.previousSibling) break;
      }
      roots.add(root);
    }
    for (const root of roots) {
      for (let ancestor = root.parent; ancestor; ancestor = ancestor.parent) {
        if (roots.has(ancestor)) {
          roots.delete(root);
          break;
        }
      }
    }
    const order = new Map<CanonicalNode, number>();
    const visit = (node: CanonicalNode) => {
      order.set(node, order.size);
      node.children.forEach(visit);
    };
    visit(document.root);
    const convert = (node: CanonicalNode): MarkdownNode | undefined => {
      const children = node.children
        .map(convert)
        .filter((child): child is MarkdownNode => child !== undefined);
      const isSelected = selected.has(node.sharedId);
      let result: MarkdownNode;
      switch (node.type) {
        case 'document':
          if (!children.length) return undefined;
          result = { type: 'document', children };
          break;
        case 'paragraph':
          if (!isSelected) return undefined;
          result = { type: 'paragraph', content: node.content ?? '' };
          break;
        case 'section':
          if (!isSelected && !children.length) return undefined;
          result = {
            type: 'section',
            marker: node.marker ?? '',
            content: isSelected ? (node.content ?? '') : '',
            children,
          };
          if (isSelected && hasSelectedDescendant(node)) sectionsWithSelectedChildren.add(result);
          break;
        case 'code-block':
          if (!isSelected) return undefined;
          result = { type: 'code-block', info: node.info ?? null, content: node.content ?? '' };
          break;
        case 'list':
          if (!children.length) return undefined;
          result = { type: 'list', children };
          break;
        case 'list-item':
          if (!children.length) return undefined;
          result = {
            type: 'list-item',
            marker: node.marker ?? '',
            ...(node.checked === undefined ? {} : { checked: node.checked }),
            children,
          };
          break;
        case 'block-quote':
          if (!children.length) return undefined;
          result = { type: 'block-quote', marker: node.marker ?? '', children };
          break;
      }
      return result;
    };
    const orderedRoots = [...roots].toSorted((a, b) => order.get(a)! - order.get(b)!);
    const blocks = orderedRoots
      .map(convert)
      .filter((block): block is MarkdownNode => block !== undefined);
    return blocks.length
      ? serializeToString({ type: 'document', children: blocks }, undefined, undefined, (node) =>
          sectionsWithSelectedChildren.has(node) ? '\n' : undefined,
        )
      : '';
  }

  private onInlineKeyDown = (event: CustomEvent<InlineKeyDown>) => {
    const { inline, node: projectedNode, keyboardEvent } = event.detail;
    const node = projectedNode as unknown as CanonicalNode;
    const document = this.document;
    const writer = this.writer;
    if (!(node instanceof CanonicalNode) || !document || !writer) return;
    const key = keyboardEvent.key;
    const control = keyboardEvent.ctrlKey || keyboardEvent.metaKey;
    if (control && (key.toLowerCase() === 'z' || key.toLowerCase() === 'y')) {
      keyboardEvent.preventDefault();
      this.sealTypingGroup();
      const result =
        key.toLowerCase() === 'z' ? writer.undo(this.sessionId) : writer.redo(this.sessionId);
      this.restoreHistoryFocus(result);
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
      this.sealTypingGroup();
      this.moveAcrossBlocks(inline, node, keyboardEvent);
      return;
    }
    if (key === 'Backspace' || key === 'Delete') {
      const selected = this.currentBlockSelection();
      if (selected.length) {
        keyboardEvent.preventDefault();
        this.replaceBlocks(selected, '');
        return;
      }
    }
    if (key === 'Tab') {
      keyboardEvent.preventDefault();
      const selected = this.currentBlockSelection();
      const context = this.hostContext;
      this.runDraft((draft) => {
        const actionFocus = editIndent(
          draft,
          document.root.sharedId,
          node.sharedId,
          keyboardEvent.shiftKey ? 'unindent' : 'indent',
          selected.map((item) => item.sharedId),
        );
        if (!actionFocus || !selected.length) return actionFocus;
        const first = selected[0]!;
        const last = selected.at(-1)!;
        const reverse =
          !!context?.selectionAnchor &&
          (context.selectionAnchor as unknown as CanonicalNode).sharedId === last.sharedId;
        const anchorNode = reverse ? last : first;
        const focusNode = reverse ? first : last;
        const anchor = draft.bookmark(
          anchorNode.sharedId,
          reverse ? (anchorNode.content ?? '').length : 0,
          reverse ? 'right' : 'left',
        );
        const focus = draft.bookmark(
          focusNode.sharedId,
          reverse ? 0 : (focusNode.content ?? '').length,
          reverse ? 'left' : 'right',
        );
        return {
          ...actionFocus,
          selection: { anchor, focus, restoreOnRedo: true },
        };
      }, selected.length > 0);
      return;
    }
    if (control && key.toLowerCase() === 'a') {
      keyboardEvent.preventDefault();
      const selected = this.currentBlockSelection();
      if (selected.length) {
        const all = this.visibleInlineNodes();
        this.setBlockSelection(all, all[0], all.at(-1));
      } else if (
        inline.getTextSelection()?.anchor === 0 &&
        inline.getTextSelection()?.focus === node.content?.length
      ) {
        this.setBlockSelection([node], node, node);
      } else {
        inline.setSelectionOffsets(0, node.content?.length ?? 0);
      }
      return;
    }
    if (key === 'Enter') this.sealTypingGroup();
    else if (key.length !== 1 || control || keyboardEvent.altKey) this.sealTypingGroup();
  };

  private moveAcrossBlocks(inline: MarkdownInline, node: CanonicalNode, event: KeyboardEvent) {
    const context = this.hostContext;
    const root = this.document?.root;
    if (!context || !root) return;
    event.preventDefault();
    const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? 'backward' : 'forward';
    const granularity = ['ArrowUp', 'ArrowDown'].includes(event.key)
      ? 'line'
      : event.ctrlKey || event.metaKey
        ? 'word'
        : 'character';
    const result = context.hasSelection
      ? 0
      : inline.moveCaret(event.shiftKey ? 'extend' : 'move', direction, granularity);
    if (result === true) {
      if (!event.shiftKey) context.clearSelection();
      this.captureSelection();
      return;
    }
    const visible = this.visibleInlineNodes();
    const index = visible.findIndex((candidate) => candidate.sharedId === node.sharedId);
    const next = visible[index + (direction === 'backward' ? -1 : 1)];
    if (!next) return;
    const offset = direction === 'backward' ? (next.content ?? '').length : 0;
    if (event.shiftKey) {
      context.extendSelection(
        node as unknown as import('../markdown/view-model-node.js').InlineViewModelNode,
        next as unknown as import('../markdown/view-model-node.js').InlineViewModelNode,
      );
    } else {
      context.clearSelection();
    }
    const anchor = createCanonicalTextAnchor(this.document!, {
      nodeId: next.sharedId,
      offset,
      affinity: direction === 'backward' ? 'left' : 'right',
    });
    void this.restoreAnchors(anchor, anchor, false, event.shiftKey);
  }

  private setBlockSelection(
    nodes: readonly CanonicalNode[],
    anchor?: CanonicalNode,
    focus?: CanonicalNode,
  ) {
    const context = this.hostContext;
    if (!context) return;
    context.clearSelection();
    for (const node of nodes) {
      context.selection.add(
        node as unknown as import('../markdown/view-model-node.js').InlineViewModelNode,
      );
      node.renderSignal.value++;
    }
    context.selectionAnchor = anchor as unknown as
      | import('../markdown/view-model-node.js').InlineViewModelNode
      | undefined;
    context.selectionFocus = focus as unknown as
      | import('../markdown/view-model-node.js').InlineViewModelNode
      | undefined;
  }

  private restoreHistoryFocus(result: HistoryResult) {
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
      void this.restoreAnchors(result.selectionAnchors.anchor, result.selectionAnchors.focus, true);
      return;
    }
    const anchor = result.focusAnchor;
    if (anchor) void this.restoreAnchors(anchor, anchor);
    else if (result.focus) void this.focusBookmark(result.focus);
    else void this.restoreSavedSelection();
  }

  private onCompositionStart = (event: CustomEvent<{ inline: MarkdownInline }>) => {
    const inline = event.detail.inline;
    const node = this.activeInline(inline);
    const selection = inline.getTextSelection();
    const document = this.document;
    if (!node || !selection || !document || inline.textContent !== node.content) return;
    const blockSelection = this.currentBlockSelection().map((item) => item.sharedId);
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
      ...(blockSelection.length ? { blockSelection } : {}),
      invalidate: () => this.invalidateComposition(session),
    };
    this.composition = session;
    inline.addEventListener('composition-invalidated', session.invalidate);
    this.sealTypingGroup();
  };

  private invalidateComposition(session: CompositionDraft) {
    if (this.composition !== session) return;
    this.composition = undefined;
    session.inline.removeEventListener('composition-invalidated', session.invalidate);
    session.inline.composing = false;
    if (session.inline.isConnected) void this.recoverInvalidatedComposition(session);
  }

  private async recoverInvalidatedComposition(session: CompositionDraft) {
    const document = this.document;
    if (!document) return;
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
    if (this.document !== document || sameInline) return;
    await this.restoreAnchors(session.selectionAnchor, session.selectionFocus);
    const target = this.findInline(focus.nodeId);
    target?.replayRecoveryEvents();
  }

  private onCompositionEnd = (
    event: CustomEvent<{ inline: MarkdownInline; event: CompositionEvent }>,
  ) => {
    const session = this.composition;
    this.composition = undefined;
    const inline = event.detail.inline;
    const data = event.detail.event.data;
    if (session) {
      session.inline.removeEventListener('composition-invalidated', session.invalidate);
      session.inline.composing = false;
    }
    if (!session || session.inline !== inline || !this.document || !this.writer) {
      if (inline.isConnected)
        void inline.recoverComposition(inline.getTextSelection() ?? { anchor: 0, focus: 0 });
      return;
    }
    const nativeText = inline.textContent ?? '';
    let from: number;
    let to: number;
    let insert: string;
    if (session.blockSelection?.length) {
      const selected = session.blockSelection
        .map((id) => this.document!.node(id))
        .filter((node) => node.connected);
      if (!selected.length || selected.length !== session.blockSelection.length) {
        void inline.recoverComposition(session.selection);
        return;
      }
      void inline.recoverComposition(session.selection, false).then(() => {
        this.replaceBlocks(selected, data ?? '');
        void this.replayCompositionInputs(session.node.sharedId);
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
      )
        prefix++;
      let suffix = 0;
      while (
        suffix < session.content.length - prefix &&
        suffix < nativeText.length - prefix &&
        session.content[session.content.length - 1 - suffix] ===
          nativeText[nativeText.length - 1 - suffix]
      )
        suffix++;
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
      this.runTextInput(session.node, from, to, insert, true);
      this.findInline(session.node.sharedId)?.replayRecoveryEvents();
    });
  };

  private findInline(nodeId: NodeId) {
    return [
      ...(this.renderer?.shadowRoot?.querySelectorAll<MarkdownInline>('md-inline') ?? []),
    ].find(
      (candidate) => (candidate.node as unknown as CanonicalNode | undefined)?.sharedId === nodeId,
    );
  }

  private async replayCompositionInputs(nodeId: NodeId) {
    const renderer = this.renderer;
    if (!renderer) return;
    await this.updateComplete;
    await renderer.updateComplete;
    const recovered = this.findInline(nodeId);
    const target = renderer.getInlineSelection().inline;
    if (recovered && target && recovered !== target) {
      target.holdRecoveryEventsFrom(recovered.takeRecoveryEvents());
    }
    target?.replayRecoveryEvents();
    recovered?.replayRecoveryEvents();
  }

  private onClipboard = (event: ClipboardEvent) => {
    const selection = this.currentBlockSelection();
    if (!selection.length || !event.clipboardData) return;
    event.preventDefault();
    const markdown = this.serializeBlockSelection(selection);
    event.clipboardData.setData('text/plain', markdown);
    try {
      event.clipboardData.setData('text/markdown', markdown);
    } catch {
      // Plain text is sufficient when the browser rejects custom clipboard data.
    }
    if (event.type === 'cut') this.replaceBlocks(selection, '');
  };

  private onPaste = (event: ClipboardEvent) => {
    const inline = event.composedPath().find((target) => target instanceof MarkdownInline);
    if (!(inline instanceof MarkdownInline)) return;
    const node = this.activeInline(inline);
    if (!node || !event.clipboardData) return;
    const markdown = event.clipboardData.getData('text/markdown');
    if (markdown) {
      event.preventDefault();
      this.runDraft((draft) =>
        insertMarkdownBlocks(draft, this.document!.root.sharedId, node.sharedId, markdown),
      );
      this.hostContext?.clearSelection();
      return;
    }
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    const selection = this.currentBlockSelection();
    if (selection.length) {
      this.replaceBlocks(selection, text);
      return;
    }
    const native = inline.getTextSelection();
    if (native)
      this.runTextInput(
        node,
        Math.min(native.anchor, native.focus),
        Math.max(native.anchor, native.focus),
        text.replace(/\n/g, ' '),
        true,
      );
  };
}

function previousCodePoint(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const low = text.charCodeAt(offset - 1);
  if (low >= 0xdc00 && low <= 0xdfff && offset > 1) {
    const high = text.charCodeAt(offset - 2);
    if (high >= 0xd800 && high <= 0xdbff) return offset - 2;
  }
  return offset - 1;
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

declare global {
  interface HTMLElementTagNameMap {
    'md-canonical-editor': CanonicalEditor;
  }
}
