import type { ReadonlyCodeBlockNodeView } from './node-view.js';
import type { HostContext } from './host-context.js';

export interface MarkdownRenderDelegate {
  renderCodeBlock?: (args: {
    node: ReadonlyCodeBlockNodeView;
    hostContext: HostContext;
    selected: boolean;
  }) => unknown;
}
