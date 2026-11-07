# Proposal: Connect the retained structural producer to production projection

- **Issue:** grain/104 (MW-13C); integration parent grain/94.
- **Status:** Proposed continuation. Requests API and lifetime review before
  implementation. The existing controlled C implementation remains intact.
- **Authority:** parent `structural-execution-plan` v1, SHA-256
  `e63457a69a187e962b053452e1072ba24a630569ae43c4b676de13aa44b3adc7`,
  and grain/104 `owner-production-integration-plan` v1. The current owner decision
  permits candidate development with pinned B+C before B is merged. It retains
  the proposal, review, CI, readiness, and integration gates.
- **Source inspected:** `65ab8f5e7e11b7330737b81992bab72f06d24142`, tree
  `cdd809fd5dc510e2cb2602603c801efaca97db89`. Its parents are
  `881fd3dbad46eeaf174dd209150cae600747bdc5` and
  `864a182aebe7a2fdacfa70013a72763786d37e3e`.
- **Candidate branch:** `integration/104-production-projection`, created from
  verified feature head `864a182`, then fast-forwarded to exact B `65ab8f5`.
  The new draft PR targets `feat/94-incremental-materialization`. B's branch,
  PR94, historical merged C PR95, shared feature, and evidence ref remain intact.
- **Prior evidence:** owner-projection-review v4 reaffirms v3's scoped closure
  of the move-index, property-undo, earlier-birth ordering, and copy-accounting
  findings at `d6dcb0c`. Review-corrections v2 and the integration receipt preserve
  their evidence. They do not establish production B+C acceptance. Required CI
  at unchanged B `65ab8f5` is reported failing, including the split32 deadline.

## Motivation

A managed editing session splits a paragraph, types in both flows, joins them,
edits a distant paragraph in a separate session, and undoes and redoes the join.
The accepted publication should consume B's exact structural changes and update
C's affected resources. A distant deletion, suppressed birth, or scaffold must
not force full projection. The next structural command must reuse the B state
that produced the preceding publication.

This continuation concerns derived core projection and its publication boundary.
It preserves document meaning, canonical facts, editing behavior, the independent
reference default, exact author causality, and Yjs 13.6.33.

## Problem statement

Paths below are relative to `src/markdown/multiwriter/` unless stated otherwise.

1. `materialization/projection.ts:prepare()` reconstructs provenance from all ready
   actions before calling the owned `MaterializedOwnership.prepare()`. It ignores
   `prepared.value.changes`, calls `projectWithActivity()`, and indexes the full
   result. B's indexed replay cannot remove this caller's full preparation cost.
2. B's `materialization/coupled.ts` retains certified `Payload.entry` records,
   exact source metadata, resources, and up to eight checkpoints. Its current
   `ProjectionInput` API nevertheless requires a complete layout-input array.
3. C's `prepareStructural()` consumes exact changes but increments its own
   generation. Its commit evicts the internal B cache because the controlled
   caller owns a different producer. Nesting this public method in `prepare()`
   would invalidate the outer token and discard production reuse.
4. `test/multiwriter/projection-consumer.ts:change()` builds controlled inputs by
   comparing full snapshots, exporting destination requirements, and reconstructing
   provenance. It is a test builder, not the production adapter.
5. `materialization/document.ts` commits activity before projection. A stale
   projection token can therefore reject after the activity root has advanced.
   The existing publication facts/generation check does not check every private
   component's generation.

The approved C consumer contract described the information required from B.
This proposal specifies its production API, input ownership, witness updates,
fallback reuse, and commit ordering. It adds no replay engine or normalizer.

## Proposal

### One owned producer and one preparation generation

Keep `MaterializedProjection.ownership` as the only retained production B producer.
Keep `MaterializedPublication.build()` as the only publisher of the complete
heads/native/projection tuple. Preserve the current text/property fast paths.

Split C's private candidate construction from its public controlled entry point.
A private `buildStructuralState(before, change)` returns either detached C roots
or the existing named decline result. It neither increments a generation nor
commits/evicts a producer. The production `prepare()` creates one generation,
captures one base State, and composes B, adapter, and C candidates under it.
The public controlled `prepareStructural()` continues to create its own token
and evicts the unrelated internal producer after an external commit.

