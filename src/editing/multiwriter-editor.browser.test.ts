import { afterEach, expect, test, vi } from 'vitest';
import { userEvent, cdp } from 'vitest/browser';
import { html } from 'lit';
import { IndexedDBActionJournal } from '../markdown/multiwriter/providers/index.js';
import type { ViewNode } from '../markdown/multiwriter/projection/types.js';
import { createGenesis, decodeGenesis } from '../markdown/multiwriter/bootstrap/index.js';
import { openReplica, type Replica } from '../markdown/multiwriter/replica/index.js';
import {
  LocalEditor,
  insertText,
  insertParagraph,
  deleteBlocks,
} from '../markdown/multiwriter/authoring/index.js';
import { serializeProjection } from '../markdown/multiwriter/projection/index.js';
import { asInlineMarkdownNodeView } from '../markdown/node-view.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import { MultiwriterEditor } from './multiwriter-editor.js';
import { nextTask } from './test/lifecycle.js';

function devtools() {
  return cdp() as unknown as {
    send(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
}
const mounts: { editor: MultiwriterEditor; replica: Replica }[] = [];
afterEach(async () => {
  for (const { editor, replica } of mounts.splice(0)) {
    editor.remove();
    await replica.close();
  }
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});
async function mount(
  bytes: Uint8Array,
  journal?: Awaited<ReturnType<typeof IndexedDBActionJournal.open>>,
) {
  const replica = await openReplica({
    genesis: bytes,
    persistedGenesis: bytes,
    journal: journal ?? {
      read: async () => [],
      append: async () => {},
      close() {},
    },
    mode: 'bidirectional',
  });
  const editor = new MultiwriterEditor();
  editor.replica = replica;
  editor.style.display = 'block';
  editor.style.width = '390px';
  document.body.append(editor);
  mounts.push({ editor, replica });
  await settle(editor);
  const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
  return {
    editor,
    replica,
    renderer,
    inlines: () => [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')],
  };
}
async function settle(editor: MultiwriterEditor) {
  for (let i = 0; i < 4; i++) {
    await nextTask();
    await editor.updateComplete;
    const renderer = editor.shadowRoot!.querySelector('md-block-render');
    await renderer?.updateComplete;
    await Promise.all(
      [...(renderer?.shadowRoot?.querySelectorAll('md-block, md-inline') ?? [])].map(
        (e) => (e as MarkdownInline).updateComplete,
      ),
    );
  }
}
const markdown = (replica: Replica) => serializeProjection(replica.publication().value.view);
function focus(inline: MarkdownInline, offset = inline.nodeView!.content.length) {
  inline.focus();
  inline.setSelectionOffsets(offset, offset);
}
async function type(text: string, editor: MultiwriterEditor) {
  await userEvent.keyboard(text);
  await settle(editor);
}
function paste(inline: MarkdownInline, text: string, markdown = '') {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);
  if (markdown) clipboardData.setData('text/markdown', markdown);
  const event = new ClipboardEvent('paste', {
    bubbles: true,
    composed: true,
    cancelable: true,
    clipboardData,
  });
  inline.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

test('trusted typing, Enter, Backspace join and per-pane undo/redo use independent replicas', async () => {
  const bytes = createGenesis('mounted-typing', 'base');
  const a = await mount(bytes),
    b = await mount(bytes);
  const errors: unknown[] = [];
  a.editor.addEventListener('replica-edit-error', (e) => errors.push((e as CustomEvent).detail));
  focus(a.inlines()[0]);
  await type('AB', a.editor);
  expect(markdown(a.replica)).toBe('baseAB\n');
  expect(a.replica.status().history.undo).toBe(1);
  await type('{Enter}tail', a.editor);
  expect(markdown(a.replica)).toBe('baseAB\n\ntail\n');
  b.replica.receiveBundle('peer', a.replica.captureBundle());
  await settle(b.editor);
  expect(markdown(b.replica)).toBe(markdown(a.replica));
  focus(b.inlines()[1]);
  await type('B', b.editor);
  a.replica.receiveBundle('peer', b.replica.captureBundle());
  await settle(a.editor);
  focus(a.inlines()[1], 0);
  await type('{Backspace}', a.editor);
  expect(markdown(a.replica)).toBe('baseABtailB\n');
  await type('{Control>}z{/Control}', a.editor);
  expect(markdown(a.replica)).toBe('baseAB\n\ntailB\n');
  await type('{Control>}y{/Control}', a.editor);
  expect(markdown(a.replica)).toBe('baseABtailB\n');
  expect(b.replica.status().history.undo).toBe(1);
  expect(errors).toEqual([]);
});

test('remote prepend maps native caret and preserves distant DOM without focusing another pane', async () => {
  const bytes = createGenesis('mounted-caret', 'first\n\nsecond');
  const a = await mount(bytes),
    b = await mount(bytes);
  const second = b.inlines()[1],
    facade = second.nodeView;
  focus(b.inlines()[0], 3);
  await nextTask();
  const first = a.replica.publication().value.view.root.children[0];
  a.replica.edit(insertText, {
    nodeId: a.replica.handle(first.origin.representative),
    from: 0,
    text: 'remote ',
  });
  b.replica.receiveBundle('peer', a.replica.captureBundle());
  await settle(b.editor);
  expect(b.inlines()[1]).toBe(second);
  expect(second.nodeView).toBe(facade);
  expect(b.inlines()[0].getTextSelection()).toEqual({ anchor: 10, focus: 10 });
  await type('X', b.editor);
  expect(markdown(b.replica)).toBe('remote firXst\n\nsecond\n');
  const source = document.createElement('textarea');
  document.body.append(source);
  source.focus();
  a.replica.edit(insertParagraph, {
    nodeId: a.replica.handle(first.origin.representative),
    from: 2,
  });
  b.replica.receiveBundle('peer', a.replica.captureBundle());
  await settle(b.editor);
  expect(document.activeElement).toBe(source);
  expect(b.inlines().at(-1)).toBe(second);
  source.remove();
});

test('Markdown paste, task state, indentation and block clipboard retain undo', async () => {
  const p = await mount(createGenesis('mounted-paste', 'base'));
  focus(p.inlines()[0]);
  paste(p.inlines()[0], '* [ ] one\n* two', '* [ ] one\n* two');
  await settle(p.editor);
  expect(markdown(p.replica)).toContain('* [ ] one');
  const task = p.renderer.shadowRoot!.querySelector('md-block[type="list-item"]')!;
  const node = (task as unknown as { node: unknown }).node;
  task.dispatchEvent(
    new CustomEvent('task-state-intent', {
      detail: { node, operation: 'cycle' },
      bubbles: true,
      composed: true,
    }),
  );
  await settle(p.editor);
  expect(markdown(p.replica)).toContain('* [x] one');
  focus(p.inlines().at(-1)!);
  await type('{Tab}', p.editor);
  expect(markdown(p.replica)).toContain('  * two');
  await type('{Control>}z{/Control}', p.editor);
  expect(markdown(p.replica)).toContain('\n* two');
  focus(p.inlines().at(-1)!);
  await type('{Control>}a{/Control}', p.editor);
  await type('{Control>}a{/Control}', p.editor);
  const clipboardData = new DataTransfer();
  p.inlines()
    .at(-1)!
    .dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  expect(clipboardData.getData('text/plain')).toContain('two');
});

test('remote deletion resolves fallback and empty-root caret does not author until input', async () => {
  const bytes = createGenesis('mounted-delete', 'old\n\nlast');
  const a = await mount(bytes),
    b = await mount(bytes);
  focus(a.inlines()[0], 2);
  await nextTask();
  const first = b.replica.publication().value.view.root.children[0];
  b.replica.edit(deleteBlocks, { nodeIds: [b.replica.handle(first.origin.representative)] });
  a.replica.receiveBundle('peer', b.replica.captureBundle());
  await settle(a.editor);
  expect(a.inlines()[0].getTextSelection()).toEqual({ anchor: 0, focus: 0 });
  await type('A', a.editor);
  expect(markdown(a.replica)).toBe('Alast\n');
  const remaining = a.replica.publication().value.view.root.children[0];
  a.replica.edit(({ draft }, id: string) => {
    draft.deleteSubtree(id);
    return { status: 'handled' };
  }, a.replica.handle(remaining.origin.representative));
  await settle(a.editor);
  expect(a.replica.publication().value.view.emptyRoot).not.toBeNull();
  expect(a.inlines()).toHaveLength(1);
  expect(markdown(a.replica)).toBe('');
  focus(a.inlines()[0], 0);
  await type('new', a.editor);
  expect(markdown(a.replica)).toBe('new\n');
});

test('trusted code Enter and plain text paste preserve trailing LF and Unicode', async () => {
  const p = await mount(createGenesis('mounted-code', '```\nhello\n```'));
  focus(p.inlines()[0]);
  await type('{Enter}', p.editor);
  expect(p.inlines()[0].nodeView!.content).toBe('hello\n');
  paste(p.inlines()[0], '🙂\n漢');
  await settle(p.editor);
  expect(p.inlines()[0].nodeView!.content).toBe('hello\n🙂\n漢');
  await type('{Control>}z{/Control}', p.editor);
  expect(p.inlines()[0].nodeView!.content).toBe('hello\n');
});

test('CDP composition commits once through managed history', async () => {
  const p = await mount(createGenesis('mounted-ime', 'base'));
  focus(p.inlines()[0]);
  await nextTask();
  await devtools().send('Input.imeSetComposition', {
    text: '漢',
    selectionStart: 1,
    selectionEnd: 1,
  });
  await devtools().send('Input.insertText', { text: '漢' });
  await settle(p.editor);
  expect(markdown(p.replica)).toBe('base漢\n');
  expect(p.replica.status().history.undo).toBe(1);
  await type('X', p.editor);
  expect(markdown(p.replica)).toBe('base漢X\n');
  await type('{Control>}z{/Control}', p.editor);
  expect(markdown(p.replica)).toBe('base漢\n');
  await type('{Control>}z{/Control}', p.editor);
  expect(markdown(p.replica)).toBe('base\n');
});

test('composition invalidation follows split ownership and replays queued input exactly once', async () => {
  const bytes = createGenesis('mounted-split-ime', 'alpha');
  const a = await mount(bytes),
    b = await mount(bytes);
  const inline = a.inlines()[0],
    replayed: MarkdownInline[] = [];
  focus(inline);
  await nextTask();
  const queued = new KeyboardEvent('keydown', {
    key: 'Shift',
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  a.renderer.addEventListener('inline-keydown', (event) => {
    const detail = (event as CustomEvent<{ inline: MarkdownInline; keyboardEvent: KeyboardEvent }>)
      .detail;
    if (detail.keyboardEvent === queued) replayed.push(detail.inline);
  });
  await devtools().send('Input.imeSetComposition', {
    text: '漢',
    selectionStart: 1,
    selectionEnd: 1,
  });
  inline.addEventListener('composition-invalidated', () => inline.dispatchEvent(queued), {
    once: true,
  });
  const first = b.replica.publication().value.view.root.children[0];
  b.replica.edit(insertParagraph, {
    nodeId: b.replica.handle(first.origin.representative),
    from: 2,
  });
  a.replica.receiveBundle('peer', b.replica.captureBundle());
  await settle(a.editor);
  expect(markdown(a.replica)).toBe('al\n\npha\n');
  expect(a.inlines()[1].getTextSelection()).toEqual({ anchor: 3, focus: 3 });
  expect(replayed).toEqual([a.inlines()[1]]);
  await devtools().send('Input.insertText', { text: '!' });
  await settle(a.editor);
  expect(markdown(a.replica)).toBe('al\n\npha!\n');
  await type('{Control>}z{/Control}', a.editor);
  expect(markdown(a.replica)).toBe('al\n\npha\n');
});

test('composition recovery cannot steal focus after Source wins an asynchronous render race', async () => {
  const bytes = createGenesis('mounted-ime-race', 'alpha');
  const a = await mount(bytes),
    b = await mount(bytes);
  const inline = a.inlines()[0];
  focus(inline);
  await nextTask();
  await devtools().send('Input.imeSetComposition', {
    text: '漢',
    selectionStart: 1,
    selectionEnd: 1,
  });
  const source = document.createElement('textarea');
  document.body.append(source);
  inline.addEventListener(
    'composition-invalidated',
    () => {
      source.focus();
    },
    { once: true },
  );
  const first = b.replica.publication().value.view.root.children[0];
  b.replica.edit(insertText, {
    nodeId: b.replica.handle(first.origin.representative),
    from: 0,
    text: 'R',
  });
  a.replica.receiveBundle('peer', b.replica.captureBundle());
  await settle(a.editor);
  expect(document.activeElement).toBe(source);
  expect(markdown(a.replica)).toBe('Ralpha\n');
  expect(a.replica.status().history.undo).toBe(0);
  source.remove();
});

test('a remote deletion during composition cancels the native branch and later typing uses fallback', async () => {
  const bytes = createGenesis('mounted-ime-delete', 'alpha\n\nlast');
  const a = await mount(bytes),
    b = await mount(bytes);
  const inline = a.inlines()[0];
  focus(inline);
  await nextTask();
  await devtools().send('Input.imeSetComposition', {
    text: '漢',
    selectionStart: 1,
    selectionEnd: 1,
  });
  const first = b.replica.publication().value.view.root.children[0];
  b.replica.edit(({ draft }, id: string) => {
    draft.deleteSubtree(id);
    return { status: 'handled' };
  }, b.replica.handle(first.origin.representative));
  a.replica.receiveBundle('peer', b.replica.captureBundle());
  await settle(a.editor);
  expect(markdown(a.replica)).toBe('last\n');
  expect(a.inlines()[0].getTextSelection()).toEqual({ anchor: 0, focus: 0 });
  await type('X', a.editor);
  expect(markdown(a.replica)).toBe('Xlast\n');
});

test('native text/plain-only paste remains literal and failed block cut leaves the document selected', async () => {
  const p = await mount(createGenesis('mounted-native-clipboard', 'base'));
  const source = document.createElement('textarea');
  source.value = '# literal';
  document.body.append(source);
  source.focus();
  source.select();
  await userEvent.keyboard('{Control>}c{/Control}');
  source.remove();
  const inline = p.inlines()[0];
  focus(inline);
  let trusted = false;
  let types: string[] = [];
  inline.addEventListener(
    'paste',
    (event) => {
      trusted = event.isTrusted;
      types = [...(event.clipboardData?.types ?? [])];
    },
    { once: true },
  );
  await type('{Control>}v{/Control}', p.editor);
  expect(trusted).toBe(true);
  expect(types).toEqual(['text/plain']);
  expect(markdown(p.replica)).toBe('base# literal\n');
  await type('{Control>}a{/Control}', p.editor);
  await type('{Control>}a{/Control}', p.editor);
  const before = markdown(p.replica),
    clipboardData = new DataTransfer();
  vi.spyOn(clipboardData, 'setData').mockImplementation(() => {
    throw new Error('denied');
  });
  inline.dispatchEvent(
    new ClipboardEvent('cut', { clipboardData, bubbles: true, composed: true, cancelable: true }),
  );
  await settle(p.editor);
  expect(markdown(p.replica)).toBe(before);
  expect(inline.hostContext!.hasSelection).toBe(true);
});

test('same-account mounted restart preserves exact native state and only resets the restarted history', async () => {
  const bytes = createGenesis('mounted-idb', 'base'),
    descriptor = decodeGenesis(bytes);
  const identity = {
    namespace: crypto.randomUUID(),
    protocolVersion: 3 as const,
    documentId: descriptor.documentId,
    genesisId: descriptor.genesisId,
  };
  const a = await mount(bytes, await IndexedDBActionJournal.open(identity)),
    b = await mount(bytes);
  focus(a.inlines()[0]);
  await type('A', a.editor);
  focus(b.inlines()[0]);
  await type('B', b.editor);
  a.replica.receiveBundle('peer', b.replica.captureBundle());
  await settle(a.editor);
  const before = markdown(a.replica),
    held = a.replica.retainedUpdate();
  await a.replica.flush();
  a.editor.remove();
  await a.replica.close();
  const reopened = await mount(bytes, await IndexedDBActionJournal.open(identity));
  expect(markdown(reopened.replica)).toBe(before);
  expect(reopened.replica.retainedUpdate()).toEqual(held);
  expect(reopened.replica.status().history).toMatchObject({ reset: true, undo: 0, redo: 0 });
  expect(b.replica.status().history.undo).toBe(1);
  focus(reopened.inlines()[0]);
  await type('R', reopened.editor);
  expect(markdown(reopened.replica)).toContain('R');
});

test('nested host input, selection and history stay in the initiating projected section', async () => {
  const p = await mount(
    createGenesis(
      'mounted-host',
      '```nested\nhost\n```\n\n# Section\n\nalpha\n\nbeta\n\n# After\n\nend',
    ),
  );
  const root = p.renderer.block!;
  const section = root.children!.find((node) => node.type === 'section')!;
  p.editor.renderDelegate = {
    renderCodeBlock: ({ node }) =>
      node.info === 'nested'
        ? html`<md-transclusion .node=${node} .root=${section}></md-transclusion>`
        : undefined,
  };
  await settle(p.editor);
  const transclusion = p.renderer.shadowRoot!.querySelector('md-transclusion')!;
  await transclusion.updateComplete;
  const nestedRenderer = transclusion.shadowRoot!.querySelector('md-block-render')!;
  await nestedRenderer.updateComplete;
  const nested = [...nestedRenderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')];
  focus(nested[1]);
  await type('X', p.editor);
  expect(markdown(p.replica)).toContain('alphaX');
  await type('{Control>}z{/Control}', p.editor);
  expect(markdown(p.replica)).not.toContain('alphaX');
  await type('{Control>}y{/Control}', p.editor);
  expect(markdown(p.replica)).toContain('alphaX');
  expect(nested[1].hostContext).not.toBe(p.renderer.hostContext);
});

test('toolbar navigation and edits target the initiating pane after toolbar focus', async () => {
  const bytes = createGenesis('mounted-toolbar', 'first\n\nsecond');
  const a = await mount(bytes),
    b = await mount(bytes);
  focus(a.inlines()[0]);
  await type('A', a.editor);
  focus(b.inlines()[0]);
  await type('B', b.editor);
  focus(a.inlines()[0]);
  await nextTask();
  const control = document.createElement('button');
  control.textContent = 'Toolbar';
  document.body.append(control);
  control.focus();
  await a.editor.toolbarAction('undo');
  await settle(a.editor);
  expect(markdown(a.replica)).toBe('first\n\nsecond\n');
  expect(markdown(b.replica)).toBe('firstB\n\nsecond\n');
  control.focus();
  await a.editor.toolbarAction('redo');
  await settle(a.editor);
  expect(markdown(a.replica)).toBe('firstA\n\nsecond\n');
  control.focus();
  await a.editor.toolbarAction('split');
  await settle(a.editor);
  expect(a.inlines()).toHaveLength(3);
  expect(b.inlines()).toHaveLength(2);
  control.remove();
});

test('scoped browser commands validate scope separately from the initiating host', async () => {
  const p = await mount(
    createGenesis('mounted-scope', '# Section\n\ninside\n\n# Other\n\noutside'),
  );
  const walk = (node: ViewNode): ViewNode[] => [node, ...node.children.flatMap(walk)];
  const section = walk(p.replica.publication().value.view.root).find(
    (node) => node.type === 'section' && node.content === 'Other',
  )!;
  p.editor.scopeRoot = section.origin;
  focus(p.inlines().at(-1)!);
  await type('X', p.editor);
  expect(markdown(p.replica)).toContain('outsideX');
  await type('{Control>}z{/Control}', p.editor);
  expect(markdown(p.replica)).not.toContain('outsideX');
  const before = markdown(p.replica),
    errors: unknown[] = [];
  p.editor.addEventListener('replica-edit-error', (event) =>
    errors.push((event as CustomEvent).detail),
  );
  focus(p.inlines()[1]);
  await type('Y', p.editor);
  expect(markdown(p.replica)).toBe(before);
  expect(errors.length).toBeGreaterThan(0);
});

test('stale mounted typing and splitting cannot rescue a deleted native suffix', async () => {
  const bytes = createGenesis('mounted-deletion-wins', 'abcdef\n\nlast');
  const a = await mount(bytes),
    b = await mount(bytes);
  const first = b.replica.publication().value.view.root.children[0];
  b.replica.edit(({ draft }, id: string) => {
    draft.deleteSubtree(id);
    return { status: 'handled' };
  }, b.replica.handle(first.origin.representative));
  focus(a.inlines()[0], 3);
  await type('X{Enter}', a.editor);
  b.replica.receiveBundle('peer', a.replica.captureBundle());
  await settle(b.editor);
  a.replica.receiveBundle('peer', b.replica.captureBundle());
  await settle(a.editor);
  expect(markdown(a.replica)).toBe(markdown(b.replica));
  expect(markdown(a.replica)).not.toContain('def');
  expect(markdown(a.replica)).not.toContain('abc');
  expect(markdown(a.replica)).not.toContain('X');
  expect(markdown(a.replica)).toContain('last');
  expect(
    a.replica.publication().value.view.root.children.some((node) => node.type === 'block-quote'),
  ).toBe(false);
});

test('mode changes and a distant remote edit preserve a valid native composition', async () => {
  const bytes = createGenesis('mounted-ime-distant', 'first\n\nsecond');
  const a = await mount(bytes),
    b = await mount(bytes);
  const inline = a.inlines()[1];
  focus(inline);
  await nextTask();
  await devtools().send('Input.imeSetComposition', {
    text: '漢',
    selectionStart: 1,
    selectionEnd: 1,
  });
  a.replica.setMode('outbound-only');
  a.replica.setMode('bidirectional');
  const first = b.replica.publication().value.view.root.children[0];
  b.replica.edit(insertText, {
    nodeId: b.replica.handle(first.origin.representative),
    from: 0,
    text: 'R',
  });
  a.replica.receiveBundle('peer', b.replica.captureBundle());
  await nextTask();
  expect(a.inlines()[1]).toBe(inline);
  expect(inline.composing).toBe(true);
  await devtools().send('Input.insertText', { text: '漢' });
  await settle(a.editor);
  expect(markdown(a.replica)).toBe('Rfirst\n\nsecond漢\n');
  expect(a.replica.status().history.undo).toBe(1);
});

test('retained publication failure restores its staged caret without duplicating text or history', async () => {
  const p = await mount(createGenesis('mounted-retained', 'base'));
  const errors: unknown[] = [];
  p.editor.addEventListener('replica-edit-error', (event) =>
    errors.push((event as CustomEvent).detail),
  );
  focus(p.inlines()[0]);
  await nextTask();
  const refresh = vi.spyOn(LocalEditor.prototype, 'refresh').mockImplementationOnce(() => {
    throw new Error('publication failed');
  });
  await type('A', p.editor);
  refresh.mockRestore();
  expect(markdown(p.replica)).toBe('baseA\n');
  expect(p.inlines()[0].getTextSelection()).toEqual({ anchor: 5, focus: 5 });
  expect(errors).toHaveLength(1);
  expect(p.replica.status().localEdits).toBe(1);
  await type('X', p.editor);
  expect(markdown(p.replica)).toBe('baseAX\n');
  await type('{Control>}z{/Control}', p.editor);
  expect(markdown(p.replica)).toBe('base\n');
});

test('selected-block Delete preserves direction through undo and continued replacement', async () => {
  const p = await mount(
    createGenesis('mounted-selected-delete', 'Alpha\n\nBeta\n\nGamma\n\nDelta'),
  );
  const beta = p.inlines()[1],
    gamma = p.inlines()[2],
    context = p.renderer.hostContext;
  focus(gamma);
  context.setSelection(
    asInlineMarkdownNodeView(gamma.nodeView!),
    asInlineMarkdownNodeView(beta.nodeView!),
  );
  await type('{Delete}', p.editor);
  expect(markdown(p.replica)).toBe('Alpha\n\nDelta\n');
  expect(p.inlines()[0].getTextSelection()).toEqual({ anchor: 5, focus: 5 });
  await type('{Control>}z{/Control}', p.editor);
  expect([...context.selection].map((node) => node.content).sort()).toEqual(['Beta', 'Gamma']);
  expect(context.selectionAnchor?.content).toBe('Gamma');
  expect(context.selectionFocus?.content).toBe('Beta');
  await type('R', p.editor);
  expect(markdown(p.replica)).toBe('Alpha\n\nR\n\nDelta\n');
  await type('{Control>}z{/Control}', p.editor);
  expect(markdown(p.replica)).toBe('Alpha\n\nBeta\n\nGamma\n\nDelta\n');
});

test('trusted Shift+Enter and supplementary-character composition round-trip through history', async () => {
  const p = await mount(createGenesis('mounted-shift-emoji', '😀'));
  focus(p.inlines()[0]);
  await type('{Shift>}{Enter}{/Shift}', p.editor);
  expect(markdown(p.replica)).not.toBe('😀\n');
  await type('{Control>}z{/Control}', p.editor);
  expect(markdown(p.replica)).toBe('😀\n');
  const inline = p.inlines()[0];
  inline.focus();
  inline.setSelectionOffsets(0, 2);
  await devtools().send('Input.imeSetComposition', {
    text: '😁',
    selectionStart: 2,
    selectionEnd: 2,
  });
  await devtools().send('Input.insertText', { text: '😁' });
  await settle(p.editor);
  expect(markdown(p.replica)).toBe('😁\n');
  await type('{Control>}z{/Control}', p.editor);
  expect(markdown(p.replica)).toBe('😀\n');
  await type('{Control>}y{/Control}', p.editor);
  expect(markdown(p.replica)).toBe('😁\n');
});

test('successful block cut keeps Markdown markers and undo restores the selected block', async () => {
  const p = await mount(createGenesis('mounted-cut', '* [x] task\n\nlast'));
  const inline = p.inlines()[0],
    context = p.renderer.hostContext;
  focus(inline);
  context.setSelection(
    asInlineMarkdownNodeView(inline.nodeView!),
    asInlineMarkdownNodeView(inline.nodeView!),
  );
  const data = new DataTransfer();
  inline.dispatchEvent(
    new ClipboardEvent('cut', {
      clipboardData: data,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
  await settle(p.editor);
  expect(data.getData('text/plain')).toContain('* [x] task');
  expect(markdown(p.replica)).not.toContain('task');
  await type('{Control>}z{/Control}', p.editor);
  expect(markdown(p.replica)).toContain('* [x] task');
  expect(context.selection.size).toBe(1);
});

test('remote partial block-selection deletion collapses to its surviving directional focus', async () => {
  const bytes = createGenesis('mounted-partial-selection', 'Alpha\n\nBeta\n\nGamma\n\nDelta');
  const a = await mount(bytes),
    b = await mount(bytes);
  focus(a.inlines()[1]);
  await type('{Control>}a{/Control}', a.editor);
  await type('{Control>}a{/Control}', a.editor);
  await type('{Shift>}{ArrowDown}{/Shift}', a.editor);
  expect([...a.renderer.hostContext.selection].map((node) => node.content).sort()).toEqual([
    'Beta',
    'Gamma',
  ]);
  const beta = b.replica.publication().value.view.root.children[1];
  b.replica.edit(({ draft }, id: string) => {
    draft.deleteSubtree(id);
    return { status: 'handled' };
  }, b.replica.handle(beta.origin.representative));
  a.replica.receiveBundle('peer', b.replica.captureBundle());
  await settle(a.editor);
  expect(a.renderer.hostContext.selection.size).toBe(0);
  expect(a.inlines()[1].nodeView!.content).toBe('Gamma');
  expect(a.inlines()[1].getTextSelection()).toEqual({ anchor: 5, focus: 5 });
  await type('X', a.editor);
  expect(markdown(a.replica)).toBe('Alpha\n\nGammaX\n\nDelta\n');
});

test('inactive pane maps partial block selection without stealing peer focus and resumes from the mapped caret', async () => {
  const bytes = createGenesis('mounted-inactive-selection', 'Alpha\n\nBeta\n\nGamma\n\nDelta');
  const a = await mount(bytes),
    b = await mount(bytes);
  focus(a.inlines()[1]);
  await type('{Control>}a{/Control}', a.editor);
  await type('{Control>}a{/Control}', a.editor);
  await type('{Shift>}{ArrowDown}{/Shift}', a.editor);
  focus(b.inlines()[0]);
  await nextTask();
  const beta = b.replica.publication().value.view.root.children[1];
  b.replica.edit(({ draft }, id: string) => {
    draft.deleteSubtree(id);
    return { status: 'handled' };
  }, b.replica.handle(beta.origin.representative));
  a.replica.receiveBundle('peer', b.replica.captureBundle());
  await settle(a.editor);
  expect(b.inlines()[0].matches(':focus')).toBe(true);
  expect(a.renderer.hostContext.selection.size).toBe(0);
  const control = document.createElement('button');
  document.body.append(control);
  control.focus();
  await a.editor.toolbarAction('left');
  await settle(a.editor);
  expect(a.inlines()[1].getTextSelection()).toEqual({ anchor: 4, focus: 4 });
  await type('X', a.editor);
  expect(markdown(a.replica)).toBe('Alpha\n\nGammXa\n\nDelta\n');
  control.remove();
});
