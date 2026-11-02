#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = join(repository, 'benchmarks/yjs-m0/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const profiles = ['core', 'editor', 'harness', 'retention'];
const overlays = [
  'benchmarks/yjs-m0',
  'src/markdown/canonical-m0-parity.test.ts',
  'src/markdown/canonical-m0.benchmark.test.ts',
  'src/editing/canonical-m0.browser.test.ts',
  'src/main.yjs-m0.browser.test.ts',
];

const help = `Usage: npm run bench:yjs-m0 -- [options]

Run one Grain/Yjs M0 profile in fresh npm/Vitest processes. The default profile
is core. Use --against with a commit or ref to compare that source tree with
the current workspace. The runner overlays these checked-in benchmark tests on
the reference worktree; it does not change the reference commit.

Options:
  -p, --profile <name>  core, editor, harness, retention, or all (default: core)
  -r, --runs <count>    fresh processes per side (profile default: see manifest)
      --fixture <id>    run one core fixture (for focused checks or ablations)
      --against <ref>   compare the current workspace with this Git ref
  -o, --output <file>   write the JSON report to a new file
      --progress-file <file> append durable retention checkpoints to this JSONL file
      --counters-only   collect core counter samples without rerunning timing distributions
      --force           replace the output file if it already exists
  -h, --help            show this help

Examples:
  npm run bench:yjs-m0 -- --profile core --runs 5 --output benchmarks/yjs-m0/results/core.json
  npm run bench:yjs-m0 -- --profile core --fixture paragraphs-10 --runs 1
  npm run bench:yjs-m0 -- --profile editor --against origin/yjs --runs 5
  npm run bench:yjs-m0 -- --profile retention --runs 1 --output benchmarks/yjs-m0/results/retention-run-1.json
  npm run bench:yjs-m0 -- --profile core --runs 2 --counters-only --output benchmarks/yjs-m0/results/counter-correction.json
`;

function usageError(message) {
  process.stderr.write(`${message}\n\n${help}`);
  process.exitCode = 2;
}

