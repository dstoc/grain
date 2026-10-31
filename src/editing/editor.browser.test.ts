import { test, describe, expect, vi } from 'vitest';
import { Editor } from './editor.js';
import { testState } from './test/test_state.js';
import { MarkdownTree } from '../markdown/view-model.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import { nextTask } from './test/lifecycle.js';
import './test/markdown_node_snapshot.js';
import { viewModel } from '../markdown/view-model-node.js';
import { userEvent } from 'vitest/browser';

describe('Editor', () => {
  function serializeEditor(editor: Editor) {
    const tree = editor.root?.[viewModel].tree.serialize();
    return tree
      ? {
          ...tree,
          [Symbol.for('markdown-tree')]: true,
        }
      : undefined;
  }

  const state = testState(async () => {
    const editor = new Editor();
    document.body.textContent = '';
    document.body.appendChild(editor);
    const tree = new MarkdownTree({
      type: 'document',
      children: [
        {
          type: 'paragraph',
          content: '',
        },
      ],
    });
    editor.root = tree.root;
    await nextTask();
    const inline = editor
      .shadowRoot!.querySelector('md-block-render')!
      .shadowRoot!.querySelector('md-inline')!;
    inline.focus();
    function getFocusedInline(): MarkdownInline {
      return state.editor
        .shadowRoot!.querySelector('md-block-render')!
        .shadowRoot!.querySelector('md-inline:focus')!;
    }
    const input = {
      async insert(text: string) {
        getFocusedInline().onBeforeInput(
          new InputEvent('input', {
            inputType: 'insertText',
            data: text,
          }),
        );
        await nextTask();
      },
      async insertParagraph(repeat = 1) {
        for (let i = 0; i < repeat; i++) {
          getFocusedInline().onBeforeInput(
            new InputEvent('input', {
              inputType: 'insertParagraph',
            }),
          );
          await nextTask();
        }
      },
      async selectAll() {
        const selection = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(getFocusedInline());
        selection.removeAllRanges();
        selection.addRange(range);
      },
      async press(key: string, repeat = 1) {
        const shiftKey = key.includes('Shift+');
        const altKey = key.includes('Alt+');
        const ctrlKey = key.includes('Control+');
        key = /(?:(?:Control|Alt|Shift)\+)*(.*)/.exec(key)![1];
        for (let i = 0; i < repeat; i++) {
          getFocusedInline().onKeyDown(
            new KeyboardEvent('keydown', {
              ctrlKey,
              altKey,
              shiftKey,
              key,
            }),
          );
          await nextTask();
        }
      },
    };
    return { editor, input };
  });

  describe('undo', () => {
    test('copies and cuts blocks through trusted keyboard events', async () => {
      await state.input.insert('hello');
      await state.input.insertParagraph();
      await state.input.insert('world');
      await state.input.selectAll();
      await state.input.press('Control+a', 2);
      await userEvent.keyboard('{Control>}c{/Control}');
      const destination = document.createElement('textarea');
      document.body.append(destination);
      destination.focus();
      await userEvent.keyboard('{Control>}v{/Control}');
      expect(destination.value).toBe('hello\n\nworld\n');
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const inline = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline | null;
      // Focus was moved to the destination; restore it without changing the block selection.
      (inline ?? renderer.shadowRoot!.querySelectorAll('md-inline')[1]).focus();
      await userEvent.keyboard('{Control>}x{/Control}');
      await nextTask();
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`<!-- -->`);
      await userEvent.keyboard('{Control>}v{/Control}');
      await nextTask();
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        <!-- -->

        hello

        world
      `);
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`<!-- -->`);
    });
    test('restores focus and block selection across deletion, undo and redo', async () => {
      await state.input.insert('hello');
      await state.input.insertParagraph();
      await state.input.insert('world');
      await state.input.selectAll();
      await state.input.press('Control+a', 2);
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const focused = () => renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      expect(focused().hostContext!.selection.size).toBe(2);
      await state.input.press('Backspace');
      expect(focused().node!.content).toBe('');
      expect(focused().getSelection()?.start.index).toBe(0);
      expect(focused().hostContext!.selection.size).toBe(0);
      await state.input.press('Control+z');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        hello

        world
      `);
      expect(focused().node!.content).toBe('world');
      expect(focused().hostContext!.selection.size).toBe(2);
      await state.input.press('Control+y');
      expect(focused().node!.content).toBe('');
      expect(focused().getSelection()?.start.index).toBe(0);
      expect(focused().hostContext!.selection.size).toBe(0);
      await state.input.insert('again');
      expect(focused().node!.content).toBe('again');
    });

    test('can type after deleting the only selected block', async () => {
      await state.input.insert('hello');
      await state.input.selectAll();
      await state.input.press('Control+a');
      await state.input.press('Backspace');
      await state.input.insert('again');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`again`);
    });

    test('can undo block selection delete', async () => {
      await state.input.insert('hello');
      await state.input.insertParagraph();
      await state.input.insert('* item');
      await state.input.selectAll();
      await state.input.press('Control+a');
      await state.input.press('Backspace');
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const focused = () => renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      expect(focused().node!.content).toBe('hello');
      await state.input.press('Control+z');
      expect(focused().node!.content).toBe('item');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        hello
        * item
      `);
    });

    test('restores focus after deleting all nested list blocks', async () => {
      await state.input.insert('* first');
      await state.input.insertParagraph();
      await state.input.insert('second');
      await state.input.selectAll();
      await state.input.press('Control+a', 3);
      await state.input.press('Backspace');
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const focused = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      expect(focused).toBeTruthy();
      await state.input.insert('again');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`again`);
    });

    test('keeps an editable focused after cutting all blocks', async () => {
      await state.input.insert('hello');
      await state.input.insertParagraph();
      await state.input.insert('world');
      await state.input.selectAll();
      await state.input.press('Control+a', 2);
      const inline = state.editor
        .shadowRoot!.querySelector('md-block-render')!
        .shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      const data = new DataTransfer();
      inline.dispatchEvent(
        new ClipboardEvent('cut', {
          bubbles: true,
          composed: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
      await nextTask();
      expect(data.getData('text/plain')).toBe('hello\n\nworld\n');
      await state.input.press('Control+z');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
          hello

          world
        `);
      await state.input.press('Control+y');
      await state.input.insert('again');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`again`);
    });

    test('retains selected blocks when cut has no clipboard data', async () => {
      await state.input.insert('hello');
      await state.input.selectAll();
      await state.input.press('Control+a');
      const inline = state.editor
        .shadowRoot!.querySelector('md-block-render')!
        .shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      const event = new ClipboardEvent('cut', { bubbles: true, composed: true, cancelable: true });
      inline.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(inline.hostContext!.selection.size).toBe(1);
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`hello`);
    });

    test('retains selected blocks when writing plain text throws', async () => {
      await state.input.insert('hello');
      await state.input.selectAll();
      await state.input.press('Control+a');
      const inline = state.editor
        .shadowRoot!.querySelector('md-block-render')!
        .shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      const data = new DataTransfer();
      vi.spyOn(data, 'setData').mockImplementation(() => {
        throw new Error('denied');
      });
      const event = new ClipboardEvent('cut', {
        bubbles: true,
        composed: true,
        cancelable: true,
        clipboardData: data,
      });
      inline.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(inline.hostContext!.selection.size).toBe(1);
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`hello`);
    });

    test('retains focus through split, merge, indent and unindent', async () => {
      await state.input.insert('* hello');
      await state.input.insertParagraph();
      await state.input.insert('world');
      await state.input.press('Tab');
      await state.input.press('Shift+Tab');
      await state.input.press('ArrowLeft', 5);
      await state.input.press('Backspace');
      await state.input.insert('!');
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      expect(renderer.shadowRoot!.querySelector('md-inline:focus')).toBeTruthy();
    });

    test('retains focus after pasting Markdown blocks', async () => {
      const read = vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([]);
      const readText = vi
        .spyOn(navigator.clipboard, 'readText')
        .mockResolvedValue('first\n\nsecond');
      try {
        const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
        const inline = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
        await state.editor.triggerPaste(
          inline,
          inline.node!,
          { startIndex: 0, oldEndIndex: 0 },
          true,
        );
        await nextTask();
        const focused = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
        expect(focused.node!.content).toBe('second');
        await state.input.press('Escape');
        await state.input.insert('!');
        expect(focused.node!.content).toBe('second!');
      } finally {
        read.mockRestore();
        readText.mockRestore();
      }
    });
  });

  describe('sections', () => {
    test('insertParagraph at the start of the heading moves outward', async () => {
      await state.input.insert('# hello');
      await state.input.press('ArrowLeft', 7);
      await state.input.insertParagraph();
      await state.input.insert('world!');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        world!

        # hello
      `);
    });
    test('insertParagraph on empty paragraph moves outwards', async () => {
      // Need to use a parent, otherwise there's nowhere to move outwards to.
      await state.input.insert('> # heading');
      await state.input.insertParagraph();
      await state.input.insert('body');
      await state.input.press('ArrowLeft', 4);
      await state.input.insertParagraph(2);
      await state.input.insert('middle');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        # heading
        <!-- -->

        middle

        body
      `);
    });
  });

  describe('block-quotes', () => {
    test('insertParagraph adds a new paragraph to the block-quote', async () => {
      await state.input.insert('> hello');
      await state.input.insertParagraph();
      await state.input.insert('world!');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        > hello
        > 
        > world!
      `);
    });
    test('insertParagraph on empty paragraph moves outwards (start)', async () => {
      await state.input.insert('> hello');
      await state.input.press('ArrowLeft', 5);
      await state.input.insertParagraph(2);
      await state.input.insert('world!');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        world!

        > hello
      `);
    });

    test('insertParagraph on empty paragraph moves outwards (end)', async () => {
      await state.input.insert('> hello');
      await state.input.insertParagraph(2);
      await state.input.insert('world!');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        > hello

        world!
      `);
    });

    test('insertParagraph on empty paragraph moves outwards (middle)', async () => {
      await state.input.insert('> hello');
      await state.input.press('ArrowLeft', 3);
      await state.input.insertParagraph(3);
      await state.input.insert('middle');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        > he

        middle

        > llo
      `);
    });
  });

  describe('list items', () => {
    test('renders following items after inserting at the start of a numbered item', async () => {
      await state.input.insert('5. aaa');
      await state.input.insertParagraph();
      await state.input.insert('bbb');
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const first = renderer.shadowRoot!.querySelector('md-inline')!;
      first.focus();
      const range = document.createRange();
      range.selectNodeContents(first);
      range.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      await state.input.insertParagraph();
      const renderedText = () =>
        Array.from(renderer.shadowRoot!.querySelectorAll('md-inline')).map(
          (inline) => inline.textContent,
        );
      expect(renderedText()).toEqual(['', 'aaa', 'bbb']);
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        5. <!-- -->
        6. aaa
        7. bbb
      `);
      await state.input.press('Control+z');
      expect(renderedText()).toEqual(['aaa', 'bbb']);
      await state.input.press('Control+y');
      expect(renderedText()).toEqual(['', 'aaa', 'bbb']);
    });
    test('removing an empty first numbered item retains the list start', async () => {
      await state.input.insert('1. test');
      await state.input.press('ArrowLeft', 4);
      await state.input.insertParagraph();
      await state.input.insertParagraph();
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        <!-- -->

        1. test
      `);
      await state.input.press('Control+z');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        1. <!-- -->
        2. test
      `);
      await state.input.press('Control+y');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        <!-- -->

        1. test
      `);
    });
    test('retains a non-default start after removing the first empty item', async () => {
      await state.input.insert('5. test');
      await state.input.press('ArrowLeft', 4);
      await state.input.insertParagraph();
      await state.input.insertParagraph();
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        <!-- -->

        5. test
      `);
    });
    test('continues a numbered list and undoes the insertion', async () => {
      await state.input.insert('5. hello');
      await state.input.insertParagraph();
      await state.input.insert('world');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        5. hello
        6. world
      `);
      await state.input.press('Control+z');
      await state.input.press('Control+z');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`5. hello`);
    });
    test('insertParagraph adds new list items', async () => {
      await state.input.insert('* hello');
      await state.input.insertParagraph();
      await state.input.insert('world!');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        * hello
        * world!
      `);
    });

    test('insertParagraph in the middle of a list item, splits', async () => {
      await state.input.insert('* hello');
      await state.input.press('ArrowLeft', 3);
      await state.input.insertParagraph();
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        * he
        * llo
      `);
    });

    test('insertParagraph on empty paragraph moves outwards (start)', async () => {
      await state.input.insert('* hello');
      await state.input.press('ArrowLeft', 10);
      await state.input.insertParagraph(2);
      await state.input.insert('world!');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        world!
        * hello
      `);
    });

    test('insertParagraph on empty paragraph moves outwards (end)', async () => {
      await state.input.insert('* hello');
      await state.input.insertParagraph(2);
      await state.input.insert('world!');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        * hello


        world!
      `);
    });

    test('insertParagraph on empty paragraph moves outwards (middle)', async () => {
      await state.input.insert('* hello');
      await state.input.press('ArrowLeft', 3);
      await state.input.insertParagraph(3);
      await state.input.insert('middle');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        * he


        middle
        * llo
      `);
    });
  });
});
