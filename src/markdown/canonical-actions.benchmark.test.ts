import { it, expect } from 'vitest';
import * as Y from 'yjs';

import { deleteContentBackwards, insertParagraph } from '../editing/canonical-edits.js';
import { viewModel, type InlineViewModelNode } from './view-model-node.js';
import { MarkdownTree } from './view-model.js';
import { parseBlocks } from './block-parser/api.js';
import { serializeToString } from './block-serializer.js';
import { CanonicalDocument } from './canonical-model.js';
import { CanonicalWriter } from './canonical-actions.js';

interface RuntimeProcess {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  getBuiltinModule?(specifier: string): unknown;
  memoryUsage(): { readonly heapUsed: number; readonly rss: number };
}

const runtimeProcess = (globalThis as typeof globalThis & { process: RuntimeProcess }).process;
const enabled = runtimeProcess.env.CANONICAL_HISTORY_BENCHMARK === '1';

function makeGarbageCollector(): (() => void) | undefined {
  const getBuiltinModule = runtimeProcess.getBuiltinModule;
  if (!getBuiltinModule) return undefined;
  const v8 = getBuiltinModule.call(runtimeProcess, 'node:v8') as {
    setFlagsFromString(flags: string): void;
  };
  const vm = getBuiltinModule.call(runtimeProcess, 'node:vm') as {
    runInNewContext(source: string): unknown;
  };
  v8.setFlagsFromString('--expose_gc');
  const collect = vm.runInNewContext('gc');
  return typeof collect === 'function' ? (collect as () => void) : undefined;
}

const collectGarbage = enabled ? makeGarbageCollector() : undefined;
const paragraphCount = 150;
const sampleCount = 15;

function markdownFixture(count: number): string {
  return (
    Array.from({ length: count }, (_, index) => `paragraph-${index} contains enough text`).join(
      '\n\n',
    ) + '\n'
  );
}

function summary(values: readonly number[]) {
  if (!values.length) return { medianMs: null, p90Ms: null };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
  const rounded = (value: number) => Number(value.toFixed(6));
  return {
    medianMs: rounded(percentile(0.5)),
    p90Ms: rounded(percentile(0.9)),
  };
}

function elapsed(action: () => void): number {
  const start = performance.now();
  action();
  return performance.now() - start;
}

function acceptedEdit(result: ReturnType<CanonicalWriter['edit']>): void {
  if (!('receipt' in result)) throw new Error(`benchmark edit was not accepted: ${result.status}`);
}

function snapshotCounts(document: CanonicalDocument) {
  const snapshot = document.canonicalSnapshot();
  return {
    nodes: snapshot.nodes.length,
    tapes: snapshot.tapes.length,
    markers: snapshot.tapes.reduce(
      (count, tape) => count + tape.delta.filter((item) => typeof item !== 'string').length,
      0,
    ),
  };
}

interface DocListener {
  (event: unknown): void;
}

interface ObservableDocPrototype {
  on: (this: object, eventName: string, listener: DocListener) => unknown;
  off: (this: object, eventName: string, listener: DocListener) => unknown;
}

function withAfterTransactionListenerCount<T>(run: (count: () => number) => T): T {
  const prototype = Y.Doc.prototype as unknown as ObservableDocPrototype;
  const originalOn = prototype.on;
  const originalOff = prototype.off;
  const listeners = new WeakMap<object, Set<DocListener>>();
  let active = 0;
  prototype.on = function (this: object, eventName: string, listener: DocListener) {
    if (eventName === 'afterTransaction') {
      let registered = listeners.get(this);
      if (!registered) listeners.set(this, (registered = new Set()));
      if (!registered.has(listener)) {
        registered.add(listener);
        active++;
      }
    }
    return originalOn.call(this, eventName, listener);
  };
  prototype.off = function (this: object, eventName: string, listener: DocListener) {
    if (eventName === 'afterTransaction') {
      const registered = listeners.get(this);
      if (registered?.delete(listener)) active--;
    }
    return originalOff.call(this, eventName, listener);
  };
  try {
    return run(() => active);
  } finally {
    prototype.on = originalOn;
    prototype.off = originalOff;
  }
}

