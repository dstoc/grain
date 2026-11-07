# Exact-author ownership proof reuse

Issue: grain/104, assigned narrow D slice on draft PR96. Technical proposal v4
was approved at `e8128a7` in `cmt_nGtOKK4V1HEGSYpn`. This implementation replaces
only the full ownership replay for a supported new local action. It does not
replace structural selection staging or establish whole-command performance,
readiness, independent implementation review, or B/C/parent acceptance.

## Attempt and proof lifetime

`IndexedActionStore.checkLocal()` opens a private attempt only after checking
integrity, references, actor order, ready dependencies and Lamport time. Its
supplied ready dependencies must cover every head of that exact immutable ready
root; redundant ready dependencies are allowed. The attempt binds final encoded
envelope bytes, store owner, facts version, readiness generation, payload/ready
roots, author-past identity and dependency certificate tokens. Remote readiness
validation never opens this registry entry.

Ingest applies the candidate to its isolated exact-author native branch, then
checks native references and allocations. Only then does `bindAuthorNative()`
attach a fresh native-attempt token. The existing projection and ownership
preambles still resolve births, activity, interpretation selection, allocations,
snapshots, membership, homes and edge brackets.

The optional provider runs outside both semantic rejection catches. It checks the
committed publication and C/B tuple, including exact genesis, ready/native roots,
checkpoint, C state and both preparation generations. It forks that owned B
prefix and derives changed tapes from the validated final native manifest and
allocations. It reads the already validated snapshots, never compiler-supplied
tape claims. Candidate activity must match the selected ownership input.

`MaterializedOwnership.prepareAuthor()` permits exactly one ordered append. Its
strict mode declines at the computed native/activity frontier **before** resource
reconstruction or any old suffix replay. Ordinary native-refinement and reserved
reader guards remain in place. It executes the candidate's ordinary constructor,
layout and coverage checks plus the author-only split predicates at the actual
pre-effect prefix. It returns a detached proof, never candidate roots or a commit
closure. It does not commit its fork.

The private proof registry retains owned action bytes, opaque identity tokens,
versions, completed ordinal count and detached refinement witnesses. It retains
no native facade, B fork, activity callback, request, document or checkpoint.
Consumption rechecks the live attempt and publication guard and removes the
proof. The enclosing local attempt's `finally` removes every minted proof,
including one lost after minting but before the provider returns. Every private
fork is evicted in the provider's `finally`. Retry certification and existing
same-action ingest certificates keep their separate contracts.

## Skipped-check crosswalk

The independent `ownership/ownership.ts` full replay remains unchanged. Its shared
cut helper now tags its existing data errors; no ordering or cut rule changes.

| Full replay obligation                                        | Proof path evidence or executed check                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact semantic input order and complete retained payloads     | Store head coverage and dependency certificate binding; C/B ready/payload roots; B strict single append. No new control or interpretation can change retained eligibility.                                                                                          |
| Complete tape/marker coverage, endpoints and native bindings  | Exact genesis and author-past native branch; `OwnershipResources.append()` validates candidate allocations, changed tape endpoints and marker native identities, snapshot-marker counts and complete tape counts. Native withdrawal/reorder declines before replay. |
| Unique homes and full fresh trailing home tapes               | Unchanged prefix resource roots; original `deriveHomes()`/edge-bracket preambles; appended resource/home validation.                                                                                                                                                |
| Nonoverlapping skeletons and nonreserved captures             | Prefix subdivision preserves retained range endpoints and disjointness. `OwnershipResources.append()` checks new skeleton cells, captures, split root occurrences and canonical empty cuts. Home refinement updates each touched tape's reserved edges.             |
| Immutable allocation, occurrence, run/flow and birth bindings | Candidate `MaterializedLayout.beginAction()` and batch checks; retained prefix roots; ordinary per-ordinal slot, placement and join/cycle checks. Births enter before effects, even for inactive intentions.                                                        |
| Owned-cell reachability and reserved assignments              | Each checkpoint refines its own assignments and coverage. Existing `OwnershipCoverage` checks dirty components at births, structural steps and completed action; final installed tape count remains checked.                                                        |
| Author split source availability                              | The candidate author mode rejects a source born by a split at the same or a later ordinal.                                                                                                                                                                          |
| Empty source completeness                                     | Candidate source must be standalone and have no ordinary cells in its actual raw traversal.                                                                                                                                                                         |
| Basis occurrence, adjacency and order                         | Candidate cells must retain authored occurrences and consecutive positions in the pre-effect top-level source traversal, excluding reserved cells and retaining ordinary empty cells. Joined sources use their actual component.                                    |
| Captured skeleton                                             | Existing cut rules select the authored side; the new run's skeleton, excluding its fresh home, must equal that side.                                                                                                                                                |
| Destination requirements and split cohorts                    | Existing `StructuralIndex.refresh()` updates the affected requirement/cohort dependency groups before proof completion. Full exports remain independent reads.                                                                                                      |

