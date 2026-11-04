import { readFileSync, writeFileSync } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  createGenesis,
  decodeGenesis,
} from '../../src/markdown/multiwriter/bootstrap/descriptor.js';
import { referenceGenesis } from '../../src/markdown/multiwriter/bootstrap/descriptor.js';
import { openReferenceDocument } from '../../src/markdown/multiwriter/reference/document.js';
import { LocalEditor } from '../../src/markdown/multiwriter/authoring/editor.js';
import { encodeEnvelope } from '../../src/markdown/multiwriter/actions/codec.js';
import { insertText } from '../../src/editing/commands/insert-text.js';
import { serializeProjection } from '../../src/markdown/multiwriter/projection/project.js';

const { values } = parseArgs({
  options: {
    mode: { type: 'string' },
    fixture: { type: 'string' },
    implementation: { type: 'string' },
    size: { type: 'string' },
    steps: { type: 'string' },
    warmup: { type: 'string' },
  },
});
const limits = { bytes: 128 * 1024 * 1024, operations: 20_000_000, nativeOperations: 10_000_000 };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const semanticHash = (value) =>
  hash(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint'
        ? `${item}n`
        : item instanceof Uint8Array
          ? Buffer.from(item).toString('base64')
          : item,
    ),
  );
function refresh(document) {
  let result = document.publication.refresh();
  while (result.state === 'deferred') result = result.continuation.resume(Number.MAX_SAFE_INTEGER);
  return result.value;
}
function observation(document) {
  const p = document.publication.status().publication;
  const o = p.value.ownership;
  return semanticHash({
    ready: document.store.snapshot(),
    heads: p.heads,
    view: p.value.view,
    activity: p.value.activity.effects,
    visibility: p.value.visibility,
    placements: o.nodeAllocations.map((n) => [n.id, o.blockPlacement(n.id), o.children(n.id)]),
    assignments: o.assignments,
    flows: o.flowPlacements,
    runs: o.runLayouts,
    buckets: o.buckets,
    homes: o.homeBindings,
    requirements: o.destinationRequirements,
    native: p.native.encodeState(),
    canonical: document.store.encodeUpdate(),
  });
}
function metrics(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
if (values.mode === 'capture') {
  const size = Number(values.size),
    steps = Number(values.steps);
  const genesis = createGenesis(
    `mw13-bench-${size}`,
    Array.from({ length: size }, () => 'abc').join('\n\n'),
    limits,
  );
  const document = openReferenceDocument(referenceGenesis(decodeGenesis(genesis, limits)), {
    nativeDecodeOperations: limits.nativeOperations,
  });
  refresh(document);
  const editor = new LocalEditor(document, referenceGenesis(decodeGenesis(genesis, limits)), {
    nativeDecodeOperations: limits.nativeOperations,
  });
  const carriers = [],
    schedule = Array.from({ length: steps }, (_, i) => ({ from: i % 3, text: 'x' }));
  const off = document.store.onUpdate((u) => carriers.push(u));
  try {
    for (const [i, edit] of schedule.entries()) {
      const node = document.publication.status().publication.value.view.root.children[0];
      const result = editor.edit({ local: 'bench', group: BigInt(i + 1) }, insertText, {
        nodeId: editor.handle(node.origin.representative),
        ...edit,
      });
      if (result.status !== 'applied') throw new Error('Capture command did not apply');
      if ((i + 1) % 100 === 0) process.stderr.write(`captured ${i + 1}/${steps}\n`);
    }
    if (carriers.length !== steps) throw new Error('Capture lost an original carrier');
    const fixture = {
      size,
      genesis,
      schedule,
      carriers,
      expected: observation(document),
      markdown: serializeProjection(document.publication.status().publication.value.view),
    };
    writeFileSync(values.fixture, serialize(fixture), { flag: 'wx' });
    process.stdout.write(
      JSON.stringify({
        size,
        steps,
        sha256: hash(readFileSync(values.fixture)),
        genesisBytes: genesis.byteLength,
        carrierBytes: carriers.reduce((n, u) => n + u.byteLength, 0),
      }) + '\n',
    );
  } finally {
    off();
    editor.destroy();
    document.destroy();
  }
} else {
  if (!['replay', 'command'].includes(values.mode)) throw new Error('Invalid worker mode');
  const fixture = deserialize(readFileSync(values.fixture));
  const open =
    values.implementation === 'reference'
      ? openReferenceDocument
      : (await import('../../src/markdown/multiwriter/materialization/document.js'))
          .openMaterializedDocument;
  global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const document = open(referenceGenesis(decodeGenesis(fixture.genesis, limits)), {
    nativeDecodeOperations: limits.nativeOperations,
  });
  const start = performance.now();
  refresh(document);
  const coldMs = performance.now() - start;
  const editor =
    values.mode === 'command'
      ? new LocalEditor(document, referenceGenesis(decodeGenesis(fixture.genesis, limits)), {
          nativeDecodeOperations: limits.nativeOperations,
        })
      : undefined;
  const warmup = Number(values.warmup),
    samples = [];
  try {
    for (let i = 0; i < fixture.schedule.length; i++) {
      const before = performance.now();
      if (editor) {
        const node = document.publication.status().publication.value.view.root.children[0];
        const result = editor.edit({ local: 'bench', group: BigInt(i + 1) }, insertText, {
          nodeId: editor.handle(node.origin.representative),
          ...fixture.schedule[i],
        });
        if (result.status !== 'applied') throw new Error('Timed command did not apply');
      } else {
        document.store.applyUpdate(fixture.carriers[i]);
        refresh(document);
      }
      const elapsed = performance.now() - before;
      if (i >= warmup) samples.push(elapsed);
    }
    const markdown = serializeProjection(document.publication.status().publication.value.view);
    if (markdown !== fixture.markdown) throw new Error('Command script output differs');
    // Oracle/diagnostic exports are deliberately outside the measured intervals.
    if (!editor && observation(document) !== fixture.expected)
      throw new Error('Exact replay differs from reference');
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const canonical = document.store.encodeUpdate();
    const result = {
      mode: values.mode,
      implementation: values.implementation,
      size: fixture.size,
      steps: fixture.schedule.length,
      warmup,
      coldMs,
      latencyMs: metrics(samples),
      diagnostics: document.publication.diagnostics?.() ?? null,
      canonicalBytes: canonical.byteLength,
      envelopeBytes: document.store
        .snapshot()
        .ready.reduce((n, a) => n + encodeEnvelope(a).byteLength, 0),
      embeddedNativeUpdateBytes: document.store
        .snapshot()
        .ready.reduce((n, a) => n + a.nativeInsertUpdates.reduce((m, u) => m + u.byteLength, 0), 0),
      genesisBytes: fixture.genesis.byteLength,
      nativeBytes: document.publication.status().publication.native.encodeState().byteLength,
      // This includes canonical state AND all caches/editor metadata; it is not a cache-only heap measurement.
      processHeapDelta: heapAfter - heapBefore,
      storageJournalBytes: null,
      localHistoryBytes: null,
      consolidation: null,
      verified: true,
      markdownSha256: hash(markdown),
      fixtureSha256: hash(readFileSync(values.fixture)),
    };
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    editor?.destroy();
    document.destroy();
  }
}
