# Proposal: MW-04 ownership and split/join/transfer algebra

- **Issue:** grain/85.
- **Status:** Proposed; requires proposal review before implementation.
- **Authority:** [MW-00 proposal, version 1](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/81), especially §§5–7, 12–14. This document specifies implementation boundaries and verification; it does not replace the schema-3 contracts.
- **Inspected baseline:** `yjs` at `046410d155fcb9d93414696113a23a7bf4151472`. The implementation branch is `feat/85-ownership-algebra`, based on `origin/yjs`. PRs target `yjs`.
- **Dependency:** MW-02 native tapes and MW-03 layout. Both modules exist in the inspected tree. Yjs remains pinned to 13.6.33.

## Motivation

Two disconnected authors split `abcdef`: A cuts after `ab`, and B cuts after `abc`. After exchange, both cuts must survive as `ab | c | def`, regardless of which action sorts first. Assigning each whole suffix to the latest run loses one cut. Sorting the resulting siblings by ordinary action priority can instead display `ab | def | c`.

MW-04 implements the component-selection rule and split-cohort ordering already specified by the master proposal. It also supplies exclusive cell ownership through joins, transfers, retraction, and native marker refinement. The first consumers are headless ownership tests, followed by MW-06 projection and MW-08 composition.

## Problem statement

`src/markdown/multiwriter/contracts.ts` defines `CellAssignment`, `RunLayout`, `FlowBasis`, `RangeRef`, `InlineSlot`, and the structural effects. No `multiwriter/ownership/` implementation exists.

`text/cache.ts:NativeTapeCache` supplies `snapshot()`, `marker()`, `range()`, and `lookup()` over real insertion-only native tapes. Snapshots include permanent embeds, text identities, and converged native order. This module deliberately does not assign ownership.

`layout/layout.ts:LayoutPrefix` supplies retained allocations, run skeletons, flow ancestry, cycle-safe joins and moves, and one step per semantic effect. `beginAction()` installs births even when effects are inactive. `step()` handles joins and moves; it leaves split/transfer ownership to this workstream. Its `occurrenceOrder()` and `children()` accept derived `OccurrenceBucket`s from MW-04. Transferred runs already have immutable flow parents through their allocations.

`visibility/visibility.ts:VisibilityLayout` requires final token ownership and permanent-range membership. It separately requires causal birth-content coverage and effective destination requirements. Current visibility tests inject that interface; ownership must not mistake final owner queries for causal birth coverage.

`test/multiwriter/corpus.ts` freezes split, transfer, join, deletion, and undo outcomes. Existing layout tests explicitly cover layout facets without native ownership. `test/multiwriter/network.ts` expects a future integrated replica factory. Neither test suite is an ownership implementation or evidence that the combined algorithm works.

## Proposal

Add a headless full reference reducer under `src/markdown/multiwriter/ownership/`. Use the existing logical types and native/layout modules. Add no dependency, persistent format, shared resource kind, browser integration, or structural authority.

### Inputs and publication boundary

The reducer accepts common-genesis layout/allocation facts, validated home-ownership bindings, native snapshots from one complete ready closure, ordered action inputs compatible with `LayoutActionInput`, and effect activity supplied by the visibility/history layer. Home bindings identify the initial run and occurrence of each tape interval; do not infer a home by picking the first overlapping run skeleton. Split and transfer runs can overlap older skeletons without initially owning those cells.

These bindings are derived integration data, like MW-03's `BirthPlacement`; they are not new envelope fields. The implementation must validate unique home coverage and trace each binding to retained genesis/allocation facts. If the frozen facts cannot determine a required binding unambiguously, stop and report the counterexample before adding a wire field or choosing by allocation order.

Use `compareActions()` and effect ordinals from `contracts.ts`. Construct a fresh disposable `LayoutPrefix` and ownership state for each reference reduction. Publish a result only after replay and invariant checks complete. A missing allocation, unknown marker, invalid native interval, conflicting home binding, or invalid internal basis is an explicit error; do not return a partial result or silently attach content to root.

