import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { observePhases } from './phases.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
function worker(args) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--import',
        './benchmarks/multiwriter/resolve-ts.mjs',
        'benchmarks/multiwriter/worker.mjs',
        ...args,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
}
test('original carrier observations compare contract values across reader export orders', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grain-mw13-observation-'));
  try {
    const fixture = join(directory, 'fixture.bin');
    const captured = worker([
      '--mode',
      'capture',
      '--size',
      '2',
      '--steps',
      '2',
      '--fixture',
      fixture,
    ]);
    const replay = (implementation) =>
      worker([
        '--mode',
        'replay',
        '--implementation',
        implementation,
        '--fixture',
        fixture,
        '--warmup',
        '0',
      ]);
    const reference = replay('reference'),
      materialized = replay('materialized');
    for (const result of [reference, materialized]) {
      assert.equal(result.verified, true);
      assert.equal(result.fixtureSha256, captured.sha256);
    }
    for (const key of [
      'canonicalBytes',
      'envelopeBytes',
      'embeddedNativeUpdateBytes',
      'genesisBytes',
      'nativeBytes',
      'markdownSha256',
    ])
      assert.equal(materialized[key], reference[key], key);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('managed worker measures real selection/edit/Undo/Redo and serialized history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grain-mw13-managed-'));
  try {
    const fixture = join(directory, 'fixture.bin');
    worker(['--mode', 'capture', '--size', '2', '--steps', '2', '--fixture', fixture]);
    const samples = ['reference', 'materialized'].map((implementation) =>
      worker([
        '--mode',
        'command',
        '--managed',
        '--implementation',
        implementation,
        '--fixture',
        fixture,
        '--warmup',
        '0',
      ]),
    );
    for (const sample of samples) {
      assert.equal(sample.verified, true);
      assert.equal(sample.historyMode, 'managed');
      assert.equal(sample.historyStatus.undo, 2);
      assert.equal(sample.historyStatus.redo, 0);
      assert(sample.localHistoryBytes > 0);
      assert.equal(sample.historyMethod, 'serialized MW-10 navigation metadata; not heap');
      assert.equal(sample.navigation.undoRestoration, 'exact');
      assert.equal(sample.navigation.redoRestoration, 'exact');
      assert(sample.navigation.undoMs >= 0);
      assert(sample.navigation.redoMs >= 0);
      assert.equal(sample.latencyMs.samples.length, 2);
      assert.equal(sample.storageJournalBytes, null);
      assert.equal(sample.engineBoundaryMs.samples.length, 2);
      for (const boundary of Object.values(sample.engineBoundaryMs.boundaries)) {
        assert.equal(boundary.samples.length, 2);
        assert(boundary.samples.every((value) => value >= 0));
      }
      assert(sample.engineBoundaryMs.boundaries.append.samples.every((value) => value > 0));
    }
    assert.equal(samples[0].markdownSha256, samples[1].markdownSha256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phase observation preserves deferred work, receiver identity, cancellation and nested boundaries', () => {
  let clock = 0,
    cancelled = 0;
  const complete = { state: 'complete', value: {} };
  const continuation = {
    cancel() {
      assert.equal(this, continuation);
      cancelled++;
    },
    resume(budget) {
      assert.equal(this, continuation);
      clock += budget;
      return complete;
    },
  };
  class Publication {
    refresh() {
      assert.equal(this, publication);
      clock += 5;
      return { state: 'deferred', continuation };
    }
  }
  const publication = new Publication();
  const document = {
    publication,
    store: {
      append(value) {
        assert.equal(this, document.store);
        clock += 2;
        publication.refresh();
        clock += 3;
        return value;
      },
      applyUpdate() {
        clock += 6;
      },
    },
    certifyLocal() {
      clock += 4;
    },
    stageLocalAction() {
      clock += 3;
    },
  };
  const originalAppend = document.store.append,
    phases = observePhases(document, () => clock),
    before = phases.snapshot();
  const value = {};
  assert.equal(document.store.append(value), value);
  const work = publication.refresh();
  work.continuation.cancel();
  assert.equal(cancelled, 1);
  assert.equal(work.continuation.resume(7), complete);
  document.store.applyUpdate();
  document.certifyLocal();
  document.stageLocalAction();
  assert.deepEqual(phases.since(before), {
    append: 10,
    receive: 6,
    certify: 4,
    stage: 3,
    refresh: 17,
  });
  phases.restore();
  assert.equal(document.store.append, originalAppend);
  assert.equal(Object.hasOwn(publication, 'refresh'), false);
});

test('phase observation rethrows the original failure after recording the work once', () => {
  let clock = 0,
    calls = 0;
  const failure = new Error('retained append observer');
  const document = {
    store: {
      append() {
        calls++;
        clock += 2;
        throw failure;
      },
    },
    publication: {},
  };
  const phases = observePhases(document, () => clock);
  assert.throws(
    () => document.store.append(),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  assert.equal(phases.snapshot().append, 2);
  phases.restore();
});

test('managed runner help and argument errors keep stdout machine-readable', () => {
  const run = (args) =>
    spawnSync(process.execPath, ['benchmarks/multiwriter/managed.mjs', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage:/);
  assert.equal(help.stderr, '');
  const invalid = run(['--fixture', '/unused', '--output', '/unused', '--runs', '0']);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /--runs must be a positive safe integer/);
});

test('paired runners reuse an exact retained fixture and reject a changed schedule', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grain-mw13-reuse-'));
  try {
    const source = join(directory, 'source');
    mkdirSync(source);
    const fixture = join(source, 'fixture-2.bin');
    const capture = worker([
      '--mode',
      'capture',
      '--size',
      '2',
      '--steps',
      '2',
      '--fixture',
      fixture,
    ]);
    const original = readFileSync(fixture);
    writeFileSync(join(source, 'fixture-2.json'), JSON.stringify(capture));
    writeFileSync(
      join(source, 'report.json'),
      JSON.stringify({
        complete: true,
        steps: 2,
        baseline: '415363a4e85549a33eee3010d69e55ce6161002d',
        candidate: 'test-capture',
      }),
    );
    const output = join(directory, 'unmanaged');
    execFileSync(
      process.execPath,
      [
        'benchmarks/multiwriter/run.mjs',
        '--fixtures',
        source,
        '--output',
        output,
        '--size',
        '2',
        '--runs',
        '1',
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const report = JSON.parse(readFileSync(join(output, 'report.json')));
    assert.equal(report.complete, true);
    assert.equal(report.samples.length, 4);
    assert.equal(report.sourceFixtureReport.candidate, 'test-capture');
    assert(
      report.samples.every((sample) => sample.verified && sample.fixtureSha256 === capture.sha256),
    );
    assert(readFileSync(join(output, 'fixture-2.bin')).equals(original));
    assert(readFileSync(fixture).equals(original));
    const invalid = spawnSync(
      process.execPath,
      [
        'benchmarks/multiwriter/run.mjs',
        '--fixtures',
        source,
        '--output',
        join(directory, 'invalid'),
        '--size',
        '2',
        '--steps',
        '3',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /--steps differs from the retained fixture schedule/);
    const managed = join(directory, 'managed');
    execFileSync(
      process.execPath,
      [
        'benchmarks/multiwriter/managed.mjs',
        '--fixture',
        fixture,
        '--output',
        managed,
        '--runs',
        '1',
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const managedReport = JSON.parse(readFileSync(join(managed, 'report.json')));
    assert.equal(managedReport.complete, true);
    assert.equal(managedReport.warmup, 1);
    assert.equal(managedReport.samples.length, 2);
    assert(
      managedReport.samples.every(
        (sample) =>
          sample.historyMode === 'managed' && sample.navigation.undoRestoration === 'exact',
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('discarded publication roots are collectable while held publications remain readable', () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--import',
        './benchmarks/multiwriter/resolve-ts.mjs',
        '--input-type=module',
        '--eval',
        String.raw`
      import { commandGenesis, commandReplica } from './test/multiwriter/commands/replica.ts';
      import { insertText } from './src/editing/commands/insert-text.ts';
      import { insertParagraph } from './src/editing/commands/insert-paragraph.ts';
      import { joinWithPrevious } from './src/editing/commands/join-with-previous.ts';
      import { readySource } from './src/markdown/multiwriter/authoring/ready-source.ts';
      const turn = () => new Promise(resolve => setImmediate(resolve));
      const results = [];
      for (const kind of ['text', 'info', 'structural']) for (const managed of [false, true]) {
        const peer = commandReplica(commandGenesis(kind === 'info' ? '\x60\x60\x60js\nabc\n\x60\x60\x60' : 'abcdef'), undefined, 'materialized');
        const history = managed ? peer.editor.session('gc') : undefined;
        const property = (ctx, args) => { ctx.draft.setInfo(args.nodeId, args.info); return {status: 'handled'}; };
        const edit = i => {
          const command = kind === 'structural' ? (i % 2 ? insertParagraph : joinWithPrevious) : kind === 'text' ? insertText : property;
          const input = kind === 'structural' ? {nodeId: peer.handle(peer.nodes()[i % 2 ? 0 : 1]), from: 3} : kind === 'text' ? {nodeId: peer.handle(peer.nodes()[0]), from: 1, text: 'x'} : {nodeId: peer.handle(peer.nodes()[0]), info: String(i)};
          return history ? history.edit(command, input) : peer.editor.edit({local: 'gc', group: BigInt(i)}, command, input);
        };
        const retired = (() => {
          edit(1);
          const value = peer.document.publication.status().publication;
          const ready = peer.document.store.readReady().ready;
          return [new WeakRef(value.value), new WeakRef(value.native), new WeakRef(value.value.view.root), new WeakRef(ready), new WeakRef(readySource(ready))];
        })();
        let held = peer.document.publication.status().publication;
        let heldReady = peer.document.store.readReady().ready;
        let heldSource = readySource(heldReady);
        const retainedNative = held.native.encodeState(), retainedText = held.value.view.root.children[0].content, retainedInfo = held.value.view.root.children[0].info;
        for (let i = 2; i <= 16; i++) edit(i);
        await turn(); global.gc(); global.gc();
        const heldBefore = retired.every(ref => ref.deref() !== undefined);
        await turn(); peer.document.publication.evict();
        await turn(); global.gc(); global.gc();
        const heldAfter = retired.every(ref => ref.deref() !== undefined);
        if (held.value.view.root.children[0].content !== retainedText || held.value.view.root.children[0].info !== retainedInfo ||
            !Buffer.from(held.native.encodeState()).equals(retainedNative)) throw new Error('Held publication changed');
        if (!heldSource.has(heldReady[0].id.actor + ':' + heldReady[0].id.sequence)) throw new Error('Held ready metadata changed');
        held = undefined; heldReady = undefined; heldSource = undefined;
        let released = false;
        for (let i = 0; i < 10; i++) {
          await turn(); global.gc(); global.gc();
          if (retired.every(ref => ref.deref() === undefined)) { released = true; break; }
        }
        results.push({kind, managed, heldBefore, heldAfter, released});
        peer.close();
      }
      console.log(JSON.stringify(results));
    `,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  assert.deepEqual(
    result,
    ['text', 'info', 'structural'].flatMap((kind) =>
      [false, true].map((managed) => ({
        kind,
        managed,
        heldBefore: true,
        heldAfter: true,
        released: true,
      })),
    ),
  );
});

test('structural locality command validates arguments before writing and documents its work limit', () => {
  const run = (args) =>
    spawnSync(process.execPath, ['benchmarks/multiwriter/structural-locality.mjs', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /five minutes/);
  assert.equal(help.stderr, '');
  const invalid = run(['--output', '/unused', '--case', '10000']);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /invalid --case/);
});

test('short structural runner uses real managed history, independent checks, exclusive spans and retained work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grain-mw13a-'));
  try {
    const output = join(directory, 'sample');
    execFileSync(
      process.execPath,
      [
        '--import',
        './benchmarks/multiwriter/resolve-ts.mjs',
        'benchmarks/multiwriter/structural-locality-worker.mjs',
        '--fixture',
        'test/multiwriter/fixtures/structural-locality/fixture-150.bin',
        '--output',
        output,
        '--instrumented',
        '--deleted',
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 },
    );
    const report = JSON.parse(readFileSync(output + '.json'));
    assert.equal(report.complete, true);
    assert.equal(report.trace.length, 8);
    assert.equal(report.prefixActions, 0);
    assert.equal(report.persistence.measured, false);
    for (const row of report.trace) {
      assert(row.oracleMs > 0);
      assert(row.exclusive.wallMs <= row.wallMs);
      const exclusive = row.exclusive.spans.reduce((n, s) => n + s.end - s.start, 0);
      assert(Math.abs(exclusive - row.exclusive.wallMs) < 0.000001, 'exclusive spans reconcile');
      for (let i = 1; i < row.exclusive.spans.length; i++)
        assert.equal(row.exclusive.spans[i].start, row.exclusive.spans[i - 1].end);
    }
    const split = report.trace.find((s) => s.name === 'split').exclusive.work;
    assert.equal(split['author/draft.fullConstructionTrees'] ?? 0, 0);
    assert.equal(split['author/compiler.fullConstructionTrees'] ?? 0, 0);
    assert.equal(split['author/command.candidatesPrepared'], 1);
    assert.equal(split['publication/command.candidatesPublished'], 1);
    assert.equal(split['publication/ownership.fullInputEnumerated'] ?? 0, 0);
    assert.equal(split['publication/ownership.sortInputs'] ?? 0, 0);
    assert.equal(split['publication/ownership.suffixActions'], 1);
    assert.equal(split['publication/deletion.fullIndexesConstructed'] ?? 0, 0);
    assert.equal(split['publication/projection.localStructuralCandidates'], 1);
    assert.equal(split['publication/deletion.retainedEffectsInspected'] ?? 0, 0);
    assert(split['publication/deletion.changedEffectsInspected'] > 0);
    assert(split['publication/coupled.candidatesCommitted'] > 0);
    const edit = report.trace.find((s) => s.name === 'unrelated-edit').exclusive.work;
    assert.equal(edit['publication/projection.fullProjectors'] ?? 0, 0);
    assert.equal(edit['publication/provenance.fullReconstructions'] ?? 0, 0);
    assert.equal(edit['publication/coupled.candidatesCommitted'], 1);
    assert(readFileSync(output + '.bin').byteLength > 0);
    const coldOutput = join(directory, 'cold');
    execFileSync(
      process.execPath,
      [
        '--import',
        './benchmarks/multiwriter/resolve-ts.mjs',
        'benchmarks/multiwriter/structural-cold-worker.mjs',
        '--fixture',
        output + '.bin',
        '--output',
        coldOutput,
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 },
    );
    const cold = JSON.parse(readFileSync(coldOutput + '.json'));
    assert.equal(cold.complete, true);
    assert(cold.evictionReopenMs > 0);
    assert.equal(cold.startedWithEmptyHistory, true);
    assert.equal(cold.history.undo, 1);
    assert.equal(cold.history.redo, 0);
    assert.equal(cold.undoRestoration, 'exact');
    assert.equal(cold.redoRestoration, 'exact');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cancelled production adapter candidates release roots while the prior tuple stays held', () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--import',
        './benchmarks/multiwriter/resolve-ts.mjs',
        '--input-type=module',
        '--eval',
        String.raw`
          import assert from 'node:assert/strict';
          import { commandGenesis, commandReplica } from './test/multiwriter/commands/replica.ts';
          import { insertParagraph } from './src/editing/commands/insert-paragraph.ts';
          import { MaterializedProjection } from './src/markdown/multiwriter/materialization/projection.ts';
          const genesis = commandGenesis('abcdef\n\ntail');
          const source = commandReplica(genesis), target = commandReplica(genesis, undefined, 'materialized');
          const held = target.document.publication.status().publication;
          const heldNative = held.native.encodeState(), heldView = JSON.stringify(held.value.view);
          assert.equal(source.editor.session('source').edit(insertParagraph, {nodeId: source.handle(source.nodes()[0]), from: 2}).status, 'applied');
          target.document.store.applyUpdate(source.document.store.encodeUpdate());
          const retired = [];
          const prepare = MaterializedProjection.prototype.prepare;
          let built = false;
          // A non-retaining wrapper records only weak identities. Mock call logs
          // would themselves retain the candidate and invalidate this control.
          MaterializedProjection.prototype.prepare = function* (...args) {
            const candidate = yield* prepare.apply(this, args);
            retired.push(new WeakRef(candidate.value), new WeakRef(candidate.value.view.root), new WeakRef(candidate.value.ownership));
            built = true;
            yield;
            return candidate;
          };
          for (let trial = 0; trial < 16; trial++) {
            built = false;
            let work = target.document.publication.refresh(0);
            while (!built) {
              assert.equal(work.state, 'deferred');
              work = work.continuation.resume(1);
            }
            assert.equal(work.state, 'deferred');
            work.continuation.cancel();
            assert.equal(target.document.publication.status().publication, held);
            assert.equal(target.document.activityDiagnostics().retainedActions, 0);
          }
          MaterializedProjection.prototype.prepare = prepare;
          target.document.publication.evict();
          const turn = () => new Promise(resolve => setImmediate(resolve));
          let released = false;
          for (let i = 0; i < 10; i++) {
            await turn(); global.gc(); global.gc();
            if (retired.every(ref => ref.deref() === undefined)) { released = true; break; }
          }
          assert.equal(JSON.stringify(held.value.view), heldView);
          assert(Buffer.from(held.native.encodeState()).equals(heldNative));
          console.log(JSON.stringify({released, candidates: retired.length / 3, retainedPrior: true}));
          target.close(); source.close();
        `,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  assert.deepEqual(result, { released: true, candidates: 16, retainedPrior: true });
});

test('held selected cohort roots release producer and cancelled candidates across later publications', () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--import',
        './benchmarks/multiwriter/resolve-ts.mjs',
        '--input-type=module',
        '--eval',
        String.raw`
          import assert from 'node:assert/strict';
          import { NativeFixture } from './src/markdown/multiwriter/ownership/test-fixtures.ts';
          import { commandReplica } from './test/multiwriter/commands/replica.ts';
          import { insertParagraph } from './src/editing/commands/insert-paragraph.ts';
          import { insertText } from './src/editing/commands/insert-text.ts';
          import { StructuralIndex } from './src/markdown/multiwriter/materialization/structural.ts';
          import { MaterializedProjection } from './src/markdown/multiwriter/materialization/projection.ts';
          const f = new NativeFixture();
          f.author('A1', f => [f.split('P', 'R', 'P3')]);
          f.author('B1', f => [f.split('P', 'L', 'P1')]);
          const genesis = {documentId: 'D', genesisId: 'G', layout: f.genesis,
            body: {...f.bodies.get('G'), allocations: f.genesis.allocations}, initialProperties: []};
          const producers = new WeakMap(), selectedCohorts = StructuralIndex.prototype.selectedCohorts;
          StructuralIndex.prototype.selectedCohorts = function () {
            const read = selectedCohorts.call(this);
            producers.set(read, new WeakRef(this));
            return read;
          };
          const p = commandReplica(genesis, undefined, 'materialized');
          for (const name of ['A1', 'B1']) {
            const envelope = f.envelope(name);
            p.document.certifyLocal(envelope); p.document.store.append(envelope); p.editor.refresh();
          }
          // Hold only the selected reader, not its OwnershipResult or publication.
          const read = p.document.publication.status().publication.value.ownership.cohortLookup,
            producer = producers.get(read), root = f.id('root', 'node'), saved = structuredClone(read(root));
          assert.equal(saved.length, 1); assert.equal(saved[0].roots.length, 2);
          for (let i = 1; i <= 16; i++) assert.equal(p.editor.session('text').edit(insertText, {
            nodeId: p.handle(p.nodes()[0]), from: 1, text: 'x',
          }, {typing: false}).status, 'applied');
          assert.deepEqual(read(root), saved);
          const source = commandReplica(genesis, p.document.store.encodeUpdate());
          assert.equal(source.editor.session('split').edit(insertParagraph, {
            nodeId: source.handle(source.nodes()[0]), from: 1,
          }).status, 'applied');
          p.document.store.applyUpdate(source.document.store.encodeUpdate());
          const retired = [], prepare = MaterializedProjection.prototype.prepare;
          let built = false;
          MaterializedProjection.prototype.prepare = function* (...args) {
            const candidate = yield* prepare.apply(this, args);
            retired.push(new WeakRef(candidate.value), new WeakRef(candidate.value.ownership),
              producers.get(candidate.value.ownership.cohortLookup));
            built = true; yield; return candidate;
          };
          for (let trial = 0; trial < 16; trial++) {
            built = false;
            let work = p.document.publication.refresh(0);
            while (!built) { assert.equal(work.state, 'deferred'); work = work.continuation.resume(1); }
            assert.equal(work.state, 'deferred'); work.continuation.cancel();
            assert.deepEqual(read(root), saved);
          }
          MaterializedProjection.prototype.prepare = prepare;
          StructuralIndex.prototype.selectedCohorts = selectedCohorts;
          p.document.publication.evict();
          const turn = () => new Promise(resolve => setImmediate(resolve));
          let released = false;
          for (let i = 0; i < 10; i++) {
            await turn(); global.gc(); global.gc();
            if (!producer.deref() && retired.every(ref => ref && !ref.deref())) { released = true; break; }
          }
          assert.deepEqual(read(root), saved);
          const bytes = p.document.store.encodeUpdate();
          const held = p.document.publication.status().publication;
          const native = held.native.encodeState();
          p.editor.refresh();
          assert(Buffer.from(held.native.encodeState()).equals(native));
          assert(Buffer.from(p.document.store.encodeUpdate()).equals(bytes));
          assert.deepEqual(read(root), saved);
          console.log(JSON.stringify({released, candidates: retired.length / 3, heldSelectedRoots: saved[0].roots.length}));
          p.close(); source.close(); f.destroy();
        `,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  assert.deepEqual(result, { released: true, candidates: 16, heldSelectedRoots: 2 });
});
