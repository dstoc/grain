import { afterEach, expect, test, vi } from 'vitest';
import type { LitElement } from 'lit';
import { page, userEvent } from 'vitest/browser';
import { nextTask } from './editing/test/lifecycle.js';
import type { MarkdownInline } from './markdown/inline-render.js';
import './main.js';

afterEach(async () => {
  await page.viewport(1280, 720);
  document.body.replaceChildren();
  vi.useRealTimers();
});

test('Enter replaces selected text in Render and updates Source and Serialize', async () => {
  const harness = document.createElement('md-dev-harness') as LitElement;
  document.body.append(harness);
  await harness.updateComplete;
  const source = harness.shadowRoot!.querySelector('textarea')!;
  source.value = 'alpha BETA omega';
  source.dispatchEvent(new Event('input', { bubbles: true }));
  await harness.updateComplete;
  await nextTask();
  const editor = harness.shadowRoot!.querySelector('md-editor')!;
  const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
  const inline = renderer.shadowRoot!.querySelector('md-inline')!;
  inline.focus();
  await userEvent.keyboard(
    '{Home}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}{Enter}X',
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await harness.updateComplete;
  expect(source.value).toBe('alpha \n\nX omega\n');
  harness.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab')[1]!.click();
  await harness.updateComplete;
  expect(harness.shadowRoot!.querySelector('.serialized')!.textContent).toBe(source.value);
});

test('Source appends update Tree and Serialize without a full reparse', async () => {
  const harness = document.createElement('md-dev-harness') as LitElement;
  document.body.append(harness);
  await harness.updateComplete;
  const source = harness.shadowRoot!.querySelector('textarea')!;
  const tabs = harness.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab');
  source.focus();
  source.value = 'alpha';
  source.dispatchEvent(new Event('input', { bubbles: true }));
  await harness.updateComplete;
  source.setSelectionRange(source.value.length, source.value.length);
  source.setRangeText('BETA', source.selectionStart, source.selectionEnd, 'end');
  source.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  await harness.updateComplete;
  expect(source.value).toBe('alphaBETA');
  expect(harness.shadowRoot!.activeElement).toBe(source);
  expect(harness.shadowRoot!.textContent).toContain('mode: append');
  tabs[2]!.click();
  await harness.updateComplete;
  expect(harness.shadowRoot!.querySelector('.tree')!.textContent).toContain('alphaBETA');
  tabs[1]!.click();
  await harness.updateComplete;
  expect(harness.shadowRoot!.querySelector('.serialized')!.textContent).toBe('alphaBETA\n');
});

test('Serialize follows partial, stopped, and finished playback', async () => {
  vi.useFakeTimers();
  const harness = document.createElement('md-dev-harness') as LitElement;
  document.body.append(harness);
  await harness.updateComplete;
  const source = harness.shadowRoot!.querySelector('textarea')!;
  source.value = 'alpha';
  source.dispatchEvent(new Event('input', { bubbles: true }));
  const serialize = harness.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab')[1]!;
  serialize.click();
  const play = harness.shadowRoot!.querySelector<HTMLButtonElement>('.play')!;
  play.click();
  vi.advanceTimersByTime(20);
  await harness.updateComplete;
  expect(harness.shadowRoot!.querySelector('.serialized')!.textContent).toBe('al\n');
  play.click();
  await harness.updateComplete;
  expect(harness.shadowRoot!.querySelector('.serialized')!.textContent).toBe('al\n');
  play.click();
  vi.advanceTimersByTime(50);
  await harness.updateComplete;
  expect(harness.shadowRoot!.querySelector('.serialized')!.textContent).toBe('alpha\n');
});

async function createHarness(value: string) {
  const harness = document.createElement('md-dev-harness') as LitElement;
  document.body.append(harness);
  await harness.updateComplete;
  const source = harness.shadowRoot!.querySelector('textarea')!;
  source.value = value;
  source.dispatchEvent(new Event('input', { bubbles: true }));
  await harness.updateComplete;
  return { harness, source };
}

function currentEditorInlines(harness: LitElement) {
  return [
    ...harness
      .shadowRoot!.querySelector('md-editor')!
      .shadowRoot!.querySelector('md-block-render')!
      .shadowRoot!.querySelectorAll<MarkdownInline>('md-inline'),
  ];
}

async function settleHarness(harness: LitElement) {
  await nextTask();
  await harness.updateComplete;
  await nextTask();
  await harness.updateComplete;
}

async function createSettledHarness(value: string) {
  const result = await createHarness(value);
  await settleHarness(result.harness);
  return result;
}

async function showSimulatedKeyboard(harness: LitElement, inline: HTMLElement) {
  inline.focus();
  const toggle = harness.shadowRoot!.querySelector<HTMLButtonElement>('.simulation-toggle')!;
  toggle.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
  );
  toggle.click();
  await settleHarness(harness);
  return harness.shadowRoot!.querySelector('md-mobile-keyboard-toolbar')!;
}

