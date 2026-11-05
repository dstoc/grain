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

| Boundary             | Reused work                                                                                                                                                        | Remaining cost or fallback                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness            | Reverse dependencies, immutable certificates, actor causal frontiers and resource queries                                                                          | Ordered ready/head/variant arrays are rebuilt. Public diagnostic exports still clone detached values.                                                 |
| Author certification | Exact causal native branch; touched-tape refinement and exact deletion checks; text-only controls reuse certified raw structure after complete activity validation | Structural/property actions still materialize full causal arrays. A different author branch can reconstruct native state.                             |
| Native publication   | New bodies integrate once; old views retain immutable roots                                                                                                        | The affected tape is indexed as a whole. Long tapes require interval work.                                                                            |
| Activity             | Persistent roots and deterministic suffix replay                                                                                                                   | Exact prefix comparison and compatibility arrays still visit retained payloads.                                                                       |
| Coupled replay       | Persistent placement/ownership roots; tape-local split reader frontiers; compatible cell subdivision; continuous native snapshot/cell roots                        | Invalidation is conservative within a read tape. General preparation still enumerates retained resources, homes and compatibility arrays.             |
| Text projection      | Insertions, exact deletion/replacement and text-only controls update affected flows/ancestors; tape readers include ghost addresses                                | Subtree deletion, dormant births, scaffolds and structural/interpretation changes use full projection. Touched tapes/flows are scanned.               |
| Command preparation  | Publication-local handles, lazy text pieces/native resources, raw ownership reuse between replacement deletion and insertion                                       | Structural compiler queries still use the full projector. Writer synchronization still enumerates retained actions.                                   |
| Managed history      | Exact pre-append text selection staging; text-only Undo/Redo updates visibility locally                                                                            | Structural/property selection staging uses full author projection. Generic control validation still constructs causal arrays.                         |
| Cache eviction       | Drops readiness/author certificates and preimages, private native caches and historical reducer roots; reverse indexes rebuild on the next read                    | Active publications retain shared roots. Cache counts and controlled released-heap deltas do not establish total cache heap or peak candidate memory. |

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
reentrant peer prepend can split a surrogate pair. Both readers have that regression.

Eviction releases publication-native, activity, coupled/projection, readiness and
author-certification caches, including detached certification preimages. It first
cancels suspended readiness validation, then releases its private native branch.
Retained decoded facts and undecoded ingress remain in the canonical store;
reverse dependencies rebuild on the next read. The active publication, live
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

Engine/test source `fc866472c92dba3595af99cafe5466569551efc6` passes the
unfiltered Node suite: 2,252 tests, the same 194 original source skips, 648.45
seconds with three workers. The unchanged frozen 501-group materialization case
takes 292.179 seconds in that suite. No isolated rerun is claimed. The later
formatting commit changes one test's layout only; its compiled JavaScript is equal.
An occurrence audit preserves every previous test after one performance-case
rename and adds 30 cases. Text-control work expectations now assert reusable raw
roots; semantic/frozen assertions, seeds, schedules and deadlines remain unchanged.
Structural rollback still checks checkpoint 128.

Combined MW-10/MW-18 source `d1f8bed01cb01c3573b192be537e677c101b3212`
passes 230 checks across 11 files in 213.92 seconds. It includes the real managed
501-group control, both frozen maintenance traces, journal replacement/retry,
cache eviction, old-prefix edits, restart and the new text/history regressions.
Managed 501 groups use task-state commands, not mixed-text performance. Journal
consolidation reduces batches but can increase serialized bytes. The dependency's
normal conflict resolution and review/merge remain required. No new browser run
is claimed; storage behavior is unchanged.

Focused controls cover unrelated split tapes, transferred ghost addresses,
checkpoints before transfers/new home births, joined traversal readers, cancelled
candidates, marker withdrawal, exact deletion, overlapping peer tags, Unicode,
managed observer recovery, live history after eviction and malformed ranges.
Independent full replay remains the oracle. New short measurement probes retain
exact common genesis bytes, alternating fresh processes and post-timing reference
checks. Reports keep their source/scope and do not establish scale or mixed-history
acceptance. See grain/94's current-stage artifacts for raw reports and limitations.

## Evidence and outstanding gates

Focused checks cover detached exports, concurrent-resource exclusion, exact
certificate reuse, cancellation, old-publication isolation, checkpoint resume
before an undo target, cache eviction/restart, literal commands and managed
observer recovery. Warm literal tests cover 10, 150 and 1,000 paragraphs, asserting
one native tape read, no full-projector call, and two replaced view records for a
root paragraph edit. These checks do not prove the paths in the table's fallback
column. The issue artifacts identify exact source heads and completed runs.

Complete the following before accepting MW-13:

1. Refine tape-local structural reader invalidation to affected intervals. Remove
   retained resource/home enumeration from general suffix preparation. Native
   snapshot/cell construction now reuses continuous roots, but resource validation
   still traverses the inventory.
2. Extend affected-container projection through deletion, dormant births,
   interpretation selection, lifting, wrapper grouping and ordered numbering.
3. Finish lazy writer metadata, action-local structural compilation and structural/
   property history staging without full replay. Exact text replacement and
   text-only history staging now use the local path.
4. Replace whole touched-tape work with affected native interval indexes.
5. Verify cancellation/capacity/withdrawal at the new boundaries against the full
   oracle, including the frozen corpus, generated schedules and real commands.
6. Complete matched whole-command scale/fragmentation, mixed uninterrupted
   10,000-action, strict one-way/catch-up and real MW-10/MW-18 timing/storage/cache
   reports. Keep canonical bytes, journals, cache heap and history metadata
   separate. No core latency target or complete performance pass is established.

Keep draft PR #88 and all outstanding gates open. The earlier measurement and
verification artifacts remain historical evidence for their original source.
