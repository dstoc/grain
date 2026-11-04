import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  requiredJobs,
  workflowJobs,
  makePlan,
  validateGate,
  escapePattern,
} from './partitions.mjs';

const identity = { sha: 'current-sha', run: '123', attempt: '2' };
const ordinary = { file: `${process.cwd()}/src/a.test.ts`, name: 'same parameterized name' };
const tests = [
  ordinary,
  ordinary,
  {
    file: `${process.cwd()}/src/reference.test.ts`,
    name: 'independent reference: history-limit-retains-canonical-facts',
  },
  {
    file: `${process.cwd()}/src/reference.test.ts`,
    name: 'independent reference: old-prefix-after-lossless-maintenance',
  },
  { file: `${process.cwd()}/src/reference.test.ts`, name: 'independent reference: small' },
  ...Array.from({ length: 40 }, (_, n) => ({
    file: `${process.cwd()}/src/reference-matrix.test.ts`,
    name: `case ${n}`,
  })),
];
function fixture() {
  const plan = makePlan(tests, identity);
  const needs = Object.fromEntries(workflowJobs.map((id) => [id, { result: 'success' }]));
  const reports = requiredJobs.map((id) => ({
    id,
    identity,
    exitCode: 0,
    inventory: [{ file: 'src/phase.test.ts', name: 'phase' }],
    vitest: {
      success: true,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      testResults: (plan.jobs[id] ?? [{ file: 'src/phase.test.ts', name: 'phase' }]).map(
        (test) => ({
          name: `${process.cwd()}/${test.file}`,
          status: 'passed',
          assertionResults: [{ ancestorTitles: [], title: test.name, status: 'passed' }],
        }),
      ),
    },
  }));
  return { plan, needs, reports };
}
const verify = ({ plan, needs, reports }) =>
  validateGate(plan, reports, needs, identity, { node: [], browser: [] });
test('complete coverage passes with duplicate names preserved', () => verify(fixture()));
for (const outcome of ['failure', 'cancelled', 'skipped', 'timed_out', undefined])
  test(`rejects job outcome ${outcome}`, () => {
    const value = fixture();
    value.needs.node.result = outcome;
    assert.throws(() => verify(value), /did not succeed/);
  });
for (const [label, mutate] of [
  ['missing shard', (v) => v.reports.pop()],
  ['duplicate shard', (v) => v.reports.push(v.reports[0])],
  ['missing dependency', (v) => delete v.needs.node],
  [
    'wrong SHA',
    (v) => {
      v.reports[0].identity = { ...identity, sha: 'old' };
    },
  ],
  [
    'old run',
    (v) => {
      v.reports[0].identity = { ...identity, run: '122' };
    },
  ],
  [
    'old attempt',
    (v) => {
      v.reports[0].identity = { ...identity, attempt: '1' };
    },
  ],
  [
    'stale plan',
    (v) => {
      v.plan.identity = { ...identity, sha: 'old' };
    },
  ],
  [
    'failed command',
    (v) => {
      v.reports[0].exitCode = 1;
    },
  ],
  [
    'malformed report',
    (v) => {
      v.reports.find((r) => r.id === 'retention').vitest = {};
    },
  ],
  [
    'empty report',
    (v) => {
      v.reports.find((r) => r.id === 'retention').vitest.testResults = [];
    },
  ],
  [
    'failed test',
    (v) => {
      v.reports.find((r) => r.id === 'retention').vitest.numFailedTests = 1;
    },
  ],
  [
    'skipped assigned test',
    (v) => {
      v.reports.find((r) => r.id === 'retention').vitest.testResults[0].assertionResults[0].status =
        'pending';
    },
  ],
  [
    'lost duplicate occurrence',
    (v) => {
      v.reports.find((r) => r.id === 'ordinary').vitest.testResults.pop();
    },
  ],
  [
    'new skip',
    (v) => {
      v.reports
        .find((r) => r.id === 'ordinary')
        .vitest.testResults.push({
          name: `${process.cwd()}/src/a.test.ts`,
          assertionResults: [{ ancestorTitles: [], title: 'new skip', status: 'pending' }],
        });
    },
  ],
  [
    'missing browser case',
    (v) => {
      v.reports.find((r) => r.id === 'browser').vitest.testResults = [];
    },
  ],
  [
    'missing smoke case',
    (v) => {
      v.reports
        .find((r) => r.id === 'smoke')
        .inventory.push({ file: 'src/phase.test.ts', name: 'omitted' });
    },
  ],
])
  test(`rejects ${label}`, () => {
    const value = fixture();
    mutate(value);
    assert.throws(() => verify(value));
  });
test('exact name patterns escape Markdown and regexp punctuation', () => {
  const value = 'independent matrix: [] / a+b (x) .* \\';
  const pattern = new RegExp(`^${escapePattern(value)}$`);
  assert(pattern.test(value));
  assert(!pattern.test(value + 'suffix'));
});

test('a failed CLI retry removes its previous success report', () => {
  const output = mkdtempSync(join(tmpdir(), 'grain-ci-retry-'));
  try {
    const receipt = join(output, 'ordinary.json');
    writeFileSync(receipt, JSON.stringify({ id: 'ordinary', exitCode: 0 }));
    // No plan exists. The retry must fail before invoking Vitest.
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./run.mjs', import.meta.url)),
      'ordinary',
      '--output',
      output,
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(receipt), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