async function activateToolbarAction(harness: LitElement, label: string) {
  const toolbar = harness.shadowRoot!.querySelector('md-mobile-keyboard-toolbar')!;
  const button = toolbar.shadowRoot!.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
  button.click();
  await settleHarness(harness);
  return button;
}

async function waitForFocusedInline(harness: LitElement) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const focused = currentEditorInlines(harness).find((inline) => inline.matches(':focus'));
    if (focused?.mobileToolbarInputReady) return focused;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Render editor did not restore a focused inline');
}

test('mobile toolbar stays hidden without keyboard geometry and scrolls at phone width', async () => {
  await page.viewport(390, 844);
  const { harness, source } = await createSettledHarness('alpha\n\nbeta');
  const [inline] = currentEditorInlines(harness);
  inline!.focus();
  inline!.setSelectionOffsets(2, 2);
  const toolbar = harness.shadowRoot!.querySelector('md-mobile-keyboard-toolbar')!;
  expect(toolbar.visible).toBe(false);

  await showSimulatedKeyboard(harness, inline!);
  expect(toolbar.visible).toBe(true);
  const buttons = toolbar.shadowRoot!.querySelectorAll<HTMLButtonElement>('button');
  expect(buttons).toHaveLength(12);
  expect([...buttons].every((button) => button.getBoundingClientRect().width >= 44)).toBe(true);
  expect([...buttons].map((button) => button.getAttribute('aria-label'))).toEqual([
    'Unindent',
    'Indent',
    'Insert paragraph or split block',
    'Select all and promote block selection',
    'Extend block selection upward',
    'Extend block selection downward',
    'Undo',
    'Redo',
    'Move caret left',
    'Move caret right',
    'Move caret up',
    'Move caret down',
  ]);

  const strip = toolbar.shadowRoot!.querySelector<HTMLElement>('.strip')!;
  expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
  strip.scrollLeft = strip.scrollWidth;
  expect(strip.scrollLeft).toBeGreaterThan(0);
  for (const button of [...buttons].slice(6)) {
    const rect = button.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.visualViewport!.width);
  }
  const lastButtonRect = buttons[11]!.getBoundingClientRect();
  expect(lastButtonRect.left).toBeGreaterThanOrEqual(0);
  expect(lastButtonRect.right).toBeLessThanOrEqual(window.visualViewport!.width);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth,
  );
  const simulatedKeyboard = harness
    .shadowRoot!.querySelector<HTMLElement>('.simulated-keyboard')!
    .getBoundingClientRect();
  expect(toolbar.getBoundingClientRect().bottom).toBeCloseTo(simulatedKeyboard.top, 0);

  strip.scrollLeft = 0;
  const left = buttons[8]!;
  const pointerDown = new PointerEvent('pointerdown', {
    bubbles: true,
    button: 0,
    cancelable: true,
  });
  left.dispatchEvent(pointerDown);
  expect(pointerDown.defaultPrevented).toBe(true);
  expect(inline!.matches(':focus')).toBe(true);
  left.click();
  await settleHarness(harness);
  expect(currentEditorInlines(harness)[0]!.getSelection()?.start.index).toBe(1);

  harness.shadowRoot!.querySelector<HTMLButtonElement>('.simulation-toggle')!.click();
  await settleHarness(harness);
  expect(toolbar.visible).toBe(false);
  expect(inline!.matches(':focus')).toBe(true);
  source.focus();
  await settleHarness(harness);
  toolbar.dispatchEvent(
    new CustomEvent('mobile-toolbar-action', {
      detail: { action: 'select-all' },
      bubbles: true,
      composed: true,
    }),
  );
  expect(source.value).toBe('alpha\n\nbeta');
  harness.remove();
});

