import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
