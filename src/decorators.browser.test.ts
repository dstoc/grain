import { describe, expect, test, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import './editing/editor.js';
import { parseMarkdownTree } from './markdown/block-parser/api.js';
import { HostContext } from './markdown/host-context.js';
import { MarkdownBlock, MarkdownRenderer } from './markdown/block-render.js';
import { MarkdownSpan } from './markdown/inline-render.js';
import { sigprop } from './signal-utils.js';

describe('standard decorator behavior', () => {
  test('registers components, reflects properties, and resolves queries after update', async () => {
    for (const name of [
      'md-editor',
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
    const editor = document.createElement('md-editor');
    document.body.append(editor);
    editor.status = 'loaded';
    await editor.updateComplete;
    expect(editor.getAttribute('status')).toBe('loaded');
    editor.setAttribute('status', 'error');
    await editor.updateComplete;
    expect(editor.status).toBe('error');
    expect((editor as unknown as { markdownRenderer: MarkdownRenderer }).markdownRenderer).toBe(
      editor.shadowRoot!.querySelector('md-block-render'),
    );
    const span = document.createElement('md-span') as MarkdownSpan;
    const child = document.createElement('md-span');
    span.append(child);
    document.body.append(span);
    await span.updateComplete;
    expect(Array.from(span.spans)).toEqual([child]);
    editor.remove();
    span.remove();
  });

  test('delivers and updates subscribed context on mounted application components', async () => {
    const renderer = document.createElement('md-block-render') as MarkdownRenderer;
    renderer.block = parseMarkdownTree('hello').root;
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

  test('sigprop observes the current signal and disposes replaced and cleaned-up effects', () => {
    class Host {
      @sigprop accessor current: ReturnType<typeof signal<number>> | undefined;
      effectDispose?: () => void;
      effect = vi.fn(() => this.current?.value);
    }
    const host = new Host();
    const first = signal(1);
    const second = signal(2);
    host.current = first;
    first.value++;
    expect(host.effect).toHaveBeenCalledTimes(2);
    host.current = second;
    expect(host.effect).toHaveBeenCalledTimes(3);
    first.value++;
    expect(host.effect).toHaveBeenCalledTimes(3);
    second.value++;
    expect(host.effect).toHaveBeenCalledTimes(4);
    host.effectDispose?.();
    second.value++;
    expect(host.effect).toHaveBeenCalledTimes(4);
  });
});
