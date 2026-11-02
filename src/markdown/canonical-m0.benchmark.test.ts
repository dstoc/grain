import { describe, expect, it } from 'vitest';

import manifestText from '../../benchmarks/yjs-m0/manifest.json?raw';
import packageJsonText from '../../package.json?raw';
import { paragraphMarkdown } from '../../benchmarks/yjs-m0/fixtures.js';
import { CanonicalDocument, type CanonicalNode } from './canonical-model.js';
import { CanonicalWriter, type ActionRequest, type TreeDraft } from './canonical-actions.js';
import { serializeToString } from './block-serializer.js';
import {
  measureNativeOperations,
  receiptByteLength,
  snapshotNativeState,
} from '../../benchmarks/yjs-m0/counters.js';

interface RuntimeProcess {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly stderr?: { write(value: string): void };
  getBuiltinModule?(specifier: string): unknown;
  memoryUsage(): { readonly heapUsed: number; readonly rss: number };
}

interface CoreFixture {
  readonly id: string;
  readonly shape: 'paragraphs' | 'single-tape' | 'wide-list' | 'fragmented-ownership';
  readonly nodes?: number;
  readonly utf16Length?: number;
  readonly items?: number;
  readonly spans?: number;
}

interface M0Manifest {
  readonly baseline: {
    readonly commit: string;
    readonly fixtureSeed: number;
    readonly yjsVersion: string;
  };
  readonly profiles: {
    readonly core: {
      readonly warmupOperationsPerDistribution: number;
      readonly measuredOperationsPerDistribution: number;
      readonly fixtures: readonly CoreFixture[];
    };
    readonly retention: {
      readonly warmupOperationsPerDistribution: number;
      readonly measuredOperationsPerDistribution: number;
      readonly retainedGroupCounts: readonly number[];
      readonly longTraceActions: number;
    };
  };
}

const runtimeProcess = (globalThis as typeof globalThis & { process: RuntimeProcess }).process;
const manifest = JSON.parse(manifestText) as M0Manifest;
const profile = runtimeProcess.env.YJS_M0_PROFILE;
const runIndex = Number(runtimeProcess.env.YJS_M0_RUN_INDEX ?? '0');
const selectedFixture = runtimeProcess.env.YJS_M0_FIXTURE;
const seed = manifest.baseline.fixtureSeed;
const rounding = (value: number) => Number(value.toFixed(6));

function summary(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const variance =
    samples.reduce((total, value) => total + (value - mean) ** 2, 0) / samples.length;
  return {
    sampleCount: samples.length,
    p50Ms: rounding(percentile(0.5)),
    p95Ms: rounding(percentile(0.95)),
    meanMs: rounding(mean),
    populationStandardDeviationMs: rounding(Math.sqrt(variance)),
    minimumMs: rounding(sorted[0]!),
    maximumMs: rounding(sorted.at(-1)!),
  };
}