An owned structural success commits B and C together. It never follows the
external-producer eviction path. A cold or declined C candidate also retains the
same validated B result when compatible; it does not commit B before computing C.
This distinction is private to the two entry points, not a caller-selected trust
flag on `StructuralProjectionChange`.

### Indexed ready input belongs to B

Add the internal production entry point:

```ts
interface StructuralReadyInput {
  readonly genesis: ProjectionInput['genesis'];
  readonly genesisManifest: ProjectionInput['genesisManifest'];
  readonly initialProperties: ProjectionInput['initialProperties'];
  readonly native: NativeView;
  readonly actions: ReadySequence;
}

// Internal method on MaterializedOwnership:
prepareReady(
  input: StructuralReadyInput,
  activity: Activity,
  variants: PayloadIndex,
): Work<PreparedOwnership>
```

`PreparedOwnership.value` retains `ownership: OwnershipResult`,
`snapshots: readonly TapeSnapshot[]`, and `changes: StructuralChanges`, and adds
`birthContent: readonly BirthContent[]` for exactly the fresh batches.
The candidate exposes `assertCurrent(): void` and `commit(): void` as described
below. Keep the existing full-input `prepare()` for controlled/audit
callers and D-owned staging. Both paths use the same coupled execution rules.

For compatible additions, `prepareReady()` obtains fresh actions from
`ReadySource.additions(committedSource)`. It derives layout births for those
batches once. B uses its existing retained payload entries for the certified
prefix, and those fresh entries for new positions. The internal replay input
supports `length` and indexed reads; resource append consumes the explicit fresh
entries. It must not implement a full-array getter or materialize the prefix to
call `slice()`, `map()`, or `flatMap()` on it.

The exact ordered-append checks, encoded payload comparisons for detached bodies,
control-target decisions, packet selection, native continuity, and reserved-reader
guard remain. Earlier additions take B's complete order audit and exact suffix;
they are not mislabeled appends. Audit input is materialized explicitly and charged.
Withdrawal/replacement or missing compatible source takes complete certified input
assembly. Neither path uses action names as a safety certificate.

Extract `reconstructBirthContent(batch): readonly BirthContent[]`, with a
`LayoutGenesis & { readonly effects: readonly SemanticEffect[] }` input, from
`reference/provenance.ts:reconstructProvenanceMeasured()` into a helper beside
`reconstructBirths()`. Given one certified allocation/birth/effect batch, it returns
the existing `BirthContent` values: empty intervals for non-inline nodes, private
home for ordinary inline births, and the explicit root skeleton for split births.
Preserve `ProvenanceError`, ambiguity checks, cloning, and counters. Seed genesis
once; derive only fresh allocating batches on the compatible addition path,
including inactive births. Activity and final merged ownership cannot alter this
coverage. Full reference reconstruction calls the pure helper independently and
continues to assemble every batch without candidate indexes or certificates.

The helper is deterministic fact derivation, not author validation. Existing
ingest certification against the exact author closure remains mandatory.

### Exact B-to-C resource adapter

Implement an internal `projection-adapter.ts` used only by
`MaterializedProjection`. Inputs are the committed C roots, the exact B candidate,
ready sequence/source, native view, and candidate activity. Output is either a
`StructuralProjectionChange` or a named compatibility decline.

Store a `producerBase` binding in C State containing the committed B genesis,
ready source, native identity, and opaque checkpoint identity. Check B's base
against all four fields of that binding. Bind
the resulting change to B's candidate native, ready source, revision, and
checkpoint. An equal action count or equal Markdown is insufficient. Text/property
commits must advance this checkpoint identity too, so the next structural edit
has the correct base.

The adapter walks changed resources and selected old/new readers:

