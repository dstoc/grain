import { afterEach, expect, test } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import type { LitElement } from 'lit';

import { nextTask } from './editing/test/lifecycle.js';
import type { CanonicalDocument } from './markdown/canonical/document.js';
import type { CanonicalNode } from './markdown/canonical/node-projection.js';
import type { CanonicalWriter } from './markdown/canonical/writer.js';
import type { TwoClientExperiment } from './editing/two-client-experiment.js';
import type { CanonicalEditor } from './editing/canonical-editor.js';
import { MarkdownInline } from './markdown/inline-render.js';
import './main.js';

interface HarnessInternals {
  readonly canonicalDocument?: CanonicalDocument;
  readonly canonicalWriter?: CanonicalWriter;
  readonly twoClientMode: boolean;
  readonly twoClientExperiment?: TwoClientExperiment;
  markdownForSave(): string;
}

let harness: LitElement | undefined;

afterEach(async () => {
  harness?.remove();
  await nextTask();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await page.viewport(1280, 720);
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  harness = undefined;
});

async function settleHarness(target = harness!) {
  await nextTask();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await target.updateComplete;
  const editors = [...target.shadowRoot!.querySelectorAll('md-canonical-editor')];
  for (const editor of editors) {
    await (editor as LitElement).updateComplete;
    const renderer = editor.shadowRoot!.querySelector('md-block-render') as LitElement;
    await renderer.updateComplete;
    await Promise.all(
      [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')].map(
        (inline) => inline.updateComplete,
      ),
    );
  }
  await nextTask();
  await target.updateComplete;
}

async function mountHarness(markdown: string) {
  harness = document.createElement('md-dev-harness') as LitElement;
  document.body.replaceChildren(harness);
  await harness.updateComplete;
  const source = harness.shadowRoot!.querySelector('textarea')!;
  source.value = markdown;
  source.dispatchEvent(new Event('input', { bubbles: true }));
  await settleHarness();
  return { harness, source };
}

async function enableTwoClients() {
  const toggle = harness!.shadowRoot!.querySelector<HTMLButtonElement>('.experiment-toggle')!;
  toggle.click();
  await settleHarness();
  return editors();
}

function editors() {
  return [...harness!.shadowRoot!.querySelectorAll<CanonicalEditor>('md-canonical-editor')];
}

function inlines(editor: Element) {
  const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
  return [...renderer.shadowRoot!.querySelectorAll<MarkdownInline>('md-inline')];
}

function inlineWithText(editor: Element, text: string) {
  const inline = inlines(editor).find((candidate) => candidate.nodeView?.content === text);
  if (!inline) throw new Error(`could not find inline with ${JSON.stringify(text)}`);
  return inline;
}

function expectReplicaConvergence() {
  const state = harness as unknown as HarnessInternals;
  const authority = state.canonicalDocument!;
  const authorityState = authority.checkpoint();
  const clients = state.twoClientExperiment!.clients;
  for (const client of clients) {
    expect(client.document.acceptedRevision).toBe(authority.acceptedRevision);
    expect(client.document.canonicalSnapshot()).toEqual(authority.canonicalSnapshot());
    expect([...client.document.checkpoint().update]).toEqual([...authorityState.update]);
  }
  expect([...clients[0].document.checkpoint().update]).toEqual([
    ...clients[1].document.checkpoint().update,
  ]);
}

function acceptPaneText(index: 0 | 1, actionId: string, insert: string, offset?: number) {
  const state = harness as unknown as HarnessInternals;
  const client = state.twoClientExperiment!.clients[index]!;
  const writer = client.writer!;
  const node = client.document.root.children[0]!;
  const from = offset ?? node.content!.length;
  const request = writer.prepareTextInput(
    node.sharedId,
    { from, to: from, insert },
    { actionId, sessionId: client.sessionId },
  );
  writer.trackPreparedAction(request);
  const transport = state.twoClientExperiment!.sessionTransport(client.sessionId)!;
  const result = transport.apply(writer, request, {
    sessionId: client.sessionId,
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  });
  if (result.status === 'pending') return transport.publish(writer, request, result.pending);
  if (result.status === 'duplicate') return result.accepted;
  if (result.status === 'rejected') writer.releasePreparedAction(request);
  throw new Error(`expected authority-accepted text update, got ${result.status}`);
}

