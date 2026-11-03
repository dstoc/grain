import type { CanonicalDocument } from '../../markdown/canonical/document.js';
import type { CanonicalNode } from '../../markdown/canonical/node-projection.js';
import type { Bookmark } from '../../markdown/canonical/action-types.js';
import { CanonicalNode as CanonicalNodeProjection } from '../../markdown/canonical/node-projection.js';
import {
  createCanonicalTextAnchor,
  resolveCanonicalTextAnchor,
} from '../../markdown/canonical-selection.js';
import type { CanonicalTextAnchor } from '../../markdown/canonical-selection.js';
import type { MarkdownInline } from '../../markdown/inline-render.js';
import type { MarkdownRenderer } from '../../markdown/block-render.js';
import type { HostContext } from '../../markdown/host-context.js';
import { asInlineMarkdownNodeView } from '../../markdown/node-view.js';
import type { EditSelection } from '../../markdown/semantic/selection.js';
import type { NodeId } from '../../markdown/semantic/types.js';
import { BrowserSessionRunner } from './session-runner.js';

interface NativeSelectionSnapshot {
  readonly nodeId: NodeId;
  readonly anchor: number;
  readonly focus: number;
}

interface BrowserSelectionHost {
  document(): CanonicalDocument | undefined;
  renderer(): MarkdownRenderer | undefined;
  isConnected(): boolean;
  requestUpdate(): void;
  updateComplete(): Promise<unknown>;
}

/** Owns selection capture, canonical anchors, recovery, and block selection. */
export class SelectionController {
  private anchor?: CanonicalTextAnchor;
  private focus?: CanonicalTextAnchor;
  private lastNativeSelection?: NativeSelectionSnapshot;
  private expectedInputSelection?: { readonly nodeId: NodeId; readonly offset: number };
  private restoring = false;
  private ownerDocument?: Document;
  private selectionChangeRoot?: ShadowRoot;

  constructor(
    private readonly host: BrowserSelectionHost,
    private readonly session: BrowserSessionRunner,
  ) {}

  get selectionAnchor(): CanonicalTextAnchor | undefined {
    return this.anchor;
  }

  get selectionFocus(): CanonicalTextAnchor | undefined {
    return this.focus;
  }

  connect(ownerDocument: Document): void {
    if (this.ownerDocument === ownerDocument) return;
    this.disconnect();
    this.ownerDocument = ownerDocument;
    ownerDocument.addEventListener('selectionchange', this.onSelectionChange);
  }

  disconnect(): void {
    this.ownerDocument?.removeEventListener('selectionchange', this.onSelectionChange);
    this.ownerDocument = undefined;
    this.selectionChangeRoot?.removeEventListener('selectionchange', this.onSelectionChange);
    this.selectionChangeRoot = undefined;
    this.expectedInputSelection = undefined;
  }

  resetDocument(): void {
    this.anchor = undefined;
    this.focus = undefined;
    this.lastNativeSelection = undefined;
    this.expectedInputSelection = undefined;
  }

  expectInputSelection(nodeId: NodeId, offset: number): void {
    this.expectedInputSelection = { nodeId, offset };
  }

