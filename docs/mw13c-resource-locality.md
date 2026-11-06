# MW-13C projection locality

Issue: grain/104. Base: `c9327db5209ad1d566c6f2ef84e4186cba6d40a5`
on `feat/94-incremental-materialization`. The approved proposal is in grain/104's
`proposal` artifact and draft proposal PR #93. This document records implementation
coverage. It does not establish C completion, B+C integration, or parent acceptance.

## Persistent foundations

Exact deletion contributions have persistent interval roots per tape/client and
reverse effect identities. Updates, removal and reactivation copy affected search
paths. Queries order covering declarations with `compareEffects()` before tag
deduplication. Earlier arrivals do not renumber unrelated contributions. Dense
active-effect ranks exist only in the full projection adapter, never in retained
roots. The full visibility reducer remains independent.

Text eligibility depends on the edited tapes and their projected readers. Captured
subtree intervals and inherited birth-content intervals now have retained
declaration and tag-group contributions. Coverage follows birth parents and exact
concurrency, including dormant declarations and new descendants. A reused tag's
last active subtree declaration supplies its inherited text coverage; direct node
tags still accumulate covering declarations in semantic order. Queries inspect
the edited tape's groups, never all document deletion declarations. Contributions
retain permanent intervals, including empty intervals. Unavailable, suppressed or
scaffold readers require visibility-witness maintenance before local text can use
them. Other tapes remain eligible. Property-only checked/info updates retain their
existing restriction to represented, unmerged origins.

Read-only address indexes are registered for the exact ownership/visibility pair.
They index retained node existence, source flow homes and node visibility. They
preserve captured lineage, source-deletion checks, destination availability and
native boundary validation. An unregistered pair uses the full lookup. Returned
addresses remain detached copies. Held publications keep their own index roots.

Command lookup preserves publication-local preorder `construction:<ordinal>`
handles. Persistent origin records and weighted sibling trees compute rank/select.
Insertion does not rewrite following handles. Refinement inspects changed parents'
child arrays and reports that work; it does not visit unchanged descendants.
Explicit iteration is separate and charged. No previous index wrapper is retained.

## Fallback ledger

These conditions remain explicit. An intermediate patch is not issue acceptance.

| Operation/input condition                                                                           | Current behavior                                         | Remaining owner/work                                                                                           |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| First open or eviction                                                                              | Full provenance, projection and index seed               | Expected cold path                                                                                             |
| Exact ready-source additions, including ordinary structural actions                                 | Reuse deletion roots; full structural projection remains | B supplies reviewed resource delta; C consumes it                                                              |
| Text insertion/replacement/control on tapes outside subtree coverage, with available active readers | Local visibility/text/view/address projection            | Covered by focused tests                                                                                       |
| Text touching captured/inherited subtree tapes with represented available readers                   | Local text/tag queries on affected tapes                 | Covered by same-tape sibling deletion, text/history and controlled split/join tests                            |
| Text touching an unavailable/suppressed/scaffold reader or a tape without projected readers         | Full visibility/projection                               | C witness additions/removals and ghost-reader updates                                                          |
| Checked/info updates on a represented single-origin node                                            | Local view replacement                                   | Covered by existing and extended tests                                                                         |
| Checked/info updates on a hidden or merged constituent                                              | Full projection                                          | C raw/normalized constituent records                                                                           |
| New interpretation, or control of an action containing interpretation                               | Full deletion-index seed and projection                  | C packet eligibility/mask delta index                                                                          |
| Ready-source withdrawal, replacement, or missing exact compatibility metadata                       | Full deletion-index seed and projection                  | Consume explicit removal/eligibility deltas from the shared contract                                           |
| Structural split/join, placement, lifting, deletion, wrapper/section/numbering change               | Guarded full projector and provenance reconstruction     | C structural region consumer and shared one-pass normalization schedule; B retains replay/refinement ownership |
| Producer declines a text/property refinement                                                        | Guarded coupled/full path                                | Preserve B's historical-reader guard; no marker-only exemption                                                 |

The remaining structural row names required operation families. It is unfinished
work, not an accepted general-case fallback. Production integration must use B's
reviewed output at compatible pins. C-controlled changes cannot establish that gate.

## Verification scope

Focused tests compare exact tags and order, complete independent projections,
preorder handles, selected addresses, unrelated record identity, held publications,
native bytes and eviction. Work controls cover a 4,096-declaration tape, one changed
subtree among 150 paragraphs, and repeated insertion into one sibling gap.
No canonical write, protocol change, dependency change, oracle change or historical
reader exemption is part of these foundations.

## Controlled structural consumer

`MaterializedProjection.prepareStructural()` consumes C's narrow adapter of A's
contract. It requires the exact base projection, a certified ready-source suffix,
the candidate action/revision, final ownership/native inputs, changed flow readers
and containers, root runs, affected/native tapes and destination witnesses. It
returns private roots or a named fallback. The existing owner commits the result;
preparation emits no canonical writes. Cancellation, another preparation, eviction
or a changed base invalidates commit. Production wiring is not enabled here.

The controlled slice covers paragraph splits/joins, literal input and their
controls in unchanged document, quote, list-item and section containers. Raw and
normalized membership stay separate. Merged quote constituents keep their own
wrapper boundary origins; changed last-child gaps update the corresponding raw
wrapper only. Changed normalized parents and ancestor paths are replaced.
Unchanged subtrees retain their view, address and index identities.