function createGarbageCollector(): (() => void) | undefined {
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

const collectGarbage = createGarbageCollector();

function emitRetentionProgress(event: Readonly<Record<string, unknown>>): void {
  const record = {
    at: new Date().toISOString(),
    profile: 'retention',
    runIndex,
    side: runtimeProcess.env.YJS_M0_PROGRESS_SIDE ?? 'workspace',
    fixtureSeed: seed,
    ...event,
  };
  const progressFile = runtimeProcess.env.YJS_M0_PROGRESS_FILE;
  if (progressFile) {
    const getBuiltinModule = runtimeProcess.getBuiltinModule;
    if (!getBuiltinModule)
      throw new Error('Node.js getBuiltinModule is required for retention progress');
    const fileSystem = getBuiltinModule.call(runtimeProcess, 'node:fs') as {
      appendFileSync(path: string, data: string): void;
    };
    fileSystem.appendFileSync(progressFile, `${JSON.stringify(record)}\n`);
  }
}

function fixtureMarkdown(fixture: CoreFixture): string {
  switch (fixture.shape) {
    case 'paragraphs':
      return paragraphMarkdown(fixture.nodes!);
    case 'single-tape':
      return 'x'.repeat(fixture.utf16Length!);
    case 'wide-list':
      return Array.from({ length: fixture.items! }, (_, index) => `- item-${index}-content`).join(
        '\n',
      );
    case 'fragmented-ownership':
      return Array.from(
        { length: fixture.spans! + 1 },
        (_, index) => `fragment-${index}-content`,
      ).join('\n\n');
  }
}

function createDocument(fixture: CoreFixture): CanonicalDocument {
  const document = CanonicalDocument.fromMarkdown(fixtureMarkdown(fixture), {
    documentId: `m0-${fixture.id}-${seed}`,
    authorityEpoch: 'grain-yjs-m0',
    actionId: `m0-import-${fixture.id}-${seed}`,
    makeId: (role, ordinal) => `m0-${seed}-${fixture.id}-${role}-${ordinal}`,
  });
  if (fixture.shape !== 'fragmented-ownership') return document;

  const writer = new CanonicalWriter(document);
  const target = document.root.children[0]!;
  const result = writer.edit(
    { actionId: `m0-fragment-seed-${seed}`, sessionId: 'm0-setup' },
    (draft: TreeDraft) => {
      for (const source of document.root.children.slice(1)) {
        const targetView = draft.node(target.sharedId);
        const sourceView = draft.node(source.sharedId);
        const sourceLength = sourceView.content?.length ?? 0;
        draft.transferInlineRange({
          source: source.sharedId,
          from: 0,
          to: sourceLength,
          destination: target.sharedId,
          at: targetView.content?.length ?? 0,
          affinity: 'right',
        });
      }
    },
  );
  if (!('receipt' in result)) throw new Error(`fragment fixture setup failed: ${result.status}`);
  writer.close();
  const checkpoint = document.checkpoint();
  document.close();
  return CanonicalDocument.open(checkpoint);
}

function firstInline(document: CanonicalDocument) {
  const visit = (node: typeof document.root): typeof document.root | undefined => {
    if (node.content !== undefined) return node;
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  const target = visit(document.root);
  if (!target || !target.content?.length) throw new Error('benchmark fixture has no editable text');
  return target;
}

function editRequest(
  writer: CanonicalWriter,
  nodeId: string,
  caseId: string,
  operationIndex: number,
  offset: number,
  char: string,
): ActionRequest {
  const request = writer.prepareTextInput(
    nodeId,
    { from: offset, to: offset + 1, insert: char },
    {
      actionId: `m0-${caseId}-action-${operationIndex}-${char}`,
      sessionId: 'm0-core-session',
      historyGroupId: `m0-${caseId}-history-${operationIndex}`,
    },
  );
  return request;
}

function publishTextInput(writer: CanonicalWriter, request: ActionRequest) {
  // The matched M0 ref predates explicit session admission.
  writer.admitSession?.('m0-core-session');
  const applied = writer.apply(request, {
    sessionId: 'm0-core-session',
    authorityEpoch: request.authorityEpoch,
    sessionSequence: request.sessionSequence,
  });
  if (applied.status !== 'pending') throw new Error(`benchmark apply failed: ${applied.status}`);
  return writer.publish(applied.pending);
}

function warm(fixture: CoreFixture, operationCount: number): void {
  const document = createDocument(fixture);
  const writer = new CanonicalWriter(document);
  const target = firstInline(document);
  const offset = Math.floor(target.content!.length / 2);
  for (let index = 0; index < operationCount; index++) {
    const request = editRequest(
      writer,
      target.sharedId,
      fixture.id,
      index,
      offset,
      index % 2 ? 'x' : 'y',
    );
    publishTextInput(writer, request);
  }
  writer.close();
  document.close();
}

function counterSample(fixture: CoreFixture) {
  const document = createDocument(fixture);
  const writer = new CanonicalWriter(document);
  const target = firstInline(document);
  const offset = Math.floor(target.content!.length / 2);
  const before = snapshotNativeState(document);
  const measured = measureNativeOperations(document, () => {
    const request = editRequest(writer, target.sharedId, fixture.id, 100000, offset, 'z');
    return publishTextInput(writer, request);
  });
  const after = snapshotNativeState(document);
  const result = {
    before,
    after,
    introducedClientIds: after.clientIds.filter((clientId) => !before.clientIds.includes(clientId)),
    counts: measured.counts,
    acceptedUpdateBytes: measured.value.update.byteLength,
    receiptBytes: receiptByteLength(measured.value.receipt),
    targetOffset: offset,
  };
  expect(document.validate().valid).toBe(true);
  writer.close();
  document.close();
  return result;
}

function benchmarkFixture(fixture: CoreFixture, warmupCount: number, operationCount: number) {
  warm(fixture, warmupCount);
  const document = createDocument(fixture);
  const writer = new CanonicalWriter(document);
  const target = firstInline(document);
  const offset = Math.floor(target.content!.length / 2);
  const acceptanceTimes: number[] = [];
  const prepareTimes: number[] = [];
  const applyPublishTimes: number[] = [];
  const exportTimes: number[] = [];
  const serializationTimes: number[] = [];
  const checkpointTimes: number[] = [];
  let acceptedUpdateBytes = 0;
  let receiptBytes = 0;
  collectGarbage?.();
  const memoryBefore = runtimeProcess.memoryUsage();
  const resourcesBefore = snapshotNativeState(document);

  for (let index = 0; index < operationCount; index++) {
    const acceptanceStart = performance.now();
    const prepareStart = performance.now();
    const request = editRequest(
      writer,
      target.sharedId,
      fixture.id,
      index,
      offset,
      index % 2 === 0 ? 'x' : 'y',
    );
    prepareTimes.push(performance.now() - prepareStart);

    const applyStart = performance.now();
    const accepted = publishTextInput(writer, request);
    applyPublishTimes.push(performance.now() - applyStart);
    acceptanceTimes.push(performance.now() - acceptanceStart);
    acceptedUpdateBytes += accepted.update.byteLength;
    receiptBytes += receiptByteLength(accepted.receipt);

    const exportStart = performance.now();
    const tree = document.exportMarkdownTree();
    exportTimes.push(performance.now() - exportStart);

    const serializeStart = performance.now();
    serializeToString(tree);
    serializationTimes.push(performance.now() - serializeStart);

    const checkpointStart = performance.now();
    document.checkpoint();
    checkpointTimes.push(performance.now() - checkpointStart);
  }

  const resourcesAfter = snapshotNativeState(document);
  collectGarbage?.();
  const memoryAfter = runtimeProcess.memoryUsage();
  const counters = counterSample(fixture);
  const report = {
    fixture,
    operationCount,
    warmupCount,
    historyGroupsCreated: operationCount,
    targetOffset: offset,
    stages: {
      prepareThroughPublish: summary(acceptanceTimes),
      prepareTextInput: summary(prepareTimes),
      applyAndPublish: summary(applyPublishTimes),
      exportMarkdownTree: summary(exportTimes),
      serializeToString: summary(serializationTimes),
      checkpoint: summary(checkpointTimes),
    },
    acceptedUpdateBytes: {
      total: acceptedUpdateBytes,
      mean: rounding(acceptedUpdateBytes / operationCount),
    },
    receiptBytes: { total: receiptBytes, mean: rounding(receiptBytes / operationCount) },
    resources: { before: resourcesBefore, afterMeasured: resourcesAfter },
    nativeCounterSample: counters,
    memoryBytes: {
      heapUsedBefore: memoryBefore.heapUsed,
      heapUsedAfter: memoryAfter.heapUsed,
      observedHeapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssBefore: memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      observedRssDelta: memoryAfter.rss - memoryBefore.rss,
      forcedGarbageCollectionAvailable: Boolean(collectGarbage),
      note: collectGarbage
        ? 'Samples were collected after forced GC while the fixture remained live.'
        : 'Process samples may include unreachable objects because forced GC was unavailable.',
    },
    ...(fixture.shape === 'wide-list'
      ? { structuralListCounterSample: countWideListMove(fixture) }
      : {}),
  };
  expect(document.validate().valid).toBe(true);
  writer.close();
  document.close();
  return report;
}

function findWideList(document: CanonicalDocument) {
  const visit = (node: CanonicalNode): CanonicalNode | undefined => {
    if (node.type === 'list' && node.children.length > 1) return node;
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  const list = visit(document.root);
  if (!list) throw new Error('wide-list fixture has no list with multiple children');
  return { list, firstId: list.children[0]!.sharedId, movingId: list.children.at(-1)!.sharedId };
}

function prepareListMove(
  writer: CanonicalWriter,
  parentId: string,
  movingId: string,
  firstId: string,
  operationIndex: number,
  fixtureId: string,
): ActionRequest {
  return writer.prepareCommand(
    {
      actionId: `m0-${fixtureId}-move-${operationIndex}`,
      sessionId: 'm0-core-session',
      historyGroupId: `m0-${fixtureId}-move-history-${operationIndex}`,
    },
    (draft) => {
      draft.place(movingId, parentId, operationIndex % 2 === 0 ? firstId : null);
    },
  );
}

function countWideListMove(fixture: CoreFixture) {
  const document = createDocument(fixture);
  const writer = new CanonicalWriter(document);
  const { list, firstId, movingId } = findWideList(document);
  const before = snapshotNativeState(document);
  const measured = measureNativeOperations(document, () => {
    const request = prepareListMove(writer, list.sharedId, movingId, firstId, 100000, fixture.id);
    return publishTextInput(writer, request);
  });
  const after = snapshotNativeState(document);
  expect(document.validate().valid).toBe(true);
  const report = {
    measuredActions: 1,
    description: 'One untimed structural move with native operations and state counted separately.',
    before,
    after,
    introducedClientIds: after.clientIds.filter((clientId) => !before.clientIds.includes(clientId)),
    counts: measured.counts,
    acceptedUpdateBytes: measured.value.update.byteLength,
    receiptBytes: receiptByteLength(measured.value.receipt),
    checkpointBytes: {
      before: before.checkpointBytes,
      after: after.checkpointBytes,
      delta: after.checkpointBytes - before.checkpointBytes,
    },
  };
  writer.close();
  document.close();
  return report;
}

function runCoreProfile() {
  const config = manifest.profiles.core;
  expect(import.meta.env.VITE_GRAIN_YJS_M0_PROFILE ?? runtimeProcess.env.YJS_M0_PROFILE).toBe(
    'core',
  );
  const packageManifest = JSON.parse(packageJsonText) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  expect(packageManifest.dependencies?.yjs).toBe(manifest.baseline.yjsVersion);
  const fixtures = selectedFixture
    ? config.fixtures.filter((fixture) => fixture.id === selectedFixture)
    : config.fixtures;
  if (!fixtures.length) throw new Error(`Unknown M0 core fixture: ${selectedFixture}`);
  if (runtimeProcess.env.YJS_M0_COUNTERS_ONLY === '1') {
    const measuredFixtures = fixtures.map((fixture) => ({
      fixture,
      nativeCounterSample: counterSample(fixture),
      ...(fixture.shape === 'wide-list'
        ? { structuralListCounterSample: countWideListMove(fixture) }
        : {}),
    }));
    const report = {
      profile: 'core',
      counterSamplesOnly: true,
      runIndex,
      baselineCommit: manifest.baseline.commit,
      fixtureSeed: seed,
      yjsVersion: packageManifest.dependencies?.yjs,
      environment: {
        node: runtimeProcess.version,
        platform: runtimeProcess.platform,
        arch: runtimeProcess.arch,
      },
      fixtures: measuredFixtures,
    };
    console.log(`GRAIN_YJS_M0_REPORT=${JSON.stringify(report)}`);
    return;
  }
  const measuredFixtures = [];
  for (const fixture of fixtures) {
    runtimeProcess.stderr?.write(`GRAIN_YJS_M0_PROGRESS=core ${fixture.id} started\n`);
    measuredFixtures.push(
      benchmarkFixture(
        fixture,
        config.warmupOperationsPerDistribution,
        config.measuredOperationsPerDistribution,
      ),
    );
    runtimeProcess.stderr?.write(`GRAIN_YJS_M0_PROGRESS=core ${fixture.id} finished\n`);
  }
  const report = {
    profile: 'core',
    runIndex,
    baselineCommit: manifest.baseline.commit,
    fixtureSeed: seed,
    yjsVersion: packageManifest.dependencies?.yjs,
    environment: {
      node: runtimeProcess.version,
      platform: runtimeProcess.platform,
      arch: runtimeProcess.arch,
    },
    fixtures: measuredFixtures,
  };
  console.log(`GRAIN_YJS_M0_REPORT=${JSON.stringify(report)}`);
}

const retentionFixture: CoreFixture = {
  id: 'paragraphs-150-retention',
  shape: 'paragraphs',
  nodes: 150,
};

function historyEdit(
  writer: CanonicalWriter,
  targetId: string,
  operationIndex: number,
  caseId: string,
) {
  const request = editRequest(
    writer,
    targetId,
    caseId,
    operationIndex,
    12,
    operationIndex % 2 === 0 ? 'x' : 'y',
  );
  return publishTextInput(writer, request);
}

function retainedHistoryGroupCount(writer: CanonicalWriter, sessionId = 'm0-core-session'): number {
  const internals = writer as unknown as {
    readonly sessions: ReadonlyMap<string, { readonly all: ReadonlySet<unknown> }>;
  };
  return internals.sessions.get(sessionId)?.all.size ?? 0;
}

function seededHistory(depth: number) {
  const document = createDocument(retentionFixture);
  const writer = new CanonicalWriter(document);
  const target = firstInline(document);
  for (let index = 0; index < depth; index++)
    historyEdit(writer, target.sharedId, index, `m0-history-seed-${depth}`);
  return { document, writer, target };
}

function warmHistory(depth: number, warmupCount: number): void {
  const { document, writer, target } = seededHistory(depth);
  for (let index = 0; index < warmupCount; index++)
    historyEdit(writer, target.sharedId, depth + index, `m0-history-warm-${depth}`);
  writer.close();
  document.close();
}

function benchmarkHistoryDepth(depth: number, warmupCount: number, operationCount: number) {
  warmHistory(depth, warmupCount);
  const seeded = seededHistory(depth);
  const { document, target } = seeded;
  let writer = seeded.writer;
  const observedRetainedGroupsBefore = retainedHistoryGroupCount(writer);
  expect(observedRetainedGroupsBefore).toBe(depth);
  const prepareTimes: number[] = [];
  const applyPublishTimes: number[] = [];
  const callbackCounts: number[] = [];
  let acceptedUpdateBytes = 0;
  let receiptBytes = 0;
  collectGarbage?.();
  const memoryBefore = runtimeProcess.memoryUsage();
  const resourcesBefore = snapshotNativeState(document);

  for (let index = 0; index < operationCount; index++) {
    if (depth === 0 && index > 0) {
      writer.close();
      writer = new CanonicalWriter(document);
    }
    const prepareStart = performance.now();
    const request = editRequest(
      writer,
      target.sharedId,
      `m0-history-depth-${depth}`,
      index,
      12,
      index % 2 === 0 ? 'x' : 'y',
    );
    prepareTimes.push(performance.now() - prepareStart);
    const applyStart = performance.now();
    const accepted = publishTextInput(writer, request);
    applyPublishTimes.push(performance.now() - applyStart);
    acceptedUpdateBytes += accepted.update.byteLength;
    receiptBytes += receiptByteLength(accepted.receipt);
    callbackCounts.push(snapshotNativeState(document).activeAfterTransactionCallbacks);
    if (depth === 0) {
      writer.close();
      writer = new CanonicalWriter(document);
    }
  }

  const resourcesAfterMeasured = snapshotNativeState(document);
  const observedRetainedGroupsAfter = retainedHistoryGroupCount(writer);
  expect(observedRetainedGroupsAfter).toBe(depth === 0 ? 0 : Math.min(500, depth + operationCount));
  collectGarbage?.();
  const memoryAfter = runtimeProcess.memoryUsage();
  writer.close();
  const callbacksAfterClose = snapshotNativeState(document).activeAfterTransactionCallbacks;
  const report = {
    retainedGroupsBefore: depth,
    observedRetainedGroupsBefore,
    measuredOperationCount: operationCount,
    warmupOperationCount: warmupCount,
    retainedGroupsAfter: depth === 0 ? 0 : Math.min(500, depth + operationCount),
    observedRetainedGroupsAfter,
    stages: {
      prepareTextInput: summary(prepareTimes),
      applyAndPublish: summary(applyPublishTimes),
    },
    callbackCountsDuringSamples: {
      minimum: Math.min(...callbackCounts),
      maximum: Math.max(...callbackCounts),
      mean: rounding(
        callbackCounts.reduce((total, value) => total + value, 0) / callbackCounts.length,
      ),
    },
    activeCallbacksAfterClose: callbacksAfterClose,
    acceptedUpdateBytes: {
      total: acceptedUpdateBytes,
      mean: rounding(acceptedUpdateBytes / operationCount),
    },
    receiptBytes: { total: receiptBytes, mean: rounding(receiptBytes / operationCount) },
    resources: { before: resourcesBefore, afterMeasured: resourcesAfterMeasured },
    memoryBytes: {
      heapUsedBefore: memoryBefore.heapUsed,
      heapUsedAfter: memoryAfter.heapUsed,
      observedHeapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssBefore: memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      observedRssDelta: memoryAfter.rss - memoryBefore.rss,
      forcedGarbageCollectionAvailable: Boolean(collectGarbage),
    },
  };
  expect(document.validate().valid).toBe(true);
  document.close();
  return report;
}

function benchmarkLongTrace(actionCount: number, sampleCount: number) {
  const warmup = seededHistory(0);
  for (let index = 0; index < sampleCount; index++)
    historyEdit(warmup.writer, warmup.target.sharedId, index, 'm0-long-trace-warmup');
  warmup.writer.close();
  warmup.document.close();

  const document = createDocument(retentionFixture);
  const writer = new CanonicalWriter(document);
  const target = firstInline(document);
  const prepareTimes: number[] = [];
  const applyPublishTimes: number[] = [];
  let acceptedUpdateBytes = 0;
  let receiptBytes = 0;
  collectGarbage?.();
  const memoryBefore = runtimeProcess.memoryUsage();
  const resourcesBefore = snapshotNativeState(document);
  const traceStartedAt = performance.now();
  const checkpointInterval = 100;
  let checkpointStart = 0;
  let checkpointAcceptedUpdateBytes = 0;
  let checkpointReceiptBytes = 0;
  emitRetentionProgress({
    kind: 'long-trace-started',
    completedActions: 0,
    targetActions: actionCount,
    warmupOperationCount: sampleCount,
    fixture: retentionFixture,
  });

  for (let index = 0; index < actionCount; index++) {
    const prepareStart = performance.now();
    const request = editRequest(
      writer,
      target.sharedId,
      'm0-long-trace',
      index,
      12,
      index % 2 === 0 ? 'x' : 'y',
    );
    prepareTimes.push(performance.now() - prepareStart);
    const applyStart = performance.now();
    const accepted = publishTextInput(writer, request);
    applyPublishTimes.push(performance.now() - applyStart);
    acceptedUpdateBytes += accepted.update.byteLength;
    receiptBytes += receiptByteLength(accepted.receipt);

    const completedActions = index + 1;
    if (completedActions % checkpointInterval === 0 || completedActions === actionCount) {
      const memory = runtimeProcess.memoryUsage();
      const chunkPrepareTimes = prepareTimes.slice(checkpointStart, completedActions);
      const chunkApplyPublishTimes = applyPublishTimes.slice(checkpointStart, completedActions);
      emitRetentionProgress({
        kind: 'long-trace-progress',
        completedActions,
        targetActions: actionCount,
        elapsedMs: rounding(performance.now() - traceStartedAt),
        chunk: {
          fromAction: checkpointStart + 1,
          throughAction: completedActions,
          prepareTextInputMs: chunkPrepareTimes.map(rounding),
          applyAndPublishMs: chunkApplyPublishTimes.map(rounding),
          acceptedUpdateBytes: acceptedUpdateBytes - checkpointAcceptedUpdateBytes,
          receiptBytes: receiptBytes - checkpointReceiptBytes,
        },
        cumulative: {
          acceptedUpdateBytes,
          receiptBytes,
          heapUsedBytes: memory.heapUsed,
          rssBytes: memory.rss,
        },
      });
      runtimeProcess.stderr?.write(
        `GRAIN_YJS_M0_PROGRESS=retention long trace ${completedActions}/${actionCount} actions (${rounding(performance.now() - traceStartedAt)} ms)\n`,
      );
      checkpointStart = completedActions;
      checkpointAcceptedUpdateBytes = acceptedUpdateBytes;
      checkpointReceiptBytes = receiptBytes;
    }
  }

  const resourcesAfter = snapshotNativeState(document);
  const observedRetainedGroups = retainedHistoryGroupCount(writer);
  expect(observedRetainedGroups).toBe(500);
  collectGarbage?.();
  const memoryAfter = runtimeProcess.memoryUsage();
  const report = {
    actionCount,
    measuredSampleCount: actionCount,
    historyGroupLimit: 500,
    observedRetainedGroups,
    stages: {
      prepareTextInput: summary(prepareTimes),
      applyAndPublish: summary(applyPublishTimes),
    },
    acceptedUpdateBytes: {
      total: acceptedUpdateBytes,
      mean: rounding(acceptedUpdateBytes / actionCount),
    },
    receiptBytes: { total: receiptBytes, mean: rounding(receiptBytes / actionCount) },
    resources: { before: resourcesBefore, after: resourcesAfter },
    memoryBytes: {
      heapUsedBefore: memoryBefore.heapUsed,
      heapUsedAfter: memoryAfter.heapUsed,
      observedHeapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssBefore: memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      observedRssDelta: memoryAfter.rss - memoryBefore.rss,
      forcedGarbageCollectionAvailable: Boolean(collectGarbage),
    },
  };
  expect(document.validate().valid).toBe(true);
  writer.close();
  document.close();
  return report;
}

function runRetentionProfile() {
  const config = manifest.profiles.retention;
  emitRetentionProgress({
    kind: 'profile-started',
    baselineCommit: manifest.baseline.commit,
    yjsVersion: manifest.baseline.yjsVersion,
    environment: {
      node: runtimeProcess.version,
      platform: runtimeProcess.platform,
      arch: runtimeProcess.arch,
    },
    warmupOperationsPerDistribution: config.warmupOperationsPerDistribution,
    measuredOperationsPerDistribution: config.measuredOperationsPerDistribution,
    retainedGroupCounts: config.retainedGroupCounts,
    longTraceActions: config.longTraceActions,
  });
  const retainedHistory = [];
  for (const depth of config.retainedGroupCounts) {
    runtimeProcess.stderr?.write(`GRAIN_YJS_M0_PROGRESS=retention depth ${depth} started\n`);
    const result = benchmarkHistoryDepth(
      depth,
      config.warmupOperationsPerDistribution,
      config.measuredOperationsPerDistribution,
    );
    retainedHistory.push(result);
    emitRetentionProgress({ kind: 'retained-history-depth-complete', depth, result });
    runtimeProcess.stderr?.write(`GRAIN_YJS_M0_PROGRESS=retention depth ${depth} finished\n`);
  }
  const longTrace = benchmarkLongTrace(
    config.longTraceActions,
    config.warmupOperationsPerDistribution,
  );
  const report = {
    profile: 'retention',
    runIndex,
    baselineCommit: manifest.baseline.commit,
    fixtureSeed: seed,
    environment: {
      node: runtimeProcess.version,
      platform: runtimeProcess.platform,
      arch: runtimeProcess.arch,
    },
    retainedHistory,
    longTrace,
  };
  emitRetentionProgress({ kind: 'profile-complete', report });
  console.log(`GRAIN_YJS_M0_REPORT=${JSON.stringify(report)}`);
}

describe('Grain/Yjs M0 core benchmark', () => {
  it.skipIf(profile !== 'core')(
    'reports acceptance, projection, serialization, checkpoint, and native state distributions',
    () => {
      runCoreProfile();
    },
    1_200_000,
  );

  it.skipIf(profile !== 'retention')(
    'reports retained native history callbacks and a 10000-action trace',
    () => {
      runRetentionProfile();
    },
    7_200_000,
  );
});
