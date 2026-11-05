#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const help = `Usage: node benchmarks/multiwriter/run.mjs --output <new-directory> [--size <nodes>] [--runs <count>] [--steps <count>] [--fixtures <completed-run-directory>]

Compare the pinned full-reference source with incremental native materialization
in paired fresh processes. Default: 10/150/1000/5000 paragraphs, 24 literal edits,
three pairs per command/replay workload. Replay uses the exact same captured
original carriers and genesis. Command timing uses the same semantic script.
Raw samples and fixture bytes are retained. Existing output is never replaced.
Run on an otherwise idle host. Ctrl+C stops the run; partial output is incomplete.

Example: node benchmarks/multiwriter/run.mjs --output /tmp/mw13-measurement --size 150
`;
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let values, sourceReport;
try {
  ({ values } = parseArgs({
    options: {
      output: { type: 'string' },
      fixtures: { type: 'string' },
      size: { type: 'string' },
      runs: { type: 'string' },
      steps: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
  if (values.help) {
    process.stdout.write(help);
    process.exit(0);
  }
  if (!values.output) throw new Error('--output is required');
  for (const name of ['size', 'runs', 'steps'])
    if (
      values[name] !== undefined &&
      (!/^[1-9][0-9]*$/.test(values[name]) || !Number.isSafeInteger(Number(values[name])))
    )
      throw new Error(`--${name} must be a positive safe integer`);
  if (values.fixtures) {
    sourceReport = JSON.parse(readFileSync(join(resolve(values.fixtures), 'report.json'), 'utf8'));
    if (!sourceReport.complete) throw new Error('Input fixture run is incomplete');
    if (sourceReport.baseline !== manifest.baseline)
      throw new Error('Input fixture baseline differs from the pinned reference');
    if (values.steps && Number(values.steps) !== sourceReport.steps)
      throw new Error('--steps differs from the retained fixture schedule');
  }
} catch (error) {
  process.stderr.write(`${error.message}\n${help}`);
  process.exit(2);
}
const runs = Number(values.runs ?? manifest.runs),
  steps = Number(values.steps ?? sourceReport?.steps ?? manifest.steps);
const warmup = Math.min(manifest.warmup, steps - 1);
const sizes = values.size ? [Number(values.size)] : manifest.sizes;
const output = resolve(values.output);
mkdirSync(output); // fail before running anything when the destination already exists
const temporary = mkdtempSync(join(tmpdir(), 'grain-mw13-'));
const baseline = join(temporary, 'baseline');
const samples = [];
const metadata = {
  manifest,
  sizes,
  runs,
  steps,
  warmup,
  baseline: git(['rev-parse', manifest.baseline]),
  candidate: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--porcelain']),
  runtime: process.version,
  yjs: JSON.parse(readFileSync(join(root, 'node_modules/yjs/package.json'), 'utf8')).version,
  host: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
  },
  scope: manifest.scope,
  sourceFixtureReport: sourceReport
    ? { baseline: sourceReport.baseline, candidate: sourceReport.candidate }
    : null,
  complete: false,
};
if (metadata.yjs !== manifest.yjs) throw new Error('Installed Yjs differs from the pinned version');
writeFileSync(join(output, 'report.json'), JSON.stringify(metadata, null, 2));
let worktree = false;
function worker(cwd, args) {
  const stdout = execFileSync(
    process.execPath,
    [
      '--expose-gc',
      '--import',
      './benchmarks/multiwriter/resolve-ts.mjs',
      'benchmarks/multiwriter/worker.mjs',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  return JSON.parse(stdout);
}
try {
  git(['worktree', 'add', '--detach', baseline, manifest.baseline]);
  worktree = true;
  symlinkSync(join(root, 'node_modules'), join(baseline, 'node_modules'), 'dir');
  cpSync(join(root, 'benchmarks/multiwriter'), join(baseline, 'benchmarks/multiwriter'), {
    recursive: true,
  });
  // The historical editor has no capacity option. Change ONLY its local native
  // decode capacity, matching the candidate's explicit 10M-operation option.
  const editorPath = join(baseline, 'src/markdown/multiwriter/authoring/editor.ts');
  const editor = readFileSync(editorPath, 'utf8');
  if ((editor.match(/new NativeTapeCache\(\)/g) ?? []).length !== 2)
    throw new Error('Historical editor capacity overlay no longer matches');
  writeFileSync(
    editorPath,
    editor.replaceAll('new NativeTapeCache()', 'new NativeTapeCache(10_000_000)'),
  );
  metadata.baselineCapacityOverlay = git(
    ['diff', '--', 'src/markdown/multiwriter/authoring/editor.ts'],
    baseline,
  );
  writeFileSync(join(output, 'report.json'), JSON.stringify(metadata, null, 2));
  for (const size of sizes) {
    const fixture = join(output, `fixture-${size}.bin`);
    if (sourceReport) {
      const source = join(resolve(values.fixtures), `fixture-${size}.bin`);
      const description = join(resolve(values.fixtures), `fixture-${size}.json`);
      const captured = JSON.parse(readFileSync(description, 'utf8'));
      const bytes = readFileSync(source);
      if (
        captured.size !== size ||
        captured.steps !== steps ||
        captured.sha256 !== createHash('sha256').update(bytes).digest('hex')
      )
        throw new Error('Retained fixture identity or schedule differs');
      cpSync(source, fixture, { errorOnExist: true, force: false });
      cpSync(description, join(output, `fixture-${size}.json`), {
        errorOnExist: true,
        force: false,
      });
    } else {
      const capture = worker(baseline, [
        '--mode',
        'capture',
        '--size',
        String(size),
        '--steps',
        String(steps),
        '--fixture',
        fixture,
      ]);
      writeFileSync(join(output, `fixture-${size}.json`), JSON.stringify(capture, null, 2));
    }
    for (const mode of ['replay', 'command'])
      for (let pair = 0; pair < runs; pair++) {
        for (const implementation of pair % 2
          ? ['materialized', 'reference']
          : ['reference', 'materialized']) {
          process.stderr.write(
            `${size} paragraphs, ${mode}, pair ${pair + 1}/${runs}, ${implementation}\n`,
          );
          const sample = {
            pair,
            ...worker(implementation === 'reference' ? baseline : root, [
              '--mode',
              mode,
              '--implementation',
              implementation,
              '--fixture',
              fixture,
              '--warmup',
              String(warmup),
            ]),
          };
          samples.push(sample);
          writeFileSync(
            join(output, `${size}-${mode}-${pair}-${implementation}.json`),
            JSON.stringify(sample, null, 2),
          );
        }
      }
  }
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify({ ...metadata, complete: true, samples }, null, 2),
  );
  process.stdout.write(`${join(output, 'report.json')}\n`);
} finally {
  if (worktree) git(['worktree', 'remove', '--force', baseline]);
  rmSync(temporary, { recursive: true, force: true });
}
