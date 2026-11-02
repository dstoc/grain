import type { ReadonlySignal } from '@preact/signals-core';

import type { InlineTree } from './inline-parser.js';
import type { MarkdownNode } from './node.js';

/** Read-only semantic and projection data consumed by renderers. */
export interface ReadonlyMarkdownNodeView {
  readonly id: number;
  readonly type: MarkdownNode['type'];
  readonly children?: readonly ReadonlyMarkdownNodeView[];
  readonly parent?: ReadonlyMarkdownNodeView;
  readonly previousSibling?: ReadonlyMarkdownNodeView;
  readonly nextSibling?: ReadonlyMarkdownNodeView;
  readonly content?: string;
  readonly marker?: string;
  readonly checked?: boolean;
  readonly info?: string | null;
  readonly connected: boolean;
  readonly version: number;
  readonly renderSignal: ReadonlySignal<number>;
  readonly inlineTree?: InlineTree;
}

/** A checked inline projection accepted by the renderer and browser adapters. */
export type InlineMarkdownNodeView = ReadonlyMarkdownNodeView &
  (
    | { readonly type: 'paragraph'; readonly content: string }
    | { readonly type: 'section'; readonly content: string; readonly marker: string }
    | { readonly type: 'code-block'; readonly content: string; readonly info: string | null }
  );

export function asInlineMarkdownNodeView(node: ReadonlyMarkdownNodeView): InlineMarkdownNodeView {
  if (
    (node.type !== 'paragraph' && node.type !== 'section' && node.type !== 'code-block') ||
    typeof node.content !== 'string' ||
    (node.type === 'section' && typeof node.marker !== 'string') ||
    (node.type === 'code-block' && typeof node.info !== 'string' && node.info !== null)
  ) {
    throw new Error(`invalid inline renderer node: ${node.type}`);
  }
  return node as InlineMarkdownNodeView;
}
