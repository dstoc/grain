# Proposal: MW-03 placement, slots, and flow layout

**Issue:** grain/84.  
**Status:** Proposed implementation plan; runtime work has not started.  
**Source contract:** [MW-00 proposal, version 1](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/81), especially §§4–6, 7.4, 8.2, and 14.  
**Inspected branch:** `yjs` at `676d0314e259caa199605f5bfe3a9029c0941c54`, which includes the required `1d76dddbd8620c5dc92b02ccb1c45e67af7ddc46` baseline and MW-00.  
**Implementation branch:** `feat/84-mw03-layout`; eventual implementation PR targets `yjs`.

## Motivation

P and Q are independent inline blocks. A joins Q into P while B, without receiving A, joins P into Q. Both intentions are valid in their authors' views. Once both actions are ready, every replica must choose the same acyclic containment graph. Neither join deletes a source node or copies its text. The losing attachment and both source slots remain addressable.

MW-03 supplies that placement foundation. MW-04 will use it while assigning native cells to runs. MW-06 will project its raw blocks and flows into legal Markdown. These consumers need the same cycle rule and permanent slots rather than separate block and text conflict algorithms.

## Problem statement

`src/markdown/multiwriter/contracts.ts` freezes `RawRole`, `BlockSlot`, `InlineSlot`, `RunLayout`, `FlowPlacement`, resource IDs, semantic effects, and `compareEffects()`. It does not implement placement reduction or occurrence traversal.

`test/multiwriter/corpus.ts` contains expected opposing joins, move-versus-join, deletion-versus-cycle, ghost destinations, and split-versus-move outcomes. `src/markdown/multiwriter/corpus.test.ts` audits those traces and contains a restricted occurrence-order model. It does not run a layout engine. `native-order.test.ts` calibrates one native ordering assumption only.

The existing `canonical/validation.ts` validates schema-2 stored child lists. It depends on Yjs and mutable semantic kinds. It cannot become this kernel: schema 3 separates immutable raw roles from presentation, retains obsolete placements, and interprets complete actions without an authority. Likewise, `semantic/types.ts:isAllowedSemanticChild()` describes legal Markdown children, not raw inline nodes with retained children.

No existing proposal directory or proposal document was found on this branch. This document follows the attached proposal skill's structure and the repository's direct technical documentation style.

## Proposal

Implement a headless reference layout module in `src/markdown/multiwriter/layout/`. Reuse the frozen logical contracts unchanged. Add no dependency and keep Yjs pinned to 13.6.33.

The reference reducer accepts one validated, dependency-closed action set, common genesis allocations, and the active-effect decision from the visibility/history layer. It returns derived placement and addressing data. It does not determine readiness, decode bytes, resolve group controls, or infer activity from array arrival order.

### One cycle-safe primitive

Implement one generic forest edge replacement primitive, instantiated for blocks and inline layout. A request carries a child, typed parent, and placement metadata. Before replacement, check domain rules and walk the proposed parent's current ancestry. Self-parenting and ancestry cycles leave the previous edge unchanged. A failed attempt remains in the retained input facts and can have a different result on replay.

The reference driver sorts effects with `compareEffects()` and starts from creation fallbacks on every reduction. New allocations enter at their birth prefix; allocation facts and their fallback placements remain after effect retraction. Replaying a late earlier effect or changed activity recomputes later safety decisions. It must never reuse a previous cycle verdict.

Use full reference replay first. MW-13 owns incremental suffix replay and performance budgets. The prefix step operation must also be usable by MW-04, which has to interleave flow placement with splits and transfers rather than compute all final joins first.

The primitive's result distinguishes applied placement, ineffective cycle, and ineffective role constraint. Invalid internal input, such as a missing referenced allocation, is a contract error with no published partial result. It is not an invented fallback to root. MW-01/MW-15 still own ingest quarantine and diagnostics.

### Immutable block roles

The fixed document root has no parent and cannot move. Every other node has one effective occurrence and raw parent. Use this role table independently of mutable presentation:

| Parent raw role | Allowed child raw roles |
| --- | --- |
| `root`, `quote`, `list-item`, `inline` | `inline`, `list`, `quote` |
| `list` | `list-item` |

A paragraph or code presentation can therefore retain raw children on an `inline` node. MW-06 lifts those children in the legal view. Layout does not mutate roles, normalize wrappers, or delete children when presentation changes.