function canonicalInline(document: CanonicalDocument, content: string): CanonicalNode | undefined {
  const pending = [document.root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.content === content) return node;
    pending.push(...[...(node.children ?? [])].reverse());
  }
  return undefined;
}

async function typeAtEnd(inline: MarkdownInline, text: string) {
  inline.focus();
  const end = inline.nodeView?.content.length ?? 0;
  inline.setSelectionOffsets(end, end);
  await userEvent.keyboard(text);
  await settleHarness();
}

function devtools() {
  return cdp() as unknown as {
    send(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
}

test('keeps single-client mode by default and delivers edits and structural history between real editors', async () => {
  await mountHarness('alpha\n\nbeta');
  expect(editors()).toHaveLength(1);
  expect((harness as unknown as HarnessInternals).twoClientMode).toBe(false);

  const [editorA, editorB] = await enableTwoClients();
  expect(editors()).toHaveLength(2);
  const state = harness as unknown as HarnessInternals;
  expect(editorA!.writer).toBe(state.twoClientExperiment!.clients[0].writer);
  expect(editorB!.writer).toBe(state.twoClientExperiment!.clients[1].writer);
  expect(editorA!.writer).not.toBe(editorB!.writer);
  expect(editorA!.writer).not.toBe(state.canonicalWriter);
  expect(harness!.shadowRoot!.textContent).toContain('Network/offline delivery');
  expect(harness!.shadowRoot!.textContent).toContain(
    'stale-client Receive reconciliation are omitted',
  );
  expectReplicaConvergence();

  await typeAtEnd(inlineWithText(editorA!, 'alpha'), ' A');
  expect(editorA!.canUndo()).toBe(true);
  expect(editorA!.writer!.canUndo(editorA!.sessionId)).toBe(false);
  expect(inlineWithText(editorA!, 'alpha A').matches(':focus')).toBe(true);
  expect(inlineWithText(editorB!, 'alpha A').matches(':focus')).toBe(false);
  expectReplicaConvergence();

  await typeAtEnd(inlineWithText(editorB!, 'beta'), ' B');
  expect(inlineWithText(editorB!, 'beta B').matches(':focus')).toBe(true);
  expect(inlineWithText(editorA!, 'beta B').matches(':focus')).toBe(false);
  expectReplicaConvergence();

  const beta = inlineWithText(editorB!, 'beta B');
  beta.focus();
  beta.setSelectionOffsets(beta.nodeView!.content.length, beta.nodeView!.content.length);
  await userEvent.keyboard('{Enter}');
  await settleHarness();
  expect(state.canonicalDocument!.root.children).toHaveLength(3);
  expect(inlines(editorB!).some((inline) => inline.matches(':focus'))).toBe(true);
  expectReplicaConvergence();

  await userEvent.keyboard('{Control>}z{/Control}');
  await settleHarness();
  expect(state.canonicalDocument!.root.children).toHaveLength(2);
  expect(inlines(editorB!).some((inline) => inline.matches(':focus'))).toBe(true);
  expectReplicaConvergence();
  await userEvent.keyboard('{Control>}y{/Control}');
  await settleHarness();
  expect(state.canonicalDocument!.root.children).toHaveLength(3);
  expectReplicaConvergence();

  await typeAtEnd(inlineWithText(editorB!, ''), 'tail');
  expect(state.canonicalDocument!.root.children.map((node) => node.content ?? '')).toContain(
    'tail',
  );
  expect(inlineWithText(editorB!, 'tail').matches(':focus')).toBe(true);
  expectReplicaConvergence();

  const source = harness!.shadowRoot!.querySelector('textarea')!;
  expect(source.value).toContain('alpha A');
  expect(source.value).toContain('beta B');
  expect((harness as unknown as HarnessInternals).markdownForSave()).toContain('tail');
});

test('rejected connected text and commands release the pane writer for its next action', async () => {
  await mountHarness('alpha\n\nbeta');
  const [editorA] = await enableTwoClients();
  const state = harness as unknown as HarnessInternals;
  const authority = state.canonicalWriter!;
  const originalApply = authority.apply;
  let rejectNext = false;
  authority.apply = (request, context) => {
    if (rejectNext) {
      rejectNext = false;
      return { status: 'rejected', reason: 'invalid-operation' };
    }
    return originalApply.call(authority, request, context);
  };

  try {
    let before = state.canonicalDocument!.checkpoint().update;
    rejectNext = true;
    await typeAtEnd(inlineWithText(editorA!, 'alpha'), '!');
    expect(state.canonicalDocument!.checkpoint().update).toEqual(before);
    await typeAtEnd(inlineWithText(editorA!, 'alpha'), '?');
    expect(inlineWithText(editorA!, 'alpha?').matches(':focus')).toBe(true);

    before = state.canonicalDocument!.checkpoint().update;
    const alpha = inlineWithText(editorA!, 'alpha?');
    alpha.focus();
    alpha.setSelectionOffsets(6, 6);
    rejectNext = true;
    await userEvent.keyboard('{Enter}');
    await settleHarness();
    expect(state.canonicalDocument!.checkpoint().update).toEqual(before);
    expect(state.canonicalDocument!.root.children).toHaveLength(2);

    await typeAtEnd(inlineWithText(editorA!, 'alpha?'), 'X');
    expect(inlineWithText(editorA!, 'alpha?X').matches(':focus')).toBe(true);
    await userEvent.keyboard('{Enter}');
    await settleHarness();
    expect(state.canonicalDocument!.root.children).toHaveLength(3);
    expectReplicaConvergence();
  } finally {
    authority.apply = originalApply;
  }
});

test('mode exit abandons a prepared pane action and closes only the connected panes', async () => {
  await mountHarness('alpha');
  await enableTwoClients();
  const state = harness as unknown as HarnessInternals;
  const retiredExperiment = state.twoClientExperiment!;
  const retiredClient = retiredExperiment.clients[0]!;
  const retiredWriter = retiredClient.writer!;
  const paragraph = retiredClient.document.root.children[0]!;
  const pending = retiredWriter.prepareTextInput(
    paragraph.sharedId,
    { from: 5, to: 5, insert: 'uncommitted' },
    { actionId: 'dispose-prepared-pane-text', sessionId: retiredClient.sessionId },
  );
  retiredWriter.trackPreparedAction(pending);

  harness!.shadowRoot!.querySelector<HTMLButtonElement>('.experiment-toggle')!.click();
  await settleHarness();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(retiredExperiment.state.status).toBe('closed');
  expect(() => retiredWriter.trackPreparedAction(pending)).toThrow('canonical writer is closed');
  expect(() => retiredClient.document.checkpoint()).toThrow('closed');
  expect(state.canonicalDocument!.root.children[0]!.content).toBe('alpha');

  await typeAtEnd(inlineWithText(editors()[0]!, 'alpha'), '!');
  expect(state.canonicalDocument!.root.children[0]!.content).toBe('alpha!');
  expect(editors()[0]!.writer).toBe(state.canonicalWriter);
});

test.each([
  { client: 'Client A', direction: 'indent' as const },
  { client: 'Client B', direction: 'indent' as const },
  { client: 'Client A', direction: 'outdent' as const },
  { client: 'Client B', direction: 'outdent' as const },
])(
  'keeps $client focus through connected $direction, continued typing, undo, and redo',
  async ({ client, direction }) => {
    const source = direction === 'indent' ? '- One\n- Two' : '- One\n  - Two';
    await mountHarness(source);
    const [editorA, editorB] = await enableTwoClients();
    const origin = client === 'Client A' ? editorA! : editorB!;
    const other = client === 'Client A' ? editorB! : editorA!;
    const state = harness as unknown as HarnessInternals;
    const originalInline = inlineWithText(origin, 'Two');
    let trustedTab = false;
    originalInline.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Tab') trustedTab = event.isTrusted;
    });
    originalInline.focus();
    originalInline.setSelectionOffsets(3, 3);

    await userEvent.keyboard(direction === 'indent' ? '{Tab}' : '{Shift>}{Tab}{/Shift}');
    await settleHarness();

    const nestedMarkdown = direction === 'indent' ? '- One\n  - Two' : '- One\n- Two';
    expect(trustedTab).toBe(true);
    expect(state.markdownForSave().trimEnd()).toBe(nestedMarkdown);
    const active = inlineWithText(origin, 'Two');
    expect(active.matches(':focus')).toBe(true);
    expect(active.getTextSelection()).toEqual({ anchor: 3, focus: 3 });
    expect(inlines(other).some((inline) => inline.matches(':focus'))).toBe(false);
    expect(origin.canUndo()).toBe(true);
    expect(other.canUndo()).toBe(false);
    expectReplicaConvergence();

    await userEvent.keyboard('X');
    await settleHarness();
    expect(state.markdownForSave().trimEnd()).toBe(nestedMarkdown.replace('Two', 'TwoX'));
    expect(canonicalInline(state.canonicalDocument!, 'TwoX')).toBeDefined();
    expect(inlineWithText(origin, 'TwoX').matches(':focus')).toBe(true);
    expect(inlines(other).some((inline) => inline.matches(':focus'))).toBe(false);
    expectReplicaConvergence();

    await userEvent.keyboard('{Control>}z{/Control}');
    await settleHarness();
    expect(state.markdownForSave().trimEnd()).toBe(nestedMarkdown);
    expect(inlineWithText(origin, 'Two').matches(':focus')).toBe(true);

    await userEvent.keyboard('{Control>}z{/Control}');
    await settleHarness();
    expect(state.markdownForSave().trimEnd()).toBe(source);
    expect(inlineWithText(origin, 'Two').matches(':focus')).toBe(true);
    expect(origin.canUndo()).toBe(false);
    expect(other.canUndo()).toBe(false);
    expect(origin.canRedo()).toBe(true);
    expect(other.canRedo()).toBe(false);
    expect(inlines(other).some((inline) => inline.matches(':focus'))).toBe(false);

    await userEvent.keyboard('{Control>}y{/Control}');
    await settleHarness();
    expect(state.markdownForSave().trimEnd()).toBe(nestedMarkdown);
    expect(inlineWithText(origin, 'Two').matches(':focus')).toBe(true);
    expect(inlineWithText(origin, 'Two').getTextSelection()).toEqual({ anchor: 3, focus: 3 });
    expectReplicaConvergence();

    await userEvent.keyboard('Y');
    await settleHarness();
    expect(state.markdownForSave().trimEnd()).toBe(nestedMarkdown.replace('Two', 'TwoY'));
    expect(inlineWithText(origin, 'TwoY').matches(':focus')).toBe(true);
    expect(inlines(other).some((inline) => inline.matches(':focus'))).toBe(false);
    expectReplicaConvergence();
  },
);