| B input                                  | C resources to include                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Assignment/subdivision before and after  | Both owners' runs/flows, their birth headers and effective block destinations, changed tapes, and retained ghost readers.              |
| Block placement before and after         | The moved node, former/new parents, and both departed/arriving sibling gaps.                                                           |
| Flow placement before and after          | Source home header, old/new enclosing flows and effective block destinations, and destination run/occurrence readers.                  |
| Run/occurrence births or changes         | Referenced flows, block parents or inline slots, including inactive/ineffective anchors.                                               |
| Root and attachment before and after     | Every old/new run and destination slot; include removal-only readers and affected tapes.                                               |
| Cohort before and after                  | Both root sets and their raw block/inline containers, even when final visible content is unchanged.                                    |
| Destination requirement before and after | Every former/new witness node and the exact effect reference.                                                                          |
| `changes.actions` and fresh batches      | Original semantic action bodies, control targets, births, and native-manifest tapes; C retains its packet/deletion invalidation rules. |

Use selected `runLayout()`, `flowBlock()`, node allocation, and home lookups on
each side. Add detached `OwnershipResult.flowPlacement(flow)` and
`OwnershipResult.occurrence(id)` forwarding to the existing layout methods;
these selected readers are currently missing from the facade. Newly allocated resources are
read only on the side where they exist. Follow flow ancestry to its effective
block, while also keeping the original home header for ghost availability.
Do not export `assignments`, `nodeAllocations`, `flowPlacements`, `runLayouts`,
all visibility arrays, or all destination requirements to discover the delta.

Reuse C's `tapeNodes`, `runFlows`, `flowHomes`, and `flowRoots` roots for reverse
readers and stable roots. Complete raw/ghost readers that are absent from visible
records are obtained from the selected changed ownership components. If the
existing roots cannot identify a required retained reader without a global scan,
stop with that concrete missing dependency; do not silently omit it or introduce
an unreviewed second inventory cache.

For each affected inline node, supply its stable private-home root and all
before/after participating native tapes. Include native-manifest tapes even for
marker-only input. `semanticChanges` comes from B's exact `changes.actions`; C
still expands controls and packet eligibility through its certified ready source.
The diagnostic `family` is chosen from effects only for reporting. Copy B's replay
frontier and reason verbatim.

### Complete destination witnesses without a second replay index

Reuse C's `State.nodeRequirements` and `requirementReaders`. Seed these during
the existing cold index operation. For each B `derived.requirements` change:

1. Start with the retained per-node effect-reference set for every node in the
   union of the before/after contribution.
2. Remove the old contribution by exact action ID and effect ordinal from each
   former node. Null/missing after values are real removals.
3. Add the new contribution to each new node, deduplicated by the same key.
4. Include complete final witness arrays for all affected nodes and containers,
   including empty arrays for nodes with no requirements and all fresh births.

C updates its reverse requirement readers from these complete values, as it does
today. No new effect replay table or complete requirement export is needed.
Interpretation, weak split suppression, and subtree visibility remain separate
from raw destination requirements. Their existing C indexes expand semantic
dependencies after adaptation.

### Coordinated commit eligibility

Extend internal prepared activity, ownership, and projection candidates with
`assertCurrent(): void`. The method checks captured generation, committed base,
and unused status without changing roots. Keep `commit()` checked for existing
standalone callers. A projection candidate's check also checks its B candidate.
All preparation, lazy computations needed for installation, and fallible
validation finish before installation.

At `document.ts`'s reduction commit hook, capture the exact prepared activity and
projection pair, then:

1. Check activity and projection, including B and the adapter's base binding.
2. Recheck publication facts/generation at the existing publication boundary.
3. Synchronously install the checked roots and tuple with no yield, await,
   callback, listener dispatch, lazy export, or validation between installations.

The publication facts check already immediately precedes the reduction hook;
retain that ordering and prohibit the eligibility methods from calling user code.
Checked component commits may recheck their own tokens because no operation in
this synchronous interval can invalidate another component. Root assignments and
counter updates must be the entire install body. Any new fallible work belongs
before the checks. A failure at any eligibility check leaves all committed roots
and the prior publication unchanged. Test stale B, stale C, and stale activity
independently rather than relying on this ordering argument alone.

