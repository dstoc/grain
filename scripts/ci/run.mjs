import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  escapePattern,
  fileName,
  makePlan,
  nodeJobs,
  requiredJobs,
  validateGate,
} from './partitions.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: 'string', default: 'ci-results' }, help: { type: 'boolean' } },
});
if (values.help) {
  console.log(
    'Usage: node scripts/ci/run.mjs plan|aggregate|<job> [--output ci-results]\nJobs: ' +
      requiredJobs.join(', '),
  );
  process.exit(0);
}
assert.equal(positionals.length, 1, 'Supply exactly one job');
const [id] = positionals;
assert(['plan', 'aggregate', ...requiredJobs].includes(id), `Unknown job ${id}`);
mkdirSync(values.output, { recursive: true });
const path = (name) => resolve(values.output, name);
const read = (name) => JSON.parse(readFileSync(path(name), 'utf8'));
const write = (name, value) => writeFileSync(path(name), JSON.stringify(value, null, 2) + '\n');
const identity = {
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  run: process.env.GITHUB_RUN_ID ?? 'local',
  attempt: process.env.GITHUB_RUN_ATTEMPT ?? 'local',
};
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const vp = resolve('node_modules/.bin/vp');
if (id === 'plan') {
  rmSync(path('plan.json'), { force: true });
  run(vp, [
    'test',
    'list',
    '--project',
    'node',
    '--staticParse=false',
    '--maxWorkers=1',
    '--json',
    path('runtime.json'),
  ]);
  const plan = makePlan(read('runtime.json'), identity);
  // Include modules whose every test is skipped: runtime list omits them.
  plan.ordinaryFiles = readdirSync('src', { recursive: true })
    .filter(
      (file) =>
        file.endsWith('.test.ts') &&
        !file.endsWith('.browser.test.ts') &&
        !/(^|\/)reference(-matrix)?\.test\.ts$/.test(file),
    )
    .map((file) => `src/${file}`)
    .sort();
  write('plan.json', plan);
} else if (id === 'aggregate') {
  const needs = JSON.parse(process.env.CI_NEEDS ?? '{}');
  const reports = requiredJobs.map((job) => read(`${job}.json`));
  const skips = JSON.parse(readFileSync(new URL('./source-skips.json', import.meta.url), 'utf8'));
  validateGate(read('plan.json'), reports, needs, identity, skips);
  console.log('All required jobs and Node test occurrences passed at', identity.sha);
} else {
  // A failed local retry must not leave an earlier success receipt behind.
  rmSync(path(`${id}.json`), { force: true });
  const vitestPath = path(`${id}.vitest.json`);
  const reporter = ['--reporter=default', '--reporter=json', `--outputFile.json=${vitestPath}`];
  let inventory;
  if (id === 'browser' || id === 'smoke') {
    const project = id === 'browser' ? 'browser' : 'node';
    const files = id === 'smoke' ? ['src/markdown/block-parser.permutations.test.ts'] : [];
    const env =
      id === 'smoke' ? { ...process.env, MARKDOWN_EXTENSIVE_SMOKE_TESTS: '1' } : process.env;
    run(
      vp,
      [
        'test',
        'list',
        '--project',
        project,
        ...files,
        '--staticParse=false',
        '--maxWorkers=1',
        '--json',
        path(`${id}.runtime.json`),
      ],
      env,
    );
    inventory = read(`${id}.runtime.json`).map((test) => ({
      file: fileName(test.file),
      name: test.name,
    }));
    assert(inventory.length, `Empty runtime inventory for ${id}`);
  }
  if (nodeJobs.includes(id)) {
    const plan = read('plan.json');
    assert.deepEqual(plan.identity, identity, 'Plan is from another run, attempt or revision');
    const assigned = plan.jobs[id];
    assert(assigned?.length, `Empty job ${id}`);
    const files =
      id === 'ordinary' ? plan.ordinaryFiles : [...new Set(assigned.map((test) => test.file))];
    const pattern =
      id === 'ordinary'
        ? []
        : [
            '--testNamePattern',
            `^(?:${[...new Set(assigned.map((test) => test.name))].map(escapePattern).join('|')})$`,
          ];
    run(vp, [
      'test',
      'run',
      '--project',
      'node',
      ...files,
      '--maxWorkers=2',
      ...pattern,
      ...reporter,
    ]);
  } else if (id === 'static') {
    run(process.execPath, ['--test', 'scripts/ci/partitions.test.mjs']);
    for (const script of [
      'build',
      'build:web',
      'lint',
      'check:boundaries',
      'analyze:unused',
      'analyze:unused:production',
      'format:check',
    ])
      run('python3', [
        'scripts/ci/measure.py',
        path(`static-${script.replaceAll(':', '-')}.metrics.json`),
        'npm',
        'run',
        script,
      ]);
  } else if (id === 'browser') {
    run('npm', ['run', 'test:browser', '--', ...reporter]);
  } else if (id === 'smoke') {
    run('npm', ['run', 'test:extensive-smoke', '--', '--maxWorkers=2', ...reporter]);
  }
  write(`${id}.json`, {
    id,
    identity,
    exitCode: 0,
    ...(inventory ? { inventory } : {}),
    ...(id === 'static' ? {} : { vitest: JSON.parse(readFileSync(vitestPath, 'utf8')) }),
  });
}
