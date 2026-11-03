import { afterEach, expect, test } from 'vitest';
import { userEvent, cdp } from 'vitest/browser';
import { CanonicalDocument } from '../markdown/canonical-model.js';
import { CanonicalWriter } from '../markdown/canonical-actions.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import { CanonicalEditor } from './canonical-editor.js';
import { nextTask } from './test/lifecycle.js';

let editor: CanonicalEditor | undefined;
let model: CanonicalDocument | undefined;
let writer: CanonicalWriter | undefined;
let renderer: HTMLElementTagNameMap['md-block-render'] | undefined;

afterEach(async () => {
  editor?.remove();
  await nextTask();
  writer?.close();
  model?.close();
  writer = undefined;
  model = undefined;
  editor = undefined;
  renderer = undefined;
  window.getSelection()?.removeAllRanges();
});

async function mount(source: string): Promise<MarkdownInline> {
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

function inlines(): MarkdownInline[] {
  return [...(renderer?.shadowRoot?.querySelectorAll<MarkdownInline>('md-inline') ?? [])];
}

async function settle(): Promise<void> {
  await nextTask();
  await editor?.updateComplete;
  await renderer?.updateComplete;
  await Promise.all(inlines().map((inline) => inline.updateComplete));
  await nextTask();
}

function devtools() {
  return cdp() as unknown as {
    send(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
}

test.each([
  ['shared prefix', 0, 5, 'alpine', 'alpine'],
  ['shared suffix', 0, 5, 'omega', 'omega'],
  ['leading whitespace', 5, 5, ' beta', 'alpha beta'],
  ['no overlap', 0, 5, 'BETA', 'BETA'],
] as const)(
  'native composition with %s commits at its original selection envelope',
  async (_label, from, to, composition, expected) => {
    const inline = await mount('alpha');
    inline.focus();
    inline.setSelectionOffsets(from, to);

    await devtools().send('Input.imeSetComposition', {
      text: composition,
      selectionStart: composition.length,
      selectionEnd: composition.length,
    });
    await devtools().send('Input.insertText', { text: composition });
    await settle();
    await settle();

    expect(model!.root.children[0]!.content).toBe(expected);
    expect(inlines()[0]!.textContent).toBe(expected);
    expect(inlines()[0]!.getTextSelection()).toEqual({
      anchor: expected.length,
      focus: expected.length,
    });

    await devtools().send('Input.insertText', { text: '!' });
    await settle();
    await settle();
    expect(model!.root.children[0]!.content).toBe(`${expected}!`);
    expect(inlines()[0]!.getTextSelection()).toEqual({
      anchor: expected.length + 1,
      focus: expected.length + 1,
    });

    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model!.root.children[0]!.content).toBe(expected);
    await userEvent.keyboard('{Control>}z{/Control}');
    await settle();
    expect(model!.root.children[0]!.content).toBe('alpha');
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model!.root.children[0]!.content).toBe(expected);
    await userEvent.keyboard('{Control>}y{/Control}');
    await settle();
    expect(model!.root.children[0]!.content).toBe(`${expected}!`);
  },
);