Ingress, competing prepare, cancellation, changed source/native/genesis/base,
decode-limit change, and eviction invalidate the relevant candidates. A late
command fork has independent generations and cannot commit into the owner.
The adapter retains no candidate in a shared field that a later prepare can
replace before the commit hook captures it.

### Fallback and reseed

| Input condition                                                | Required result                                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| First open, eviction, missing retained source, changed genesis | Full certified seed; install coherent B and C roots at the same tuple.                                                 |
| Native withdrawal/reorder/discontinuous branch                 | Preserve B's conservative resource rebuild and exact replay reason.                                                    |
| Reserved cell becomes ordinary under a historical reader       | Preserve B's exact earlier reader frontier and suffix replay. C can still be local if its changes are complete.        |
| Earlier compatible addition                                    | Charge B's order audit/suffix. Feed its exact changes to local C when compatible.                                      |
| Withdrawal/replacement/absent exact addition                   | Preserve C's `missing-exact-addition` full reconstruction and reseed; verify removed addresses and contributions.      |
| C declines on missing/incompatible metadata                    | Record the exact C reason. Use the same validated B result for full projection/indexing when its input is still valid. |
| Any stale candidate                                            | Discard without installation; rebuild from the current facts through the publication owner.                            |

On C decline, full provenance assembly is an explicit, charged fallback cost.
Pass the already prepared ownership/snapshots to the full projector. Do not run
a second B producer, commit then reconstruct, or evict valid B merely because C
declined. Reseed C requirement, source, and B checkpoint bindings coherently.
Missing witnesses on ordinary supported commands are adapter defects and block
acceptance. Distant deletion/suppression/scaffold, wrappers, lifting, sections,
numbering, and presentation are not blanket fallback conditions.

### Publication lifetime and retained cost

Keep B's eight periodic checkpoints and fork generations. The adapter adds one
exact `producerBase` binding per current C State and temporary affected-resource
sets. Witness updates reuse C's persistent maps. B's existing ordered payload
entries remain the owner of retained layout inputs; do not retain a parallel
action array or a chain of adapter States.

Escaping native, ownership, visibility, address, and command readers capture
completed immutable roots and IDs. Construct their lazy export closures outside
candidate/commit scopes, following `structuralReads()`. They must not capture a
prior State, live producer, activity callback, preparation generator, or commit
closure. Charge lazy exports separately when requested. Old publications remain
readable after later prepare/cancel/commit/evict.

This continuation does not change `RetainedEditError`, append identity, listener
cleanup, canonical byte retention, or single history registration. A retained
append failure still retries the same action rather than duplicating it.

## Non-goals

- Changing Markdown, deletion, ownership, interpretation, Unicode, or selection
  semantics; weakening the reader guard or independent oracle.
- D's pre-append full staging, structural drafts, or exact-author reconstruction.
  Their work remains separately attributed even in a managed-command trace.
- A second normalizer/replay engine, generic transaction framework, worker,
  persistence/wire change, dependency change, pruning, or browser cutover.
- Reviving B's rejected audit-resource-string experiment, merging failed B,
  making a new draft ready without authorization, or completing B/C/the parent.

## Suggested implementation shape

1. Add checked candidate eligibility and split C state construction from commit.
   Keep the external controlled seam and existing tests working.
2. Add B's indexed ready entry point and the pure per-batch coverage helper.
   Preserve the full audit path and all source/payload guards.
3. Add the exact adapter and requirement-delta construction. Wire the production
   structural branch to it and preserve B across local or full C commits.
4. Complete the 10-node managed trace before the 150-node variants. Extend through
   deletion, interpretation, lifting, and wrapper boundaries in separate reviewable
   patches. Keep a condition-specific fallback ledger in
   `docs/mw13c-resource-locality.md`.
5. Run relevant static/regression checks, retain incomplete/failed evidence, then
   obtain new-head CI and independent review before shared integration.

These steps begin only after this proposal is approved. They do not authorize
starting D/E or changing B/shared/evidence branches.

## Verification

