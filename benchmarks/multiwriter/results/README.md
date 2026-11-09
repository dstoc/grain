# Native materialization stage measurements

These measurements compare implementation `64e92e8dafb074765d7058536b8dd3f8e800c8fa`
with the pinned full-reference source `415363a4e85549a33eee3010d69e55ce6161002d`.
They cover the first native-cache/command-overlay stage of grain/94. They do not
establish MW-13 acceptance. Full semantic publication still uses the reference
projector, and readiness/certification still scan closures.

Each row reports the median of three fresh-process p50/p95 values, in milliseconds.
Each process ran the same 24-action literal script and excluded four warm-up
actions from its latency samples. Pair order alternated. Replay used the exact
same genesis and original carriers. Command runs used the same semantic script
with fresh writer identities. All final replay and Markdown comparisons passed.
The historical editor received only the recorded local-capacity overlay.

| Paragraphs | Workload | Reference p50 | Reference p95 | Native stage p50 | Native stage p95 |
| ---------- | -------- | ------------- | ------------- | ---------------- | ---------------- |
| 10         | replay   | 23.896        | 33.449        | 19.992           | 23.359           |
| 10         | command  | 35.239        | 46.205        | 22.775           | 25.610           |
| 150        | replay   | 598.747       | 625.283       | 571.388          | 603.406          |
| 150        | command  | 1161.514      | 1305.325      | 563.501          | 658.807          |

Environment: Linux, Node 26.13.0, Yjs 13.6.33, AMD Ryzen 9 5900X. Node correctness
and corpus workers were running concurrently. These observations include that
contention and are not isolated performance budgets. The phase is complete
carrier apply plus publication, or the complete headless command; neither is a
browser input-to-paint measurement.

At 150 paragraphs the stage still takes hundreds of milliseconds. It does not
meet the parent 2 ms / 5 ms core target. Removing the intermediate command
projection reduces command time, while the remaining full publication dominates.
No general speedup for structural editing follows from this literal workload.

Raw per-process samples, fixture hashes, capacities, canonical/native byte counts
and controlled-GC process heap deltas are retained in
[native-stage-10.json](native-stage-10.json) and
[native-stage-150.json](native-stage-150.json). Exact binary genesis/carrier
fixtures and individual sample files accompany the issue's measurement artifact.
Embedded native-update bytes are a subset of envelope bytes. Full native export
bytes are a separate encoding, not additional canonical storage. The whole-process
heap delta includes canonical data, caches, command state and runtime noise; no
cache-only memory claim is made.

The reports intentionally leave storage journals, production undo metadata and
consolidation fields null. A separate integration branch probes actual MW-18
consolidation; that probe does not supply per-instance MW-10 history or performance
acceptance. A development 1,000-paragraph/two-action smoke run also completed, but
is not a matched 24-action scale comparison. No 5,000-paragraph measurement,
mixed 10,000-action trace, strict one-way/catch-up
performance result, or complete cache/history storage accounting was completed.
Do not extrapolate these short runs to those workloads.

## Post-M5 semantic control

The additional paired control compares exact post-M5 schema-2 commit
`c3a8812e8bbee69c805a50347dd29d11c076d2de` with native-stage commit
`96c0df224b5348daeb1a400b7f4774a130cb68ce`. It reuses the same fixture and
24-action literal script, with four warm-up actions and three alternating
fresh-process pairs. The candidate and historical model both matched the final
Markdown. The historical source received no algorithm or capacity patch.
Environment and concurrent correctness workers were the same as above.

| Paragraphs | Post-M5 p50 | Post-M5 p95 | Native stage p50 | Native stage p95 |
| ---------- | ----------- | ----------- | ---------------- | ---------------- |
| 10         | 0.769       | 1.238       | 22.557           | 26.156           |
| 150        | 0.556       | 0.996       | 584.458          | 639.779          |

Times are milliseconds and are medians of per-process percentiles. These models
have different capabilities: schema 2 admits edits through an authority and uses
native history, while schema 3 retains independent immutable action envelopes.
This compares the same literal task, not offline merge behavior or identical
wire data. The stage is far slower than this historical control and is not ready
for browser cutover. Full-readiness, author-certification and semantic-replay work
remain unoptimized.

[post-m5-10.json](post-m5-10.json) and [post-m5-150.json](post-m5-150.json) retain
all raw samples and fixture hashes. The schema-2 checkpoint includes its initial
document, unlike the separate schema-3 genesis/actionDoc fields. The individual
byte fields are not equivalent storage categories. No cache-only heap, production
history, 10k trace or structural-performance conclusion is drawn from this control.

## Readiness/activity stage, 2026-11-05

