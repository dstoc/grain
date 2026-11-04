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
schema-2 post-M5 comparison, mixed 10,000-action trace, strict one-way/catch-up
performance result, or complete cache/history storage accounting was completed.
Do not extrapolate these short runs to those workloads.
