# Proposal: Measure and shorten the required yjs CI gate

**Status:** Proposed for grain/100. No implementation or speedup is claimed.

**Baseline:** Accepted MW-08 merge `0b500005bb26ebdbd0b8b891428ddd2b84bc4f30`
on `yjs`. Branch and eventual implementation PR target: `yjs`. Yjs stays pinned
to 13.6.33. Grain/89 is Done. This proposal requires approval before implementation.

## Motivation

A small change should receive build and lint results without waiting for the
501-group reference retention trace. Both results must still be required before
merge. The retention trace must keep all groups, old-prefix edits, maintenance,
checkpoint reconstruction and assertions.

The current `.github/workflows/ci.yml` puts installation, Chromium installation,
builds, static checks, Node tests, browser tests and extensive smoke into one
sequential `test` job on `ubuntu-latest`, with Node 24. Node discovery in
`vitest.config.ts` includes `src/**/*.test.ts` except browser tests. Thus the
ordinary Node command already includes reference corpus and matrix coverage.

## Problem statement

### Evidence available now

GitHub run [41823326357](https://github.com/dstoc/grain/actions/runs/41823326357)
passed at reviewed head `b5dca9d8efaecc53e5bea89487211b240644ebe1` before the
accepted squash merge. Its API timestamps give these elapsed durations:

| Phase                                                | Elapsed |
| ---------------------------------------------------- | ------: |
| Entire test job                                      |  33m59s |
| npm ci                                               |      3s |
| Chromium installation                                |     25s |
| Builds and static checks together                    |      6s |
| Node suite, including reference matrix and retention |  32m22s |
| Browser suite                                        |     25s |
| Extensive smoke                                      |     28s |

These coarse step timestamps include command overhead and are one observation,
not a controlled baseline. They do not separate ordinary Node, retention and
matrix work. The runner image revision, exact Node patch version, CPU/memory,
worker count, per-test timings and variation remain unverified. The log download
endpoint returned HTTP 403 in this investigation; job metadata remained readable.
Do not estimate missing measurements from earlier local runs or add separately
reported matrix times to a Node run that already includes that matrix.

### Concrete paths to profile

- `src/markdown/multiwriter/reference.test.ts` runs the frozen corpus through
  `referenceFactory()`. Only the history-limit trace has a 2,700,000ms deadline;
  other corpus traces have 60,000ms. Do not increase global deadlines.
- `test/multiwriter/corpus.ts` constructs 501 retention actions. The trace checks
  navigation eviction, cache drop, checkpoint reload and a returning old-prefix
  writer. `old-prefix-after-lossless-maintenance` is a separate required trace.
- `src/markdown/multiwriter/reference-matrix.test.ts` runs every ordered pair of
  structural choices and eight generated seeds, including serialized replay.
- `test/multiwriter/network.ts` compares peers before and after schedule steps.
  Its replay path opens a separate port from checkpoint bytes and compares
  document facets, complete canonical native bytes and materialized identities.
- `test/multiwriter/reference/factory.ts` materializes state, rebuilds aliases,
  prepares authors, serializes views and reconstructs native diagnostics.
  `isolationState()` creates a diagnostic Y.Doc from native states.
- `src/markdown/multiwriter/reference/document.ts` composes author validation,
  publication, provenance reconstruction and projection. Native admission and
  ownership validation must use the exact author closure.
- `src/markdown/multiwriter/reference/store.ts` already memoizes complete
  snapshots by `factsVersion`. The factory already caches materialization at
  that version. Do not propose these existing caches as new savings.

No phase profile yet proves which of these paths dominates. Parallelizing files
alone cannot shorten a single dominant retention test.

## Proposal

### 1. Establish a comparable baseline before optimizing

Use detached baseline and candidate checkouts with their own dependencies.
Run at least three full repetitions per revision on the same runner class,
OS/image, Node patch version, lockfile/tool versions and explicit worker count.
Alternate baseline and candidate order. Record cold installation separately
from warm execution; record queue delay separately from job execution.

Save a machine-readable manifest with commit/tree, command, environment flags,
runner image, architecture, CPU model/count, available RAM, Node/npm/Yjs/Vitest
versions, pool and workers, start/end times and exit status. Save per-test
reporter output and per-step wall, user/system CPU and peak memory. Account for
worker processes when measuring memory and CPU; distinguish peak concurrent
memory from a sum of process peaks. Record actual measurement availability.

Report every repetition, median and range, sum of runner execution time, CPU
time where available, and critical-path wall time. Compare both fixed-worker
suite execution and the proposed complete CI layout, including duplicate setup.
The accepted historical head is supporting evidence; the pinned accepted merge
is the reproducible before revision. Any later base changes need a separate
measurement label.

Add optional test-side timing/count probes around author preparation/local
certification, store admission, provenance/ownership reduction, publication,
serialization, native-cache creation/apply, network observation/isolation and
fresh reconstruction. Attribute nested costs without double counting. Start
with CPU profiles and call counts, then instrument only unresolved phases.
Compare instrumented and uninstrumented runs to disclose probe overhead.
Do not commit instrumentation to production APIs merely to time tests.

### 2. Remove only demonstrated redundant helper work

Select fixes from the profile. Prefer reducing repeated immutable encoding,
lookup construction or detached diagnostic assembly within one replica and
one unchanged facts version. Require a precise invalidation argument covering
pending ingress, variants, quarantine, changed ready closures, history,
publication, decode-limit changes, restart and disposal.

Keep detached results: a caller must not mutate a cached observation. Never
share derived state between peers or transfer a live cache into a reopened
replica. Reconstruction must start from retained canonical bytes plus the exact
genesis descriptor. It must still decode, certify, rebuild native state and
reduce independently. Keep the replay implementation and its assertions intact.

If measurements point into production algorithms, pause that optimization for
a focused amendment with equivalence/regression evidence. This proposal does
not approve incremental reducers, changed author validation or a new oracle.
If a helper optimization cannot preserve the oracle, retain the slower path.

### 3. Separate required phases and shard only independent cases

Use the existing workflow and Vitest projects. Propose these required job groups:

| Job group           | Required work                                                       |
| ------------------- | ------------------------------------------------------------------- |
| Static checks       | Both builds, lint, boundary checks, both Knip modes, formatting     |
| Ordinary Node       | All Node cases outside the explicit reference partition             |
| Reference retention | Complete 501-group trace and old-prefix maintenance coverage        |
| Reference remainder | Remaining frozen reference corpus and local reference controls      |
| Reference matrix    | Every structural pair and generated/replayed seed                   |
| Browser             | Existing complete browser project, preserving serial file execution |
| Smoke               | Existing extensive-smoke command and environment                    |
| Aggregate           | Verify all expected jobs and complete coverage inventory            |

Determine matrix shard count from measurements and runner capacity. Keep a
single retention trace on one worker; do not split its action history. Split
independent matrix pairs/seeds by stable IDs only if their file dominates.
Prefer file-level partitioning where sufficient. Never depend on test order or
share mutable fixtures across shards. Avoid a new general scheduling framework.

Collect the baseline discovered test IDs, skip/todo status and generated case
inventory. Compare the union of candidate partitions against it, including all
501 actions and unchanged seed decisions. Detect omissions and duplicate
assignment. New orchestration tests must be accounted for separately. Existing
skips remain visible; no new skips, narrowed assertions or changed expected
outcomes are allowed. Do not retain accidental duplicate matrix execution just
to match old elapsed time.

Keep a stable required aggregate check named `test`, with `if: always()` and
explicit dependencies on every required job. Matrix fail-fast must be disabled
so diagnostics from other shards complete. The aggregate must reject failure,
cancellation, timeout, unexpected skip, missing shard or missing/invalid report.
Require exact expected shard IDs, revision and attempt identity; never treat an
empty artifact directory as success. Check branch protection against the actual
check names before rollout. Required-check changes need repository-owner action
if this run lacks access. Preserve the old merge gate until verified.

### 4. Track long CI to its terminal conclusion

The reported 20-minute watcher limit is shorter than the observed successful
33m59s job. No watcher implementation or configuration was found in this repo;
the limit's owner and exact behavior remain to be verified in Tines/runner
configuration or source. A GitHub job still queued or running is pending, not a
test failure. A completed unsuccessful job is a failure; an unreadable API or
expired watcher is an orchestration/infrastructure result.

Record PR head SHA and run/job URLs before polling. On a watcher deadline,
persist a pending result and resume observation of that same SHA/run rather
than restarting tests or reporting success. Ignore superseded-head success.
Propose bounded resumable polling or a supervisor deadline that covers measured
full-gate duration with margin to the orchestration owner. This requires no
change to global test timeouts. If external configuration cannot be changed,
attach an explicit manual Check handoff with the live run identity and unresolved
watcher limitation. CI optimization does not resolve the watcher by itself.

## Suggested implementation shape

1. Add reproducible measurement/report commands and capture baseline evidence.
2. Apply only profile-supported helper changes, each with equivalence evidence.
3. Partition required jobs and add aggregate/coverage validation.
4. Exercise failure and completion tracking, then run the complete final gate.
5. Commit commands, coverage mapping, raw evidence locations and a before/after
   report under `docs/`; attach evidence to grain/100 and target the PR to `yjs`.

Use existing Node scripts and Vitest reporters where practical; add no dependency
without demonstrated need. Rollback restores the sequential workflow and removes
helper optimizations. Keep required-check protection valid during rollback.

## Non-goals

- No workload reduction, sampling, frozen-trace edits, weakened expectations,
  new skips, offline-only gates or optional merge coverage.
- No shared replica state, restored live caches, authority substitute or removal
  of fresh reconstruction.
- No production algorithm redesign, Yjs upgrade, browser concurrency change or
  claim about application editing latency.
- No global timeout increase or unverified change to external watcher policy.

## Verification

Before implementation, existing focused commands are:

```sh
npm run test -- src/markdown/multiwriter/reference-projection.test.ts
npm run test -- src/markdown/multiwriter/reference-matrix.test.ts
npm run test -- src/markdown/multiwriter/reference.test.ts
```

The projection command is a focused check, not full correctness acceptance.
The matrix command includes all pairs/seeds. The reference command includes the
complete expensive retention workload. Full current gate commands are:

```sh
npm run build
npm run build:web
npm run lint
npm run check:boundaries
npm run analyze:unused
npm run analyze:unused:production
npm run format:check
npm run test
npm run test:browser
npm run test:extensive-smoke
```

CI uses `npm ci`; the runner journal requires `npm install` for this managed
workspace. Record that distinction. Provision Chromium before browser runs.
The implementation must document exact partition and measurement commands,
including worker counts, without requiring users to reconstruct workflow filters.

Run orchestration controls for a failed test, cancelled job, timed-out shard,
missing shard/report, duplicate shard, malformed report, wrong SHA and successful
complete run. Verify that the required aggregate cannot pass any incomplete
case. Use a disposable branch/workflow run for GitHub behavior that local script
tests cannot establish. Check all final required jobs pass at the exact PR head;
do not equate an earlier revision's result with final verification.

Compare helper output before/after over frozen traces, full matrix, generated
serialized replay, retention and quarantine/variant controls. Compare complete
canonical bytes, native identities and document observations, not just Markdown.
Retain all network isolation and reconstruction assertions.

## Success criteria

- At least three comparable before/after full runs report per-phase/per-test
  timing, resource use, variation, total compute and critical path at pinned SHAs.
- Fast checks complete independently of retention, and measured full-gate wall
  time improves materially. Set numerical budgets from the baseline profile
  before optimizing; report remaining serial cost and any compute increase.
- The final revision passes all required coverage, unchanged acceptance
  assertions, full 501-group history and independent fresh replay, with no new skips.
- Coverage and aggregate controls reject every failed, cancelled, missing,
  timed-out or stale result. Branch protection requires the verified aggregate.
- The watcher is either verified to follow long runs to completion or has a named
  external handoff describing its unresolved limit and exact pending-run handling.
- Committed documentation supplies runnable fast/full commands, CI layout,
  measured budgets, raw evidence locations and evidence limits. No performance
  target is claimed from this proposal's single historical observation.