function plainDocumentMeasurements(markdown: string) {
  const reports = [];
  for (const relativeOffset of [0, 0.5, 1]) {
    const standaloneEdit: number[] = [];
    const standaloneProjection: number[] = [];
    const canonicalPrepare: number[] = [];
    const canonicalApplyPublish: number[] = [];
    const canonicalProjection: number[] = [];

    for (let sample = 0; sample < sampleCount; sample++) {
      const standalone = new MarkdownTree(parseBlocks(markdown).node);
      const standaloneNode = standalone.root.children![paragraphCount - 1]! as InlineViewModelNode;
      const offset = Math.floor(standaloneNode.content.length * relativeOffset);
      const oldEndIndex = offset < standaloneNode.content.length ? offset + 1 : offset;
      standaloneEdit.push(
        elapsed(() =>
          standalone.edit(() => {
            standaloneNode[viewModel].edit({
              startIndex: offset,
              oldEndIndex,
              newEndIndex: offset + 1,
              newText: 'Z',
            });
            return {};
          }),
        ),
      );
      standaloneProjection.push(
        elapsed(() => {
          serializeToString(standalone.serialize());
        }),
      );

      const document = CanonicalDocument.fromMarkdown(markdown);
      const writer = new CanonicalWriter(document);
      const canonicalNode = document.root.children[paragraphCount - 1]!;
      const canonicalContent = canonicalNode.content ?? '';
      const canonicalOffset = Math.floor(canonicalContent.length * relativeOffset);
      const canonicalEnd =
        canonicalOffset < canonicalContent.length ? canonicalOffset + 1 : canonicalOffset;
      const requestStart = performance.now();
      const request = writer.prepareTextInput(
        canonicalNode.sharedId,
        { from: canonicalOffset, to: canonicalEnd, insert: 'Z' },
        { actionId: `plain-${relativeOffset}-${sample}`, sessionId: 'plain' },
      );
      canonicalPrepare.push(performance.now() - requestStart);
      canonicalApplyPublish.push(
        elapsed(() => {
          const result = writer.apply(request, {
            sessionId: 'plain',
            authorityEpoch: request.authorityEpoch,
            sessionSequence: request.sessionSequence,
          });
          if (result.status !== 'pending')
            throw new Error(`benchmark apply failed: ${result.status}`);
          writer.publish(result.pending);
        }),
      );
      canonicalProjection.push(
        elapsed(() => {
          serializeToString(document.exportMarkdownTree());
        }),
      );
      writer.close();
      document.close();
    }

    reports.push({
      relativeOffset,
      sampleCount,
      standalone: {
        editMs: summary(standaloneEdit),
        projectionMs: summary(standaloneProjection),
      },
      canonical: {
        prepareMs: summary(canonicalPrepare),
        applyPublishMs: summary(canonicalApplyPublish),
        projectionMs: summary(canonicalProjection),
      },
    });
  }
  return reports;
}

function historyMeasurements(markdown: string) {
  return withAfterTransactionListenerCount((listenerCount) => {
    const reports = [];
    for (const [sessionCount, groupsPerSession] of [
      [1, 0],
      [1, 16],
      [1, 64],
      [1, 501],
      [4, 16],
      [4, 64],
    ]) {
      const document = CanonicalDocument.fromMarkdown(markdown);
      const writer = new CanonicalWriter(document);
      const nodeId = document.root.children[0]!.sharedId;
      const initialBytes = document.checkpoint().update.byteLength;
      const initialCounts = snapshotCounts(document);
      collectGarbage?.();
      const initialMemory = runtimeProcess.memoryUsage();
      const initialListeners = listenerCount();
      const prepareTimes: number[] = [];
      const applyPublishTimes: number[] = [];
      let sequence = 0;

      for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex++) {
        for (let groupIndex = 0; groupIndex < groupsPerSession; groupIndex++) {
          const sessionId = `history-session-${sessionIndex}`;
          const actionId = `history-${sessionIndex}-${groupIndex}`;
          const replacement = sequence++ % 2 === 0 ? 'X' : 'p';
          const prepareStart = performance.now();
          const request = writer.prepareTextInput(
            nodeId,
            { from: 0, to: 1, insert: replacement },
            { actionId, sessionId, historyGroupId: `${sessionId}-group-${groupIndex}` },
          );
          prepareTimes.push(performance.now() - prepareStart);
          applyPublishTimes.push(
            elapsed(() => {
              const result = writer.apply(request, {
                sessionId,
                authorityEpoch: request.authorityEpoch,
                sessionSequence: request.sessionSequence,
              });
              if (result.status !== 'pending')
                throw new Error(`benchmark apply failed: ${result.status}`);
              writer.publish(result.pending);
            }),
          );
        }
      }

      const finalBytes = document.checkpoint().update.byteLength;
      const finalCounts = snapshotCounts(document);
      collectGarbage?.();
      const finalMemory = runtimeProcess.memoryUsage();
      const finalListeners = listenerCount();
      expect(document.validate().valid).toBe(true);
      reports.push({
        sessionCount,
        groupsPerSession,
        totalGroups: sessionCount * groupsPerSession,
        prepareMsPerGroup: summary(prepareTimes),
        applyPublishMsPerGroup: summary(applyPublishTimes),
        encodedStateBytes: {
          before: initialBytes,
          after: finalBytes,
          delta: finalBytes - initialBytes,
        },
        resources: { before: initialCounts, after: finalCounts },
        processMemoryBytes: {
          heapUsedBefore: initialMemory.heapUsed,
          heapUsedAfter: finalMemory.heapUsed,
          observedHeapDelta: finalMemory.heapUsed - initialMemory.heapUsed,
          rssBefore: initialMemory.rss,
          rssAfter: finalMemory.rss,
          observedRssDelta: finalMemory.rss - initialMemory.rss,
          note: collectGarbage
            ? 'heap samples after forced collection while the fixture remains live'
            : 'process-level samples; garbage collection may occur between readings',
        },
        activeAfterTransactionListeners: {
          before: initialListeners,
          after: finalListeners,
          delta: finalListeners - initialListeners,
        },
      });
      writer.close();
      document.close();
    }
    return reports;
  });
}

