import { readFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CanonicalDocument } from '../../src/markdown/canonical-model.js';
import { CanonicalWriter } from '../../src/markdown/canonical-actions.js';
import { serializeToString } from '../../src/markdown/block-serializer.js';
const { values } = parseArgs({
  options: { fixture: { type: 'string' }, warmup: { type: 'string' } },
});
const fixtureBytes = readFileSync(values.fixture),
  fixture = deserialize(fixtureBytes);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const markdown = Array.from({ length: fixture.size }, () => 'abc').join('\n\n');
global.gc();
const beforeHeap = process.memoryUsage().heapUsed;
const document = CanonicalDocument.fromMarkdown(markdown);
const writer = new CanonicalWriter(document);
const node = document.root.children[0];
const samples = [];
writer.admitSession('bench');
try {
  for (const [i, edit] of fixture.schedule.entries()) {
    const start = performance.now();
    const request = writer.prepareTextInput(
      node.sharedId,
      { from: edit.from, to: edit.from, insert: edit.text },
      {
        actionId: `bench-${i}`,
        sessionId: 'bench',
        historyGroupId: `group-${i}`,
      },
    );
    const result = writer.apply(request, {
      sessionId: 'bench',
      authorityEpoch: request.authorityEpoch,
      sessionSequence: request.sessionSequence,
    });
    if (result.status !== 'pending') throw new Error(`Post-M5 apply failed: ${result.status}`);
    writer.publish(result.pending);
    const elapsed = performance.now() - start;
    if (i >= Number(values.warmup)) samples.push(elapsed);
  }
  const output = serializeToString(document.exportMarkdownTree());
  if (output !== fixture.markdown) throw new Error('Post-M5 semantic script output differs');
  global.gc();
  const processHeapDelta = process.memoryUsage().heapUsed - beforeHeap;
  const sorted = [...samples].sort((a, b) => a - b);
  process.stdout.write(
    JSON.stringify({
      mode: 'command',
      implementation: 'schema2-postM5',
      size: fixture.size,
      steps: fixture.schedule.length,
      warmup: Number(values.warmup),
      latencyMs: {
        samples,
        p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      },
      canonicalCheckpointBytes: document.checkpoint().update.byteLength,
      processHeapDelta,
      fixtureSha256: hash(fixtureBytes),
      markdownSha256: hash(output),
      verified: true,
      model: 'schema-2 authority and native history; not an independent multiwriter algorithm',
    }) + '\n',
  );
} finally {
  writer.close();
  document.close();
}
