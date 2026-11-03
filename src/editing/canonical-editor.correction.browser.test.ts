import { afterEach, expect, test } from 'vitest';
import { userEvent, cdp } from 'vitest/browser';
import { CanonicalDocument } from '../markdown/canonical-model.js';
import { CanonicalWriter, type ActionRequest } from '../markdown/canonical-actions.js';
import { parseBlocks } from '../markdown/block-parser/api.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import { asInlineMarkdownNodeView } from '../markdown/node-view.js';
import type { ReadonlyMarkdownNodeView } from '../markdown/node-view.js';
import { CanonicalEditor } from './canonical-editor.js';
import { insertParagraph } from './commands/insert-paragraph.js';
import { prepareEdit } from './prepare-edit.js';
import { nextTask } from './test/lifecycle.js';

let editor: CanonicalEditor | undefined;
let model: CanonicalDocument | undefined;
let writer: CanonicalWriter | undefined;
afterEach(async () => {
  editor?.remove();
  await nextTask();
  writer?.close();
  model?.close();
  writer = undefined;
  model = undefined;
  window.getSelection()?.removeAllRanges();
});

async function mount(_mode: string, source: string) {
  model = CanonicalDocument.fromMarkdown(source);
  writer = new CanonicalWriter(model);
  const canonical = new CanonicalEditor();
  canonical.document = model;
  canonical.writer = writer;
  editor = canonical;
  window.document.body.replaceChildren(editor);
  await nextTask();
  await editor.updateComplete;
  const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
  await renderer.updateComplete;
  await nextTask();
  return renderer;
}

async function applyRemote(prepare: (writer: CanonicalWriter) => ActionRequest | undefined) {
  const replica = CanonicalDocument.open(model!.checkpoint());
  const remote = new CanonicalWriter(replica);
  try {
    remote.admitSession('remote');
    const request = prepare(remote);
    if (!request) throw new Error('remote command was not applicable');
    const result = remote.apply(request, {
      sessionId: request.sessionId,
      authorityEpoch: request.authorityEpoch,
      sessionSequence: request.sessionSequence,
    });
    const action =
      result.status === 'pending'
        ? remote.publish(result.pending)
        : result.status === 'duplicate'
          ? result.accepted
          : undefined;
    if (!action) throw new Error(result.status);
    model!.applyAccepted({ revision: action.revision, update: action.update });
  } finally {
    remote.close();
    replica.close();
  }
}

for (const mode of ['canonical']) {
  test(`${mode} copying code plus a same-text heading preserves literal code`, async () => {
    const source = '```text\n# title\nliteral\n```\n\n# title\n\nbody';
    const renderer = await mount(mode, source);
    const inlines = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')];
    inlines[0]!.focus();
    inlines[0]!.setSelectionOffsets(0, 0);
    await userEvent.keyboard('{Control>}a{/Control}{Control>}a{/Control}{Control>}a{/Control}');
    await nextTask();
    await nextTask();
    expect(renderer.hostContext.selection.size).toBe(3);
    const clipboardData = new DataTransfer();
    const copy = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clipboardData,
    });
    inlines[0]!.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    const copied = parseBlocks(clipboardData.getData('text/plain')).node;
    expect(copied.children![0]).toMatchObject({ type: 'code-block', content: '# title\nliteral' });
  });

  test.each([
    ['body in unselected section', '# title\n\nbody', 'body', 'body\n'],
    ['heading without its body', '# title\n\nbody', 'title', '# title\n'],
    ['body among unselected sections', '# One\n\nbody\n\n# Two\n\nother', 'body', 'body\n'],
    ['second list item', '- first\n- second', 'second', '- second\n'],
    ['quoted paragraph', '> first\n>\n> second', 'second', 'second\n'],
  ])(`${mode} copy %s excludes unselected structure`, async (_label, source, content, expected) => {
    const renderer = await mount(mode, source);
    const inline = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].find(
      (i) => i.nodeView?.content === content,
    )!;
    inline.focus();
    inline.setSelectionOffsets(0, 0);
    const node = inline.nodeView!;
    renderer.hostContext.setSelection(node, node);
    await nextTask();
    const destination = window.document.createElement('textarea');
    window.document.body.append(destination);
    await userEvent.keyboard('{Control>}c{/Control}');
    destination.focus();
    await userEvent.keyboard('{Control>}v{/Control}');
    expect(destination.value).toBe(expected);
  });
}

