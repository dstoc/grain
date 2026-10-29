import type { CodeBlockNode } from './node.js';
import type { HostContext } from './host-context.js';
import type { ViewModelNode } from './view-model-node.js';

export interface MarkdownRenderDelegate {
  renderCodeBlock?: (args: {
    node: ViewModelNode & CodeBlockNode;
    hostContext: HostContext;
    selected: boolean;
  }) => unknown;
}
