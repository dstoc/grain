import { afterEach, describe, expect, test } from 'vitest';
import { userEvent, cdp } from 'vitest/browser';
import { CanonicalWriter, type TreeDraft } from '../markdown/canonical-actions.js';
import { CanonicalDocument, type CanonicalNode } from '../markdown/canonical-model.js';
import type { HostContext } from '../markdown/host-context.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import { CanonicalEditor } from './canonical-editor.js';
import { insertParagraph, joinWithPrevious } from './canonical-edits.js';
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
    writer = new CanonicalWriter(model);
    editor = new CanonicalEditor();
    editor.document = model;
    editor.writer = writer;
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
  async function remote(id: string, command: (draft: TreeDraft) => void) {
    const replica = CanonicalDocument.open(model.checkpoint());
    const other = new CanonicalWriter(replica);
    try {
      const action = other.edit({ actionId: id, sessionId: 'remote' }, command);
      if (!('receipt' in action)) throw Error(action.status);
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
    await remote('split', (draft) => insertParagraph(draft, model.root.sharedId, node.sharedId, 2));
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
    await remote('join', (draft) => joinWithPrevious(draft, model.root.sharedId, node.sharedId));
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
  test('block clipboard preserves Markdown structure', async () => {
    const inline = await mount('# title\n\n- child');
    inline.focus();
    inline.setSelectionOffsets(5, 5);
    await userEvent.keyboard('{Control>}a{/Control}{Control>}a{/Control}{Control>}a{/Control}');
    await settle();
    expect(renderer.hostContext.selection.size).toBe(2);
    const destination = window.document.createElement('textarea');
    window.document.body.append(destination);
    await userEvent.keyboard('{Control>}c{/Control}');
    destination.focus();
    await userEvent.keyboard('{Control>}v{/Control}');
    expect(destination.value).toBe('# title\n\n- child\n');
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
    await remote('interrupt', (draft) =>
      draft.spliceText(node.sharedId, { from: 0, to: 0, insert: 'R' }),
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
