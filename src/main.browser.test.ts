import { afterEach, expect, test, vi } from 'vitest';
import type { LitElement } from 'lit';
import './main.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
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
