import { LitElement, css, html, type TemplateResult } from 'lit';

import type {
  BlockQuoteNode,
  CodeBlockNode,
  ListItemNode,
  MarkdownNode,
  ParagraphNode,
  SectionNode,
} from './node.js';
import type { ViewModelNode } from './view-model-node.js';

type RenderableNode = MarkdownNode & Partial<ViewModelNode>;

const styles = css`
  :host {
    display: block;
    color: #1f2937;
    --md-accent: #0f766e;
    --md-surface: #ffffff;
    --md-subtle: #f3f4f6;
    --md-border: #d1d5db;
    --md-quote: #ecfeff;
    --md-code: #f8fafc;
    font:
      15px/1.5 'Iowan Old Style',
      'Palatino Linotype',
      'Book Antiqua',
      Palatino,
      Georgia,
      serif;
  }

  .root {
    display: grid;
    gap: 0.4rem;
  }

  .block {
    min-width: 0;
  }

  .inline {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .section {
    display: grid;
    gap: 0.45rem;
    margin: 0.55rem 0 0.8rem;
    padding-left: 0.9rem;
    border-left: 2px solid color-mix(in srgb, var(--md-accent) 26%, white);
  }

  .section-header {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    min-width: 0;
  }

  .section-marker {
    flex: none;
    font:
      600 11px/1 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--md-accent);
    background: color-mix(in srgb, var(--md-accent) 10%, white);
    border-radius: 999px;
    padding: 0.18rem 0.42rem;
  }

  .section-title {
    min-width: 0;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .section-body {
    display: grid;
    gap: 0.35rem;
  }

  .paragraph {
    padding: 0.1rem 0;
  }

  .list {
    display: grid;
    gap: 0.2rem;
  }

  .list-item {
    display: grid;
    grid-template-columns: 1.4rem minmax(0, 1fr);
    gap: 0.5rem;
    align-items: start;
  }

  .list-marker {
    padding-top: 0.1rem;
    color: var(--md-accent);
    font:
      600 12px/1.4 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    text-align: center;
    user-select: none;
  }

  .list-body {
    display: grid;
    gap: 0.25rem;
  }

  .quote {
    display: grid;
    gap: 0.35rem;
    padding: 0.7rem 0.9rem 0.7rem 1rem;
    border-left: 4px solid var(--md-accent);
    border-radius: 0 14px 14px 0;
    background: linear-gradient(90deg, var(--md-quote), transparent 85%);
  }

  .code {
    padding: 0.8rem 0.95rem;
    border: 1px solid var(--md-border);
    border-radius: 14px;
    background: var(--md-code);
    font:
      13px/1.55 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    white-space: pre-wrap;
    overflow-x: auto;
  }

  .code-info {
    margin-bottom: 0.45rem;
    color: #6b7280;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
`;

export class MarkdownBlockRender extends LitElement {
  static override styles = styles;
  static override properties = {
    block: { attribute: false },
    version: { attribute: false },
  };

  declare block: RenderableNode;
  declare version: number;

  override render() {
    if (!this.block) return html``;
    return html`<div class="root">${this.renderNode(this.block, true)}</div>`;
  }

  private renderNode(
    node: RenderableNode,
    isRoot = false,
  ): TemplateResult | string {
    switch (node.type) {
      case 'document':
        return html`${(node.children ?? []).map((child) =>
          this.renderNode(child as RenderableNode),
        )}`;
      case 'section':
        return this.renderSection(node);
      case 'paragraph':
        return this.renderParagraph(node, isRoot);
      case 'list':
        return html`<div class="block list">
          ${(node.children ?? []).map((child) =>
            this.renderNode(child as RenderableNode),
          )}
        </div>`;
      case 'list-item':
        return this.renderListItem(node);
      case 'block-quote':
        return this.renderBlockQuote(node);
      case 'code-block':
        return this.renderCodeBlock(node);
      default:
        return html``;
    }
  }

  private renderSection(
    node: SectionNode & RenderableNode,
  ): TemplateResult | string {
    return html`
      <section class="block section">
        <div class="section-header">
          <span class="section-marker">${node.marker}</span>
          <div class="inline section-title">${node.content}</div>
        </div>
        <div class="section-body">
          ${(node.children ?? []).map((child) =>
            this.renderNode(child as RenderableNode),
          )}
        </div>
      </section>
    `;
  }

  private renderParagraph(
    node: ParagraphNode & RenderableNode,
    isRoot = false,
  ): TemplateResult | string {
    return html`<div class="block paragraph ${isRoot ? 'root' : ''}">
      <div class="inline">${node.content}</div>
    </div>`;
  }

  private renderListItem(
    node: ListItemNode & RenderableNode,
  ): TemplateResult | string {
    return html`
      <div class="block list-item">
        <div class="list-marker">${this.markerText(node)}</div>
        <div class="list-body">
          ${(node.children ?? []).map((child) =>
            this.renderNode(child as RenderableNode),
          )}
        </div>
      </div>
    `;
  }

  private renderBlockQuote(
    node: BlockQuoteNode & RenderableNode,
  ): TemplateResult | string {
    return html`
      <blockquote class="block quote">
        ${(node.children ?? []).map((child) =>
          this.renderNode(child as RenderableNode),
        )}
      </blockquote>
    `;
  }

  private renderCodeBlock(
    node: CodeBlockNode & RenderableNode,
  ): TemplateResult | string {
    return html`
      <div class="block code">
        ${node.info ? html`<div class="code-info">${node.info}</div>` : ''}
        <div>${node.content}</div>
      </div>
    `;
  }

  private markerText(node: ListItemNode) {
    if (node.checked === true) return '[x]';
    if (node.checked === false) return '[ ]';
    return node.marker.trim();
  }
}

customElements.define('md-block-render', MarkdownBlockRender);

declare global {
  interface HTMLElementTagNameMap {
    'md-block-render': MarkdownBlockRender;
  }
}
