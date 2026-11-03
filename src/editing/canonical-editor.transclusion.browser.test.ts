import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { html } from 'lit';

import { CanonicalWriter } from '../markdown/canonical-actions.js';
import { CanonicalDocument, CanonicalNode } from '../markdown/canonical-model.js';
import { ConstructionPreviewAdapter } from '../markdown/construction-preview.js';
import { parseMarkdownTree } from '../markdown/block-parser/api.js';
import type { DocumentNode } from '../markdown/node.js';
import type { ReadonlyCodeBlockNodeView, ReadonlyMarkdownNodeView } from '../markdown/node-view.js';
import type { MarkdownRenderDelegate } from '../markdown/render-delegate.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import { CanonicalEditor } from './canonical-editor.js';
import { nextTask } from './test/lifecycle.js';

describe('canonical editor transclusion navigation', () => {
  let editor: CanonicalEditor;
  let model: CanonicalDocument;
  let writer: CanonicalWriter;
  let renderer: HTMLElementTagNameMap['md-block-render'];

  afterEach(async () => {
    editor?.remove();
    await nextTask();
    writer?.close();
    model?.close();
    window.getSelection()?.removeAllRanges();
  });

  async function settle() {
    for (let index = 0; index < 4; index++) {
      await nextTask();
      await editor.updateComplete;
      for (const element of deepElements(editor, 'md-block-render')) {
        await (element as HTMLElementTagNameMap['md-block-render']).updateComplete;
      }
      for (const element of deepElements(editor, 'md-transclusion')) {
        await (element as HTMLElementTagNameMap['md-transclusion']).updateComplete;
      }
      for (const element of deepElements(editor, 'md-inline')) {
        await (element as MarkdownInline).updateComplete;
      }
    }
    await nextTask();
  }

  async function mount(
    tree: DocumentNode,
    makeDelegate: (document: CanonicalDocument) => MarkdownRenderDelegate,
  ) {
    model = CanonicalDocument.fromTree(tree);
    editor = new CanonicalEditor();
    editor.document = model;
    writer = new CanonicalWriter(model);
    editor.writer = writer;
    editor.renderDelegate = makeDelegate(model);
    document.body.replaceChildren(editor);
    await settle();
    renderer = editor.shadowRoot!.querySelector('md-block-render')!;
  }

  function deepElements(root: Node, selector: string): Element[] {
    const found: Element[] = [];
    const visit = (node: Node) => {
      if (node instanceof Element) {
        if (node.matches(selector)) found.push(node);
        if (node.shadowRoot) visit(node.shadowRoot);
      }
      for (const child of node.childNodes) visit(child);
    };
    visit(root);
    return found;
  }

  function transclusionDelegate(
    getRoot: (
      code: ReadonlyCodeBlockNodeView,
      document: CanonicalDocument,
    ) => ReadonlyMarkdownNodeView,
  ): (document: CanonicalDocument) => MarkdownRenderDelegate {
    return (document) => {
      const roots = new WeakMap<ReadonlyCodeBlockNodeView, ReadonlyMarkdownNodeView>();
      return {
        renderCodeBlock: ({ node }) => {
          if (node.info !== 'md' && node.info !== 'outer') return undefined;
          let root = roots.get(node);
          if (!root) {
            root = getRoot(node, document);
            roots.set(node, root);
          }
          return html`<md-transclusion .node=${node} .root=${root}></md-transclusion>`;
        },
      };
    };
  }

  function previewRoot(markdown: string): ReadonlyMarkdownNodeView {
    return new ConstructionPreviewAdapter(parseMarkdownTree(markdown)).root;
  }

  function inline(content: string, context?: 'outer' | 'nested') {
    return deepElements(editor, 'md-inline')
      .map((element) => element as MarkdownInline)
      .find(
        (candidate) =>
          candidate.nodeView?.content === content &&
          (context === undefined ||
            (context === 'outer'
              ? candidate.getRootNode() === renderer.shadowRoot
              : candidate.getRootNode() !== renderer.shadowRoot)),
      )!;
  }

  function activeInline() {
    return renderer.getInlineSelection().inline;
  }

  async function key(key: string) {
    await userEvent.keyboard(`{${key}}`);
    await settle();
  }

  test('enters a read-only preview from either direction and exits it', async () => {
    const code = { type: 'code-block', info: 'md', content: 'Inside' } as const;
    await mount(
      {
        type: 'document',
        children: [
          { type: 'paragraph', content: 'Alpha' },
          code,
          { type: 'paragraph', content: 'Omega' },
        ],
      },
      transclusionDelegate((node) => previewRoot(node.content)),
    );

    inline('Alpha', 'outer').focus();
    inline('Alpha', 'outer').setSelectionOffsets(5, 5);
    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('Inside');
    expect(activeInline()?.getTextSelection()).toEqual({ anchor: 0, focus: 0 });

    inline('Omega', 'outer').focus();
    inline('Omega', 'outer').setSelectionOffsets(0, 0);
    await key('ArrowUp');
    expect(activeInline()?.nodeView?.content).toBe('Inside');
    expect(activeInline()?.getTextSelection()).toEqual({ anchor: 6, focus: 6 });

    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('Omega');
    expect(activeInline()?.getTextSelection()).toEqual({ anchor: 0, focus: 0 });
  });

  test('uses horizontal arrows to enter and leave the preview', async () => {
    const code = { type: 'code-block', info: 'md', content: 'Inside' } as const;
    await mount(
      {
        type: 'document',
        children: [
          { type: 'paragraph', content: 'Alpha' },
          code,
          { type: 'paragraph', content: 'Omega' },
        ],
      },
      transclusionDelegate((node) => previewRoot(node.content)),
    );

    inline('Alpha', 'outer').focus();
    inline('Alpha', 'outer').setSelectionOffsets(5, 5);
    await key('ArrowRight');
    expect(activeInline()?.nodeView?.content).toBe('Inside');
    expect(activeInline()?.getTextSelection()).toEqual({ anchor: 0, focus: 0 });

    await key('ArrowLeft');
    expect(activeInline()?.nodeView?.content).toBe('Alpha');
    expect(activeInline()?.getTextSelection()).toEqual({ anchor: 5, focus: 5 });
  });

  test('walks through nested transclusions and back to the outer document', async () => {
    const tree: DocumentNode = {
      type: 'document',
      children: [
        { type: 'paragraph', content: 'Before' },
        {
          type: 'code-block',
          info: 'outer',
          content: 'Alpha\n\n```md\nInside\n```\n\nOmega',
        },
        { type: 'paragraph', content: 'After' },
      ],
    };
    const roots = new WeakMap<ReadonlyCodeBlockNodeView, ReadonlyMarkdownNodeView>();
    await mount(
      tree,
      transclusionDelegate((node) => {
        let root = roots.get(node);
        if (!root) {
          root = previewRoot(node.content);
          roots.set(node, root);
        }
        return root;
      }),
    );

    inline('Alpha').focus();
    inline('Alpha').setSelectionOffsets(5, 5);
    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('Inside');
    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('Omega');
    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('After');
  });

  test('enters and leaves an empty rendered paragraph', async () => {
    await mount(
      {
        type: 'document',
        children: [
          { type: 'paragraph', content: 'Alpha' },
          { type: 'code-block', info: 'md', content: '' },
          { type: 'paragraph', content: 'Omega' },
        ],
      },
      transclusionDelegate((node) => previewRoot(node.content)),
    );

    inline('Alpha', 'outer').focus();
    inline('Alpha', 'outer').setSelectionOffsets(5, 5);
    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('');
    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('Omega');
  });

  test('does not extend a selection across host boundaries or edit preview text', async () => {
    const code = { type: 'code-block', info: 'md', content: 'Inside' } as const;
    await mount(
      {
        type: 'document',
        children: [
          { type: 'paragraph', content: 'Alpha' },
          code,
          { type: 'paragraph', content: 'Omega' },
        ],
      },
      transclusionDelegate((node) => previewRoot(node.content)),
    );

    const alpha = inline('Alpha', 'outer');
    alpha.focus();
    alpha.setSelectionOffsets(5, 5);
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    await settle();
    expect(activeInline()).toBe(alpha);
    expect(alpha.getTextSelection()).toEqual({ anchor: 5, focus: 5 });
    expect(alpha.hostContext?.selection.size).toBe(0);

    const inside = inline('Inside');
    inside.focus();
    inside.setSelectionOffsets(6, 6);
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    await settle();
    expect(activeInline()).toBe(inside);
    expect(inside.getTextSelection()).toEqual({ anchor: 6, focus: 6 });

    await userEvent.keyboard('X');
    await settle();
    expect(inline('Inside').nodeView?.content).toBe('Inside');
    expect(model.root.children.map((node) => node.content)).toEqual(['Alpha', 'Inside', 'Omega']);
  });

  test('keeps canonical nested transclusion nodes editable', async () => {
    const tree: DocumentNode = {
      type: 'document',
      children: [
        { type: 'paragraph', content: 'Alpha' },
        { type: 'code-block', info: 'md', content: 'placeholder' },
        { type: 'section', marker: '#', content: 'Editable', children: [] },
        { type: 'paragraph', content: 'Omega' },
      ],
    };
    await mount(
      tree,
      transclusionDelegate((_node, document) =>
        document.root.children.find((node) => node.type === 'section')!,
      ),
    );

    inline('Alpha', 'outer').focus();
    inline('Alpha', 'outer').setSelectionOffsets(5, 5);
    await key('ArrowDown');
    expect(activeInline()?.nodeView).toBeInstanceOf(CanonicalNode);
    expect(activeInline()?.nodeView?.content).toBe('Editable');
    const transclusion = deepElements(
      editor,
      'md-transclusion',
    )[0] as HTMLElementTagNameMap['md-transclusion'];
    const nestedRenderer = transclusion.shadowRoot!.querySelector('md-block-render')!;
    expect(activeInline()?.hostContext).toBe(nestedRenderer.hostContext);
    await userEvent.keyboard('!');
    await settle();
    expect(model.root.children.find((node) => node.type === 'section')?.content).toBe('!Editable');
  });
});