test('mobile toolbar undo and redo preserve history focus and keyboard visibility', async () => {
  await page.viewport(390, 844);
  const initial = 'alpha\n\nbeta\n';
  const { harness, source } = await createSettledHarness(initial);
  const [first] = currentEditorInlines(harness);
  first!.focus();
  first!.setSelectionOffsets(5, 5);
  const toolbar = await showSimulatedKeyboard(harness, first!);
  const undo = toolbar.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!;
  const redo = toolbar.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')!;

  expect(undo.disabled).toBe(true);
  expect(redo.disabled).toBe(true);
  await activateToolbarAction(harness, 'Undo');
  expect(source.value).toBe(initial);
  expect(currentEditorInlines(harness)[0]!.matches(':focus')).toBe(true);
  expect(toolbar.visible).toBe(true);

  await userEvent.keyboard('!');
  await settleHarness(harness);
  const afterFirstEdit = source.value;
  expect(afterFirstEdit).not.toBe(initial);
  expect(undo.disabled).toBe(false);
  expect(redo.disabled).toBe(true);

  const secondInline = currentEditorInlines(harness)[1]!;
  secondInline.focus();
  secondInline.setSelectionOffsets(4, 4);
  await userEvent.keyboard('?');
  await settleHarness(harness);
  const afterSecondEdit = source.value;
  expect(afterSecondEdit).not.toBe(afterFirstEdit);

  const pointerDown = new PointerEvent('pointerdown', {
    bubbles: true,
    button: 0,
    cancelable: true,
  });
  undo.dispatchEvent(pointerDown);
  expect(pointerDown.defaultPrevented).toBe(true);
  expect(currentEditorInlines(harness)[1]!.matches(':focus')).toBe(true);
  await activateToolbarAction(harness, 'Undo');
  expect(source.value).toBe(afterFirstEdit);
  expect(currentEditorInlines(harness)[1]!.matches(':focus')).toBe(true);
  expect(currentEditorInlines(harness)[1]!.getSelection()?.start.index).toBe(4);
  expect(toolbar.visible).toBe(true);

  await activateToolbarAction(harness, 'Undo');
  expect(source.value).toBe(initial);
  expect(currentEditorInlines(harness)[0]!.matches(':focus')).toBe(true);
  expect(currentEditorInlines(harness)[0]!.getSelection()?.start.index).toBe(5);
  expect(undo.disabled).toBe(true);
  expect(redo.disabled).toBe(false);

  await activateToolbarAction(harness, 'Undo');
  expect(source.value).toBe(initial);
  expect(currentEditorInlines(harness)[0]!.matches(':focus')).toBe(true);
  expect(toolbar.visible).toBe(true);

  await activateToolbarAction(harness, 'Redo');
  expect(source.value).toBe(afterFirstEdit);
  expect(currentEditorInlines(harness)[0]!.matches(':focus')).toBe(true);
  expect(currentEditorInlines(harness)[0]!.getSelection()?.start.index).toBe(6);
  await activateToolbarAction(harness, 'Redo');
  expect(source.value).toBe(afterSecondEdit);
  expect(currentEditorInlines(harness)[1]!.matches(':focus')).toBe(true);
  expect(currentEditorInlines(harness)[1]!.getSelection()?.start.index).toBe(5);
  expect(undo.disabled).toBe(false);
  expect(redo.disabled).toBe(true);

  await activateToolbarAction(harness, 'Redo');
  expect(source.value).toBe(afterSecondEdit);
  expect(currentEditorInlines(harness)[1]!.matches(':focus')).toBe(true);
  expect(toolbar.visible).toBe(true);
  harness.remove();
});

