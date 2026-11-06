# MW-13C projection locality

Issue: grain/104. The controlled C slice was integrated through PR #95 at
`864a182`. The production continuation uses approved proposal v2 and draft PR #96,
branch `integration/104-production-projection`, over exact B+C `65ab8f5`.
The parent owns shared integration and PR #88. This document does not establish
complete C, integrated performance, readiness authorization, or parent acceptance.

## Candidate and resource contract

`MaterializedProjection.prepareStructural()` consumes an exact local producer
result. It requires the current base projection, a compatible ready-source root,
a candidate action/revision, final ownership/native inputs, changed flow readers
and containers, root runs, affected/native tapes, exact allocating-closure birth
coverage, and complete destination requirements for changed nodes.

Exact additions can be a local append, an earlier concurrent arrival, or a batch.
Semantic bodies come from the certified ready source. Controls also invalidate
their targets; interpretation changes expand member eligibility dependencies.
Text births retain each allocating action's identity, including inactive births
in a batch. A duplicate has no new candidate. Source withdrawals/replacements
without compatible evidence remain explicit cold conditions.

Preparation creates private roots and emits no canonical writes. The existing
publication owner commits the coherent tuple. Cancellation, another preparation,
eviction or a changed base invalidates commit. Escaping readers own current
immutable roots, not prior State objects or preparation callbacks.

## Deletion, availability and interpretation indexes

Exact text deletions retain per-effect contributions and persistent native-clock
interval roots. Covering declarations keep semantic order independent of dense
active-effect ranks. Removal or reactivation changes only that declaration;
first-covering tag deduplication happens after exact and subtree matches combine.

`SubtreeDeletions` retains birth-parent reverse edges, per-declaration node
coverage, inactive declarations, reused-tag groups and permanent intervals.
Coverage follows birth parents and exact concurrency, never final ownership.
For reused tags, the last active subtree declaration supplies inherited text
coverage. Node tags still accumulate all covering declarations in semantic order.
New concurrent descendants invalidate their own covering groups.

Captured and inherited intervals use persistent marker-ordered search trees with
maximum-end marker summaries. Native insertion preserves endpoint order; numeric
positions and native callbacks are not retained. Queries use the gap after a
current cell's start marker, so scalar UTF-16 visibility does not call a mutation
boundary API on surrogate halves. Empty captured intervals remain indexed for
later insertion. The unindexed query and independent full reducer remain
comparison paths. Dense same-tape queries have bounded search-path tests.

`VisibilityWitnesses` retains active-birth, effective-destination and visible-text
witnesses, raw parent edges, per-tape content counts and subtree totals. Changed
raw paths inspect child summaries without reconstructing unrelated descendants.
Tag and placement changes update deleted destinations and affected flow tapes.
Removing the last scaffold content witness suppresses its header; undo restores
the original lineage and addresses. Text preparation handles hidden and scaffold
readers through these witnesses rather than a document-wide eligibility flag.

`SplitVisibility` retains source-to-split readers and weak derivations. A changed
raw source path or deletion tag revisits its dependent splits. Concurrency checks
include every active declaration of a reused tag on the source's raw ancestor
path. Hidden split births and their destination requirements feed availability
separately from deletion and raw ownership.

`MaterializedInterpretations` retains losing/dormant packets, active source
candidates, explicit member eligibility, packet-owned birth readers and ordered
per-field property contributions. Source and property winners use persistent
ordered roots. A property append does not scan retained source history. Packet
identity changes invalidate dormant birth readers as well as current winners.
Mask contributions use exact native ranges and include empty queries at interval
ends. Complete packet/mask exports are lazy and charged; selected reads do not
export all sources.

## Views and one-pass normalization

The inert paragraph path preserves real document, quote, list-item and section
context. Other supported changes reconstruct raw inputs in connected normalization
regions and call the existing shared one-pass normalizer once. They do not run a
second normalizer or normalize previously normalized output again.

Region dependencies retain former as well as current raw inputs. Retained raw boundary summaries distinguish same-type merge runs from different
nonempty wrappers. A structural change refreshes its affected top-level summaries;
unrelated wrapper descendants are not traversed. The planner connects actual merge
runs and cleanup-origin contributors, preserving available empty barriers until
the shared pass removes them. It also retains invisible/cleaned gap dependencies,
former departure gaps and new barriers between former output contributors. A batch
of moved root barriers is handled together. Merged-container child changes use this
regional schedule because an empty constituent can become a separate output. Section dependencies include the connected root
section suffix and the real preceding non-section ordering context. Lifting,
merged constituents, wrapper origins, empty-container cleanup and ordered-list
numbering use the same shared rules and pass order as full reconstruction.

