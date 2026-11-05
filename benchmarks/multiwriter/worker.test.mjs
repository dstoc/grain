import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
