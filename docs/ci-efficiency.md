# Required yjs CI

The `test` check passes only after static checks, all Node partitions, the browser
suite, and extensive smoke succeed. Static checks, browser tests, and smoke start
independently. Node jobs wait for runtime discovery. A failed or cancelled matrix
member does not cancel its siblings.

This implements the approved [grain/100 proposal](proposals/2026-11-04-ci-efficiency.md).
Repeated comparable CI measurements and owner verification of branch protection
are required before accepting the speedup. The initial local observations below
do not establish that acceptance.

## Commands

Install dependencies with `npm ci` in CI. The managed agent runner uses
`npm install`. Use the lockfile's Yjs 13.6.33. CI uses Node 24; record its exact
patch version from each metrics artifact. Browser tests require Playwright's
Chromium (`./node_modules/.bin/playwright install --with-deps chromium`).

For fast feedback:

```sh
node scripts/ci/run.mjs plan
node scripts/ci/run.mjs ordinary
node scripts/ci/run.mjs static
```

For the complete partitioned gate, use a fresh output directory:

```sh
node scripts/ci/run.mjs plan
node scripts/ci/run.mjs static
node scripts/ci/run.mjs ordinary
node scripts/ci/run.mjs reference
node scripts/ci/run.mjs retention
node scripts/ci/run.mjs matrix-1
node scripts/ci/run.mjs matrix-2
node scripts/ci/run.mjs matrix-3
node scripts/ci/run.mjs matrix-4
node scripts/ci/run.mjs browser
node scripts/ci/run.mjs smoke
CI_NEEDS='{"plan":{"result":"success"},"static":{"result":"success"},"node":{"result":"success"},"browser":{"result":"success"},"smoke":{"result":"success"}}' node scripts/ci/run.mjs aggregate
```

The local `CI_NEEDS` example describes commands already completed successfully;
it does not verify GitHub job outcomes. GitHub supplies actual `needs` results.
The existing unpartitioned `npm run test` remains available. All original build,
lint, boundary, unused-code, formatting, browser, and smoke commands remain in
the required workflow. No global test deadline changed.

## Coverage and failure propagation

| Partition           |                             Coverage at accepted MW-08 merge |
| ------------------- | -----------------------------------------------------------: |
| Ordinary            |            1,426 runnable occurrences and 192 existing skips |
| Reference remainder |                                            44 runnable cases |
| Retention           |  Both old-prefix cases, including the entire 501-group trace |
| Matrix              | All 225 ordered pairs and eight generated/replayed schedules |
| Browser             |          330 runnable cases and two existing benchmark skips |
| Extensive smoke     |                                         8,660 runnable cases |

The patch adds one ordinary reconstruction regression. Runtime discovery builds
the Node plan from the current checkout, so new runnable tests are included.
Ordinary file selection also includes modules with only skipped tests. Vitest's
runtime list omits those modules. The source skip inventory is explicit in
`scripts/ci/source-skips.json`; do not regenerate it to approve new skips silently.

Matrix names are assigned by the first SHA-256 byte modulo four. Each name goes
to one shard. Node files run with at most two fork workers; each reference or
matrix file executes its cases serially. Browser file parallelism stays disabled.
The full 501-group trace remains on one worker.

The aggregate checks the exact job/report inventory, checkout SHA, run ID, attempt,
command success, and executed Node occurrence counts against runtime discovery.
It rejects an assigned test that is skipped, an unexpected passed test, source
skip changes, missing reports, and unsuccessful GitHub dependencies. Occurrence
counts preserve duplicate parameterized names. Names use suite/title components
because Vitest list and JSON `fullName` use different separators.

The aggregate's local controls run in the static job:

```sh
node --test scripts/ci/partitions.test.mjs
```

An attempt identity prevents mixing artifacts after partial job reruns. Rerun the
whole workflow to obtain a coherent plan and reports. The stable aggregate name
is `test`. A repository owner must verify that branch protection requires this
check. The agent's protection API request returned HTTP 403.

## Measurements

