# Incremental multiwriter materialization status

The opt-in reader reuses native state, readiness certificates, activity roots and
coupled placement/ownership checkpoints. Insertions, exact text replacements and
text-only history controls update affected flows and their ancestors while
preserving unrelated view and address objects. MW-13 remains incomplete. The approved contract is
[proposal v1](proposals/2026-11-05-mw13-incremental-materialization.md).

Select the reader locally through bootstrap's
`materialization: 'incremental-native'`. Reference remains the default. The
selection does not change genesis, envelopes, insertion identities or transport.
Yjs remains pinned to 13.6.33. No browser cutover or canonical pruning is included.

## Current behavior

| Boundary             | Reused work                                                                                                                                                        | Remaining cost or fallback                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness            | Reverse dependencies, immutable certificates, actor causal frontiers, ready-membership roots and resource queries                                                  | Ordered ready/head/variant arrays are rebuilt. Public diagnostic exports still clone detached values.                                                                   |
| Author certification | Exact causal native branch; touched-tape refinement and exact deletion checks; text-only controls reuse certified raw structure after complete activity validation | Structural/property actions still materialize full causal arrays. A different author branch can reconstruct native state.                                               |
| Native publication   | Shared ready-root differences select new native bodies; old views retain immutable roots                                                                           | The affected tape is indexed as a whole. Long tapes require interval work.                                                                                              |
| Activity             | Persistent roots and deterministic suffix replay                                                                                                                   | Exact prefix comparison and compatibility arrays still visit retained payloads.                                                                                         |
| Coupled replay       | Persistent placement/ownership roots; tape-local split readers; compatible cell subdivision; native snapshot/cell roots; retained-resource/home certificates       | Invalidation is conservative within a read tape. General projection exports all snapshots; coverage, compatibility and output arrays still traverse retained structure. |
| Text projection      | Insertions, exact deletion/replacement and text-only controls update affected flows/ancestors; tape readers include ghost addresses                                | Subtree deletion, dormant births, scaffolds and structural/interpretation changes use full projection. Touched tapes/flows are scanned.                                 |
| Command preparation  | Publication-local handles, lazy text pieces/native resources, indexed native planning and writer synchronization, raw ownership reuse during replacement           | Structural compiler queries still use full projection. Readiness compatibility arrays remain global work; exceptional writer synchronization scans retained actions.    |
| Managed history      | Exact pre-append text selection staging; text-only Undo/Redo updates visibility locally                                                                            | Structural/property selection staging uses full author projection. Generic control validation still constructs causal arrays.                                           |
| Cache eviction       | Drops readiness/author certificates and preimages, private native caches and historical reducer roots; reverse indexes rebuild on the next read                    | Active publications retain shared roots. Cache counts and controlled released-heap deltas do not establish total cache heap or peak candidate memory.                   |

The independent reference entry still performs full readiness, native, activity,
ownership, visibility and semantic replay. It does not call the optimized
materializer. Shared traversal/query contracts and pure ordering/cycle rules do
not supply optimized checkpoint state to that reference entry.

## Checkpoints and publication

Activity and coupled structural caches retain checkpoints every 128 semantic
actions, with at most eight historical checkpoints per reader. These are local
cache policies. They do not limit canonical facts or local history groups.

A coupled checkpoint forks placement and ownership together. Compatibility
requires exact payloads and matching effective activity/interpretation decisions.
A structural control invalidates its earliest affected target, even when the
control sorts later. Text-only controls change insertion activity and exact tags
without changing raw placement or ownership. Their raw roots stay reusable.

Active split replay records every tape read by its current component traversal,
including joined tapes outside its authored basis. Marker subdivision refines each
checkpoint's own assignments before the first affected reader. A tape unrelated
to that reader does not invalidate its prefix. Checkpoints before a tape's birth
do not acquire its ownership. Marker withdrawal or reordering forces replay from
genesis. Old publications keep their original roots. Reader dependencies remain
conservative at tape granularity; this is not interval-local invalidation.

Preparation returns a candidate. The reader commits activity and projection only
after complete publication. Cancellation, failure or changed receipts preserve
the previous tuple. Old native/ownership/view reads remain valid after later
commits and cache eviction. Work counters can include attempted candidates;
`lastReplayFrom` and `lastReplayLength` describe committed replay.

Private managed text staging uses the same flow projection against the writer's
exact native draft before append. It captures stable selection without committing
activity, ownership or projection roots. Rejection leaves canonical facts and local
history unchanged. Reentrant peer changes after append do not alter that captured
author result.

The local path requires one new final action, identical retained payloads, a
continuous native branch, active node births and no active subtree deletion.
It admits insertion/exact-deletion actions or an owner control whose complete
target group contains only those actions. Ingest still validates control ownership,
complete groups and control chains. Structural/mixed targets keep full replay.
New text cannot enter an existing exact syntax mask because its identities are
fresh. Marker births require no preceding split reader of the affected tape;
marker-only changes update all projected address readers, including ghost runs.
Diagnostic action/effect/text arrays stay lazy.