test('native selection changes keep the caret above the mobile toolbar', async () => {
  await page.viewport(390, 844);
  window.scrollTo(0, 0);
  const text = 'caret visibility '.repeat(300);
  const { harness } = await createSettledHarness(text);
  const inline = currentEditorInlines(harness)[0]!;
  const toolbar = await showSimulatedKeyboard(harness, inline);
  let inputEvents = 0;
  let keydownEvents = 0;
  inline.addEventListener('input', () => inputEvents++);
  inline.addEventListener('keydown', () => keydownEvents++);

  const scrollBeforeSelection = window.scrollY;
  inline.setSelectionOffsets(text.length, text.length);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  expect(inputEvents).toBe(0);
  expect(keydownEvents).toBe(0);
  expect(window.scrollY).toBeGreaterThan(scrollBeforeSelection);
  expect(inline.getCaretPosition().y).toBeLessThanOrEqual(toolbar.getBoundingClientRect().top);
  harness.remove();
});

test('toolbar indent and unindent use Grain editing and preserve the list structure', async () => {
  const { harness, source } = await createSettledHarness('- alpha\n- beta');
  const inline = currentEditorInlines(harness).find((node) => node.textContent === 'beta')!;
  inline.focus();
  inline.setSelectionOffsets(0, 0);
  await showSimulatedKeyboard(harness, inline);

  await activateToolbarAction(harness, 'Indent');
  expect(source.value).toContain('- alpha\n  - beta');
  await activateToolbarAction(harness, 'Unindent');
  expect(source.value).toContain('- alpha\n- beta');
});

test.each([
  ['paragraph', 'alpha\n\nbeta', 'alpha', 2, 2],
  ['list item', '- alpha\n- beta', 'alpha', 2, 2],
  ['code block start', '```js\nalpha\n```', 'alpha', 0, 0],
  ['code block end', '```js\nalpha\n```', 'alpha', 5, 5],
  ['selected paragraph text', 'alpha\n\nbeta', 'alpha', 1, 4],
])(
  'toolbar split sends insertLineBreak in a %s',
  async (_name, sourceText, inlineText, start, end) => {
    const { harness, source } = await createSettledHarness(sourceText);
    const inline = currentEditorInlines(harness).find((node) => node.textContent === inlineText)!;
    inline.focus();
    inline.setSelectionOffsets(start, end);
    await showSimulatedKeyboard(harness, inline);
    await activateToolbarAction(harness, 'Insert paragraph or split block');
    const after = source.value;
    expect(after).not.toBe(sourceText);

    await userEvent.keyboard('{Control>}z{/Control}');
    await settleHarness(harness);
    expect(source.value).toContain(inlineText);
    await userEvent.keyboard('{Control>}y{/Control}');
    await settleHarness(harness);
    expect(source.value).toBe(after);
  },
);

test('select all promotes the focused inline, then extends and reverses block selection', async () => {
  const { harness, source } = await createSettledHarness('alpha\n\nbeta');
  const inline = currentEditorInlines(harness)[0]!;
  inline.focus();
  inline.setSelectionOffsets(2, 2);
  const toolbar = await showSimulatedKeyboard(harness, inline);

  await activateToolbarAction(harness, 'Select all and promote block selection');
  expect(inline.hostContext!.selection.size).toBe(1);
  expect(source.value).toBe('alpha\n\nbeta');
  await activateToolbarAction(harness, 'Select all and promote block selection');
  expect(inline.hostContext!.selection.size).toBe(2);

  const selected = [...inline.hostContext!.selection];
  expect(selected.map((node) => node.content)).toEqual(['alpha', 'beta']);
  expect(toolbar.visible).toBe(true);
});

