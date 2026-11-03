import { consume } from '@lit/context';
import { html, LitElement, type TemplateResult } from 'lit';
import { customElement, property, query, queryAll } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { keyed } from 'lit/directives/keyed.js';

import { noAwait } from '../async.js';
import { cast } from '../asserts.js';
import { NodeSignalController } from './node-signal-controller.js';
import { HostContext, hostContext } from './host-context.js';
import type { InlineTreeNode } from './inline-parser.js';
import { type InlineMarkdownNodeView, type ReadonlyMarkdownNodeView } from './node-view.js';

export interface InlineInputPoint {
  span?: MarkdownSpan;
  index: number;
}

export interface InlineInput {
  inline: MarkdownInline;
  node: ReadonlyMarkdownNodeView;
  content: string;
  inputEvent: InputEvent;
  inputStart: InlineInputPoint;
  inputEnd: InlineInputPoint;
}

export interface InlineKeyDown {
  inline: MarkdownInline;
  node: ReadonlyMarkdownNodeView;
  keyboardEvent: KeyboardEvent;
}

export interface InlineLinkClick {
  type: string;
  destination: string;
}

export interface InlineProjectionSelection {
  anchor: number;
  focus: number;
}

export interface InlineProjectionRecovery {
  inline: MarkdownInline;
  selection: InlineProjectionSelection;
  replayEvents: boolean;
  complete: (recoveredInline?: MarkdownInline) => void;
}

declare global {
  interface HTMLElementEventMap {
    'inline-input': CustomEvent<InlineInput>;
    'inline-keydown': CustomEvent<InlineKeyDown>;
    'inline-link-click': CustomEvent<InlineLinkClick>;
  }
}

@customElement('md-inline')
export class MarkdownInline extends LitElement {
  constructor() {
    super();
    this.addEventListener('beforeinput', this.onBeforeInput, { capture: true });
    this.addEventListener('keydown', this.onKeyDown, { capture: true });
    this.addEventListener('pointerdown', this.onPointerDown);
    this.addEventListener('compositionstart', this.onCompositionStart);
    this.addEventListener('compositionend', this.onCompositionEnd);
    this.setAttribute('contenteditable', '');
  }

  @consume({ context: hostContext, subscribe: true })
  @property({ attribute: false })
  accessor hostContext: HostContext | undefined;

  @property({ type: Boolean, reflect: true }) accessor selected: boolean | undefined;

  @query('md-span') accessor span!: MarkdownSpan;

  @property({ attribute: false }) accessor nodeView: InlineMarkdownNodeView | undefined;

  private nodeSignal = new NodeSignalController(this, () => this.nodeView);
  private projectionVersion = 0;
  private recovery?: Promise<MarkdownInline | undefined>;
  private recoveringProjection = false;
  private pendingRecoveryEvents: Array<KeyboardEvent | InputEvent> = [];
  private holdRecoveryInputs = false;
  composing = false;

  get mobileToolbarInputReady() {
    return (
      this.isConnected &&
      !!this.nodeView?.connected &&
      !this.composing &&
      !this.recoveringProjection &&
      !this.recovery &&
      !this.holdRecoveryInputs
    );
  }

  private nativeSelection() {
    const root = this.getRootNode() as (Document | ShadowRoot) & {
      getSelection?: () => Selection | null;
    };
    return typeof root.getSelection === 'function' ? root.getSelection() : document.getSelection();
  }

  reconcileComposition(offset?: number) {
    this.projectionVersion++;
    if (offset !== undefined && this.nodeView && this.hostContext) {
      this.hostContext.focusNode = this.nodeView;
      this.hostContext.focusOffset = offset;
    }
    this.requestUpdate();
  }