Exact deletion stores native tags without removing text. Undo recomputes insertion
activity and active tags on affected tapes in semantic order. Managed command
results retain the staged native focus; re-lowering an old numeric offset after a
reentrant peer prepend can split a surrogate pair. Regression tests for both readers cover that case.

Eviction releases publication-native, activity, coupled/projection, readiness and
author-certification caches, including detached certification preimages. It first
cancels suspended readiness validation, then releases its private native branch.
The decoded-fact registry, undecoded ingress and a dirty identity set remain in
ActionStore; their heap still needs separate attribution. Reverse dependencies
rebuild on the next read. The active publication, live
history and canonical bytes remain intact. `cacheDiagnostics()` reports direct
counts/encoded lengths, not heap. Controlled before/after-GC probes report only
uniquely released whole-process heap while those retained roots stay fixed.
Shared active-publication roots and peak candidate memory remain unmeasured.
MW-18 journal consolidation remains separate on the integration branch. A cached
projection is never a canonical checkpoint.

## Retention-test profiling

The retention workload still compares every completed publication with independent
full reference readiness, native reconstruction, provenance, ownership and semantic
projection. Exact positive trace comparisons use Node's deep strict comparison,
which handles nested binary payloads without enumerating their byte properties.
Every mismatch falls back to the original Vitest matcher and diagnostics. No
observation, assertion, schedule or deadline is omitted.

Ephemeral marker-allocation indexes and ordinal cell ranges remove repeated scans
within complete ownership replay. Cell identity queries use per-client native
clock intervals. These indexes are built from each input; they do not supply a
candidate checkpoint to the reference replay. Native position reads share known
positions until their tape changes; apply, local preparation, abort and rebuild
invalidate those positions. Unfinished reads fail if their tape changes.

At engine/test source `e5a1856088a2731baa3e2f44665aba79762ce3bc`, the
unchanged 501-group frozen retention case completed in 279.128 seconds in isolation
on the recorded runner, and 287.084 seconds within the unfiltered Node suite. The
suite passed 2,222 tests with the same 194 source skips in 678.10 seconds. These are
observations on this runner, not a portable runtime guarantee. All original
retention assertions, cold replays, schedules and deadlines remain in place.

Full reference causal closure uses fresh word-indexed relations and copies only
layout input fields. Completed resumed readiness results are memoized at the exact
facts version. Certification reuses encoded bytes only after exact comparison with
its private detached preimage; differing data takes the original encoding path.
These preimages add cache memory that still requires separate accounting.

The network harness reuses detached observations only when their complete plain
data graph is proven immutable. Mutable graphs retain the original clone path.
Native isolation reads remain fresh. Symbolic native aliases use clock indexes,
and retained-prefix checks compare exact stored payload bytes. These changes
remove repeated harness work without removing observations or reference replay.
The retained 579.595-second intermediate diagnostic was not a pinned matched
baseline; it must not be used to claim a matched speedup ratio.

This work does not yet replace full touched-tape index construction, conservative
structural marker invalidation or general projection. The issue's profiling
artifacts record the source and limits of each measurement.

## Reader, replacement and eviction stage

Corrected engine/test source `9a8eece48c4ca10bf097bdb9799ff5c71d02cf9d`
passes the unfiltered Node suite: 2,252 tests, the same 194 original source skips,
565.32 seconds with three workers. An occurrence audit preserves every previous
test after one performance-case rename and adds 30 cases. Text-control work
expectations assert reusable raw roots; semantic/frozen assertions, seeds,
schedules and deadlines remain unchanged. Structural rollback still checks
checkpoint 128.

The unchanged frozen 501-group materialization case takes 270.867 seconds in an
isolated one-worker run, meeting the approximately five-minute direction on this
runner. It takes 305.076 seconds in the full suite while a one-worker integration
cohort overlaps. Both observations remain in the reports; no matched speedup or
portable runtime guarantee is claimed. The original source deadline remains.

Combined MW-10/MW-18 source `a5df71daf83ac3cc5aca113328a169bccc4630dc`
passes 230 checks across 11 files in 232.10 seconds. It includes real managed
501 groups, both frozen maintenance traces, journal replacement/retry, cache
eviction, old-prefix edits, restart and the new text/history regressions. Managed
501 groups use task-state commands, not mixed-text performance. Consolidation
reduces batches but can increase serialized bytes. The dependency's normal conflict
resolution and review/merge remain required. No new browser run is claimed;
storage behavior is unchanged.