Engine source: `4185a744d842809d9f892e347a67764e5a11da88`, including accepted
MW-10. Measurement/harness commit: `de58236023c8564b9b00612ac6e93cc3efd9403a`.
Yjs 13.6.33, Node 26.13.0, Linux/AMD Ryzen 9 5900X. All correctness workers from
this run had exited before measurement. Raw fixtures and per-process samples are
attached to grain/94 as `incremental-stage-measurements`; the reports below are
committed without replacing earlier results.

Each cell is the median of three per-process p50/p95 values in milliseconds.
Each fresh process ran 24 literal actions, with four warm-ups. Pair order
alternated. Replay used identical original carriers and genesis; commands used
the same unmanaged `LocalEditor.edit()` script. Comparisons ran outside timing.

| Paragraphs | Workload                | Full reference `415363a` p50/p95 | Current opt-in p50/p95 |
| ---------- | ----------------------- | -------------------------------- | ---------------------- |
| 10         | Receipt and publication | 20.819 / 27.349                  | 18.265 / 21.640        |
| 10         | Unmanaged command       | 33.209 / 43.841                  | 22.056 / 27.417        |
| 150        | Receipt and publication | 582.629 / 625.907                | 559.299 / 585.653      |
| 150        | Unmanaged command       | 1,055.394 / 1,099.635            | 532.750 / 580.450      |

The separate schema-2 post-M5 semantic command control at `c3a8812e` measured
0.504 / 1.328 ms versus 542.117 / 573.863 ms for the current reader. It has different
capabilities and storage categories. These cumulative baseline comparisons do not
isolate the timing effect of the new readiness/activity caches.

The reports separate canonical carrier bytes, envelope bytes, embedded native
bytes, genesis bytes and native-cache exports. Embedded native bytes are a subset
of envelopes. `processHeapDelta` is a whole-replica heapUsed delta after GC; it is
not cache-only heap, external memory, RSS or peak candidate overhead. Journals,
managed session navigation and consolidation latency are unmeasured here. Their
serialized correctness-trace sizes are in the separate history-maintenance artifact.

These are short unmanaged literal observations, not core-only or browser latency.
Full projection still runs per changed publication. Whole-command scale gates,
long tapes/wide lists/fragmentation, mixed uninterrupted 10,000-action traces,
strict one-way catch-up and complete cache/history/storage accounting remain
required. No complete MW-13 performance pass follows from these results.

## Coupled replay and local projection stage

Engine/harness source `88cf771117e5efebf1fa7e76e0cd6372ae847f60` adds coupled
checkpoints, local literal projection and private managed literal selection
staging. All correctness workers from this run had stopped before these timings.
Original 10/150 fixtures were copied unchanged and hash-checked. Every row uses
three alternating fresh-process pairs and reports the median process p50/p95 in
milliseconds. Raw samples and exact binary fixtures accompany the issue artifact.

| Paragraphs | Workload                  | Reference p50/p95   | Materialized p50/p95 |
| ---------- | ------------------------- | ------------------- | -------------------- |
| 10         | carrier apply/publication | 20.160 / 30.924     | 1.678 / 2.243        |
| 10         | unmanaged command         | 30.284 / 40.006     | 2.463 / 3.694        |
| 150        | carrier apply/publication | 559.336 / 583.819   | 1.581 / 1.794        |
| 150        | unmanaged command         | 994.381 / 1046.627  | 2.333 / 2.651        |
| 150        | managed command           | 1328.248 / 1523.919 | 3.504 / 5.082        |

Unmanaged reference is pinned `415363a`. Managed reference uses this checkout's
accepted MW-10 code. Managed workers supply real selections and perform one real
Undo and Redo per process; materialized medians are 410.004/402.584 ms. These are
single navigation samples per process, not per-action p95s. Serialized navigation
metadata is about 209 KB; it is not heap. The separate schema-2 post-M5 pairing
reports 0.466/0.885 ms versus materialized 2.395/3.393 ms.

Reports: [10](coupled-stage-10.json), [150](coupled-stage-150.json),
[managed 150](coupled-managed-150.json), [post-M5](coupled-post-m5-150.json).
Canonical, embedded native, genesis and controlled-GC whole-replica heap categories
remain distinct. These workers have no storage journal. Actual MW-18 retention
and serialized storage controls are separate verification workloads.

This is a short literal improvement, not full MW-13 acceptance. Marker refinement,
general visibility/structural changes, non-literal history and whole touched-tape
work still have full fallbacks. Whole-scale/fragmentation timings, uninterrupted
mixed 10,000-action, strict one-way/catch-up timing, full managed MW-18 performance
and separately attributed cache heap remain incomplete. No original reports or
fixture bytes were rewritten.
