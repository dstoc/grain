import { test, describe, expect, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { parseMarkdownTree } from '../markdown/block-parser/api.js';
import { Editor } from './editor.js';
import { testState } from './test/test_state.js';
import { MarkdownTree } from '../markdown/view-model.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import { nextTask } from './test/lifecycle.js';
import './test/markdown_node_snapshot.js';
import { viewModel } from '../markdown/view-model-node.js';

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
    test.each(['undo', 'redo'] as const)(
      '%s of a task toggle preserves the current paragraph and caret',
      async (direction) => {
        const tree = parseMarkdownTree('1. [ ] first\n\nsecond');
        state.editor.root = tree.root;
        await nextTask();
        const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
        const item = tree.root.children![0].children![0];
        if (item.type !== 'list-item') throw new Error('Expected a list item');
        const itemBlock = [...renderer.shadowRoot!.querySelectorAll('md-block')].find(
          (block) => block.node === item,
        )!;
        const itemUI = itemBlock.shadowRoot!.querySelector('md-list-item-ui')!;
        (itemUI.shadowRoot!.querySelector('button') as HTMLButtonElement).click();
        await nextTask();
        expect(item.checked).toBe(true);
        const inlines = renderer.shadowRoot!.querySelectorAll('md-inline');
        const paragraph = inlines[inlines.length - 1] as MarkdownInline;
        paragraph.focus();
        await userEvent.keyboard('{End}');
        await nextTask();
        if (direction === 'redo') {
          await userEvent.keyboard('{Control>}z{/Control}');
          await nextTask();
          expect(item.checked).toBe(false);
        }
        await userEvent.keyboard(
          direction === 'undo' ? '{Control>}z{/Control}' : '{Control>}y{/Control}',
        );
        await nextTask();
        expect(item.checked).toBe(direction === 'redo');
        expect(renderer.shadowRoot!.querySelector('md-inline:focus')).toBe(paragraph);
        expect(paragraph.getSelection()?.start.index).toBe(6);
        await userEvent.keyboard('Q');
        await nextTask();
        expect(paragraph.node!.content).toBe('secondQ');
        expect((inlines[0] as MarkdownInline).node!.content).toBe('first');
      },
    );

    test('initial undo preserves focus and permits typing', async () => {
      const tree = parseMarkdownTree('alpha');
      state.editor.root = tree.root;
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const inline = renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline;
      inline.focus();
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(renderer.shadowRoot!.querySelector('md-inline:focus')).toBe(inline);
      expect(inline.node!.content).toBe('alpha');
      await userEvent.keyboard('Q');
      await nextTask();
      expect(inline.node!.content).toContain('Q');
    });

    test('history with missing focus falls back to an editable after undo and redo', async () => {
      const tree = state.editor.root![viewModel].tree;
      const node = tree.root.children![0];
      tree.edit(() => {
        node[viewModel].remove();
        return {};
      });
      await nextTask();
      // The edit detached the original focused node; restore a target for the shortcut.
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      (renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline).focus();
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(renderer.shadowRoot!.querySelector('md-inline:focus')).toBeTruthy();
      await userEvent.keyboard('{Control>}y{/Control}');
      await nextTask();
      expect(renderer.shadowRoot!.querySelector('md-inline:focus')).toBeTruthy();
      await userEvent.keyboard('Q');
      await nextTask();
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`Q`);
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
      const write = vi.spyOn(navigator.clipboard, 'write').mockResolvedValue();
      try {
        await state.input.insert('hello');
        await state.input.insertParagraph();
        await state.input.insert('world');
        await state.input.selectAll();
        await state.input.press('Control+a', 2);
        await state.input.press('Control+x');
        expect(write).toHaveBeenCalledOnce();
        await state.input.insert('again');
        expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`again`);
      } finally {
        write.mockRestore();
      }
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
