import { html, type TemplateResult } from 'lit';
import { describe, expect, test, vi } from 'vitest';

import { parseMarkdownTree } from './block-parser/api.js';
import { HostContext } from './host-context.js';
import { MarkdownBlock } from './block-render.js';
import { MarkdownTree } from './view-model.js';
import type { CodeBlockNode } from './node.js';
import type { ViewModelNode } from './view-model-node.js';

function makeCodeBlock(): ViewModelNode & CodeBlockNode {
  const tree = new MarkdownTree({
    type: 'document',
    children: [
      {
        type: 'code-block',
        info: 'md',
        content: 'transclusion target',
      },
    ],
  });
  return tree.root.children![0] as ViewModelNode & CodeBlockNode;
}

function renderBlock(node: ViewModelNode, hostContext: HostContext): TemplateResult | undefined {
  return MarkdownBlock.prototype.render.call({
    node,
    hostContext,
  } as unknown as MarkdownBlock) as TemplateResult | undefined;
}

describe('MarkdownBlock', () => {
  test('uses the default code-block path when no render delegate is provided', () => {
    const node = makeCodeBlock();
    const hostContext = new HostContext();

    const result = renderBlock(node, hostContext)!;
    const subResult = result.values[0] as TemplateResult;

    expect(subResult.strings).toEqual(['<md-inline .node=', '></md-inline>']);
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
    expect(subResult.strings).toEqual(['<md-inline .node=', '></md-inline>']);
  });

  test('renders md code blocks through the delegate and forwards selection state', () => {
    const node = makeCodeBlock();
    const hostContext = new HostContext();
    const renderCodeBlock = vi.fn(
      ({ node, selected }: { node: ViewModelNode & CodeBlockNode; selected: boolean }) => {
        if (node.info !== 'md') return undefined;
        // oxfmt-ignore
        return html`<md-transclusion .node=${node} .root=${parseMarkdownTree(node.content).root} ?selected=${selected}></md-transclusion>`;
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