test('keeps focus and accepts typing after indent in the single-client harness control', async () => {
  await mountHarness('- One\n- Two');
  const [editor] = editors();
  const inline = inlineWithText(editor!, 'Two');
  inline.focus();
  inline.setSelectionOffsets(3, 3);

  await userEvent.keyboard('{Tab}');
  await settleHarness();
  expect((harness as unknown as HarnessInternals).twoClientMode).toBe(false);
  expect(inlineWithText(editor!, 'Two').matches(':focus')).toBe(true);

  await userEvent.keyboard('X');
  await settleHarness();
  expect((harness as unknown as HarnessInternals).markdownForSave().trimEnd()).toBe(
    '- One\n  - TwoX',
  );
});

test('cancels a connected indent restore when focus moves to Source while rendering waits', async () => {
  const { source } = await mountHarness('- One\n- Two');
  const [editorA] = await enableTwoClients();
  const renderer = editorA!.shadowRoot!.querySelector('md-block-render')!;
  const rootBlock = renderer.shadowRoot!.querySelector('md-block')!;
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  let reportWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reportWaiting = resolve;
  });
  let prototype: object | null = Object.getPrototypeOf(rootBlock);
  let updateCompleteGetter: (() => Promise<unknown>) | undefined;
  while (prototype && !updateCompleteGetter) {
    updateCompleteGetter = Object.getOwnPropertyDescriptor(prototype, 'updateComplete')?.get as
      | (() => Promise<unknown>)
      | undefined;
    prototype = Object.getPrototypeOf(prototype);
  }
  if (!updateCompleteGetter) throw new Error('could not find Lit updateComplete getter');

  const originalOwnDescriptor = Object.getOwnPropertyDescriptor(rootBlock, 'updateComplete');
  Object.defineProperty(rootBlock, 'updateComplete', {
    configurable: true,
    get() {
      reportWaiting();
      const rendering = updateCompleteGetter!.call(rootBlock);
      return gate.then(() => rendering);
    },
  });

  try {
    const inline = inlineWithText(editorA!, 'Two');
    inline.focus();
    inline.setSelectionOffsets(3, 3);
    await userEvent.keyboard('{Tab}');

    const reachedRenderWait = await Promise.race([
      waiting.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    expect(reachedRenderWait).toBe(true);
    source.focus();
    resolveGate();
    await settleHarness();

    expect(harness!.shadowRoot!.activeElement).toBe(source);
    expect(
      editors().every((editor) =>
        inlines(editor).every((candidate) => !candidate.matches(':focus')),
      ),
    ).toBe(true);
    expect((harness as unknown as HarnessInternals).markdownForSave().trimEnd()).toBe(
      '- One\n  - Two',
    );
    expectReplicaConvergence();
  } finally {
    resolveGate();
    if (originalOwnDescriptor)
      Object.defineProperty(rootBlock, 'updateComplete', originalOwnDescriptor);
    else delete (rootBlock as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
  }
});

test('routes toolbar undo and redo to the focused client session', async () => {
  await page.viewport(390, 844);
  await mountHarness('alpha');
  const [editorA, editorB] = await enableTwoClients();
  await typeAtEnd(inlineWithText(editorA!, 'alpha'), ' A');
  await typeAtEnd(inlineWithText(editorB!, 'alpha A'), ' B');

  const useToolbar = async (editor: Element, action: 'Undo' | 'Redo') => {
    const inline =
      inlines(editor).find((candidate) => candidate.matches(':focus')) ?? inlines(editor)[0]!;
    inline.focus();
    const toolbar = harness!.shadowRoot!.querySelector('md-mobile-keyboard-toolbar')!;
    if (!toolbar.visible) {
      const toggle = harness!.shadowRoot!.querySelector<HTMLButtonElement>('.simulation-toggle')!;
      toggle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
      );
      toggle.click();
      await settleHarness();
    }
    expect(toolbar.visible).toBe(true);
    const button = toolbar.shadowRoot!.querySelector<HTMLButtonElement>(
      `button[aria-label="${action}"]`,
    )!;
    expect(button.disabled).toBe(false);
    button.click();
    await settleHarness();
  };

  await useToolbar(editorB!, 'Undo');
  expect(
    (harness as unknown as HarnessInternals).canonicalDocument!.root.children[0]!.content,
  ).toBe('alpha A');
  expectReplicaConvergence();
  await useToolbar(editorB!, 'Redo');
  expect(
    (harness as unknown as HarnessInternals).canonicalDocument!.root.children[0]!.content,
  ).toBe('alpha A B');
  expectReplicaConvergence();
  await useToolbar(editorA!, 'Undo');
  expect(
    (harness as unknown as HarnessInternals).canonicalDocument!.root.children[0]!.content,
  ).toBe('alpha B');
  expectReplicaConvergence();
  await useToolbar(editorA!, 'Redo');
  expect(
    (harness as unknown as HarnessInternals).canonicalDocument!.root.children[0]!.content,
  ).toBe('alpha A B');
  expectReplicaConvergence();
});

