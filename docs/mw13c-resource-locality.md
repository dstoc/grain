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
subtree intervals and birth-content tapes with direct/inherited tags exclude only
those resources. Empty captured intervals are included. Unavailable, suppressed or
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
| Text touching captured/inherited subtree tapes, including empty intervals                           | Full visibility/projection                               | C interval and availability-witness updates                                                                    |
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
