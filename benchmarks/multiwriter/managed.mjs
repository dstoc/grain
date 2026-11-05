#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { deserialize } from 'node:v8';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const help = `Usage: node benchmarks/multiwriter/managed.mjs --fixture <original.bin> --output <new-directory> [--runs <pairs>]

Compare real MW-10 edit/Undo/Redo through current-source reference and materialized
readers in alternating fresh processes. Uses the existing exact genesis/literal
schedule; command writers have fresh identities. Reports serialized history
metadata separately from whole-replica heap. No journal/consolidation measurement.
This is a short managed literal workload, not a mixed 10,000-action gate.
Run on an otherwise idle host. Existing output is never replaced.
`;
let values;
try {
  ({ values } = parseArgs({
    options: {
      fixture: { type: 'string' },
      output: { type: 'string' },
      runs: { type: 'string', default: '3' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
  if (values.help) {
    process.stdout.write(help);
    process.exit(0);
  }
  if (!values.fixture || !values.output) throw new Error('--fixture and --output are required');
  if (!/^[1-9][0-9]*$/.test(values.runs) || !Number.isSafeInteger(Number(values.runs)))
    throw new Error('--runs must be a positive safe integer');
} catch (error) {
  process.stderr.write(`${error.message}\n${help}`);
  process.exit(2);
}
const original = resolve(values.fixture),
  output = resolve(values.output);
const input = deserialize(readFileSync(original));
if (!Array.isArray(input.schedule) || !input.schedule.length)
  throw new Error('Fixture must contain a nonempty command schedule');
const warmup = Math.min(4, input.schedule.length - 1);
mkdirSync(output);
const fixture = join(output, 'fixture.bin');
cpSync(original, fixture, { errorOnExist: true, force: false });
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const metadata = {
  source: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--porcelain']),
  reference: 'current-source full reference with accepted MW-10; not pinned pre-MW-10 baseline',
  runtime: process.version,
  yjs: JSON.parse(readFileSync(join(root, 'node_modules/yjs/package.json'))).version,
  host: { cpu: cpus()[0].model, platform: platform(), release: release() },
  scope:
    'same literal schedule/common genesis; real managed selection/edit/Undo/Redo; serialized navigation, whole-replica GC heap; no cache-only heap/journal/10k acceptance',
  runs: Number(values.runs),
  warmup,
  complete: false,
};
if (metadata.yjs !== '13.6.33') throw new Error('Yjs differs from the pinned version');
const samples = [];
const save = () =>
  writeFileSync(join(output, 'report.json'), JSON.stringify({ ...metadata, samples }, null, 2));
save();
for (let pair = 0; pair < Number(values.runs); pair++)
  for (const implementation of pair % 2
    ? ['materialized', 'reference']
    : ['reference', 'materialized']) {
    process.stderr.write(`managed pair ${pair + 1}/${values.runs}: ${implementation}\n`);
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--expose-gc',
          '--import',
          './benchmarks/multiwriter/resolve-ts.mjs',
          'benchmarks/multiwriter/worker.mjs',
          '--mode',
          'command',
          '--managed',
          '--implementation',
          implementation,
          '--fixture',
          fixture,
          '--warmup',
          String(warmup),
        ],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          maxBuffer: 16 * 1024 * 1024,
        },
      ),
    );
    if (!result.verified || result.historyMode !== 'managed')
      throw new Error('Managed worker did not verify');
    samples.push({ pair, ...result });
    writeFileSync(join(output, `${pair}-${implementation}.json`), JSON.stringify(result, null, 2));
    save();
  }
metadata.complete = true;
save();
process.stdout.write(JSON.stringify({ output, complete: true, samples: samples.length }) + '\n');
