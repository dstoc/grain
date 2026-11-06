# Multiwriter materialization measurements

This runner compares the opt-in materializer with the
full reference implementation at `415363a4e85549a33eee3010d69e55ce6161002d`.
It does not establish full MW-13 acceptance. The current implementation also
caches coupled replay and projects a narrow literal append locally; see the
[implementation boundaries](../../docs/mw13-materialization-status.md). Historical
reports retain the scope and source of their original stage.

Use the runner's installed dependencies (`npm install`) and Node with
`module.registerHooks` support. Yjs must be exactly 13.6.33. Verify exact fixture comparisons with
`node --test benchmarks/multiwriter/worker.test.mjs`. Run measurements on an
otherwise idle host:

```sh
node benchmarks/multiwriter/run.mjs --output /tmp/mw13-results --size 150
```

The destination must be new. This command performs three paired fresh-process
runs of both replay and commands. The first pair runs reference first, the next
pair reverses the order. Without `--size`, it runs 10, 150, 1,000 and 5,000
paragraphs. `--steps` and `--runs` override the manifest for an explicit smoke or
long run:

```sh
node benchmarks/multiwriter/run.mjs --output /tmp/mw13-smoke --size 10 --steps 2 --runs 1
```

The runner creates and removes its own temporary baseline worktree. It copies
only the benchmark harness and uses the installed dependencies. The historical
editor has no native-capacity option, so the runner applies a recorded two-line
capacity overlay (10,000,000 operations) to match the candidate's explicit local
option. No algorithm change is overlaid. Both sides use the same large genesis
and native decode capacities; the report includes the exact historical diff.

`fixture-<size>.bin` retains the exact genesis and original action-store carrier
updates. Replay applies those identical bytes in both implementations. Commands
run the same literal insertion script against that genesis; their fresh writer
identities differ. The worker compares replay output, readiness, raw placement,
ownership, addresses, visibility and exact native/canonical bytes with the
capture's reference hash after timing. Command runs compare exported Markdown.
Neither comparison is included in the measured intervals. Snapshot contract fields
are hashed in the original reference order; JavaScript property insertion order
in a reader export is not a semantic difference. Original fixtures remain valid.

`report.json` names the source commits, dirty status, runtime, Yjs, CPU, fixture
hashes and raw per-process samples. `coldMs` measures initial publication, before
constructing the command writer. `latencyMs` measures either carrier apply plus
publication, or the complete local command. The first four actions are warm-up
(or all but one for a shorter script). Do not pool these phases or treat them as
browser input-to-paint latency.

Canonical carrier bytes, summed envelope bytes, embedded native-update bytes,
native-cache export bytes and genesis descriptor bytes are distinct quantities.
The embedded native bytes are a subset of the envelopes, not additional storage.
`processHeapDelta` is a controlled-GC whole-replica process delta. It includes
canonical state, caches, local editing state and runtime noise; it is not a
cache-only heap measurement. Journal, production-history and consolidation
measurements are `null` in this low-level `LocalEditor.edit()` workload. It does not
use managed `HistorySession` navigation or an attached journal. Actual managed
history/checkpoint correctness and serialized-size controls run separately on the
integration branch; these timing reports do not measure their command costs.

An error or interruption leaves an incomplete report and any completed samples.
Only `complete: true` means all requested cases completed and passed their
comparisons. A partial trace is not a 10,000-action result. No extrapolation is
valid. If the process is forcibly stopped, inspect `git worktree list` and remove
its disposable `grain-mw13-*` baseline worktree after confirming the run ended.

Remaining acceptance includes the schema-2 post-M5 matched comparison, mixed
10,000-action continuous traces, strict one-way senders with later catch-up,
incremental semantic work gates, separately attributed cache/history memory, and
actual MW-10/MW-18 eviction/consolidation integration. `--steps 10000` alone runs
literal input and does not cover that mixed-workload contract.

## Pinned post-M5 control

Use a completed fixture directory to compare the same literal script against the
schema-2 post-M5 commit `c3a8812e8bbee69c805a50347dd29d11c076d2de`:

```sh
node benchmarks/multiwriter/post-m5.mjs --fixtures /tmp/mw13-results --output /tmp/mw13-postm5 --size 150
```

This runs three alternating fresh-process pairs. The historical path uses
`prepareTextInput` → `apply` → `publish`, with one explicit history group per edit.
The candidate uses the same `LocalEditor` script as the native-stage measurement.
Both verify final Markdown against the captured fixture. The historical source
receives only the benchmark loader/scripts, with no algorithm or capacity patch.

This is a semantic workload comparison across different models. Schema 2 has an
authority and native undo; schema 3 uses independent immutable action envelopes.
Schema 2 cannot replay schema-3 carriers. Its canonical checkpoint includes the
initial document; schema-3 genesis and actionDoc sizes remain separate. Do not
compare those individual byte fields as equivalent storage categories, and do
not infer offline/concurrent capability from this literal control.

## Managed history comparison

Use an existing exact fixture to compare real MW-10 selection capture, edit,
Undo and Redo in the current-source reference and materialized readers:

```sh
node benchmarks/multiwriter/managed.mjs --fixture /tmp/mw13-results/fixture-150.bin --output /tmp/mw13-managed-150
```

The destination must be new. The runner performs three fresh-process pairs and
reverses their order on alternate pairs. Both implementations use this checkout's
accepted MW-10 code and the same genesis/literal script. This reference is distinct
from the pinned pre-MW-10 reference used by `run.mjs`. The script creates a separate
history group per edit and supplies the native selection. Each process also times
one real Undo and Redo, verifies exact restoration, and verifies final Markdown.
The navigation samples are single operations per process, not per-action p95s.

`localHistoryBytes` is serialized navigation metadata. `processHeapDelta` remains
a controlled-GC whole-replica delta that includes history. Neither measures
cache-only heap. Publication full-projection counters exclude author selection staging. The
`stagedTextProjections` counter identifies local literal staging; non-literal or
visibility-changing staging still uses a full author projection. There is no attached storage journal
or consolidation workload in this script. The real 501-group and MW-18 tests remain
separate correctness/storage controls. These short managed literal measurements
do not satisfy the mixed 10,000-action, directional catch-up or complete MW-13 gate.

To reuse original carriers from a completed report without recapturing them:

```sh
node benchmarks/multiwriter/run.mjs --fixtures /tmp/prior-150 --output /tmp/mw13-reused-150 --size 150
```

The runner checks the pinned baseline, retained schedule and exact fixture hash,
then copies the original binary and capture metadata unchanged. Both timed
implementations replay that same input. The report records the earlier fixture
source separately from the current candidate source. `--steps` cannot change the
retained schedule.

## MW-13A structural locality diagnostic

Run the short managed split/type/join/unrelated-edit/undo/redo sequence, both
deletion variants, restored exact 100/1,000-action inputs, and native refinement
classification with:

```sh
node benchmarks/multiwriter/structural-locality.mjs --output /tmp/mw13a-results
```

Use `--case root`, `tasks`, `100`, or `1000` for one input. Each worker stops after
five minutes. Only a report with `complete: true` passes. The runner keeps exclusive
phase spans and retained-work counts separate from wall-only public command
samples, nested public API durations, cold/reference setup, and unmeasured
persistence. Fresh writers have different identities; original input bytes and
all new carriers are retained. See the [refinement decision and shared execution
contract](../../docs/mw13a-structural-locality.md) before using these profiles to
choose a production optimization. The original prefix captures have unknown source
SHAs and different actors. They are diagnostic restores, not uninterrupted runs.