A move updates the effective occurrence only if its raw edge is legal and cycle-safe. A later ineffective move leaves the last valid occurrence in place. Genesis sibling order uses the MW-00 predecessor chain, not map iteration or resource ordinal sorting.

### Permanent occurrence order

Keep an occurrence registry separate from effective placement. Each occurrence retains its exact authored slot and birth/effect order. A parent sequence is a predecessor forest: visit a predecessor, then its follower subtrees. Concurrent followers use descending `compareEffects()` order. A moved node renders only at its effective occurrence, but traversal still visits its old occurrence to reach anchored followers.

Genesis occurrences form a predecessor chain per parent. Action occurrences follow genesis siblings at the same predecessor according to their later semantic order. An occurrence from an inactive or ineffective intention remains an anchor; inactivity changes rendering eligibility, not its identity or predecessor.

Reject inconsistent references at the validation boundary: a predecessor must exist in the same slot sequence and be causally available to its author. Do not repair a missing predecessor by attaching the occurrence at the beginning. An inactive predecessor is still available.

Expose both complete occurrence order and the filtered effective order. Tests must distinguish them. In the frozen split-versus-move fixture, P's old root occurrence anchors S before U, yielding preorder `S, U, P` after P moves inside U.

MW-04 owns split cohorts and native cut ranking. Keep the ordinary sequence traversal usable with a derived bucket at a sibling gap. Do not invent cohort resource IDs or encode a marker-versus-timestamp conditional comparator in MW-03. The ordinary block ordering tests can install the allocated split sibling at its authored outer slot without claiming to implement split ownership.

### Flow and run containment

Instantiate the same primitive over a typed inline forest:

- Each run has its immutable containing flow and retained ordered range skeleton.
- Each flow starts at its own inline block terminal.
- A joined flow attaches to the run named by its destination slot.
- The containing flow of that run supplies the next ancestry step.

Following flow-to-run and run-to-flow edges catches indirect cycles, including joins through transferred runs. Block terminals end inline ancestry; they are not interchangeable with flow or run IDs. Runs cannot become children of arbitrary runs, and standalone flows cannot attach to another block's terminal.

A `JoinFlow` placement changes only containment. The source block's raw parent, home run, tape lineage, and slots survive. Return whether the flow is standalone or nested; MW-06 uses that state to suppress an absorbed header. Never supply a deletion tag as an input to cycle checking.

A `MoveBlock` of an inline node also asserts its own flow's standalone placement at the same semantic prefix. Treat the block-edge request and standalone-flow request as constituent intentions, each checked in its typed domain. This follows the master proposal's rule that atomic action visibility does not imply every intention wins. In particular, this plan proposes that an ineffective cyclic block move can still assert a legal standalone flow. Include this combined case explicitly in review and tests; the current corpus does not settle it. The alternative is to gate the standalone assertion on a successful block move. That would couple intention success across domains and requires an explicit contract decision before implementation.

For the existing `move-overrides-join` fixture both requests succeed: Q returns to its block and renders once. In opposing joins, the earlier safe attachment remains and the later cyclic attachment is ineffective.

### Ghost slot lookup

Resolve `BlockSlot` and `InlineSlot` by persistent identity. Inline lookup returns the original run, boundary, side, predecessor, and retained skeleton context. It must not redirect a slot to wherever its former text now resides. An empty or obsolete run stays addressable.

The MW-02 native index establishes marker membership and order. MW-03 needs no text offsets and must not pretend that lexical marker-ID order is native order. Missing validated marker information is an explicit unavailable input; it cannot silently become a different slot. MW-04 uses these origins plus its cell index to resolve structural intervals and empty insertion locations.

Slot lookup and traversal are pure reads. They allocate no shared resources, write no native content, and do not manufacture a replacement caret node.

### Module and consumer boundaries

Suggested implementation files:

| File under `src/markdown/multiwriter/layout/` | Responsibility |
| --- | --- |
| `forest.ts` | Shared typed edge replacement and ancestry checks |
| `occurrences.ts` | Permanent predecessor traversal and effective filtering |
| `layout.ts` | Block and inline domain policies, prefix steps, full reference replay, slot lookup |
| `index.ts` | Narrow exports for MW-04, MW-06, and MW-08 |
| `*.test.ts` | Kernel, ordering, roles, and ghost-address regressions |

Use structured `ResourceId` equality through canonical logical keys internally. Equivalent decoded ID objects must address the same resource; object reference equality is insufficient. Internal keys do not become a second wire format. Use effect order from `contracts.ts`; do not create another actor comparator.