MW-01/MW-15 own readiness and author-closure validation. An action valid in its author's closure can lose an intention after concurrent merge. Do not reject it merely because the current owner differs from its captured basis occurrence.

### Native cell index and refinement

For each tape snapshot, index markers in actual native order. Consecutive distinct permanent markers define elementary open cells, including intervals with no characters. Use logical resource equality, never object identity or lexical marker-ID ordering. Native positions are local derived indexes and never become shared addresses.

Build the reference cell partition from every ready marker, including inactive ones. When a tape enters at its allocation prefix, seed each refined cell from its unique home interval, then replay active structural assignments over that partition. Do not expose a later-born tape or home run at an earlier prefix. This is equivalent to inheriting an interval's assignment when a marker refines it. A marker with an inactive split effect changes indexing only. Later text ordered inside an existing structural range follows that range's assignment without being copied.

Associate text fragments with their exact `(tape, client, clock, length)` ranges. Native clocks count UTF-16 units; preserve valid surrogate boundaries when mapping fragments. Markers are not editable text. Structural selection uses open permanent ranges; exact observed text deletion remains the visibility layer's job.

Every cell has one `CellAssignment`. Retain immutable run skeletons and slot origins after assignments change. A run can have no currently assigned text and still be an addressable destination. Do not manufacture an empty cell with equal endpoints, a zero-width character, or projection-authored native data.

### Coupled prefix replay

For each action, install retained allocations through `LayoutPrefix.beginAction()`. Process every effect ordinal exactly once, including inactive effects. Establish source/destination and split-component decisions from the pre-effect ownership/layout state, then apply that effect's ownership and layout intentions together before the next ordinal.

- `JoinFlow` delegates containment and cycle safety to `LayoutPrefix.step()`. It changes no cell assignment. Nested source headers are a projection concern.
- `MoveBlock` uses the existing block and standalone-flow intentions, including MW-03's reviewed behavior for a cycle-rejected block move. It changes no cell assignment.
- `TransferRange` installs ownership in its allocated run and occurrence at its retained destination slot. The run's immutable containing flow comes from its allocation. Do not add a second movable run-to-flow edge.
- `SplitFlow` assigns only the selected component to the allocated new run. Its new block retains its authored outer birth placement.
- Inactive effects perform no assignment or attachment. Their allocations, markers, skeletons, and occurrences remain available.

Recompute from retained facts after a late earlier action or changed activity. Never cache a final joined-flow graph and reuse it to interpret older splits. Full replay is the reference path; MW-13 owns production incremental replay.

### Ordered traversal and transfers

Provide one deterministic raw inline traversal that combines each run's authored skeleton order, current exclusive assignments, and retained run/flow attachments. Insert attachments at their original boundary/side and predecessor sequence using MW-03 occurrence ordering. Walk ghost locations to reach their followers even when their former cells now belong elsewhere. Render a cell only at its effective run/occurrence, and a flow only at its effective containment edge.

Transfers assign the selected cells in the authored range order. Overlapping transfers use the later effective assignment; untouched cells retain their owner. Cross-tape ranges retain each tape and native identity. Repeated transfers and same-flow reorder use the same rule. Resolve source and destination in the pre-effect state so moving a range does not shift its own target during interpretation.

A completely emptied source must retain a distinct permanent insertion cell, as required by §6.4. Use the authored boundary/side and retained skeleton; do not redirect the source slot to transferred text. Tests must demonstrate typing into that source and into both sides of a transfer seam. If an authored transfer lacks the distinct boundaries needed to satisfy that invariant, report the concrete encoding gap rather than inventing local markers or hiding it behind an empty string. MW-09 will allocate required endpoints before publication.

Deletion does not participate in ownership or cycle decisions. A transfer into a deleted destination remains there internally. Visibility can hide it; ownership must not restore it to its source.

### Split component selection

For retain-left splits, implement master §6.5 literally:

1. Resolve the captured basis and cut by permanent range and occurrence identities, including empty cells and converged native markers.
2. Locate the cell immediately before the cut, or the first basis cell at a start cut.
3. Resolve that cell's current top-level flow through its effective run and MW-03 flow ancestry.
4. Walk right from the cut in the captured basis. Select the maximal component still in that top-level flow and contiguous in the current raw inline traversal. Stop at the basis end, ownership discontinuity, or layout discontinuity.
5. Assign only that component to the new run/occurrence.

Contiguity comes from the current coupled layout, not tape offset adjacency or equality of the final visible block. Hidden cells still participate. A basis can span tapes and nested joined flows. A concurrent cut can therefore shorten an earlier authored suffix without making its effect malformed.

Preserve the specified retain-original-on-right start split: the original node and text retain the right side, and the new left sibling has its own empty insertion location. Cover end cuts and empty input as well. Additional retained-side behavior must follow the master contract and receive an explicit regression; do not use an untested generic tail assignment for those cases.

### Split cohorts

Group split birth placements only when their captured ordered basis and authored outer sibling gap are equal by logical identity. Basis identity includes range endpoints and occurrences, but excludes visible text. Gap identity includes the parent and predecessor occurrence. Use no persistent cohort ID.

Rank each cohort as one `OccurrenceBucket` against ordinary followers by its earliest ready birth action, as MW-03 already supports. Inside the bucket, rank cut markers by converged position in that basis, including native ordering between distinct markers at one visible gap. Preserve anchored follower subtrees. Never mix marker and timestamp comparisons in a conditional pairwise comparator.

Only effective birth placements participate in the displayed cohort. A later effective explicit move leaves the cohort; retain its old occurrence as an anchor. An ineffective move does not replace a birth placement. Inactive split births remain retained for addressing and possible scaffolding; activity does not delete their occurrences. Include tests for retraction/reactivation and moves so bucket eligibility and anchor retention are independently observable.

Cuts with different bases or outer gaps use their authored slots and ordinary ordering. Concurrently moving the original block does not move its split-created sibling.

### Results and downstream boundaries

Expose a narrow `index.ts` with a reference reduction entry point and read-only result queries for:

- Complete cell assignments, run skeletons, effective flow/block ancestry, and derived cohort buckets.
- Ordered raw inline cells and exact native text fragments, including empty cell locations and retained ghost slots.
- Permanent-range membership and token-to-cell-to-run-to-inline-owner lookup.
- Effective ownership/layout intentions that require destination nodes, with original action/effect references.

Keep this raw output independent of visibility and Markdown normalization. It enables MW-06 and an MW-08 adapter to construct `VisibilityLayout`; it does not itself certify `containsBirthContent()`. That query must use a node's birth action causal view and retain its intervals through later transfers. Do not implement it as current ownership, whole-tape membership, or equality with a historical source node. Document this obligation at the adapter boundary and exercise the relevant visibility tests with actual ownership queries during integration.

Do not move shared contracts or export internal mutable maps. Add the ownership entry to `knip.json` for downstream production consumers. Keep input snapshots, envelopes, allocations, and skeletons unchanged.

## Non-goals

- Action codec/readiness, native body validation, network transport, or persistence.
- New deletion/history policy, history navigation, or native `Y.UndoManager` use.
- Markdown normalization, interpretation selection, parser lowering, browser focus, IME, or renderer cutover.
- A full MW-08 replica factory, full end-to-end corpus certification, or a claim that this reducer proves the combined algorithm.
- Incremental replay optimization, canonical pruning, offline expiration, new genesis, or an authority fallback.

## Verification

Use installed Yjs 13.6.33 through `NativeTapeCache`, with independently allocated caches opened from identical genesis bytes. Authors create native cuts/insertions in their own causal views. Exchange exact published bodies and compare fresh reductions of equal ready sets. Sorting one already-shared synthetic tape order is not a substitute for these controls.

