import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { paragraphMarkdown } from '../../benchmarks/yjs-m0/fixtures.js';
import { CanonicalDocument, CanonicalNode } from '../markdown/canonical-model.js';
import { CanonicalWriter } from '../markdown/canonical-actions.js';
import { MarkdownInline } from '../markdown/inline-render.js';
import { CanonicalEditor } from './canonical-editor.js';
import { nextTask } from './test/lifecycle.js';

const profile = import.meta.env.VITE_GRAIN_YJS_M0_PROFILE;
const warmupCount = 25;
const operationCount = 200;
const paragraphCount = 150;
let editor: CanonicalEditor | undefined;
let document: CanonicalDocument | undefined;
let writer: CanonicalWriter | undefined;

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

async function settle() {
  const currentEditor = editor!;
  const renderer = currentEditor.shadowRoot!.querySelector('md-block-render')!;
  await Promise.all([currentEditor.updateComplete, renderer.updateComplete]);
  await nextTask();
}

afterEach(async () => {
  editor?.remove();
  await nextTask();
  writer?.close();
  document?.close();
  editor = undefined;
  writer = undefined;
  document = undefined;
  window.getSelection()?.removeAllRanges();
});

it.skipIf(profile !== 'editor')(
  'measures 200 mounted Chromium editor input and projection operations at 150 paragraphs',
  async () => {
    await page.viewport(1280, 720);
    const markdown = paragraphMarkdown(paragraphCount);
    document = CanonicalDocument.fromMarkdown(markdown, {
      documentId: 'grain-yjs-m0-editor-150',
      authorityEpoch: 'grain-yjs-m0',
      actionId: 'grain-yjs-m0-editor-import',
      makeId: (role, ordinal) => `m0-editor-${role}-${ordinal}`,
    });
    writer = new CanonicalWriter(document);
    editor = new CanonicalEditor();
    editor.document = document;
    editor.writer = writer;
    editor.style.width = '1000px';
    editor.style.display = 'block';
    window.document.body.replaceChildren(editor);
    await nextTask();

    const renderer = editor.shadowRoot!.querySelector('md-block-render')!;
    await renderer.updateComplete;
    let inline = renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline;
    await inline.updateComplete;
    inline.focus();
    const targetNode = document.root.children[0] as CanonicalNode;
    const targetOffset = targetNode.content!.length;
    inline.setSelectionOffsets(targetOffset, targetOffset);

    for (let index = 0; index < warmupCount; index++) {
      await userEvent.keyboard(index % 2 === 0 ? 'x' : 'y');
      await settle();
      inline = renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline;
    }

    const blocks = [...renderer.shadowRoot!.querySelectorAll('md-block')];
    const targetBlock = blocks[0]!;
    const unaffectedBlock = blocks[75]!;
    const unaffectedNode = document.root.children[75] as CanonicalNode;
    const unaffectedVersion = unaffectedNode.version;
    let targetMutations = 0;
    let unaffectedMutations = 0;
    const targetObserver = new MutationObserver((records) => {
      targetMutations += records.length;
    });
    const unaffectedObserver = new MutationObserver((records) => {
      unaffectedMutations += records.length;
    });
    targetObserver.observe(targetBlock, { subtree: true, childList: true, characterData: true });
    unaffectedObserver.observe(unaffectedBlock, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    const samples: number[] = [];
    for (let index = 0; index < operationCount; index++) {
      const startedAt = performance.now();
      await userEvent.keyboard(index % 2 === 0 ? 'x' : 'y');
      await settle();
      samples.push(performance.now() - startedAt);
      inline = renderer.shadowRoot!.querySelector('md-inline') as MarkdownInline;
    }
    targetMutations += targetObserver.takeRecords().length;
    unaffectedMutations += unaffectedObserver.takeRecords().length;
    targetObserver.disconnect();
    unaffectedObserver.disconnect();

    expect(targetNode.content!.length).toBe(targetOffset + warmupCount + operationCount);
    expect(targetMutations).toBeGreaterThan(0);
    expect(unaffectedMutations).toBe(0);
    expect(unaffectedNode.version).toBe(unaffectedVersion);
    expect(blocks[75]).toBe(unaffectedBlock);

    console.log(
      `GRAIN_YJS_M0_REPORT=${JSON.stringify({
        profile: 'editor',
        runIndex: Number(import.meta.env.VITE_GRAIN_YJS_M0_RUN_INDEX ?? '0'),
        fixture: {
          id: 'paragraphs-150',
          paragraphCount,
          viewport: [window.innerWidth, window.innerHeight],
        },
        warmupCount,
        operationCount,
        stage: summary(samples),
        affectedBlockDomMutations: targetMutations,
        unaffectedBlockDomMutations: unaffectedMutations,
        unaffectedNodeVersionBefore: unaffectedVersion,
        unaffectedNodeVersionAfter: unaffectedNode.version,
        browser: navigator.userAgent,
      })}`,
    );
  },
  1_200_000,
);