test('cancels a pending peer selection restore after focus moves to Source or the toolbar', async () => {
  await page.viewport(390, 844);
  const { source } = await mountHarness('alpha');
  const [editorA, editorB] = await enableTwoClients();
  await typeAtEnd(inlineWithText(editorA!, 'alpha'), '!');

  const acceptRemoteText = (actionId: string, insert: string) => {
    acceptPaneText(1, actionId, insert);
  };

  const activeA = inlineWithText(editorA!, 'alpha!');
  activeA.focus();
  activeA.setSelectionOffsets(2, 2);
  await nextTask();
  acceptRemoteText('focus-race-source', 'R');
  source.focus();
  await settleHarness();
  expect(harness!.shadowRoot!.activeElement).toBe(source);
  expect(inlineWithText(editorB!, 'alpha!R').matches(':focus')).toBe(false);
  expectReplicaConvergence();

  const keyboardToggle =
    harness!.shadowRoot!.querySelector<HTMLButtonElement>('.simulation-toggle')!;
  const activeAgain = inlineWithText(editorA!, 'alpha!R');
  activeAgain.focus();
  activeAgain.setSelectionOffsets(2, 2);
  keyboardToggle.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
  );
  keyboardToggle.click();
  await settleHarness();
  const toolbar = harness!.shadowRoot!.querySelector('md-mobile-keyboard-toolbar')!;
  expect(toolbar.visible).toBe(true);

  acceptRemoteText('focus-race-toolbar', 'S');
  const undoButton = toolbar.shadowRoot!.querySelector<HTMLButtonElement>(
    'button[aria-label="Undo"]',
  )!;
  undoButton.focus();
  await settleHarness();
  expect(toolbar.shadowRoot!.activeElement).toBe(undoButton);
  expect(inlineWithText(editorB!, 'alpha!RS').matches(':focus')).toBe(false);
  expectReplicaConvergence();
});