test('composition invalidation restores the mapped caret before subsequent native typing', async () => {
  const renderer = await mount('canonical', 'alpha');
  const node = model!.root.children[0]!;
  const inline = renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
  inline.focus();
  inline.setSelectionOffsets(5, 5);
  await nextTask();
  const trace: unknown[] = [];
  inline.addEventListener('compositionend', (e) => trace.push({ type: e.type }));
  inline.addEventListener('input', (e) =>
    trace.push({
      type: e.type,
      inputType: (e as InputEvent).inputType,
      isComposing: (e as InputEvent).isComposing,
    }),
  );
  const devtools = cdp() as unknown as {
    send(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  await devtools.send('Input.imeSetComposition', {
    text: '漢',
    selectionStart: 1,
    selectionEnd: 1,
  });
  await applyRemote((remote) =>
    remote.prepareCommand({ actionId: 'interrupt', sessionId: 'remote' }, (draft) => {
      draft.spliceText(node.sharedId, { from: 0, to: 0, insert: 'R' });
    }),
  );
  await nextTask();
  await nextTask();
  const recovered = renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
  expect(recovered.composing).toBe(false);
  expect(recovered.getTextSelection()).toEqual({ anchor: 6, focus: 6 });
  expect(trace.some((event) => (event as { type: string }).type === 'compositionend')).toBe(false);
  await devtools.send('Input.insertText', { text: '!' });
  await nextTask();
  await nextTask();
  expect(node.content).toBe('Ralpha!');
  expect(
    renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!.getTextSelection(),
  ).toEqual({ anchor: 7, focus: 7 });
  await userEvent.keyboard('{Control>}z{/Control}');
  await nextTask();
  expect(node.content).toBe('Ralpha');
  await userEvent.keyboard('{Control>}y{/Control}');
  await nextTask();
  expect(node.content).toBe('Ralpha!');
});

test('composition recovery follows its text anchor through a remote split', async () => {
  const renderer = await mount('canonical', 'alpha');
  const node = model!.root.children[0]!;
  const inline = renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
  inline.focus();
  inline.setSelectionOffsets(5, 5);
  await nextTask();
  const devtools = cdp() as unknown as {
    send(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  const queuedKey = new KeyboardEvent('keydown', {
    key: 'Shift',
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  const replayedKeys: MarkdownInline[] = [];
  renderer.addEventListener('inline-keydown', (event) => {
    const detail = (event as CustomEvent<{ inline: MarkdownInline; keyboardEvent: KeyboardEvent }>)
      .detail;
    if (detail.keyboardEvent === queuedKey) replayedKeys.push(detail.inline);
  });
  await devtools.send('Input.imeSetComposition', {
    text: '漢',
    selectionStart: 1,
    selectionEnd: 1,
  });
  inline.addEventListener('composition-invalidated', () => inline.dispatchEvent(queuedKey), {
    once: true,
  });
  await applyRemote(
    (remote) =>
      prepareEdit(
        remote,
        { actionId: 'split-during-composition', sessionId: 'remote' },
        model!.root.sharedId,
        undefined,
        insertParagraph,
        { nodeId: node.sharedId, from: 2 },
      )?.request,
  );
  await nextTask();
  await nextTask();
  expect(model!.root.children.map((item) => item.content)).toEqual(['al', 'pha']);
  const inlines = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')];
  expect(inlines[1]!.getTextSelection()).toEqual({ anchor: 3, focus: 3 });
  expect(replayedKeys).toEqual([inlines[1]]);
  await devtools.send('Input.insertText', { text: '!' });
  await nextTask();
  await nextTask();
  expect(model!.root.children.map((item) => item.content)).toEqual(['al', 'pha!']);
  expect(inlines[1]!.getTextSelection()).toEqual({ anchor: 4, focus: 4 });
  await userEvent.keyboard('{Control>}z{/Control}');
  await nextTask();
  expect(model!.root.children.map((item) => item.content)).toEqual(['al', 'pha']);
  await userEvent.keyboard('{Control>}y{/Control}');
  await nextTask();
  expect(model!.root.children.map((item) => item.content)).toEqual(['al', 'pha!']);

  const original = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].find(
    (candidate) =>
      (candidate.nodeView as unknown as CanonicalDocument['root'] | undefined)?.sharedId ===
      node.sharedId,
  )!;
  original.focus();
  original.setSelectionOffsets(2, 2);
  await nextTask();
  await devtools.send('Input.insertText', { text: '?' });
  await nextTask();
  await nextTask();
  expect({
    acceptsInput: original.mobileToolbarInputReady,
    selection: original.getTextSelection(),
    text: original.textContent,
    model: model!.root.children.map((item) => item.content),
  }).toEqual({
    acceptsInput: true,
    selection: { anchor: 3, focus: 3 },
    text: 'al?',
    model: ['al?', 'pha!'],
  });
});

test('typing in the original paragraph after a remote split works without composition', async () => {
  const renderer = await mount('canonical', 'alpha');
  const node = model!.root.children[0]!;
  const inline = renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
  inline.focus();
  inline.setSelectionOffsets(5, 5);
  await nextTask();
  const devtools = cdp() as unknown as {
    send(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  await applyRemote(
    (remote) =>
      prepareEdit(
        remote,
        { actionId: 'split-without-composition', sessionId: 'remote' },
        model!.root.sharedId,
        undefined,
        insertParagraph,
        { nodeId: node.sharedId, from: 2 },
      )?.request,
  );
  await nextTask();
  await nextTask();
  const inlines = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')];
  expect(model!.root.children.map((item) => item.content)).toEqual(['al', 'pha']);
  inlines[1]!.focus();
  inlines[1]!.setSelectionOffsets(3, 3);
  await devtools.send('Input.insertText', { text: '!' });
  await nextTask();
  await nextTask();
  expect(model!.root.children.map((item) => item.content)).toEqual(['al', 'pha!']);
  expect(inlines[1]!.getTextSelection()).toEqual({ anchor: 4, focus: 4 });
  await userEvent.keyboard('{Control>}z{/Control}');
  await nextTask();
  expect(model!.root.children.map((item) => item.content)).toEqual(['al', 'pha']);
  await userEvent.keyboard('{Control>}y{/Control}');
  await nextTask();
  expect(model!.root.children.map((item) => item.content)).toEqual(['al', 'pha!']);

  const original = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].find(
    (candidate) =>
      (candidate.nodeView as unknown as CanonicalDocument['root'] | undefined)?.sharedId ===
      node.sharedId,
  )!;
  original.focus();
  original.setSelectionOffsets(2, 2);
  await nextTask();
  await devtools.send('Input.insertText', { text: '?' });
  await nextTask();
  await nextTask();
  expect({
    acceptsInput: original.mobileToolbarInputReady,
    selection: original.getTextSelection(),
    text: original.textContent,
    model: model!.root.children.map((item) => item.content),
  }).toEqual({
    acceptsInput: true,
    selection: { anchor: 3, focus: 3 },
    text: 'al?',
    model: ['al?', 'pha!'],
  });
});

test.each(['session', 'disconnect'] as const)(
  'composition recovery releases continued typing after %s changes the generation',
  async (boundary) => {
    const renderer = await mount('canonical', 'alpha');
    const canonical = editor as CanonicalEditor;
    const inline = renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
    inline.focus();
    inline.setSelectionOffsets(5, 5);
    await nextTask();

    const devtools = cdp() as unknown as {
      send(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    canonical.addEventListener(
      'inline-composition-end',
      () => {
        if (boundary === 'session') canonical.sessionId = 'replacement-session';
        else {
          canonical.remove();
          window.document.body.append(canonical);
        }
      },
      { once: true },
    );
    await devtools.send('Input.imeSetComposition', {
      text: '漢',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await devtools.send('Input.insertText', { text: '漢' });
    await nextTask();
    await nextTask();

    const recovered = renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
    expect(recovered.mobileToolbarInputReady).toBe(true);
    recovered.focus();
    recovered.setSelectionOffsets(5, 5);
    await userEvent.keyboard('!');
    await nextTask();
    await nextTask();

    expect(model!.root.children[0]!.content).toBe('alpha!');
    expect(recovered.mobileToolbarInputReady).toBe(true);
    if (boundary === 'session') {
      expect(writer!.canUndo('replacement-session', model!.root.children[0]!.sharedId)).toBe(true);
    }
  },
);

test('cross-node composition recovery discards queued input after a session change', async () => {
  const renderer = await mount('canonical', 'alpha');
  const canonical = editor!;
  const node = model!.root.children[0]!;
  const inline = renderer.shadowRoot!.querySelector<MarkdownInline>('md-inline')!;
  inline.focus();
  inline.setSelectionOffsets(5, 5);
  await nextTask();

  const devtools = cdp() as unknown as {
    send(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  const queuedKey = new KeyboardEvent('keydown', {
    key: 'Shift',
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  const replayed: KeyboardEvent[] = [];
  renderer.addEventListener('inline-keydown', (event) => {
    const detail = (event as CustomEvent<{ keyboardEvent: KeyboardEvent }>).detail;
    if (detail.keyboardEvent === queuedKey) replayed.push(detail.keyboardEvent);
  });
  inline.addEventListener('composition-invalidated', () => inline.queueRecoveryKeydown(queuedKey), {
    once: true,
  });
  canonical.addEventListener(
    'inline-projection-recovery',
    () => {
      canonical.sessionId = 'cross-node-replacement-session';
    },
    { capture: true, once: true },
  );
  await devtools.send('Input.imeSetComposition', {
    text: '漢',
    selectionStart: 1,
    selectionEnd: 1,
  });
  await applyRemote(
    (remote) =>
      prepareEdit(
        remote,
        { actionId: 'split-during-stale-composition-recovery', sessionId: 'remote' },
        model!.root.sharedId,
        undefined,
        insertParagraph,
        { nodeId: node.sharedId, from: 2 },
      )?.request,
  );
  await nextTask();
  await nextTask();

  const inlines = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')];
  expect(inlines.every((candidate) => candidate.mobileToolbarInputReady)).toBe(true);
  expect(replayed).toEqual([]);
  const target = renderer.getInlineSelection().inline!;
  const targetNode = target.nodeView as unknown as { content: string; sharedId: string };
  target.focus();
  target.setSelectionOffsets(target.textContent!.length, target.textContent!.length);
  await userEvent.keyboard('!');
  await nextTask();
  await nextTask();

  expect(targetNode.content.endsWith('!')).toBe(true);
  expect(target.mobileToolbarInputReady).toBe(true);
});

test('selected-block composition recovery does not commit or hold input across a session change', async () => {
  const renderer = await mount('canonical', 'alpha\n\nbeta');
  const canonical = editor!;
  const [first, last] = model!.root.children;
  const context = renderer.hostContext;
  const firstView = asInlineMarkdownNodeView(first as unknown as ReadonlyMarkdownNodeView);
  const lastView = asInlineMarkdownNodeView(last as unknown as ReadonlyMarkdownNodeView);
  context.selection.add(firstView);
  context.selection.add(lastView);
  context.selectionAnchor = lastView;
  context.selectionFocus = firstView;
  const inline = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')][1]!;
  inline.focus();
  inline.setSelectionOffsets(4, 4);
  await nextTask();

  const queuedKey = new KeyboardEvent('keydown', {
    key: 'Shift',
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  const replayed: KeyboardEvent[] = [];
  renderer.addEventListener('inline-keydown', (event) => {
    const detail = (event as CustomEvent<{ keyboardEvent: KeyboardEvent }>).detail;
    if (detail.keyboardEvent === queuedKey) replayed.push(detail.keyboardEvent);
  });
  canonical.addEventListener(
    'inline-composition-end',
    () => {
      canonical.sessionId = 'selected-block-replacement-session';
    },
    { once: true },
  );
  inline.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true, composed: true, data: '' }),
  );
  inline.queueRecoveryKeydown(queuedKey);
  inline.textContent = 'beta漢';
  inline.dispatchEvent(
    new CompositionEvent('compositionend', { bubbles: true, composed: true, data: '漢' }),
  );
  await nextTask();
  await nextTask();

  expect(model!.root.children.map((node) => node.content)).toEqual(['alpha', 'beta']);
  const recovered = [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].find(
    (candidate) => candidate.textContent === 'beta',
  )!;
  expect(recovered.mobileToolbarInputReady).toBe(true);
  expect(replayed).toEqual([]);
  context.selection.clear();
  context.selectionAnchor = undefined;
  context.selectionFocus = undefined;
  recovered.focus();
  recovered.setSelectionOffsets(4, 4);
  await userEvent.keyboard('!');
  await nextTask();
  await nextTask();

  expect(model!.root.children.map((node) => node.content)).toEqual(['alpha', 'beta!']);
  expect(recovered.mobileToolbarInputReady).toBe(true);
});
