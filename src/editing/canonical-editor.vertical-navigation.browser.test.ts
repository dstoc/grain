import { afterEach, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';

import { CanonicalWriter } from '../markdown/canonical-actions.js';
import { CanonicalDocument, CanonicalNode } from '../markdown/canonical-model.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import type { DocumentNode } from '../markdown/node.js';
import { CanonicalEditor } from './canonical-editor.js';
import { nextTask } from './test/lifecycle.js';

let editor: CanonicalEditor;
let model: CanonicalDocument;
let writer: CanonicalWriter;

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
    for (const renderer of deepElements(editor, 'md-block-render')) {
      await (renderer as HTMLElementTagNameMap['md-block-render']).updateComplete;
    }
    for (const inline of deepElements(editor, 'md-inline')) {
      await (inline as MarkdownInline).updateComplete;
    }
  }
}

async function mount(markdown: string, width = 320) {
  await mountModel(CanonicalDocument.fromMarkdown(markdown), width);
}

async function mountTree(tree: DocumentNode, width = 320) {
  await mountModel(CanonicalDocument.fromTree(tree), width);
}

async function mountModel(documentModel: CanonicalDocument, width: number) {
  model = documentModel;
  writer = new CanonicalWriter(model);
  editor = new CanonicalEditor();
  editor.document = model;
  editor.writer = writer;
  editor.style.cssText = `display:block;width:${width}px;font:16px Arial;line-height:24px`;
  document.body.replaceChildren(editor);
  await settle();
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

function inlineWithText(text: string) {
  const inline = deepElements(editor, 'md-inline')
    .map((element) => element as MarkdownInline)
    .find((candidate) => candidate.nodeView?.content === text);
  if (!inline) throw new Error(`no inline with text ${JSON.stringify(text)}`);
  return inline;
}

function caretRect(inline: MarkdownInline): DOMRect {
  const root = inline.getRootNode() as ShadowRoot & { getSelection: () => Selection | null };
  const selection = root.getSelection();
  if (!selection?.rangeCount) throw new Error('no native caret range');
  return selection.getRangeAt(0).getBoundingClientRect();
}

function visualLines(inline: MarkdownInline) {
  const range = document.createRange();
  range.selectNodeContents(inline);
  const rects = [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((left, right) => left.top - right.top || left.left - right.left);
  const lines: Array<{ top: number; bottom: number }> = [];
  for (const rect of rects) {
    const line = lines.at(-1);
    if (line && rect.top < line.bottom) {
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ top: rect.top, bottom: rect.bottom });
    }
  }
  return lines;
}

function nearestCaretDistance(inline: MarkdownInline, visualX: number, direction: 'up' | 'down') {
  inline.focus();
  const lines = visualLines(inline);
  const line = direction === 'up' ? lines.at(-1) : lines[0];
  if (!line) throw new Error(`no rendered ${direction} target line`);
  const candidates: number[] = [];
  for (let offset = 0; offset <= inline.nodeView!.content.length; offset++) {
    inline.setSelectionOffsets(offset, offset);
    const rect = caretRect(inline);
    const centerY = rect.top + rect.height / 2;
    if (
      !(rect.x === 0 && rect.y === 0 && rect.height === 0) &&
      centerY >= line.top - 1 &&
      centerY <= line.bottom + 1
    ) {
      candidates.push(Math.abs(rect.x - visualX));
    }
  }
  if (!candidates.length) throw new Error(`no caret positions on target ${direction} line`);
  return { distance: Math.min(...candidates), line, lineCount: lines.length };
}