This slice skips the shared normalizer only when paragraph leaves, container
membership, wrapper constituents and section boundaries prove the region inert.
It does not normalize a detached section or run normalized output a second time.
An empty container, a new merge boundary or a split through merged constituents
requires the next shared normalization patch. Actual list Enter that allocates an
item and changes markers is not the inert paragraph-only case.

Syntax-mask queries now use persistent tape/client interval roots. They preserve
full native-range containment, including empty queries. Controlled packet changes
replace or withdraw their own contributions. Full interpretation changes still
seed winner/membership selection and the mask index; incremental packet selection
and eligibility invalidation remain unfinished.

The observed B development contract at PR #94 head
`2301529fb2466120cb084ac0ade52bf27ba489b1` supplies `StructuralChanges` through
`prepare().value.changes` and specialized `structuralChanges`. The parent adapter
must map its exact base/candidate, assignment/run/flow/attachment changes, old/new
block parents, native tapes and destination-requirement deltas into this consumer.
The controlled fixture constructs full snapshot differences outside C timing.
It does not certify B's producer or remove B's reader guard.

### Controlled fallback conditions

Fallbacks return the operation family, affected nodes/tapes and supplied replay
frontier/reason. Diagnostic work includes attempted candidates. These are interim
conditions, with C owning the remaining region/visibility work.

| Reason                                                                                                    | Input condition and next work                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incompatible-base`, `missing-exact-suffix`                                                               | No exact current base or single ordered suffix; consume reviewed suffix/retraction evidence before extending reuse.                                                                                     |
| `semantic-<effect>`, `wrapper-placement`                                                                  | Changed interpretation/properties, subtree deletion, nonempty lifting, transfer or wrapper placement; add that family's explicit semantic dependencies.                                                 |
| `node-deletion-coverage`, `parent-visibility`, `birth-coverage-region`                                    | Changed node deletion, unavailable parent or changed birth region still needs availability-witness updates. Directly deleted ghost readers with unchanged coverage have no projected header to rebuild. |
| `unknown-resource`, `unrepresented-container`, `container-kind`, `former-normalization-parent`            | Missing resource or normalized parent membership; retain raw records and expand the actual region.                                                                                                      |
| `child-lifting`, `normalization-region`, `normalized-constituents`                                        | Changed children, non-paragraph presentation or grouped output; restore the relevant raw constituents and run the shared one-pass rules.                                                                |
| `wrapper-boundary`, `normalized-constituent-split`, `empty-container-region`                              | A new adjacency, separated merged constituent or empty wrapper requires shared merge/cleanup dependencies.                                                                                              |
| `section-range`, `changed-normalized-parent`                                                              | Heading-dependent containment or changed projected parent needs the shared section range.                                                                                                               |
| `presentation`                                                                                            | Affected inline is not a paragraph; add that presentation's dependencies.                                                                                                                               |
| `missing-root-run`, `incompatible-root-run`, `missing-destination-witnesses`, `missing-normalized-output` | Incomplete/incompatible producer resources; decline rather than invent lineage, availability or output.                                                                                                 |

This is an initial slice for separate review. Availability-witness updates,
interpretation winner/membership updates, lifting, wrapper merges, section ranges,
ordered numbering, retractions/earlier arrivals and reviewed B production
integration must be completed before grain/104 can be accepted.

## Continuation: captured and inherited contributions

`SubtreeDeletions` retains birth-parent reverse edges, per-declaration node
coverage, reused-tag groups and tape readers. Compatible ready additions update
only new births and named effects/controls. First open, incompatible sources and
interpretation eligibility changes still use a named cold seed. Retraction and
reactivation controls preserve held roots. Text queries combine subtree and exact
declarations before first-covering tag deduplication.

Real managed replacements and undo/redo remain local when a deleted sibling
shares the edited paragraph's native tape (10/150 nodes). The controlled
split/join/undo/redo trace on that tape also remains local. Complete view and
visibility, native retention, unrelated view identity and held reads are compared
with independent reconstruction. This adds coverage; it does not establish
subtree-deletion mutation locality, availability maintenance, normalization or
reviewed B integration. Tape-local group queries still inspect that tape's
relevant interval contributions; dense same-tape coverage is charged explicitly.

## Continuation: availability and weak split witnesses

`VisibilityWitnesses` retains birth/destination/content witnesses, raw parent
edges, per-tape visible-content counts and subtree totals. A structural candidate
updates changed raw paths and child summaries; it does not reconstruct unrelated
subtrees to decide scaffold or suppression state. Text publication keeps the
counts current. Visibility remains separate from normalized membership.

`SplitVisibility` retains source-to-split readers and hidden derivations. A tag or
raw-parent change expands through its actual source descendants. Only their split
readers are checked for concurrent deletion. Reused tags use every active
subtree declaration for concurrency, as the full projector does. Hidden split
births and effective destination requirements feed the availability index.

Controlled paragraph deletion, undo/redo, and subsequent editing at 10/150 nodes
now use local candidates. A concurrent deletion/weak-split trace also passes
complete independent view, visibility, saved-address and held-publication checks.
Wrapper/section/lifting normalization remains a separate unfinished patch. The
production structural path and B integration gate remain unchanged.