test.each(['Client A', 'Client B', 'Source'] as const)(
  'composition recovery preserves %s focus and releases inactive-client input',
  async (focusTarget) => {
    const { source } = await mountHarness('alpha');
    const [editorA, editorB] = await enableTwoClients();
    const state = harness as unknown as HarnessInternals;
    const composing = inlineWithText(editorA!, 'alpha');
    composing.focus();
    composing.setSelectionOffsets(5, 5);
    await nextTask();

    await devtools().send('Input.imeSetComposition', {
      text: '漢',
      selectionStart: 1,
      selectionEnd: 1,
    });
    acceptPaneText(1, `composition-peer-${focusTarget}`, 'R', 0);

    let targetInline: MarkdownInline | undefined;
    if (focusTarget === 'Client B') {
      targetInline = inlines(editorB!)[0]!;
      targetInline.focus();
    } else if (focusTarget === 'Source') {
      source.focus();
    }
    await settleHarness();
    await settleHarness();

    if (focusTarget === 'Client A') {
      const recovered = inlineWithText(editorA!, 'Ralpha');
      expect(recovered.matches(':focus')).toBe(true);
      expect(recovered.getTextSelection()).toEqual({ anchor: 6, focus: 6 });
      await devtools().send('Input.insertText', { text: '!' });
      await settleHarness();
      await settleHarness();
      expect(state.canonicalDocument!.root.children[0]!.content).toBe('Ralpha!');
      expect(state.canonicalWriter!.canUndo('client-a')).toBe(true);
    } else if (focusTarget === 'Client B') {
      expect(targetInline!.matches(':focus')).toBe(true);
      expect(inlines(editorA!).some((inline) => inline.matches(':focus'))).toBe(false);
      expect(targetInline!.nodeView?.content).toBe('Ralpha');
      targetInline!.setSelectionOffsets('Ralpha'.length, 'Ralpha'.length);
      await devtools().send('Input.insertText', { text: '!' });
      await settleHarness();
      await settleHarness();
      expect(state.canonicalDocument!.root.children[0]!.content).toBe('Ralpha!');
      expect(state.canonicalWriter!.canUndo('client-a')).toBe(false);
      expect(state.canonicalWriter!.canUndo('client-b')).toBe(true);
      expect(targetInline!.mobileToolbarInputReady).toBe(true);
    } else {
      expect(harness!.shadowRoot!.activeElement).toBe(source);
      expect(inlines(editorA!).some((inline) => inline.matches(':focus'))).toBe(false);
      expect(inlines(editorA!).every((inline) => inline.mobileToolbarInputReady)).toBe(true);
      expect(state.canonicalDocument!.root.children[0]!.content).toBe('Ralpha');
      expect(state.canonicalWriter!.canUndo('client-a')).toBe(false);
    }
    expectReplicaConvergence();
  },
);