  visibleInlineNodes(root = this.host.document()?.root): CanonicalNode[] {
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

  currentBlockSelection(context = this.host.renderer()?.hostContext): CanonicalNode[] {
    const selection = context?.selection ?? [];
    const selected = new Set<NodeId>();
    for (const node of selection) {
      if (node instanceof CanonicalNodeProjection) selected.add(node.sharedId);
    }
    const root =
      context?.root instanceof CanonicalNodeProjection
        ? (context.root as CanonicalNode)
        : undefined;
    return this.visibleInlineNodes(root).filter((node) => selected.has(node.sharedId));
  }

  captureSelection(sealChangedGroup = false): void {
    if (this.restoring || !this.host.document()) return;
    const { inline } = this.host.renderer()?.getInlineSelection() ?? {};
    const node = inline?.nodeView;
    const canonicalNode =
      node instanceof CanonicalNodeProjection ? (node as CanonicalNode) : undefined;
    const selection = inline?.getTextSelection();
    const document = this.host.document();
    if (!document || !inline || !canonicalNode || !selection || !canonicalNode.connected) {
      return;
    }
    const snapshot = {
      nodeId: canonicalNode.sharedId,
      anchor: selection.anchor,
      focus: selection.focus,
    };
    const previous = this.lastNativeSelection;
    if (
      sealChangedGroup &&
      this.session.hasTypingGroup &&
      previous &&
      (previous.nodeId !== snapshot.nodeId ||
        previous.anchor !== snapshot.anchor ||
        previous.focus !== snapshot.focus)
    ) {
      this.session.sealTypingGroup();
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
      this.anchor = createCanonicalTextAnchor(document, {
        nodeId: canonicalNode.sharedId,
        offset: selection.anchor,
        affinity: selection.anchor <= selection.focus ? 'left' : 'right',
      });
      this.focus = createCanonicalTextAnchor(document, {
        nodeId: canonicalNode.sharedId,
        offset: selection.focus,
        affinity: selection.focus >= selection.anchor ? 'right' : 'left',
      });
    } catch {
      // A native selection can briefly point into a render recovery projection.
    }
  }

  async restoreSavedSelection(hostContext?: HostContext): Promise<void> {
    const anchor = this.anchor;
    const focus = this.focus ?? anchor;
    if (!anchor || !focus) return;
    await this.restoreAnchors(anchor, focus, false, false, hostContext);
  }

  async restoreAnchors(
    anchor: CanonicalTextAnchor,
    focus: CanonicalTextAnchor,
    restoreAsBlockSelection = false,
    preserveBlockSelection = false,
    hostContext?: HostContext,
  ): Promise<void> {
    const document = this.host.document();
    const rootRenderer = this.host.renderer();
    const renderer = hostContext
      ? (this.rendererForContext(hostContext) ?? rootRenderer)
      : rootRenderer;
    const generation = this.session.generation;
    if (!document || !renderer || !this.host.isConnected()) return;
    if (!this.session.isCurrentGeneration(generation)) return;
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
    const context = hostContext ?? renderer.hostContext;
    if (!preserveBlockSelection && (start.nodeId !== end.nodeId || restoreAsBlockSelection)) {
      const visibleRoot =
        context.root instanceof CanonicalNodeProjection ? context.root : undefined;
      const visible = this.visibleInlineNodes(visibleRoot);
      const startIndex = visible.findIndex((node) => node.sharedId === start.nodeId);
      const endIndex = visible.findIndex((node) => node.sharedId === end.nodeId);
      if (startIndex >= 0 && endIndex >= 0) {
        const low = Math.min(startIndex, endIndex);
        const high = Math.max(startIndex, endIndex);
        const ordered = visible.slice(low, high + 1);
        this.setBlockSelection(
          ordered,
          document.node(start.nodeId),
          document.node(end.nodeId),
          context,
        );
      }
    } else if (!preserveBlockSelection) {
      context.clearSelection();
    }
    context.focusNode = asInlineMarkdownNodeView(target);
    context.focusOffset = end.offset;
    this.restoring = true;
    this.host.requestUpdate();
    try {
      await this.host.updateComplete();
      await renderer.updateComplete;
      if (!this.host.isConnected() || !this.session.isCurrentGeneration(generation)) return;
      const inline = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].find(
        (candidate) => candidate.nodeView === target,
      );
      if (!inline || !inline.isConnected) return;
      await inline.updateComplete;
      if (!this.session.isCurrentGeneration(generation)) return;
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
      this.anchor = createCanonicalTextAnchor(document, start);
      this.focus = createCanonicalTextAnchor(document, end);
    } finally {
      this.restoring = false;
    }
  }

  async focusBookmark(bookmark: Bookmark | undefined, hostContext?: HostContext): Promise<void> {
    const document = this.host.document();
    if (!document || !bookmark) return;
    try {
      const anchor = createCanonicalTextAnchor(document, bookmark);
      await this.restoreAnchors(anchor, anchor, false, false, hostContext);
    } catch {
      await this.restoreSavedSelection(hostContext);
    }
  }

  textSelectionBefore(
    nodeId: NodeId,
    inline: MarkdownInline,
    fallbackAnchor: number,
    fallbackFocus: number,
  ): EditSelection {
    const native = inline.getTextSelection();
    const anchor = native?.anchor ?? fallbackAnchor;
    const focus = native?.focus ?? fallbackFocus;
    return {
      anchor: {
        nodeId,
        offset: anchor,
        affinity: anchor <= focus ? 'left' : 'right',
      },
      focus: {
        nodeId,
        offset: focus,
        affinity: focus >= anchor ? 'right' : 'left',
      },
    };
  }