test('selection extension buttons extend and reverse an existing block selection', async () => {
  const { harness } = await createSettledHarness('alpha\n\nbeta\n\ngamma');
  const inline = currentEditorInlines(harness)[0]!;
  inline.focus();
  inline.setSelectionOffsets(2, 2);
  await showSimulatedKeyboard(harness, inline);

  await activateToolbarAction(harness, 'Select all and promote block selection');
  const initialSize = inline.hostContext!.selection.size;
  expect(initialSize).toBe(1);
  await activateToolbarAction(harness, 'Extend block selection downward');
  const afterBoundary = currentEditorInlines(harness)[0]!;
  const extendedSize = afterBoundary.hostContext!.selection.size;
  expect(extendedSize).toBeGreaterThan(initialSize);
  await activateToolbarAction(harness, 'Extend block selection upward');
  expect(afterBoundary.hostContext!.selection.size).toBeLessThan(extendedSize);
});

test('all four caret controls move through the native selection in a mounted Render editor', async () => {
  const { harness } = await createSettledHarness('ab\ncd');
  const inline = currentEditorInlines(harness)[0]!;
  inline.focus();
  inline.setSelectionOffsets(1, 1);
  await showSimulatedKeyboard(harness, inline);

  await activateToolbarAction(harness, 'Move caret left');
  expect(currentEditorInlines(harness)[0]!.getSelection()?.start.index).toBe(0);
  await activateToolbarAction(harness, 'Move caret right');
  expect(currentEditorInlines(harness)[0]!.getSelection()?.start.index).toBe(1);
  currentEditorInlines(harness)[0]!.setSelectionOffsets(4, 4);
  await activateToolbarAction(harness, 'Move caret up');
  const up = currentEditorInlines(harness)[0]!.getSelection()!.start.index;
  expect(up).toBeLessThan(4);
  await activateToolbarAction(harness, 'Move caret down');
  expect(currentEditorInlines(harness)[0]!.getSelection()!.start.index).toBeGreaterThan(up);
});

test('keyboard activation of a toolbar button returns focus to the editing inline', async () => {
  const { harness } = await createSettledHarness('alpha');
  const inline = currentEditorInlines(harness)[0]!;
  inline.focus();
  inline.setSelectionOffsets(2, 2);
  const toolbar = await showSimulatedKeyboard(harness, inline);
  const button = toolbar.shadowRoot!.querySelector<HTMLButtonElement>(
    'button[aria-label="Move caret right"]',
  )!;
  expect(button.disabled).toBe(false);
  button.focus();
  await userEvent.keyboard('{Enter}');
  await settleHarness(harness);
  const current = currentEditorInlines(harness)[0]!;
  expect(current.matches(':focus')).toBe(true);
  expect(current.getSelection()?.start.index).toBe(3);
});

test('toolbar actions are inert during composition and resume on the recovered inline', async () => {
  const { harness } = await createSettledHarness('alpha\n\nbeta');
  const inline = currentEditorInlines(harness)[0]!;
  inline.focus();
  inline.setSelectionOffsets(1, 3);
  const toolbar = await showSimulatedKeyboard(harness, inline);
  const original = inline.getTextSelection();

  inline.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }));
  expect(inline.mobileToolbarInputReady).toBe(false);
  toolbar.dispatchEvent(
    new CustomEvent('mobile-toolbar-action', {
      detail: { action: 'select-all' },
      bubbles: true,
      composed: true,
    }),
  );
  expect(inline.getTextSelection()).toEqual(original);
  expect(inline.hostContext!.selection.size).toBe(0);

  inline.dispatchEvent(
    new CompositionEvent('compositionend', { data: '', bubbles: true, composed: true }),
  );
  const recoveredInline = await waitForFocusedInline(harness);
  expect(recoveredInline.mobileToolbarInputReady).toBe(true);
  await activateToolbarAction(harness, 'Move caret right');
  expect(toolbar.visible).toBe(true);
});