test('preserves connected composition focus through an IME keydown, commit, and continued input', async () => {
  await mountHarness('alpha');
  const [editorA] = await enableTwoClients();
  const state = harness as unknown as HarnessInternals;
  const composing = inlineWithText(editorA!, 'alpha');
  composing.focus();
  composing.setSelectionOffsets(5, 5);
  await nextTask();

  const composingKeydowns: { key: string; isComposing: boolean }[] = [];
  composing.addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === 'Process') {
      composingKeydowns.push({ key: keyboardEvent.key, isComposing: keyboardEvent.isComposing });
    }
  });
  await devtools().send('Input.imeSetComposition', {
    text: '漢',
    selectionStart: 1,
    selectionEnd: 1,
  });
  await devtools().send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Process',
    code: 'KeyA',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  });
  await devtools().send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Process',
    code: 'KeyA',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  });
  expect(composingKeydowns).toEqual([{ key: 'Process', isComposing: true }]);

  await devtools().send('Input.insertText', { text: '漢' });
  await settleHarness();
  await settleHarness();

  const recovered = inlineWithText(editorA!, 'alpha漢');
  expect(recovered.matches(':focus')).toBe(true);
  expect(recovered.getTextSelection()).toEqual({ anchor: 6, focus: 6 });
  await devtools().send('Input.insertText', { text: '!' });
  await settleHarness();
  await settleHarness();
  expect(state.canonicalDocument!.root.children[0]!.content).toBe('alpha漢!');
  expectReplicaConvergence();
});

