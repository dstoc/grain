import { consume } from '@lit/context';
import { html, LitElement, type TemplateResult } from 'lit';
import { customElement, property, query, queryAll } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { noAwait } from '../async.js';
import { cast } from '../asserts.js';
import { sigprop, type SigpropHost } from '../signal-utils.js';
import { HostContext, hostContext } from './host-context.js';
import type { InlineTreeNode } from './inline-parser.js';
import { type InlineViewModelNode, viewModel } from './view-model-node.js';

export interface InlineInputPoint {
  span?: MarkdownSpan;
  index: number;
}

export interface InlineInput {
  inline: MarkdownInline;
  node: InlineViewModelNode;
  content: string;
  inputEvent: InputEvent;
  inputStart: InlineInputPoint;
  inputEnd: InlineInputPoint;
}

export interface InlineKeyDown {
  inline: MarkdownInline;
  node: InlineViewModelNode;
  keyboardEvent: KeyboardEvent;
}

export interface InlineLinkClick {
  type: string;
  destination: string;
}

declare global {
  interface HTMLElementEventMap {
    'inline-input': CustomEvent<InlineInput>;
    'inline-keydown': CustomEvent<InlineKeyDown>;
    'inline-link-click': CustomEvent<InlineLinkClick>;
  }
}

@customElement('md-inline')
export class MarkdownInline extends LitElement implements SigpropHost {
  constructor() {
    super();
    this.addEventListener('beforeinput', this.onBeforeInput, { capture: true });
    this.addEventListener('keydown', this.onKeyDown, { capture: true });
    this.addEventListener('pointerdown', this.onPointerDown);
    this.setAttribute('contenteditable', '');
  }

  @consume({ context: hostContext, subscribe: true })
  @property({ attribute: false })
  accessor hostContext: HostContext | undefined;

  @property({ type: Boolean, reflect: true }) accessor selected: boolean | undefined;

  @query('md-span') accessor span!: MarkdownSpan;

  @sigprop accessor node: InlineViewModelNode | undefined;

  effectDispose?: () => void;

  effect() {
    this.node?.[viewModel].renderSignal.value;
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.effectDispose?.();
  }

  override render() {
    if (!this.node) return;
    if (!this.node[viewModel].connected) return;
    this.selected = this.hostContext?.selection.has(this.node) ?? false;
    return html`<md-span .node=${this.node[viewModel].inlineTree.rootNode}></md-span>`;
  }

  override updated() {
    if (!this.node) return;
    noAwait(this.maybeSetFocus());
  }

  protected override createRenderRoot() {
    return this;
  }

  private setFocus(focusOffset: number) {
    const walker = document.createTreeWalker(this, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let next: Node | null;
    let offset = 0;
    const selection = (this.getRootNode() as Document).getSelection()!;
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
    if (!this.node) return;
    if (this.hostContext?.focusNode !== this.node) return;
    await this.span.updateComplete;
    if (this.hostContext?.focusNode !== this.node) return;
    if (!this.isConnected) return;
    const focusOffset = this.hostContext?.focusOffset;
    if (focusOffset !== undefined) {
      if (focusOffset === Infinity || focusOffset === -Infinity) {
        this.setFocus(this.node.content.length);
      } else if (focusOffset < 0 || Object.is(focusOffset, -0)) {
        this.setFocus(this.node.content.length);
        const selection = (this.getRootNode() as Document).getSelection()!;
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
    const index = (cast(previous) as MarkdownSpan).node!.startIndex + offset;
    return {
      span: parent,
      index,
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
    const selection = (this.getRootNode() as Document).getSelection()!;
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
    const selection = (this.getRootNode() as Document).getSelection()!;
    if (!selection.focusNode) return;
    return MarkdownInline.getSelectionRange(selection);
  }

  getCaretPosition() {
    let { x, y, height } = (this.getRootNode() as Document)
      .getSelection()!
      .getRangeAt(0)
      .getBoundingClientRect();
    if (x === 0 && y === 0) {
      ({ x, y, height } = this.getBoundingClientRect());
    }
    return { x, y: y + height };
  }

  onKeyDown = (e: KeyboardEvent) => {
    if (!this.node) return;
    this.dispatchEvent(
      new CustomEvent('inline-keydown', {
        detail: {
          inline: this,
          node: this.node,
          keyboardEvent: e,
        },
        bubbles: true,
        composed: true,
      }),
    );
  };

  onBeforeInput = (e: InputEvent) => {
    if (!this.node) return;
    e.preventDefault();
    const selection = (this.getRootNode() as Document).getSelection()!;
    const { start: inputStart, end: inputEnd } = MarkdownInline.getSelectionRange(selection);
    this.dispatchEvent(
      new CustomEvent('inline-input', {
        detail: {
          inline: this,
          node: this.node,
          inputEvent: e,
          inputStart,
          inputEnd,
          content: this.node.content,
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
        return parent.matches(':focus-within');
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