Start with production `commandReplica(..., 'materialized')` and its real managed
session commands in `structural-consumer.test.ts`, without calling the controlled
`seed/change/prepareStructural` driver. Capture publication-purpose diagnostics
around accepted-state reduction. Author/staging/reference work remains outside
that interval and is reported separately.

At 10 nodes, run split, type both sides, join, distant edit in another session,
undo, and redo. Repeat at 150 with distant deletion, suppressed birth, and scaffold.
Require consecutive structural commits to retain the same owned B cache and
advance the exact checkpoint binding. Within each supported warm publication
interval assert zero full provenance/projector/view/deletion/command-index seeds
and no complete inventory/visibility export. Count attempted and discarded work.

After every step compare with a cold independent reference from the same exact
canonical bytes, outside timing. Compare complete normalized nodes, origins,
wrappers, fragments/native ranges, masks, editable empty slots, visibility flags,
tags/order, interpretation decisions, and raw ownership. Resolve saved and new
addresses with both affinities, invalid/cross-tape/Unicode controls, managed
selection, and continued typing. Preserve distant record/address identities and
held native/view/command-index reads. Projection must leave canonical bytes equal.

Extend existing tests rather than replacing their assertions:

- `execution.test.ts` and `compatibility.test.ts`: suffix access guards, altered
  or reordered bodies, batches, control/packet decisions, withdrawal, and earlier
  arrivals. Assert actual B frontier/reason and C local or named fallback result.
- `review-regressions.test.ts`: both cross-parent directions with nonempty
  subtrees, checked-property undo, and earlier allocation visibility ordering.
- `structural-refinement.test.ts`: joined empty home, dormant redo, ghost
  transfers, both affinities, concurrent earlier join, and invalid boundaries.
- Existing deletion/interpretation/normalization/mixed-wrapper controls: packet
  winners/dormant members, reused tags, birth/deletion/split concurrency, wrapper
  merge/unmerge, lifting, sections, numbering, and empty-root restoration.
- `publication.test.ts`: cancellation at adapter yields, competing preparations,
  each stale component, and failure at every pre-install check; duplicate/no-change
  identity, reentrant observers, late withdrawal, reversed carriers, cold reopen,
  reducer failure/retry, retained append failure, and eviction.
- Repeated prepare/cancel/evict and GC controls: release adapter contexts and
  prior roots not held by publications, with no retained ready-array chain.

An obsolete full-fallback assertion in `controls.test.ts` may change only with
the demonstrated production local/suffix contract and all semantic checks retained.
Preserve existing assertions, deadlines, warm fixtures, workers, CI partitions,
and the 8/32/128 sibling-copy accounting controls. Include root-width copying,
changed-parent arrays, interval/dependency visits, B order audits, and genuine
wide normalization regions in the ledger.

After the vertical slice, reuse A's exact 0/100/1,000-history inputs with original
hashes and provenance. Report prefix load cost separately and keep independent
comparisons outside candidate timing. Use raw times or medians for short samples.
Keep each expensive workload near five minutes; a protective stop is incomplete.
No 10k or comparable long work until short metrics justify it. This proposal
makes no whole-command latency, D, storage, browser, or parent acceptance claim.

Run `npm run build`, relevant `npm run test -- ... --maxWorkers=4`, lint, formatting,
boundary checks, and both unused-code modes after implementation. Required CI on
the actual new head and independent review remain gates; local checks or source
equality cannot substitute for them.

## Success criteria

- Production managed split/join/history consumes exact B changes and retains one
  owned producer over consecutive structural publications.
- Supported warm publication avoids full provenance/projector/index reconstruction
  with distant difficult features and preserves complete independent observations.
- Every activity/B/C eligibility failure leaves all committed roots and the old
  tuple unchanged; held readers survive later commits and eviction.
- Destination and birth witnesses are complete, including inactive births,
  former locations, ghost readers, removal-only deltas, and earlier arrivals.
- Ordinary required operation families have demonstrated local paths or a named
  unresolved integration blocker. Defensive metadata declines remain explicit.
- New-head CI, independent review, readiness authorization, and owner integration
  remain distinct gates. The new PR stays draft until fresh readiness authorization.
