import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';

export const retention =
  /^independent reference: (history-limit-retains-canonical-facts|old-prefix-after-lossless-maintenance)$/;
export const nodeJobs = [
  'ordinary',
  'reference',
  'retention',
  'matrix-1',
  'matrix-2',
  'matrix-3',
  'matrix-4',
];
export const phaseJobs = ['static', 'browser', 'smoke'];
export const requiredJobs = [...phaseJobs, ...nodeJobs];
export const workflowJobs = ['plan', 'static', 'node', 'browser', 'smoke'];
export const fileName = (file) => relative(process.cwd(), file).replaceAll('\\', '/');
export const testKey = (test) => JSON.stringify([test.file, test.name]);
export const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function partition(test) {
  if (test.file.endsWith('/reference-matrix.test.ts')) {
    return `matrix-${(createHash('sha256').update(test.name).digest()[0] % 4) + 1}`;
  }
  if (test.file.endsWith('/reference.test.ts'))
    return retention.test(test.name) ? 'retention' : 'reference';
  return 'ordinary';
}

export function counts(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

export function equalInventory(actual, expected, message) {
  assert.deepEqual(counts(actual.map(testKey)), counts(expected.map(testKey)), message);
}

export function makePlan(tests, identity) {
  assert(tests.length > 0, 'Empty runtime inventory');
  const normalized = tests.map((test) => ({ file: fileName(test.file), name: test.name }));
  const jobs = Object.fromEntries(
    nodeJobs.map((id) => [id, normalized.filter((test) => partition(test) === id)]),
  );
  for (const [id, assigned] of Object.entries(jobs))
    assert(assigned.length, `Empty partition ${id}`);
  equalInventory(Object.values(jobs).flat(), normalized, 'Partition occurrence coverage');
  return { identity, tests: normalized, jobs };
}

export function reportTests(report) {
  assert.equal(report.success, true, 'Vitest report failed');
  assert.equal(report.numFailedTests, 0, 'Failed tests');
  assert.equal(report.numFailedTestSuites, 0, 'Failed suites');
  return report.testResults.flatMap((suite) => {
    assert.notEqual(suite.status, 'failed', `Failed module ${suite.name}`);
    return suite.assertionResults.map((test) => ({
      file: fileName(suite.name),
      // Vitest list joins suite names with ' > '; JSON fullName uses spaces.
      // Keep the components so literal punctuation in a title is not rewritten.
      name: [...test.ancestorTitles, test.title].join(' > '),
      status: test.status,
      duration: test.duration,
    }));
  });
}

export function validateNodeReport(plan, id, report, allowedSkips) {
  const assigned = plan.jobs[id];
  assert(assigned?.length, `Unknown partition ${id}`);
  const assignedKeys = new Set(assigned.map(testKey));
  const allKeys = new Set(plan.tests.map(testKey));
  const rows = reportTests(report);
  const executed = rows.filter((test) => test.status === 'passed');
  equalInventory(executed, assigned, `${id}: executed occurrence coverage`);
  const skipped = [];
  for (const test of rows) {
    if (test.status === 'passed') continue;
    assert(
      ['pending', 'todo', 'skipped'].includes(test.status),
      `Unexpected status ${test.status}`,
    );
    assert(!assignedKeys.has(testKey(test)), `Assigned test did not run: ${test.name}`);
    if (allKeys.has(testKey(test))) {
      assert.notEqual(partition(test), id, 'Filtered assigned test');
    } else skipped.push(test);
  }
  equalInventory(skipped, id === 'ordinary' ? allowedSkips : [], `${id}: source skip inventory`);
  return executed;
}

export function validateGate(plan, reports, needs, identity, allowedSkips) {
  assert.deepEqual(plan.identity, identity, 'Stale plan identity');
  assert.deepEqual(Object.keys(needs).sort(), [...workflowJobs].sort(), 'Required job inventory');
  for (const [id, value] of Object.entries(needs))
    assert.equal(value.result, 'success', `${id} did not succeed`);
  assert.deepEqual(
    reports.map((report) => report.id).sort(),
    [...requiredJobs].sort(),
    'Missing or duplicate shard',
  );
  const executed = [];
  for (const report of reports) {
    assert.deepEqual(report.identity, identity, `Stale report ${report.id}`);
    assert.equal(report.exitCode, 0, `${report.id} command failed`);
    if (nodeJobs.includes(report.id))
      executed.push(...validateNodeReport(plan, report.id, report.vitest, allowedSkips.node));
    else if (report.id !== 'static') {
      const rows = reportTests(report.vitest);
      assert(
        rows.some((test) => test.status === 'passed'),
        `${report.id}: empty report`,
      );
      const skipped = rows.filter((test) => test.status !== 'passed');
      assert(
        skipped.every((test) => ['pending', 'todo', 'skipped'].includes(test.status)),
        'Invalid skipped status',
      );
      equalInventory(skipped, allowedSkips[report.id] ?? [], `${report.id}: source skip inventory`);
    }
  }
  equalInventory(executed, plan.tests, 'Complete runtime Node coverage');
}