Controlled GC exposed a lifetime bug at the earlier stage: lazy projection readers
and retained layout callbacks kept prior preparation contexts alive. The corrected
reader creates escaping getters with only current roots, uses causal membership
only during allocation, and retains only declared resource fields. All five
benchmark-harness tests pass, including managed/unmanaged GC checks: explicitly
held publications stay readable, then discarded value/native/root objects collect
after release while the current document stays open.

Three alternating fresh-process triples at the corrected source use one retained
150-paragraph genesis and six managed replacements with native selection (two
warm-up commands). Median per-process p50/p95 is 1,249.878/1,257.793 ms for the
previous materializer, 4.567/6.420 ms for the candidate, and 1,471.344/1,481.307 ms
for current full reference. Candidate Undo/Redo medians are 5.911/4.749 ms. These
small whole-command samples do not establish core-phase or scale budgets.

Separate 64-group GC probes retain identical canonical bytes, active publication
and live history across eviction. Median uniquely released process heap is
4,784,608 bytes for the candidate and 1,772,968 for the previous source. This is
released heap, not total cache memory. The active roots, decoded facts and writer
remain; shared-root attribution and peak candidate memory are open. The eviction
call excludes GC; continued editing includes rebuilding the evicted caches. No
journal is attached to these timing workers. Raw byte/history fields stay separate.
Earlier stage measurements remain historical evidence for their recorded source.

Focused controls cover unrelated split tapes, transferred ghost addresses,
checkpoints before transfers/new home births, joined traversal readers, cancelled
candidates, marker withdrawal, exact deletion, overlapping peer tags, Unicode,
managed observer recovery, live history after eviction and malformed ranges.
Independent full replay remains the oracle. New short measurement probes retain
exact common genesis bytes, alternating fresh processes and post-timing reference
checks. Reports keep their source/scope and do not establish scale or mixed-history
acceptance. See grain/94's current-stage artifacts for raw reports and limitations.

## Resource, readiness and compiler-read stage

Engine/test/benchmark source `5f09381e8f48bfbed0ac8bc5cd28b6c7fa643b05`
adds persistent retained-resource maps and tape-local private-home classification.
Compatible suffixes index new allocations, derive new homes and check changed
marker topology. Retained skeleton checks survive marker subdivision. Structural
Undo/Redo with unchanged native state reuses those certificates. Late earlier
payloads, withdrawal, native reconstruction and eviction use cold resource
validation. General projection still exports complete snapshot arrays and checks
structural coverage; this is not interval-local replay or general local projection.

Immutable ready-membership roots supply actor sequence and Lamport metadata to the
writer. Comparing shared AVL paths identifies additive native bodies, including
across rotations. The root stores no chain of older ready arrays or wrappers.
Native integration clears its reuse token until every body in that candidate is
integrated. A writer also checks its appended-ahead identities before reusing its
last ready root. Withdrawal/replacement and partial integration retain full safety
checks. Readiness still rebuilds ordered ready/head/variant arrays; this stage does
not remove all retained-action work from ordinary input.

The compiler's `NativePlan` indexes permanent marker locations and reads its owned
tape snapshots internally. Public snapshots and marker results remain detached.
The previous source made 1,200 resource-key calls for one marker lookup after
loading 150 tapes; both new scan controls fail there and pass with indexing.
Internal locate/range/text queries no longer clone a public snapshot. The compiler
still invokes full projection for structural queries, and structural/property
history staging still constructs a full author result.

Verification remains source-scoped:

- Resource checkpoint `e32aa84212a078d446cf6e4ff10466968c56bd98`: unfiltered Node,
  2,267 passed and the same 194 source skips. No existing test file changed; 15
  cases were added. The unchanged materialization 501-group case took 279.876
  seconds in that run.
- Ready checkpoint `6cf6a5a10a9b0a3400baa09cbad392e51d7823ca`: unfiltered Node,
  2,279 passed and the same 194 source skips. Its materialization 501-group case
  took 338.145 seconds while new wide/deep cases and structural diagnostics
  overlapped. That observation exceeds the approximate five-minute direction.
- Current source `5f09381`: 2,281 passed with exactly the two long reference and
  materialization history-limit cases filtered, plus the original 194 source
  skips. An occurrence audit preserves all prior cases and adds four. The new
  5,000-paragraph work gate and 1,000-action writer case remain in that run.
- The unchanged current-source materialization 501-group case passed alone in
  288.832 seconds (4m49s), with a 10 ms CPU profile and no competing correctness
  workers. The profile attributes about 121 seconds of self samples to
  `structuredClone`; it samples no `NativePlan` frame. The original assertions,
  trace, cold reconstruction and deadline remain intact. The independent reference
  501-group case retains its unfiltered `6cf6a5a` evidence; no new unfiltered
  current-source pass is claimed.
