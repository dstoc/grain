import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';

import { CanonicalWriter } from '../markdown/canonical-actions.js';
import type { AcceptedAction, ActionRequest } from '../markdown/canonical-actions.js';
import { CanonicalDocument, CanonicalNode } from '../markdown/canonical-model.js';
import type { HostContext } from '../markdown/host-context.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import { asInlineMarkdownNodeView } from '../markdown/node-view.js';
import { insertParagraph } from './commands/insert-paragraph.js';
import { joinWithPrevious } from './commands/join-with-previous.js';
import { prepareEdit } from './prepare-edit.js';
import { CanonicalEditor } from './canonical-editor.js';
import { nextTask } from './test/lifecycle.js';

describe('CanonicalEditor in Chromium', () => {
  let editor: CanonicalEditor | undefined;
  let document: CanonicalDocument | undefined;
  let writer: CanonicalWriter | undefined;

  afterEach(async () => {
    editor?.remove();
    await nextTask();
    writer?.close();
    document?.close();
    editor = undefined;
    writer = undefined;
    document = undefined;
    window.getSelection()?.removeAllRanges();
  });

  async function mount(markdown: string, sessionId = 'local') {
    window.getSelection()?.removeAllRanges();
    document = CanonicalDocument.fromMarkdown(markdown);
    writer = new CanonicalWriter(document);
    editor = new CanonicalEditor();
    editor.document = document;
    editor.writer = writer;
    editor.sessionId = sessionId;
    editor.style.width = '390px';
    editor.style.display = 'block';
    window.document.body.replaceChildren(editor);
    await nextTask();
    const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
    await renderer.updateComplete;
    const inline = (renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline)!;
    await inline.updateComplete;
    return { editor, renderer, inline };
  }

  async function deliverRemote(
    prepare: (
      replica: CanonicalDocument,
      remoteWriter: CanonicalWriter,
    ) => ActionRequest | undefined,
  ) {
    const current = document!;
    const replica = CanonicalDocument.open(current.checkpoint());
    const remoteWriter = new CanonicalWriter(replica);
    try {
      remoteWriter.admitSession('remote');
      const request = prepare(replica, remoteWriter);
      if (!request) throw new Error('remote command was not applicable');
      const result = remoteWriter.apply(request, {
        sessionId: request.sessionId,
        authorityEpoch: request.authorityEpoch,
        sessionSequence: request.sessionSequence,
      });
      const accepted =
        result.status === 'pending'
          ? remoteWriter.publish(result.pending)
          : result.status === 'duplicate'
            ? result.accepted
            : undefined;
      if (!accepted) throw new Error(`remote action was not accepted: ${result.status}`);
      current.applyAccepted({ revision: accepted.revision, update: accepted.update });
    } finally {
      remoteWriter.close();
      replica.close();
    }
    await nextTask();
    await editor!.updateComplete;
    await editor!.shadowRoot!.querySelector('md-block-render')!.updateComplete;
    await nextTask();
  }

  async function settle(mounted: Awaited<ReturnType<typeof mount>>) {
    await nextTask();
    await mounted.editor.updateComplete;
    await mounted.renderer.updateComplete;
    await Promise.all(
      [...mounted.renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].map(
        (inline) => inline.updateComplete,
      ),
    );
    await nextTask();
  }

  function inlineFor(renderer: HTMLElement, node: CanonicalNode): MarkdownInline {
    const inline = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].find(
      (candidate) =>
        (candidate.nodeView as unknown as CanonicalNode | undefined)?.sharedId === node.sharedId,
    );
    if (!inline) throw new Error(`no inline renderer for ${node.sharedId}`);
    return inline;
  }

  function inlineWithText(root: CanonicalNode, text: string): CanonicalNode {
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.content === text) return node;
      pending.push(...node.children);
    }
    throw new Error(`no inline node with text ${text}`);
  }

  function containingListOwner(node: CanonicalNode): CanonicalNode | undefined {
    const item = node.parent;
    const list = item?.parent;
    const owner = list?.parent;
    return item?.type === 'list-item' && list?.type === 'list' && owner?.type === 'list-item'
      ? owner
      : undefined;
  }

  function expectCaret(inline: MarkdownInline, node: CanonicalNode, offset: number) {
    expect(inline.nodeView).toBe(node);
    expect(inline.matches(':focus')).toBe(true);
    expect(inline.getTextSelection()).toEqual({ anchor: offset, focus: offset });
  }

  function expectBlockSelection(
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
    expect(
      [...context.selection].every((node) => (node as unknown as CanonicalNode).connected),
    ).toBe(true);
  }

  async function shiftArrow(
    key: 'ArrowUp' | 'ArrowDown',
    mounted: Awaited<ReturnType<typeof mount>>,
  ) {
    await userEvent.keyboard(`{Shift>}{${key}}{/Shift}`);
    await settle(mounted);
  }

  test.each(['backward', 'forward'] as const)(
    'Shift+Arrow %s initializes an inclusive range and preserves its anchor while extending and contracting',
    async (direction) => {
      const mounted = await mount('Alpha\n\nBeta\n\nGamma\n\nDelta');
      const [alpha, beta, gamma, delta] = document!.root.children as CanonicalNode[];
      const context = mounted.renderer.hostContext;
      const start = direction === 'backward' ? gamma! : beta!;
      const startInline = inlineFor(mounted.renderer, start);
      const offset = direction === 'backward' ? 0 : (start.content ?? '').length;
      startInline.focus();
      startInline.setSelectionOffsets(offset, offset);

      const initialKey = direction === 'backward' ? 'ArrowUp' : 'ArrowDown';
      const oppositeKey = direction === 'backward' ? 'ArrowDown' : 'ArrowUp';
      await shiftArrow(initialKey, mounted);
      expectBlockSelection(
        context,
        direction === 'backward' ? gamma! : beta!,
        direction === 'backward' ? beta! : gamma!,
        [beta!, gamma!],
      );
      expect(inlineFor(mounted.renderer, beta!).selected).toBe(true);
      expect(inlineFor(mounted.renderer, gamma!).selected).toBe(true);

      await shiftArrow(initialKey, mounted);
      expectBlockSelection(
        context,
        direction === 'backward' ? gamma! : beta!,
        direction === 'backward' ? alpha! : delta!,
        direction === 'backward' ? [alpha!, beta!, gamma!] : [beta!, gamma!, delta!],
      );

      await shiftArrow(oppositeKey, mounted);
      expectBlockSelection(
        context,
        direction === 'backward' ? gamma! : beta!,
        direction === 'backward' ? beta! : gamma!,
        [beta!, gamma!],
      );

      await shiftArrow(oppositeKey, mounted);
      expectBlockSelection(
        context,
        direction === 'backward' ? gamma! : beta!,
        direction === 'backward' ? gamma! : beta!,
        [direction === 'backward' ? gamma! : beta!],
      );

      await shiftArrow(initialKey, mounted);
      expectBlockSelection(
        context,
        direction === 'backward' ? gamma! : beta!,
        direction === 'backward' ? beta! : gamma!,
        [beta!, gamma!],
      );
    },
  );

  test('Backspace removes the selected edge blocks and focuses the next block through undo and redo', async () => {
    const mounted = await mount('Alpha\n\nBeta\n\nGamma');
    const [alpha, beta, gamma] = document!.root.children as CanonicalNode[];
    const context = mounted.renderer.hostContext;
    const betaInline = inlineFor(mounted.renderer, beta!);
    betaInline.focus();
    betaInline.setSelectionOffsets(2, 2);
    await shiftArrow('ArrowUp', mounted);
    expectBlockSelection(context, beta!, alpha!, [alpha!, beta!]);

    await userEvent.keyboard('{Backspace}');
    await settle(mounted);
    expect(document!.root.children.map((node) => node.content)).toEqual(['Gamma']);
    expect(alpha!.connected).toBe(false);
    expect(beta!.connected).toBe(false);
    expect(gamma!.connected).toBe(true);
    let focused = mounted.renderer.getInlineSelection().inline!;
    expect((focused.nodeView as unknown as CanonicalNode).sharedId).toBe(gamma!.sharedId);
    expect(focused.getTextSelection()).toEqual({ anchor: 0, focus: 0 });

    await userEvent.keyboard('{Control>}z{/Control}');
    await settle(mounted);
    expect(document!.root.children.map((node) => node.content)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expectBlockSelection(context, beta!, alpha!, [alpha!, beta!]);

    await userEvent.keyboard('{Control>}y{/Control}');
    await settle(mounted);
    expect(document!.root.children.map((node) => node.content)).toEqual(['Gamma']);
    expect(context.selection.size).toBe(0);
    focused = mounted.renderer.getInlineSelection().inline!;
    expect((focused.nodeView as unknown as CanonicalNode).sharedId).toBe(gamma!.sharedId);
    expect(focused.getTextSelection()).toEqual({ anchor: 0, focus: 0 });
    expect(gamma!.connected).toBe(true);
  });

  test('Delete removes a middle range and restores its direction and predecessor caret', async () => {
    const mounted = await mount('Alpha\n\nBeta\n\nGamma\n\nDelta');
    const [alpha, beta, gamma, delta] = document!.root.children as CanonicalNode[];
    const context = mounted.renderer.hostContext;
    const betaView = asInlineMarkdownNodeView(beta!);
    const gammaView = asInlineMarkdownNodeView(gamma!);
    context.selection.add(betaView);
    context.selection.add(gammaView);
    context.selectionAnchor = betaView;
    context.selectionFocus = gammaView;
    inlineFor(mounted.renderer, gamma!).focus();

    await userEvent.keyboard('{Delete}');
    await settle(mounted);
    expect(document!.root.children.map((node) => node.content)).toEqual(['Alpha', 'Delta']);
    expect(alpha!.connected).toBe(true);
    expect(beta!.connected).toBe(false);
    expect(gamma!.connected).toBe(false);
    expect(delta!.connected).toBe(true);
    let focused = mounted.renderer.getInlineSelection().inline!;
    expect((focused.nodeView as unknown as CanonicalNode).sharedId).toBe(alpha!.sharedId);
    expect(focused.getTextSelection()).toEqual({ anchor: 5, focus: 5 });

    await userEvent.keyboard('{Control>}z{/Control}');
    await settle(mounted);
    expect(document!.root.children.map((node) => node.content)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
    ]);
    expectBlockSelection(context, beta!, gamma!, [beta!, gamma!]);

    await userEvent.keyboard('{Control>}y{/Control}');
    await settle(mounted);
    expect(document!.root.children.map((node) => node.content)).toEqual(['Alpha', 'Delta']);
    focused = mounted.renderer.getInlineSelection().inline!;
    expect((focused.nodeView as unknown as CanonicalNode).sharedId).toBe(alpha!.sharedId);
    expect(focused.getTextSelection()).toEqual({ anchor: 5, focus: 5 });
  });

  test('cut removes selected blocks, focuses the next block, and restores the reversed range on undo', async () => {
    const mounted = await mount('Alpha\n\nBeta\n\nGamma');
    const [alpha, beta, gamma] = document!.root.children as CanonicalNode[];
    const context = mounted.renderer.hostContext;
    const alphaView = asInlineMarkdownNodeView(alpha!);
    const betaView = asInlineMarkdownNodeView(beta!);
    context.selection.add(alphaView);
    context.selection.add(betaView);
    context.selectionAnchor = betaView;
    context.selectionFocus = alphaView;
    const alphaInline = inlineFor(mounted.renderer, alpha!);
    alphaInline.focus();
    const clipboardData = new DataTransfer();

    alphaInline.dispatchEvent(
      new ClipboardEvent('cut', {
        bubbles: true,
        composed: true,
        cancelable: true,
        clipboardData,
      }),
    );
    await settle(mounted);
    expect(clipboardData.getData('text/plain')).toBe('Alpha\n\nBeta\n');
    expect(document!.root.children.map((node) => node.content)).toEqual(['Gamma']);
    expect(alpha!.connected).toBe(false);
    expect(beta!.connected).toBe(false);
    let focused = mounted.renderer.getInlineSelection().inline!;
    expect((focused.nodeView as unknown as CanonicalNode).sharedId).toBe(gamma!.sharedId);
    expect(focused.getTextSelection()).toEqual({ anchor: 0, focus: 0 });

    await userEvent.keyboard('{Control>}z{/Control}');
    await settle(mounted);
    expectBlockSelection(context, beta!, alpha!, [alpha!, beta!]);

    await userEvent.keyboard('{Control>}y{/Control}');
    await settle(mounted);
    expect(document!.root.children.map((node) => node.content)).toEqual(['Gamma']);
    focused = mounted.renderer.getInlineSelection().inline!;
    expect((focused.nodeView as unknown as CanonicalNode).sharedId).toBe(gamma!.sharedId);
  });

  test('deletes nested list blocks without disturbing their surrounding empty block or identities', async () => {
    const mounted = await mount('* First\n* Alpha\n* Beta\n* <!-- -->\n* Last\n\nOutside');
    const list = document!.root.children[0]!;
    expect(list.type).toBe('list');
    const [firstItem, alphaItem, betaItem, emptyItem, lastItem] = list.children as CanonicalNode[];
    const [first] = firstItem!.children as CanonicalNode[];
    const [alpha] = alphaItem!.children as CanonicalNode[];
    const [beta] = betaItem!.children as CanonicalNode[];
    const [empty] = emptyItem!.children as CanonicalNode[];
    const [last] = lastItem!.children as CanonicalNode[];
    const context = mounted.renderer.hostContext;
    const alphaView = asInlineMarkdownNodeView(alpha!);
    const betaView = asInlineMarkdownNodeView(beta!);
    context.selection.add(alphaView);
    context.selection.add(betaView);
    context.selectionAnchor = betaView;
    context.selectionFocus = alphaView;
    inlineFor(mounted.renderer, beta!).focus();

    await userEvent.keyboard('{Backspace}');
    await settle(mounted);
    expect(list.children).toHaveLength(3);
    expect(list.children.map((item) => item.children[0]!.content)).toEqual(['First', '', 'Last']);
    expect(list.children[0]!.children[0]).toBe(first);
    expect(list.children[1]!.children[0]).toBe(empty);
    expect(list.children[2]!.children[0]).toBe(last);
    expect(alpha!.connected).toBe(false);
    expect(beta!.connected).toBe(false);
    const focused = mounted.renderer.getInlineSelection().inline!;
    expect((focused.nodeView as unknown as CanonicalNode).sharedId).toBe(first!.sharedId);
    expect(focused.getTextSelection()).toEqual({ anchor: 5, focus: 5 });

    await userEvent.keyboard('{Control>}z{/Control}');
    await settle(mounted);
    expectBlockSelection(context, beta!, alpha!, [alpha!, beta!]);
    expect(list.children[3]!.children[0]).toBe(empty);
    expect(list.children[4]!.children[0]).toBe(last);
  });

  test('deleting a section heading promotes its children and focuses surviving content', async () => {
    const mounted = await mount('Before\n\n# Title\n\nBody\n\n# Later\n\nAfter');
    const [before, section, after] = document!.root.children as CanonicalNode[];
    expect(section!.type).toBe('section');
    const [body] = section!.children as CanonicalNode[];
    const context = mounted.renderer.hostContext;
    const sectionView = asInlineMarkdownNodeView(section!);
    context.selection.add(sectionView);
    context.selectionAnchor = sectionView;
    context.selectionFocus = sectionView;
    inlineFor(mounted.renderer, section!).focus();

    await userEvent.keyboard('{Backspace}');
    await settle(mounted);
    expect(document!.root.children.map((node) => [node.type, node.content])).toEqual([
      ['paragraph', 'Before'],
      ['paragraph', 'Body'],
      ['section', 'Later'],
    ]);
    expect(before!.connected).toBe(true);
    expect(section!.connected).toBe(false);
    expect(body!.connected).toBe(true);
    expect(after!.connected).toBe(true);
    expect(document!.root.children[1]).toBe(body);
    let focused = mounted.renderer.getInlineSelection().inline!;
    expect((focused.nodeView as unknown as CanonicalNode).sharedId).toBe(before!.sharedId);
    expect(focused.getTextSelection()).toEqual({ anchor: 6, focus: 6 });

    await userEvent.keyboard('{Control>}z{/Control}');
    await settle(mounted);
    expectBlockSelection(context, section!, section!, [section!]);
    expect(section!.children[0]).toBe(body);

    await userEvent.keyboard('{Control>}y{/Control}');
    await settle(mounted);
    expect(document!.root.children[1]).toBe(body);
    focused = mounted.renderer.getInlineSelection().inline!;
    expect((focused.nodeView as unknown as CanonicalNode).sharedId).toBe(before!.sharedId);
  });

  test('Shift+Up selection replacement is undone and redone with the correct block range', async () => {
    const mounted = await mount('Alpha\n\nBeta\n\nGamma');
    const [alpha, beta, gamma] = document!.root.children as CanonicalNode[];
    const context = mounted.renderer.hostContext;
    const betaInline = inlineFor(mounted.renderer, beta!);
    betaInline.focus();
    betaInline.setSelectionOffsets(2, 2);
    await shiftArrow('ArrowUp', mounted);
    expectBlockSelection(context, beta!, alpha!, [alpha!, beta!]);

    await userEvent.keyboard('X');
    await settle(mounted);
    expect(document!.root.children.map((node) => node.content)).toEqual(['X', 'Gamma']);

    await userEvent.keyboard('{Control>}z{/Control}');
    await settle(mounted);
    expect(document!.root.children.map((node) => node.content)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expectBlockSelection(context, beta!, alpha!, [alpha!, beta!]);

    await userEvent.keyboard('{Control>}y{/Control}');
    await settle(mounted);
    expect(document!.root.children.map((node) => node.content)).toEqual(['X', 'Gamma']);
    expect(context.selection.size).toBe(0);
    expect(gamma!.connected).toBe(true);
  });

  test('routes browser text, undo and redo through the canonical session coordinator', async () => {
    const mounted = await mount('alpha');
    const node = document!.root.children[0]!;
    expect(mounted.inline.nodeView).toBe(node);
    expect('node' in mounted.inline).toBe(false);
    mounted.inline.focus();
    mounted.inline.setSelectionOffsets(5, 5);

    await userEvent.keyboard('!');
    await nextTask();
    expect(node.content).toBe('alpha!');
    expect(writer!.canUndo('local', node.sharedId)).toBe(true);
    expect(writer!.canUndo('local', document!.root.sharedId)).toBe(true);

    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(node.content).toBe('alpha');
    expect(mounted.inline.getTextSelection()).toEqual({ anchor: 5, focus: 5 });

    await userEvent.keyboard('{Control>}y{/Control}');
    await nextTask();
    expect(node.content).toBe('alpha!');
    expect(mounted.inline.getTextSelection()).toEqual({ anchor: 6, focus: 6 });
  });

  test.each([
    { direction: 'indent' as const, offset: 0 },
    { direction: 'indent' as const, offset: 2 },
    { direction: 'indent' as const, offset: 4 },
    { direction: 'outdent' as const, offset: 0 },
    { direction: 'outdent' as const, offset: 2 },
    { direction: 'outdent' as const, offset: 4 },
  ])(
    'preserves a collapsed caret at $offset through $direction, history, and typing',
    async ({ direction, offset }) => {
      const source =
        direction === 'indent' ? '- Alpha\n- Beta\n- Gamma' : '- Alpha\n  - Beta\n- Gamma';
      const mounted = await mount(source);
      const target = inlineWithText(document!.root, 'Beta');
      const inline = inlineFor(mounted.renderer, target);
      const originalOwnerId = containingListOwner(target)?.sharedId;
      let trustedTab = false;
      inline.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') trustedTab = event.isTrusted;
      });
      inline.focus();
      inline.setSelectionOffsets(offset, offset);

      await userEvent.keyboard(direction === 'indent' ? '{Tab}' : '{Shift>}{Tab}{/Shift}');
      await settle(mounted);

      expect(trustedTab).toBe(true);
      expect(containingListOwner(target)?.sharedId).not.toBe(originalOwnerId);
      expectCaret(inlineFor(mounted.renderer, target), target, offset);

      await userEvent.keyboard('{Control>}z{/Control}');
      await settle(mounted);
      expect(containingListOwner(target)?.sharedId).toBe(originalOwnerId);
      expectCaret(inlineFor(mounted.renderer, target), target, offset);

      await userEvent.keyboard('{Control>}y{/Control}');
      await settle(mounted);
      expect(containingListOwner(target)?.sharedId).not.toBe(originalOwnerId);
      expectCaret(inlineFor(mounted.renderer, target), target, offset);

      await userEvent.keyboard('X');
      await settle(mounted);
      expect(target.content).toBe(`Beta`.slice(0, offset) + 'X' + `Beta`.slice(offset));
      expect(inlineFor(mounted.renderer, target).getTextSelection()).toEqual({
        anchor: offset + 1,
        focus: offset + 1,
      });
    },
  );

  test.each([
    { direction: 'indent' as const, anchor: 1, focus: 3 },
    { direction: 'indent' as const, anchor: 3, focus: 1 },
    { direction: 'outdent' as const, anchor: 1, focus: 3 },
    { direction: 'outdent' as const, anchor: 3, focus: 1 },
  ])(
    'collapses a $direction text range to its ordered start through history',
    async ({ direction, anchor, focus }) => {
      const source =
        direction === 'indent' ? '- Alpha\n- Beta\n- Gamma' : '- Alpha\n  - Beta\n- Gamma';
      const mounted = await mount(source);
      const target = inlineWithText(document!.root, 'Beta');
      const inline = inlineFor(mounted.renderer, target);
      inline.focus();
      inline.setSelectionOffsets(anchor, focus);

      await userEvent.keyboard(direction === 'indent' ? '{Tab}' : '{Shift>}{Tab}{/Shift}');
      await settle(mounted);
      expectCaret(inlineFor(mounted.renderer, target), target, 1);

      await userEvent.keyboard('{Control>}z{/Control}');
      await settle(mounted);
      expectCaret(inlineFor(mounted.renderer, target), target, 1);

      await userEvent.keyboard('{Control>}y{/Control}');
      await settle(mounted);
      expectCaret(inlineFor(mounted.renderer, target), target, 1);
    },
  );

  test.each([
    { direction: 'indent' as const, text: 'Gamma' },
    { direction: 'outdent' as const, text: 'Beta' },
  ])(
    '$direction keeps the caret inside a nested list in a block quote',
    async ({ direction, text }) => {
      const mounted = await mount('> - Alpha\n>   - Beta\n>   - Gamma');
      const target = inlineWithText(document!.root, text);
      const inline = inlineFor(mounted.renderer, target);
      const originalOwnerId = containingListOwner(target)?.sharedId;
      inline.focus();
      inline.setSelectionOffsets(2, 2);

      await userEvent.keyboard(direction === 'indent' ? '{Tab}' : '{Shift>}{Tab}{/Shift}');
      await settle(mounted);
      expect(containingListOwner(target)?.sharedId).not.toBe(originalOwnerId);
      expectCaret(inlineFor(mounted.renderer, target), target, 2);

      await userEvent.keyboard('{Control>}z{/Control}');
      await settle(mounted);
      expect(containingListOwner(target)?.sharedId).toBe(originalOwnerId);
      expectCaret(inlineFor(mounted.renderer, target), target, 2);

      await userEvent.keyboard('{Control>}y{/Control}');
      await settle(mounted);
      expect(containingListOwner(target)?.sharedId).not.toBe(originalOwnerId);
      expectCaret(inlineFor(mounted.renderer, target), target, 2);
    },
  );

  test('keeps block-selection indent behavior and selection through undo and redo', async () => {
    const mounted = await mount('- Alpha\n- Beta\n- Gamma');
    const target = inlineWithText(document!.root, 'Beta');
    const context = mounted.renderer.hostContext;
    const selected = asInlineMarkdownNodeView(target);
    context.selection.add(selected);
    context.selectionAnchor = selected;
    context.selectionFocus = selected;
    const inline = inlineFor(mounted.renderer, target);
    inline.focus();
    inline.setSelectionOffsets(2, 2);

    await userEvent.keyboard('{Tab}');
    await settle(mounted);
    expect(containingListOwner(target)).toBeDefined();
    expectBlockSelection(context, target, target, [target]);

    await userEvent.keyboard('{Control>}z{/Control}');
    await settle(mounted);
    expect(containingListOwner(target)).toBeUndefined();
    expectBlockSelection(context, target, target, [target]);

    await userEvent.keyboard('{Control>}y{/Control}');
    await settle(mounted);
    expect(containingListOwner(target)).toBeDefined();
    expectBlockSelection(context, target, target, [target]);
  });

  test('admits the configured session when replacing the writer', async () => {
    const mounted = await mount('alpha', 'review-custom-session');
    const previousDocument = document!;
    const previousWriter = writer!;
    const replacementDocument = CanonicalDocument.fromMarkdown('alpha');
    const replacementWriter = new CanonicalWriter(replacementDocument);
    document = replacementDocument;
    writer = replacementWriter;
    editor!.document = replacementDocument;
    editor!.writer = replacementWriter;
    await nextTask();
    await editor!.updateComplete;
    await editor!.shadowRoot!.querySelector('md-block-render')!.updateComplete;
    previousWriter.close();
    previousDocument.close();

    const inline = mounted.renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
    inline.focus();
    inline.setSelectionOffsets(5, 5);
    await userEvent.keyboard('!');
    await nextTask();

    expect(replacementDocument.root.children[0]!.content).toBe('alpha!');
    expect(inline.getTextSelection()).toEqual({ anchor: 6, focus: 6 });
  });

  test('admits the configured session when a writer is assigned later', async () => {
    window.getSelection()?.removeAllRanges();
    document = CanonicalDocument.fromMarkdown('alpha');
    editor = new CanonicalEditor();
    editor.document = document;
    editor.sessionId = 'review-delayed-session';
    editor.style.width = '390px';
    editor.style.display = 'block';
    window.document.body.replaceChildren(editor);
    await nextTask();
    await editor.updateComplete;

    writer = new CanonicalWriter(document);
    editor.writer = writer;
    await nextTask();
    await editor.updateComplete;
    const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
    await renderer.updateComplete;
    const inline = renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
    inline.focus();
    inline.setSelectionOffsets(5, 5);
    await userEvent.keyboard('!');
    await nextTask();

    expect(document.root.children[0]!.content).toBe('alpha!');
    expect(inline.getTextSelection()).toEqual({ anchor: 6, focus: 6 });
  });

  test('attributes a checkbox action to the configured nondefault session', async () => {
    const mounted = await mount('1. [ ] task', 'review-custom-session');
    const listItem = document!.root.children[0]!.children[0]!;
    if (listItem.type !== 'list-item') throw new Error('expected a parsed list item');
    const listItemBlock = [...mounted.renderer.shadowRoot!.querySelectorAll('md-block')].find(
      (block) =>
        (block as unknown as { node?: CanonicalNode }).node?.sharedId === listItem.sharedId,
    );
    const button = listItemBlock?.shadowRoot
      ?.querySelector('md-list-item-ui')
      ?.shadowRoot?.querySelector('button');

    expect(button).toBeDefined();
    await userEvent.click(button!);
    await nextTask();

    expect(listItem.checked).toBe(true);
    expect({
      configuredSession: writer!.canUndo('review-custom-session', document!.root.sharedId),
      defaultSession: writer!.canUndo('local', document!.root.sharedId),
    }).toEqual({ configuredSession: true, defaultSession: false });
  });

  test('seals typing after an accepted child-list-only structural effect', async () => {
    const mounted = await mount('alpha\n\nbeta');
    const first = document!.root.children[0]!;
    if (first.type !== 'paragraph') throw new Error('expected a parsed paragraph');
    mounted.inline.focus();
    mounted.inline.setSelectionOffsets(first.content!.length, first.content!.length);
    await userEvent.keyboard('!');
    await nextTask();

    const replica = CanonicalDocument.open(document!.checkpoint());
    const replicaWriter = new CanonicalWriter(replica);
    let accepted: AcceptedAction;
    try {
      const result = replicaWriter.edit(
        { actionId: 'child-list-only-effect', sessionId: 'remote' },
        (draft) => draft.place(replica.root.children[0]!.sharedId, replica.root.sharedId, null),
      );
      if (!('receipt' in result)) throw new Error('expected a child-list-only accepted action');
      accepted = result;
      expect(accepted.receipt.structuralPatch.childLists.length).toBeGreaterThan(0);
      expect(accepted.receipt.structuralPatch.cells).toHaveLength(0);
      expect(accepted.receipt.structuralPatch.births).toHaveLength(0);
    } finally {
      replicaWriter.close();
      replica.close();
    }

    // Keep the active document unchanged while sending a real child-list-only receipt through the handler.
    const accept = (editor as unknown as { onAccepted(action: AcceptedAction): void }).onAccepted;
    accept.call(editor, accepted);
    await nextTask();
    mounted.inline.focus();
    mounted.inline.setSelectionOffsets(first.content!.length, first.content!.length);
    await userEvent.keyboard('?');
    await nextTask();
    expect(first.content).toBe('alpha!?');

    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(first.content).toBe('alpha!');
  });

  test('preserves a reversed text selection while replacing it and restores caret on undo', async () => {
    const mounted = await mount('abcdef');
    const node = document!.root.children[0]!;
    mounted.inline.focus();
    mounted.inline.setSelectionOffsets(5, 2);

    await userEvent.keyboard('X');
    await nextTask();
    expect(node.content).toBe('abXf');
    expect(mounted.inline.getTextSelection()).toEqual({ anchor: 3, focus: 3 });

    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(node.content).toBe('abcdef');
    expect(mounted.inline.getTextSelection()).toEqual({ anchor: 2, focus: 2 });
  });

  test('commits composition as one isolated history entry and recovers its caret', async () => {
    const mounted = await mount('alpha');
    const node = document!.root.children[0]!;
    mounted.inline.focus();
    mounted.inline.setSelectionOffsets(5, 5);
    mounted.inline.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true, composed: true, data: '' }),
    );
    mounted.inline.textContent = 'alpha漢';
    mounted.inline.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, composed: true, data: '漢' }),
    );
    await nextTask();
    await nextTask();

    expect(node.content).toBe('alpha漢');
    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(node.content).toBe('alpha');
    await userEvent.keyboard('{Control>}y{/Control}');
    await nextTask();
    expect(node.content).toBe('alpha漢');
  });

  test('restores block selection direction after replacing selected blocks and undoing', async () => {
    const mounted = await mount('alpha\n\nbeta');
    const [first, last] = document!.root.children as CanonicalNode[];
    const firstView = asInlineMarkdownNodeView(first);
    const lastView = asInlineMarkdownNodeView(last);
    const context = mounted.renderer.hostContext;
    context.selection.add(firstView);
    context.selection.add(lastView);
    context.selectionAnchor = lastView;
    context.selectionFocus = firstView;
    mounted.inline.focus();

    await userEvent.keyboard('X');
    await nextTask();
    expect(document!.root.children.map((node) => node.content)).toEqual(['X']);

    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(document!.root.children.map((node) => node.content)).toEqual(['alpha', 'beta']);
    expect(context.selection.size).toBe(2);
    expect((context.selectionAnchor as unknown as CanonicalNode).sharedId).toBe(last.sharedId);
    expect((context.selectionFocus as unknown as CanonicalNode).sharedId).toBe(first.sharedId);
    expect((context.selectionAnchor as unknown as CanonicalNode).connected).toBe(true);
    expect((context.selectionFocus as unknown as CanonicalNode).connected).toBe(true);

    await userEvent.keyboard('{Control>}y{/Control}');
    await nextTask();
    expect(document!.root.children.map((node) => node.content)).toEqual(['X']);
    expect(context.selection.size).toBe(0);
    expect(context.selectionAnchor).toBeUndefined();
    expect(context.selectionFocus).toBeUndefined();
    const redoInline = mounted.renderer.getInlineSelection().inline!;
    const redoFocus = redoInline.nodeView as unknown as CanonicalNode;
    expect(redoFocus.sharedId).toBe(first.sharedId);
    expect(redoFocus.connected).toBe(true);
    expect(redoInline.getTextSelection()).toEqual({ anchor: 1, focus: 1 });
  });

  test('retains the unaffected rendered block facade and element during input', async () => {
    const mounted = await mount('first\n\nsecond');
    const nodes = document!.root.children as CanonicalNode[];
    const blocks = [...mounted.renderer.shadowRoot!.querySelectorAll('md-block')];
    const stableBlock = blocks.find(
      (block) => (block as unknown as { node?: CanonicalNode }).node === nodes[1],
    );
    expect(stableBlock).toBeDefined();

    const firstInline = [
      ...mounted.renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
    ][0]!;
    firstInline.focus();
    firstInline.setSelectionOffsets(5, 5);
    await userEvent.keyboard('!');
    await nextTask();

    expect(nodes[1]).toBe(document!.root.children[1]);
    expect(
      [...mounted.renderer.shadowRoot!.querySelectorAll('md-block')].includes(stableBlock!),
    ).toBe(true);
  });

  test('measures browser input projection and unaffected-node rendering at 150 blocks', async () => {
    const source = Array.from({ length: 150 }, (_, index) => `Paragraph ${index} content`).join(
      '\n\n',
    );
    const mounted = await mount(source);
    const blocks = [...mounted.renderer.shadowRoot!.querySelectorAll('md-block')];
    const targetBlock = blocks[0]!;
    const unaffectedBlock = blocks[75]!;
    const targetNode = document!.root.children[0] as CanonicalNode;
    const unaffectedNode = document!.root.children[75] as CanonicalNode;
    const unaffectedVersion = unaffectedNode.version;
    const unaffectedSignal = unaffectedNode.renderSignal.value;
    const targetInline = mounted.renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
    let targetMutations = 0;
    let unaffectedMutations = 0;
    const targetObserver = new MutationObserver((records) => {
      targetMutations += records.length;
    });
    const unaffectedObserver = new MutationObserver((records) => {
      unaffectedMutations += records.length;
    });
    targetObserver.observe(targetBlock, { subtree: true, childList: true, characterData: true });
    unaffectedObserver.observe(unaffectedBlock, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    targetInline.focus();
    const targetEnd = (targetInline.textContent ?? '').length;
    targetInline.setSelectionOffsets(targetEnd, targetEnd);
    const startedAt = performance.now();
    await userEvent.keyboard('x');
    await nextTask();
    await Promise.all([
      mounted.editor.updateComplete,
      mounted.renderer.updateComplete,
      targetBlock.updateComplete,
      unaffectedBlock.updateComplete,
      targetInline.updateComplete,
    ]);
    await nextTask();
    targetObserver.disconnect();
    unaffectedObserver.disconnect();
    const elapsedMs = performance.now() - startedAt;

    expect(targetMutations).toBeGreaterThan(0);
    expect(unaffectedMutations).toBe(0);
    expect(targetNode.version).toBeGreaterThan(0);
    expect(unaffectedNode.version).toBe(unaffectedVersion);
    expect(unaffectedNode.renderSignal.value).toBe(unaffectedSignal);
    expect(blocks[75]).toBe(unaffectedBlock);
    console.info(
      'canonical-browser-measurement',
      JSON.stringify({
        blocks: 150,
        inputAndProjectionMs: Number(elapsedMs.toFixed(2)),
        affectedBlockDomMutations: targetMutations,
        unaffectedBlockDomMutations: unaffectedMutations,
      }),
    );
  });

  test('keeps browser selection anchored through remote split, join and removal', async () => {
    const mounted = await mount('abcdef');
    mounted.inline.focus();
    mounted.inline.setSelectionOffsets(4, 4);
    await nextTask();
    const [first] = document!.root.children as CanonicalNode[];

    await deliverRemote(
      (replica, remoteWriter) =>
        prepareEdit(
          remoteWriter,
          { actionId: 'remote-split', sessionId: 'remote' },
          replica.root.sharedId,
          undefined,
          insertParagraph,
          { nodeId: first!.sharedId, from: 3 },
        )?.request,
    );
    expect(document!.root.children.map((node) => node.content)).toEqual(['abc', 'def']);
    let focused = [
      ...mounted.renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
    ].find((inline) => inline.matches(':focus'));
    expect(focused).toBeDefined();
    expect((focused!.nodeView as unknown as CanonicalNode).sharedId).toBe(
      (document!.root.children[1] as CanonicalNode).sharedId,
    );
    expect(focused!.getTextSelection()).toEqual({ anchor: 1, focus: 1 });

    const right = document!.root.children[1] as CanonicalNode;
    await deliverRemote(
      (replica, remoteWriter) =>
        prepareEdit(
          remoteWriter,
          { actionId: 'remote-join', sessionId: 'remote' },
          replica.root.sharedId,
          undefined,
          joinWithPrevious,
          { nodeId: right.sharedId },
        )?.request,
    );
    expect(document!.root.children.map((node) => node.content)).toEqual(['abcdef']);
    focused = [...mounted.renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].find(
      (inline) => inline.matches(':focus'),
    );
    expect(focused).toBeDefined();
    expect((focused!.nodeView as unknown as CanonicalNode).sharedId).toBe(first!.sharedId);
    expect(focused!.getTextSelection()).toEqual({ anchor: 4, focus: 4 });

    await deliverRemote((replica, remoteWriter) =>
      remoteWriter.prepareCommand({ actionId: 'remote-remove', sessionId: 'remote' }, (draft) => {
        draft.detach(replica.root.children[0]!.sharedId);
      }),
    );
    expect(document!.root.children).toHaveLength(1);
    focused = [...mounted.renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].find(
      (inline) => inline.matches(':focus'),
    );
    const visible = new Set(
      document!.root.children.map((node) => (node as CanonicalNode).sharedId),
    );
    const focusedNode = focused?.nodeView as unknown as CanonicalNode | undefined;
    expect(focusedNode?.connected).toBe(true);
    expect(visible.has(focusedNode!.sharedId)).toBe(true);
  });

  test('seals repeated typing when an accepted remote edit interrupts input', async () => {
    const mounted = await mount('abcdef');
    const node = document!.root.children[0]!;
    mounted.inline.focus();
    mounted.inline.setSelectionOffsets(6, 6);
    await userEvent.keyboard('X');
    await nextTask();
    expect(node.content).toBe('abcdefX');

    await deliverRemote((_replica, remoteWriter) =>
      remoteWriter.prepareCommand(
        { actionId: 'remote-interruption', sessionId: 'remote' },
        (draft) => {
          draft.spliceText(node.sharedId, { from: 0, to: 0, insert: 'R' });
        },
      ),
    );
    expect(node.content).toBe('RabcdefX');
    const focused = [
      ...mounted.renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
    ].find((inline) => inline.matches(':focus'))!;
    await userEvent.keyboard('Y');
    await nextTask();
    expect(node.content).toBe('RabcdefXY');

    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(node.content).toBe('RabcdefX');
    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(node.content).toBe('Rabcdef');
    await userEvent.keyboard('{Control>}y{/Control}');
    await nextTask();
    expect(node.content).toBe('RabcdefX');
    expect(focused.isConnected).toBe(true);
  });

  test('surfaces history reset after restoring the canonical checkpoint', async () => {
    const mounted = await mount('alpha');
    const originalDocument = document!;
    const originalWriter = writer!;
    mounted.inline.focus();
    mounted.inline.setSelectionOffsets(5, 5);
    await userEvent.keyboard('!');
    await nextTask();

    const restored = CanonicalDocument.restore(
      originalDocument.checkpoint(),
      'canonical-editor-browser-reconnected-epoch',
    );
    const restoredWriter = new CanonicalWriter(restored);
    mounted.editor.document = restored;
    mounted.editor.writer = restoredWriter;
    document = restored;
    writer = restoredWriter;
    await mounted.editor.updateComplete;
    await mounted.renderer.updateComplete;
    await nextTask();
    const historyReset = new Promise<string>((resolve) => {
      mounted.editor.addEventListener(
        'canonical-history-reset',
        (event) => resolve((event as CustomEvent<{ sessionId: string }>).detail.sessionId),
        { once: true },
      );
    });
    const active = [
      ...mounted.renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
    ][0]!;
    active.focus();
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(await historyReset).toBe('local');
    expect(restored.root.children[0]?.content).toBe('alpha!');
    await mounted.renderer.updateComplete;
    await nextTask();
    originalWriter.close();
    originalDocument.close();
  });
});
