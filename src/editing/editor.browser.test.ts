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
import { serializeToString } from '../markdown/block-serializer.js';
import { html } from 'lit';

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

  describe('plain-text paste', () => {
    test.each([
      ['alpha BETA omega', 6, 10, 'X', false, 'alpha X omega'],
      ['alpha BETA omega', 6, 10, 'X', true, 'alpha X omega'],
      ['alpha omega', 6, 6, 'X', false, 'alpha Xomega'],
      ['😀 BETA omega', 3, 7, '🦊', false, '😀 🦊 omega'],
      ['alpha BETA omega', 6, 10, 'X\nZ', false, 'alpha X Z omega'],
    ])(
      'pastes into %s at offsets %i–%i with %s (reverse: %s)',
      async (original, start, end, pasted, reverse, expected) => {
        const tree = new MarkdownTree({
          type: 'document',
          children: [{ type: 'paragraph', content: original }],
        });
        state.editor.root = tree.root;
        await nextTask();
        const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
        const inline = renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline;
        inline.focus();
        const walker = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT);
        let text: Node | null;
        do {
          text = walker.nextNode();
        } while (text && text.textContent !== original);
        expect(text).not.toBeNull();
        window
          .getSelection()!
          .setBaseAndExtent(text!, reverse ? end : start, text!, reverse ? start : end);
        const read = vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([]);
        const readText = vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue(pasted);
        const content = () => inline.node!.content;
        try {
          inline.onBeforeInput(new InputEvent('beforeinput', { inputType: 'insertFromPaste' }));
          await nextTask();
          expect(content()).toBe(expected);
          expect(inline.getSelection()?.start.index).toBe(start + pasted.length);
          await userEvent.keyboard('Y');
          await nextTask();
          const withTyping =
            expected.slice(0, start + pasted.length) + 'Y' + expected.slice(start + pasted.length);
          expect(content()).toBe(withTyping);
          await state.input.press('Control+z');
          expect(content()).toBe(original);
          await state.input.press('Control+y');
          expect(content()).toBe(withTyping);
        } finally {
          read.mockRestore();
          readText.mockRestore();
        }
      },
    );
  });

  describe('code block select all', () => {
    async function setup(content: string) {
      const tree = new MarkdownTree({
        type: 'document',
        children: [
          { type: 'code-block', info: 'text', content },
          { type: 'paragraph', content: 'beta' },
        ],
      });
      state.editor.root = tree.root;
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const inline = renderer.shadowRoot!.querySelector('md-inline')!;
      inline.focus();
      return { tree, inline, renderer };
    }

    test.each(['alpha', 'alpha\n', 'alpha\n\n', 'alpha\nbeta\n', ''])(
      'promotes native selection without changing code %j',
      async (content) => {
        const { tree, inline } = await setup(content);
        const before = serializeToString(tree.root);
        await userEvent.keyboard('{Control>}a{/Control}');
        await nextTask();
        expect(inline.hostContext!.selection.size).toBe(content ? 0 : 1);
        expect(serializeToString(tree.root)).toBe(before);
        if (content) {
          await userEvent.keyboard('{Control>}a{/Control}');
          await nextTask();
          expect(inline.hostContext!.selection.has(inline.node!)).toBe(true);
        }
        expect(inline.matches(':focus')).toBe(true);
        expect(serializeToString(tree.root)).toBe(before);
        await userEvent.keyboard('{Control>}a{/Control}');
        await nextTask();
        expect(inline.hostContext!.selection.size).toBe(2);
        expect(serializeToString(tree.root)).toBe(before);
      },
    );

    test.each([
      [0, 5],
      [1, 6],
      [1, 5],
    ])('does not promote partial text offsets %i–%i', async (start, end) => {
      const { inline } = await setup('alpha\n');
      const text = inline.querySelector('md-span')!.childNodes;
      const target = [...text].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent === 'alpha\n',
      )!;
      const range = document.createRange();
      range.setStart(target, start);
      range.setEnd(target, end);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      await userEvent.keyboard('{Control>}a{/Control}');
      await nextTask();
      expect(inline.hostContext!.selection.size).toBe(0);
      await userEvent.keyboard('{Control>}a{/Control}');
      await nextTask();
      expect(inline.hostContext!.selection.has(inline.node!)).toBe(true);
    });

    test.each([false, true])(
      'promotes full text boundaries across wrappers (reverse: %s)',
      async (reverse) => {
        const { inline } = await setup('alpha\n');
        const span = inline.querySelector('md-span')!;
        span.replaceChildren(document.createComment('before'), document.createTextNode('al'));
        const wrapper = document.createElement('md-span');
        wrapper.node = span.node;
        const last = document.createTextNode('pha\n');
        wrapper.append(last);
        span.append(wrapper, document.createComment('after'));
        const first = span.childNodes[1];
        const selection = window.getSelection()!;
        selection.setBaseAndExtent(
          reverse ? last : first,
          reverse ? last.length : 0,
          reverse ? first : last,
          reverse ? 0 : last.length,
        );
        await state.input.press('Control+a');
        expect(inline.hostContext!.selection.has(inline.node!)).toBe(true);
      },
    );

    test.each(['unavailable', 'throws', 'external', 'mismatch', 'unsupported'])(
      'declines ambiguous composed selection: %s',
      async (reason) => {
        const { inline, renderer } = await setup('alpha\n');
        const selection = document.getSelection()!;
        const text = [...inline.querySelector('md-span')!.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent === 'alpha\n',
        )!;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 5);
        selection.removeAllRanges();
        selection.addRange(range);
        if (reason === 'mismatch') text.textContent = 'alphb\n';
        if (reason === 'unsupported')
          inline.querySelector('md-span')!.append(document.createElement('b'));
        const spy = vi.spyOn(selection, 'getComposedRanges');
        if (reason === 'unavailable') spy.mockImplementation(undefined as never);
        else if (reason === 'throws')
          spy.mockImplementation(() => {
            throw new Error('unavailable');
          });
        else if (reason === 'external') {
          const other = renderer.shadowRoot!.querySelectorAll('md-inline')[1];
          spy.mockReturnValue([
            new StaticRange({
              startContainer: inline,
              startOffset: 0,
              endContainer: other,
              endOffset: 0,
            }),
          ]);
        } else {
          spy.mockReturnValue([
            new StaticRange({
              startContainer: inline,
              startOffset: 0,
              endContainer: inline,
              endOffset: inline.childNodes.length,
            }),
          ]);
        }
        try {
          await state.input.press('Control+a');
          expect(inline.hostContext!.selection.size).toBe(0);
        } finally {
          spy.mockRestore();
        }
      },
    );

    test('deletes the selected code and restores it with undo and redo', async () => {
      const { tree, inline } = await setup('alpha\n');
      const before = serializeToString(tree.root);
      await userEvent.keyboard('{Control>}a{/Control}{Control>}a{/Control}');
      await nextTask();
      expect(inline.hostContext!.selection.has(inline.node!)).toBe(true);
      await userEvent.keyboard('{Backspace}');
      await nextTask();
      expect(serializeToString(tree.root)).not.toBe(before);
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(serializeToString(tree.root)).toBe(before);
      await userEvent.keyboard('{Control>}y{/Control}');
      await nextTask();
      expect(serializeToString(tree.root)).not.toBe(before);
    });

    test.each(['fallback', 'inline', 'replacement'])(
      'keeps code delegate behavior for %s',
      async (mode) => {
        state.editor.renderDelegate = {
          renderCodeBlock: ({ node }) =>
            mode === 'fallback'
              ? undefined
              : mode === 'inline'
                ? html`<md-inline .node=${node}></md-inline>`
                : html`<b>replacement</b>`,
        };
        const { renderer } = await setup('alpha\n');
        if (mode === 'replacement') {
          expect(renderer.shadowRoot!.querySelector('b')!.textContent).toBe('replacement');
          expect(renderer.shadowRoot!.querySelectorAll('md-inline')).toHaveLength(1);
          return;
        }
        const inline = renderer.shadowRoot!.querySelector('md-inline')!;
        inline.focus();
        await userEvent.keyboard('{Control>}a{/Control}{Control>}a{/Control}');
        await nextTask();
        expect(inline.hostContext!.selection.has(inline.node!)).toBe(true);
      },
    );

    test('selects within a nested host without selecting its containing block', async () => {
      const nested = new MarkdownTree({
        type: 'document',
        children: [{ type: 'code-block', info: 'text', content: 'alpha\n' }],
      });
      state.editor.renderDelegate = {
        renderCodeBlock: ({ node }) =>
          node.info === 'nested'
            ? html`<md-transclusion .node=${node} .root=${nested.root}></md-transclusion>`
            : undefined,
      };
      await setup('outer');
      const outer = new MarkdownTree({
        type: 'document',
        children: [
          { type: 'code-block', info: 'nested', content: 'outer' },
          { type: 'paragraph', content: 'beta' },
        ],
      });
      state.editor.root = outer.root;
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const transclusion = renderer.shadowRoot!.querySelector('md-transclusion')!;
      const innerRenderer = transclusion.shadowRoot!.querySelector('md-block-render')!;
      const inline = innerRenderer.shadowRoot!.querySelector('md-inline')!;
      inline.focus();
      await userEvent.keyboard('{Control>}a{/Control}{Control>}a{/Control}');
      await nextTask();
      expect(inline.hostContext!.selection.has(inline.node!)).toBe(true);
      expect(renderer.hostContext.selection.size).toBe(0);
    });
  });

  describe('block prefix conversion', () => {
    test.each([
      ['# ', '# '],
      ['- ', '- '],
      ['> ', '> '],
    ])('keeps the caret before existing text after typing %s', async (prefix, serializedPrefix) => {
      await state.input.insert('hello');
      await userEvent.keyboard('{Home}');
      await userEvent.keyboard(prefix);
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const focused = () => renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      expect(focused().getSelection()?.start.index).toBe(0);
      await userEvent.keyboard('X');
      await nextTask();
      expect(serializeToString(state.editor.root![viewModel].tree.serialize())).toBe(
        serializedPrefix + 'Xhello\n',
      );
      await state.input.press('Control+z');
      await state.input.press('Control+y');
      expect(serializeToString(state.editor.root![viewModel].tree.serialize())).toBe(
        serializedPrefix + 'Xhello\n',
      );
    });

    test('keeps the caret within text inserted with a prefix', async () => {
      await state.input.insert('hello');
      await userEvent.keyboard('{Home}');
      await state.input.insert('# X');
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const focused = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      expect(focused.node!.content).toBe('Xhello');
      expect(focused.getSelection()?.start.index).toBe(1);
      await state.input.insert('Y');
      expect(focused.node!.content).toBe('XYhello');
    });

    test('keeps heading-like text after a heading marker at the caret', async () => {
      await state.input.insert('hello');
      await userEvent.keyboard('{Home}');
      await state.input.insert('# # X');
      await state.input.insert('Y');
      expect(serializeToString(state.editor.root![viewModel].tree.serialize())).toBe(
        '# # XYhello\n',
      );
    });

    test.each(['> # X', '> ># X'])(
      'keeps the paste position after stacked block markers %s and preserves history',
      async (prefix) => {
        await state.input.insert('hello');
        await userEvent.keyboard('{Home}');
        const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
        const inline = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
        const read = vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([]);
        const readText = vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue(prefix);
        try {
          await state.editor.triggerPaste(inline, inline.node!, { startIndex: 0, oldEndIndex: 0 });
          await nextTask();
          const focused = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
          expect(focused.getSelection()?.start.index).toBe(1);
          await userEvent.keyboard('Y');
          await nextTask();
          const serialize = () => serializeToString(state.editor.root![viewModel].tree.serialize());
          expect(serialize()).toBe('# XYhello\n');
          await state.input.press('Control+z');
          expect(serialize()).toBe('# Xhello\n');
          await state.input.press('Control+y');
          expect(serialize()).toBe('# XYhello\n');
        } finally {
          read.mockRestore();
          readText.mockRestore();
        }
      },
    );

    test('keeps seven hashes as content after a container marker', async () => {
      await state.input.insert('hello');
      await userEvent.keyboard('{Home}');
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const inline = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      const read = vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([]);
      const readText = vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('> ####### X');
      try {
        await state.editor.triggerPaste(inline, inline.node!, { startIndex: 0, oldEndIndex: 0 });
        await nextTask();
        const focused = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
        expect(focused.getSelection()?.start.index).toBe(9);
        await userEvent.keyboard('Y');
        await nextTask();
        const serialize = () => serializeToString(state.editor.root![viewModel].tree.serialize());
        expect(serialize()).toBe('> ####### XYhello\n');
        await state.input.press('Control+z');
        expect(serialize()).toBe('> ####### Xhello\n');
        await state.input.press('Control+y');
        expect(serialize()).toBe('> ####### XYhello\n');
      } finally {
        read.mockRestore();
        readText.mockRestore();
      }
    });

    test('keeps the paste position when a later line repeats the heading text', async () => {
      const tree = new MarkdownTree({
        type: 'document',
        children: [{ type: 'paragraph', content: 'hello\nXhello' }],
      });
      state.editor.root = tree.root;
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const inline = renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline;
      inline.focus();
      await userEvent.keyboard('{Home}');
      const read = vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([]);
      const readText = vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('# X');
      try {
        await state.editor.triggerPaste(inline, inline.node!, { startIndex: 0, oldEndIndex: 0 });
        await nextTask();
        const focused = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
        expect(focused.getSelection()?.start.index).toBe(1);
        await userEvent.keyboard('Y');
        await nextTask();
        expect(serializeToString(tree.serialize())).toBe('# XYhello\nXhello\n');
        await state.input.press('Control+z');
        await state.input.press('Control+y');
        expect(serializeToString(tree.serialize())).toBe('# XYhello\nXhello\n');
      } finally {
        read.mockRestore();
        readText.mockRestore();
      }
    });
  });

  describe('outdenting multi-block list items', () => {
    test.each([
      ['alpha', false],
      ['beta', false],
      ['alpha', true],
      ['beta', true],
    ] as const)(
      'preserves content and history from %s (block selection: %s)',
      async (content, selected) => {
        const source = '- alpha\n\n  beta\n\n  gamma\n  - child\n- tail\n';
        const tree = parseMarkdownTree(source);
        const before = serializeToString(tree.serialize());
        state.editor.root = tree.root;
        await nextTask();
        const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
        const inline = [...renderer.shadowRoot!.querySelectorAll('md-inline')].find(
          (element) => element.node?.content === content,
        )!;
        inline.focus();
        if (selected) {
          await userEvent.keyboard('{Home}{Shift>}{ArrowDown}{/Shift}');
          await nextTask();
          expect(inline.hostContext!.selection.size).toBeGreaterThan(0);
        }
        await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
        await nextTask();
        const serialize = () => serializeToString(tree.serialize());
        const after = serialize();
        expect(after).toBe('alpha\n\nbeta\n\ngamma\n- child\n- tail\n');
        expect(
          [...renderer.shadowRoot!.querySelectorAll('md-inline')].map((el) => el.node?.content),
        ).toEqual(['alpha', 'beta', 'gamma', 'child', 'tail']);
        await userEvent.keyboard('{Control>}z{/Control}');
        await nextTask();
        expect(serialize()).toBe(before);
        await userEvent.keyboard('{Control>}y{/Control}');
        await nextTask();
        expect(serialize()).toBe(after);
      },
    );
  });

  describe('Enter with an inline selection', () => {
    test('splits a selected prefix before a block marker and preserves history', async () => {
      const tree = new MarkdownTree({
        type: 'document',
        children: [{ type: 'paragraph', content: 'alpha * beta' }],
      });
      state.editor.root = tree.root;
      await nextTask();
      const inline = state.editor
        .shadowRoot!.querySelector('md-block-render')!
        .shadowRoot!.querySelector('md-inline')!;
      inline.focus();
      await userEvent.keyboard(
        '{Home}{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}',
      );
      expect(inline.getSelection()?.start.index).toBe(0);
      expect(inline.getSelection()?.end.index).toBe(6);
      const paragraphs = () => tree.serialize().children;
      await userEvent.keyboard('{Enter}');
      await nextTask();
      expect(paragraphs()).toEqual([
        { type: 'paragraph', content: '' },
        { type: 'paragraph', content: '* beta' },
      ]);
      await userEvent.keyboard('X');
      await nextTask();
      expect(paragraphs()).toEqual([
        { type: 'paragraph', content: '' },
        { type: 'paragraph', content: 'X* beta' },
      ]);
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(paragraphs()).toEqual([{ type: 'paragraph', content: 'alpha * beta' }]);
      await userEvent.keyboard('{Control>}y{/Control}');
      await nextTask();
      expect(paragraphs()).toEqual([
        { type: 'paragraph', content: '' },
        { type: 'paragraph', content: '* beta' },
      ]);
      await userEvent.keyboard('X');
      await nextTask();
      expect(paragraphs()).toEqual([
        { type: 'paragraph', content: '' },
        { type: 'paragraph', content: 'X* beta' },
      ]);
    });

    test.each([
      ['forward', false, false],
      ['reverse', true, false],
      ['ordered list', false, true],
    ])('replaces the selection and keeps the caret usable (%s)', async (_name, reverse, list) => {
      const paragraph = { type: 'paragraph' as const, content: 'alpha BETA omega' };
      const tree = new MarkdownTree({
        type: 'document',
        children: list
          ? [
              {
                type: 'list',
                children: [{ type: 'list-item', marker: '1. ', children: [paragraph] }],
              },
            ]
          : [paragraph],
      });
      state.editor.root = tree.root;
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const inline = renderer.shadowRoot!.querySelector('md-inline')!;
      inline.focus();
      await userEvent.keyboard(
        reverse
          ? '{Home}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Shift>}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{/Shift}'
          : '{Home}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}',
      );
      expect(inline.getSelection()?.start.index).toBe(6);
      expect(inline.getSelection()?.end.index).toBe(10);
      await userEvent.keyboard('{Enter}');
      await nextTask();
      const serialized = () => serializeToString(state.editor.root![viewModel].tree.serialize());
      const expected = list ? '1. alpha \n2.  omega\n' : 'alpha \n\n omega\n';
      expect(serialized()).toBe(expected);
      await userEvent.keyboard('X');
      await nextTask();
      expect(serialized()).toBe(list ? '1. alpha \n2. X omega\n' : 'alpha \n\nX omega\n');
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(serialized()).toBe(expected);
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(serialized()).toBe(list ? '1. alpha BETA omega\n' : 'alpha BETA omega\n');
      await userEvent.keyboard('{Control>}y{/Control}');
      await nextTask();
      expect(serialized()).toBe(expected);
      await userEvent.keyboard('X');
      await nextTask();
      expect(serialized()).toBe(list ? '1. alpha \n2. X omega\n' : 'alpha \n\nX omega\n');
    });
  });

  describe('inline Backspace', () => {
    test.each([
      ['separator', '---', 'after', false],
      ['asterisks', '***', 'after', false],
      ['created heading prefix', '#', ' heading', false],
      ['nested quote', '---', 'after', true],
    ])('keeps the destination and caret when joining %s', async (_name, before, after, nested) => {
      const paragraphs = [
        { type: 'paragraph' as const, content: before },
        { type: 'paragraph' as const, content: after },
      ];
      const tree = new MarkdownTree({
        type: 'document',
        children: [
          { type: 'paragraph', content: 'earlier' },
          ...(nested
            ? [{ type: 'block-quote' as const, marker: '> ', children: paragraphs }]
            : paragraphs),
        ],
      });
      state.editor.root = tree.root;
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const inlines = renderer.shadowRoot!.querySelectorAll('md-inline');
      const destination = (inlines[1] as MarkdownInline).node!;
      (inlines[2] as MarkdownInline).focus();
      const focused = () => renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      const contents = () =>
        [...renderer.shadowRoot!.querySelectorAll('md-inline')].map(
          (inline) => inline.node!.content,
        );
      await userEvent.keyboard('{Home}{Backspace}');
      await nextTask();
      expect(contents()).toEqual(['earlier', before + after]);
      expect(focused().node).toBe(destination);
      expect(focused().node!.type).toBe('paragraph');
      expect(focused().getSelection()?.start.index).toBe(before.length);
      await userEvent.keyboard('X');
      await nextTask();
      expect(contents()).toEqual(['earlier', before + 'X' + after]);
      expect(serializeToString(tree.serialize())).toBe(
        `earlier\n\n${nested ? '> ' : ''}${before}X${after}\n`,
      );
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(contents()).toEqual(['earlier', before, after]);
      await userEvent.keyboard('{Control>}y{/Control}');
      await nextTask();
      expect(contents()).toEqual(['earlier', before + after]);
      expect(focused().node).toBe(destination);
      expect(focused().getSelection()?.start.index).toBe(before.length);
      await userEvent.keyboard('X');
      await nextTask();
      expect(contents()).toEqual(['earlier', before + 'X' + after]);
    });

    test('joins paragraphs at the caret and restores the join through undo and redo', async () => {
      const tree = new MarkdownTree({
        type: 'document',
        children: [
          { type: 'paragraph', content: 'alpha' },
          { type: 'paragraph', content: 'beta' },
        ],
      });
      state.editor.root = tree.root;
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const focused = () => renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      (renderer.shadowRoot!.querySelectorAll('md-inline')[1] as MarkdownInline).focus();
      await userEvent.keyboard('{Home}{Backspace}');
      await nextTask();
      expect(serializeToString(tree.serialize())).toBe('alphabeta\n');
      expect(focused().getSelection()?.start.index).toBe(5);
      expect(focused().getSelection()?.end.index).toBe(5);
      await userEvent.keyboard('X');
      await nextTask();
      expect(serializeToString(tree.serialize())).toBe('alphaXbeta\n');
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(serializeToString(tree.serialize())).toBe('alphabeta\n');
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(serializeToString(tree.serialize())).toBe('alpha\n\nbeta\n');
      expect(focused().node!.content).toBe('beta');
      expect(focused().getSelection()?.start.index).toBe(0);
      await userEvent.keyboard('{Control>}y{/Control}');
      await nextTask();
      expect(serializeToString(tree.serialize())).toBe('alphabeta\n');
      expect(focused().getSelection()?.start.index).toBe(5);
      await userEvent.keyboard('X');
      await nextTask();
      expect(serializeToString(tree.serialize())).toBe('alphaXbeta\n');
      expect(focused().textContent).toContain('alphaXbeta');
    });

    async function seed(content: string) {
      const tree = new MarkdownTree({
        type: 'document',
        children: [{ type: 'paragraph', content }],
      });
      state.editor.root = tree.root;
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      (renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline).focus();
    }

    async function deleteAt(start: number, end = start) {
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const inline = renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      const text = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, end);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      inline.onBeforeInput(new InputEvent('beforeinput', { inputType: 'deleteContentBackward' }));
      await nextTask();
      return inline;
    }

    test('deletes an emoji with keyboard input', async () => {
      await seed('A😀B');
      await userEvent.keyboard('{End}{ArrowLeft}{Backspace}');
      await nextTask();
      expect(serializeToString(state.editor.root![viewModel].tree.serialize())).toBe('AB\n');
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(serializeToString(state.editor.root![viewModel].tree.serialize())).toBe('A😀B\n');
    });

    test('deletes a whole supplementary character and restores it on undo', async () => {
      await seed('A😀B');
      const inline = await deleteAt(3);
      expect(inline.node!.content).toBe('AB');
      expect(inline.textContent).toContain('AB');
      expect(inline.getSelection()?.start.index).toBe(1);
      expect(serializeToString(state.editor.root![viewModel].tree.serialize())).toBe('AB\n');
      await state.input.press('Control+z');
      expect(inline.node!.content).toBe('A😀B');
      await state.input.press('Control+y');
      expect(inline.node!.content).toBe('AB');
    });

    test('deletes a selected emoji and restores it on undo', async () => {
      await seed('A😀B');
      const inline = await deleteAt(1, 3);
      expect(inline.node!.content).toBe('AB');
      await state.input.press('Control+z');
      expect(inline.node!.content).toBe('A😀B');
    });

    test('deletes only the combining mark', async () => {
      await seed('AéB');
      const inline = await deleteAt(3);
      expect(inline.node!.content).toBe('AeB');
    });
  });

  describe('undo', () => {
    test.each([
      [
        '# main\n## section A\ntext\n\n## section B\n',
        'section B',
        'text',
        '# main\n## section A\ntextX\n',
      ],
      [
        '# main\n## section A\n### nested\nlast\n\n## section B\n',
        'section B',
        'last',
        '# main\n## section A\n### nested\nlastX\n',
      ],
      [
        '# main\n## section A\n\n## section B\n',
        'section B',
        'section A',
        '# main\n## section AX\n',
      ],
      ['before\n\n- item\n\nafter\n', 'after', 'item', 'before\n- itemX\n'],
    ])(
      'focuses the final preceding editable after block deletion',
      async (source, target, preceding, expected) => {
        const tree = parseMarkdownTree(source);
        const before = serializeToString(tree.serialize());
        state.editor.root = tree.root;
        await nextTask();
        const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
        const focused = () =>
          renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
        const inline = [...renderer.shadowRoot!.querySelectorAll('md-inline')].find(
          (el) => el.node?.content === target,
        )!;
        inline.focus();
        await state.input.selectAll();
        await state.input.press('Control+a');
        await state.input.press('Backspace');
        expect(focused().node!.content).toBe(preceding);
        expect(focused().getSelection()?.start.index).toBe(preceding.length);
        const after = serializeToString(tree.serialize());
        await state.input.press('Control+z');
        expect(serializeToString(tree.serialize())).toBe(before);
        await state.input.press('Control+y');
        expect(serializeToString(tree.serialize())).toBe(after);
        expect(focused().node!.content).toBe(preceding);
        await state.input.insert('X');
        expect(serializeToString(tree.serialize())).toBe(expected);
      },
    );

    test('uses document order for a reversed block selection and successful cut', async () => {
      const tree = parseMarkdownTree('# main\n## A\ntext\n\n## B\n\n## C\n');
      const before = serializeToString(tree.serialize());
      state.editor.root = tree.root;
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const inlines = [...renderer.shadowRoot!.querySelectorAll('md-inline')];
      const b = inlines.find((el) => el.node?.content === 'B')!;
      const c = inlines.find((el) => el.node?.content === 'C')!;
      c.focus();
      c.hostContext!.expandSelection([c.node!, b.node!]);
      const data = new DataTransfer();
      c.dispatchEvent(
        new ClipboardEvent('cut', {
          bubbles: true,
          composed: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
      await nextTask();
      expect(data.getData('text/plain')).toContain('## B');
      const focused = () => renderer.shadowRoot!.querySelector('md-inline:focus') as MarkdownInline;
      expect(focused().node!.content).toBe('text');
      expect(focused().getSelection()?.start.index).toBe(4);
      const after = serializeToString(tree.serialize());
      await state.input.press('Control+z');
      expect(serializeToString(tree.serialize())).toBe(before);
      await state.input.press('Control+y');
      expect(serializeToString(tree.serialize())).toBe(after);
      await state.input.insert('X');
      expect(focused().node!.content).toBe('textX');
    });

    test('keeps promoted section children after deleting its heading', async () => {
      const tree = parseMarkdownTree('# main\n## A\ntext\n\n## B\nkeep\n');
      const before = serializeToString(tree.serialize());
      state.editor.root = tree.root;
      await nextTask();
      const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
      const b = [...renderer.shadowRoot!.querySelectorAll('md-inline')].find(
        (el) => el.node?.content === 'B',
      )!;
      b.focus();
      await state.input.selectAll();
      await state.input.press('Control+a');
      await state.input.press('Backspace');
      const after = serializeToString(tree.serialize());
      expect(after).toContain('keep');
      await state.input.press('Control+z');
      expect(serializeToString(tree.serialize())).toBe(before);
      await state.input.press('Control+y');
      expect(serializeToString(tree.serialize())).toBe(after);
      await state.input.insert('X');
      expect(serializeToString(tree.serialize())).toContain('textX');
      expect(serializeToString(tree.serialize())).toContain('keep');
    });

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

    test.each(['', 'first\n**bold**'])(
      'edits literal code and restores it through undo and redo',
      async (content) => {
        const tree = new MarkdownTree({
          type: 'document',
          children: [{ type: 'code-block', info: 'js', content }],
        });
        state.editor.root = tree.root;
        await nextTask();
        const renderer = state.editor.shadowRoot!.querySelector('md-block-render')!;
        const inline = renderer.shadowRoot!.querySelector('md-inline')!;
        inline.focus();
        const range = document.createRange();
        range.selectNodeContents(inline);
        range.collapse(false);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        await state.input.insert('[x](url)');
        expect(inline.innerText).toBe(content + '[x](url)');
        expect(inline.getSelection()?.start.index).toBe(content.length + 8);
        await state.input.press('Control+z');
        expect(inline.innerText).toBe(content);
        await state.input.press('Control+y');
        expect(inline.innerText).toBe(content + '[x](url)');
      },
    );
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

describe('composition recovery', () => {
  function setSelection(inline: MarkdownInline, anchor: number, focus = anchor) {
    const walker = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let next: Node | null;
    while ((next = walker.nextNode())) nodes.push(next as Text);
    const pointAt = (requested: number): [Node, number] => {
      let remaining = requested;
      for (const node of nodes) {
        if (remaining <= node.length) return [node, remaining];
        remaining -= node.length;
      }
      return nodes.length ? [nodes.at(-1)!, nodes.at(-1)!.length] : [inline, 0];
    };
    const [anchorNode, anchorOffset] = pointAt(anchor);
    const [focusNode, focusOffset] = pointAt(focus);
    window.getSelection()!.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  }

  function compositionInput(
    inline: MarkdownInline,
    mutate: () => void,
    anchor: number,
    focus: number,
    data: string,
    targetRange?: { start: number; end: number },
  ) {
    setSelection(inline, anchor, focus);
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      inputType: 'insertCompositionText',
      data,
      isComposing: true,
    });
    if (targetRange) {
      const text = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT).nextNode()!;
      Object.defineProperty(beforeInput, 'getTargetRanges', {
        value: () => [
          new StaticRange({
            startContainer: text,
            startOffset: targetRange.start,
            endContainer: text,
            endOffset: targetRange.end,
          }),
        ],
      });
    }
    inline.dispatchEvent(beforeInput);
    mutate();
    setSelection(inline, anchor + data.length, anchor + data.length);
    inline.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertCompositionText',
        data,
        isComposing: true,
      }),
    );
  }

  function getInline(editor: Editor) {
    return editor
      .shadowRoot!.querySelector('md-block-render')!
      .shadowRoot!.querySelector('md-inline')!;
  }

  async function setup(content: string, start: number, end = start) {
    const editor = new Editor();
    document.body.replaceChildren(editor);
    const tree = new MarkdownTree({ type: 'document', children: [{ type: 'paragraph', content }] });
    editor.root = tree.root;
    await nextTask();
    const inline = editor
      .shadowRoot!.querySelector('md-block-render')!
      .shadowRoot!.querySelector('md-inline')!;
    inline.focus();
    const text = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT).nextNode() as Text | null;
    setSelection(inline, start, end);
    return { editor, tree, inline, text: text! };
  }

  test('replays the no-op and leading-space voice updates as one model-safe sequence', async () => {
    const { editor, tree, inline } = await setup('Block Harness', 13);
    inline.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    inline.dispatchEvent(
      new CompositionEvent('compositionupdate', { bubbles: true, data: 'Harness' }),
    );
    inline.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: 'Harness' }),
    );
    await nextTask();
    expect(serializeToString(tree.root)).toBe('Block Harness\n');
    expect(getInline(editor).textContent).toBe('Block Harness');

    const current = getInline(editor);
    const text = document.createTreeWalker(current, NodeFilter.SHOW_TEXT).nextNode() as Text;
    current.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    compositionInput(current, () => (text.textContent = 'Block Harness Test'), 13, 13, ' Test');
    compositionInput(current, () => (text.textContent = 'Block Harness Test'), 14, 18, 'Test');
    current.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'Test' }));
    await nextTask();
    const recovered = getInline(editor);
    expect(serializeToString(tree.root)).toBe('Block Harness Test\n');
    expect(recovered.textContent).toBe('Block Harness Test');
    expect(recovered.matches(':focus')).toBe(true);

    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('Block Harness\n');
    await userEvent.keyboard('{Control>}y{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('Block Harness Test\n');
    await userEvent.keyboard('!');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('Block Harness Test!\n');
  });

  test.each([
    ['target range', true],
    ['selection fallback', false],
  ])(
    'expands the replacement left without moving its right endpoint (%s)',
    async (_, useTargetRange) => {
      const { editor, tree, inline } = await setup('alpha beta omega', 10);
      inline.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      compositionInput(
        inline,
        () => {
          const text = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT).nextNode() as Text;
          text.textContent = 'alpha BETA omega';
        },
        6,
        10,
        'BETA',
        useTargetRange ? { start: 6, end: 10 } : undefined,
      );
      inline.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'BETA' }));
      await nextTask();

      expect(serializeToString(tree.root)).toBe('alpha BETA omega\n');
      expect(getInline(editor).textContent).toBe('alpha BETA omega');
      expect(getInline(editor).matches(':focus')).toBe(true);

      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(serializeToString(tree.root)).toBe('alpha beta omega\n');
      await userEvent.keyboard('{Control>}y{/Control}');
      await nextTask();
      expect(serializeToString(tree.root)).toBe('alpha BETA omega\n');

      await userEvent.keyboard('!');
      await nextTask();
      expect(serializeToString(tree.root)).toBe('alpha BETA! omega\n');
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(serializeToString(tree.root)).toBe('alpha BETA omega\n');
      await userEvent.keyboard('{Control>}z{/Control}');
      await nextTask();
      expect(serializeToString(tree.root)).toBe('alpha beta omega\n');
    },
  );

  test('preserves a rightward replacement envelope extension', async () => {
    const { editor, tree, inline } = await setup('alpha beta omega', 6);
    inline.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    compositionInput(
      inline,
      () => {
        const text = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT).nextNode() as Text;
        text.textContent = 'alpha BEbeta omega';
      },
      6,
      6,
      'BE',
    );
    compositionInput(
      inline,
      () => {
        const text = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT).nextNode() as Text;
        text.textContent = 'alpha BETA omega';
      },
      6,
      12,
      'BETA',
      { start: 6, end: 12 },
    );
    inline.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'BETA' }));
    await nextTask();

    expect(serializeToString(tree.root)).toBe('alpha BETA omega\n');
    expect(getInline(editor).textContent).toBe('alpha BETA omega');
    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('alpha beta omega\n');
    await userEvent.keyboard('{Control>}y{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('alpha BETA omega\n');
  });

  test('commits an empty-inline replay once and removes native inline-boundary text', async () => {
    const { editor, tree, inline } = await setup('', 0);
    inline.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    let nativeText: Text | undefined;
    compositionInput(
      inline,
      () => {
        nativeText = document.createTextNode('Hello');
        inline.append(nativeText);
      },
      0,
      0,
      'Hello',
    );
    compositionInput(inline, () => (nativeText!.textContent = 'Hello world'), 0, 5, 'Hello world');
    compositionInput(
      inline,
      () => (nativeText!.textContent = 'Hello world!'),
      0,
      11,
      'Hello world!',
    );
    compositionInput(
      inline,
      () => (nativeText!.textContent = 'Hello world!'),
      0,
      12,
      'Hello world!',
    );
    inline.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: 'Hello world!' }),
    );
    await nextTask();
    let recovered = getInline(editor);
    expect(serializeToString(tree.root)).toBe('Hello world!\n');
    expect(recovered.textContent).toBe('Hello world!');
    expect(recovered.querySelectorAll('md-span')).not.toHaveLength(0);
    expect(recovered.matches(':focus')).toBe(true);

    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('<!-- -->\n');
    await userEvent.keyboard('{Control>}y{/Control}');
    await nextTask();
    recovered = getInline(editor);
    expect(serializeToString(tree.root)).toBe('Hello world!\n');
    expect(recovered.textContent).toBe('Hello world!');
    tree.root[viewModel].renderSignal.value++;
    await nextTask();
    expect(getInline(editor).textContent).toBe('Hello world!');
  });

  test('recovery preserves unaffected inline identity', async () => {
    const editor = new Editor();
    document.body.replaceChildren(editor);
    const tree = new MarkdownTree({
      type: 'document',
      children: [
        { type: 'paragraph', content: 'first' },
        { type: 'paragraph', content: 'second' },
      ],
    });
    editor.root = tree.root;
    await nextTask();
    const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
    const inlines = [...renderer.shadowRoot!.querySelectorAll('md-inline')];
    inlines[0]!.focus();
    setSelection(inlines[0]!, 5);
    inlines[0]!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const firstText = document
      .createTreeWalker(inlines[0]!, NodeFilter.SHOW_TEXT)
      .nextNode() as Text;
    compositionInput(inlines[0]!, () => (firstText.textContent = 'first!'), 5, 5, '!');
    inlines[0]!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '!' }));
    await nextTask();
    expect(renderer.shadowRoot!.querySelectorAll('md-inline')[1]).toBe(inlines[1]);
    expect(serializeToString(tree.root)).toBe('first!\n\nsecond\n');
  });

  test('restores the projection and preserves redo on selected cancellation', async () => {
    const { editor, tree, inline } = await setup('anchor', 6);
    await userEvent.keyboard('X');
    await nextTask();
    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    const text = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT).nextNode()!;
    window.getSelection()!.setBaseAndExtent(text, 1, text, 6);
    inline.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    text.textContent = 'aé'; // Emulate the browser's provisional selected-range mutation.
    inline.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    await nextTask();
    const recovered = getInline(editor);
    expect(recovered.textContent).toBe('anchor');
    expect(recovered.getTextSelection()).toEqual({ anchor: 1, focus: 6 });
    expect(serializeToString(tree.root)).toBe('anchor\n');
    await userEvent.keyboard('{Control>}y{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('anchorX\n');
  });

  test('commits one replacement and isolates adjacent edits in history', async () => {
    const { editor, tree } = await setup('anchor', 6);
    await userEvent.keyboard('X');
    await nextTask();
    const current = getInline(editor);
    const active = document.createTreeWalker(current, NodeFilter.SHOW_TEXT).nextNode() as Text;
    setSelection(current, 7);
    current.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    compositionInput(current, () => (active.textContent = 'anchorXé'), 7, 7, 'é');
    current.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'é' }));
    await nextTask();
    expect(serializeToString(tree.root)).toBe('anchorXé\n');
    await userEvent.keyboard('é');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('anchorXéé\n');
    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('anchorXé\n');
    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('anchorX\n');
    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('anchor\n');
  });

  test('ignores a late completion after a model change', async () => {
    const { editor, tree, inline, text } = await setup('anchor', 6);
    inline.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    text.textContent = 'anchoré';
    const node = inline.node!;
    tree.edit(() => {
      node[viewModel].edit({ startIndex: 6, oldEndIndex: 6, newEndIndex: 7, newText: 'X' });
      return {};
    });
    inline.dispatchEvent(
      new InputEvent('beforeinput', { bubbles: true, inputType: 'deleteContentBackward' }),
    );
    inline.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'é' }));
    await nextTask();
    expect(serializeToString(tree.root)).toBe('anchorX\n');
    expect(getInline(editor).textContent).toBe('anchorX');
  });

  test('resumes typing after invalidation without a composition end', async () => {
    const { editor, tree, inline, text } = await setup('anchor', 3);
    inline.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    text.textContent = 'ancéhor';
    const node = inline.node!;
    tree.edit(() => {
      node[viewModel].edit({ startIndex: 6, oldEndIndex: 6, newEndIndex: 7, newText: '!' });
      return {};
    });
    await nextTask();
    expect(getInline(editor).textContent).toBe('anchor!');
    expect(getInline(editor).getSelection()?.start.index).toBe(0);
    await userEvent.keyboard('X');
    await nextTask();
    expect(getInline(editor).textContent).toBe('Xanchor!');
    expect(node.content).toBe('Xanchor!');
    expect(serializeToString(tree.root)).toBe('Xanchor!\n');
    expect(getInline(editor).getSelection()?.start.index).toBe(1);
    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('anchor\n');
    await userEvent.keyboard('{Control>}y{/Control}');
    await nextTask();
    expect(getInline(editor).textContent).toBe('Xanchor!');
    expect(serializeToString(tree.root)).toBe('Xanchor!\n');
  });

  test('a no-op completion restores the DOM without creating a history boundary', async () => {
    const { editor, tree, inline } = await setup('anchor', 6);
    await userEvent.keyboard('X');
    await nextTask();
    const text = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT).nextNode()!;
    window.getSelection()!.setBaseAndExtent(text, 6, text, 7);
    inline.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    text.textContent = 'anchorpreedit';
    inline.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'X' }));
    await nextTask();
    expect(getInline(editor).textContent).toBe('anchorX');
    await userEvent.keyboard('Y');
    await nextTask();
    await userEvent.keyboard('{Control>}z{/Control}');
    await nextTask();
    expect(serializeToString(tree.root)).toBe('anchor\n');
  });
});
