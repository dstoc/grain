import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { parseArgs } from 'node:util';
import { commandReplica } from '../../test/multiwriter/commands/replica.js';
import { insertText } from '../../src/markdown/multiwriter/authoring/index.js';
import { compareBytes } from '../../src/markdown/multiwriter/actions/cbor.js';
import { independentCheck, limits, hash, json } from './structural-fixture.mjs';
const { values } = parseArgs({
  options: { fixture: { type: 'string' }, output: { type: 'string' } },
});
const raw = readFileSync(values.fixture),
  fixture = deserialize(raw);
let start = performance.now();
const p = commandReplica(fixture.genesis, fixture.canonical, 'materialized', limits);
const candidateColdMs = performance.now() - start;
process.stderr.write(`candidate final cold: ${candidateColdMs.toFixed(1)} ms\n`);
start = performance.now();
const reference = commandReplica(fixture.genesis, fixture.canonical, 'reference', limits);
const referenceColdMs = performance.now() - start;
process.stderr.write(`reference final cold: ${referenceColdMs.toFixed(1)} ms\n`);
const carriers = [],
  off = p.document.store.onUpdate((u) => carriers.push(u.slice()));
try {
  assert.equal(compareBytes(p.document.store.encodeUpdate(), fixture.canonical), 0);
  independentCheck(p, reference);
  const prior = p.document.publication.status().publication;
  const priorNative = prior.native.encodeState(),
    priorView = json(prior.value.view);
  const history = p.editor.session('cold-continuation');
  assert.equal(history.status().undo, 0);
  assert.equal(history.status().redo, 0);
  const node = p.nodes().at(-1),
    nodeId = p.handle(node),
    before = p.markdown();
  const point = { nodeId, offset: 0, affinity: 'right' };
  start = performance.now();
  const edit = history.edit(
    insertText,
    { nodeId, from: 0, text: 'C' },
    { typing: false, selectionBefore: { anchor: point, focus: point } },
  );
  const continuedEditMs = performance.now() - start;
  assert.equal(edit.status, 'applied');
  independentCheck(p, reference);
  const after = p.markdown();
  const evictStart = performance.now();
  p.document.publication.evict();
  p.editor.refresh();
  const evictionReopenMs = performance.now() - evictStart;
  independentCheck(p, reference);
  const undo = history.undo();
  assert.equal(undo.state, 'applied');
  assert.equal(undo.restoration.state, 'exact');
  assert.equal(undo.restoration.anchor.offset, 0);
  assert.equal(p.markdown(), before);
  independentCheck(p, reference);
  const redo = history.redo();
  assert.equal(redo.state, 'applied');
  assert.equal(redo.restoration.state, 'exact');
  assert.equal(redo.restoration.anchor.offset, 1);
  assert.equal(p.markdown(), after);
  independentCheck(p, reference);
  assert.equal(compareBytes(prior.native.encodeState(), priorNative), 0);
  assert.equal(json(prior.value.view), priorView);
  assert.equal(history.status().undo, 1);
  assert.equal(carriers.length, 3);
  const canonical = p.document.store.encodeUpdate();
  writeFileSync(
    values.output + '.bin',
    serialize({ genesis: fixture.genesis, initial: fixture.canonical, carriers, canonical }),
    { flag: 'wx' },
  );
  writeFileSync(
    values.output + '.json',
    json({
      complete: true,
      fixtureSha256: hash(raw),
      candidateColdMs,
      referenceColdMs,
      continuedEditMs,
      evictionReopenMs,
      startedWithEmptyHistory: true,
      history: history.status(),
      undoRestoration: undo.restoration.state,
      redoRestoration: redo.restoration.state,
      canonicalSha256: hash(canonical),
      persistence: { measured: false, reason: 'no journal attached' },
    }),
    { flag: 'wx' },
  );
} finally {
  off();
  reference.close();
  p.close();
}
