import { consume, provide } from '@lit/context';
import { html, LitElement, render } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { keyed } from 'lit/directives/keyed.js';

import { NodeSignalController } from './node-signal-controller.js';
import { HostContext, hostContext } from './host-context.js';
import { MarkdownInline, type InlineProjectionRecovery } from './inline-render.js';
import type { MarkdownRenderDelegate } from './render-delegate.js';
import { styles } from './style.js';
import {
  asInlineMarkdownNodeView,
  type ReadonlyCodeBlockNodeView,
  type ReadonlyMarkdownNodeView,
} from './node-view.js';
import './transclusion.js';
import './block-ui.js';

@customElement('md-block')
export class MarkdownBlock extends LitElement {
  @property({ type: Boolean, reflect: true }) accessor root: boolean | undefined;
  @property({ type: String, reflect: true }) accessor type = '';

  @consume({ context: hostContext, subscribe: true })
  @property({ attribute: false })
  accessor hostContext: HostContext | undefined;

  @property({ attribute: false }) accessor node: ReadonlyMarkdownNodeView | undefined;

  private nodeSignal = new NodeSignalController(this, () => this.node);
  private inlineProjectionVersion = 0;

  constructor() {
    super();
    this.addEventListener('inline-projection-recovery', this.onInlineProjectionRecovery);
  }

  private onInlineProjectionRecovery = (event: Event) => {
    const recovery = (event as CustomEvent<InlineProjectionRecovery>).detail;
    if (!recovery || recovery.inline.parentElement !== this) return;
    event.stopPropagation();
    event.preventDefault();
    this.inlineProjectionVersion++;
    const context = recovery.inline.hostContext;
    const node = recovery.inline.nodeView;
    const focusGuarded = !!recovery.shouldRestoreFocus;
    if (focusGuarded) {
      if (context && context.focusNode === node) {
        context.focusNode = undefined;
        context.focusOffset = undefined;
      }
    } else if (node && context) {
      context.focusNode = node;
      context.focusOffset = recovery.selection.focus;
    }
    this.requestUpdate();
    void this.updateComplete.then(async () => {
      const next = this.querySelector(':scope > md-inline');
      if (next instanceof MarkdownInline && next.nodeView === recovery.inline.nodeView) {
        await next.updateComplete;
        const restoreFocus = !recovery.shouldRestoreFocus || recovery.shouldRestoreFocus();
        if (focusGuarded) {
          if (restoreFocus) {
            next.focus();
            recovery.shouldRestoreFocus?.markRestored?.();
            next.setSelectionOffsets(recovery.selection.anchor, recovery.selection.focus);
          } else if (context && context.focusNode === node) {
            context.focusNode = undefined;
            context.focusOffset = undefined;
          }
        } else {
          await next.maybeSetFocus();
          next.focus();
          next.setSelectionOffsets(recovery.selection.anchor, recovery.selection.focus);
        }
        const pending = recovery.inline.takeRecoveryEvents();
        if (focusGuarded && !restoreFocus) next.discardRecoveryEvents();
        else if (recovery.replayEvents) next.replayRecoveryEvents(pending);
        else next.holdRecoveryEventsFrom(pending);
        recovery.complete(next);
      } else {
        recovery.inline.takeRecoveryEvents();
        recovery.complete();
      }
    });
  };

  override render() {
    const node = this.node;
    if (!node) return;
    this.type = node.type;
    if (node.type === 'code-block') {
      const hostContext = this.hostContext;
      const codeBlock = asInlineMarkdownNodeView(node) as ReadonlyCodeBlockNodeView;
      const selected = hostContext?.selection.has(asInlineMarkdownNodeView(node)) ?? false;
      if (hostContext) {
        const rendered = hostContext.renderDelegate?.renderCodeBlock?.({
          node: codeBlock,
          hostContext,
          selected,
        });
        if (rendered !== undefined) {
          return rendered;
        }
      }
    }
    const inline =
      node.type === 'paragraph' || node.type === 'section' || node.type === 'code-block'
        ? (this.inlineProjectionVersion ?? 0) === 0
          ? this.renderInline(node)
          : keyed(this.inlineProjectionVersion, this.renderInline(node))
        : '';
    return html`${inline}
    ${repeat(
      node.children ?? [],
      (child) => child.id,
      (child) => html`<md-block .node=${child}></md-block>`,
    )}`;
  }

  private renderInline(node: ReadonlyMarkdownNodeView) {
    const inlineNode = asInlineMarkdownNodeView(node);
    return html`<md-inline .nodeView=${inlineNode}></md-inline>`;
  }

  #renderShadow() {
    const node = this.node;
    if (!node) return;
    if (node.type === 'section') {
      return html`
        <md-section-ui .node=${this.node as ReadonlyMarkdownNodeView}>
          <slot></slot>
        </md-section-ui>
      `;
    }
    if (node.type === 'list-item') {
      return html`
        <md-list-item-ui .node=${this.node as ReadonlyMarkdownNodeView}>
          <slot></slot>
        </md-list-item-ui>
      `;
    }
    return;
  }

  protected override updated() {
    const content = this.#renderShadow();
    if (content && !this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    if (this.shadowRoot) {
      render(content ?? html`<slot></slot>`, this.shadowRoot);
    }
  }

  protected override createRenderRoot() {
    return this;
  }
}

@customElement('md-block-render')
export class MarkdownRenderer extends LitElement {
  static override styles = styles;

  @provide({ context: hostContext })
  accessor hostContext = new HostContext();

  @property({ attribute: false })
  accessor renderDelegate: MarkdownRenderDelegate | undefined;

  @property({ attribute: false }) accessor block!: ReadonlyMarkdownNodeView;
  @property({ attribute: false }) accessor version = 0;

  constructor() {
    super();
    this.hostContext = new HostContext();
  }

  protected override createRenderRoot() {
    const root = super.createRenderRoot();
    root.addEventListener('focusin', this.onFocusIn);
    return root;
  }

  override render() {
    this.hostContext.root = this.block;
    this.hostContext.renderDelegate = this.renderDelegate;
    if (!this.block) return html``;
    return html`<md-block .node=${this.block} ?root=${true}></md-block>`;
  }

  getInlineSelection(): {
    inline?: HTMLElementTagNameMap['md-inline'];
    startIndex?: number;
    endIndex?: number;
  } {
    let active = this.shadowRoot!.activeElement;
    while (true) {
      if (!active || active instanceof MarkdownInline) {
        const inline = active;
        const selection = inline?.getSelection();
        return {
          inline: inline ?? undefined,
          startIndex: selection?.start.index,
          endIndex: selection?.end.index,
        };
      }
      active = active.shadowRoot?.activeElement ?? null;
    }
  }

  private onFocusIn = (e: Event) => {
    if (!(e.target instanceof MarkdownInline)) return;
    const target = e.target;
    if (!target.nodeView) return;
    this.dispatchEvent(
      new CustomEvent('md-block-focus', {
        detail: target.nodeView,
        bubbles: true,
        composed: true,
      }),
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'md-block': MarkdownBlock;
    'md-block-render': MarkdownRenderer;
  }

  interface HTMLElementEventMap {
    'md-block-focus': CustomEvent<ReadonlyMarkdownNodeView>;
  }
}
