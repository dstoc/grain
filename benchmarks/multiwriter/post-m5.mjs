#!/usr/bin/env node
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
import { tmpdir, cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const help = `Usage: node benchmarks/multiwriter/post-m5.mjs --fixtures <completed-run-directory> --output <new-directory> [--size <paragraphs>] [--runs <pairs>]

Compare the exact pinned schema-2 post-M5 writer with the current native-stage
writer using the existing fixture's literal command script. Default: 150
paragraphs, three alternating fresh-process pairs. Final Markdown must match.
This is a semantic workload comparison across different models, not carrier
replay or an offline-convergence test. Output is never overwritten.
`;
let values;
try {
  ({ values } = parseArgs({
    options: {
      fixtures: { type: 'string' },
      output: { type: 'string' },
      size: { type: 'string', default: '150' },
      runs: { type: 'string', default: '3' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
  if (values.help) {
    process.stdout.write(help);
    process.exit(0);
  }
  if (!values.fixtures || !values.output) throw new Error('--fixtures and --output are required');
  for (const n of ['size', 'runs'])
    if (!/^[1-9][0-9]*$/.test(values[n]) || !Number.isSafeInteger(Number(values[n])))
      throw new Error(`--${n} must be a positive safe integer`);
} catch (e) {
  process.stderr.write(`${e.message}\n${help}`);
  process.exit(2);
}
const fixture = join(resolve(values.fixtures), `fixture-${values.size}.bin`);
const sourceReport = JSON.parse(
  readFileSync(join(resolve(values.fixtures), 'report.json'), 'utf8'),
);
if (!sourceReport.complete) throw new Error('Input fixture run is incomplete');
readFileSync(fixture);
const output = resolve(values.output);
mkdirSync(output);
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const temporary = mkdtempSync(join(tmpdir(), 'grain-mw13-postm5-')),
  baseline = join(temporary, 'baseline');
const metadata = {
  baseline: git(['rev-parse', manifest.postM5]),
  candidate: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--porcelain']),
  runtime: process.version,
  yjs: JSON.parse(readFileSync(join(root, 'node_modules/yjs/package.json'), 'utf8')).version,
  host: { cpu: cpus()[0].model, platform: platform(), release: release() },
  size: Number(values.size),
  runs: Number(values.runs),
  sourceFixtureReport: { baseline: sourceReport.baseline, candidate: sourceReport.candidate },
  models: {
    baseline: 'schema-2 authority and native undo',
    candidate: 'schema-3 independent action envelopes with full reference semantic fallback',
  },
  complete: false,
};
if (metadata.yjs !== manifest.yjs) throw new Error('Yjs differs from the pinned version');
writeFileSync(join(output, 'report.json'), JSON.stringify(metadata, null, 2));
const samples = [];
let added = false;
try {
  git(['worktree', 'add', '--detach', baseline, manifest.postM5]);
  added = true;
  symlinkSync(join(root, 'node_modules'), join(baseline, 'node_modules'), 'dir');
  cpSync(join(root, 'benchmarks/multiwriter'), join(baseline, 'benchmarks/multiwriter'), {
    recursive: true,
  });
  for (let pair = 0; pair < Number(values.runs); pair++)
    for (const implementation of pair % 2
      ? ['materialized', 'schema2-postM5']
      : ['schema2-postM5', 'materialized']) {
      process.stderr.write(
        `post-M5 comparison, ${values.size} paragraphs, pair ${pair + 1}/${values.runs}, ${implementation}\n`,
      );
      const schema2 = implementation === 'schema2-postM5';
      const args = [
        '--expose-gc',
        '--import',
        './benchmarks/multiwriter/resolve-ts.mjs',
        `benchmarks/multiwriter/${schema2 ? 'post-m5-worker' : 'worker'}.mjs`,
        '--fixture',
        fixture,
        '--warmup',
        String(sourceReport.warmup),
      ];
      if (!schema2) args.push('--mode', 'command', '--implementation', 'materialized');
      const raw = execFileSync(process.execPath, args, {
        cwd: schema2 ? baseline : root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const sample = { pair, ...JSON.parse(raw) };
      samples.push(sample);
      writeFileSync(
        join(output, `${pair}-${implementation}.json`),
        JSON.stringify(sample, null, 2),
      );
    }
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify({ ...metadata, complete: true, samples }, null, 2),
  );
  process.stdout.write(`${join(output, 'report.json')}\n`);
} finally {
  if (added) git(['worktree', 'remove', '--force', baseline]);
  rmSync(temporary, { recursive: true, force: true });
}
