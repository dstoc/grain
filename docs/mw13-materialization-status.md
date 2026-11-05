# Incremental multiwriter materialization status

The opt-in reader reuses native state, readiness certificates, activity roots and
coupled placement/ownership checkpoints. A narrow literal-input path updates the
affected text flow and its ancestors while preserving unrelated view and address
objects. MW-13 remains incomplete. The approved contract is
[proposal v1](proposals/2026-11-05-mw13-incremental-materialization.md).

Select the reader locally through bootstrap's
`materialization: 'incremental-native'`. Reference remains the default. The
selection does not change genesis, envelopes, insertion identities or transport.
Yjs remains pinned to 13.6.33. No browser cutover or canonical pruning is included.

## Current behavior

| Boundary             | Reused work                                                                                                  | Remaining cost or fallback                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness            | Reverse dependencies, immutable certificates, actor causal frontiers and resource queries                    | Ordered ready/head/variant arrays are still rebuilt. Public `snapshot()`/`compute()` exports deliberately clone detached diagnostics.          |
| Author certification | Exact causal native branch; touched-tape text/refinement checks; exact local certificate reused after append | Structural and control validation still materialize full causal arrays. A different author branch can reconstruct native state.                |
| Native publication   | New bodies integrate once; old views retain immutable roots                                                  | The affected tape is still indexed as a whole. Long tapes require interval work.                                                               |
| Activity             | Persistent roots and deterministic suffix replay                                                             | Exact prefix comparison and compatibility-array construction still visit retained payloads.                                                    |
| Coupled replay       | Persistent placement forests, ownership maps, attachments, cohorts and structural intentions                 | Existing-tape marker changes conservatively replay from genesis. The general preparation path still enumerates native snapshots/resources.     |
| Text projection      | Affected tape/flow and ancestor path; unchanged nodes and addresses retain identity                          | Deletions, inactive births, scaffolds and structural/interpretation changes use full projection. The touched tape/flow is still scanned.       |
| Command preparation  | Publication-local handle indexes, lazy text pieces and native-resource access                                | Structural compiler queries still use the full projector. Ready metadata and writer synchronization still enumerate retained actions.          |
| Managed history      | Existing MW-10 semantics and private literal selection staging                                               | Non-literal or visibility-changing selection staging still constructs a full author projection. Managed and unmanaged timings remain separate. |

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
A late control invalidates its earliest affected target, even when the control
itself sorts later. Existing-tape native marker changes currently invalidate all
structural checkpoints. This conservative fallback includes the zero-action
checkpoint: its old cell partition is not compatible with new markers.

Preparation returns a candidate. The reader commits activity and projection only
after complete publication. Cancellation, failure or changed receipts preserve
the previous tuple. Old native/ownership/view reads remain valid after later
commits and cache eviction. Work counters can include attempted candidates;
`lastReplayFrom` and `lastReplayLength` describe committed replay.

Private managed literal staging uses the same flow projection against the writer’s
exact native draft before append. It captures stable selection without committing
activity, ownership or projection roots. Rejection leaves canonical facts and local
history unchanged. Reentrant peer changes after append do not alter that captured
author result.

The local text path requires one new final action, identical retained payloads,
no new allocations or marker births, a continuous native branch, and unchanged
visibility/interpretation decisions. It admits only insertion effects. It keeps
full diagnostic action/effect/text arrays lazy. New text cannot enter an existing
exact syntax mask because it has fresh native identities.

Eviction releases publication-native, activity and coupled/projection caches. It
retains the active publication and canonical facts. Readiness certificates and
the separate author-certification cache still need explicit eviction accounting.
MW-18 journal consolidation remains a separate operation on the integration
branch. A cached projection is never a canonical checkpoint.

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

This work does not yet replace full touched-tape index construction, conservative
structural marker invalidation or general projection. The issue's profiling
artifacts record the source and limits of each measurement.

## Evidence and outstanding gates

Focused checks cover detached exports, concurrent-resource exclusion, exact
certificate reuse, cancellation, old-publication isolation, checkpoint resume
before an undo target, cache eviction/restart, literal commands and managed
observer recovery. Warm literal tests cover 10, 150 and 1,000 paragraphs, asserting
one native tape read, no full-projector call, and two replaced view records for a
root paragraph edit. These checks do not prove the paths in the table's fallback
column. The issue artifacts identify exact source heads and completed runs.

Complete the following before accepting MW-13:

1. Replace conservative marker fallback with structural reader invalidation and
   compatible cell refinement. Remove full resource/native enumeration from the
   general suffix preparation path.
2. Extend affected-container projection through deletion, dormant births,
   interpretation selection, lifting, wrapper grouping and ordered numbering.
3. Finish lazy writer metadata, action-local structural
   compilation and non-literal managed-history staging without full replay.
4. Replace whole touched-tape work with affected native interval indexes.
5. Verify cancellation/capacity/withdrawal at the new boundaries against the full
   oracle, including the frozen corpus, generated schedules and real commands.
6. Complete matched whole-command scale/fragmentation, mixed uninterrupted
   10,000-action, strict one-way/catch-up and real MW-10/MW-18 timing/storage/cache
   reports. Keep canonical bytes, journals, cache heap and history metadata
   separate. No core latency target or complete performance pass is established.

Keep draft PR #88 and all outstanding gates open. The earlier measurement and
verification artifacts remain historical evidence for their original source.