  blockSelectionBefore(
    selection: readonly CanonicalNode[],
    hostContext = this.host.renderer()?.hostContext,
  ): EditSelection | undefined {
    if (!selection.length) return undefined;
    const first = selection[0]!;
    const last = selection.at(-1)!;
    const reverse =
      hostContext?.selectionAnchor instanceof CanonicalNodeProjection &&
      hostContext.selectionAnchor.sharedId === last.sharedId;
    const anchorNode = reverse ? last : first;
    const focusNode = reverse ? first : last;
    return {
      nodeIds: selection.map((node) => node.sharedId),
      anchor: {
        nodeId: anchorNode.sharedId,
        offset: reverse ? (anchorNode.content ?? '').length : 0,
        affinity: reverse ? 'right' : 'left',
      },
      focus: {
        nodeId: focusNode.sharedId,
        offset: reverse ? 0 : (focusNode.content ?? '').length,
        affinity: reverse ? 'left' : 'right',
      },
    };
  }

  moveAcrossBlocks(inline: MarkdownInline, node: CanonicalNode, event: KeyboardEvent): void {
    const context = inline.hostContext ?? this.host.renderer()?.hostContext;
    const document = this.host.document();
    if (!context || !document?.root) return;
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
    const root =
      context.root instanceof CanonicalNodeProjection ? (context.root as CanonicalNode) : undefined;
    const visible = this.visibleInlineNodes(root);
    const index = visible.findIndex((candidate) => candidate.sharedId === node.sharedId);
    const next = visible[index + (direction === 'backward' ? -1 : 1)];
    if (!next) return;
    const offset = direction === 'backward' ? (next.content ?? '').length : 0;
    if (event.shiftKey) {
      const from = asInlineMarkdownNodeView(node);
      const to = asInlineMarkdownNodeView(next);
      if (context.selectionAnchor && context.selectionFocus) {
        context.extendSelection(from, to);
      } else {
        context.setSelection(from, to);
      }
    } else {
      context.clearSelection();
    }
    const anchor = createCanonicalTextAnchor(document, {
      nodeId: next.sharedId,
      offset,
      affinity: direction === 'backward' ? 'left' : 'right',
    });
    void this.restoreAnchors(anchor, anchor, false, event.shiftKey, context);
  }

  setBlockSelection(
    nodes: readonly CanonicalNode[],
    anchor?: CanonicalNode,
    focus?: CanonicalNode,
    context = this.host.renderer()?.hostContext,
  ): void {
    if (!context) return;
    context.clearSelection();
    for (const node of nodes) {
      context.selection.add(asInlineMarkdownNodeView(node));
      node.renderSignal.value++;
    }
    context.selectionAnchor = anchor ? asInlineMarkdownNodeView(anchor) : undefined;
    context.selectionFocus = focus ? asInlineMarkdownNodeView(focus) : undefined;
  }

  private rendererForContext(context: HostContext): MarkdownRenderer | undefined {
    const root = this.host.renderer()?.shadowRoot;
    if (!root) return;
    const pending: Node[] = [...root.childNodes].reverse();
    while (pending.length) {
      const current = pending.pop()!;
      if (
        current instanceof HTMLElement &&
        current.localName === 'md-block-render' &&
        (current as MarkdownRenderer).hostContext === context
      ) {
        return current as MarkdownRenderer;
      }
      if (current instanceof Element && current.shadowRoot) {
        pending.push(...[...current.shadowRoot.childNodes].reverse());
      }
      pending.push(...[...current.childNodes].reverse());
    }
  }

  private onSelectionChange = (): void => {
    const { inline } = this.host.renderer()?.getInlineSelection() ?? {};
    const node = inline?.nodeView;
    const canonicalNode =
      node instanceof CanonicalNodeProjection ? (node as CanonicalNode) : undefined;
    const selection = inline?.getTextSelection();
    const expected = this.expectedInputSelection;
    if (
      canonicalNode &&
      selection &&
      expected?.nodeId === canonicalNode.sharedId &&
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
}
