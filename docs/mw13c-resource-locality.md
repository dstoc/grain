# MW-13C projection locality

Issue: grain/104. Base: `c9327db5209ad1d566c6f2ef84e4186cba6d40a5`
on `feat/94-incremental-materialization`. The approved proposal is grain/104's
`proposal` v1 and proposal PR #93. Implementation PR #95 owns this child branch.
The parent owns production B+C integration and PR #88. This document does not
establish complete C, integrated performance, or parent acceptance.

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

Region dependencies retain former as well as current raw inputs. Wrapper groups
expand across actual raw sibling boundaries, including the barriers that exist
before empty-container cleanup. Section dependencies include the connected root
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

| Operation/input condition                                                    | Current behavior and remaining gate                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First open, eviction or no compatible retained source                        | Full provenance/projection/index seed; expected cold path.                                                                                                                                             |
| Production structural commands through `prepare()`                           | Guarded full structural projector. The parent must wire reviewed B `StructuralChanges` into the local consumer and verify compatible source pins. C-controlled differences do not establish that gate. |
| Producer declines structural/native refinement                               | Preserve B's suffix/cold fallback and historical-reader guard. C supplies no marker-only exemption.                                                                                                    |
| Exact controlled append, earlier arrival or batch                            | Local visibility, interpretation, region/view/address candidate for split/join, text, deletion, transfer, placement, lifting, interpretation, wrappers, sections, numbering and history.               |
| `incompatible-base`                                                          | Base is not the current projection; reject reuse.                                                                                                                                                      |
| `missing-exact-addition`                                                     | Missing exact source metadata, no addition/duplicate, withdrawal, replacement or an action outside the certified addition set; reconstruct through the owner.                                          |
| `missing-semantic-action`, `missing-control-target`, `missing-packet-member` | Required body is absent from the exact candidate source; decline reuse.                                                                                                                                |
| `missing-birth-coverage`                                                     | New allocations lack complete, unique allocating-closure coverage; decline reuse.                                                                                                                      |
| `unknown-resource`, `unknown-native-resource`                                | Supplied node/tape is outside retained candidate resources; decline reuse.                                                                                                                             |
| `missing-root-run`, `incompatible-root-run`, `missing-destination-witnesses` | Producer metadata is incomplete or names incompatible flow lineage; decline reuse.                                                                                                                     |

Normalization-boundary diagnostics such as `wrapper-boundary`, `section-range`,
`child-lifting` and `presentation` now select the shared regional schedule. They
are not full-projection fallbacks. No ordinary semantic family is hidden behind
an unlabeled general-case fallback in the controlled consumer.

## Verification and remaining acceptance

Tests compare complete normalized views, constituent/wrapper origins, fragments,
masks, editable empty slots, visibility tags and flags, old/new address resolution,
held publications and canonical bytes with independent reconstruction. Controls
cover 10/150-node traces, unrelated deletion/suppression/scaffolds, reused tags,
concurrent births/deletion/splits, transfers and ghost slots, packet winners and
membership, wrapper cleanup, sections, ordered numbering, paste, indent/outdent,
all-content deletion, exact batches, earlier arrivals, cancellation and eviction.

The remaining acceptance gate is consumption of reviewed B output and production
managed-command verification at compatible B/C source pins, including exact
suffix/retraction/earlier-arrival evidence. The parent owns that integration.
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
