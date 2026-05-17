import { consume, provide } from '@lit/context';
import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { sigprop, type SigpropHost } from '../signal-utils.js';
import { HostContext, hostContext } from './host-context.js';
import { MarkdownInline } from './inline-render.js';
import { isInlineNode } from './node.js';
import { styles } from './style.js';
import type { InlineViewModelNode, ViewModelNode } from './view-model-node.js';
import { viewModel } from './view-model-node.js';

@customElement('md-block')
export class MarkdownBlock extends LitElement implements SigpropHost {
  @property({ type: Boolean, reflect: true }) accessor root: boolean | undefined;
  @property({ type: String, reflect: true }) accessor type = '';

  @consume({ context: hostContext, subscribe: true })
  @property({ attribute: false })
  accessor hostContext: HostContext | undefined;

  @sigprop accessor node: ViewModelNode | undefined;

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
    const node = this.node;
    if (!node) return;
    this.type = node.type;
    return html`${isInlineNode(node) ? html`<md-inline .node=${node}></md-inline>` : ''}
    ${repeat(
      node.children ?? [],
      (child) => child[viewModel].id,
      (child) => html`<md-block .node=${child}></md-block>`,
    )}`;
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
