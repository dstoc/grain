import type { CodeBlockNode } from './node.js';
import type { ReadonlyMarkdownNodeView } from './node-view.js';
import type { HostContext } from './host-context.js';

export interface MarkdownRenderDelegate {
  renderCodeBlock?: (args: {
    node: ReadonlyMarkdownNodeView & CodeBlockNode;
    hostContext: HostContext;
    selected: boolean;
  }) => unknown;
}