Participating regions rebuild their raw structure. Unchanged inline readers reuse
their text projection; mask, native, tag, ownership and ghost-reader changes
invalidate that reuse explicitly. Complete metadata comparison restores equal
view, origin, fragment, boundary, wrapper and address identities. Unrelated root
regions retain their records. Root child-array copies and boundary summaries are
charged. A genuinely wide section range or numbering region remains wide work;
it is not hidden as a constant-cost operation.

Read-only addresses use indexes registered for the exact ownership/visibility
pair. They preserve captured lineage, source-deletion checks, destination
availability and native boundary validation. An unregistered pair keeps the
independent full lookup. Returned addresses remain detached copies.

Command lookup retains publication-local `construction:<ordinal>` preorder
handles. Persistent origin records and weighted sibling trees provide rank/select
without rewriting following handles or lazily constructing a complete map.
Explicit full iteration is separate and charged.

## Fallback ledger and integration boundary

| Operation/input condition                                                    | Current behavior and remaining gate                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First open, eviction or no compatible retained source                        | Full provenance/projection/index seed; expected cold path.                                                                                                                                                                                                          |
| Production structural commands through `prepare()`                           | One retained B producer and exact resource adapter feed the local C builder. Managed 10/150 split/type/join/distant-edit/history controls cover difficult features. Broader acceptance remains source-scoped.                                                       |
| Producer declines structural/native refinement                               | Preserve B's suffix/cold fallback and historical-reader guard. C supplies no marker-only exemption.                                                                                                                                                                 |
| Exact controlled append, earlier arrival or batch                            | Local visibility, interpretation, region/view/address candidate for split/join, text, deletion, transfer, placement, lifting, interpretation, wrappers, sections, numbering and history.                                                                            |
| Structural list/item/quote edit beside consecutive nonempty mixed wrappers   | Separate regions across different nonempty wrappers. The original failing ordered-list split probe is retained as a passing regression. Quote-growth controls at 8/32/128 paragraphs rebuild seven list-region nodes and inspect seven boundary nodes at each size. |
| `incompatible-base`                                                          | Base is not the current projection; reject reuse.                                                                                                                                                                                                                   |
| `missing-exact-addition`                                                     | Missing exact source metadata, no addition/duplicate, withdrawal, replacement or an action outside the certified addition set; reconstruct through the owner.                                                                                                       |
| `missing-semantic-action`, `missing-control-target`, `missing-packet-member` | Required body is absent from the exact candidate source; decline reuse.                                                                                                                                                                                             |
| `missing-birth-coverage`                                                     | New allocations lack complete, unique allocating-closure coverage; decline reuse.                                                                                                                                                                                   |
| `unknown-resource`, `unknown-native-resource`                                | Supplied node/tape is outside retained candidate resources; decline reuse.                                                                                                                                                                                          |
| `missing-root-run`, `incompatible-root-run`, `missing-destination-witnesses` | Producer metadata is incomplete or names incompatible flow lineage; decline reuse.                                                                                                                                                                                  |

Normalization-boundary diagnostics such as `wrapper-boundary`, `section-range`,
`child-lifting` and `presentation` now select the shared regional schedule. They
are not full-projection fallbacks. Zero full-projector counters do not establish production integration, end-to-end
latency or C completion.

## Verification and remaining acceptance

Tests compare complete normalized views, constituent/wrapper origins, fragments,
masks, editable empty slots, visibility tags and flags, old/new address resolution,
held publications and canonical bytes with independent reconstruction. Controls
cover 10/150-node traces, unrelated deletion/suppression/scaffolds, reused tags,
concurrent births/deletion/splits, transfers and ghost slots, packet winners and
membership, wrapper cleanup, sections, ordered numbering, paste, indent/outdent,
all-content deletion, exact batches, earlier arrivals, cancellation and eviction.

The production candidate consumes B's exact changes. Managed 10/150-node traces
check warm publication with distant deletion, suppression and scaffolds. Remaining
acceptance includes broader production semantic, suffix/retraction/earlier-arrival,
atomicity, retention and compatible-head CI evidence. Fresh broad correctness/static reports
and any deadline failures remain separately source-scoped; earlier reports do not
prove later changes. The parent owns that integration.
Controlled fixtures build complete differences outside C timing and preserve
independent full comparisons; they do not certify B's producer.

Source-scoped reports accompany the issue artifacts. No full-suite, long retention,
uninterrupted trace, latency target, storage, browser, 10k workload or parent
acceptance follows from these local correctness and work-count controls.

