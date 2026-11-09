# Proposal: Resource-local visibility, normalization, and addresses

- **Issue:** grain/104 (MW-13C); integration parent grain/94.
- **Status:** Proposed. Requests approval for C's implementation. The changes,
  locality guarantees, and acceptance tests below are proposed work.
- **Authority:** grain/94 `structural-execution-plan` v1, context
  `ctx_QlCIuCY1eBXN1ph4`, SHA-256
  `e63457a69a187e962b053452e1072ba24a630569ae43c4b676de13aa44b3adc7`,
  especially §§3–5, 7 (C), 8, and 9. The approved
  [MW-13 proposal](2026-11-05-mw13-incremental-materialization.md) and
  [A's integrated contract](../mw13a-structural-locality.md) remain binding.
- **Inspected integration head:**
  `c9327db5209ad1d566c6f2ef84e4186cba6d40a5`, tree
  `d619e81ea42d8a888eebb7abb0d2a62dc86d3743`, freshly fetched and checked
  against draft PR #88 on November 6, 2026. A's `owner-integration-review`
  and `owner-integration-receipt` v1 were read. Their reviewed-head CI evidence
  is not a new test run on this source.
- **Review branch:** `docs/104-resource-local-projection-proposal`, from that
  exact head. C's draft PR targets `feat/94-incremental-materialization`.
  The parent owner integrates reviewed changes. The separate combined-evidence
  branch remains evidence, not C's base or a reset target.

## Motivation

An editor splits a paragraph, types into both halves, joins them, edits a distant
paragraph in another session, then undoes and redoes the join. A deleted subtree
elsewhere remains in the document's retained history. Projection should update
the participating flows and their actual dependencies. The distant deletion must
not force reconstruction of unrelated visibility, origins, or editing addresses.

This is a change to derived computation in the core projection layer. Raw
ownership remains complete, including hidden cells and ghost slots. Visibility
and normalization determine the editable projection without writing canonical
facts. Published records outside the dependency region retain their identities.

## Problem statement

Paths below are relative to `src/markdown/multiwriter/` unless stated otherwise.
At the inspected head:

- `materialization/projection.ts` computes one global `stableVisibility` flag.
  `prepare()`, `canStageText()`, and `canStageProperties()` use it to exclude
  local work when any retained node is deleted, suppressed, or a scaffold.
  Structural preparation reconstructs provenance, calls `projectWithActivity()`,
  and runs `indexMeasured()` over the complete view, text, and retained actions.
- `materialization/text-deletions.ts` indexes exact native intervals by tape and
  client. Queries avoid a deletion-by-character product, but each new index scans
  `Activity.effects` and sorts every retained active `DeleteText` range.
  The local text path separately retains per-tape deletion arrays and scans
  affected tapes. These paths need one persistent contribution index.
- `visibility/visibility.ts` separates insertion activity, exact/inherited tags,
  deleted destinations, suppressed births, and scaffolds. Inherited subtree
  coverage follows birth parents and birth-causal content, including content
  transferred elsewhere. Current ownership alone cannot replace it.
- `projection/project.ts` also weakly suppresses split derivations under
  concurrent subtree deletion, absorbs joined flow headers, lifts children,
  records exact masks and origins, and supplies editable empty slots.
  Rebuilding visible text alone would omit these decisions.
- `projection/normalize.ts` clones and indexes the complete detached view, then
  calls `src/markdown/semantic/normalize.ts`. The shared one-pass rules handle
  sections, adjacent lists/quotes, list numbering, and empty containers.
- `projection/addresses.ts` scans allocation and visibility arrays for address
  availability. `authoring/view-index.ts` builds complete preorder command maps
  after structural changes. Its `construction:<ordinal>` handles are local to
  a publication; retaining old ordinal keys after insertion would be incorrect.

Existing tests cover exact tag order, local text refinements, structural
projection, controls, and old publications. `structural-visibility.test.ts`
currently expects retained deletion ranges to be indexed again on split. It
proves the intermediate indexed full path, not C's proposed local path.

## Proposal

### 1. Consume A's candidate contract; keep B's decisions upstream

Extend `MaterializedProjection` to prepare a private projection candidate from
the exact base and resource changes specified by A. Reuse `ReadySource`,
`NativeView`, `OwnershipResult`, `RangeRef`, effect references, and resource IDs.
Use a small internal adapter where B's final producer is not yet available.
Field names can follow B's reviewed types; the required information is:

| Input         | Required meaning                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compatibility | Exact genesis, coherent base publication/ready certificates, native generation, payload identity, and private revision; exact author and merged bases stay distinct.                  |
| Structure     | Before/after assignments, ordered subdivision mapping, affected tapes/runs/flows/nodes/occurrences, and former/new parents and placements.                                            |
| Semantics     | Changed activity and eligibility, exact/inherited deletion contributions, packet membership and masks, birth enablement, destination requirements, and birth-causal coverage changes. |
| Retractions   | Withdrawn resources/facts, old locations, invalidated ghost slots, and negative dependencies. An empty changed-ID list is not proof that absent resources are unchanged.              |

C does not infer refinement safety from marker births, final owners, matching
Markdown, or action counts. B certifies conditional checkpoint-owned subdivision
or performs the required suffix/cold replay. A's joined-empty-home two-marker
counterexample remains a negative control. A changed reserved classification,
dormant reader, cohort, or earlier effect must reach C through B's resulting
changes, even if the user-facing action contains no visible text.

Reuse verified allocation and birth-provenance roots for the exact base, then
apply the supplied additions/retractions. C must not call
`reconstructProvenance()` over all actions merely to obtain a small change set.
Existing author-causal admission still validates new native bodies, membership,
packets, and birth coverage. Reuse of unchanged certified facts does not waive
those checks for changed facts.

Until B is integrated, controlled tests supply before/after resource changes
from independently checked snapshots. They compare complete observations and
exercise C's consumer. Production continues through the guarded full path when
the producer cannot supply a compatible complete change set. Controlled evidence
is labeled and cannot establish B+C or end-to-end command acceptance.

### 2. Retain and update deletion contributions

Evolve `ExactTextDeletions` into immutable roots that can be forked and updated.
Seed them during cold construction; local preparation changes only contributions
named by the semantic delta. Keep the full-scanning `reduceVisibility()` path as
an independent comparison.

Index declarations by exact effect identity and their native ranges. Maintain
interval roots per tape/client, with a reverse effect-to-range index for removal,
undo/redo, packet eligibility changes, and ready-set withdrawal. Updating one
declaration copies its affected search paths; it does not rebuild all retained
intervals, even on the same tape. Dormant declarations remain available for
reactivation without consulting the full action log.

Preserve semantic ordering. Current `OrderedDeletionTag.order` is a dense position
in filtered `Activity.effects`; persisting that number would make earlier arrivals
renumber unrelated declarations. Store stable semantic effect-order keys using
the existing `compareActions()`/`compareEffects()` order and
merge exact/subtree query results in that order. Deduplicate each tag only after
finding its first **covering** declaration for the queried token. Reused tags,
overlapping ranges, inactive effects, and packet membership retain current
behavior. The full reducer's numeric ordering remains its independent oracle.

Keep subtree contributions distinct from exact native insertion intervals:

- Index each subtree effect's captured nodes, retained `RangeRef` intervals, and
  concurrent birth descendants. Follow birth-parent edges and exact causality;
  do not derive coverage from current placement or final ownership.
- Index current raw-parent descendants separately for `deletedDestination`.
  A move can change that predicate while captured text tags remain unchanged.
- Connect inherited birth-content intervals to native interval readers, including
  transferred content and later insertions within retained boundaries.
- Retain declaration identities when a tag is reused, including the full reducer's
  tag-grouped inherited-coverage behavior. Retracting one declaration updates that
  group and its readers; it cannot blindly remove all contributions for the tag.

Recompute only changed intervals/tokens, affected owners, and dependent node
visibility. Exports of complete ordered visibility arrays may enumerate their
current immutable roots; candidate preparation and selected-address reads must
not trigger those exports. Charge such enumeration when it is explicitly used.

### 3. Track semantic dependencies independently of raw ownership

Keep indexed raw projection records as well as normalized representatives.
Today's normalized `nodes` map cannot recover an absorbed header or a merged
wrapper constituent by itself. Extend the existing persistent maps rather than
building a second editable document model.

The candidate follows these dependency edges:

| Change                                 | Invalidate or update                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native text or interval subdivision    | Token visibility on changed intervals; all raw and ghost flow readers, fragments, boundaries, and addresses of those intervals.                                                                |
| Split/join/transfer or placement       | Both flow endpoints, old/new inline owners, absorbed/lifted headers, former/new parent sequences, wrapper edges, and destination requirements.                                                 |
| Subtree declaration, birth, or control | Direct tags, captured and inherited coverage, current deleted descendants, and affected split-derivation suppression.                                                                          |
| Birth/requirement/content visibility   | Availability witnesses for active births, effective destination effects, visible content, and kept descendants; update ancestor scaffold/suppression state when a witness changes.             |
| Interpretation change                  | Winner set for the source, all competing packets including dormant packets, explicit member-effect eligibility, packet-owned births, exact syntax masks, and resulting presentation/structure. |
| Withdrawal                             | Remove previous contributions and reverse edges, inspect negative readers, and update former as well as new locations.                                                                         |

Use retained witness counts/sets to propagate availability additions and removals;
do not rescan all nodes to decide whether an unrelated scaffold is still needed.
Weak split suppression depends on concurrent deletion of the split source,
surviving content/children, and independent effective placements. Preserve those
inputs explicitly. A document-wide boolean cannot stand in for them.

Interpretation indexes retain losing candidates and their membership. Undoing a
winner can expose an older packet without new syntax. Exact masks are indexed
by native tape/client range; never identify syntax by substring or visible offset.
Shared pure predicates may be extracted from existing reducers. The full reference
orchestration must not consume C's retained indexes or certificates.

### 4. Rebuild participating flows and normalize the dependency region

For split/join, rebuild the participating raw flow records and the affected parent
child sequences. Use `projectInline()`'s retained fragment/address reuse where
its owner assumptions still hold; generalize flow construction for newly born,
absorbed, or reactivated headers. Update reverse tape/run readers on additions
and removals. A transfer can leave addressable ghost slots in the former flow.

Replace changed view records and their ancestor paths. Reuse unchanged child
records, origins, fragments, boundaries, wrapper addresses, and address records.
Copying a changed parent's immutable child array remains visible in the work
ledger; it must not recursively rebuild or normalize unrelated descendants.

Use the existing semantic normalizer's rules and one-pass ordering. Extract the
existing rule bodies into shared internal helpers if a bounded schedule needs
them; retain the current complete schedule for full/reference normalization.
The local adapter operates on detached copy-on-write records with real parent
and sibling context. Do not normalize an isolated section as though it were a
document root, and do not introduce a new fixed-point normalizer.

Select the region from former/new parents and raw-to-normalized constituent
dependencies. Expand it before each relevant shared pass to include:

- section ranges and trailing blocks affected by heading boundaries;
- the contiguous mergeable list/quote wrappers on either side of a changed gap;
- lifted children and the ancestors whose emptiness or availability changes;
- affected list items and the numbering suffix determined by the first marker;
- the document's inline-presence summary when its last editable inline changes.

Maintain boundary summaries for unchanged normalized subtrees. Skip a subtree
only when its context and summary prove that the shared pass has no work there.
A changed boundary expands the region to its actual dependents. Wide list
renumbering or a section range that genuinely spans the document is valid wide
work and receives its own resource counts. It is not a reason to rebuild unrelated
branches by default. Differential tests must verify the region planner, especially
wrapper merging, origin concatenation, pass order, and empty-container cleanup.

### 5. Keep read-only address and command lookup local

Maintain publication-owned indexes for node existence/visibility, flow-to-home
allocation, effective flow destination, retained range/marker readers, and
raw-origin-to-normalized membership. Address lookup uses the same availability
predicate as `resolveAddress()` with indexed inputs. Keep the existing full
lookup for independent comparison. It must return the original captured lineage;
caret recovery remains separate from mutation availability.

Address reuse compares the complete identity: run, boundary, side, predecessor,
and origin range. Equal visible offsets do not identify empty gaps. Marker-only
changes invalidate ghost readers and empty slots even when content is unchanged.
Creation undo can suppress a joined source header while its lineage survives;
source deletion or destination unavailability still makes mutation unavailable.

Preserve the preorder `construction:<ordinal>` handle contract. Adapt only the
read-only index seam in `authoring/view-index.ts`: retain origin/parent/sibling
records and subtree sizes with indexed sibling ordering so rank/select resolves
the current ordinal without rewriting every following handle. Command lookup
and `handleOrigin()` must not lazily build a full map on first use. Explicit
iteration can enumerate the current preorder and is charged separately. This
does not change handle lifetime, selection semantics, commands, or D's draft work.
Stored published addresses retain identity; APIs that currently return detached
address copies continue to do so.

### 6. Publication lifetime and memory

All new roots belong to the existing projection candidate. `prepare()` and staging
fork roots privately; only the existing publication owner commits the coherent
native/activity/ownership/visibility/view/address tuple. Generation cancellation,
new ingress, changed payload/base/native evidence, limit changes, and eviction
invalidate affected candidates. A rejection cannot mutate published roots.

Indexes hold current immutable records and dependency IDs, not prior `State`
objects, command closures, callbacks, or every historical projection. Old roots
remain readable for as long as their publication is held; eviction drops the live
cache without changing canonical/native facts. After canonical append, preserve
`RetainedEditError`, the original action ID, and single history registration.
C adds no acceptance or publication owner and no canonical writes.

Account for interval nodes, reverse edges, visibility witnesses, raw/normalized
records, address records, and ordering summaries. Release superseded candidate
roots and test repeated prepare/cancel/evict for retained-context chains. These
are C's retained-memory controls; E still owns aggregate/shared/peak measurement.

### 7. Explicit fallback ledger

Record a reason, operation family, affected resources, replay frontier supplied
by B, attempted work, and committed work for every fallback. Proposed categories:

| Condition                                                                        | Behavior and completion requirement                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First open, eviction, or no compatible projection base                           | Full provenance/projection/index seed; record cold reconstruction.                                                                                                                                                        |
| Missing or incompatible producer delta                                           | Keep guarded full projection. Controlled C tests do not waive this condition; production acceptance needs B's reviewed producer.                                                                                          |
| Earlier effect, control, eligibility change, or withdrawal changes B's decisions | Consume B's exact suffix change set; if its dependency summary is incomplete, record that precise missing family and use full reconstruction.                                                                             |
| Local semantic family not yet implemented                                        | During implementation, name the effect and input condition, with a regression and owning patch below. Ordinary split/join, text, deletion, interpretation, lifting, and wrapper cases cannot remain here at C completion. |
| Proven normalization dependency spans a wide region                              | Run shared rules over that region and report real dependents. Whole-document normalization needs an identified dependency, not a generic escape hatch.                                                                    |
| Malformed/unverified native identity, range, membership, or address              | Preserve rejection/unavailability. Reconstruction cannot authorize an otherwise invalid mutation.                                                                                                                         |

This ledger is an implementation deliverable, updated after each patch. No
unlabeled “general case” may hide an ordinary required operation. A conservative
fallback during a separately reviewable intermediate patch is not final acceptance.

## Suggested implementation shape

Each patch has its own correctness and work-count evidence on C's branch:

1. **Persistent visibility foundations.** Incremental exact-deletion roots,
   effect ordering, reverse contributions, raw/normalized records, and controlled
   A-contract inputs. Compare tags and retractions with the independent full scan.
2. **Structural vertical slice.** Participating split/join flows, normalization
   regions, address indexes, and preorder lookup. Repeat the short fixture with
   an unrelated active deletion, dormant birth, and scaffold, plus undo/redo.
   Remove global `stableVisibility` eligibility for compatible local consumers.
3. **Deletion and lifting boundaries.** Captured/inherited coverage, moved
   destinations, concurrent births/splits, witness removal, child lifting, and
   empty-root transitions. Include overlapping/reused tags and controls.
4. **Interpretation and wrapper boundaries.** Competing/dormant packets, masks,
   membership, merged wrapper constituents, section ranges, ordered numbering,
   and mixed affected families. Close ordinary-operation ledger entries.
5. **Producer integration.** The parent integrates C with B's reviewed output;
   verify the same tests through real managed commands and record compatible
   B/C source pins. D retains exact-author prepared-result and full-command work.

Primary files are `materialization/projection.ts`, `text-deletions.ts`, new
adjacent private dependency indexes, and the narrow shared seams in
`projection/project.ts`, `normalize.ts`, `interpretation.ts`, `addresses.ts`,
`visibility/visibility.ts`, `authoring/view-index.ts`, and the existing semantic
normalizer. B's coupled replay, ownership, native refinement, and resource producer
remain outside C's ownership. Coordinate shared type changes through A's contract.

## Non-goals

- Changing deletion, split, private-home, cohort, interpretation, Markdown,
  Unicode, selection, history, or address semantics.
- Replacing the production historical-reader guard, certifying against a merged
  state instead of the exact author closure, or implementing B/D/E.
- A second normalizer, a generic incremental execution framework, a worker,
  dependency upgrade, wire/storage format change, or canonical pruning.
- Changing the independent reference default, merging PR #88, browser cutover,
  physical-storage acceptance, or closing parent grain/94.

## Verification

Keep reference reconstruction outside candidate timing. Use existing
`createMaterializationOracle()` and fresh `openReferenceDocument()` with original
carrier bytes; never pass C's index roots to the reference path.

1. Run the split/type-both/join/unrelated-edit/undo/redo sequence at 10 and 150
   nodes. Preserve an unrelated node, its origins, stored addresses, native reads,
   and earlier publication throughout. Repeat with an unrelated deleted subtree,
   suppressed birth, and scaffold. Assert selected-address lookup and continued
   typing, not just Markdown.
2. For each step compare complete normalized view, constituent/wrapper origins,
   fragment ranges and masks, editable empty slots, visibility tags/order and
   flags, interpretation decisions, raw ownership, and old/new address resolution
   with both affinities. Check saved managed selection and invalid mutation cases.
3. Cover transfers retaining ghost slots; marker-only and joined-empty-home
   changes; dormant split reactivation; concurrent deletion/birth/split; changed
   raw destinations; repeated tags whose first declaration does not cover; packet
   winner undo; wrapper merge/unmerge, lifted children, sections, numbered-list
   suffixes, all-content deletion, and empty-root restoration.
4. Exercise every operation that reaches these structures through real commands:
   insertion, deletion/replacement, split, join, paste, indent, and unindent, with
   relevant undo/redo. Run late earlier delivery, both carrier orders, duplicates,
   retractions, cancellation at yields, rejection, reentrant observers, retained
   append failure, cold reopen, and eviction. Verify canonical bytes do not change
   during projection and old publications remain usable after eviction.
5. Use A's disabled-by-default diagnostics to assert zero full projector,
   provenance, full visibility/deletion-index, and full command-index construction
   within a supported warm **C projection candidate**. Count interval updates,
   token queries, dependency edges, raw/normalized records, ghost readers, child
   array copies, address/rank reads, and explicit exports by purpose. Separate
   author-certification and D-owned draft/staging costs from C's publication costs.
6. Compare fixed affected regions as unrelated node/history/deletion counts grow.
   Unrelated subtrees keep view/address identity and receive no reconstruction
   visits. Exercise a genuinely wide numbering/dependency region separately.
   Diagnostics must include attempted/discarded candidates and lazy reads.

Reuse A's exact 0/100/1,000-action inputs with their hashes and distinct capture
provenance. Load costs are separate from edit timing. Follow diagnostic → vertical
slice → short scaling gates. Record source/workload/runtime and completeness;
report raw times or medians for short samples. Keep each expensive workload near
five minutes maximum, with unchanged assertions and existing deadlines. Timeout
is incomplete evidence. Do not start 10k or long scale work under this proposal.

Run focused materialization/projection/visibility tests, `npm run build`, relevant
lint/format and boundary checks after implementation. Preserve full suite/corpus
coverage at the shared integration gate. Existing tests that assert the old full
path must gain equivalent semantic and local-work assertions; do not simply
delete their verification. C-local evidence cannot establish the full-command
latency targets or B+C+D acceptance.

## Success criteria

- The warm split/join fixture and unrelated text edit use resource-local C
  projection with and without difficult features elsewhere, including undo/redo.
- Complete observations match independent reconstruction; unaffected published
  view/address records retain identity and old publications stay readable.
- Warm local changes update relevant deletion contributions, visibility, origins,
  normalization regions, and address indexes without full projection/provenance
  or hidden whole-history/index rebuilding.
- Required deletion, interpretation, lifting, and wrapper families have separately
  reviewed patches and tests. Every remaining fallback has an exact condition and
  accountable owner; ordinary required edits have no catch-all fallback.
- Production integration consumes B's reviewed output at recorded compatible
  source pins. Canonical facts, reference default, semantic guards, and the single
  publication owner remain intact.