  recoverComposition(
    selection: InlineProjectionSelection,
    replayEvents = true,
  ): Promise<MarkdownInline | undefined> {
    if (this.recovery) return this.recovery;
    this.recoveringProjection = true;
    this.recovery = new Promise<MarkdownInline | undefined>((resolve) => {
      const event = new CustomEvent<InlineProjectionRecovery>('inline-projection-recovery', {
        detail: { inline: this, selection, replayEvents, complete: resolve },
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      this.dispatchEvent(event);
      if (event.defaultPrevented) return;
      this.projectionVersion++;
      this.requestUpdate();
      void this.updateComplete.then(async () => {
        await this.maybeSetFocus();
        this.focus();
        this.setSelectionOffsets(selection.anchor, selection.focus);
        if (replayEvents) this.replayRecoveryEvents();
        else this.holdRecoveryInputs = true;
        resolve(this);
      });
    }).finally(() => {
      this.recovery = undefined;
      this.recoveringProjection = false;
    });
    return this.recovery!;
  }

  getTextSelection(): InlineProjectionSelection | undefined {
    const selection = this.nativeSelection();
    if (!selection?.anchorNode || !selection.focusNode) return;
    const anchor = this.textOffset(selection.anchorNode, selection.anchorOffset);
    const focus = this.textOffset(selection.focusNode, selection.focusOffset);
    if (anchor === undefined || focus === undefined) return;
    return { anchor, focus };
  }

  textOffset(container: Node, offset: number): number | undefined {
    if (container !== this && !this.contains(container)) return;
    try {
      const range = document.createRange();
      range.selectNodeContents(this);
      range.setEnd(container, offset);
      return range.toString().length;
    } catch {
      return;
    }
  }

  setSelectionOffsets(anchorOffset: number, focusOffset: number) {
    const pointAt = (requestedOffset: number): [Node, number] => {
      let remaining = Math.max(0, Math.min(this.textContent?.length ?? 0, requestedOffset));
      const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
      let next: Node | null;
      let last: Text | undefined;
      while ((next = walker.nextNode())) {
        const text = next as Text;
        last = text;
        if (remaining <= text.length) return [text, remaining];
        remaining -= text.length;
      }
      return last ? [last, last.length] : [this, 0];
    };
    const [anchor, anchorNodeOffset] = pointAt(anchorOffset);
    const [focus, focusNodeOffset] = pointAt(focusOffset);
    this.nativeSelection()!.setBaseAndExtent(anchor, anchorNodeOffset, focus, focusNodeOffset);
  }

  queueRecoveryInput(event: InputEvent) {
    this.pendingRecoveryEvents.push(event);
  }

  queueRecoveryKeydown(event: KeyboardEvent) {
    this.pendingRecoveryEvents.push(event);
  }

  holdRecoveryEventsFrom(events: Array<KeyboardEvent | InputEvent>) {
    this.holdRecoveryInputs = true;
    this.pendingRecoveryEvents.push(...events);
  }

  takeRecoveryEvents() {
    return this.pendingRecoveryEvents.splice(0);
  }

  replayRecoveryEvents(pending = this.takeRecoveryEvents()) {
    this.holdRecoveryInputs = false;
    for (const event of pending) this.dispatchEvent(event);
  }

  discardRecoveryEvents() {
    this.pendingRecoveryEvents.length = 0;
    this.holdRecoveryInputs = false;
  }

  private onCompositionStart = (event: CompositionEvent) => {
    this.composing = true;
    this.dispatchEvent(
      new CustomEvent('inline-composition-start', {
        detail: { inline: this, event },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private onCompositionEnd = (event: CompositionEvent) => {
    this.dispatchEvent(
      new CustomEvent('inline-composition-end', {
        detail: { inline: this, event },
        bubbles: true,
        composed: true,
      }),
    );
    this.composing = false;
  };

  override disconnectedCallback() {
    if (this.composing) this.dispatchEvent(new Event('composition-invalidated'));
    this.composing = false;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (this.composing) this.dispatchEvent(new Event('composition-invalidated'));
  }

  override render() {
    const node = this.nodeView;
    if (!node || !node.connected) return;
    this.selected = this.hostContext?.selection.has(node) ?? false;
    return keyed(
      this.projectionVersion,
      html`<md-span .node=${node.inlineTree?.rootNode}></md-span>`,
    );
  }

  override updated() {
    if (!this.nodeView) return;
    noAwait(this.maybeSetFocus());
  }

  protected override createRenderRoot() {
    return this;
  }

  private setFocus(focusOffset: number) {
    const walker = document.createTreeWalker(this, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let next: Node | null;
    let offset = 0;
    const selection = this.nativeSelection()!;
    let final: MarkdownSpan | Text | undefined;
    while ((next = walker.nextNode()) && next !== this) {
      if (next instanceof MarkdownSpan) {
        offset = next.node!.startIndex;
        final = next;
      } else if (next.nodeType === Node.TEXT_NODE) {
        const length = (next as Text).length;
        final = next as Text;
        if (offset + length >= focusOffset) {
          const index = focusOffset - offset;
          const range = document.createRange();
          range.setStart(next, index);
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        offset += length;
      }
    }
    if (final) {
      const range = document.createRange();
      range.setStart(final, final.nodeType === Node.TEXT_NODE ? (final as Text).length : 0);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  async maybeSetFocus() {
    const node = this.nodeView;
    if (!node || !node.connected) return;
    if (this.hostContext?.focusNode !== node) return;
    const span = this.querySelector<MarkdownSpan>('md-span');
    if (!span) return;
    await span.updateComplete;
    if (this.hostContext?.focusNode !== node) return;
    if (!this.isConnected) return;
    const focusOffset = this.hostContext?.focusOffset;
    if (focusOffset !== undefined) {
      if (focusOffset === Infinity || focusOffset === -Infinity) {
        this.setFocus(node.content.length);
      } else if (focusOffset < 0 || Object.is(focusOffset, -0)) {
        this.setFocus(node.content.length);
        const selection = this.nativeSelection()!;
        selection.modify('move', 'backward', 'lineboundary');
        if (focusOffset < 0) {
          const point = MarkdownInline.nodeOffsetToInputPoint(
            selection.focusNode!,
            selection.focusOffset,
          );
          if (point.span) {
            this.setFocus(point.span.node!.startIndex + point.index + -focusOffset);
          }
        }
      } else {
        this.setFocus(focusOffset);
      }

      this.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
    }

    setTimeout(() => {
      if (!this.hostContext) return;
      this.hostContext.focusNode = undefined;
      this.hostContext.focusOffset = undefined;
    });
  }

  static nodeOffsetToInputPoint(node: Node, offset: number): InlineInputPoint {
    if (node instanceof MarkdownInline) {
      return { index: 0 };
    }
    if (node instanceof MarkdownSpan && node.node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.setEnd(node, offset);
      return {
        span: node,
        index: node.node.startIndex + range.toString().length,
      };
    }
    let parent: HTMLElement = cast(node.parentElement);
    while (!(parent instanceof MarkdownSpan)) {
      parent = cast(parent.parentElement);
    }
    const walker = document.createTreeWalker(
      parent,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    walker.currentNode = node;
    let previous = walker.previousNode();
    while (previous && previous !== parent && !(previous instanceof MarkdownSpan)) {
      if (previous.nodeType === Node.TEXT_NODE) {
        offset += (previous as Text).length;
      }
      previous = walker.previousNode();
    }
    return {
      span: parent,
      index: (cast(previous) as MarkdownSpan).node!.startIndex + offset,
    };
  }

  static getSelectionRange(selection: Selection) {
    const start = MarkdownInline.nodeOffsetToInputPoint(
      selection.anchorNode!,
      selection.anchorOffset,
    );
    const end = MarkdownInline.nodeOffsetToInputPoint(selection.focusNode!, selection.focusOffset);
    return start.index <= end.index ? { start, end } : { start: end, end: start };
  }

  moveCaret(
    alter: 'move' | 'extend',
    direction: 'backward' | 'forward',
    granularity: 'line' | 'character' | 'word',
  ): true | number {
    const selection = this.nativeSelection()!;
    const focusNode = selection.focusNode!;
    const focusOffset = selection.focusOffset;
    const initial = MarkdownInline.nodeOffsetToInputPoint(
      selection.focusNode!,
      selection.focusOffset,
    );
    const focus = document.createRange();
    focus.setStart(selection.focusNode!, selection.focusOffset);
    focus.collapse(true);
    const anchor = document.createRange();
    anchor.setStart(selection.anchorNode!, selection.anchorOffset);
    anchor.collapse(true);

    selection.removeAllRanges();
    selection.addRange(focus);
    selection.modify('move', 'backward', 'lineboundary');
    selection.modify('extend', 'forward', 'lineboundary');
    const line = MarkdownInline.getSelectionRange(selection);

    selection.modify('move', 'forward', 'documentboundary');
    const end = MarkdownInline.nodeOffsetToInputPoint(selection.focusNode!, selection.focusOffset);

    selection.removeAllRanges();
    selection.addRange(anchor);
    selection.extend(focusNode, focusOffset);
    selection.modify(alter, direction, granularity);
    const result = MarkdownInline.nodeOffsetToInputPoint(
      selection.focusNode!,
      selection.focusOffset,
    );

    if (granularity === 'line') {
      if (direction === 'backward') {
        return result.index < line.start.index || initial.index - line.start.index;
      }
      return (
        result.index > line.end.index ||
        (result.index !== end.index && result.index === line.end.index) ||
        initial.index - line.start.index
      );
    }
    return result.index !== initial.index || (direction === 'backward' ? Infinity : 0);
  }

  getSelection() {
    const selection = this.nativeSelection()!;
    if (!selection.focusNode) return;
    return MarkdownInline.getSelectionRange(selection);
  }

  getCaretPosition() {
    let { x, y, height } = this.nativeSelection()!.getRangeAt(0).getBoundingClientRect();
    if (x === 0 && y === 0) {
      ({ x, y, height } = this.getBoundingClientRect());
    }
    return { x, y: y + height };
  }

  setCaretAtVisualX(x: number, direction: 'backward' | 'forward'): boolean {
    if (!Number.isFinite(x) || !this.nodeView) return false;
    if (
      direction === 'backward' &&
      this.nodeView.type === 'code-block' &&
      this.nodeView.content.endsWith('\n')
    ) {
      return false;
    }
    const line = this.visualLine(direction);
    if (!line) return false;

    const position = document.caretPositionFromPoint?.(x, line.y, {
      shadowRoots: this.shadowRoots(),
    });
    if (
      position &&
      this.isCaretOnLine(position.offsetNode, position.offset, line) &&
      this.setCaret(position.offsetNode, position.offset)
    ) {
      return true;
    }

    const nearest = this.nearestCaretOnLine(x, line);
    return nearest ? this.setCaret(nearest.node, nearest.offset) : false;
  }

  private visualLine(direction: 'backward' | 'forward') {
    const range = document.createRange();
    range.selectNodeContents(this);
    const rects = [...range.getClientRects()]
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((left, right) => left.top - right.top || left.left - right.left);
    const lines: Array<{ top: number; bottom: number }> = [];
    for (const rect of rects) {
      const line = lines.at(-1);
      if (line && rect.top < line.bottom) {
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else {
        lines.push({ top: rect.top, bottom: rect.bottom });
      }
    }
    const line = direction === 'backward' ? lines.at(-1) : lines[0];
    return line ? { ...line, y: (line.top + line.bottom) / 2 } : undefined;
  }

  private shadowRoots(): ShadowRoot[] {
    const roots: ShadowRoot[] = [];
    let root: Node = this.getRootNode();
    while (root instanceof ShadowRoot) {
      roots.push(root);
      root = root.host.getRootNode();
    }
    return roots;
  }

  private isCaretOnLine(node: Node, offset: number, line: { top: number; bottom: number }) {
    if (this.textOffset(node, offset) === undefined) return false;
    const range = document.createRange();
    try {
      range.setStart(node, offset);
      range.collapse(true);
    } catch {
      return false;
    }
    const rect = range.getBoundingClientRect();
    if (rect.x === 0 && rect.y === 0 && rect.height === 0) return false;
    const y = rect.top + rect.height / 2;
    return y >= line.top - 1 && y <= line.bottom + 1;
  }

  private nearestCaretOnLine(x: number, line: { top: number; bottom: number }) {
    let nearest: { node: Text; offset: number; distance: number } | undefined;
    let textOffset = 0;
    const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const text = current as Text;
      for (let offset = 0; offset <= text.length;) {
        const range = document.createRange();
        range.setStart(text, offset);
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        const y = rect.top + rect.height / 2;
        const logicalOffset = textOffset + offset;
        if (
          logicalOffset <= this.nodeView!.content.length &&
          !(rect.x === 0 && rect.y === 0 && rect.height === 0) &&
          y >= line.top - 1 &&
          y <= line.bottom + 1
        ) {
          const distance = Math.abs(rect.x - x);
          if (!nearest || distance < nearest.distance) {
            nearest = { node: text, offset, distance };
          }
        }
        if (offset === text.length) break;
        const codePoint = text.data.codePointAt(offset)!;
        offset += codePoint > 0xffff ? 2 : 1;
      }
      textOffset += text.length;
    }
    return nearest;
  }

  private setCaret(node: Node, offset: number) {
    const selection = this.nativeSelection();
    if (!selection) return false;
    try {
      selection.collapse(node, offset);
      return true;
    } catch {
      return false;
    }
  }

  onKeyDown = (e: KeyboardEvent) => {
    if (this.recovery || this.holdRecoveryInputs) {
      e.preventDefault();
      this.queueRecoveryKeydown(e);
      return;
    }
    if (this.composing || e.isComposing) return;
    const node = this.nodeView;
    if (!node) return;
    this.dispatchEvent(
      new CustomEvent('inline-keydown', {
        detail: {
          inline: this,
          node,
          keyboardEvent: e,
        },
        bubbles: true,
        composed: true,
      }),
    );
  };

  onBeforeInput = (e: InputEvent) => {
    if (this.recovery || this.holdRecoveryInputs) {
      e.preventDefault();
      this.queueRecoveryInput(e);
      return;
    }
    const node = this.nodeView;
    if (!node) return;
    if (this.composing || e.isComposing) return;
    e.preventDefault();
    const selection = this.nativeSelection()!;
    const { start: inputStart, end: inputEnd } = MarkdownInline.getSelectionRange(selection);
    this.dispatchEvent(
      new CustomEvent('inline-input', {
        detail: {
          inline: this,
          node,
          inputEvent: e,
          inputStart,
          inputEnd,
          content: node.content,
        },
        bubbles: true,
        composed: true,
      }),
    );
  };

  onPointerDown = () => {
    this.hostContext?.clearSelection();
  };
}

@customElement('md-span')
export class MarkdownSpan extends LitElement {
  @property({ type: Boolean, reflect: true }) accessor formatting = false;
  @property({ type: String, reflect: true }) accessor type = '';
  @property({ attribute: false }) accessor node: InlineTreeNode | undefined;

  @queryAll(':scope > md-span') accessor spans!: NodeListOf<MarkdownSpan>;

  constructor() {
    super();
    this.addEventListener('pointerdown', (e) => {
      this.handlePointerDown(e);
    });
    this.addEventListener('click', (e) => {
      this.handleClick(e);
    });
  }

  override async getUpdateComplete() {
    const result = super.getUpdateComplete();
    await Promise.all(Array.from(this.spans).map((span) => span.updateComplete));
    return result;
  }

  override shouldUpdate(changed: Map<string, unknown>) {
    if (!changed.has('node')) return false;
    const oldSyntaxNode = changed.get('node') as InlineTreeNode | undefined;
    const newSyntaxNode = this.node;
    return !!newSyntaxNode && oldSyntaxNode?.id !== newSyntaxNode.id;
  }

  protected override createRenderRoot() {
    return this;
  }

  get inlineHasFocus(): boolean {
    let parent = this.parentElement;
    while (parent) {
      if (parent instanceof MarkdownInline) {
        return parent.matches(':is(:focus, :focus-within)');
      }
      parent = parent.parentElement;
    }
    return false;
  }

  private handlePointerDown(event: Event) {
    if (this.inlineHasFocus) return;
    const node = this.node;
    if (!node) return;
    if (
      event.target instanceof HTMLAnchorElement ||
      node.type === 'inline_link' ||
      node.type === 'shortcut_link' ||
      node.type === 'uri_autolink'
    ) {
      event.preventDefault();
    }
  }

  private handleClick(event: Event) {
    if (this.inlineHasFocus) return;
    const node = this.node;
    if (!node) return;

    let inlineLinkClick: InlineLinkClick;
    if (event.target instanceof HTMLAnchorElement) {
      inlineLinkClick = {
        type: 'magic_link',
        destination: event.target.href,
      };
    } else {
      if (
        node.type !== 'inline_link' &&
        node.type !== 'shortcut_link' &&
        node.type !== 'uri_autolink'
      ) {
        return;
      }
      const text = node.namedChildren.find((child) => child.type === 'link_text')?.text ?? '';
      const destination =
        node.namedChildren.find((child) => child.type === 'link_destination')?.text ??
        (node.type === 'uri_autolink' ? node.text.slice(1, -1) : null) ??
        text;
      inlineLinkClick = {
        type: node.type,
        destination,
      };
    }
    event.preventDefault();
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('inline-link-click', {
        detail: inlineLinkClick,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const node = this.node;
    if (!node) return html``;
    this.type = node.type;
    this.formatting = isFormatting(node);

    let index = node.startIndex;
    interface Result {
      node?: InlineTreeNode;
      result: TemplateResult;
    }
    const results: Result[] = [];
    const children = [...node.namedChildren];
    while (index < node.endIndex) {
      const child = children.shift();
      if (child) {
        if (index < child.startIndex) {
          const text = node.text.substring(
            index - node.startIndex,
            child.startIndex - node.startIndex,
          );
          results.push({ result: this.renderText(text) });
        }
        index = child.endIndex;
        results.push({
          node: child,
          result: html`<md-span .node=${child}></md-span>`,
        });
      } else {
        const text = node.text.substring(index - node.startIndex, node.endIndex - node.startIndex);
        results.push({ result: this.renderText(text) });
        index = node.endIndex;
      }
    }
    return repeat(
      results,
      (item) => item.node?.id ?? item.result.strings.join(''),
      (item) => item.result,
    );
  }

  private renderText(content: string): TemplateResult {
    const codeBlock = this.closest('md-inline')?.nodeView;
    if (codeBlock?.type === 'code-block') {
      // The trailing break gives Chromium a caret position after a final newline without
      // adding text to the code block's projection.
      if (codeBlock.content.endsWith('\n') && content.endsWith('\n')) {
        return html`${content}<br />`;
      }
      return html`${content}`;
    }
    const parts = content.split(/(\b(?:https?:\/|go|b|cl)\/[^\s]*[\w/=?])/u);
    if (parts.length === 1) {
      return html`${parts[0]}`;
    }
    return html`${parts.map((value, index) => {
      if (index % 2 === 0) {
        return html`${value}`;
      }
      const target = value.startsWith('http') ? value : `http://${value}`;
      return html`<a href=${target} target="_blank" rel="noopener noreferrer">${value}</a>`;
    })}`;
  }
}

function isFormatting(node: InlineTreeNode) {
  return ['syntax', 'link_destination', 'link_title'].includes(node.type);
}

declare global {
  interface Selection {
    modify(
      alter: 'move' | 'extend',
      direction: 'forward' | 'backward',
      granularity: 'character' | 'lineboundary' | 'line' | 'word' | 'documentboundary',
    ): void;
  }

  interface HTMLElementTagNameMap {
    'md-inline': MarkdownInline;
    'md-span': MarkdownSpan;
  }
}
