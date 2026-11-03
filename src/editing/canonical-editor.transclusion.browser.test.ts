import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { html } from 'lit';

import { CanonicalWriter } from '../markdown/canonical-actions.js';
import { CanonicalDocument, CanonicalNode } from '../markdown/canonical-model.js';
import { ConstructionPreviewAdapter } from '../markdown/construction-preview.js';
import type { HostContext } from '../markdown/host-context.js';
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
        renderCodeBlock: ({ node, selected }) => {
          if (node.info !== 'md' && node.info !== 'outer') return undefined;
          let root = roots.get(node);
          if (!root) {
            root = getRoot(node, document);
            roots.set(node, root);
          }
          return html`<md-transclusion
            .node=${node}
            .root=${root}
            ?selected=${selected}
          ></md-transclusion>`;
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

  function caretX(inline: MarkdownInline) {
    const root = inline.getRootNode() as ShadowRoot & { getSelection: () => Selection | null };
    return root.getSelection()!.getRangeAt(0).getBoundingClientRect().x;
  }

  function nearestCaretDistance(inline: MarkdownInline, visualX: number) {
    inline.focus();
    const selection = inline.getTextSelection();
    let nearest = Infinity;
    for (let offset = 0; offset <= inline.nodeView!.content.length; offset++) {
      inline.setSelectionOffsets(offset, offset);
      nearest = Math.min(nearest, Math.abs(caretX(inline) - visualX));
    }
    if (selection) inline.setSelectionOffsets(selection.anchor, selection.focus);
    return nearest;
  }

  function expectSelection(
    context: HostContext,
    anchor: CanonicalNode,
    focus: CanonicalNode,
    selected: readonly CanonicalNode[],
  ) {
    expect((context.selectionAnchor as unknown as CanonicalNode | undefined)?.sharedId).toBe(
      anchor.sharedId,
    );
    expect((context.selectionFocus as unknown as CanonicalNode | undefined)?.sharedId).toBe(
      focus.sharedId,
    );
    expect(
      [...context.selection].map((node) => (node as unknown as CanonicalNode).sharedId).sort(),
    ).toEqual(selected.map((node) => node.sharedId).sort());
  }

  function observeKeydowns() {
    const events: KeyboardEvent[] = [];
    const listener = (event: KeyboardEvent) => events.push(event);
    document.addEventListener('keydown', listener, true);
    return {
      events,
      stop: () => document.removeEventListener('keydown', listener, true),
    };
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

    const keyboard = observeKeydowns();
    const alpha = inline('Alpha', 'outer');
    alpha.focus();
    alpha.setSelectionOffsets(5, 5);
    const alphaX = alpha.getCaretPosition().x;
    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('Inside');
    const firstInside = activeInline()!;
    const firstInsideOffset = firstInside.getTextSelection()!.focus;
    const firstInsideX = firstInside.getCaretPosition().x;
    expect(Math.abs(firstInsideX - alphaX)).toBeLessThanOrEqual(
      nearestCaretDistance(firstInside, alphaX) + 1,
    );
    firstInside.focus();
    firstInside.setSelectionOffsets(firstInsideOffset, firstInsideOffset);
    await userEvent.keyboard('X');
    await settle();
    expect(activeInline()?.nodeView?.content).toBe('Inside');
    expect(model.root.children.map((node) => node.content)).toEqual(['Alpha', 'Inside', 'Omega']);

    const omega = inline('Omega', 'outer');
    omega.focus();
    omega.setSelectionOffsets(0, 0);
    const omegaX = omega.getCaretPosition().x;
    await key('ArrowUp');
    expect(activeInline()?.nodeView?.content).toBe('Inside');
    const lastInside = activeInline()!;
    const lastInsideOffset = lastInside.getTextSelection()!.focus;
    const lastInsideX = lastInside.getCaretPosition().x;
    expect(Math.abs(lastInsideX - omegaX)).toBeLessThanOrEqual(
      nearestCaretDistance(lastInside, omegaX) + 1,
    );
    lastInside.focus();
    lastInside.setSelectionOffsets(lastInsideOffset, lastInsideOffset);

    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('Omega');
    const finalOmega = activeInline()!;
    expect(Math.abs(finalOmega.getCaretPosition().x - lastInsideX)).toBeLessThanOrEqual(
      nearestCaretDistance(finalOmega, lastInsideX) + 1,
    );
    expect(keyboard.events.map((event) => event.key)).toEqual([
      'ArrowDown',
      'X',
      'ArrowUp',
      'ArrowDown',
    ]);
    expect(keyboard.events.every((event) => event.isTrusted)).toBe(true);
    keyboard.stop();
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

    const alpha = inline('Alpha');
    alpha.focus();
    alpha.setSelectionOffsets(5, 5);
    const alphaX = alpha.getCaretPosition().x;
    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('Inside');
    const inside = activeInline()!;
    const insideX = inside.getCaretPosition().x;
    expect(Math.abs(insideX - alphaX)).toBeLessThanOrEqual(
      nearestCaretDistance(inside, alphaX) + 1,
    );
    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('Omega');
    const omega = activeInline()!;
    const omegaX = omega.getCaretPosition().x;
    expect(Math.abs(omegaX - insideX)).toBeLessThanOrEqual(
      nearestCaretDistance(omega, insideX) + 1,
    );
    await key('ArrowDown');
    expect(activeInline()?.nodeView?.content).toBe('After');
    expect(Math.abs(activeInline()!.getCaretPosition().x - omegaX)).toBeLessThanOrEqual(
      nearestCaretDistance(activeInline()!, omegaX) + 1,
    );
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

  test('selects the parent transclusion wrapper without entering its preview', async () => {
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

    const [alphaNode, codeNode, omegaNode] = model.root.children as CanonicalNode[];
    const parentContext = renderer.hostContext!;
    const keyboard = observeKeydowns();
    const inside = inline('Inside');
    const nestedContext = inside.hostContext!;
    const alpha = inline('Alpha', 'outer');
    alpha.focus();
    alpha.setSelectionOffsets(5, 5);
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    await settle();
    expect(activeInline()).toBe(alpha);
    expect(alpha.getTextSelection()).toEqual({ anchor: 5, focus: 5 });
    expectSelection(parentContext, alphaNode!, codeNode!, [alphaNode!, codeNode!]);
    expect(
      (deepElements(editor, 'md-transclusion')[0] as HTMLElementTagNameMap['md-transclusion'])
        .selected,
    ).toBe(true);
    expect(nestedContext).not.toBe(parentContext);
    expect(nestedContext.selection.size).toBe(0);

    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    await settle();
    expectSelection(parentContext, alphaNode!, omegaNode!, [alphaNode!, codeNode!, omegaNode!]);
    expect(activeInline()?.nodeView?.content).toBe('Omega');

    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    await settle();
    expectSelection(parentContext, alphaNode!, codeNode!, [alphaNode!, codeNode!]);
    expect(activeInline()?.nodeView?.content).toBe('Omega');

    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    await settle();
    expectSelection(parentContext, alphaNode!, alphaNode!, [alphaNode!]);
    expect(activeInline()?.nodeView?.content).toBe('Alpha');

    parentContext.clearSelection();
    const omega = inline('Omega', 'outer');
    omega.focus();
    omega.setSelectionOffsets(0, 0);
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    await settle();
    expectSelection(parentContext, omegaNode!, codeNode!, [codeNode!, omegaNode!]);
    expect(activeInline()).toBe(omega);
    expect(nestedContext.selection.size).toBe(0);

    const arrows = keyboard.events.filter((event) => event.key.startsWith('Arrow'));
    expect(arrows).toHaveLength(5);
    expect(arrows.every((event) => event.isTrusted && event.shiftKey)).toBe(true);
    keyboard.stop();

    parentContext.clearSelection();
    inside.focus();
    inside.setSelectionOffsets(6, 6);
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    await settle();
    expect(activeInline()).toBe(inside);
    expect(inside.getTextSelection()).toEqual({ anchor: 6, focus: 6 });
    expect(inside.hostContext?.selection.size).toBe(0);

    await userEvent.keyboard('X');
    await settle();
    expect(inline('Inside').nodeView?.content).toBe('Inside');
    expect(model.root.children.map((node) => node.content)).toEqual(['Alpha', 'Inside', 'Omega']);
  });

  test('copies and deletes the selected parent wrapper, with undo and redo', async () => {
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

    const [alphaNode, codeNode] = model.root.children as CanonicalNode[];
    const context = renderer.hostContext!;
    const keyboard = observeKeydowns();
    const alpha = inline('Alpha', 'outer');
    alpha.focus();
    alpha.setSelectionOffsets(5, 5);
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    await settle();
    expectSelection(context, alphaNode!, codeNode!, [alphaNode!, codeNode!]);

    const clipboardData = new DataTransfer();
    const copy = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clipboardData,
    });
    alpha.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(clipboardData.getData('text/plain')).toBe('Alpha\n\n```md\nInside\n```\n');
    expect(clipboardData.getData('text/markdown')).toBe('Alpha\n\n```md\nInside\n```\n');

    await userEvent.keyboard('{Backspace}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['Omega']);
    expect(alphaNode!.connected).toBe(false);
    expect(codeNode!.connected).toBe(false);
    expect(context.selection.size).toBe(0);

    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['Alpha', 'Inside', 'Omega']);
    expectSelection(context, alphaNode!, codeNode!, [alphaNode!, codeNode!]);
    expect(activeInline()?.hostContext).toBe(context);

    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['Omega']);
    expect(context.selection.size).toBe(0);
    const keyboardActions = keyboard.events.filter((event) =>
      ['ArrowDown', 'Backspace', 'z', 'y'].includes(event.key),
    );
    expect(keyboardActions.map((event) => event.key)).toEqual(['ArrowDown', 'Backspace', 'z', 'y']);
    expect(keyboardActions.every((event) => event.isTrusted)).toBe(true);
    expect(keyboardActions.slice(2).every((event) => event.ctrlKey)).toBe(true);
    keyboard.stop();
  });

  test.each(['forward', 'backward'] as const)(
    'keeps parent focus through %s wrapper deletion and history',
    async (direction) => {
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

      const [alphaNode, codeNode, omegaNode] = model.root.children as CanonicalNode[];
      const context = renderer.hostContext!;
      const start = inline(direction === 'forward' ? 'Alpha' : 'Omega', 'outer');
      const startNode = direction === 'forward' ? alphaNode! : omegaNode!;
      const selected = direction === 'forward' ? [alphaNode!, codeNode!] : [codeNode!, omegaNode!];
      const keyboard = observeKeydowns();
      const errors: unknown[] = [];
      editor.addEventListener('canonical-edit-error', (event) =>
        errors.push((event as CustomEvent).detail),
      );
      start.focus();
      start.setSelectionOffsets(direction === 'forward' ? 5 : 0, direction === 'forward' ? 5 : 0);
      await userEvent.keyboard(
        direction === 'forward' ? '{Shift>}{ArrowDown}{/Shift}' : '{Shift>}{ArrowUp}{/Shift}',
      );
      await settle();
      expect(context.selection.size).toBe(2);

      await userEvent.keyboard('{Backspace}');
      await settle();
      const deleted = direction === 'forward' ? ['Omega'] : ['Alpha'];
      expect(model.root.children.map((node) => node.content)).toEqual(deleted);
      expect(context.selection.size).toBe(0);
      expect(activeInline()?.hostContext).toBe(context);
      expect(activeInline()?.nodeView).toBe(startNode === alphaNode ? omegaNode : alphaNode);

      await userEvent.keyboard('{Control>}z{/Control}');
      await settle();
      expect(model.root.children.map((node) => node.content)).toEqual(['Alpha', 'Inside', 'Omega']);
      expectSelection(
        context,
        direction === 'forward' ? alphaNode! : omegaNode!,
        codeNode!,
        selected,
      );
      expect(activeInline()?.hostContext).toBe(context);
      expect(activeInline()?.nodeView).toBe(startNode);

      await userEvent.keyboard('{Control>}y{/Control}');
      await settle();
      expect(model.root.children.map((node) => node.content)).toEqual(deleted);
      expect(context.selection.size).toBe(0);
      expect(activeInline()?.hostContext).toBe(context);

      await userEvent.keyboard('X');
      await settle();
      expect(model.root.children.map((node) => node.content)).toEqual(
        direction === 'forward' ? ['XOmega'] : ['AlphaX'],
      );
      await userEvent.keyboard('{Control>}z{/Control}');
      await settle();
      expect(model.root.children.map((node) => node.content)).toEqual(deleted);
      await userEvent.keyboard('{Control>}z{/Control}');
      await settle();
      expect(model.root.children.map((node) => node.content)).toEqual(['Alpha', 'Inside', 'Omega']);
      await userEvent.keyboard('{Control>}y{/Control}{Control>}y{/Control}');
      await settle();
      expect(model.root.children.map((node) => node.content)).toEqual(
        direction === 'forward' ? ['XOmega'] : ['AlphaX'],
      );
      expect(errors).toEqual([]);

      const keyboardActions = keyboard.events.filter((event) =>
        ['ArrowDown', 'ArrowUp', 'Backspace', 'z', 'y', 'X'].includes(event.key),
      );
      expect(keyboardActions.every((event) => event.isTrusted)).toBe(true);
      keyboard.stop();
    },
  );

  test.each(['forward', 'backward'] as const)(
    'copies the %s selected parent range through native clipboard transfer',
    async (direction) => {
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

      const start = inline(direction === 'forward' ? 'Alpha' : 'Omega', 'outer');
      const keyboard = observeKeydowns();
      start.focus();
      start.setSelectionOffsets(direction === 'forward' ? 5 : 0, direction === 'forward' ? 5 : 0);
      await userEvent.keyboard(
        direction === 'forward' ? '{Shift>}{ArrowDown}{/Shift}' : '{Shift>}{ArrowUp}{/Shift}',
      );
      await settle();
      await userEvent.keyboard('{Control>}c{/Control}');
      const destination = document.createElement('textarea');
      document.body.append(destination);
      destination.focus();
      await userEvent.keyboard('{Control>}v{/Control}');
      expect(destination.value).toBe(
        direction === 'forward' ? 'Alpha\n\n```md\nInside\n```\n' : '```md\nInside\n```\n\nOmega\n',
      );
      expect(keyboard.events.every((event) => event.isTrusted)).toBe(true);
      keyboard.stop();
    },
  );

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

    const alpha = inline('Alpha', 'outer');
    alpha.focus();
    alpha.setSelectionOffsets(5, 5);
    const alphaX = alpha.getCaretPosition().x;
    await key('ArrowDown');
    expect(activeInline()?.nodeView).toBeInstanceOf(CanonicalNode);
    expect(activeInline()?.nodeView?.content).toBe('Editable');
    const transclusion = deepElements(
      editor,
      'md-transclusion',
    )[0] as HTMLElementTagNameMap['md-transclusion'];
    const nestedRenderer = transclusion.shadowRoot!.querySelector('md-block-render')!;
    expect(activeInline()?.hostContext).toBe(nestedRenderer.hostContext);
    const nestedInline = activeInline()!;
    const caretOffset = activeInline()!.getTextSelection()!.focus;
    expect(Math.abs(nestedInline.getCaretPosition().x - alphaX)).toBeLessThanOrEqual(
      nearestCaretDistance(nestedInline, alphaX) + 1,
    );
    expect(caretOffset).toBeGreaterThan(0);
    expect(caretOffset).toBeLessThan('Editable'.length);
    nestedInline.focus();
    nestedInline.setSelectionOffsets(caretOffset, caretOffset);
    await userEvent.keyboard('!');
    await settle();
    const editedContent = 'Editable'.slice(0, caretOffset) + '!' + 'Editable'.slice(caretOffset);
    expect(model.root.children.find((node) => node.type === 'section')?.content).toBe(
      editedContent,
    );
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children.find((node) => node.type === 'section')?.content).toBe('Editable');
    expect(activeInline()?.hostContext).toBe(nestedRenderer.hostContext);
    expect(activeInline()?.getTextSelection()).toEqual({ anchor: caretOffset, focus: caretOffset });
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model.root.children.find((node) => node.type === 'section')?.content).toBe(
      editedContent,
    );
    expect(activeInline()?.hostContext).toBe(nestedRenderer.hostContext);
    expect(activeInline()?.getTextSelection()).toEqual({
      anchor: caretOffset + 1,
      focus: caretOffset + 1,
    });
  });
});
