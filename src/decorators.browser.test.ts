import { describe, expect, test } from 'vitest';
import { parseMarkdownTree } from './markdown/block-parser/api.js';
import { ConstructionPreviewAdapter } from './markdown/construction-preview.js';
import { HostContext } from './markdown/host-context.js';
import './markdown/block-render.js';
import './markdown/inline-render.js';
import { MarkdownBlock, MarkdownRenderer } from './markdown/block-render.js';
import { MarkdownSpan } from './markdown/inline-render.js';

describe('standard decorator behavior', () => {
  test('registers components, reflects properties, and resolves queries after update', async () => {
    for (const name of [
      'md-block-render',
      'md-block',
      'md-inline',
      'md-span',
      'md-transclusion',
      'md-section-ui',
      'md-list-item-ui',
    ]) {
      expect(customElements.get(name)).toBeDefined();
    }
    const span = document.createElement('md-span') as MarkdownSpan;
    const child = document.createElement('md-span');
    span.append(child);
    document.body.append(span);
    await span.updateComplete;
    expect(Array.from(span.spans)).toEqual([child]);
    span.remove();
  });

  test('delivers and updates subscribed context on mounted application components', async () => {
    const renderer = document.createElement('md-block-render') as MarkdownRenderer;
    renderer.block = new ConstructionPreviewAdapter(parseMarkdownTree('hello')).root;
    document.body.append(renderer);
    await renderer.updateComplete;
    const block = renderer.shadowRoot!.querySelector('md-block') as MarkdownBlock;
    await block.updateComplete;
    expect(block.hostContext).toBe(renderer.hostContext);
    const replacement = new HostContext();
    renderer.hostContext = replacement;
    await block.updateComplete;
    expect(block.hostContext).toBe(replacement);
    renderer.remove();
  });
});
