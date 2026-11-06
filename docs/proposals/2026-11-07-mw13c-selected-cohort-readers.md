# Proposal: Select production cohorts by parent and account for witness updates

- **Issue:** grain/104 (MW-13C); integration parent grain/94.
- **Status:** Proposed correction. Requests review before implementation of the
  selected-reader API and index. The existing production adapter remains intact.
- **Authority:** grain/94 `structural-execution-plan` v1, SHA-256
  `e63457a69a187e962b053452e1072ba24a630569ae43c4b676de13aa44b3adc7`;
  grain/104 `owner-production-integration-plan` v1 and
  `owner-production-integration-review` v1. The latter explicitly requires the
  normal proposal gate for a new internal selected-reader/index API.
- **Inspected source:** PR96 head
  `a4c94d538a9d647ff49acedccbbe27df814a3d32`, tree
  `ac354caa0cfb2e0af7131b453b2dd753d15f95e8`. Continue on
  `integration/104-production-projection`; preserve every existing commit.
- **Scope:** Extend the approved
  [production adapter proposal](2026-11-06-mw13c-production-adapter.md).
  Its publication owner, exact bindings, atomic installation, conservative
  guards, independent reference, and fallback rules remain binding.

## Motivation

A managed editor has three root regions: `localabcdef`, a quote containing forty
`x` characters, and `tail`. Split the remaining long paragraph inside the quote
N times, then split the unrelated first root paragraph at offset 3. The quote
keeps its view identity and the root's affected structure is unchanged as N grows.
Publication must not export the quote's retained split groups to order root
children.

A fresh source-only probe at the inspected head, using Node 24.22.2, reproduces
the owner's counts:

| Unrelated quote splits | Root width before/after | Publication `ownership.cohortsExported` |
| ---------------------: | ----------------------: | --------------------------------------: |
|                      0 |                     3/4 |                                       1 |
|                      4 |                     3/4 |                                       5 |
|                     12 |                     3/4 |                                      13 |

All three cases preserve quote identity and match complete independent view,
visibility, assignments, destination requirements, buckets, selected child and
occurrence order, a saved address, and native bytes. Held publication reads and
canonical-byte checks pass. Each measured publication uses one local structural
candidate and zero full projectors. These are work-count/correctness observations,
not latency acceptance or a repaired-path result.

## Problem statement

Paths below are relative to `src/markdown/multiwriter/`.

1. `ownership/ownership.ts` implements `OwnershipResult.children()` and
   `occurrenceOrder()` by calling `cohortValues()` and filtering all exported
   buckets by their first root's immutable occurrence parent.
2. `materialization/structural.ts:exportBuckets()` enumerates the complete
   retained group map on its first call after dirty-group refresh. The map also
   contains null entries for groups that do not produce a multi-root bucket.
   Sequential singleton groups account for the 1/5/13 reproduction. Caching the
   export removes later inventory traversal but retains the complete-array
   filter on every selected query when nonempty buckets exist.
3. Regional normalization calls both old and candidate child readers. A local
   warm publication therefore still reaches the global export even though its
   full-projector counters are zero.
4. `materialization/projection-adapter.ts:projectionChange()` removes witnesses
   with `filter`, tests each addition with `some`, and copies the current array
   with a spread for each new reference. Its final copy/sort counters omit that
   intermediate work. With W retained witnesses and D changed contributions to
   one node, this can do repeated work proportional to W times D.
5. `materialization/projection.ts` also filters and copies reverse requirement
   readers during installation preparation. Those actual dependent-array costs
   must remain visible after the adapter changes.

## Proposal

### One parent index in the retained producer

Extend `StructuralIndex` with a persistent map keyed by block-parent resource ID.
Each value is a persistent map from the existing split-group key to its current
nonnull cohort entry. Reuse `PersistentMap`; add no replay engine or action log.

Record the immutable block parent with each nonnull entry in the existing
`buckets` map. Derive it from `layout.occurrence(bucket.roots[0]).slot`, matching
the current filter exactly. Keep the first-effect order and cut-ordered roots
unchanged. A valid split bucket has action occurrences at one block sibling gap;
retain the existing same-gap and ordering validation. Do not derive membership
from a visible wrapper, current block placement, or final flow ownership.

In the existing dirty-group loop in `refresh()`:

1. Read the previous entry and compute the next entry with the existing
   `splitBuckets()` and first-effect selection.
2. If the previous entry exists, fork its parent map and remove that group key.
   Remove an empty parent map from the outer map.
3. If the next entry exists, fork its parent map and install the new entry.
   Replace both the original bucket entry and selected membership before the
   candidate can escape.
4. A null next entry retracts selected membership. The full retained map keeps
   its existing null entry and full-export behavior.