Wrap each command to record its revision, command, Node/npm/package versions,
runner image, CPU/RAM/cgroup limits, wall time, child CPU, and memory:

```sh
python3 scripts/ci/measure.py ci-results/full-node.metrics.json npm run test -- --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=ci-results/full-node.vitest.json
```

The output path must not exist. Metrics are written before execution and finalized
after exit. A timeout or termination can leave an unfinished manifest; never count
it as a completed measurement. Concurrent process-tree RSS is sampled every 100ms
and can count shared pages more than once. Child maximum RSS is a different metric;
it is not the concurrent tree peak. CPU includes descendants. Do not sum nested
static-command measurements with their containing static job's CPU or wall time.

Each CI job uploads metrics and complete per-test JSON reports, even on failure.
Installation and Chromium setup have separate manifests. Builds and individual
static commands have separate manifests. Download artifacts from the exact run:

```sh
gh run download RUN_ID --dir evidence/RUN_ID
gh api repos/dstoc/grain/actions/runs/RUN_ID/jobs --paginate > evidence/RUN_ID/jobs.json
```

Use job start/end timestamps to report total runner time and the actual critical
path, including setup and scheduling gaps. Report queue delay separately from
execution. Command metrics alone omit Actions setup/upload overhead. Compare at
least three full repetitions at accepted merge
`0b500005bb26ebdbd0b8b891428ddd2b84bc4f30` and the candidate SHA, with equivalent
runner resources, Node patch version, worker counts, and lockfile. Keep every
repetition; report medians, ranges, CPU, memory, total compute, and critical path.
Alternate baseline/candidate order where possible. Disclose overlap with other
work and instrumented runs rather than treating them as clean baselines.

Initial observations on the local Ryzen 9 5900X runner with Node 26.13.0:

- Accepted matrix: 233 passed, 549.596 seconds in the first full Node run.
- Accepted browser: 330 passed, two skipped, 22.90 seconds with system Chromium.
- Candidate ordinary before the added regression: 1,426 passed, 192 skipped,
  73.17 seconds. Candidate extensive smoke: 8,660 passed, 23.15 seconds.
- An exploratory 64-action CPU profile took 9.494 seconds before and 7.910 seconds
  after the helper changes. These are single instrumented observations with
  overlapping work, not a controlled speedup or the full retention workload.

The profile showed repeated same-tape snapshots in alias reconstruction and
repeated membership/location queries during skeleton sorting. The helper now
shares a tape snapshot only within one materialization and decorates each sort
entry once. It retains the same native lookup and ownership answers. No result
crosses replicas or checkpoint opens. Production certification, reducers,
publication, and native reconstruction are unchanged. The fresh replay still
opens a new replica from canonical bytes and compares complete native bytes,
document observations, and materialized identities.

The four matrix shards are an initial measured experiment, based on the observed
nine-minute matrix file. Queue capacity and the single retention trace can still
dominate the full gate. No numerical full-gate improvement is claimed until the
repeated CI reports are complete. Initial experiment targets are matrix critical
path below 60% of the serial matrix median and retention below 85% of its baseline
median, with total compute reported even if it increases. These are targets, not
test timeouts or merge criteria.

## Long-running check observation

The reported external watcher deadline is 20 minutes. The historical successful
run 41823326357 took 33m59s. No watcher implementation or configuration was found
in this repository, and this patch does not change it.

The Tines supervisor/runner operator must identify that setting. Proposed behavior:
save the PR head SHA, workflow run ID, and job URLs; resume bounded observation of
the same run after a watcher deadline. A queued/in-progress GitHub job remains
pending. A completed unsuccessful job fails. An unreadable API or watcher deadline
is an orchestration result, not a test failure or success. Discard success from a
superseded head. Set an observation budget from measured full-gate duration with
margin, without changing global test timeouts.

If the operator cannot change the watcher, hand off the exact pending SHA/run to
Check and follow it to its terminal conclusion. The unresolved external setting
and branch-protection verification remain rollout limitations.