test('toolbar actions are inert during projection recovery and held recovery events', async () => {
  const { harness } = await createSettledHarness('alpha\n\nbeta');
  const recoveredInline = currentEditorInlines(harness)[0]!;
  recoveredInline.focus();
  recoveredInline.setSelectionOffsets(1, 3);
  const toolbar = await showSimulatedKeyboard(harness, recoveredInline);
  const original = recoveredInline.getTextSelection();
  let finishRecovery!: () => void;
  recoveredInline.addEventListener(
    'inline-projection-recovery',
    (event) => {
      event.preventDefault();
      finishRecovery = (event as CustomEvent<{ complete: () => void }>).detail.complete;
    },
    { once: true },
  );
  const recovery = recoveredInline.recoverComposition({ anchor: 1, focus: 3 });
  expect(recoveredInline.mobileToolbarInputReady).toBe(false);
  toolbar.dispatchEvent(
    new CustomEvent('mobile-toolbar-action', {
      detail: { action: 'select-all' },
      bubbles: true,
      composed: true,
    }),
  );
  expect(recoveredInline.hostContext!.selection.size).toBe(0);
  expect(recoveredInline.getTextSelection()).toEqual(original);
  finishRecovery();
  await recovery;
  const current = currentEditorInlines(harness).find(
    (candidate) => candidate.node === recoveredInline.node,
  )!;
  current.focus();
  expect(current.mobileToolbarInputReady).toBe(true);

  current.holdRecoveryEventsFrom([]);
  expect(current.mobileToolbarInputReady).toBe(false);
  toolbar.dispatchEvent(
    new CustomEvent('mobile-toolbar-action', {
      detail: { action: 'select-all' },
      bubbles: true,
      composed: true,
    }),
  );
  expect(current.hostContext!.selection.size).toBe(0);
  current.replayRecoveryEvents([]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(current.mobileToolbarInputReady).toBe(true);
  await activateToolbarAction(harness, 'Move caret right');
  expect(toolbar.visible).toBe(true);
});

test('VirtualKeyboard geometry controls visibility and overlay ownership restores on tab exit', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'virtualKeyboard');
  let rect = new DOMRect(0, 420, 800, 300);
  const keyboard = new EventTarget() as EventTarget & {
    overlaysContent: boolean;
    readonly boundingRect: DOMRect;
  };
  keyboard.overlaysContent = false;
  Object.defineProperty(keyboard, 'boundingRect', { get: () => rect });
  Object.defineProperty(navigator, 'virtualKeyboard', {
    configurable: true,
    value: keyboard,
  });
  try {
    const { harness } = await createSettledHarness('alpha\n\nbeta');
    const inline = currentEditorInlines(harness)[0]!;
    inline.focus();
    await settleHarness(harness);
    const toolbar = harness.shadowRoot!.querySelector('md-mobile-keyboard-toolbar')!;
    expect(keyboard.overlaysContent).toBe(true);
    expect(toolbar.visible).toBe(true);
    expect(toolbar.getBoundingClientRect().top).toBe(364);
    expect(toolbar.getBoundingClientRect().bottom).toBe(rect.top);

    const button = toolbar.shadowRoot!.querySelector<HTMLButtonElement>('button')!;
    button.focus();
    await settleHarness(harness);
    expect(keyboard.overlaysContent).toBe(false);
    rect = new DOMRect(0, 720, 800, 0);
    keyboard.dispatchEvent(new Event('geometrychange'));
    await settleHarness(harness);
    expect(toolbar.visible).toBe(false);

    rect = new DOMRect(0, 420, 800, 300);
    inline.focus();
    await settleHarness(harness);
    keyboard.dispatchEvent(new Event('geometrychange'));
    await settleHarness(harness);
    expect(keyboard.overlaysContent).toBe(true);
    expect(toolbar.visible).toBe(true);
    window.dispatchEvent(new Event('orientationchange'));
    await settleHarness(harness);
    expect(toolbar.visible).toBe(true);

    rect = new DOMRect(0, 720, 800, 0);
    keyboard.dispatchEvent(new Event('geometrychange'));
    await settleHarness(harness);
    expect(toolbar.visible).toBe(false);
    expect(keyboard.overlaysContent).toBe(true);

    harness.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab')[1]!.click();
    await settleHarness(harness);
    expect(keyboard.overlaysContent).toBe(false);
    expect(toolbar.visible).toBe(false);

    harness.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab')[0]!.click();
    await settleHarness(harness);
    currentEditorInlines(harness)[0]!.focus();
    expect(keyboard.overlaysContent).toBe(true);
    harness.remove();
    expect(keyboard.overlaysContent).toBe(false);
  } finally {
    if (original) Object.defineProperty(navigator, 'virtualKeyboard', original);
    else Reflect.deleteProperty(navigator, 'virtualKeyboard');
  }
});