Store the previous parent in the entry so removal never needs an occurrence
lookup against a newer layout that may no longer contain the old allocation.
Changes in cut ranking or first effect replace the entry within the same parent.
Control changes, ineffective/moved split births, earlier arrivals, interpretation
changes, and native refinement use the existing exact replay/dirty-group rules.
This index does not introduce a new activity or visibility decision.

`fork()` shares both index roots. Every changed inner map is forked before it is
edited. Cold replay builds membership during the same refresh pass; it does not
scan all buckets a second time. Checkpoint restoration and suffix replay resume
the matching parent index from that checkpoint, never from final ownership.

### An internal selected reader with an exact lifetime

Add one optional final constructor argument to `OwnershipResult`:

```ts
cohortLookup?: (parent: NodeId) => readonly OccurrenceBucket[]
```

When supplied, both `children(parent)` and `occurrenceOrder(slot)` use that reader
with the block parent. They do not call `cohortValues()` or filter its full output.
When absent, retain the existing independent full-array path unchanged. This
preserves full reference reconstruction and existing controlled constructors.
It adds no new public editing operation, serialized field, or peer evidence.

Construct the production callback through `structuralReads()` and a separate
top-level closure factory that captures only a forked completed parent-index
root. It must not capture a producer, activity callback, candidate, previous
State, commit context, or preparation generator. Inner maps and their entries
are immutable after installation. A selected query enumerates only that parent's
nonnull entries, sorts them by the same `compareEffects(first)` order used by
the full export, and returns their buckets. Existing public query results remain
detached. Do not add a retained query-result cache or prior-root chain.

Wire the callback at both production construction sites:
`materialization/ownership.ts:replayOwnershipSuffixMeasured()` and the native
text-refinement result in `materialization/coupled.ts`. Require it on cold,
warm, property/text, suffix, fork, and fallback/reseed production routes.

A missing parent entry means an empty cohort list. It does not trigger a full
export. Existing layout validation still rejects invalid parents/slots. Keep
`OwnershipResult.buckets` and `StructuralIndex.exportBuckets()` as explicit full
reads, independently assembled from the original complete group map. Full exports
must not use the selected index as their source of truth.

### Update witnesses once per affected node

Within `projectionChange()`, use a temporary edit map for each node touched by a
changed requirement contribution. Seed that node's map once from its retained
`nodeRequirements`, keyed by the existing exact action ID plus effect ordinal.
Then remove old contributions and add new contributions with keyed operations.
Retained requirement references are unique by that key; verify this invariant
against independent exports in the controls.

Preserve the current union of former/new requirement nodes and all affected
nodes/containers. For a touched node, materialize the edited map once. For an
affected node without a contribution edit, read the retained array directly.
Produce each complete final array once and sort it with the existing action-order
and ordinal comparator. Preserve empty arrays, removal-only readers, ghost
destinations, dormant births, unchanged reference values, and missing-source
declines. No edit map escapes the adapter and no C State gains another index.

This replaces repeated linear membership searches and intermediate array copies.
It does not change the output type, destination semantics, or eligibility rules.
The reverse reader update in `projection.ts` keeps its behavior; instrument its
existing dependent-array scans/copies rather than redesigning that index here.

### Account for attempted work and real dependencies

Add counters at the operation, traversal, and copy sites rather than infer work
from final collection sizes:

- Selected-cohort parent lookups, index membership inserts/removals, selected
  entries visited, sorting inputs/comparisons, and bucket/root entries copied.
  Keyed lookup/update counters count operations, not constant-time AVL work;
  persistent-map path costs remain logarithmic in the index sizes.
- Full cohort export calls, complete retained group entries visited including
  nulls, nonnull sort inputs/comparisons, and roots copied on explicit detached
  exports. Distinguish cached calls from actual inventory traversal.
- Witness seed entries visited, keyed membership/update operations, final entries
  visited/copied, and sort inputs/comparisons. Count discarded preparations too.
- Reverse requirement reader entries inspected/copied in `projection.ts`,
  including every `filter` callback and spread input in the existing update path.

Keep existing counter names for their existing units. Document any additional
counter's unit in `docs/mw13c-resource-locality.md`; do not silently reinterpret
`adapterWitnessEntriesCopied` or `ownership.cohortsExported` as a different unit.
If an intermediate array operation remains, charge its inputs and copied outputs
at every execution, including unsuccessful membership tests and later declines.

Adding unrelated parents can increase keyed lookup depth. It must not increase
selected cohort entry visits, exported inventories, or copied witness arrays for
a fixed affected parent. Cohorts and child occurrences within the actual selected
parent remain genuine ordering dependencies; charge their visits and copies.
Keep root-width copies and the existing 8/32/128 birth-sibling controls visible.

### Retention, installation, and fallback

The new index stores one additional membership per current nonnull bucket and one
outer entry per parent with such buckets. Null groups add no selected membership.
Versions share persistent roots under B's existing eight-checkpoint bound; no
checkpoint count, eviction policy, or canonical-retention rule changes.