function splitJoinUndoMeasurements(markdown: string) {
  const document = CanonicalDocument.fromMarkdown(markdown);
  const writer = new CanonicalWriter(document);
  const splitTimes: number[] = [];
  const joinTimes: number[] = [];
  const undoTimes: number[] = [];
  const redoTimes: number[] = [];
  const baseBytes = document.checkpoint().update.byteLength;
  const baseCounts = snapshotCounts(document);
  const cycles = 12;

  for (let cycle = 0; cycle < cycles; cycle++) {
    const original = document.root.children[0]!;
    acceptedEdit(
      elapsedEdit(
        writer,
        `fragment-split-${cycle}`,
        (draft) => insertParagraph(draft, document.root.sharedId, original.sharedId, 2),
        splitTimes,
      ),
    );
    const trailing = document.root.children[1]!;
    acceptedEdit(
      elapsedEdit(
        writer,
        `fragment-join-${cycle}`,
        (draft) => deleteContentBackwards(draft, document.root.sharedId, trailing.sharedId),
        joinTimes,
      ),
    );
    undoTimes.push(
      elapsed(() => {
        if (writer.undo('fragment').status !== 'applied') throw new Error('split/join undo failed');
      }),
    );
    redoTimes.push(
      elapsed(() => {
        if (writer.redo('fragment').status !== 'applied') throw new Error('split/join redo failed');
      }),
    );
  }

  expect(document.validate().valid).toBe(true);
  const finalBytes = document.checkpoint().update.byteLength;
  const finalCounts = snapshotCounts(document);
  const report = {
    cycles,
    splitMs: summary(splitTimes),
    joinMs: summary(joinTimes),
    undoMs: summary(undoTimes),
    redoMs: summary(redoTimes),
    encodedStateBytes: { before: baseBytes, after: finalBytes, delta: finalBytes - baseBytes },
    resources: { before: baseCounts, after: finalCounts },
  };
  writer.close();
  document.close();
  return report;
}

function elapsedEdit(
  writer: CanonicalWriter,
  actionId: string,
  callback: Parameters<CanonicalWriter['edit']>[1],
  samples: number[],
) {
  let result: ReturnType<CanonicalWriter['edit']> | undefined;
  samples.push(
    elapsed(() => {
      result = writer.edit({ actionId, sessionId: 'fragment' }, callback);
    }),
  );
  if (!result) throw new Error('benchmark edit did not return');
  return result;
}

it.skipIf(!enabled)(
  'reports canonical editing latency and retained history growth',
  () => {
    const markdown = markdownFixture(paragraphCount);
    const report = {
      runtime: runtimeProcess.version,
      platform: runtimeProcess.platform,
      arch: runtimeProcess.arch,
      paragraphCount,
      preparationIncludes:
        'tape marker lookup, offset mapping, and branch preparation; substeps are not instrumented separately',
      plainDocument: plainDocumentMeasurements(markdown),
      retainedHistory: historyMeasurements(markdown),
      repeatedSplitJoinUndo: splitJoinUndoMeasurements(markdown),
    };
    console.log(`CANONICAL_HISTORY_BENCHMARK=${JSON.stringify(report)}`);
  },
  180_000,
);
