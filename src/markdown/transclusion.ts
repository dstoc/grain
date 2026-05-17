import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { HostContext } from './host-context.js';
import type { InlineViewModelNode } from './view-model-node.js';
import type { CodeBlockNode } from './node.js';

@customElement('md-transclusion')
export class MarkdownTransclusion extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 10px;
      border-radius: 10px;
      border: solid var(--md-code-block-bgcolor) 1px;
      background-color: var(--root-background-color);
    }
  `;

  @property({ attribute: false })
  accessor node: (InlineViewModelNode & CodeBlockNode) | undefined;

  @property({ type: Boolean, reflect: true })
  accessor selected = false;

  @property({ attribute: false })
  accessor hostContext: HostContext | undefined;

  override render() {
    const ref = this.node?.content.trim() ?? '';
    return html`⮴ ${ref || 'transclusion unavailable'}`;
  }
}

export function getContainingTransclusion(element: Element) {
  const renderShadow = element.getRootNode();
  if (!(renderShadow instanceof ShadowRoot)) return;
  const renderHost = renderShadow.host;
  if (!(renderHost instanceof HTMLElement)) return;
  if (renderHost.tagName.toLowerCase() !== 'md-block-render') return;
  const shadow = renderHost.getRootNode();
  if (!(shadow instanceof ShadowRoot)) return;
  const transclusion = shadow.host;
  if (!(transclusion instanceof MarkdownTransclusion)) return;
  return transclusion;
}

declare global {
  interface HTMLElementTagNameMap {
    'md-transclusion': MarkdownTransclusion;
  }
}
