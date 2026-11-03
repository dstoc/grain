import { it, expect } from 'vitest';
import { MarkdownTransclusion } from './transclusion.js';
import { HostContext } from './host-context.js';
import { parseMarkdownTree } from './block-parser/api.js';
import { ConstructionPreviewAdapter } from './construction-preview.js';
import { asInlineMarkdownNodeView } from './node-view.js';
import { nextTask } from '../editing/test/lifecycle.js';

it('forwards end focus to the last paragraph in a mounted transclusion', async () => {
  const outer = parseMarkdownTree('```md\nouter\n```');
  const nested = parseMarkdownTree('first\n\nsecond\n\n> quoted first\n>\n> quoted last');
  const context = new HostContext();
  const outerPreview = new ConstructionPreviewAdapter(outer);
  const nestedPreview = new ConstructionPreviewAdapter(nested);
  context.root = outerPreview.root;
  const transclusion = new MarkdownTransclusion();
  const node = asInlineMarkdownNodeView(outerPreview.root.children![0]!);
  if (node.type !== 'code-block') throw new Error('expected code block');
  transclusion.node = node;
  transclusion.root = nestedPreview.root;
  transclusion.hostContext = context;
  document.body.replaceChildren(transclusion);
  try {
    await nextTask();
    const renderer = transclusion.shadowRoot!.querySelector('md-block-render')!;
    const requests: { content?: string }[] = [];
    let current = renderer.hostContext.focusNode;
    Object.defineProperty(renderer.hostContext, 'focusNode', {
      get: () => current,
      set: (value) => {
        current = value;
        requests.push(value);
      },
    });
    context.focusNode = node;
    context.focusOffset = -1;
    await transclusion.maybeUpdateFocus();
    expect(requests[0]?.content).toBe('quoted last');
  } finally {
    transclusion.remove();
  }
});