function parseOptions() {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: false,
      strict: true,
      options: {
        profile: { type: 'string', short: 'p', default: 'core' },
        runs: { type: 'string', short: 'r' },
        fixture: { type: 'string' },
        against: { type: 'string' },
        output: { type: 'string', short: 'o' },
        'progress-file': { type: 'string' },
        'counters-only': { type: 'boolean' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
    return values;
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function git(args, cwd = repository) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else rejectPromise(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}

function copyHarness(target) {
  for (const relative of overlays) {
    const source = join(repository, relative);
    const destination = join(target, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true });
  }
}

async function withReferenceWorktree(ref, action) {
  const temporaryParent = mkdtempSync(join(tmpdir(), 'grain-yjs-m0-'));
  const worktree = join(temporaryParent, 'repo');
  let added = false;
  try {
    await git(['worktree', 'add', '--detach', worktree, ref]);
    added = true;
    symlinkSync(join(repository, 'node_modules'), join(worktree, 'node_modules'), 'dir');
    copyHarness(worktree);
    return await action(worktree);
  } finally {
    if (added) {
      try {
        await git(['worktree', 'remove', '--force', worktree]);
      } catch (error) {
        process.stderr.write(`Could not remove temporary worktree: ${String(error)}\n`);
      }
    }
    rmSync(temporaryParent, { recursive: true, force: true });
  }
}

function npmCommand(profile, junitOutputFile) {
  const browser = profile === 'editor' || profile === 'harness';
  const testFile =
    profile === 'core' || profile === 'retention'
      ? 'src/markdown/canonical-m0.benchmark.test.ts'
      : profile === 'editor'
        ? 'src/editing/canonical-m0.browser.test.ts'
        : 'src/main.yjs-m0.browser.test.ts';
  return [
    'run',
    browser ? 'test:browser' : 'test',
    '--',
    testFile,
    ...(browser
      ? ['--reporter=junit', `--outputFile=${junitOutputFile}`]
      : ['--disableConsoleIntercept']),
  ];
}

async function runFreshProcess(
  cwd,
  profile,
  runIndex,
  sideLabel,
  fixture,
  { progressFile, countersOnly = false } = {},
) {
  const started = performance.now();
  const browser = profile === 'editor' || profile === 'harness';
  const junitOutputFile = browser
    ? join(tmpdir(), `grain-yjs-m0-${process.pid}-${profile}-${runIndex}-${Date.now()}.xml`)
    : undefined;
  const args = npmCommand(profile, junitOutputFile);
  process.stderr.write(`[${sideLabel}] ${profile} run ${runIndex + 1}: npm ${args.join(' ')}\n`);
  const childEnvironment = {
    ...process.env,
    YJS_M0_PROFILE: profile,
    YJS_M0_RUN_INDEX: String(runIndex),
    VITE_GRAIN_YJS_M0_PROFILE: profile,
    VITE_GRAIN_YJS_M0_RUN_INDEX: String(runIndex),
    ...(fixture ? { YJS_M0_FIXTURE: fixture } : {}),
    ...(countersOnly ? { YJS_M0_COUNTERS_ONLY: '1' } : {}),
    ...(progressFile
      ? {
          YJS_M0_PROGRESS_FILE: progressFile,
          YJS_M0_PROGRESS_SIDE: sideLabel,
        }
      : {}),
  };
  if (progressFile) {
    appendFileSync(
      progressFile,
      `${JSON.stringify({
        kind: 'process-started',
        at: new Date().toISOString(),
        profile,
        runIndex,
        side: sideLabel,
        sourceCommit: await git(['rev-parse', 'HEAD'], cwd),
        progressFile: relative(repository, progressFile),
        command: `npm ${args.join(' ')}`,
        runnerArguments: process.argv.slice(1),
        node: process.version,
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
        cpuModel: cpus()[0]?.model ?? null,
        logicalCpuCount: cpus().length,
        npmUserAgent: process.env.npm_config_user_agent ?? null,
        fixtureSeed: manifest.baseline.fixtureSeed,
        retainedGroupCounts: manifest.profiles.retention.retainedGroupCounts,
        longTraceActions: manifest.profiles.retention.longTraceActions,
        warmupOperationsPerDistribution:
          manifest.profiles.retention.warmupOperationsPerDistribution,
        measuredOperationsPerDistribution:
          manifest.profiles.retention.measuredOperationsPerDistribution,
      })}\n`,
    );
  }
  const childPromise = new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('npm', args, {
      cwd,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${profile} run failed (${code})\n${stderr}\n${stdout}`));
    });
  });
  let output;
  try {
    output = await childPromise;
  } catch (error) {
    if (progressFile)
      appendFileSync(
        progressFile,
        `${JSON.stringify({
          kind: 'process-failed',
          at: new Date().toISOString(),
          profile,
          runIndex,
          side: sideLabel,
          error: error instanceof Error ? error.message : String(error),
          processElapsedMs: Number((performance.now() - started).toFixed(3)),
        })}\n`,
      );
    throw error;
  }
  let capturedOutput = `${output.stdout}\n${output.stderr}`;
  if (junitOutputFile && existsSync(junitOutputFile)) {
    const xml = readFileSync(junitOutputFile, 'utf8');
    const encodedLogs = [...xml.matchAll(/GRAIN_YJS_M0_REPORT=([^<\r\n]+)/g)].map(
      (match) => match[1],
    );
    const decodedLogs = encodedLogs.map(
      (line) =>
        `GRAIN_YJS_M0_REPORT=${line
          .replaceAll('&quot;', '"')
          .replaceAll('&apos;', "'")
          .replaceAll('&#39;', "'")
          .replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>')
          .replaceAll('&amp;', '&')}`,
    );
    capturedOutput += `\n${decodedLogs.join('\n')}`;
  }
  const reportLines = capturedOutput
    .split(/\r?\n/)
    .filter((line) => line.includes('GRAIN_YJS_M0_REPORT='));
  const reportLine = reportLines.at(-1);
  if (!reportLine)
    throw new Error(`${profile} run did not emit a GRAIN_YJS_M0_REPORT line\n${capturedOutput}`);
  const reportStart = reportLine.indexOf('GRAIN_YJS_M0_REPORT=') + 'GRAIN_YJS_M0_REPORT='.length;
  const report = JSON.parse(reportLine.slice(reportStart));
  if (junitOutputFile) rmSync(junitOutputFile, { force: true });
  const processElapsedMs = Number((performance.now() - started).toFixed(3));
  if (progressFile)
    appendFileSync(
      progressFile,
      `${JSON.stringify({
        kind: 'process-complete',
        at: new Date().toISOString(),
        profile,
        runIndex,
        side: sideLabel,
        processElapsedMs,
        report,
      })}\n`,
    );
  return {
    report,
    processElapsedMs,
  };
}

function flattenDistributions(value, path = [], output = new Map()) {
  if (!value || typeof value !== 'object') return output;
  if (
    !Array.isArray(value) &&
    typeof value.p50Ms === 'number' &&
    typeof value.p95Ms === 'number' &&
    typeof value.sampleCount === 'number'
  ) {
    output.set(path.join('.'), value);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    flattenDistributions(child, [...path, key], output);
  }
  return output;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregateRuns(runs) {
  const perRun = runs.map(({ report }) => flattenDistributions(report));
  const paths = [...new Set(perRun.flatMap((values) => [...values.keys()]))].sort();
  const distributionSummary = paths.map((path) => {
    const samples = perRun.map((values) => values.get(path)).filter(Boolean);
    const p50s = samples.map((sample) => sample.p50Ms);
    const medianP50 = median(p50s);
    const sortedP50s = [...p50s].sort((left, right) => left - right);
    return {
      path,
      processCount: p50s.length,
      medianOfProcessP50Ms: Number(medianP50.toFixed(6)),
      p95OfProcessP50Ms: Number(sortedP50s[Math.ceil(p50s.length * 0.95) - 1].toFixed(6)),
      medianAbsoluteDeviationOfProcessP50Ms: Number(
        median(p50s.map((value) => Math.abs(value - medianP50))).toFixed(6),
      ),
      processP50Ms: p50s,
      processP95Ms: samples.map((sample) => sample.p95Ms),
    };
  });
  return { distributions: distributionSummary };
}

async function runSide(cwd, label, profile, count, fixture, options) {
  const runs = [];
  for (let index = 0; index < count; index++)
    runs.push(await runFreshProcess(cwd, profile, index, label, fixture, options));
  return {
    label,
    head: await git(['rev-parse', 'HEAD'], cwd),
    runs,
    aggregate: aggregateRuns(runs),
  };
}

async function validateYjsVersion(cwd) {
  const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const version = packageJson.dependencies?.yjs;
  if (version !== manifest.baseline.yjsVersion) {
    throw new Error(
      `Expected yjs@${manifest.baseline.yjsVersion} in ${cwd}; found ${String(version)}`,
    );
  }
}

function compareSides(against, candidate) {
  const baseline = new Map(against.aggregate.distributions.map((item) => [item.path, item]));
  return candidate.aggregate.distributions.flatMap((item) => {
    const prior = baseline.get(item.path);
    if (!prior || prior.medianOfProcessP50Ms === 0) return [];
    return [
      {
        path: item.path,
        baselineMedianP50Ms: prior.medianOfProcessP50Ms,
        candidateMedianP50Ms: item.medianOfProcessP50Ms,
        candidateToBaselineRatio: Number(
          (item.medianOfProcessP50Ms / prior.medianOfProcessP50Ms).toFixed(4),
        ),
      },
    ];
  });
}

async function main() {
  const options = parseOptions();
  if (!options) return;
  if (options.help) {
    process.stdout.write(help);
    return;
  }
  if (!['all', ...profiles].includes(options.profile)) {
    usageError(`Unknown profile: ${options.profile}`);
    return;
  }
  if (options.fixture !== undefined) {
    if (options.profile !== 'core') {
      usageError('--fixture is only valid with --profile core');
      return;
    }
    if (!manifest.profiles.core.fixtures.some((fixture) => fixture.id === options.fixture)) {
      usageError(`Unknown core fixture: ${options.fixture}`);
      return;
    }
  }
  if (options['counters-only'] && options.profile !== 'core') {
    usageError('--counters-only is only valid with --profile core');
    return;
  }
  if (options['progress-file'] && !['all', 'retention'].includes(options.profile)) {
    usageError('--progress-file is only valid with --profile retention or --profile all');
    return;
  }
  if (options.force && !options.output && !options['progress-file']) {
    usageError('--force requires --output or --progress-file');
    return;
  }
  const outputPath = options.output ? resolve(repository, options.output) : undefined;
  if (outputPath && existsSync(outputPath) && !options.force)
    throw new Error(`Output already exists: ${outputPath} (use --force to replace it)`);
  const selectedProfiles = options.profile === 'all' ? profiles : [options.profile];
  let progressFile;
  if (selectedProfiles.includes('retention')) {
    progressFile = options['progress-file']
      ? resolve(repository, options['progress-file'])
      : outputPath
        ? `${outputPath}.progress.jsonl`
        : join(
            repository,
            'benchmarks/yjs-m0/results',
            `retention-progress-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.jsonl`,
          );
    if (existsSync(progressFile) && !options.force)
      throw new Error(`Progress file already exists: ${progressFile} (use --force to replace it)`);
    mkdirSync(dirname(progressFile), { recursive: true });
    writeFileSync(progressFile, '', { flag: options.force ? 'w' : 'wx' });
  }
  const runOverrides = new Map();
  if (options.runs !== undefined) {
    const count = Number(options.runs);
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
      usageError('--runs must be an integer from 1 to 100');
      return;
    }
    for (const profile of selectedProfiles) runOverrides.set(profile, count);
  }

  const results = [];
  for (const profile of selectedProfiles) {
    const runs = runOverrides.get(profile) ?? manifest.profiles[profile].defaultFreshProcesses;
    const processOptions = {
      progressFile: profile === 'retention' ? progressFile : undefined,
      countersOnly: Boolean(options['counters-only']),
    };
    await validateYjsVersion(repository);
    if (options.against) {
      const against = await withReferenceWorktree(options.against, async (worktree) => {
        await validateYjsVersion(worktree);
        return runSide(
          worktree,
          `against ${options.against}`,
          profile,
          runs,
          options.fixture,
          processOptions,
        );
      });
      const candidate = await runSide(
        repository,
        'workspace',
        profile,
        runs,
        options.fixture,
        processOptions,
      );
      results.push({ profile, against, candidate, comparisons: compareSides(against, candidate) });
    } else {
      results.push({
        profile,
        fixture: options.fixture,
        candidate: await runSide(
          repository,
          'workspace',
          profile,
          runs,
          options.fixture,
          processOptions,
        ),
      });
    }
  }

  const result = {
    schemaVersion: 1,
    baseline: manifest.baseline,
    createdAt: new Date().toISOString(),
    invocation: {
      nodeExecutable: process.execPath,
      args: process.argv.slice(1),
      selectedProfiles,
      runs: Object.fromEntries(
        selectedProfiles.map((profile) => [
          profile,
          runOverrides.get(profile) ?? manifest.profiles[profile].defaultFreshProcesses,
        ]),
      ),
      against: options.against ?? null,
      fixture: options.fixture ?? null,
      countersOnly: Boolean(options['counters-only']),
      progressFile: progressFile ? relative(repository, progressFile) : null,
    },
    environment: {
      node: process.version,
      npmUserAgent: process.env.npm_config_user_agent ?? null,
      os: platform(),
      osRelease: release(),
      architecture: arch(),
      cpuModel: cpus()[0]?.model ?? null,
      logicalCpuCount: cpus().length,
    },
    profiles: results,
    measurementRules: manifest.measurementRules,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    writeFileSync(outputPath, json, { flag: options.force ? 'w' : 'wx' });
    process.stderr.write(`Saved benchmark report to ${outputPath}\n`);
  } else {
    process.stdout.write(json);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