Import actual corpus inputs and compare only implemented ownership/layout facets with the frozen expectations. Expected observations must never supply reducer output. Cover `cuts-earlier-first`, `cuts-later-first`, `same-gap-empty-cut`, `split-at-zero-retains-original-right`, `cross-tape-join`, `split-inside-cross-tape-join`, `opposing-joins`, `move-overrides-join`, `overlapping-transfers`, `ghost-destination-slot`, both `split-sibling-keeps-authored-outer-context` traces, `undo-split-after-peer-insert`, and `undo-cross-tape-join`. Deletion traces must retain the same ownership regardless of visibility filtering; MW-05/MW-08 own the complete visible result.

Add focused cases beyond the corpus:

1. Both semantic cut orders and both native-client tie orders, distinct markers at one gap, start/end/empty cuts, concurrent text at each seam, and inactive-marker refinement.
2. Split after cross-tape join, join versus split in both orders, transfers into nested joined flows, and a basis whose current component stops at a layout or ownership discontinuity.
3. Repeated and overlapping transfers across tapes, same-flow reorder, emptied source typing, ghost destination typing, left/right seam affinity, and action-local native text.
4. Cohorts mixed with ordinary siblings, anchored followers, different bases/gaps, a moved split sibling, ineffective moves, and retraction/reactivation at original priority. Check that the comparator remains total by testing the resulting traversal, including three-way cases.
5. Late earlier effects and changed activity followed by full replay; surviving peer insertions return through the same identities after split retraction.
6. Unicode fragments, equivalent decoded IDs, unchanged input objects, unknown endpoints, conflicting home bindings, and failed replay with no published partial output.

At every replay prefix, assert total non-overlapping cell coverage, one effective owner per cell, immutable run parent/skeleton, acyclic flow ancestry, and addressable empty/ghost slots. In raw traversal, assert each text identity appears once and each owned cell location is visited once. Compare assignments, ancestry, skeletons, attachment order, and empty locations separately from concatenated strings. Record native marker identities and manifests to prove structural replay allocated no new text or slots.

Use generated small tape/range/attachment combinations and permuted complete-body delivery with fresh reconstruction. Preserve failing seeds as ordinary regressions. These tests establish the ownership layer; real action-store readiness, projection, normalized Markdown, directional isolation, and full history composition remain MW-08/MW-16 gates.

Implementation checks: `npm run build`, `npm run test -- src/markdown/multiwriter/`, `npm run lint`, `npm run check:boundaries`, both `analyze:unused` scripts, and `npm run format:check`. Run the full Node suite if shared fixtures/types change. No browser run is needed while the issue stays within its headless scope.

Proposal preparation checks source paths, fixture names, the dependency modules, and agreement with the authoritative contract. It does not establish runtime correctness.

## Suggested implementation shape

1. Implement `cells.ts` for native partition/range lookup and home/refinement invariants, with real native-cache tests.
2. Implement `traversal.ts` for skeleton/attachment order, ghost slots, and exact fragment visitation.
3. Implement `ownership.ts` for coupled prefix replay, transfers, and split components using `LayoutPrefix`.
4. Implement `cohorts.ts` for basis/gap grouping and native cut ranking through `OccurrenceBucket`.
5. Add `index.ts`, focused corpus-facet comparisons, generated checks, and consumer documentation. Keep production optimization out of the reference path.
6. Open an implementation PR against `yjs`, attach it to grain/85, and request review with actual checks and remaining composition limits.

## Success criteria

- Every ready native cell, including empty and hidden cells, has exactly one effective run/occurrence assignment.
- Different-position cuts yield `ab | c | def` in both semantic orders; same-gap cuts retain distinct empty locations.
- Joins, repeated/cross-tape transfers, and split retraction preserve exact native identities and ghost addresses.
- Split selection uses the coupled action prefix, and cohorts display in native cut order without moving authored outer contexts.
- Equal validated ready sets and activity yield equal raw ownership/layout after independent native reconstruction.
- No shared writes, new wire contract, browser change, canonical pruning, or combined-algorithm claim is introduced.