test.each(['alpha  ', 'alpha  \n'])(
  'editing outside code preserves literal content: %j',
  async (code) => {
    const { harness, source } = await createHarness(`\`\`\`js\n${code}\n\`\`\`\n\nother`);
    await nextTask();
    const renderer = harness
      .shadowRoot!.querySelector('md-editor')!
      .shadowRoot!.querySelector('md-block-render')!;
    const inline = Array.from(renderer.shadowRoot!.querySelectorAll<HTMLElement>('md-inline')).find(
      (node) => node.textContent === 'other',
    )!;
    inline.focus();
    await userEvent.keyboard('{End}X');
    await nextTask();
    await harness.updateComplete;
    const expected = `\`\`\`js\n${code}\n\`\`\`\n\notherX\n`;
    expect(source.value).toBe(expected);
    harness.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab')[1]!.click();
    await harness.updateComplete;
    expect(harness.shadowRoot!.querySelector('.serialized')!.textContent).toBe(expected);
  },
);
test('outdenting a multi-block item updates Source, Render and Serialize', async () => {
  const { harness, source } = await createHarness(
    '- alpha\n\n  beta\n\n  gamma\n  - child\n- tail\n',
  );
  await nextTask();
  const renderer = harness
    .shadowRoot!.querySelector('md-editor')!
    .shadowRoot!.querySelector('md-block-render')!;
  renderer.shadowRoot!.querySelector('md-inline')!.focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  await nextTask();
  await harness.updateComplete;
  const expected = 'alpha\n\nbeta\n\ngamma\n- child\n- tail\n';
  expect(source.value).toBe(expected);
  expect(
    [...renderer.shadowRoot!.querySelectorAll('md-inline')].map((inline) =>
      inline.textContent?.trim(),
    ),
  ).toEqual(['alpha', 'beta', 'gamma', 'child', 'tail']);
  harness.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab')[1]!.click();
  await harness.updateComplete;
  expect(harness.shadowRoot!.querySelector('.serialized')!.textContent).toBe(expected);
});

test('block selection outdents an item between siblings without losing their order', async () => {
  const { harness, source } = await createHarness('- anchor\n- alpha\n\n  beta\n- tail\n');
  await nextTask();
  const renderer = harness
    .shadowRoot!.querySelector('md-editor')!
    .shadowRoot!.querySelector('md-block-render')!;
  renderer.shadowRoot!.querySelectorAll('md-inline')[1]!.focus();
  await userEvent.keyboard('{Home}{Shift>}{ArrowDown}{/Shift}{Shift>}{Tab}{/Shift}');
  await nextTask();
  await harness.updateComplete;
  expect(source.value).toBe('- anchor\n\n\nalpha\n\nbeta\n- tail\n');
});

async function expectDocument(harness: LitElement, source: HTMLTextAreaElement, value: string) {
  expect(source.value).toBe(value);
  const tabs = harness.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab');
  tabs[2]!.click();
  await harness.updateComplete;
  for (const paragraph of value.trim().split('\n\n')) {
    expect(harness.shadowRoot!.querySelector('.tree')!.textContent).toContain(paragraph);
  }
  tabs[1]!.click();
  await harness.updateComplete;
  expect(harness.shadowRoot!.querySelector('.serialized')!.textContent).toBe(
    value.trimEnd() + '\n',
  );
  tabs[0]!.click();
  await harness.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const renderer = harness
    .shadowRoot!.querySelector('md-editor')!
    .shadowRoot!.querySelector('md-block-render')!;
  for (const paragraph of value.trim().split('\n\n')) {
    expect(
      Array.from(renderer.shadowRoot!.querySelectorAll('md-inline'))
        .map((inline) => inline.textContent)
        .join('\n'),
    ).toContain(paragraph);
  }
}

