import { afterEach, expect, test, vi } from 'vitest';
import type { LitElement } from 'lit';
import { userEvent } from 'vitest/browser';
import { nextTask } from './editing/test/lifecycle.js';
import './main.js';

afterEach(() => {
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
