# MW-13B: conditional subdivision and indexed coupled replay

This implements grain/103's approved mechanism from
[A's structural locality contract](mw13a-structural-locality.md). It preserves
the independent reference default and Yjs 13.6.33. B does not complete grain/94,
replace C's projector, or replace D's author/certification path.

## Reuse condition

`materialization/subdivision.ts` maps each changed old cell to its ordered native
descendants. `coupled.ts` first verifies retained marker identities, native
bindings, and order on a continuous native branch. It then checks home
classification. Each ordinary content cell expands in place. A reserved cell
may expand only into reserved cells if a historical split reads that interval.

This is a certificate about each checkpoint's own assignments. It does not
derive old owners from the latest ownership result. `refineCheckpoint()` forks
the checkpoint's owners, assignment counts, coverage, and structural dependencies.
It installs no home born after that checkpoint. Original markers and their sides
keep their meaning. Newly inserted markers add distinct addressable gaps.

An ordinary-cell refinement preserves the content traversal and the selected
contiguous segment of an unchanged historical split. Fixed transfers expand
pointwise. Original basis/occurrence keys remain cohort identities; changed tape
and placement dependencies cause native cut ranks to be recomputed. Placement
and ownership still execute together, in semantic effect order.

A reserved cell gaining an ordinary descendant violates that premise. The
retained interval-reader index finds its first affected active split. B restores
a compatible checkpoint before that reader and replays the exact suffix. A's
joined-empty-home two-marker counterexample still produces `ac` / `b`, while
unconditional checkpoint subdivision would produce `a` / `bc`.

An inactive split provides no permission to reuse its old decision after redo.
Reactivation changes its original activity certificate and restores/replays from
before the split against the current native subdivision.

## Ordered facts and resource checks

The ready root certifies exact retained payloads. A causally subsequent ordered
append checks only new payloads and explicit control targets. The payload table
also stores certified layout inputs at their semantic positions. Known suffixes
read this table instead of materializing, deduplicating, or sorting the complete
log. Appended packet selection and controls of packets retain full selection
validation. Earlier arrivals and replaced/withdrawn payloads retain the audit
comparison and fallback.

A supplied suffix must match the ready root's action order and exact bodies.
Detached bodies are compared with their encoded payloads. Inputs without a
compatible ordered certificate take the complete ordering audit before B builds
its position, resource, or replay tables; those tables cannot disagree on order.

Ordinary text/property activity does not change the raw coupled graph. Its
activity delta still reaches projection. Marker allocations and all permanent
births enter resource validation at their actual action; an outer text command
does not hide those structural dependencies.

`OwnershipResources` retains allocation, marker, home, and flow lookup tables.
Suffix validation visits new allocations and changed tapes. Home arrays and full
snapshot inventories are explicit lazy exports, not prerequisites to replay.
The independent/audit path still performs full resource validation.

`StructuralIndex` stores destination and cohort dependencies in checkpoint-owned
persistent maps. Changed assignments, block placements, flow intentions, and
native tapes invalidate their actual readers. It preserves inactive occurrences
and ghost traversal paths. A move can legitimately revisit many old intentions
for the same node/flow; a split elsewhere does not visit them. Requirements and
cohort exports are lazy, cached reads. The independent reducer still reconstructs
them from all original facts.

Split replay resolves the reference owner's top-level flow through indexed
placement ancestry and reads the newborn node directly by ID. It never exports
the complete node/flow inventories to find either record. Inventory exports and
affected flow-ancestor visits have explicit work counters. The bounded regression
grows unrelated split births at depths 0, 8, and 32 and forbids both inventory
getters during isolated B preparation. Full projector callers still export
inventories; those costs remain visible outside the isolated replay gate.

## Candidate output and publication

General `MaterializedOwnership.prepare()` returns `value.changes`. The specialized
text/property preparation returns `structuralChanges`; its existing `changes`
field continues to mean the affected text/property actions. Both use
`StructuralChanges` from `subdivision.ts`:

- Exact base genesis, ready/native identities, and opaque checkpoint identity.
- Candidate ready/native identities, private preparation revision, and opaque
  checkpoint identity.
- Ordered payload/activity certificate changes, including control targets and
  removals, plus the affected original actions.
- Ordered cell subdivisions with old/new reserved classification, assignment
  differences, block/flow/occurrence/run changes, roots, and ghost attachments.
- Exact before/after destination requirements and cohort entries, including
  withdrawals, so projection need not force their complete lazy exports.
- Changed native tapes and an explicit replay frontier/reason.

The changes describe raw structural resources and semantic inputs. C derives
visibility, masks, normalization, and view/address records from those inputs.
The returned tapes include address changes even when visible text is unchanged.
An action that loses readiness is a retraction from these derived roots; its
canonical envelope and native identities remain retained.

Preparing does not publish, accept, or add history. Cancellation or another
preparation invalidates commit. Forks have separate generations and counters.
Only the existing publication owner commits the complete tuple. Old publications
and checkpoints keep their own roots. At most eight periodic checkpoints are
retained; this mechanism does not retain all historical materialized versions.

## Fallbacks

| Reason                         | Behavior                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `append`                       | Resume the committed prefix; consume the known suffix.                                                                                 |
| `content-subdivision`          | Refine checkpoint-owned assignments, coverage, and slots; consume the suffix.                                                          |
| `reserved-content-reader`      | Restore before the first affected adjacency reader; replay from there.                                                                 |
| `changed-order-or-activity`    | Compare exact payload/decision certificates and restore a compatible earlier checkpoint. Packet selection can require full comparison. |
| `native-withdrawal-or-reorder` | Rebuild resources and replay from genesis. A discontinuous native branch or changed genesis also uses this conservative path.          |
| `cold`                         | Build fresh resources and coupled state.                                                                                               |

`lastReplayReason` reports the committed path. Attempted work remains in the
diagnostic ledger; commit counters remain separate. A failed candidate cannot
install refined readers, cohorts, or new mutation addresses.

## Verification boundaries

`execution.test.ts` guards retained array entries so a certified append fails if
B reads them. It compares action/effect/candidate work after unrelated text and
layout history, and compares complete raw observations with a fresh reference.
A separate test changes a component and checks that its historical placement
readers are visited. Payload withdrawal must retract marker addresses and force
fallback. Candidate cancellation and competing preparation cannot commit.

The native differential matrix retains both affinities, original cuts, reserved
edges, empty gaps, ghost transfers/joins, cohorts and moved roots, earlier
concurrent effects, deleted/cross-tape addresses, and Unicode boundary rejection.
The dormant reserved-home negative verifies reactivation separately. Existing
checkpoint, controls-before-target, old-publication, eviction/restart, and network
tests remain part of the verification surface.

The public command path still has C/D work: full provenance/projection and
author-closure reconstruction can enumerate unrelated history outside B. B's
guarded unit interval deliberately excludes those callers. Public diagnostic
reports retain their counts; a local replay improvement is not an end-to-end,
storage, browser, memory-scale, or uninterrupted long-run claim. Reference checks
stay outside candidate timing, and protective stops remain incomplete evidence.
