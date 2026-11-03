import { afterEach, expect, test } from 'vitest';
import { CanonicalWriter } from '../markdown/canonical-actions.js';
import { CanonicalDocument } from '../markdown/canonical-model.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import { CanonicalEditor } from './canonical-editor.js';
import { nextTask } from './test/lifecycle.js';

let model: CanonicalDocument;
let writer: CanonicalWriter;
let editor: CanonicalEditor;

afterEach(async () => {
  editor?.remove();
  await nextTask();
  writer?.close();
  model?.close();
  window.getSelection()?.removeAllRanges();
});

for (const duringPublication of [false, true]) {
  test(`Enter from host callback, duringPublication=${duringPublication}`, async () => {
    model = CanonicalDocument.fromMarkdown('alpha');
    writer = new CanonicalWriter(model);
    editor = new CanonicalEditor();
    editor.document = model;
    editor.writer = writer;
    window.document.body.replaceChildren(editor);
    await nextTask();
    const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
    await renderer.updateComplete;
    const inline = renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
    await inline.updateComplete;
    inline.focus();
    inline.setSelectionOffsets(2, 2);
    const errors: unknown[] = [];
    editor.addEventListener('canonical-edit-error', (event) =>
      errors.push((event as CustomEvent).detail),
    );
    const enter = () =>
      inline.dispatchEvent(
        new CustomEvent('inline-input', {
          bubbles: true,
          composed: true,
          detail: {
            inline,
            node: inline.nodeView,
            content: inline.nodeView!.content,
            inputEvent: new InputEvent('beforeinput', { inputType: 'insertParagraph' }),
            inputStart: { index: 2 },
            inputEnd: { index: 2 },
          },
        }),
      );
    let first = true;
    const unsubscribe = writer.subscribe(() => {
      if (duringPublication && first) {
        first = false;
        enter();
      }
    });
    const node = model.root.children[0]!;
    writer.edit({ actionId: 'host-update' }, (draft) => {
      draft.spliceText(node.sharedId, { from: 5, to: 5, insert: '!' });
    });
    if (!duringPublication) enter();
    await nextTask();
    await nextTask();
    unsubscribe();
    expect(errors).toEqual([]);
    expect(model.root.children.map((child) => child.content)).toEqual(['al', 'pha!']);
  });
}
