import { consume, provide } from '@lit/context';
import { html, LitElement, render } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { keyed } from 'lit/directives/keyed.js';

import { NodeSignalController } from './node-signal-controller.js';
import { HostContext, hostContext } from './host-context.js';
import { MarkdownInline, type InlineProjectionRecovery } from './inline-render.js';
import { isInlineNode } from './node.js';
import type { MarkdownRenderDelegate } from './render-delegate.js';
import { styles } from './style.js';
import type { InlineViewModelNode, ViewModelNode } from './view-model-node.js';
import { viewModel } from './view-model-node.js';
import './transclusion.js';
import './block-ui.js';

@customElement('md-block')
export class MarkdownBlock extends LitElement {
  @property({ type: Boolean, reflect: true }) accessor root: boolean | undefined;
  @property({ type: String, reflect: true }) accessor type = '';

  @consume({ context: hostContext, subscribe: true })
  @property({ attribute: false })
  accessor hostContext: HostContext | undefined;

  @property({ attribute: false }) accessor node: ViewModelNode | undefined;

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
    if (recovery.inline.node && recovery.inline.hostContext) {
      recovery.inline.hostContext.focusNode = recovery.inline.node;
      recovery.inline.hostContext.focusOffset = recovery.selection.focus;
    }
    this.requestUpdate();
    void this.updateComplete.then(async () => {
      const next = this.querySelector(':scope > md-inline');
      if (next instanceof MarkdownInline && next.node === recovery.inline.node) {
        await next.updateComplete;
        await next.maybeSetFocus();
        next.focus();
        next.setSelectionOffsets(recovery.selection.anchor, recovery.selection.focus);
        const pending = recovery.inline.takeRecoveryEvents();
        if (recovery.replayEvents) next.replayRecoveryEvents(pending);
        else next.holdRecoveryEventsFrom(pending);
      } else {
        recovery.inline.takeRecoveryEvents();
      }
      recovery.complete();
    });
  };

  override render() {
    const node = this.node;
    if (!node) return;
    this.type = node.type;
    if (node.type === 'code-block') {
      const hostContext = this.hostContext;
      const selected = hostContext?.selection.has(node) ?? false;
      if (hostContext) {
        const rendered = hostContext.renderDelegate?.renderCodeBlock?.({
          node,
          hostContext,
          selected,
        });
        if (rendered !== undefined) {
          return rendered;
        }
      }
    }
    const inline = isInlineNode(node)
      ? (this.inlineProjectionVersion ?? 0) === 0
        ? html`<md-inline .node=${node}></md-inline>`
        : keyed(this.inlineProjectionVersion, html`<md-inline .node=${node}></md-inline>`)
      : '';
    return html`${inline}
    ${repeat(
      node.children ?? [],
      (child) => child[viewModel].id,
      (child) => html`<md-block .node=${child}></md-block>`,
    )}`;
  }

  #renderShadow() {
    const node = this.node;
    if (!node) return;
    if (node.type === 'section') {
      return html`
        <md-section-ui .node=${this.node}>
          <slot></slot>
        </md-section-ui>
      `;
    }
    if (node.type === 'list-item') {
      return html`
        <md-list-item-ui .node=${this.node}>
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

  @property({ attribute: false }) accessor block!: ViewModelNode;
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
    if (!target.node) return;
    this.dispatchEvent(
      new CustomEvent('md-block-focus', {
        detail: target.node,
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
    'md-block-focus': CustomEvent<InlineViewModelNode>;
  }
}
