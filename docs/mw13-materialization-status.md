# Incremental multiwriter materialization status

## Current status, 2026-11-09

At source `812417255120f02b796a849d39751db218c43f8b`,
[PR #88](https://github.com/dstoc/grain/pull/88) is open and non-draft for
owner-authorized partial integration into `yjs`, pending required GitHub gates.
It has not merged. The feature branch includes
[PR #95](https://github.com/dstoc/grain/pull/95)'s projection changes,
[PR #96](https://github.com/dstoc/grain/pull/96)'s retained production projection
and narrow author-proof reuse,
[PR #97](https://github.com/dstoc/grain/pull/97)'s prepared-command baseline, and
[PR #98](https://github.com/dstoc/grain/pull/98)'s validated sibling-order reuse
and final-layout repair.

Reference remains the default; `incremental-native` remains an explicit local
opt-in. The independent full reference/oracle, Yjs 13.6.33 and conservative
fallbacks remain intact. No browser cutover, canonical pruning or PR #79
integration is included.

[D, grain/105](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/105), is
Done under the accepted prepared-command baseline. Its matched split/join p50
observations are roughly 83.340/32.571 ms, not a 15 ms pass or replacement
threshold. [E, grain/106](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/106),
and [parent grain/94](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/94)
remain in Escalate with dependencies intact. E's ordinary-text core p50/p95
2/5 ms goals, broader scale/history/storage/heap obligations and uninterrupted
mixed 10,000-action trace remain open. Partial code integration does not complete
E or MW-13 acceptance.

The original overview, behavior table, stage reports and gate list below record
earlier work through `ba5ddc8`. Their present-tense descriptions and draft
instructions are historical and source-scoped. This status snapshot supersedes
older instructions to keep PR #88 draft. Historical failures remain failures.
The [PR #98 evidence qualifications](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/109)
remain applicable, and the six earlier missing-output experiments remain unresolved.

The opt-in reader reuses native state, readiness certificates, activity roots and
coupled placement/ownership checkpoints. Insertions, exact text replacements and
text-only history controls update affected flows and their ancestors. Checked/info edits update affected view records while
preserving unrelated view and address objects. MW-13 remains incomplete. The approved contract is
[proposal v1](proposals/2026-11-05-mw13-incremental-materialization.md).

Select the reader locally through bootstrap's
`materialization: 'incremental-native'`. Reference remains the default. The
selection does not change genesis, envelopes, insertion identities or transport.
Yjs remains pinned to 13.6.33. No browser cutover or canonical pruning is included.

## Current behavior

| Boundary             | Reused work                                                                                                                                        | Remaining cost or fallback                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness            | Reverse dependencies, immutable certificates, actor causal frontiers, ready-membership roots and resource queries                                  | Private readers use a persistent ordered sequence. Explicit diagnostic/public exports still materialize detached arrays. Payload roots and head dependencies update locally.                                                        |
| Author certification | Exact causal native branch; touched-tape refinement; property-only updates query exact author-past resources                                       | Changed ready-payload paths validate retained author branches, including new unappended candidates. Structural actions and property controls still construct causal arrays; different author branches can reconstruct native state. |
| Native publication   | Immutable native tape roots copy affected item/index paths; old views keep prior roots                                                             | Yjs validation and position discovery can still walk retained context. Complete snapshots remain detached exports. Marker refinement and unindexed staging still rebuild affected cell indexes.                                     |
| Activity             | Persistent roots and deterministic suffix replay                                                                                                   | Exact ready roots certify ordered appends. Earlier arrivals and unregistered inputs retain full comparison. Ordinary maps retain full author-branch compatibility checks.                                                           |
| Coupled replay       | Exact append decisions, private activity/ownership forks, per-component coverage and split read intervals; marker-stable text reuses cell topology | Controls, earlier arrivals, selection changes and affected native reads retain conservative suffix replay. Native reader invalidation can still restart at genesis.                                                                 |
| Local projection     | Affected text/properties and ancestor records; direct property overlays; unchanged fragments and addresses                                         | Visibility/tape arrays still traverse retained text. Structural/deletion/interpretation projection and normalization retain full paths.                                                                                             |
| Command preparation  | Literal/property overlays and private activity/ownership forks compare only the candidate action on exact appends                                  | Structural drafts, birth arrays, parser conversion and unindexed native staging retain full paths.                                                                                                                                  |
| Managed history      | Exact pre-append selection staging; local text and checked/info projection; structural staging reuses suffix-replayed ownership on a private fork  | Structural staging still runs full visibility/normalization projection. Structural/property controls retain full author validation.                                                                                                 |
| Cache eviction       | Drops private derived caches and historical roots while active publications stay readable                                                          | Scoped history-navigation heap is measured separately. Total/shared/peak cache and broader mixed-history heap remain open.                                                                                                          |

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
genesis. Old publications keep their original roots. Split readers now retain the marker intervals read by range, adjacency and token queries. New markers outside those intervals do not invalidate the split. Marker-order validation makes position and membership queries stable under subdivision. Reverse-read queries use a persistent endpoint minimum envelope, including mixed overlap. Point and gap minima retain strictly open endpoints. Native read-index construction now copies affected item paths. Marker refinement and unindexed command staging still rebuild affected cell tapes; explicit snapshot and visibility exports remain full.

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

## Command, property and native-interval stage

Engine/test source `c103ad106ca3ee90c42f13bdc0fb98f8f90af2eb` includes compiler
checkpoint `bbb0b6c38f3b21b204dab777fd155b47717179a7` and property/interval
checkpoint `2595b9901ce64c2870fc1b925c20bcb04bd95aa3`. Earlier sources and reports
remain preserved.

Compiler ownership queries fork the committed coupled checkpoint and replay the
unpublished action. Each query starts from the committed prefix. Partial effects
are never committed. Receipt/version guards reject stale branches. Split planning
uses participating tapes and direct home queries. Cold preparation retains full
raw replay. Parser-conversion view queries still use full projection. Managed
structural selection staging reuses a private ownership fork, then runs the full
visibility/normalization projector before append.

Checked and code-info edits stay in command overlays until a structural operation
requires the isolated tree. The draft and compiler flush those properties before
materialization. Exact author-past resource queries certify property-only actions
without cloning the causal closure or reading native tapes. This shortcut accepts
no births, native bodies or interpretation members. Checked/info publication and
owner controls update affected records and ancestors while preserving text
addresses. Presentation/marker changes, mixed groups and hidden/merged targets
retain full projection. Property controls still use full author validation.

Split replay records topology-read marker intervals, including transferred and
joined ranges outside the authored basis. New markers outside a reader's intervals
reuse its prefix. New markers inside a read interval invalidate the first reader.
Withdrawal or reordered retained markers force conservative reconstruction.
Checkpoint forks preserve each prefix's own assignments and read intervals.
Interval matching scans retained ranges on the affected tape. It does not replace
whole touched-tape snapshots or CellIndex construction.

Native clock queries now select overlapping disjoint intervals and return cells
in tape order. Clock order can differ from tape order after later insertions.
Overlapping diagnostic snapshots retain the original coverage/duplicate checks.
The old source reads 11/1,001 cell-fragment lists for one token in 10/1,000-cell
controls; current controls read only the selected cell. The same-tape transferred
split control skips an outside marker and still replays for an inside marker.

A sampled three-cycle structural diagnostic at `2595b99` excludes genesis and the
final cold oracle. About 65% of sampled time is in author certification; retained
occurrence scans dominate its fresh replay. `LayoutPrefix` now builds its own
sequence index during each reconstruction and uses its existing block-owner map
for child queries. Empty boundary queries call `slotSequence` once rather than
11/151 times with 10/150 unrelated births. The independent reference still builds
all inputs and state from scratch. It receives no candidate checkpoints or
materializer state. Pure ordering and cycle rules remain unchanged.

Verification is source-scoped:

- `bbb0b6c`: broad Node 2,285 passed; two short trace audits pass separately.
  Together they cover 2,287 cases with only the two long history-limit cases
  deferred and the original 194 skips. The raw broad filter excluded four names;
  the audit preserves that distinction.
- `2595b99`: broad Node 2,305 passed, exactly the two long cases filtered and the
  original 194 source skips. Every prior occurrence is preserved; 24 cases were
  added over `5f09381`.
- `c103ad1`: broad Node 2,308 passed, the same two explicit filters and 194 source
  skips. The runtime occurrence inventory preserves all previous cases and adds
  27 over `5f09381`. The unchanged materialization and independent-reference 501-group cases pass separately in 278.386 and 220.739 seconds. The joined runtime audit covers all 2,310 runnable Node cases plus 194 source skips. This is partitioned coverage, not one unfiltered command.
- Combined MW-10/MW-18 source `55387b17887989dc40e1386161e57845381897b0` passes
  272 checks in 18 files. Coverage includes real managed 501 groups, both frozen
  maintenance traces, strict one-way/catch-up, consolidation/retry, cache eviction,
  old-prefix editing/restart and the new compiler/property/interval controls.
  This remains correctness/storage evidence rather than mixed-text performance.

Build, web build, lint, format, boundaries, both Knip modes and all five benchmark
harness checks pass at `c103ad1`. No assertion, source skip, seed, schedule, restart,
or retention deadline was weakened. The frozen materialization retention case was
not repeated per edit. Normal dependency conflict resolution/review/merge remains
required for PR #79. No fresh Chromium run is claimed.

At benchmark source `4bdee7253ad5f6168464e171d92fbf49b0b602a0`, three
alternating fresh-process structural/task triples and three cache-eviction pairs
complete on the exact retained 150-paragraph genesis or a separately retained
150-task-item genesis. Both retain real managed history and native selection;
cold reference checks stay outside timed intervals. The first two of six cycles
are warm-up. Values below are medians of three per-process p50/p95s.

| Whole command      | Candidate p50/p95 ms | Prior source p50/p95 ms | Current full reference p50/p95 ms |
| ------------------ | -------------------- | ----------------------- | --------------------------------- |
| Split              | 846.956 / 1,090.888  | 4,012.584 / 6,045.769   | 1,167.724 / 1,478.650             |
| Join               | 664.087 / 846.078    | 2,942.749 / 4,258.180   | 952.932 / 1,178.669               |
| Task checked state | 46.664 / 65.821      | 1,023.956 / 1,032.445   | 525.635 / 538.512                 |

Candidate structural Undo/Redo p50 is 417.563/425.068 ms; task Undo/Redo is
106.670/106.057 ms. The structural target is not met at this source. These are
shallow whole-command observations, not core phases or portable budgets. They do
not describe the later initial-property lookup source. The prior source is
`45a86d4` (engine `5f09381`); full reference uses the same current source and
accepted managed history, not the pinned pre-MW-10 baseline.

Three 64-group literal eviction pairs release median candidate process heap of
5,777,432 bytes with canonical export, active publication and history fixed.
Median before/after heap is 34,083,024/28,303,208 bytes. This is uniquely released
whole-process heap, not total/shared/peak cache or isolated history heap. The
writer still retains its 63-action ready root plus one appended-ahead identity;
all 64 canonical facts remain. Eviction takes 0.329 ms excluding GC and the next
edit takes 515.242 ms including reconstruction. Timed workers attach no journal.
Native/canonical/descriptor/serialized-history fields remain separate.

A subsequent full-projector lookup stage is pinned to engine/test/benchmark source
`7b9417b50cf69fc375479d5c5c38cef39a6bc75c`. Initial-property validation now
builds a fresh set of retained node origins instead of scanning allocations for
every initial property. Duplicate/unknown rejection and full reconstruction remain.
The 150-node old guard makes 23,250 resource-key calls before its first native
snapshot; the new linear-work bounds pass. The three controls preserve rejection
behavior and fail on the old lookup where expected.

This latest source passes 2,311 Node cases with exactly the two long history-limit
cases filtered and the original 194 skips. Runtime auditing preserves all previous
occurrences and adds 30 over `5f09381`. Build/web/lint/format/boundaries/both Knip
modes and all five expanded harness checks pass. The frozen reference-factory
retention descriptors omit initialProperties, so the new set branch is unused
there. Per the approved cadence those unchanged long cases were not repeated for
this lookup edit; their `c103ad1` isolated evidence remains above. No new complete
latest-source/unfiltered pass is claimed. Combined head
`124ad2212e7da47ae8def566b387f54bdaf226cc` passes 82 affected checks; the
full combined 272-case report remains pinned to `55387b1`.

Three alternating replacement pairs at 1,000 paragraphs complete at `7b9417b`,
reusing the same retained genesis bytes captured before the lookup edit. Six real
managed replacements carry native selection; the first two warm up. Candidate
whole-command median per-process p50/p95 is 5.062/6.770 ms. Full reference is
7,785.771/7,892.091 ms. One actual Undo/Redo runs per process, and each completed
process compares its exact final state with cold full reference outside timing.
This does not establish core-phase, structural, fragmentation or mixed-10k gates.
Controlled-GC process readings include the synthetic genesis, instance, writer,
history and runtime; they are not total/shared/peak cache measurements.

At `7b9417b`, the 5,000-paragraph paired replacement workload did not complete
before the previous run ended. Its exact 19,433,457-byte synthetic genesis and interrupted report are retained.
No 5,000-paragraph pair is verified. A separate candidate-only probe reached its
240-second benchmark limit before returning a cold-reference comparison (exit
124), so it supplies no verified latency sample. This benchmark limit changes no
correctness-test deadline. The 1,000-paragraph six-process result is complete;
the overall wide report stays incomplete. No extrapolated 5k or mixed-10k result
is claimed.

A final three-cycle profile at `7b9417b`, with other workers stopped, still attributes about 38.5% inclusive sampled time to publication refresh, 26.6% self samples to resourceKey and 22.3% to structuredClone. Nested inclusive samples overlap; these are cost diagnostics, not core-phase wall times or a matched speedup.

The stage artifacts retain all raw samples, exact fixtures, source inventories,
negative controls, scripts, CPU profile and interrupted development diagnostics.
No prior evidence is relabeled as the latest source. Remaining scale, memory,
projection, compatibility, mixed-10k and real maintenance performance gates stay
open. PR #88 remains draft and PR #79 still needs normal conflict resolution,
independent review and merge.

## Indexed metadata, fresh reconstruction and matched maintenance stage

Engine/test/benchmark source `81ea0185d66e988b7d36a62bf99e5e7a9cc5102d`
adds persistent topology-read interval roots and exact ready-root suffix
compatibility. Activity, text/property publication and unpublished staging avoid
retained payload comparisons. Controls update indexed target positions. Ready
payload roots update changed facts; heads follow current ready dependencies,
including fork withdrawal. Stale reverse edges cannot suppress a head. The ordered
ready array and ingest author-branch compatibility remain retained-state work.

Fresh home/allocation/collection lookups rebuild indexes from each invocation's
own input. Both layout reducers validate complete changed slot sequences, including
retained anchors. The full reference still reconstructs its input independently;
it receives no candidate checkpoints. Negative controls detect prior quadratic
home/occurrence lookups, 1,005 fact lookups for one suffix, and 151 sequence
validations for one changed sequence. Changed-sequence tests also reject new-anchor
cycles. Interval controls compare with fresh scans through marker subdivision,
text shifts and retained checkpoints; mixed-overlap lookup remains a stated limit.

All 2,336 ordinary runnable Node cases pass across broad plus isolated reports,
with the same 194 source skips. The audit preserves every incoming occurrence and
adds 23 cases. The unchanged materialization/reference retention cases pass alone
in 269.074/219.645 seconds, without competing workers. This is partitioned coverage,
not one unfiltered invocation or a portable timing guarantee. Both opt-in
1,000/5,000-paragraph production-bootstrap checks also pass. Build, web build, lint,
format, boundaries, both Knip modes and all seven benchmark/GC controls pass.
No fresh Chromium run or CI completion is claimed.

Combined source `cb986dc8ddf82b6b3ae27837c1b6bd85233e2cec` passes 350
checks in 27 files. The real managed 501-group case takes 36.797 seconds; the
frozen checkpoint/history case takes 127.870 seconds. This includes strict
one-way/catch-up, old-prefix identity, restart, journal replacement/retry, native
observer failures and current metadata/layout controls. PR #79 still requires
normal conflict resolution, independent review and merge.

Matched reports keep exact source and workload boundaries:

- At `17cab90`, three alternating 5,000-paragraph replacement pairs complete on
  the original retained 19,433,457-byte synthetic genesis, SHA-256
  `a542c387bb95a8ba98db5fb3b0a6d8fe95467f5f7183364607f6ec9050e17afe`.
  Materialized whole-command median per-process p50/p95 is 6.887/8.775 ms;
  Undo/Redo is 86.325/85.610 ms. Every process includes an independent cold
  comparison outside timing. These timings do not belong to later source `81ea018`.
- At `81ea018`, three retained 150-paragraph replacement pairs measure actual
  managed selection/edit/Undo/Redo. Whole-command p50/p95 is 4.639/4.938 ms;
  refresh/resume is 1.441/1.685 ms. Append, certification and staging are separate
  public boundaries. Nested durations overlap; they are not exclusive internal
  phases, browser latency or complete core-budget acceptance.
- Three current structural triples compare incoming `21e3dea`, candidate and
  current full reference on the original 150-paragraph genesis. Candidate
  split/join p50 is 746.602/567.473 ms versus 840.177/648.237 ms incoming.
  The structural target remains unmet. All nine processes verify by cold reference.
- At `cb986dc`, three alternating maintenance pairs retain one new exact task
  genesis and execute 501 real managed groups, 500-to-2 history limit, strict
  forward send/retransmission, actual MW-18 consolidation, cache eviction,
  checkpoint restart and same-instance old-prefix catch-up. Materialized task
  edit p50/p95 is 5.446/10.493 ms; consolidation is 4,772.313 ms and checkpoint
  opening is 4,888.411 ms. The journal is memory-backed; these are not disk or
  IndexedDB latency results. Its first paired process consolidates 504 batches
  and 188,416 bytes into a 201,576-byte checkpoint. Canonical facts stay unchanged.
  Serialized navigation metadata falls from 242,369 bytes at 500 groups to 991
  bytes at two groups; those values are not heap. Post-restart tail accounting
  includes the new attachment seed and admitted ingress. This property-only
  one-task workload does not establish wide/mixed-text or long-lived 10k gates.

The issue's metadata/layout-stage artifacts retain raw samples, source inventories,
exact fixtures, scripts, work negatives and the diagnostic profile. No current
measurement establishes total/shared/peak cache or history heap. Reference remains
default; Yjs remains 13.6.33. No canonical pruning or browser cutover is included.

## Coverage, ordered reads and mixed-trace stage

Engine/test/benchmark source `9e7b82383049ca460db665f588d286c1a005ae65`
adds per-component raw coverage certificates, endpoint minima for mixed native
reads, bounded range seeking, persistent coverage membership refinement, exact
changed-payload author retention, and private ordered ready sequences. Public
snapshots and explicit diagnostic arrays remain detached full exports. Native
snapshot/cell construction, general structural compatibility and projection,
structural drafts, and total/shared/peak cache and history heap remain open.

Each coupled checkpoint owns its coverage membership. Births, assignments,
attachments, joins and standalone moves invalidate affected root components.
Native subdivision refines each prefix's own memberships. Duplicate emission,
unreachable cells and reserved-home ownership remain checked. Cold replay needs
one complete genesis certificate. Changed components can still be large.

The endpoint envelope stores separate point/gap minima to preserve strictly open
read boundaries. Three synthetic fresh-process pairs query the mixed-overlap
control in 14 nodes versus 3,472. Median 1,000-query batch time is 0.139 versus
29.237 ms; construction is slower, 44.336 versus 13.120 ms. These ordinal-position
microprobes do not measure native integration or heap. Native range reads seek
by position and visit the requested parts; whole touched-tape construction is
still a cost.

All 2,349 ordinary runnable Node cases pass across broad plus isolated reports,
with the original 194 source skips. The occurrence audit preserves every incoming
case and adds 13. This is partitioned coverage. The unchanged materialization and
reference retention cases pass alone in 266.563/218.237 seconds. Both opt-in
1,000/5,000-paragraph bootstrap cases pass separately. Build/web/lint/format,
boundaries, both Knip modes and seven benchmark/GC controls pass. No new Chromium
or completed CI result is claimed.

Combined MW-10/MW-18 source `c280f563e8c0b4873943fe5ac19ba42f3eec0dcf`
passes 388 checks in 35 files and build. Managed 501 groups take 36.869 seconds;
the frozen checkpoint/history case takes 127.744 seconds. This retains the prior
maintenance, old-prefix, retry/restart, transport and observer-failure coverage.
PR #79 still requires normal conflict resolution, independent review and merge.

Three alternating structural triples on the original retained 150-paragraph
genesis compare incoming `10a2563`, this candidate and current full reference.
Candidate split/join median per-process p50 is 505.107/387.069 ms, versus
786.136/576.820 ms incoming. The 15 ms target remains unmet. Three retained
150-paragraph replacement pairs give candidate whole-command p50/p95
4.523/5.044 ms and public refresh/resume 1.481/1.700 ms. Public API envelopes can
overlap; they are not exclusive internal phases or a complete core-budget pass.
The completed 5,000-paragraph report remains scoped to `17cab90`, not this source.

A separate continuous probe uses the retained 150-task fixture, independent
isolated commands, real directional providers and separate memory journals. Per
100 actions it requests 80 replacements, 16 task edits, split, join, Undo and Redo.
A rejects B's old-prefix updates while outbound-only; strict unacknowledged sends
to C occur at 1,000-action checkpoints. The 35-minute guard stops the attempt in
authoring: 2,900 source/control actions reached checked checkpoints and 2,990
complete original carrier frames were saved. No assertion failure was reported.
This is an interrupted prefix, not a completed or verified 10,000-action trace.
Final long-run catch-up, consolidation, restart and cold checks were not reached.
The same script's separate 100-action smoke completes those checks.

The saved outer prefix reconstructs 2,990 envelope records: 2,904,145 envelope
payload bytes, including 74,472 embedded native insertion bytes, and 2,933,952
canonical actionDoc bytes. These are not journal or cache heap measurements.
The original V8 genesis fixture is separate. Sampled process heap includes
multiple replicas, canonical facts, caches, history and runtime; it does not
attribute total/shared/peak cache or actual history heap. Do not stitch a restarted
prefix into an uninterrupted result.

A diagnostic profile reopens the exact 100-action prefix and warms a fresh
writer. Continued replacement has zero full projections and zero native-reader
invalidations. Split/join each invalidate a reader and replay 102/103 actions
from genesis. All profiled commands match independent cold reconstruction.
Sampling and fresh-writer costs make this diagnostic unsuitable for matched
latency claims. It identifies a structural replay frontier to investigate; the
mixed slowdown must not be attributed solely to the general visibility gate.

## Native roots, retained cells and fragments stage

Engine/test source: `11216a9905ef3306aaf95b7703b386e61852ab90`.
Combined MW-10/MW-18 source: `0af6b0e69f8fda9eb61c4fa74a71d4b71129801e`.
The four commits add exact structural append decisions and private activity forks,
persistent checked/info overlays, affected-item native indexes, marker-stable cell
reuse and unchanged fragment reuse. New native indexes preserve final Yjs item
segmentation, including merges with retained text. Scalar UTF-16 ownership accepts
both surrogate units; mutation/range boundaries retain Unicode checks. Native
reader invalidation remains conservative.

All 2,366 ordinary runnable Node cases pass across broad plus isolated reports.
The occurrence audit preserves every incoming case and the original 194 source
skips, with 17 additive cases. The unchanged materialization/reference retention
cases pass alone in 272.553/218.252 seconds. Both opt-in wide-bootstrap cases pass.
Build/web/lint/format/boundaries/both Knip modes and all seven benchmark/GC controls
pass. Combined integration passes 405 checks in 39 files and build; real managed
501 groups take 35.311 seconds and frozen checkpoint/history takes 127.637 seconds.
These are source-scoped partitioned reports, not one unfiltered invocation. No new
Chromium or completed CI result is claimed.

Three alternating fresh-process native pairs use exact original carriers. At
4,096 fragments, candidate native integration/index p50/p95 is 2.794/3.827 ms
versus 14.224/17.458 ms incoming. It indexes 24 affected items across 24 inputs
versus 196,956 complete tape parts. This native-only fixture excludes Markdown
layout, visibility, authoring and history; it does not prove full core budgets or
cache heap. At 64 fragments the corresponding timings are 0.294/0.395 versus
0.445/0.560 ms.

Three structural triples retain the original 150-paragraph fixture. Candidate
split/join median per-process p50 is 519.984/394.030 ms, versus 510.491/396.069 ms
incoming. Structural latency targets remain unmet. Three current/reference
replacement pairs give candidate whole-command p50/p95 4.819/5.187 ms, versus
409.442/417.863 ms full reference. Three shallow task pairs on the retained
150-task genesis give 0.925/1.236 ms versus 1.681/1.877 ms incoming. API envelopes
can overlap; these are not exclusive core timings or retained-depth acceptance.

Exact 1,000-action prefix diagnostics at 94db930 and 11216a9 cold-match all five
commands. Replacement stays local. Split/join still replay 1,002/1,003 actions
from genesis; Undo/Redo resumes at 896 and replays 108/109. Whole-command sampled
timings remain materially unchanged. The first CPU sample is too late to isolate
the replacement phase by its nominal duration; no phase-cost conclusion is drawn.
The original prefix remains diagnostic input, not a resumed long run.

The actual MW-10 navigation-root heap probe authors 501 replacement groups on
150 tasks. V8 strong-edge graph accounting finds 5,218,696 retained bytes through
500 navigation groups, versus 23,304 bytes after limiting history to two. The
session shell is a separate 200 bytes. Navigation data is counted once and split
into exclusive/shared reachability; raw full-GC snapshots and an owned/shared
control are retained. Canonical/native bytes remain unchanged through history and
cache eviction; continued Undo/Redo cold-matches reference. This scoped graph
method is not total session-driver memory, total/shared/peak cache attribution,
physical storage, or broad mixed-history heap acceptance.

The new combined 150-task 10,000-action attempt ends incomplete (exit 124) during authoring. Its unchanged 2,100-second guard preserves 3,000 checked source/control actions and 3,000 complete original carrier frames, with 0 trailing unparsed bytes. No restarted prefix is an uninterrupted result. The final long-run maintenance/catch-up/restart/cold sequence is not completed.
The separate 100-action smoke completes the full final sequence. The original
framed prefix reconstructs 3,000 outer records,
2,949,597 envelope payload bytes including
74,899 native-insertion bytes, and
2,976,505 full actionDoc bytes. Outer-byte analysis
does not certify semantic readiness or full projection. Memory-backed journals,
diagnostic disk framing and sampled whole-process heap do not close physical
storage or cache/history memory gates.

The `native-interval-stage-verification`, `native-interval-stage-measurements`
and `history-navigation-heap` issue artifacts retain exact sources, scripts,
fixtures, raw samples and verified catalogs. Earlier artifacts and reports remain
scoped to their original sources; the completed 5,000-paragraph report still
belongs only to 17cab90. PR #79 still needs normal conflict resolution,
independent review and merge. Keep PR #88 draft.

## Structural visibility and retained native reads

Final engine/test source is `ba5ddc8`; combined MW-10/MW-18 source is `838eea2`.

Structural and pre-append selection projection index exact-text deletion ranges by native tape/client clock. A query returns each covering declaration's position in the selected activity sequence. Exact/subtree matches merge before tag deduplication. This preserves first-covering order when a tag is reused; its first global declaration can cover another character. The independent reference still scans the declarations. A real admitted-action regression and exact/mixed-subtree controls retain this contract.

Registered immutable NativePlan roots answer untouched reads directly. The first write loads that tape; arbitrary facades keep snapshot behavior. Local projection reads native ending markers and home text intervals without full marker-snapshot exports, and reads each run layout once. History uses direct, cached run lookups. Affected-tape text ordering still traverses retained text. Native-reader invalidation and coupled replay gates remain unchanged.

All 2,377 ordinary runnable Node cases pass across the broad run and two isolated semantic retention runs. Every incoming occurrence and the original 194 source skips remain, with eleven additive cases. The unchanged materialization/reference cases pass alone in 275.324/228.663 seconds. Both opt-in wide-bootstrap cases pass separately. Build/web/lint/format/boundaries/both Knip modes and all seven benchmark/GC controls pass.

Combined integration passes 416 checks in 43 files and build. Its occurrence audit preserves all prior 405 cases/39 files. Real managed 501 groups take 36.308 seconds; frozen checkpoint/history takes 124.960 seconds. All 48 existing IndexedDB provider/checkpoint tests pass on installed headless Chromium 156.0.8078.73 at the combined source.

This is partitioned evidence, not one unfiltered invocation. Earlier f10199d/cdd8db3 reports precede the shared-tag correction; the production-Knip failure and corrected development controls remain archived separately.

Three alternating fresh-process structural triples reuse the original 150-paragraph fixture. Candidate split/join median per-process p50 is 522.255/397.893 ms versus 530.412/409.020 ms incoming. No material structural whole-command improvement or 15 ms target pass is established. Undo/Redo is 281.834/288.167 ms.

Three current/reference replacement pairs give candidate p50/p95 4.739/5.166 ms versus 433.290/468.892 ms. Three shallow task pairs give 0.958/1.239 ms versus 1.033/1.512 ms incoming. These are whole-command observations; public phase envelopes overlap and do not establish exclusive core budgets.

The corrected 100-action profile cold-matches replacement/split/join/Undo/Redo. Replacement replays one action; split/join still replay 102/103 from genesis. Undo/Redo replay 104/105 from genesis at this depth. The separate pre-fix 1,000-action profiles are not final-source measurements.

The supplemental XFS-backed Chromium IndexedDB probe completes three alternating fresh browser-process pairs. It records strict transaction completion, logical journal payloads and separate IndexedDB directory logical/allocated file bytes at history/cache/consolidation barriers. Pending original outer carriers survive checkpoint and fresh-connection restore; old prerequisites unlock them. Independent cold reconstruction and browser-process reopen pass. The workload is 24 managed replacements with four warm-up edits; candidate-only cache eviction is outside matched timing. JSON navigation size is not heap. This does not close 501-group physical storage, broad mixed history or total/shared/peak cache acceptance.

The cdd8db3 long attempt was cancelled for the ordering correction (exit 130), before its unchanged 2,100-second guard. The last saved source/control comparison is action 1,300; 1,391 complete original frames remain with no truncated tail. Outer reconstruction has 1,391 records, 1,240,854 envelope payload bytes including 34,684 embedded native bytes, and 1,254,656 actionDoc bytes. This is not semantic readiness, full projection, storage-journal size or heap acceptance. It is separate from the historical v11 3,000-frame attempt; neither prefix can be stitched into an uninterrupted result.

No fresh 10,000-action attempt starts at the corrected source: its unchanged 2,100-second guard plus handoff time cannot fit the remaining supervisor window. The unchanged separate 100-action smoke completes all final one-way/retransmission, maintenance, cache/history eviction, same-instance catch-up, restart and independent cold checks.

Artifacts `structural-visibility-stage-verification` and `structural-visibility-stage-measurements` retain exact sources, raw samples, inputs, scripts, negatives and verified catalogs. PR #88 remains draft. Required structural/native/draft, remaining scale/fragmentation, mixed-10k, memory, physical-storage breadth and dependency/browser-cutover gates remain open. No completed CI or browser editor/physical IME acceptance is claimed.

## Evidence and outstanding gates

Focused checks cover detached exports, concurrent-resource exclusion, exact
certificate reuse, cancellation, old-publication isolation, checkpoint resume
before an undo target, cache eviction/restart, literal commands and managed
observer recovery. Warm literal tests cover 10, 150, 1,000 and 5,000 paragraphs, asserting
one native tape read, no full-projector call, and two replaced view records for a
root paragraph edit. These checks do not prove the paths in the table's fallback
column. The issue artifacts identify exact source heads and completed runs.

Complete the following before accepting MW-13:

1. Finish interval-local native position discovery, marker/cell refinement and
   unindexed command staging. Merged native items can include retained text;
   current snapshots and visibility arrays still traverse complete touched tapes.
2. Complete general structural decision/author compatibility and refinement
   replay. Preserve exact author closures, private-home adjacency, native marker
   order and cohorts. Do not remove conservative gates without proof.
3. Extend affected projection through subtree deletion, dormant births, scaffolds,
   interpretation, lifting, wrapper grouping and ordered numbering.
4. Complete structural drafts, birth arrays and pre-append selection staging.
   Private activity forks and append certificates do not remove those full paths.
5. Attribute total/shared/peak materialization-cache and broader actual history
   heap without double-counting roots. The scoped navigation study is separate.
6. Complete remaining matched scales, long tapes, wide siblings and fragmentation;
   uninterrupted mixed 10,000-action pairs; long-lived directional catch-up;
   physical storage and broader real MW-10/MW-18 maintenance measurements. Preserve
   every independent oracle, assertion, trace, seed, schedule, deadline, canonical
   fact, pending carrier and original identity.

Proceed with the owner-authorized partial integration of PR #88 only after the
required GitHub checks and independent review pass for the integration head.
Keep E and full MW-13 acceptance open. Earlier measurements and verification
artifacts remain historical evidence for their original sources.