test('reentrant accepted-update delivery keeps both panes locked after replica projection callback', async () => {
  await mountHarness('alpha');
  const [editorA, editorB] = await enableTwoClients();
  const state = harness as unknown as HarnessInternals;
  const paragraph = state.canonicalDocument!.root.children[0]!;
  let injected = false;
  const unsubscribe = state.twoClientExperiment!.clients[0].document.subscribeProjection(() => {
    if (injected) return;
    injected = true;
    const later = state.canonicalWriter!.edit(
      { actionId: 'reentrant-ui', sessionId: 'client-b' },
      (draft) => {
        draft.spliceText(paragraph.sharedId, { from: 6, to: 6, insert: '?' });
      },
    );
    if (!('update' in later)) throw new Error(`expected accepted action, got ${later.status}`);
    expect(state.twoClientExperiment!.receiveAccepted(later)).toBe(false);
  });
  try {
    await typeAtEnd(inlineWithText(editorA!, 'alpha'), '!');
    expect(state.canonicalDocument!.acceptedRevision).toBe(2);
    expect(
      state.twoClientExperiment!.clients.map((client) => client.document.acceptedRevision),
    ).toEqual([1, 1]);
    expect(state.twoClientExperiment!.state).toMatchObject({ status: 'failed', revision: 1 });
    expect((editorA as unknown as { disabled: boolean }).disabled).toBe(true);
    expect((editorB as unknown as { disabled: boolean }).disabled).toBe(true);
    expect(harness!.shadowRoot!.textContent).not.toContain('Connected to one in-process authority');
  } finally {
    unsubscribe();
  }
});

test('shows delivery failure, blocks both panes, and closes replaced pane writers and documents', async () => {
  const { source } = await mountHarness('alpha');
  const [editorA, editorB] = await enableTwoClients();
  const state = harness as unknown as HarnessInternals;
  const oldAuthority = state.canonicalDocument!;
  const retiredExperiment = state.twoClientExperiment!;
  const oldClients = state.twoClientExperiment!.clients.map((client) => client.document);
  const oldClientWriters = state.twoClientExperiment!.clients.map((client) => client.writer!);
  const failureInline = inlineWithText(editorA!, 'alpha');
  failureInline.focus();
  failureInline.setSelectionOffsets(5, 5);
  await settleHarness();
  const failingClient = oldClients[0]!;
  const applyAccepted = failingClient.applyAccepted;
  failingClient.applyAccepted = () => {
    throw new Error('injected pane projection failure');
  };

  await userEvent.keyboard('!');
  await settleHarness();
  expect(state.twoClientExperiment!.state.status).toBe('failed');
  expect(harness!.shadowRoot!.textContent).toContain('injected pane projection failure');
  expect((editorA as unknown as { disabled: boolean }).disabled).toBe(true);
  expect((editorB as unknown as { disabled: boolean }).disabled).toBe(true);
  expect(state.canonicalDocument!.root.children[0]!.content).toBe('alpha!');
  expect(
    state.twoClientExperiment!.clients.map((client) => client.document.acceptedRevision),
  ).toEqual([0, 0]);
  source.focus();
  await settleHarness();
  source.value = 'replacement';
  source.dispatchEvent(new Event('input', { bubbles: true }));
  await settleHarness();
  expect(state.twoClientExperiment!.state.status).toBe('ready');
  expect(
    state.twoClientExperiment!.clients.map((client) => client.document.root.children[0]!.content),
  ).toEqual(['replacement', 'replacement']);
  await new Promise((resolve) => setTimeout(resolve, 10));
  failingClient.applyAccepted = applyAccepted;
  expect(() => oldAuthority.checkpoint()).toThrow('closed');
  for (const oldClient of oldClients) expect(() => oldClient.checkpoint()).toThrow('closed');
  for (const oldClientWriter of oldClientWriters)
    expect(() => oldClientWriter.trackPreparedAction({} as never)).toThrow(
      'canonical writer is closed',
    );

  harness!.remove();
  await nextTask();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(retiredExperiment.state.status).toBe('closed');
  const remounted = document.createElement('md-dev-harness') as LitElement;
  document.body.replaceChildren(remounted);
  harness = remounted;
  await settleHarness(remounted);
  expect(remounted.shadowRoot!.querySelectorAll('md-canonical-editor')).toHaveLength(1);
  expect((remounted as unknown as HarnessInternals).twoClientMode).toBe(false);
});
