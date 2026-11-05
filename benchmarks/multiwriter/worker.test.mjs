import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
    }
    assert.equal(samples[0].markdownSha256, samples[1].markdownSha256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
      const turn = () => new Promise(resolve => setImmediate(resolve));
      const results = [];
      for (const managed of [false, true]) {
        const peer = commandReplica(commandGenesis('abc'), undefined, 'materialized');
        const history = managed ? peer.editor.session('gc') : undefined;
        const edit = i => history
          ? history.edit(insertText, {nodeId: peer.handle(peer.nodes()[0]), from: 1, text: 'x'})
          : peer.editor.edit({local: 'gc', group: BigInt(i)}, insertText, {nodeId: peer.handle(peer.nodes()[0]), from: 1, text: 'x'});
        const retired = (() => {
          edit(1);
          const value = peer.document.publication.status().publication;
          return [new WeakRef(value.value), new WeakRef(value.native), new WeakRef(value.value.view.root)];
        })();
        let held = peer.document.publication.status().publication;
        const retainedNative = held.native.encodeState(), retainedText = held.value.view.root.children[0].content;
        for (let i = 2; i <= 16; i++) edit(i);
        await turn(); global.gc(); global.gc();
        const heldBefore = retired.every(ref => ref.deref() !== undefined);
        await turn(); peer.document.publication.evict();
        await turn(); global.gc(); global.gc();
        const heldAfter = retired.every(ref => ref.deref() !== undefined);
        if (held.value.view.root.children[0].content !== retainedText ||
            !Buffer.from(held.native.encodeState()).equals(retainedNative)) throw new Error('Held publication changed');
        held = undefined;
        let released = false;
        for (let i = 0; i < 10; i++) {
          await turn(); global.gc(); global.gc();
          if (retired.every(ref => ref.deref() === undefined)) { released = true; break; }
        }
        results.push({managed, heldBefore, heldAfter, released});
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
    [false, true].map((managed) => ({
      managed,
      heldBefore: true,
      heldAfter: true,
      released: true,
    })),
  );
});