The first callers are tests and then MW-04's ownership reducer. No existing editor, parser, serializer, or renderer switches to schema 3 in this issue. Add the layout entry to `knip.json` so production analysis recognizes its intended downstream use.

## Non-goals

- Cell refinement, split component selection, transfer ownership, or split-cohort ranking: MW-04.
- Deletion coverage, activity/control resolution, weak birth suppression, or local history: MW-05/MW-10.
- Interpretation packets, Markdown normalization, view nodes, and browser caret addresses: MW-06/MW-14.
- Action storage, codec, readiness, transport, checkpoints, or native body validation.
- Incremental replay optimization, canonical pruning, offline expiration, or an authority fallback.

## Verification

### Published move-kernel comparison

Use [Kleppmann et al., Figures 1, 2, and 4 and §3.5](https://martin.kleppmann.com/papers/move-op.pdf) as the external baseline. Compare the generic primitive against a test-only, independently written Figure-4 replay implementation. Cover same-child competing destinations, opposing moves, and both late safe-to-unsafe and unsafe-to-safe reclassification. Enumerate delivery permutations and preserve ignored moves. This comparison covers placement only; Grain's role, slot, flow, deletion, and history extensions require their own tests.

### Grain-specific checks

1. At every reduction prefix, assert unique parentage, root stability, immutable roles, acyclicity, one effective occurrence per placed child, and retained fallback availability.
2. Check every allowed and disallowed role pair, independent of paragraph/section/code presentation. Test self moves, longer cycles, and same-parent reordering.
3. Compare three separately allocated reducer instances after permuted/duplicate input delivery and fresh replay. Use equal ready sets for equality checks; do not share maps or caches. This is a layout test, not the independent native replica gate.
4. Check late earlier moves in both safety directions and active/inactive/reactivated moves at their original priority. Supply explicit activity inputs rather than implementing fake history navigation.
5. Check the relevant facets from `opposing-joins`, `move-overrides-join`, `delete-does-not-make-raw-cycle-safe`, `redo-old-move-keeps-old-priority`, and both `split-sibling-keeps-authored-outer-context` traces. Import the actual corpus expectations. Do not replace whole traces with adapters that return expected state.
6. Check opposing joins through both home and non-home runs, later standalone moves, and cyclic block moves paired with standalone assertions under the reviewed rule.
7. Retain ghost block occurrences and inline slots after moves, ineffective placement, inactivity, and an empty run skeleton. MW-04/MW-08 must additionally execute the complete `ghost-destination-slot` transfer trace against native cells.
8. Verify equivalent decoded resource IDs resolve identically. Check that input arrays, allocations, skeletons, and occurrences are unchanged by replay and lookup.
9. Verify concurrent follower order, nested followers, ghost predecessors, and genesis chains. Include a wide chain to ensure traversal does not depend on recursive call-stack capacity.

After implementation, run `npm run build`, focused `npm run test -- src/markdown/multiwriter/`, `npm run lint`, `npm run check:boundaries`, both Knip scripts, and `npm run format:check`. Run the remaining node suite if shared types or fixtures change. Browser tests become relevant if scope expands into editing or rendering; that expansion is not proposed here.

For this proposal-only change, validate document links, source paths, fixture names, and consistency with the master proposal. No runtime test pass or convergence result is claimed.

## Suggested implementation shape

1. Review the module boundary, immutable role table, and combined ineffective-block/standalone-flow rule.
2. Implement the shared primitive and external placement comparison first.
3. Add permanent occurrence order and raw block policies.
4. Add flow/run policies and persistent slot lookup using the same primitive.
5. Add corpus facet comparisons and generated prefix/replay checks, then expose the narrow module to downstream workstreams.
6. Open an implementation PR against `yjs`, attach it to grain/84, and request implementation review. Do not merge browser cutover before MW-08.

## Success criteria

- One primitive handles both block and inline cycle checks.
- Equal validated active-effect sets produce equal reference layout, independent of arrival order.
- Ineffective intentions and obsolete locations retain their IDs and addressability.
- Raw roles and raw edges survive presentation changes and deletion filtering.
- Opposing joins, late safety changes, ghost followers, and the reviewed combined-move rule have executable regressions.
- MW-04 can interleave layout prefix steps with ownership operations without a second placement algorithm.
- Results explicitly distinguish layout coverage from the outstanding native MW-08 composition gate.
