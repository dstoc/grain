import { describe, expect, test } from 'vitest';
import { nextTask } from '../editing/test/lifecycle.js';
import { createBlockParser } from './block-parser/api.js';
import { MarkdownRenderer } from './block-render.js';
import { ConstructionPreviewAdapter } from './construction-preview.js';
import { asInlineMarkdownNodeView } from './node-view.js';

describe('construction preview adapter', () => {
  test('keeps settled facade identity and refreshes provisional inline content', () => {
    const parser = createBlockParser();
    parser.push('first\n\n**bo');
    const preview = new ConstructionPreviewAdapter(parser.getTree());
    const root = preview.root;
    const first = root.children![0]!;
    const pending = root.children![1]!;
    const firstSignal = first.renderSignal.value;
    const firstInlineTree = first.inlineTree;
    const pendingInlineTree = pending.inlineTree;

    parser.push('ld**');
    preview.refresh();

    expect(preview.root).toBe(root);
    expect(root.children![0]).toBe(first);
    expect(first.renderSignal.value).toBe(firstSignal);
    expect(first.inlineTree).toBe(firstInlineTree);
    const updatedPending = root.children![1]!;
    expect(pending.connected).toBe(false);
    expect(updatedPending.id).not.toBe(pending.id);
    expect(updatedPending.inlineTree).not.toBe(pendingInlineTree);
    expect(updatedPending.content).toBe('**bold**');
  });

  test('invalidates the lazy inline parse tree when a projected paragraph changes in place', () => {
    const parser = createBlockParser();
    parser.push('alpha\nbe');
    const preview = new ConstructionPreviewAdapter(parser.getTree());
    const root = preview.root;
    const paragraph = root.children![0]!;
    const originalTree = paragraph.inlineTree;
    const originalSignal = paragraph.renderSignal.value;

    parser.push('ta');
    preview.refresh();

    expect(root.children![0]).toBe(paragraph);
    expect(paragraph.content).toBe('alpha\nbeta');
    expect(paragraph.inlineTree).not.toBe(originalTree);
    expect(paragraph.renderSignal.value).toBeGreaterThan(originalSignal);
  });

  test('updates a mounted renderer as a live parser publishes changed records', async () => {
    const parser = createBlockParser();
    parser.push('streamed');
    const preview = new ConstructionPreviewAdapter(parser.getTree());
    const renderer = new MarkdownRenderer();
    renderer.block = preview.root;
    document.body.append(renderer);
    await nextTask();
    let inline = renderer.shadowRoot!.querySelector('md-inline')!;
    await inline.updateComplete;
    expect(inline.textContent).toBe('streamed');

    parser.push(' content');
    preview.refresh();
    await nextTask();
    inline = renderer.shadowRoot!.querySelector('md-inline')!;
    await inline.updateComplete;
    expect(inline.nodeView).toBe(asInlineMarkdownNodeView(preview.root.children![0]!));
    expect(inline.textContent).toBe('streamed content');
    renderer.remove();
  });
});
