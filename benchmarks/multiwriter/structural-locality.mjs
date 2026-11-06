#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
const root = fileURLToPath(new URL('../../', import.meta.url));
const help =
  'Usage: node benchmarks/multiwriter/structural-locality.mjs --output <new-directory> [--inputs <fixture-directory>] [--case root|tasks|100|1000|all]\n\nShort managed structural diagnostics. Each child is capped at five minutes.\nRetained prefixes are restored diagnostic inputs, not uninterrupted results.\n';
let values;
try {
  ({ values } = parseArgs({
    options: {
      output: { type: 'string' },
      inputs: { type: 'string' },
      case: { type: 'string', default: 'all' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
  if (values.help) {
    process.stdout.write(help);
    process.exit(0);
  }
  if (!values.output) throw new Error('--output is required');
  if (!['all', 'root', 'tasks', '100', '1000'].includes(values.case))
    throw new Error('invalid --case');
} catch (error) {
  process.stderr.write(error.message + '\n' + help);
  process.exit(2);
}
const output = resolve(values.output),
  inputs = resolve(values.inputs ?? join(root, 'test/multiwriter/fixtures/structural-locality'));
const provenance = JSON.parse(
  readFileSync(join(root, 'test/multiwriter/fixtures/structural-locality/provenance.json')),
);
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cases = [
  ['root', 'fixture-150.bin'],
  ['tasks', 'fixture-150-tasks.bin'],
  ['100', 'prefix-100.bin'],
  ['1000', 'prefix-1000.bin'],
].filter(([name]) => values.case === 'all' || values.case === name);
// Validate all selected inputs before starting any work.
const files = cases.map(([name, file]) => {
  const entry = provenance.files.find((e) => e.path.endsWith('/' + file));
  const path = join(inputs, file);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    bytes = readFileSync(join(inputs, entry.path));
  }
  if (hash(bytes) !== entry.sha256) throw new Error(`Input hash differs: ${file}`);
  return { name, file, bytes, entry };
});
mkdirSync(output);
mkdirSync(join(output, 'inputs'));
mkdirSync(join(output, 'logs'));
const manifest = {
  complete: false,
  source: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--porcelain']),
  diffSha256: hash(execFileSync('git', ['diff', 'HEAD'], { cwd: root })),
  integrationHead: git(['rev-parse', 'origin/feat/94-incremental-materialization']),
  combinedEvidenceHead: 'f461f2f4588675a2688e96f813e4f1284eb8ff71',
  runtime: process.version,
  yjs: JSON.parse(readFileSync(join(root, 'node_modules/yjs/package.json'))).version,
  cpu: cpus()[0].model,
  scope:
    'MW-13A restored prefixes; independent oracle checks outside command timers; no storage journal or uninterrupted scale claim',
  inputs: files.map((f) => f.entry),
  samples: [],
};
if (manifest.yjs !== '13.6.33') throw new Error('Yjs pin differs');
const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(manifest, null, 2));
save();
function child(label, args) {
  process.stderr.write(label + '\n');
  const start = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync(
    join(output, 'logs', label + '.log'),
    (result.stdout ?? '') + (result.stderr ?? ''),
  );
  if (result.error || result.status !== 0) {
    manifest.complete = false;
    manifest.failure = {
      label,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
    };
    save();
    throw new Error(`${label} incomplete: ${result.error?.message ?? result.status}; see logs`);
  }
  return performance.now() - start;
}
child('classification', [
  '--import',
  './benchmarks/multiwriter/resolve-ts.mjs',
  'benchmarks/multiwriter/structural-classification.mjs',
  output,
]);
child('differential-tests', [
  './node_modules/vite-plus/bin/vp',
  'test',
  'run',
  '--project',
  'node',
  'src/markdown/multiwriter/materialization/structural-refinement.test.ts',
  '--maxWorkers=4',
]);

for (const { name, file, bytes } of files) {
  const path = join(output, 'inputs', file);
  writeFileSync(path, bytes, { flag: 'wx' });
  for (const deleted of [false, true])
    for (const instrumented of [false, true]) {
      const label = `${name}-${deleted ? 'deleted' : 'plain'}-${instrumented ? 'attribution' : 'wall'}`;
      const args = [
        '--import',
        './benchmarks/multiwriter/resolve-ts.mjs',
        'benchmarks/multiwriter/structural-locality-worker.mjs',
        '--fixture',
        path,
        '--output',
        join(output, label),
        ...(deleted ? ['--deleted'] : []),
        ...(instrumented ? ['--instrumented'] : []),
      ];
      const workerWallMs = child(label, args);
      manifest.samples.push({ label, workerWallMs, report: label + '.json' });
      save();
    }
}
manifest.coldSamples = [];
for (const sample of manifest.samples.filter((s) => s.label.endsWith('-attribution'))) {
  const label = 'cold-' + sample.label;
  const workerWallMs = child(label, [
    '--import',
    './benchmarks/multiwriter/resolve-ts.mjs',
    'benchmarks/multiwriter/structural-cold-worker.mjs',
    '--fixture',
    join(output, sample.label + '.bin'),
    '--output',
    join(output, label),
  ]);
  manifest.coldSamples.push({ label, workerWallMs, report: label + '.json' });
  save();
}
manifest.complete = true;
save();
copyFileSync(
  join(root, 'test/multiwriter/fixtures/structural-locality/provenance.json'),
  join(output, 'input-provenance.json'),
);
process.stdout.write(join(output, 'report.json') + '\n');
