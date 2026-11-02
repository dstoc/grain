import { afterEach, expect, it } from 'vitest';
import type { LitElement } from 'lit';
import { page, userEvent } from 'vitest/browser';

import { CanonicalNode } from './markdown/canonical-model.js';
import type { CanonicalDocument } from './markdown/canonical-model.js';
import type { CanonicalWriter } from './markdown/canonical-actions.js';
import { MarkdownInline } from './markdown/inline-render.js';
import { paragraphMarkdown, paragraphBenchmarkText } from '../benchmarks/yjs-m0/fixtures.js';
import { nextTask } from './editing/test/lifecycle.js';
import './main.js';

const profile = import.meta.env.VITE_GRAIN_YJS_M0_PROFILE;
const warmupCount = 25;
const operationCount = 200;
const paragraphCount = 150;
let harness: LitElement | undefined;

interface HarnessInternals {
  readonly parser: object;
  readonly canonicalDocument?: CanonicalDocument;
  readonly canonicalWriter?: CanonicalWriter;
}

function summary(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const variance =
    samples.reduce((total, value) => total + (value - mean) ** 2, 0) / samples.length;
  const round = (value: number) => Number(value.toFixed(6));
  return {
    sampleCount: samples.length,
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    meanMs: round(mean),
    populationStandardDeviationMs: round(Math.sqrt(variance)),
    minimumMs: round(sorted[0]!),
    maximumMs: round(sorted.at(-1)!),
  };
}

async function settleHarness() {
  await nextTask();
  await harness!.updateComplete;
  const editor = harness!.shadowRoot!.querySelector('md-canonical-editor')!;
  const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
  await Promise.all([editor.updateComplete, renderer.updateComplete]);
  await nextTask();
  await harness!.updateComplete;
}

afterEach(async () => {
  harness?.remove();
  await nextTask();
  await page.viewport(1280, 720);
  const state = harness as unknown as HarnessInternals | undefined;
  state?.canonicalWriter?.close();
  state?.canonicalDocument?.close();
  harness = undefined;
  window.getSelection()?.removeAllRanges();
});

it.skipIf(profile !== 'harness')(
  'measures full demo harness input, serialization, parser rebuild, and projection at 150 paragraphs',
  async () => {
    await page.viewport(1280, 720);
    harness = document.createElement('md-dev-harness') as LitElement;
    document.body.replaceChildren(harness);
    await harness.updateComplete;
    const source = harness.shadowRoot!.querySelector('textarea')!;
    source.value = paragraphMarkdown(paragraphCount);
    source.dispatchEvent(new Event('input', { bubbles: true }));
    await settleHarness();

    const editor = harness.shadowRoot!.querySelector('md-canonical-editor')!;
    const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
    await renderer.updateComplete;
    let inline = renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline;
    await inline.updateComplete;
    const internals = harness as unknown as HarnessInternals;
    const initialParser = internals.parser;
    const targetNode = (internals.canonicalDocument!.root.children[0] as CanonicalNode)!;
    const targetOffset = targetNode.content!.length;
    inline.focus();
    inline.setSelectionOffsets(targetOffset, targetOffset);

    for (let index = 0; index < warmupCount; index++) {
      await userEvent.keyboard(index % 2 === 0 ? 'x' : 'y');
      await settleHarness();
      inline = renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline;
    }

    let parserRebuilds = 0;
    let previousParser = internals.parser;
    const samples: number[] = [];
    for (let index = 0; index < operationCount; index++) {
      const startedAt = performance.now();
      await userEvent.keyboard(index % 2 === 0 ? 'x' : 'y');
      await settleHarness();
      samples.push(performance.now() - startedAt);
      const currentParser = internals.parser;
      if (currentParser !== previousParser) parserRebuilds++;
      previousParser = currentParser;
      inline = renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline;
    }

    expect(internals.parser).not.toBe(initialParser);
    expect(parserRebuilds).toBe(operationCount);
    expect(targetNode.content!.length).toBe(targetOffset + warmupCount + operationCount);
    expect(source.value).toContain(paragraphBenchmarkText(0));
    expect(source.value.endsWith('\n')).toBe(true);

    console.log(
      `GRAIN_YJS_M0_REPORT=${JSON.stringify({
        profile: 'harness',
        runIndex: Number(import.meta.env.VITE_GRAIN_YJS_M0_RUN_INDEX ?? '0'),
        fixture: {
          id: 'paragraphs-150',
          paragraphCount,
          viewport: [window.innerWidth, window.innerHeight],
        },
        warmupCount,
        operationCount,
        stage: summary(samples),
        parserRebuilds,
        serializedOutputLength: source.value.length,
        browser: navigator.userAgent,
      })}`,
    );
  },
  1_200_000,
);
