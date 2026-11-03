import { html, type TemplateResult } from 'lit';
import { describe, expect, test, vi } from 'vitest';

import { parseMarkdownTree } from './block-parser/api.js';
import { ConstructionPreviewAdapter } from './construction-preview.js';
import { ConstructionTree } from './semantic/construction-tree.js';
import { HostContext } from './host-context.js';
import { MarkdownBlock } from './block-render.js';
import './transclusion.js';
import { CanonicalDocument } from './canonical-model.js';
import type { ReadonlyCodeBlockNodeView, ReadonlyMarkdownNodeView } from './node-view.js';

function makeCodeBlock(): ReadonlyCodeBlockNodeView {
  const preview = new ConstructionPreviewAdapter(
    new ConstructionTree({
      type: 'document',
      children: [
        {
          type: 'code-block',
          info: 'md',
          content: 'transclusion target',
        },
      ],
    }),
  );
  return preview.root.children![0] as ReadonlyCodeBlockNodeView;
}

function renderBlock(
  node: ReadonlyMarkdownNodeView,
  hostContext: HostContext,
): TemplateResult | undefined {
  const block = new MarkdownBlock();
  block.node = node;
  block.hostContext = hostContext;
  return block.render() as TemplateResult | undefined;
}

describe('MarkdownBlock', () => {
  test('uses the default code-block path when no render delegate is provided', () => {
    const node = makeCodeBlock();
    const hostContext = new HostContext();

    const result = renderBlock(node, hostContext)!;
    const subResult = result.values[0] as TemplateResult;

    expect(subResult.strings).toEqual(['<md-inline .nodeView=', '></md-inline>']);
  });

  test('falls back to the default code-block path when the delegate returns undefined', () => {
    const node = makeCodeBlock();
    const hostContext = new HostContext();
    const renderCodeBlock = vi.fn(() => undefined);
    hostContext.renderDelegate = { renderCodeBlock };

    const result = renderBlock(node, hostContext)!;
    const subResult = result.values[0] as TemplateResult;

    expect(renderCodeBlock).toHaveBeenCalledTimes(1);
    expect(renderCodeBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        node,
        hostContext,
        selected: false,
      }),
    );
    expect(subResult.strings).toEqual(['<md-inline .nodeView=', '></md-inline>']);
  });

  test('renders canonical inline nodes through the read-only node view', () => {
    const document = CanonicalDocument.fromMarkdown('hello');
    try {
      const node = document.root.children[0]!;
      const result = renderBlock(node, new HostContext())!;
      const inline = result.values[0] as TemplateResult;

      expect(inline.strings).toEqual(['<md-inline .nodeView=', '></md-inline>']);
      expect(inline.values[0]).toBe(node);
    } finally {
      document.close();
    }
  });

  test('renders md code blocks through the delegate and forwards selection state', () => {
    const node = makeCodeBlock();
    const hostContext = new HostContext();
    const renderCodeBlock = vi.fn(
      ({ node, selected }: { node: ReadonlyCodeBlockNodeView; selected: boolean }) => {
        if (node.info !== 'md') return undefined;
        // oxfmt-ignore
        return html`<md-transclusion .node=${node} .root=${new ConstructionPreviewAdapter(parseMarkdownTree(node.content)).root} ?selected=${selected}></md-transclusion>`;
      },
    );
    hostContext.renderDelegate = { renderCodeBlock };

    const unselected = renderBlock(node, hostContext)!;
    expect(renderCodeBlock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        node,
        hostContext,
        selected: false,
      }),
    );
    expect(unselected.strings).toEqual([
      '<md-transclusion .node=',
      ' .root=',
      ' ?selected=',
      '></md-transclusion>',
    ]);
    expect(unselected.values[2]).toBe(false);

    hostContext.selection.add(node);
    const selected = renderBlock(node, hostContext)!;
    expect(renderCodeBlock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        node,
        hostContext,
        selected: true,
      }),
    );
    expect(selected.values[2]).toBe(true);
  });
});
