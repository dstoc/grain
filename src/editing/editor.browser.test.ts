import { test, describe, expect } from 'vitest';
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
    test('can undo block selection delete', async () => {
      await state.input.insert('hello');
      await state.input.insertParagraph();
      await state.input.insert('* item');
      await state.input.selectAll();
      await state.input.press('Control+a');
      await state.input.press('Backspace');
      await state.input.press('Control+z');
      expect(serializeEditor(state.editor)).toMatchInlineSnapshot(`
        hello
        * item
      `);
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