All membership updates, selected-reader construction, witness materialization,
and sorting finish before eligibility checks and synchronous installation. Old
publication readers retain completed roots across later prepare, cancel, commit,
fork, and eviction. Cancelled candidates must be collectible while old readers
remain held. No canonical write or user callback enters this preparation.

Keep existing named cold/retraction/metadata fallbacks. Ordinary supported splits
cannot fall back to a complete cohort inventory when a selected root is missing;
incomplete production wiring is a regression. No repair by moving export work
before the publication measurement interval is allowed.

## Non-goals

- Markdown, cohort ordering, ownership, visibility, normalization, author-causal
  validation, wire/persistence, Yjs 13.6.33, or independent-reference changes.
- D's pre-append staging, compiler, exact-author reconstruction, or whole-command
  performance acceptance; a second producer, normalizer, or replay engine.
- Editing B's separate branch/PR, shared feature/evidence refs, parent/D/E state,
  workflow settings, protections, labels, dependencies, or readiness authority.
- A blanket global-export fallback, a generic indexing framework, or another
  retained all-action/all-bucket cache.

## Suggested implementation shape

After proposal approval:

1. Add producer membership and the selected callback, wire both constructor
   sites, and add independent selected/full/old-reader differential controls.
2. Add the fixed-root managed regression and actual nonempty-cohort cases before
   extending the existing warm zero-full-work assertions to cohort exports.
3. Replace repeated adapter witness array edits and add complete accounting,
   including the downstream reverse-reader costs. Review this patch separately.
4. Update the locality ledger and publish source-specific semantic, lifetime,
   static, and CI evidence on the existing draft PR96 candidate.

## Verification

Start with the executable three-case reproduction in
`cohort-reader-proposal-evidence`. Promote its managed setup into the production
test suite after approval. Keep root width 3 before and 4 after the measured
split, local content/offset fixed, and unrelated nested split depths 0/4/12.
Require zero complete publication cohort exports and constant selected entry
visits/copies for the fixed affected parent. Repeated `children()` and
`occurrenceOrder()` reads must also avoid the full export, before and after an
explicit `.buckets` read. Cover old and new publication readers separately.

Add real concurrent splits at a shared quote gap to produce nonnull cohorts;
singleton null groups alone cannot verify selected membership or cut order.
Compare every selected parent's results with the independent full reference and
explicit full exports. Add controls for changing the actual affected parent's
cohort/occurrence width and require the relevant work counters to grow.

Exercise join, move-away/retraction, dormant undo/redo, distant deletion,
suppression/scaffold, earlier arrival, refinement, interpretation and wrapper
boundaries. Preserve complete normalized nodes/origins/fragments/masks/empty
slots, ordered visibility/tags, assignments, requirements, both-affinity addresses,
canonical bytes, and distant identity comparisons. Use real managed commands and
history for the production slice. Continue with the existing 10/150 traces;
reference comparisons stay outside candidate timing.

For witness accounting, grow retained witnesses and changed contributions
independently at one destination. Include multiple removals/additions, overlapping
old/new destinations, duplicate attempted additions, removal-only results and
empty final arrays. Assert exact entry-visit/copy counts and keyed operation
counts against an instrumented independent model of the old array operations.
Show one seed and one final materialization per touched node, rather than infer
locality from its final array length. Verify downstream reverse-reader accounting
with a genuinely wide dependent set and a decline after work has already occurred.

Retain cancellation/atomicity controls and extend the existing GC worker with held
selected readers, later commits/eviction, and repeated cancelled candidates.
Inspect closure capture as well as collection. Preserve eight checkpoints and
lossless canonical retention, including cold reopen and full fallback reseeding.

Run build, relevant Node tests, lint, formatting, boundaries, and both unused-code
modes on the corrected source. Use Node 24.22.2 and the existing two-worker
configuration for comparison with CI. Preserve assertions, deadlines, warm
fixtures, seeds and CI partitions. Individual expensive workloads remain around
five minutes; no 10k/comparable run. Retain failures and incomplete evidence.
Require new-head CI and independent review; source reconciliation of the old
green CI run is not corrected-path acceptance. PR96 stays draft with auto-merge
unset until separately authorized.

## Success criteria

- Fixed-root managed growth cases perform no complete publication cohort export;
  selected work follows the actual parent, including nonempty cohorts.
- Independent full exports and selected reads agree before/after controls,
  refinement, old-reader retention, cancellation, and eviction.
- Witness updates avoid repeated retained-array scans/copies and charge every
  remaining intermediate/dependent visit and copy, including discarded work.
- Existing semantic, atomicity, checkpoint, retention and independent-oracle
  contracts remain intact; corrected-source evidence supports independent review.

This proposal and its baseline probe do not resolve the review findings or grant
B/C/parent acceptance, readiness, approval, merge, or issue completion.
