// Copyright 2023 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { css, html, LitElement } from 'lit';
import { property, customElement, query } from 'lit/decorators.js';
import type {
  InlineMarkdownNodeView,
  ReadonlyCodeBlockNodeView,
  ReadonlyMarkdownNodeView,
} from './node-view.js';
import type { MarkdownRenderer } from './block-render.js';
import type { MarkdownInline } from './inline-render.js';
import { consume } from '@lit/context';
import { HostContext, hostContext, invalidateNodeView } from './host-context.js';

@customElement('md-transclusion')
export class MarkdownTransclusion extends LitElement {
  @property({ attribute: false })
  accessor node: ReadonlyCodeBlockNodeView | undefined;

  @property({ type: Boolean, reflect: true })
  accessor selected = false;

  @consume({ context: hostContext, subscribe: true })
  @property({ attribute: false })
  accessor hostContext: HostContext | undefined;

  @property({ attribute: false })
  accessor root: ReadonlyMarkdownNodeView | undefined;

  @query('md-block-render')
  private accessor markdownRenderer!: MarkdownRenderer;

  override render() {
    return this.root
      ? html`
          <md-block-render
            .block=${this.root}
            .renderDelegate=${this.hostContext?.renderDelegate}
          ></md-block-render>
        `
      : '';
  }
  static override styles = css`
    :host {
      display: block;
      padding: 10px;
      border-radius: 10px;
      border: solid var(--md-code-block-bgcolor) 1px;
      background-color: var(--root-background-color);
    }
  `;

  protected override updated() {
    void this.maybeUpdateFocus();
  }

  async maybeUpdateFocus() {
    if (!this.isConnected) return;
    if (!this.hostContext) return;
    if (!this.root) return;
    if (this.hostContext.focusNode !== this.node) return;
    await this.markdownRenderer.updateComplete;
    if (!this.isConnected) return;
    if (this.hostContext.focusNode !== this.node) return;
    const offset = this.hostContext.focusOffset ?? -1;
    const node =
      offset < 0 || Object.is(offset, -0) ? finalInlineNode(this.root) : firstInlineNode(this.root);
    this.markdownRenderer.hostContext.focusNode = node ?? undefined;
    this.markdownRenderer.hostContext.focusOffset = this.hostContext.focusOffset;
    this.hostContext.focusNode = undefined;
    this.hostContext.focusOffset = undefined;
    if (node) invalidateNodeView(node);
  }

  async focusEdge(direction: 'forward' | 'backward', visualX?: number): Promise<boolean> {
    if (!this.isConnected || !this.root) return false;
    await this.updateComplete;
    if (!this.isConnected) return false;
    await this.markdownRenderer.updateComplete;
    const candidates = renderedInlines(this.markdownRenderer.shadowRoot!);
    const inline = direction === 'forward' ? candidates[0] : candidates.at(-1);
    if (!inline?.nodeView?.connected) return false;

    inline.hostContext?.clearSelection();
    const offset = direction === 'forward' ? 0 : inline.nodeView.content.length;
    await inline.updateComplete;
    inline.focus();
    if (visualX === undefined || !inline.setCaretAtVisualX(visualX, direction)) {
      inline.setSelectionOffsets(offset, offset);
    }
    return true;
  }
}

export function getContainingTransclusion(element: Element): MarkdownTransclusion | undefined {
  const rendererRoot = element.getRootNode();
  if (!(rendererRoot instanceof ShadowRoot)) return;
  const renderer = rendererRoot.host;
  if (renderer.localName !== 'md-block-render') return;
  const transclusionRoot = renderer.getRootNode();
  if (!(transclusionRoot instanceof ShadowRoot)) return;
  const transclusion = transclusionRoot.host;
  return transclusion instanceof MarkdownTransclusion ? transclusion : undefined;
}

export function getRenderedTransclusion(
  root: ParentNode,
  node: InlineMarkdownNodeView,
): MarkdownTransclusion | undefined {
  return [...root.querySelectorAll('md-transclusion')].find(
    (element): element is MarkdownTransclusion =>
      element instanceof MarkdownTransclusion && element.node === node,
  );
}

function renderedInlines(root: ShadowRoot): MarkdownInline[] {
  const inlines: MarkdownInline[] = [];
  const visit = (node: Node) => {
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      for (const child of assigned.length ? assigned : node.childNodes) visit(child);
      return;
    }
    if (node instanceof Element && node.localName === 'md-inline') {
      inlines.push(node as MarkdownInline);
    }
    if (node instanceof Element && node.shadowRoot) {
      for (const child of node.shadowRoot.childNodes) visit(child);
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  for (const child of root.childNodes) visit(child);
  return inlines;
}

function firstInlineNode(root: ReadonlyMarkdownNodeView): InlineMarkdownNodeView | undefined {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (
      (node.type === 'paragraph' || node.type === 'section' || node.type === 'code-block') &&
      typeof node.content === 'string'
    ) {
      return node as InlineMarkdownNodeView;
    }
    pending.push(...[...(node.children ?? [])].reverse());
  }
}

function finalInlineNode(root: ReadonlyMarkdownNodeView): InlineMarkdownNodeView | undefined {
  let result: InlineMarkdownNodeView | undefined;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (
      (node.type === 'paragraph' || node.type === 'section' || node.type === 'code-block') &&
      typeof node.content === 'string'
    ) {
      result = node as InlineMarkdownNodeView;
    }
    pending.push(...[...(node.children ?? [])].reverse());
  }
  return result;
}

declare global {
  interface HTMLElementTagNameMap {
    'md-transclusion': MarkdownTransclusion;
  }
}