test('Source append after finished playback restores an open full parser', async () => {
  vi.useFakeTimers();
  const { harness, source } = await createHarness('alpha');
  harness.shadowRoot!.querySelector<HTMLButtonElement>('.play')!.click();
  vi.advanceTimersByTime(60);
  await harness.updateComplete;
  vi.useRealTimers();
  source.focus();
  source.setSelectionRange(5, 5);
  await userEvent.keyboard('X');
  await harness.updateComplete;
  expect(harness.shadowRoot!.activeElement).toBe(source);
  expect(source.selectionStart).toBe(6);
  expect(harness.shadowRoot!.textContent).toContain('Playback progress: 6/6');
  await userEvent.keyboard('Z');
  await harness.updateComplete;
  expect(harness.shadowRoot!.textContent).toContain('mode: append');
  await expectDocument(harness, source, 'alphaXZ');
});

test('Source edit after scrubbing preserves both blocks through Render edit and undo/redo', async () => {
  const { harness, source } = await createHarness('alpha\n\nbeta');
  const slider = harness.shadowRoot!.querySelector<HTMLInputElement>('input[type=range]')!;
  slider.value = '5';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  await harness.updateComplete;
  source.focus();
  await userEvent.keyboard('{Control>}{End}{/Control}X');
  await harness.updateComplete;
  expect(harness.shadowRoot!.activeElement).toBe(source);
  expect(source.selectionStart).toBe(12);
  await expectDocument(harness, source, 'alpha\n\nbetaX');
  const renderer = harness
    .shadowRoot!.querySelector('md-editor')!
    .shadowRoot!.querySelector('md-block-render')!;
  const inline = renderer.shadowRoot!.querySelector<HTMLElement>('md-inline')!;
  inline.focus();
  await userEvent.keyboard('{End}Y');
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(harness.shadowRoot!.textContent).toContain('mode: edited');
  expect(source.value).toBe('alphaY\n\nbetaX\n');
  const editInline = harness
    .shadowRoot!.querySelector('md-editor')!
    .shadowRoot!.querySelector('md-block-render')!
    .shadowRoot!.querySelector<HTMLElement>('md-inline')!;
  await userEvent.click(editInline);
  expect(harness.shadowRoot!.activeElement?.tagName).toBe('MD-EDITOR');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await userEvent.keyboard('{Control>}z{/Control}');
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(harness.shadowRoot!.textContent).toContain('mode: edited');
  expect(source.value).toBe('alpha\n\nbetaX\n');
  await userEvent.keyboard('{Control>}y{/Control}');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await expectDocument(harness, source, 'alphaY\n\nbetaX\n');
});

test.each(['running', 'stopped', 'scrub-end', 'non-append', 'unchanged', 'empty'])(
  'Source input after %s playback uses the full source',
  async (state) => {
    vi.useFakeTimers();
    const { harness, source } = await createHarness('alpha\n\nbeta');
    const play = harness.shadowRoot!.querySelector<HTMLButtonElement>('.play')!;
    play.click();
    vi.advanceTimersByTime(state === 'unchanged' || state === 'empty' ? 120 : 30);
    if (state === 'stopped') play.click();
    if (state === 'scrub-end') {
      const slider = harness.shadowRoot!.querySelector<HTMLInputElement>('input[type=range]')!;
      slider.value = '11';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const value =
      state === 'empty'
        ? ''
        : state === 'unchanged'
          ? source.value
          : state === 'non-append'
            ? 'Alpha\n\nbeta'
            : source.value + 'X';
    source.focus();
    source.value = value;
    source.setSelectionRange(value.length, value.length);
    source.dispatchEvent(new Event('input', { bubbles: true }));
    await harness.updateComplete;
    expect(harness.shadowRoot!.activeElement).toBe(source);
    expect(source.selectionStart).toBe(value.length);
    expect(harness.shadowRoot!.textContent).toContain(
      `Playback progress: ${value.length}/${value.length}`,
    );
    const serialize = harness.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab')[1]!;
    serialize.click();
    await harness.updateComplete;
    expect(harness.shadowRoot!.querySelector('.serialized')!.textContent).toBe(
      value ? value + '\n' : '<!-- -->\n',
    );
  },
);