- Combined MW-10/MW-18 source `30cd4d95ae151831af3172eeaff5f009c7634d5b`:
  234 checks across 12 files, including real managed 501 groups, both frozen
  maintenance traces, strict one-way/catch-up, consolidation/retry, cache eviction,
  old-prefix editing/restart and native-plan controls. This is correctness/storage
  evidence, not mixed-text timing or dependency review approval.

Build, web build, lint, formatting, boundaries and both Knip modes pass. All five
benchmark-harness checks pass. The GC lifetime control now also covers discarded
ready arrays/index wrappers while held values remain readable. Additional ready
and resource maps are rebuildable memory; store, writer and active-publication
roots can share them. Direct counts and eviction deltas do not establish their
total, shared or peak heap.

The current-stage issue artifacts retain all raw reports, exact fixture bytes,
negative controls, the sampled profile and intermediate checkpoints. The initial
structural timing run overlapped correctness workers and is retained as a
contention diagnostic. Final short timing results are recorded separately.
Reference full materialization remains independent and default. PR #88 remains
draft; normal MW-18 conflict resolution, review and merge remain required.

Final measurements use three alternating fresh-process triples on one retained
150-paragraph synthetic genesis. Each structural process runs six cycles of real
managed split, join, Undo join and Redo join, with native selection. The first two
cycles are warm-up. Median per-process split p50/p95 is 4,252.117/6,222.499 ms for
the candidate, 4,666.668/6,640.080 ms for the previous materializer at `2cbe0c6`,
and 6,499.600/9,560.707 ms for current full reference. Candidate join p50/p95 is
3,112.985/4,366.811 ms; Undo/Redo p50 is 1,469.815/1,563.055 ms. General structural
compilation/projection and history staging remain seconds-long work. These samples
do not meet the parent structural target.

Separate six-replacement processes use the same genesis, native selection and two
warm-up commands. Candidate replacement p50/p95 is 4.981/6.749 ms, compared with
4.906/7.009 ms for the previous materializer and 1,157.687/1,177.912 ms for current
full reference. Candidate Undo/Redo is 6.236/4.928 ms. These shallow samples do not
establish a literal speedup, core-phase budget, scale or mixed-10k acceptance.
Complete native/canonical/reference comparisons run after the timed operations.

Three alternating cache-eviction pairs use 64 real managed literal groups.
Median uniquely released whole-process heap is 5,793,768 bytes for the candidate
and 4,784,736 bytes for the previous materializer. The candidate's median process
heap is 34,011,696 bytes before eviction and 28,217,928 bytes afterward. The same
canonical export, active publication and live history remain rooted. Direct field
counts show 64 decoded facts/variants retained; the store's ready index drops from
64 actions to zero, while the writer retains a 63-action ready root and one
appended-ahead identity. Dirty identities rise from zero to 64 for recertification.
These are counts and a released-heap estimate, not total/shared/peak cache memory
or isolated history heap. Candidate eviction takes 0.468 ms excluding GC; the next
complete edit takes 699.491 ms including cache reconstruction. Timing workers
attach no journal. Canonical, embedded native, synthetic-descriptor and serialized
history byte fields remain separate.

## Evidence and outstanding gates

Focused checks cover detached exports, concurrent-resource exclusion, exact
certificate reuse, cancellation, old-publication isolation, checkpoint resume
before an undo target, cache eviction/restart, literal commands and managed
observer recovery. Warm literal tests cover 10, 150 and 1,000 paragraphs, asserting
one native tape read, no full-projector call, and two replaced view records for a
root paragraph edit. These checks do not prove the paths in the table's fallback
column. The issue artifacts identify exact source heads and completed runs.

Complete the following before accepting MW-13:

1. Refine tape-local structural reader invalidation and touched-tape construction
   to affected native intervals. Resource/home validation now reuses compatible
   certificates; general coverage, compatibility and projection exports still
   traverse retained structure. Earlier-arrival resource reconstruction is cold.
2. Extend affected-container projection through deletion, dormant births,
   interpretation selection, lifting, wrapper grouping and ordered numbering.
3. Finish lazy retained readiness/head/variant metadata, action-local structural
   compilation and structural/property history staging without full replay. Writer
   frontiers/native synchronization and private native-plan reads now use indexes.
   Exact replacement and text-only history staging use the local path.
4. Replace whole touched-tape work with affected native interval indexes.
5. Verify cancellation/capacity/withdrawal at the new boundaries against the full
   oracle, including the frozen corpus, generated schedules and real commands.
6. Complete matched whole-command scale/fragmentation, mixed uninterrupted
   10,000-action, strict one-way/catch-up and real MW-10/MW-18 timing/storage/cache
   reports. Keep canonical bytes, journals, cache heap and history metadata
   separate. No core latency target or complete performance pass is established.

Keep draft PR #88 and all outstanding gates open. The earlier measurement and
verification artifacts remain historical evidence for their original source.