async function expectVerticalCrossing(options: {
  source: string;
  target: string;
  edge: 'Home' | 'End';
  direction: 'up' | 'down';
  width?: number;
  wrapped?: boolean;
}) {
  const { source, target, edge, direction, width, wrapped } = options;
  await mount(direction === 'down' ? `${source}\n\n${target}` : `${target}\n\n${source}`, width);
  const sourceInline = inlineWithText(source);
  const targetInline = inlineWithText(target);
  const keyboardEvents: KeyboardEvent[] = [];
  const onKeydown = (event: KeyboardEvent) => keyboardEvents.push(event);
  editor.addEventListener('keydown', onKeydown);

  sourceInline.focus();
  await userEvent.keyboard(`{${edge}}`);
  await settle();
  const visualX = sourceInline.getCaretPosition().x;
  const expected = nearestCaretDistance(targetInline, visualX, direction);
  if (wrapped) expect(expected.lineCount).toBeGreaterThan(1);

  sourceInline.focus();
  await userEvent.keyboard(`{${edge}}`);
  await userEvent.keyboard(direction === 'down' ? '{ArrowDown}' : '{ArrowUp}');
  await settle();

  expect(targetInline.matches(':focus')).toBe(true);
  const selection = targetInline.getTextSelection()!;
  expect(selection.anchor).toBe(selection.focus);
  const actualRect = caretRect(targetInline);
  const actualCenterY = actualRect.top + actualRect.height / 2;
  expect(actualCenterY).toBeGreaterThanOrEqual(expected.line.top - 1);
  expect(actualCenterY).toBeLessThanOrEqual(expected.line.bottom + 1);
  expect(Math.abs(actualRect.x - visualX)).toBeLessThanOrEqual(expected.distance + 1);

  const targetNode = targetInline.nodeView as CanonicalNode;
  const original = targetNode.content!;
  const caretOffset = selection.focus;
  const edited = `${original.slice(0, caretOffset)}X${original.slice(caretOffset)}`;
  await userEvent.keyboard('X');
  await settle();
  expect(targetNode.content).toBe(edited);
  expect(inlineWithText(edited).matches(':focus')).toBe(true);

  await userEvent.keyboard('{Control>}z{/Control}');
  await settle();
  const afterUndo = inlineWithText(original);
  expect(targetNode.content).toBe(original);
  expect(afterUndo.matches(':focus')).toBe(true);
  expect(afterUndo.getTextSelection()).toEqual({ anchor: caretOffset, focus: caretOffset });

  await userEvent.keyboard('{Control>}y{/Control}');
  await settle();
  const afterRedo = inlineWithText(edited);
  expect(targetNode.content).toBe(edited);
  expect(afterRedo.matches(':focus')).toBe(true);
  expect(afterRedo.getTextSelection()).toEqual({ anchor: caretOffset + 1, focus: caretOffset + 1 });
  expect(keyboardEvents.every((event) => event.isTrusted)).toBe(true);
  editor.removeEventListener('keydown', onKeydown);
}

test.each([
  { source: 'aaa', target: 'bbb', edge: 'End' as const, direction: 'down' as const },
  { source: 'bbb', target: 'aaa', edge: 'Home' as const, direction: 'up' as const },
  { source: 'abcdef', target: 'xy', edge: 'End' as const, direction: 'down' as const },
])(
  'keeps the nearest rendered x for $direction from $source to $target through typing and history',
  async (fixture) => expectVerticalCrossing(fixture),
);

test('uses proportional caret geometry on the first wrapped destination line', async () => {
  await expectVerticalCrossing({
    source: 'WWWWWW',
    target: 'iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii',
    edge: 'End',
    direction: 'down',
    width: 100,
    wrapped: true,
  });
});

test('keeps rendered x when crossing into a differently indented nested list item', async () => {
  await mount('- parentwide\n  - child narrow', 280);
  const source = inlineWithText('parentwide');
  const target = inlineWithText('child narrow');
  source.focus();
  await userEvent.keyboard('{End}');
  await settle();
  const visualX = source.getCaretPosition().x;
  const expected = nearestCaretDistance(target, visualX, 'down');
  source.focus();
  await userEvent.keyboard('{End}');
  await userEvent.keyboard('{ArrowDown}');
  await settle();
  expect(target.matches(':focus')).toBe(true);
  expect(target.getTextSelection()!.anchor).toBe(target.getTextSelection()!.focus);
  expect(Math.abs(caretRect(target).x - visualX)).toBeLessThanOrEqual(expected.distance + 1);
});

test('keeps the existing edge fallback for an empty destination paragraph', async () => {
  await mountTree({
    type: 'document',
    children: [
      { type: 'paragraph', content: 'Source' },
      { type: 'paragraph', content: '' },
      { type: 'paragraph', content: 'After' },
    ],
  });
  const source = inlineWithText('Source');
  const empty = inlineWithText('');
  source.focus();
  await userEvent.keyboard('{End}{ArrowDown}');
  await settle();
  expect(empty.matches(':focus')).toBe(true);
  expect(empty.getTextSelection()).toEqual({ anchor: 0, focus: 0 });

  await userEvent.keyboard('X');
  await settle();
  expect(empty.nodeView?.content).toBe('X');
  await userEvent.keyboard('{Control>}z{/Control}');
  await settle();
  expect(inlineWithText('').getTextSelection()).toEqual({ anchor: 0, focus: 0 });
  await userEvent.keyboard('{Control>}y{/Control}');
  await settle();
  expect(inlineWithText('X').getTextSelection()).toEqual({ anchor: 1, focus: 1 });
});

test('keeps the code caret at the end when the final visual line is empty', async () => {
  await mountTree({
    type: 'document',
    children: [
      { type: 'code-block', info: null, content: 'line\n' },
      { type: 'paragraph', content: 'After' },
    ],
  });
  const code = inlineWithText('line\n');
  const after = inlineWithText('After');
  after.focus();
  await userEvent.keyboard('{Home}{ArrowUp}');
  await settle();
  expect(code.matches(':focus')).toBe(true);
  expect(code.getTextSelection()).toEqual({ anchor: 5, focus: 5 });

  await userEvent.keyboard('X');
  await settle();
  expect(code.nodeView?.content).toBe('line\nX');
  await userEvent.keyboard('{Control>}z{/Control}');
  await settle();
  expect(inlineWithText('line\n').getTextSelection()).toEqual({ anchor: 5, focus: 5 });
});
