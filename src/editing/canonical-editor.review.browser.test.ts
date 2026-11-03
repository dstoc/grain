import { afterEach, describe, expect, test } from 'vitest';
import { userEvent, cdp } from 'vitest/browser';
import { html } from 'lit';
import { CanonicalWriter, type ActionRequest } from '../markdown/canonical-actions.js';
import { CanonicalDocument, type CanonicalNode } from '../markdown/canonical-model.js';
import type { HostContext } from '../markdown/host-context.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import type { DocumentNode } from '../markdown/node.js';
import type { MarkdownRenderDelegate } from '../markdown/render-delegate.js';
import { CanonicalEditor } from './canonical-editor.js';
import { insertParagraph } from './commands/insert-paragraph.js';
import { joinWithPrevious } from './commands/join-with-previous.js';
import { prepareEdit } from './prepare-edit.js';
import { nextTask } from './test/lifecycle.js';

describe('M6 review browser contracts', () => {
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
    await nextTask();
    await editor.updateComplete;
    await renderer.updateComplete;
    await Promise.all(
      [...renderer.shadowRoot!.querySelectorAll('md-inline')].map((i) => i.updateComplete),
    );
    await nextTask();
  }
  async function mount(source: string) {
    model = CanonicalDocument.fromMarkdown(source);
    return mountModel(model);
  }
  async function mountTree(
    tree: DocumentNode,
    makeRenderDelegate?: (document: CanonicalDocument) => MarkdownRenderDelegate,
  ) {
    model = CanonicalDocument.fromTree(tree);
    return mountModel(model, makeRenderDelegate);
  }
  async function mountModel(
    canonical: CanonicalDocument,
    makeRenderDelegate?: (document: CanonicalDocument) => MarkdownRenderDelegate,
  ) {
    writer = new CanonicalWriter(canonical);
    editor = new CanonicalEditor();
    editor.document = canonical;
    editor.writer = writer;
    editor.renderDelegate = makeRenderDelegate?.(canonical);
    window.document.body.replaceChildren(editor);
    await nextTask();
    renderer = editor.shadowRoot!.querySelector('md-block-render')!;
    await settle();
    return inlines()[0]!;
  }
  function inlines() {
    return [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')];
  }
  function expectBlockSelection(
    context: HostContext,
    anchorId: CanonicalNode['sharedId'],
    focusId: CanonicalNode['sharedId'],
    selectedIds: readonly CanonicalNode['sharedId'][],
  ) {
    const anchor = context.selectionAnchor as unknown as CanonicalNode | undefined;
    const focus = context.selectionFocus as unknown as CanonicalNode | undefined;
    expect(anchor?.sharedId).toBe(anchorId);
    expect(focus?.sharedId).toBe(focusId);
    expect(anchor?.connected).toBe(true);
    expect(focus?.connected).toBe(true);
    expect(
      [...context.selection].map((node) => (node as unknown as CanonicalNode).sharedId).sort(),
    ).toEqual([...selectedIds].sort());
    expect(
      [...context.selection].every((node) => (node as unknown as CanonicalNode).connected),
    ).toBe(true);
  }
  function devtools() {
    return cdp() as unknown as {
      send(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
  }
  async function remote(
    prepare: (replica: CanonicalDocument, writer: CanonicalWriter) => ActionRequest | undefined,
  ) {
    const replica = CanonicalDocument.open(model.checkpoint());
    const other = new CanonicalWriter(replica);
    try {
      other.admitSession('remote');
      const request = prepare(replica, other);
      if (!request) throw new Error('remote command was not applicable');
      const result = other.apply(request, {
        sessionId: request.sessionId,
        authorityEpoch: request.authorityEpoch,
        sessionSequence: request.sessionSequence,
      });
      const action =
        result.status === 'pending'
          ? other.publish(result.pending)
          : result.status === 'duplicate'
            ? result.accepted
            : undefined;
      if (!action) throw Error(result.status);
      model.applyAccepted({ revision: action.revision, update: action.update });
    } finally {
      other.close();
      replica.close();
    }
    await settle();
  }
  test('undo publishes text to every current owner after a remote split', async () => {
    const inline = await mount('a');
    const node = model.root.children[0]!;
    inline.focus();
    inline.setSelectionOffsets(1, 1);
    await userEvent.keyboard('XY');
    await settle();
    await remote(
      (replica, other) =>
        prepareEdit(
          other,
          { actionId: 'split', sessionId: 'remote' },
          replica.root.sharedId,
          undefined,
          insertParagraph,
          { nodeId: node.sharedId, from: 2 },
        )?.request,
    );
    expect(model.root.children.map((n) => n.content)).toEqual(['aX', 'Y']);
    expect(inlines().map((i) => i.textContent)).toEqual(['aX', 'Y']);
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children.map((n) => n.content)).toEqual(['a', '']);
    expect(inlines().map((i) => i.textContent)).toEqual(['a', '']);
    expect(model.root.children[1]!.version).toBeGreaterThan(0);
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model.root.children.map((n) => n.content)).toEqual(['aX', 'Y']);
    expect(inlines().map((i) => i.textContent)).toEqual(['aX', 'Y']);
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    const secondInline = inlines()[1]!;
    secondInline.focus();
    secondInline.setSelectionOffsets(0, 0);
    await userEvent.keyboard('!');
    await settle();
    expect(model.root.children.map((n) => n.content)).toEqual(['a', '!']);
    expect(inlines().map((i) => i.textContent)).toEqual(['a', '!']);
  });
  test('undo publishes text to its surviving owner after a remote join', async () => {
    await mount('first\n\nsecond');
    const inline = inlines()[1]!;
    const node = model.root.children[1]!;
    inline.focus();
    inline.setSelectionOffsets(6, 6);
    await userEvent.keyboard('X');
    await settle();
    await remote(
      (replica, other) =>
        prepareEdit(
          other,
          { actionId: 'join', sessionId: 'remote' },
          replica.root.sharedId,
          undefined,
          joinWithPrevious,
          { nodeId: node.sharedId },
        )?.request,
    );
    expect(model.root.children.map((n) => n.content)).toEqual(['firstsecondX']);
    expect(inlines().map((i) => i.textContent)).toEqual(['firstsecondX']);
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children.map((n) => n.content)).toEqual(['firstsecond']);
    expect(inlines().map((i) => i.textContent)).toEqual(['firstsecond']);
    expect(model.root.children[0]!.version).toBeGreaterThan(0);
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model.root.children[0]!.content).toBe('firstsecondX');
    expect(inlines()[0]!.textContent).toBe('firstsecondX');
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    const survivingInline = inlines()[0]!;
    survivingInline.focus();
    survivingInline.setSelectionOffsets('firstsecond'.length, 'firstsecond'.length);
    await userEvent.keyboard('!');
    await settle();
    expect(model.root.children[0]!.content).toBe('firstsecond!');
    expect(inlines()[0]!.textContent).toBe('firstsecond!');
  });
  test('Backspace deletes selected blocks and undo restores them', async () => {
    const inline = await mount('alpha\n\nbeta');
    const context = renderer.hostContext!;
    const [first, last] = model.root.children;
    inline.focus();
    inline.setSelectionOffsets(5, 5);
    await userEvent.keyboard('{Control>}a{/Control}{Control>}a{/Control}{Control>}a{/Control}');
    await settle();
    expect(renderer.hostContext.selection.size).toBe(2);
    context.selectionAnchor = last as never;
    context.selectionFocus = first as never;
    await userEvent.keyboard('{Backspace}');
    await settle();
    expect(model.root.children.map((n) => n.content)).toEqual(['']);
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children.map((n) => n.content)).toEqual(['alpha', 'beta']);
    expectBlockSelection(context, last!.sharedId, first!.sharedId, [
      first!.sharedId,
      last!.sharedId,
    ]);
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model.root.children.map((n) => n.content)).toEqual(['']);
    expect(inlines().map((i) => i.textContent)).toEqual(['']);
    expect(context.selection.size).toBe(0);
    expect(context.selectionAnchor).toBeUndefined();
    expect(context.selectionFocus).toBeUndefined();
    const redoInline = renderer.getInlineSelection().inline!;
    const redoFocus = redoInline.nodeView as unknown as CanonicalNode;
    expect(redoFocus.sharedId).toBe(first!.sharedId);
    expect(redoFocus.connected).toBe(true);
    expect(redoInline.getTextSelection()).toEqual({ anchor: 0, focus: 0 });
  });
  test('deleteContentBackward input replaces the active block selection', async () => {
    const inline = await mount('alpha\n\nbeta');
    const context = renderer.hostContext;
    const [first, last] = model.root.children;
    inline.focus();
    inline.setSelectionOffsets(5, 5);
    await userEvent.keyboard('{Control>}a{/Control}{Control>}a{/Control}{Control>}a{/Control}');
    await settle();
    context.selectionAnchor = last as never;
    context.selectionFocus = first as never;

    const input = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: 'deleteContentBackward',
    });
    inline.dispatchEvent(input);
    await settle();

    expect(input.defaultPrevented).toBe(true);
    expect(model.root.children.map((node) => node.content)).toEqual(['']);
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['alpha', 'beta']);
    expectBlockSelection(context, last!.sharedId, first!.sharedId, [
      first!.sharedId,
      last!.sharedId,
    ]);
  });
  test('selectionchange seals the preceding typing group', async () => {
    const inline = await mount('alpha');
    const node = model.root.children[0]!;
    inline.focus();
    inline.setSelectionOffsets(5, 5);
    await userEvent.keyboard('X');
    await settle();
    inline.setSelectionOffsets(0, 6);
    window.document.dispatchEvent(new Event('selectionchange'));
    await userEvent.keyboard('Y');
    await settle();
    expect(node.content).toBe('Y');
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(node.content).toBe('alphaX');
  });
  test.each([
    ['# ', 'keyboard', 3, 'section'],
    ['* ', 'keyboard', 3, 'list'],
    ['> ', 'insert', 2, 'block-quote'],
    ['> # ', 'insert', 2, 'section'],
  ] as const)(
    'typing prefix %j maps input to its content boundary and keeps history',
    async (prefix, inputMode, undoCount, rootType) => {
      const inline = await mount('hello');
      inline.focus();
      inline.setSelectionOffsets(0, 0);
      if (inputMode === 'keyboard') await userEvent.keyboard(prefix);
      else await devtools().send('Input.insertText', { text: prefix });
      await settle();
      expect(model.root.children[0]!.type).toBe(rootType);
      expect(inlines().map((item) => item.nodeView?.content)).toContain('hello');
      await userEvent.keyboard('X');
      await settle();
      expect(inlines().map((item) => item.nodeView?.content)).toContain('Xhello');
      await userEvent.keyboard('{Control>}z{/Control}');
      await settle();
      expect(inlines().map((item) => item.nodeView?.content)).toContain('hello');
      if (undoCount === 3) {
        await userEvent.keyboard('{Control>}z{/Control}');
        await settle();
        expect(model.root.children[0]!.type).toBe('paragraph');
        expect(model.root.children[0]!.content).toBe(prefix[0] + 'hello');
      }
      await userEvent.keyboard('{Control>}z{/Control}');
      await settle();
      expect(inlines().map((item) => item.nodeView?.content)).toContain('hello');
      for (let index = 0; index < undoCount; index++) {
        await userEvent.keyboard('{Control>}y{/Control}');
      }
      await settle();
      expect(inlines().map((item) => item.nodeView?.content)).toContain('Xhello');
    },
  );

  test.each([
    ['indent', 'alpha\n\nbeta', '{Tab}'],
    ['unindent', '* alpha\n  * beta', '{Shift>}{Tab}{/Shift}'],
  ])('selected-block %s preserves direction through undo', async (_mode, source, key) => {
    const inline = await mount(source);
    inline.focus();
    inline.setSelectionOffsets(0, 0);
    await userEvent.keyboard('{Control>}a{/Control}{Control>}a{/Control}{Control>}a{/Control}');
    await settle();
    const selected = editor.shadowRoot!.querySelector('md-block-render')!.hostContext!;
    const [first, last] = model.root.children.flatMap(function visit(node): CanonicalNode[] {
      return [node, ...node.children.flatMap(visit)].filter((item) =>
        ['paragraph', 'section', 'code-block'].includes(item.type),
      );
    });
    expect(selected.selection.size).toBe(2);
    selected.selectionAnchor = last as never;
    selected.selectionFocus = first as never;
    const original = JSON.stringify(model.exportMarkdownTree());
    await userEvent.keyboard(key);
    await settle();
    const indented = JSON.stringify(model.exportMarkdownTree());
    expectBlockSelection(selected, last!.sharedId, first!.sharedId, [
      first!.sharedId,
      last!.sharedId,
    ]);
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(JSON.stringify(model.exportMarkdownTree())).toBe(original);
    expectBlockSelection(selected, last!.sharedId, first!.sharedId, [
      first!.sharedId,
      last!.sharedId,
    ]);
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(JSON.stringify(model.exportMarkdownTree())).toBe(indented);
    expectBlockSelection(selected, last!.sharedId, first!.sharedId, [
      first!.sharedId,
      last!.sharedId,
    ]);
  });
  test('block copy preserves Markdown structure', async () => {
    const inline = await mount('# title\n\n- child');
    inline.focus();
    inline.setSelectionOffsets(5, 5);
    await userEvent.keyboard('{Control>}a{/Control}{Control>}a{/Control}{Control>}a{/Control}');
    await settle();
    expect(renderer.hostContext.selection.size).toBe(2);
    const clipboardData = new DataTransfer();
    const copy = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clipboardData,
    });
    inline.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(clipboardData.getData('text/plain')).toBe('# title\n\n- child\n');
    expect(clipboardData.getData('text/markdown')).toBe('# title\n\n- child\n');
  });
  test('Markdown clipboard paste constructs canonical block structure', async () => {
    const inline = await mount('target');
    inline.focus();
    inline.setSelectionOffsets(6, 6);
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '# title\n\n- child\n');
    clipboardData.setData('text/markdown', '# title\n\n- child\n');
    inline.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        composed: true,
        cancelable: true,
        clipboardData,
      }),
    );
    await settle();
    expect(model.root.children.map((node) => node.type)).toEqual(['paragraph', 'section']);
    expect(inlines().map((item) => item.nodeView?.content)).toContain('title');
    expect(inlines().map((item) => item.nodeView?.content)).toContain('child');
    expect(model.root.children[1]!.children.map((node) => node.type)).toContain('list');
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['target']);
  });
  test('plain-text clipboard paste replaces the inline selection and undo restores it', async () => {
    const inline = await mount('hello world');
    inline.focus();
    inline.setSelectionOffsets(6, 11);
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'Grain');
    inline.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        composed: true,
        cancelable: true,
        clipboardData,
      }),
    );
    await settle();
    expect(model.root.children[0]!.content).toBe('hello Grain');
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children[0]!.content).toBe('hello world');
  });
  test.each([
    ['supplementary character', 'a😀', 3, 3, 'a'],
    ['selected emoji', 'a😀b', 1, 3, 'ab'],
    ['combining mark', 'e\u0301', 2, 2, 'e'],
  ] as const)(
    'trusted Backspace deletes the %s without splitting UTF-16 text',
    async (_case, original, anchor, focus, expected) => {
      const inline = await mount(original);
      inline.focus();
      inline.setSelectionOffsets(anchor, focus);
      await userEvent.keyboard('{Backspace}');
      await settle();

      expect(model.root.children[0]!.content).toBe(expected);
      await userEvent.keyboard('{Control>}z{/Control}');
      await settle();
      expect(model.root.children[0]!.content).toBe(original);
      await userEvent.keyboard('{Control>}y{/Control}');
      await settle();
      expect(model.root.children[0]!.content).toBe(expected);
    },
  );
  test('trusted multi-block copy, cut and paste preserve clipboard content and history', async () => {
    const inline = await mount('hello\n\nworld');
    inline.focus();
    inline.setSelectionOffsets(0, 0);
    await userEvent.keyboard('{Control>}a{/Control}{Control>}a{/Control}{Control>}a{/Control}');
    await settle();
    const context = renderer.hostContext!;
    expect(context.selection.size).toBe(2);

    await userEvent.keyboard('{Control>}c{/Control}');
    const destination = window.document.createElement('textarea');
    window.document.body.append(destination);
    destination.focus();
    await userEvent.keyboard('{Control>}v{/Control}');
    expect(destination.value).toBe('hello\n\nworld\n');

    inline.focus();
    await userEvent.keyboard('{Control>}x{/Control}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['']);
    const emptyInline = inlines()[0]!;
    emptyInline.focus();
    await userEvent.keyboard('{Control>}v{/Control}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['', 'hello', 'world']);

    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['']);
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['hello', 'world']);
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['']);
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model.root.children.map((node) => node.content)).toEqual(['', 'hello', 'world']);
  });
  test('Markdown heading paste into a section keeps the draft valid', async () => {
    const inline = await mount('# Heading');
    inline.focus();
    inline.setSelectionOffsets(7, 7);
    const original = JSON.stringify(model.exportMarkdownTree());
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '# Pasted\n');
    clipboardData.setData('text/markdown', '# Pasted\n');
    inline.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        composed: true,
        cancelable: true,
        clipboardData,
      }),
    );
    await settle();
    expect(model.validate()).toEqual({ valid: true, errors: [] });
    expect(inlines().map((item) => item.nodeView?.content)).toContain('Pasted');
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(JSON.stringify(model.exportMarkdownTree())).toBe(original);
  });
  test.each([
    [
      'start',
      0,
      [
        { type: 'paragraph', content: '' },
        { type: 'code-block', info: 'js', content: 'code' },
      ],
    ],
    [
      'end',
      4,
      [
        { type: 'code-block', info: 'js', content: 'code' },
        { type: 'paragraph', content: '' },
      ],
    ],
  ] as const)(
    'trusted Shift+Enter at the code block %s keeps the paragraph boundary behavior',
    async (_edge, offset, expected) => {
      const inline = await mountTree({
        type: 'document',
        children: [{ type: 'code-block', info: 'js', content: 'code' }],
      });
      inline.focus();
      inline.setSelectionOffsets(offset, offset);
      await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
      await settle();

      expect(model.exportMarkdownTree().children).toEqual(expected);
      await userEvent.keyboard('{Control>}z{/Control}');
      await settle();
      expect(model.exportMarkdownTree().children).toEqual([
        { type: 'code-block', info: 'js', content: 'code' },
      ]);
      await userEvent.keyboard('{Control>}y{/Control}');
      await settle();
      expect(model.exportMarkdownTree().children).toEqual(expected);
    },
  );
  test.each([
    ['forward', 6, 10],
    ['reverse', 10, 6],
  ] as const)(
    'trusted Shift+Enter replaces an interior %s code selection with a boundary paragraph',
    async (_direction, anchor, focus) => {
      const content = 'alpha BETA omega';
      const inline = await mountTree({
        type: 'document',
        children: [{ type: 'code-block', info: 'js', content }],
      });
      inline.focus();
      inline.setSelectionOffsets(anchor, focus);
      await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
      await settle();

      const expected = [
        { type: 'code-block', info: 'js', content: 'alpha ' },
        { type: 'paragraph', content: '' },
        { type: 'code-block', info: 'js', content: ' omega' },
      ];
      expect(model.exportMarkdownTree().children).toEqual(expected);
      await userEvent.keyboard('{Control>}z{/Control}');
      await settle();
      expect(model.exportMarkdownTree().children).toEqual([
        { type: 'code-block', info: 'js', content },
      ]);
      await userEvent.keyboard('{Control>}y{/Control}');
      await settle();
      expect(model.exportMarkdownTree().children).toEqual(expected);
    },
  );
  test('trusted Shift+Enter in an empty code block inserts a boundary paragraph', async () => {
    const inline = await mountTree({
      type: 'document',
      children: [{ type: 'code-block', info: 'js', content: '' }],
    });
    inline.focus();
    inline.setSelectionOffsets(0, 0);
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    await settle();

    const expected = [
      { type: 'code-block', info: 'js', content: '' },
      { type: 'paragraph', content: '' },
    ];
    expect(model.exportMarkdownTree().children).toEqual(expected);
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.exportMarkdownTree().children).toEqual([
      { type: 'code-block', info: 'js', content: '' },
    ]);
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model.exportMarkdownTree().children).toEqual(expected);
  });
  test.each([
    ['at the end', 'alpha', 5, 5, 'alpha\n'],
    ['replacing a selection', 'alpha BETA omega', 6, 10, 'alpha \n omega'],
  ] as const)(
    'trusted Enter %s inserts a literal newline into code and preserves history',
    async (_case, original, anchor, focus, expected) => {
      const inline = await mountTree({
        type: 'document',
        children: [{ type: 'code-block', info: 'js', content: original }],
      });
      inline.focus();
      inline.setSelectionOffsets(anchor, focus);
      await userEvent.keyboard('{Enter}');
      await settle();
      expect(model.root.children[0]!.content).toBe(expected);
      await userEvent.keyboard('{Control>}z{/Control}');
      await settle();
      expect(model.root.children[0]!.content).toBe(original);
      await userEvent.keyboard('{Control>}y{/Control}');
      await settle();
      expect(model.root.children[0]!.content).toBe(expected);
    },
  );
  test('Enter keeps task-looking text literal in a code block inside a list item', async () => {
    await mountTree({
      type: 'document',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'list-item',
              marker: '- ',
              children: [{ type: 'code-block', info: 'ts', content: '[x] code' }],
            },
          ],
        },
      ],
    });
    const inline = inlines().find((item) => item.nodeView?.type === 'code-block')!;
    const item = model.root.children[0]!.children[0]!;
    inline.focus();
    inline.setSelectionOffsets(9, 9);
    await userEvent.keyboard('{Enter}');
    await settle();

    expect(inlines().find((item) => item.nodeView?.type === 'code-block')?.nodeView?.content).toBe(
      '[x] code\n',
    );
    expect(item.checked).toBeUndefined();
    expect(model.validate()).toEqual({ valid: true, errors: [] });
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children[0]!.children[0]!.children[0]!.content).toBe('[x] code');
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model.root.children[0]!.children[0]!.children[0]!.content).toBe('[x] code\n');
    expect(item.checked).toBeUndefined();
  });
  test('commits composition at the final code line after a trailing newline', async () => {
    const inline = await mountTree({
      type: 'document',
      children: [{ type: 'code-block', info: 'ts', content: 'alpha\n' }],
    });
    inline.focus();
    inline.setSelectionOffsets(6, 6);
    await devtools().send('Input.imeSetComposition', {
      text: 'é',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await devtools().send('Input.insertText', { text: 'é' });
    await settle();

    expect(model.root.children[0]!.content).toBe('alpha\né');
    expect(inlines()[0]!.textContent).toBe('alpha\né');
    expect(inlines()[0]!.getTextSelection()).toEqual({ anchor: 7, focus: 7 });
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children[0]!.content).toBe('alpha\n');
    expect(inlines()[0]!.getTextSelection()).toEqual({ anchor: 6, focus: 6 });
  });
  test('replays selected-block composition inside a nested host and restores history', async () => {
    await mountTree(
      {
        type: 'document',
        children: [
          { type: 'code-block', info: 'nested', content: 'host' },
          {
            type: 'section',
            marker: '#',
            content: 'transcluded',
            children: [
              { type: 'paragraph', content: 'alpha' },
              { type: 'paragraph', content: 'beta' },
            ],
          },
          { type: 'paragraph', content: 'after' },
        ],
      },
      (canonical) => ({
        renderCodeBlock: ({ node }) =>
          node.info === 'nested'
            ? html`<md-transclusion
                .node=${node}
                .root=${canonical.root.children.find((child) => child.type === 'section')}
              ></md-transclusion>`
            : undefined,
      }),
    );
    const blocks = [...renderer.shadowRoot!.querySelectorAll('md-block')];
    await Promise.all(blocks.map((block) => block.updateComplete));
    const codeBlock = blocks.find((block) => block.node?.type === 'code-block')!;
    const transclusion = codeBlock.querySelector('md-transclusion')!;
    await transclusion.updateComplete;
    const nestedRenderer = transclusion.shadowRoot!.querySelector('md-block-render')!;
    const nestedInlines = () => [
      ...nestedRenderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
    ];
    const alpha = nestedInlines().find((inline) => inline.nodeView?.content === 'alpha')!;
    const beta = nestedInlines().find((inline) => inline.nodeView?.content === 'beta')!;
    const nestedContext = nestedRenderer.hostContext!;
    const section = model.root.children.find((node) => node.type === 'section')!;

    beta.focus();
    nestedContext.expandSelection([beta.nodeView!, alpha.nodeView!]);
    beta.setSelectionOffsets(0, beta.nodeView!.content!.length);
    beta.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true, composed: true, data: '' }),
    );
    beta.queueRecoveryInput(
      new InputEvent('beforeinput', {
        bubbles: true,
        inputType: 'insertText',
        data: 'Z',
      }),
    );
    beta.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, composed: true, data: 'BETA' }),
    );
    await settle();
    await nestedRenderer.updateComplete;
    await Promise.all(nestedInlines().map((inline) => inline.updateComplete));
    await nextTask();

    expect(section.children.map((node) => node.content).filter(Boolean)).toEqual([
      'BETAZ',
      'after',
    ]);
    expect(model.validate()).toEqual({ valid: true, errors: [] });
    expect(nestedContext.selection.size).toBe(0);
    nestedInlines()
      .find((inline) => inline.nodeView?.content === 'BETAZ')!
      .focus();
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(section.children.map((node) => node.content)).toEqual(['BETA', 'after']);
    nestedInlines()
      .find((inline) => inline.nodeView?.content === 'BETA')!
      .focus();
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(section.children.map((node) => node.content)).toEqual(['alpha', 'beta', 'after']);
    expect(nestedContext.selection.size).toBe(2);
    nestedInlines()
      .find((inline) => inline.nodeView?.content === 'alpha')!
      .focus();
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(section.children.map((node) => node.content)).toEqual(['BETA', 'after']);
    nestedInlines()
      .find((inline) => inline.nodeView?.content === 'BETA')!
      .focus();
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(section.children.map((node) => node.content).filter(Boolean)).toEqual([
      'BETAZ',
      'after',
    ]);
    await userEvent.keyboard('!');
    await settle();
    expect(section.children.map((node) => node.content)).toEqual(['BETAZ!', 'after']);
  });
  test('composition replacing a supplementary character remains valid UTF-16', async () => {
    const inline = await mount('😀');
    const errors: unknown[] = [];
    editor.addEventListener('canonical-edit-error', (e) => errors.push((e as CustomEvent).detail));
    inline.focus();
    inline.setSelectionOffsets(0, 2);
    await devtools().send('Input.imeSetComposition', {
      text: '😁',
      selectionStart: 2,
      selectionEnd: 2,
    });
    await devtools().send('Input.insertText', { text: '😁' });
    await settle();
    await settle();
    expect(model.root.children[0]!.content).toBe('😁');
    expect(errors).toEqual([]);
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model.root.children[0]!.content).toBe('😀');
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model.root.children[0]!.content).toBe('😁');
  });
  test('render invalidation clears composition without requiring compositionend', async () => {
    const inline = await mount('alpha');
    const node = model.root.children[0]!;
    inline.focus();
    inline.setSelectionOffsets(5, 5);
    const trace: unknown[] = [];
    inline.addEventListener('compositionend', (e) => trace.push({ type: e.type }));
    inline.addEventListener('input', (e) =>
      trace.push({
        type: e.type,
        inputType: (e as InputEvent).inputType,
        isComposing: (e as InputEvent).isComposing,
      }),
    );
    await devtools().send('Input.imeSetComposition', {
      text: '漢',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await remote((_replica, other) =>
      other.prepareCommand({ actionId: 'interrupt', sessionId: 'remote' }, (draft) =>
        draft.spliceText(node.sharedId, { from: 0, to: 0, insert: 'R' }),
      ),
    );
    const current = inlines()[0]!;
    current.focus();
    current.setSelectionOffsets(6, 6);
    await devtools().send('Input.insertText', { text: '!' });
    await settle();
    expect(node.content).toBe('Ralpha!');
    expect(current.composing).toBe(false);
    expect(trace.some((event) => (event as { type: string }).type === 'compositionend')).toBe(
      false,
    );
  });
});