Warm text witness updates apply visibility differences to retained tape counts
when the producer certifies unchanged raw ownership. Permanent run-to-flow and
flow-root maps avoid repeated layout lookup or lazy complete home-index creation.
Hidden and merged property constituents also use the shared regional schedule;
the representative keeps its own properties, while later separation exposes the
constituent's retained values.

The regional test driver keeps every address assertion. Each fresh reference
checkpoint supplies its complete detached allocation array once to an unregistered
ownership facade. Every reference address still runs the independent full lookup;
no candidate index or retained checkpoint enters that path. This avoids cloning
the same complete allocation array for each address. Oracle code, traces and test
deadlines are unchanged.

## Review corrections and work accounting

Command-index refinement reads old removal and sibling-boundary positions from
its prior publication. A destination visited first cannot overwrite the source's
removal position. Managed regressions cover both cross-parent traversal directions,
paragraphs and nonempty subtrees, full enumeration/rank/select, origin handles,
parents/siblings and held prior indexes.

Property invalidation compares before-state properties with the candidate
interpretation's properties. Checked-property undo/redo is compared with a
separately opened reference, including explicit false/true values. Full visibility
exports use retained semantic action/allocation order for both nodes and tapes.
Earlier allocating arrivals update ordered roots during preparation; complete
exports remain lazy and charged. They retain neither a previous ready array nor
a preparation callback.

Boundary summaries contain raw projected types and cleanup-content witnesses.
They schedule dependencies, not normalized output. The shared normalizer still
owns section placement, wrapper merging, cleanup and ordered numbering. Prior
output spans include negative gaps, and candidate spans detect a restored barrier
between former contributors. Each dependency range/output is expanded once. The
boundary schedule's root entries, prior inputs, sort comparisons, expanded ranges
and affected subtree reads are charged. Old publications retain immutable roots.

Birth-parent arrays have a separate cost: appending one birth under a parent with
N retained birth siblings copies N entries. `subtree.birthSiblingEntriesCopied`
charges that actual changed-parent work. The 8/32/128 growth controls assert those
counts and compare later inherited coverage with the full reducer. This is not a
constant-work claim and is separate from dense text/deletion interval queries.

The regional schedule also reads/copies root-width ordering data. Its counters do
not claim those arrays or boundary tables are constant work. Increasing an
unrelated quote's descendants does not increase regional subtree reconstruction;
a genuinely wide merge, section suffix or ordered numbering region remains wide.

## Production adapter and installation

`MaterializedOwnership.prepareReady()` reads the certified suffix through indexed
ready access and retains B's ordered payload entries for the prefix. Fresh batches
supply exact `reconstructBirthContent()` coverage, including inactive allocations.
Earlier arrivals retain B's complete ordering audit. Resource rebuilds explicitly
materialize and charge the retained inputs; the independent reference assembles
all batches itself.

`projection-adapter.ts` binds the old C state to B's exact genesis, native view,
ready source and checkpoint. It visits both sides of assignment, placement, flow,
run, occurrence, root, attachment, cohort and requirement deltas. Selected flow
ancestry retains private-home headers and effective destinations. A work queue
expands participating tapes through C's existing reverse readers, including ghosts.
Destination contributions remove old effect references and add new references to
complete retained per-node witness arrays. Semantically equal entries recreated
by historical replay do not dirty C; visits to those delta entries remain charged.

Text/property publications advance the same checkpoint binding. C's private state
builder has no independent generation or producer commit. A local production commit
retains the owned B producer. The public controlled seam still evicts that producer
after an external commit. A C decline uses the same prepared B result for full
projection/indexing and installs a coherent binding; it never prepares a second B.

Adapter declines are `incompatible-producer-base`, `incompatible-producer-candidate`,
`incompatible-producer-source` and `missing-exact-addition`. Cold open/eviction and
C's exact metadata declines retain named full reconstruction. Required ordinary
commands producing incomplete metadata remain integration defects.

Activity, B and C candidates expose nonmutating `assertCurrent()` checks. The
publication hook captures the pair and checks all participants before installing
any root. B prepares checkpoint refinement, positions, resources and counters
before installation. Commit does not read a ready sequence or refine checkpoints.
Stale activity/B/C, each eligibility failure and cancellation after C construction
leave the old tuple and committed roots intact; retry is checked independently.

Diagnostics retain aggregate resource IDs and also qualify them by purpose.
`publication/...` identifies accepted-state work; `staging/...` and `author/...`
remain separate. D's full pre-append staging and exact-author work are unchanged.
A history control can require B's genuine historical suffix replay, including a
replay from zero before the first periodic checkpoint. This does not imply full
C provenance/projection/index reconstruction.
