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
import {
  asInlineMarkdownNodeView,
  type InlineMarkdownNodeView,
  type ReadonlyMarkdownNodeView,
} from '../../markdown/node-view.js';
import type { EditSelection } from '../../markdown/semantic/selection.js';
import type { NodeId } from '../../markdown/semantic/types.js';
import { BrowserSessionRunner } from './session-runner.js';
import { getContainingTransclusion, getRenderedTransclusion } from '../../markdown/transclusion.js';

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
    return this.visibleInlineNodeViews(root).filter(
      (node) => node instanceof CanonicalNodeProjection,
    ) as CanonicalNode[];
  }

  visibleInlineNodeViews(root?: ReadonlyMarkdownNodeView): InlineMarkdownNodeView[] {
    if (!root) return [];
    const result: InlineMarkdownNodeView[] = [];
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (
        (node.type === 'paragraph' || node.type === 'section' || node.type === 'code-block') &&
        typeof node.content === 'string'
      ) {
        result.push(asInlineMarkdownNodeView(node));
      }
      pending.push(...[...(node.children ?? [])].reverse());
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

  expandBlockSelection(
    selected: readonly CanonicalNode[],
    context = this.host.renderer()?.hostContext,
  ): CanonicalNode[] {
    if (!context || !selected.length) return [...selected];
    const root =
      context.root instanceof CanonicalNodeProjection
        ? (context.root as CanonicalNode)
        : this.host.document()?.root;
    if (!root) return [...selected];

    const selectedIds = new Set(selected.map((node) => node.sharedId));
    const visited = new Set<NodeId>();
    const additions = new Set<NodeId>();
    let seeds = [
      ...new Set(
        selected.map((node) =>
          node.type === 'section' && node.children.length ? node.children[0]! : node,
        ),
      ),
    ];

    while (!additions.size && seeds.length) {
      const next: CanonicalNode[] = [];
      for (const node of seeds) {
        const parent = node.parent;
        if (!parent || parent.sharedId === root.parent?.sharedId) continue;
        if (visited.has(parent.sharedId)) continue;
        visited.add(parent.sharedId);
        next.push(parent);
        for (const candidate of this.visibleInlineNodes(parent)) {
          if (!selectedIds.has(candidate.sharedId)) additions.add(candidate.sharedId);
        }
      }
      seeds = next;
    }

    return this.visibleInlineNodes(root).filter(
      (node) => selectedIds.has(node.sharedId) || additions.has(node.sharedId),
    );
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

  async restoreSavedSelection(
    hostContext?: HostContext,
    shouldRestoreFocus?: () => boolean,
  ): Promise<void> {
    const anchor = this.anchor;
    const focus = this.focus ?? anchor;
    if (!anchor || !focus) return;
    await this.restoreAnchors(anchor, focus, false, false, hostContext, false, shouldRestoreFocus);
  }

  async restoreAnchors(
    anchor: CanonicalTextAnchor,
    focus: CanonicalTextAnchor,
    restoreAsBlockSelection = false,
    preserveBlockSelection = false,
    hostContext?: HostContext,
    restoreNativeTextSelection = false,
    shouldRestoreFocus?: () => boolean,
  ): Promise<void> {
    const document = this.host.document();
    const rootRenderer = this.host.renderer();
    const renderer = hostContext
      ? (this.rendererForContext(hostContext) ?? rootRenderer)
      : rootRenderer;
    const generation = this.session.generation;
    if (
      !document ||
      !renderer ||
      !this.host.isConnected() ||
      (shouldRestoreFocus && !shouldRestoreFocus())
    )
      return;
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
    const targetInlineBeforeUpdate = [
      ...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
    ].some((inline) => inline.nodeView === target);
    const deferFocusForRenderDelegate =
      target.type === 'code-block' &&
      !!context.renderDelegate?.renderCodeBlock &&
      !targetInlineBeforeUpdate;
    if (!deferFocusForRenderDelegate) {
      if (!shouldRestoreFocus) {
        context.focusNode = asInlineMarkdownNodeView(target);
        context.focusOffset = end.offset;
      }
      this.restoring = true;
      this.host.requestUpdate();
      try {
        await this.host.updateComplete();
        if (shouldRestoreFocus && !shouldRestoreFocus()) return;
        await renderer.updateComplete;
        if (
          !this.host.isConnected() ||
          !this.session.isCurrentGeneration(generation) ||
          (shouldRestoreFocus && !shouldRestoreFocus())
        )
          return;
        const inline = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].find(
          (candidate) => candidate.nodeView === target,
        );
        if (!inline || !inline.isConnected) return;
        await inline.updateComplete;
        if (
          !this.session.isCurrentGeneration(generation) ||
          (shouldRestoreFocus && !shouldRestoreFocus())
        )
          return;
        if (shouldRestoreFocus) {
          context.focusNode = asInlineMarkdownNodeView(target);
          context.focusOffset = end.offset;
        }
        inline.focus();
        if (restoreNativeTextSelection && !shouldRestoreFocus) await inline.maybeSetFocus();
        if (!this.session.isCurrentGeneration(generation)) return;
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
        if (shouldRestoreFocus) this.clearFocusHintSoon(context, target);
      } finally {
        this.restoring = false;
      }
      return;
    }
    context.focusNode = undefined;
    context.focusOffset = undefined;
    this.restoring = true;
    this.host.requestUpdate();
    try {
      await this.host.updateComplete();
      if (shouldRestoreFocus && !shouldRestoreFocus()) return;
      await renderer.updateComplete;
      if (
        !this.host.isConnected() ||
        !this.session.isCurrentGeneration(generation) ||
        (shouldRestoreFocus && !shouldRestoreFocus())
      )
        return;
      const visible = this.visibleInlineNodeViews(context.root);
      const renderedInlines = [
        ...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
      ].filter((candidate) => candidate.isConnected && candidate.nodeView);
      const inlineFor = (node: InlineMarkdownNodeView) =>
        renderedInlines.find((candidate) => candidate.nodeView === node);
      const isTarget = (node: InlineMarkdownNodeView) =>
        node instanceof CanonicalNodeProjection && node.sharedId === target.sharedId;
      let focusNode = target;
      let focusOffset = end.offset;
      let inline = inlineFor(asInlineMarkdownNodeView(focusNode));
      let focusParentHostNeighbor = false;
      if (!inline) {
        focusParentHostNeighbor = true;
        const endpoint = [start, end].find((bookmark) => {
          if (bookmark.nodeId === target.sharedId) return false;
          return inlineFor(asInlineMarkdownNodeView(document.node(bookmark.nodeId)));
        });
        if (endpoint) {
          focusNode = document.node(endpoint.nodeId);
          focusOffset = endpoint.offset;
        } else {
          const targetIndex = visible.findIndex(isTarget);
          const fallback = visible
            .map((node, index) => ({ node, index, inline: inlineFor(node) }))
            .filter(
              (candidate) =>
                candidate.inline &&
                candidate.node instanceof CanonicalNodeProjection &&
                candidate.node.sharedId !== target.sharedId,
            )
            .sort(
              (left, right) =>
                Math.abs(left.index - targetIndex) - Math.abs(right.index - targetIndex),
            )[0];
          if (!fallback?.inline || !(fallback.node instanceof CanonicalNodeProjection)) return;
          focusNode = fallback.node;
          focusOffset = fallback.index < targetIndex ? (focusNode.content ?? '').length : 0;
        }
        inline = inlineFor(asInlineMarkdownNodeView(focusNode));
      }
      if (!inline || !inline.isConnected) return;
      if (!shouldRestoreFocus) {
        context.focusNode = asInlineMarkdownNodeView(focusNode);
        context.focusOffset = focusOffset;
      }
      inline.requestUpdate();
      await inline.updateComplete;
      if (
        !this.session.isCurrentGeneration(generation) ||
        (shouldRestoreFocus && !shouldRestoreFocus())
      )
        return;
      if (shouldRestoreFocus) {
        context.focusNode = asInlineMarkdownNodeView(focusNode);
        context.focusOffset = focusOffset;
      }
      inline.focus();
      if (restoreNativeTextSelection && !shouldRestoreFocus) await inline.maybeSetFocus();
      if (!this.session.isCurrentGeneration(generation)) return;
      inline.setSelectionOffsets(
        focusParentHostNeighbor ? focusOffset : start.offset,
        focusParentHostNeighbor ? focusOffset : end.offset,
      );
      this.lastNativeSelection = {
        nodeId: focusNode.sharedId,
        anchor: focusParentHostNeighbor ? focusOffset : start.offset,
        focus: focusParentHostNeighbor ? focusOffset : end.offset,
      };
      const expectedOffset = focusParentHostNeighbor ? focusOffset : end.offset;
      if (this.expectedInputSelection?.nodeId === focusNode.sharedId) {
        this.expectedInputSelection = { nodeId: focusNode.sharedId, offset: expectedOffset };
      }
      this.anchor = createCanonicalTextAnchor(document, start);
      this.focus = createCanonicalTextAnchor(document, end);
      if (shouldRestoreFocus) this.clearFocusHintSoon(context, focusNode);
    } finally {
      this.restoring = false;
    }
  }

  async focusBookmark(
    bookmark: Bookmark | undefined,
    hostContext?: HostContext,
    shouldRestoreFocus?: () => boolean,
  ): Promise<void> {
    const document = this.host.document();
    if (!document || !bookmark) return;
    try {
      const anchor = createCanonicalTextAnchor(document, bookmark);
      await this.restoreAnchors(
        anchor,
        anchor,
        false,
        false,
        hostContext,
        false,
        shouldRestoreFocus,
      );
    } catch {
      await this.restoreSavedSelection(hostContext, shouldRestoreFocus);
    }
  }

  private clearFocusHintSoon(context: HostContext, node: CanonicalNode): void {
    window.setTimeout(() => {
      if (context.focusNode !== node) return;
      context.focusNode = undefined;
      context.focusOffset = undefined;
    }, 0);
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

  textSelectionStartBefore(
    nodeId: NodeId,
    inline: MarkdownInline,
    fallbackAnchor: number,
    fallbackFocus: number,
  ): EditSelection {
    const native = inline.getTextSelection();
    const offset = Math.min(native?.anchor ?? fallbackAnchor, native?.focus ?? fallbackFocus);
    return {
      anchor: { nodeId, offset, affinity: 'left' },
      focus: { nodeId, offset, affinity: 'right' },
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

  async moveAcrossBlocks(
    inline: MarkdownInline,
    node: InlineMarkdownNodeView,
    event: KeyboardEvent,
  ): Promise<void> {
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
    const originalSelection = inline.getTextSelection();
    const visualX =
      !event.shiftKey &&
      !context.hasSelection &&
      granularity === 'line' &&
      originalSelection &&
      originalSelection.anchor === originalSelection.focus
        ? inline.getCaretPosition().x
        : undefined;
    const result = context.hasSelection
      ? 0
      : inline.moveCaret(event.shiftKey ? 'extend' : 'move', direction, granularity);
    if (result === true) {
      if (!event.shiftKey) context.clearSelection();
      if (node instanceof CanonicalNodeProjection) this.captureSelection();
      return;
    }
    const rootRenderer = this.rendererForContext(context) ?? this.host.renderer();
    const visible = this.visibleInlineNodeViews(context.root);
    const selectedFocus = context.hasSelection ? context.selectionFocus : undefined;
    const origin = selectedFocus && visible.includes(selectedFocus) ? selectedFocus : node;
    const index = visible.indexOf(origin);
    if (index < 0 || !rootRenderer?.shadowRoot) {
      if (originalSelection)
        inline.setSelectionOffsets(originalSelection.anchor, originalSelection.focus);
      return;
    }

    const moved = await this.moveToSibling(
      rootRenderer,
      context,
      visible,
      index,
      direction,
      origin,
      event,
      visualX,
    );
    if (moved) return;
    if (event.shiftKey) {
      if (originalSelection)
        inline.setSelectionOffsets(originalSelection.anchor, originalSelection.focus);
      return;
    }

    context.clearSelection();
    await this.moveOutOfTransclusion(inline, context, direction, event, visualX);
  }

  private async moveToSibling(
    renderer: MarkdownRenderer,
    context: HostContext,
    visible: readonly InlineMarkdownNodeView[],
    index: number,
    direction: 'backward' | 'forward',
    origin: InlineMarkdownNodeView,
    event: KeyboardEvent,
    visualX?: number,
  ): Promise<boolean> {
    const step = direction === 'backward' ? -1 : 1;
    for (
      let candidateIndex = index + step;
      candidateIndex >= 0 && candidateIndex < visible.length;
      candidateIndex += step
    ) {
      const candidate = visible[candidateIndex]!;
      const moved = await this.focusCandidate(
        renderer,
        context,
        candidate,
        direction,
        origin,
        event,
        visualX,
      );
      if (!moved) continue;

      return true;
    }
    return false;
  }

  private async focusCandidate(
    renderer: MarkdownRenderer,
    context: HostContext,
    candidate: InlineMarkdownNodeView,
    direction: 'backward' | 'forward',
    origin: InlineMarkdownNodeView,
    event: KeyboardEvent,
    visualX?: number,
  ): Promise<boolean> {
    const transclusion = getRenderedTransclusion(renderer.shadowRoot!, candidate);
    if (transclusion) {
      if (event.shiftKey) {
        const from = asInlineMarkdownNodeView(origin);
        const to = asInlineMarkdownNodeView(candidate);
        if (context.selectionAnchor && context.selectionFocus) context.extendSelection(from, to);
        else context.setSelection(from, to);
        return true;
      }
      const moved = await transclusion.focusEdge(direction, visualX);
      if (moved) context.clearSelection();
      return moved;
    }

    const targetInline = [
      ...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
    ].find((element) => element.nodeView === candidate);
    if (!targetInline) return false;
    const offset = direction === 'backward' ? candidate.content.length : 0;
    let anchor: CanonicalTextAnchor | undefined;

    if (candidate instanceof CanonicalNodeProjection) {
      const document = this.host.document();
      if (!document || !candidate.connected) return false;
      try {
        anchor = createCanonicalTextAnchor(document, {
          nodeId: candidate.sharedId,
          offset,
          affinity: direction === 'backward' ? 'left' : 'right',
        });
      } catch {
        return false;
      }
    }

    if (event.shiftKey) {
      const from = asInlineMarkdownNodeView(origin);
      const to = asInlineMarkdownNodeView(candidate);
      if (context.selectionAnchor && context.selectionFocus) context.extendSelection(from, to);
      else context.setSelection(from, to);
    } else {
      context.clearSelection();
    }

    if (anchor) {
      await this.restoreAnchors(anchor, anchor, false, event.shiftKey, context);
      if (visualX !== undefined) {
        const focusedInline = [
          ...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
        ].find((element) => element.nodeView === candidate);
        if (focusedInline?.setCaretAtVisualX(visualX, direction)) this.captureSelection();
      }
      return true;
    }

    await targetInline.updateComplete;
    targetInline.focus();
    targetInline.setSelectionOffsets(offset, offset);
    if (visualX !== undefined) targetInline.setCaretAtVisualX(visualX, direction);
    return true;
  }

  private async moveOutOfTransclusion(
    inline: MarkdownInline,
    context: HostContext,
    direction: 'backward' | 'forward',
    event: KeyboardEvent,
    visualX?: number,
  ): Promise<void> {
    if (event.shiftKey) return;
    let boundary: Element = inline;
    let currentContext = context;
    while (true) {
      const transclusion = getContainingTransclusion(boundary);
      if (!transclusion) return;
      const parentContext = transclusion.hostContext;
      const parentRenderer =
        parentContext && (this.rendererForContext(parentContext) ?? this.host.renderer());
      const parentNode = transclusion.node;
      if (parentContext && parentRenderer?.shadowRoot && parentNode) {
        const visible = this.visibleInlineNodeViews(parentContext.root);
        const index = visible.indexOf(parentNode);
        if (index >= 0) {
          const moved = await this.moveToSibling(
            parentRenderer,
            parentContext,
            visible,
            index,
            direction,
            parentNode,
            event,
            visualX,
          );
          if (moved) {
            currentContext.clearSelection();
            return;
          }
        }
      }
      currentContext.clearSelection();
      currentContext = parentContext ?? currentContext;
      boundary = transclusion;
    }
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
