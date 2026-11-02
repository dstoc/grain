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