Known data assertions in the materialized layout/resource/home/cell/coverage/replay
modules use `OwnershipValidationError`. The provider rejects only that class.
Unexpected provider, host, capacity and cancellation errors propagate through
`AuthorProofProviderError`, with the original cause. No generic exception becomes
an unavailable proof or successful validation.

## Supported operations and misses

A proof supports one `SplitFlow` or `JoinFlow`, optionally accompanied by ordinary
`SetProperties`, `InsertText` and `DeleteText` effects. Prior deletions, suppressed
births, scaffolds and interpretations are not blanket exclusions.

| Input condition                                                                                               | Result                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Reference document, remote admission, unindexed context or missing current head                               | Full validation in that author's exact closure; `not-exact-local-author` when the provider is reached. |
| Candidate packet/alternate interpretation                                                                     | Projection retains complete packet and author validation; no proof provider is used.                   |
| Candidate control, transfer, move/lift, birth-only or multiple structural effects                             | `unsupported-effect-shape`; full author certification. Text/property fast validation remains separate. |
| Stale/non-authorable publication or unindexed ready input                                                     | `unavailable-publication` or `unindexed-ready`; full certification.                                    |
| Cold/evicted/mismatched C/B tuple                                                                             | `unavailable-owned-base`; full certification, with ordinary publication reseeding B.                   |
| Different selected candidate activity                                                                         | `changed-candidate-eligibility`; full certification.                                                   |
| Earlier/inexact B order or more than one append                                                               | `not-exact-single-append`; full certification before old replay.                                       |
| Missing native continuity, withdrawal/reorder, changed order/activity or reserved-to-ordinary reader frontier | Named native/frontier miss from strict B preparation; full certification before old replay.            |
| Invalid membership, references, native body, homes/brackets, constructors or author predicates                | Existing semantic rejection before append; no proof.                                                   |
| Changed facts/generation, competing preparation, invalid/expired proof or operational failure                 | Cancel/propagate; no append or stale certificate.                                                      |

## Work and verification

`authorProofDiagnostics()` reports requests, completed proofs, candidate ordinals,
rejections, named misses, old B actions replayed and discarded private forks.
Opt-in diagnostics additionally charge preamble actions/allocations/homes/snapshot
parts, candidate ordinals, split predicates, proof suffix/old actions, snapshot
parts read and discarded candidates. Existing B counters charge native cells,
refinement, resources, coverage and changed roots. `projectionAuthor.preamble*`
charges the separate projection preamble. Compiler queries can also execute a
suffix under the `author` purpose; `authorProof.suffixActions` isolates proof
work. Inclusive public spans must not be summed as exclusive work.

New regression tests cover exact bindings, forged/partial/expired proofs, missing
and redundant heads, reentrant facts, valid and invalid splits, joined/empty
sources, historical native-reader decline before replay, cold fallback, property
undo, continued typing and retained structural append recovery. The existing
complete depth-0/8/32 execution fixture, oracle, assertions and 5,000 ms deadline
are unchanged. A companion test checks actual proof hits for every managed warm
split with zero full author ownership reconstruction. Existing production traces
cover distant deletion/suppression/scaffolds and full output, origin, visibility,
address and old-reader comparisons.

Run the detached-lifetime control with Node 24.22.2:

```sh
node --expose-gc --import ./benchmarks/multiwriter/resolve-ts.mjs \
  --test benchmarks/multiwriter/author-proof-gc.test.mjs
```

Exact-source results and failed development attempts belong to the issue's
implementation evidence. Local passes do not replace final-head CI or independent
review. The known `a2ca56b` CI timeout and earlier 338.96-second retention workload
remain historical failures; this document does not relabel them as passing.
