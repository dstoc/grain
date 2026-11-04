# Proposal: MW-04 ownership and split/join/transfer algebra

- **Issue:** grain/85.
- **Status:** Proposed v4 (artifact revision 5). Design investigation authorized by Douglas on 2026-11-04 in `cmt_hmtql0ZqsQreEHgn`. Revised after review `cmt_QpUrZpeIMJTZSfRO` to define empty-basis ordering. Requires normal Proposal Review before implementation resumes. Draft PR #81 remains incomplete.
- **Authority:** [MW-00 proposal, version 1](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/81), especially §§5–7, 12–14. The private-home convention below proposes explicit amendments to §§6.2–6.5 and the authoring/validation obligations in §§4 and 9. Other schema-3 contracts remain authoritative. Approval must include these amendments; investigation authorization is not implementation approval.
- **Inspected baseline:** draft PR #81 at `8e56d1dc86cf5721a2af5275ce58802b3d50b5c5`, continuing the prior `yjs` baseline `046410d155fcb9d93414696113a23a7bf4151472`. The implementation branch is `feat/85-ownership-algebra`, based on `origin/yjs`. PRs target `yjs`.
- **Dependency:** MW-02 native tapes and MW-03 layout. Both modules exist in the inspected tree. Yjs remains pinned to 13.6.33.

## Motivation

Two disconnected authors split `abcdef`: A cuts after `ab`, and B cuts after `abc`. After exchange, both cuts must survive as `ab | c | def`, regardless of which action sorts first. Assigning each whole suffix to the latest run loses one cut. Sorting the resulting siblings by ordinary action priority can instead display `ab | def | c`.

MW-04 implements the component-selection rule and split-cohort ordering already specified by the master proposal. It also supplies exclusive cell ownership through joins, transfers, retraction, and native marker refinement. The first consumers are headless ownership tests, followed by MW-06 projection and MW-08 composition.

## Problem statement

`src/markdown/multiwriter/contracts.ts` defines `CellAssignment`, `RunLayout`, `FlowBasis`, `RangeRef`, `InlineSlot`, and the structural effects. The draft `multiwriter/ownership/` implementation now includes `cells.ts`, `traversal.ts`, `ownership.ts`, and `cohorts.ts`. It fails closed when a transfer removes every cell of a source flow. The generated positive regression at seed `34064` reproduces this gap.

`text/cache.ts:NativeTapeCache` supplies `snapshot()`, `marker()`, `range()`, and `lookup()` over real insertion-only native tapes. Snapshots include permanent embeds, text identities, and converged native order. This module deliberately does not assign ownership.

`layout/layout.ts:LayoutPrefix` supplies retained allocations, run skeletons, flow ancestry, cycle-safe joins and moves, and one step per semantic effect. `beginAction()` installs births even when effects are inactive. `step()` handles joins and moves; it leaves split/transfer ownership to this workstream. Its `occurrenceOrder()` and `children()` accept derived `OccurrenceBucket`s from MW-04. Transferred runs already have immutable flow parents through their allocations.

`visibility/visibility.ts:VisibilityLayout` requires final token ownership and permanent-range membership. It separately requires causal birth-content coverage and effective destination requirements. Current visibility tests inject that interface; ownership must not mistake final owner queries for causal birth coverage.

`test/multiwriter/corpus.ts` freezes split, transfer, join, deletion, and undo outcomes. Existing layout tests explicitly cover layout facets without native ownership. `test/multiwriter/network.ts` expects a future integrated replica factory. Neither test suite is an ownership implementation or evidence that the combined algorithm works.

## Proposal

### Review decision: retain authored skeletons

Keep one meaning for `skeleton`: the ordered permanent ranges retained in the run allocation. `RunLayout.skeleton`, `LayoutPrefix.runLayout()`, and the ownership result expose those same ranges. Refinement can subdivide a range into cells, but cannot replace its endpoints with those of the currently selected component. This follows master §5.1: a skeleton remains addressable after its cells move elsewhere.

An effective assignment is a separate observation. `CellAssignment` identifies the current run and occurrence of each refined cell. Raw traversal walks retained skeletons and attachments, but emits a cell's text only at its effective assignment. A split's selected component is a transient pre-effect decision used to change those assignments. It is not another retained skeleton or a new shared resource.

In the existing encoding, for independently authored cuts in `abcdef`, L's allocated skeleton is `[cut-after-b, tape-end]` and R's is `[cut-after-c, tape-end]`. The original P skeleton is `[tape-start, tape-end]`. Under the proposed encoding, content captures end at an interior content boundary and each run also retains its own full home-tape range. The authored `cdef`/`def` content coverage remains unchanged. Both authors capture the full suffix available in their own views. After exchange, native refinement preserves L's permanent range containing `cdef`. In either semantic order, effective ownership is P=`ab`, L=`c`, R=`def`. In the later-cut-first order, L selects only `c`; that selection does not rewrite L's allocated skeleton to end at R's cut.

This distinction also preserves ghost addresses. A slot authored at L's retained tape-end boundary still names L's run, boundary, side, and predecessor after `def` belongs to R. Looking up that slot must not redirect it to R or reject it because L currently emits only `c`. Followers attached there remain reachable through L's skeleton. Any new text follows its permanent cell assignment; a retained slot alone does not reassign R's cells to L. A source that needs an independently editable empty location must still satisfy the distinct-boundary rule below.

#### Approved frozen-corpus correction

`test/multiwriter/trace.ts:Observation.skeletons` will mean retained authored skeleton coverage, expressed through the fixture's stable cell aliases. An adapter resolves the actual allocated ranges against the native partition; it must not reconstruct skeletons from `cellRuns`, visible text, or expected observations. Empty-cell and marker identities need separate assertions because the alias coverage does not encode all native boundaries.

The draft already removes the `cutStateReverse` override in `test/multiwriter/corpus.ts` and passes `cutState` to `cuts-later-first`, just as `cuts-earlier-first` does. The sole changed expected facet is reverse-order `rL` skeleton coverage: `['P2']` becomes `['P2', 'P3', 'P4', 'P5']`. Keep every ownership, visible identity, block order, and Markdown expectation unchanged. Add the authored meaning to `Observation.skeletons` and the corpus documentation. Preserve the full skeleton assertion in both fixtures.

Douglas approved this exact correction in `cmt_NLXyIJoporotf3qZ` on grain/85. That decision is complete. Do not broaden it or seek the same approval again. Keep its positive ownership, traversal, retraction, follower, and reconstruction regressions. Additional home-tape identities and cells require their own assertions; they do not replace the frozen content facets.

Continue the headless reference reducer under `src/markdown/multiwriter/ownership/` after review. Add no dependency, authority, native deletion, or browser integration. The allocation vocabulary and CBOR field shapes stay unchanged, but the authoring and validation convention changes. This is a shared semantic contract change, not a wire-neutral implementation detail.

### Empty-source witness and proposed resolution

Three authors open the same genesis `abcdef`. In semantic order A1 < B1 < C1, A1 splits after `d` into R, B1 independently splits after `b` into L, and C1 independently transfers `bcdef` to Q. The splits first give P=`ab`, L=`cd`, R=`ef`. C1 covers every effective L cell. L's authored `cdef` skeleton remains, but its start types into the transfer and its end types into R. Markers inserted inside C1's range remain covered by that expanding range.

The previous `empty-source-gap` artifact demonstrates native order and this interval geometry with hand-assigned owners. It is not a reducer proof. The draft's separate seed `34064` is a real positive reducer failure. Preserve both witnesses. Do not reject an author-valid C1 only after discovering L during merge, weaken the regression, or allocate native data during replay.

**Recommendation:** give every flow an author-allocated private home tape in its root run, and keep a text-free cell next to each permanent home-tape sentinel outside all structural captures. This preserves content transfer and split-component selection. It adds a reserved insertion location and a precise distinction between reserved home cells and content cells. Review must approve that distinction.

### Home binding and allocation

At each flow birth, including genesis, allocate exactly one root run and one fresh private home tape. The root run belongs to that flow, uses its home node's birth occurrence, and retains the full home-tape range as the **last** element of its immutable ordered skeleton. A split's root run is `SplitFlow.newRun`: its earlier skeleton elements retain the authored source component ranges, followed by its own fresh home range. A plain new flow has only its home range. Initial imported text is bracketed inside its home tape.

Use existing `flow`, `run`, `tape`, `marker`, and `occurrence` allocations. Derive the binding by these checks:

1. The root run and flow have the same birth; the run is not an attachment run allocated by `TransferRange`.
2. Its last skeleton range uses a tape with that same birth and exactly that tape's start/end markers.
3. That tape occurs in exactly one such root binding. Other root skeleton ranges use source tapes available at that effect prefix, including a tape created earlier in the same atomic action; they do not establish a second home binding. A transfer run captures existing tapes and cannot designate another home.
4. Seed every refined cell of the fresh tape to that root run and its node's birth occurrence, including when the creating split is inactive.

The pairing is determined by typed IDs and skeleton position, not allocation array order, actor sorting, first overlap, text emptiness, or caller choice. Multiple flows in one action each need a distinct home tape and root binding. Existing `HomeBinding` input becomes a checked derived result; supplied bindings must equal the derived bindings. The current `install()` logic already permits one root run per flow, but must seed split-born tapes and validate this exact convention.

A transfer creates no flow, so it does not allocate another home. Its destination already has a home through its containing flow. A join moves the whole source flow with its own home. A block move restores that same flow; neither operation changes the home binding.

### Protected cells, capture endpoints, and typing

Call the first and last refined cells of each private home tape **reserved home cells**. With only start/end markers these are the same single cell. Their endpoints are distinct permanent marker IDs. The cells can refine over time; there is no permanent elementary-cell ID and no synthetic equal-endpoint span.

Require all of the following:

- Structural content ranges on a home tape have both endpoints strictly between its start/end sentinels. This applies to transfer ranges, split bases, and the captured source ranges in split/transfer skeletons. The owning root run's full home range is the sole full-range exception; it seeds ownership and traversal, not a structural capture.
- A reserved home cell contains no text and remains assigned to its owning root run. Ordinary interior empty cells continue to participate in splits and transfers exactly as before. Never subtract selected interior cells from a valid transfer or choose a winner by final visibility.
- When lowering an edit into a reserved home cell, the author allocates two interior markers and inserts the text between them in the same action. Bracket the entire string, including valid UTF-16 pairs. Reuse an ordinary content location when possible. Never type bare text into the cell next to a home sentinel.
- A full-content transfer captures interior endpoints around all selected content, including hidden cells inside the authored interval. It leaves the reserved edge cells. Future marker refinement and text inside that captured interval still follow the transfer; there is no exclusion of later text from an otherwise valid range.
- After full-content evacuation, the author types through the trailing reserved cell of that flow's own home tape. Fresh interior brackets make this new text lie outside earlier captures. The author records the exact run/boundary/side and new native identities. Remote replay never chooses a new numeric caret offset or invents brackets.

For the three-action witness, A1 allocates R's home and B1 allocates L's home in their independent actions. C1's range is on P's tape and cannot cover either private tape. L therefore retains its own empty home after its entire `cd` component moves. Once L later types on its home tape, a future transfer can move that new text using interior endpoints and still leave L an empty insertion cell.

A separate tape without the endpoint rule is insufficient: a later whole-tape capture would consume it too. The rule is author-closure validation, not a merge-time refusal of an otherwise valid effect. Validation must check the manifests' final order and text-free edge cells as well as structural endpoint membership. Native origin validation alone does not establish the convention.

**Conditional closure argument:** every admitted home-tape insertion occurs between two interior markers. Native integration retains all markers and their order. Every admitted capture has interior endpoints, so neither cell adjacent to a sentinel is selected. Refining a captured interior interval cannot reach a sentinel edge; refining an edge with bracketed text leaves a new empty edge. Splits and transfers therefore preserve a home cell without changing content assignments. This is a design argument with native controls, not proof that the current reducer, validator, or replica factory implements it. The merge invariant and full reference tests below are mandatory.

### Home order, bases, and split interactions

Raw traversal keeps the existing skeleton order: captured source ranges first, then the flow's home range. The home range retains all its ghost slots even after its interior content moves. Attachments at those slots use MW-03's predecessor order, including inactive predecessors. There is one effective assignment per home cell and no duplicated root run or synthetic attachment.

Reserved home cells are address locations, not split content. Omit them from authored content bases and from the adjacency test used for component selection. Preserve them in complete raw traversal and total-coverage checks. All other empty cells remain in the component walk. This is an explicit amendment to master §6.5's statement that empty cells participate: only the sentinel-adjacent, text-free home cells are exempt. Without the amendment, joining two flows would put a reserved cell between otherwise contiguous captured ranges and stop a split spuriously.

Compute content adjacency by filtering reserved cells out of the current raw cell sequence; do not filter text, hidden interior cells, transferred cells, or flow attachments. A foreign non-reserved cell between basis cells still breaks contiguity. Slot attachments are traversed normally; any content they emit participates in the sequence. A basis excludes the root's full home range and instead captures interior intervals. For nonempty captured content bases, equal bases and outer gaps still define cohorts; home identities do not enter that key. An authored empty basis instead uses its retained source home domain, as specified under Split cohorts. Two independent empty cuts of the same source home and outer gap remain one cohort.

Content ranges keep permanent endpoints and include later insertions inside them. Ordinary typing inside an existing captured interval does not alter its basis identity. New bracketed content in a previously reserved edge is outside that old interval and introduces a new address segment for later authoring. A historical split does not capture it merely because it has the same visible offset. This behavior must be tested and documented at the MW-09 address boundary.

At the start/end of nonempty content, keep the captured content address and its affinity. For an empty flow use its trailing home edge. A retain-original-on-right start split keeps original text/node identity on the right; the newly allocated left flow has its own empty home. End splits and empty splits also allocate homes before publication. For an empty content basis, the canonical trailing home slot supplies the authored cut: the source root run, its home end sentinel, side `left`, and predecessor `null`. The split selects no content and creates the new empty sibling. This slot is reused; an empty split does not need a fresh source cut marker. Do not infer its identity from visible string length during replay. Distinct same-gap births retain separate node, flow, run, occurrence, home, and future insertion-slot identities, even when they share this source cut.

An old ghost slot stays a ghost slot; it is not transparently redirected to a home. If that slot's old cell now belongs elsewhere, an insertion deliberately authored there follows its cell. Choosing the home for a new empty-flow edit is an authoring decision with a recorded address, not a rewrite of historical slots.

### Retraction, visibility, and independent replicas

Allocations and home markers survive retraction. Retracting a split restores its content component assignments at the original semantic priority but does not destroy either flow's home. Peer text authored into the new flow's private home stays in that flow's lineage; it does not migrate to the old source merely because the split is inactive. Peer text inserted into the captured source interval follows the restored assignment. Redo reuses all original IDs and reactivates the original split; it allocates nothing. An empty inactive split header may be suppressed by existing birth-derivation policy, but surviving independent peer content must not be hidden solely because the split is inactive.

Transfer retraction restores content by ordinary replay. Content typed later into the source home remains there. If both the transfer and that later typing are retracted, the permanent empty home still exists. Join retraction restores the source flow and its home together. Deletion masks and destination requirements remain separate: home cells do not make a deleted block immortal, resurrect transferred text, or prevent deletion-wins. `containsBirthContent()` must use the causal birth intervals, including any authored home text; the empty sentinel cells do not count as independent visible content.

Each replica derives identical bindings and reserved cells from equal validated facts, including retained inactive markers. Authors allocate tapes/markers only in their own actions. No replica waits for a structural authority, acknowledgment, owner lookup on another peer, or delivery-specific resource allocation. Missing prerequisite facts remain deferred. Invalid home conventions are quarantined before publication; semantic concurrency does not turn a valid interior range into an invalid one.

### Alternatives and compatibility

| Alternative                                                                                            | Consequence                                                                                                                          | Recommendation                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| More guard markers inside a captured source interval                                                   | The expanding transfer includes every later refinement there. It cannot protect the peer-created component.                          | Reject; the existing witness covers this.                                                                                                                            |
| Separate private tape with no capture constraint                                                       | Works for C1, fails when a later action captures the whole home tape.                                                                | Reject as incomplete.                                                                                                                                                |
| New insertion tape/run for every empty-flow typing action                                              | Can keep the reserved home permanently text-free, but needs attachment order, history, and authoring rules for every such insertion. | Viable alternative; larger allocation/attachment lifecycle than bracketed typing on one retained home tape. Review may choose it, then revise before implementation. |
| Explicit home-run field in flow allocations                                                            | Simplifies home discovery but changes contracts, codec, and retained envelope shape. It still needs capture protection.              | Fallback only if the birth/skeleton pairing above is ambiguous; return to review rather than add it silently.                                                        |
| Leave a selected content cell with the source, reject C1 after merge, or redirect source typing into Q | Changes transfer coverage, author-valid merge behavior, or independent empty-source editing.                                         | Reject under this issue's instructions.                                                                                                                              |
| Allocate markers while replaying                                                                       | Gives different replicas new canonical facts and violates insertion identity.                                                        | Reject.                                                                                                                                                              |

No CBOR field, resource kind, or Yjs version change is proposed. The private-home convention is nevertheless incompatible with old action sets that lack homes, capture tape sentinels, or encode empty bases with noncanonical source cuts. Do not label it an automatic schema-3 migration. Existing draft fixtures must be re-authored through the proposed convention while preserving the same semantic operations, seeds, text identities within each run, and frozen content expectations. Native endpoint IDs and added home-cell observations necessarily differ between the old and new authored encodings; compare identity preservation within an encoding, never fabricate equality across them.

Old canonical envelopes must remain retained and exportable. Before any persisted schema-3 rollout, MW-00/MW-01 must agree on a capability/version gate that prevents mixed-convention writers from authoring one document. This issue proposes no protocol-version bump or mixed-writer migration. If an existing persisted deployment requires mixed compatibility, stop before implementation/publication and obtain that design; do not silently repair old facts, force a new genesis, or expire offline writers. The current draft is not a released compatibility bridge.

### Decision requested in Proposal Review

Approve or reject the derived private-home binding, interior-capture and bracketed-typing convention, reserved-cell exception to split adjacency, empty-basis split rule and home-domain cohort key, canonical reusable empty cut, ascending equal-cut tie rule, cross-domain bucket ordering, and the retraction/peer-home-text behavior above. Confirm the cross-workstream obligations: MW-00 owns shared contract agreement; MW-01/MW-15 certify author closures; MW-09 lowers real commands; MW-06 maps new edit addresses; MW-08/MW-10 compose replicas/history. Approval of this proposal permits implementation of those named obligations, not a new field or migration invented later. Any encoding ambiguity or failed closure control returns to design review.

### Inputs and publication boundary

The reducer accepts common-genesis layout/allocation facts, validated home-ownership bindings, native snapshots from one complete ready closure, ordered action inputs compatible with `LayoutActionInput`, and effect activity supplied by the visibility/history layer. Home bindings identify the initial run and occurrence of each tape interval using the birth/skeleton convention above; do not infer a home by picking the first overlapping run skeleton. Split and transfer runs can overlap older skeletons without initially owning those cells.

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

A completely emptied source must retain a distinct permanent insertion cell, as required by §6.4. Use the private home and captured boundary/side rules above; do not redirect historical source slots to transferred text. Tests must demonstrate typing into that source and into both sides of a transfer seam. If an authored transfer lacks the distinct boundaries needed to satisfy that invariant, report the concrete encoding gap rather than inventing local markers or hiding it behind an empty string. MW-09 will allocate required endpoints before publication.

Deletion does not participate in ownership or cycle decisions. A transfer into a deleted destination remains there internally. Visibility can hide it; ownership must not restore it to its source.

### Split component selection

For retain-left splits, implement master §6.5 over content cells, with only the reserved-home-cell exception specified above:

1. Resolve the captured basis and cut by permanent range and occurrence identities, including empty cells and converged native markers.
2. Locate the cell immediately before the cut, or the first basis cell at a start cut.
3. Resolve that cell's current top-level flow through its effective run and MW-03 flow ancestry.
4. Walk right from the cut in the captured basis. Select the maximal component still in that top-level flow and contiguous in the current content-cell traversal. Stop at the basis end, ownership discontinuity, or layout discontinuity.
5. Assign only that component to the new run/occurrence.

Content contiguity comes from the current coupled layout with reserved home cells omitted, not tape offset adjacency or equality of the final visible block. Hidden cells still participate. A basis can span tapes and nested joined flows. An earlier semantic cut can therefore restrict a later split to a component of its authored suffix without making the later effect malformed. This restricts the assignment, not the retained range skeleton.

Preserve the specified retain-original-on-right start split: the original node and text retain the right side, and the new left sibling has its own empty insertion location. Cover end cuts and empty input as well. Additional retained-side behavior must follow the master contract and receive an explicit regression; do not use an untested generic tail assignment for those cases.

### Split cohorts

Use two disjoint cohort-key forms. Both use the authored outer gap `(parent, predecessor occurrence)` and logical resource equality. Neither uses visible text or a persistent cohort ID.

| Authored basis             | Cohort key                                                 | Native ordering domain                                    |
| -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| One or more content ranges | `content`, ordered `(range, occurrence)` pairs, outer gap  | The captured ordered ranges, refined by all ready markers |
| No content ranges (`[]`)   | `empty-home`, source root-run ID from `cut.run`, outer gap | That root run's retained full private home range          |

The `empty-home` source is determined at authoring, not by the eventual owner of visible text. Derive its tape and sentinel endpoints from the proposed root-run/home binding. Do not group different empty home runs merely because their outer gaps match. Do not add home identity to nonempty-basis keys. In particular, a nonempty authored basis that later loses all its text or assignments remains a `content` cohort. It never changes key or switches to its home during replay.

For an authored empty basis, MW-01/MW-15 must certify in the author's dependency closure and effect prefix that:

1. The selected source is a standalone top-level flow with no content cells after reserved cells are omitted. Joined content and ordinary empty interior cells count as content cells. A visually empty string alone does not establish an empty basis.
2. `cut.run` is that source's bound root run, not a captured source run or transfer attachment. Its last skeleton range is its retained private home range.
3. The cut is the canonical trailing slot `(root run, home end sentinel, left, null)`. This applies to both start/retain-right and end/retain-left splits of empty content. The authored outer slot distinguishes before-source from after-source placement. Empty content has no distinct text offsets to reinterpret.
4. The new root run retains its own fresh home range and captures no source content. No fresh marker on the source is required. The source cut slot can be shared by concurrent and repeated actions; the new homes and their insertion slots cannot be shared.

These are explicit authoring/validation amendments. An empty split may reuse the sentinels in the ordering domain; the interior-endpoint restriction applies to content captures, and this address domain is not a capture. It assigns no source cells. Unavailable prerequisite bindings defer until those facts arrive. A complete author closure with a missing or invalid required binding fails certification. Later peer text, joins, or retractions do not invalidate a certified empty split or make it capture that text.

Rank cuts within a `content` cohort by their converged position in the captured basis. Rank cuts within an `empty-home` cohort by their position in the same retained home range. The canonical empty cuts all name the same end sentinel, so their native positions are equal. Resolve an equal position by **ascending `compareEffects()`** (Lamport, actor bytes, action sequence, effect ordinal). This agrees with the draft helper's existing equal-position fallback. It is now an explicit contract for review. It does not compare native client IDs or allocate distinct source markers to manufacture an order. Different new homes are not different positions in the source tape.

Each cohort is one `OccurrenceBucket`. Its earliest eligible ready birth ranks the bucket against ordinary followers and other cohorts at that gap. MW-03 orders these units by descending semantic effect order and preserves each member's anchored follower subtree. A singleton uses ordinary ordering, which has the same unit rank. There is no native marker comparison between different home domains, nor a conditional pairwise comparator mixing marker and semantic order. This preserves a total order without defining a global order of unrelated tapes.

The different-domain rule intentionally uses existing conflict ordering. It does not promise that a start-created empty sibling remains immediately adjacent to its source after concurrent births at that gap. For the review's exact two-generation trace, with A before B at equal Lamport time:

| Birth                   | Captured content basis | Source domain    | Authored outer predecessor | Resulting cohort                 |
| ----------------------- | ---------------------- | ---------------- | -------------------------- | -------------------------------- |
| A1 creates SA after P   | `[]`                   | P root run/home  | P birth                    | A1, B1 in ascending effect order |
| B1 creates SB after P   | `[]`                   | P root run/home  | P birth                    | A1, B1 in ascending effect order |
| A2 creates TA before SA | `[]`                   | SA root run/home | P birth                    | A2 singleton                     |
| B2 creates TB before SB | `[]`                   | SB root run/home | P birth                    | B2 singleton                     |

All active raw block order is **P, TB, TA, SA, SB**: the later B2 and A2 singleton units precede the A1/B1 bucket; inside that bucket A1 precedes B1. If B precedes A semantically, raw order is **P, TA, TB, SB, SA**. Reversing native-client order or body delivery changes neither result. Each author's isolated two-action prefix remains P, TA, SA or P, TB, SB. TA and TB are distinct even though neither has visible text. This is an explicit conflict outcome for approval, not an adjacency guarantee or a visibility result.

Only active splits whose effective block placement is their birth occurrence enter displayed cohorts, as in the draft reducer's active-split collection. Inactive split allocations and their raw birth occurrences remain retained as ordinary anchors; visibility separately decides whether to show an empty inactive header or surviving peer content. For the A-before-B example, retracting A1 removes it from the two-member bucket, so complete retained raw order is P, TB, TA, SB, SA. A2 still addresses SA's retained home. Reactivating A1 restores P, TB, TA, SA, SB using the same facts and original priority. This raw-order distinction does not prescribe history-group navigation or hidden-header policy.

A later effective explicit move leaves a cohort; retain the old occurrence as an anchor. An ineffective move does not replace a birth placement. Cuts with different bases, home domains, or outer gaps retain their authored slots and ordinary unit ordering. Concurrently moving the original block does not move its split-created sibling. Test follower retention, activity, and effective placement separately.

#### Alternatives for empty-basis ordering

- Keep only `[]` plus gap: rejected because cuts on SA and SB have no common native ordering domain.
- Add fresh source cut markers to every empty split: does not identify a common tape across different sources. It also adds source allocations and interior empty cells. It still needs a source-domain key, so it is unnecessary for this empty case.
- Capture the full home range as a content basis: conflicts with protecting sentinel-adjacent cells and conflates address geometry with transferable content. The proposed local address domain reuses the range without assigning it.
- Use a new wire cohort/source field: unnecessary while the root run and its home are uniquely derivable. If that derivation fails, stop and return to review.
- Use descending equal-cut order: agrees with ordinary same-gap follower ordering, but changes the draft's existing ascending tie fallback. Recommend ascending order within cohorts and the already specified descending unit order between cohorts. The binary choice and the complete trace above require review approval.

### Results and downstream boundaries

Expose a narrow `index.ts` with a reference reduction entry point and read-only result queries for:

- Complete cell assignments, retained authored run skeletons (unchanged allocation ranges), effective flow/block ancestry, and derived cohort buckets. Do not expose selected-component membership as a run skeleton.
- Ordered raw inline cells and exact native text fragments, including empty cell locations and retained ghost slots.
- Permanent-range membership and token-to-cell-to-run-to-inline-owner lookup.
- Effective ownership/layout intentions that require destination nodes, with original action/effect references.

Keep this raw output independent of visibility and Markdown normalization. It enables MW-06 and an MW-08 adapter to construct `VisibilityLayout`; it does not itself certify `containsBirthContent()`. That query must use a node's birth action causal view and retain its intervals through later transfers. Do not implement it as current ownership, whole-tape membership, or equality with a historical source node. Document this obligation at the adapter boundary and exercise the relevant visibility tests with actual ownership queries during integration.

Keep shared types in their existing module and export no internal mutable maps. Add the ownership entry to `knip.json` for downstream production consumers. Keep input snapshots, envelopes, allocations, and skeletons unchanged.

## Non-goals

- Replacing the action codec/readiness, network transport, or persistence. Home-convention author validation is required integration, not a replacement decoder.
- New deletion/history policy, history navigation, or native `Y.UndoManager` use.
- Markdown normalization, interpretation selection, browser focus, IME, or renderer cutover. MW-09 command lowering and MW-06 edit-address obligations are specified here; this issue does not claim those consumers are implemented.
- A full MW-08 replica factory, full end-to-end corpus certification, or a claim that this reducer proves the combined algorithm.
- Incremental replay optimization, canonical pruning, offline expiration, new genesis, or an authority fallback.

## Verification

Use installed Yjs 13.6.33 through `NativeTapeCache`, with independently allocated caches opened from identical genesis bytes. Authors create native cuts/insertions in their own causal views. Exchange exact published bodies and compare fresh reductions of equal ready sets. Sorting one already-shared synthetic tape order is not a substitute for these controls.

Retain the already approved corpus correction and compare actual corpus inputs with every specified implemented ownership/layout facet. Add home-cell assertions alongside the unchanged content expectations. Expected observations must never supply reducer output. Cover `cuts-earlier-first`, `cuts-later-first`, `same-gap-empty-cut`, `split-at-zero-retains-original-right`, `cross-tape-join`, `split-inside-cross-tape-join`, `opposing-joins`, `move-overrides-join`, `overlapping-transfers`, `ghost-destination-slot`, both `split-sibling-keeps-authored-outer-context` traces, `undo-split-after-peer-insert`, and `undo-cross-tape-join`. Deletion traces must retain the same ownership regardless of visibility filtering; MW-05/MW-08 own the complete visible result.

Add an explicit authored-skeleton regression using real native caches. Author L and R independently from the same genesis and preserve the exact allocations and native bodies. Exercise both semantic priorities by swapping actor order, then exchange bodies in both delivery orders and reconstruct fresh caches. Compare these states separately:

| Active effects after complete native exchange | P emits  | L emits | R emits | Retained L range contains | Retained R range contains |
| --------------------------------------------- | -------- | ------- | ------- | ------------------------- | ------------------------- |
| L only; R allocation/marker retained          | `ab`     | `cdef`  | empty   | `cdef`                    | `def`                     |
| L and R, earlier cut first                    | `ab`     | `c`     | `def`   | `cdef`                    | `def`                     |
| L and R, later cut first                      | `ab`     | `c`     | `def`   | `cdef`                    | `def`                     |
| R only; L allocation/marker retained          | `abc`    | empty   | `def`   | `cdef`                    | `def`                     |
| Neither; both allocations/markers retained    | `abcdef` | empty   | empty   | `cdef`                    | `def`                     |

Also test L before R's body exists. L emits `cdef` with the same authored endpoints; R's later marker refines that interval without changing those endpoints. For each semantic priority, retract and reactivate each split, then both splits. Reactivation restores original priority and the same assignments without allocating a replacement run, occurrence, or native marker.

For each row, assert allocation skeleton endpoint identities, effective cell assignments, raw emitted native identities/order, and retained slot resolution independently. Check total text once, including cells behind ghost locations. Resolve L's original end slot before and after each replay; compare its run/boundary/side/predecessor. Add a causally authored follower at that slot and verify it remains reachable exactly once when L emits only `c` and when L's split is inactive. Use the ordinary retained occurrence ordering; do not move the follower to R. Fresh reconstruction with the same ready facts and activity must reproduce the same endpoints, assignments, traversal, and slot/follower identities. The ownership reducer reads those bodies; it must not allocate native data to make the assertions pass.

Add focused cases beyond the corpus:

1. Both semantic cut orders and both native-client tie orders, distinct markers at one gap, start/end/empty cuts, concurrent text at each seam, and inactive-marker refinement.
2. Split after cross-tape join, join versus split in both orders, transfers into nested joined flows, and a basis whose current component stops at a layout or ownership discontinuity.
3. Repeated and overlapping transfers across tapes, same-flow reorder, emptied source typing, ghost destination typing, left/right seam affinity, and action-local native text.
4. Cohorts mixed with ordinary siblings, anchored followers, different bases/gaps, a moved split sibling, ineffective moves, and retraction/reactivation at original priority. Check that the comparator remains total by testing the resulting traversal, including three-way cases.
5. Late earlier effects and changed activity followed by full replay; surviving peer insertions return through the same identities after split retraction.
6. Unicode fragments, equivalent decoded IDs, unchanged input objects, unknown endpoints, conflicting home bindings, and failed replay with no published partial output.

At every replay prefix, assert total non-overlapping cell coverage, one effective owner per cell, immutable run parent/skeleton, acyclic flow ancestry, and addressable empty/ghost slots. In raw traversal, assert each text identity appears once and each owned cell location is visited once. Compare assignments, ancestry, skeletons, attachment order, and empty locations separately from concatenated strings. Record native marker identities and manifests to prove structural replay allocated no new text or slots.

Use generated small tape/range/attachment combinations and permuted complete-body delivery with fresh reconstruction. Preserve failing seeds as ordinary regressions. These tests establish the ownership layer; real action-store readiness, projection, normalized Markdown, directional isolation, and full history composition remain MW-08/MW-16 gates.

### Required home-contract acceptance tests

These are implementation requirements after approval. The native probe below does not satisfy these reducer, authoring, or composition assertions.

| Case and real input path                                                                                                                        | Required observation                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Minimal witness: three independently authored common-genesis split/split/transfer envelopes; both split priorities and six complete-body orders | Before C1: P=`ab`, L=`cd`, R=`ef`. After C1: P=`a`, L/R empty, Q's prior text followed by `bcdef`. Every original native text ID occurs once. L and R each own their private reserved cells; L's authored skeleton still covers `cdef`.                                                          |
| Existing generated seed `34064`, all 24 seeds, same generator decisions and positive assertions                                                 | Every prefix reduces successfully; retraction/reactivation, duplicate bodies, and fresh reconstruction preserve the existing eight-text-unit identity count. Add home cells; do not skip a schedule, turn failure into `toThrow`, or replace the seed.                                           |
| After the witness, author `x` into L's empty home through real lowering, then transfer all `x` to Q and type `y` into L                         | Q contains `bcdefx` after its prior text; L contains `y`. `x` keeps its original native identity. Both transfers retain their original intervals. No replay allocation occurs. Repeat evacuation three times.                                                                                    |
| Two peers independently type into the same empty L home                                                                                         | One L flow; both bracketed insertions in converged native order; two empty sentinel-adjacent cells remain. Full-string and surrogate-pair identity comparisons agree after opposite ready-body orders.                                                                                           |
| A transfer of all known home content concurrent with peer typing                                                                                | Peer typing inside the capture follows the transfer; bracketed typing beyond its endpoint stays with the source. Assert each authored origin, not just the resulting string.                                                                                                                     |
| Split a flow with source-skeleton content plus text in its home; split across a joined flow                                                     | The maximal content component crosses reserved cells without stopping, but stops at any intervening non-reserved foreign cell. Hidden and ordinary empty content cells still participate. Both cut priorities and retain-right start behavior pass.                                              |
| Split empty content; end split; distinct cuts at one gap                                                                                        | New flow has a private home before publication; original node identity follows retainedSide; same-gap siblings and homes remain distinct and in native cohort order.                                                                                                                             |
| Empty-basis two-generation review witness through certified actions, both actor orders and both relative native-client orders                   | A-before-B raw order P, TB, TA, SA, SB; B-before-A raw order P, TA, TB, SB, SA. A1/B1 share the P home-domain cohort; A2 and B2 have separate domains. Compare all six ready-body schedules, isolated prefixes, full node/home/slot identities, and fresh reconstruction.                        |
| Same-source empty start/right and end/left cuts; three repeated empty splits                                                                    | Canonical source cut is reusable; each new node owns a distinct home and insertion slot. Start creates the new sibling before its source; end creates it after. Equal cuts use ascending effect order within their common cohort, independent of native client IDs.                              |
| Empty split activity controls, all 16 activity subsets of the four-birth witness                                                                | Recompute eligible buckets from original effect priorities. Retain every raw occurrence/home; complete raw order follows the specified active-cohort/ordinary-anchor rule. MW-10 controls, visibility, and peer home text must be tested through the real integrated paths.                      |
| Later source-home typing or joined content concurrent with a certified empty split                                                              | Preserve the recorded empty-home key and no-content assignment. Do not reclassify from current string length or merged ownership. The old split does not capture later home text.                                                                                                                |
| Malformed empty-basis author facts                                                                                                              | Reject a non-root cut run, missing home binding, noncanonical boundary/side/predecessor, omitted ordinary empty content cells, or an author-visible content component falsely encoded as `[]`. A content basis emptied only after merge stays a content cohort.                                  |
| Two flows and a dependent split created in one atomic action                                                                                    | Exact root/run/tape binding from each last skeleton range; no allocation-order inference; prefix source ranges can use the earlier effect's tape.                                                                                                                                                |
| Retract split after peer text on captured interval versus peer text on private home                                                             | Captured-interval text returns by ordinary replay. Private-home text remains with its flow. Redo uses identical tapes, markers, occurrences, and original priority.                                                                                                                              |
| Join/move/transfer retraction and reactivation with both participant homes populated                                                            | Acyclic flow ancestry, exact skeleton order, and all home bindings survive. Transfer undo leaves subsequent source-home text at source.                                                                                                                                                          |
| Retained follower at moved source end and at a home marker; inactive creator                                                                    | Followers traverse exactly once through original slots; no silent home redirect. Each raw cell and slot identity has a separate assertion.                                                                                                                                                       |
| Deletion of source/destination with typed homes; undo limit and checkpoint/restart                                                              | Deletion-wins visibility remains unchanged. Empty home cells do not rescue deleted content or make blocks immortal. Full native bytes retain old home IDs and accept later typing from an old checkpoint.                                                                                        |
| Malformed author facts through MW-01/MW-15 validation                                                                                           | Reject missing/duplicate home, conflicting supplied binding, foreign home tape, missing brackets/bare edge text, sentinel capture endpoint, overlapping structural skeletons, and wrong occurrence before publication. Missing dependencies defer. Merge alone never rejects a certified action. |
| MW-08 independent replicas using the certified lowerer and MW-10 controls                                                                       | Equal ready facts yield equal bindings, assignments, raw order, history effects, visible IDs, empty edit addresses, and normalized output. Reverse delivery, fresh open, and A→B-only delivery need no authority or acknowledgment.                                                              |

At every prefix, compare the complete raw traversal (including reserved cells) with assignments, and compare the filtered content traversal separately. Record native snapshots before and after reduction to show that replay writes no markers. Compare retained allocation skeletons directly, including appended home ranges, rather than rebuilding them from emitted text. Use independently authored expected text/ID observations, never manual cell ownership as reducer input.

### Investigation evidence and limits

The review probe at `docs/proposals/mw04-home-cell-probes/probe.mjs` uses the real `NativeTapeCache` with Yjs 13.6.33. Run:

```sh
node docs/proposals/mw04-home-cell-probes/probe.mjs > /tmp/home-cell-results.json
```

It checks independent native authors, unchanged `ef`/`cdef`/`bcdef` content captures, all six A1/B1/C1 native-body orders, empty private tape geometry, concurrent bracketed Unicode typing, interior full-content recapture, and bracketed fallback outside that capture. A negative control demonstrates why a whole-tape capture is invalid under the proposed convention. Duplicate complete ready bodies reconstruct identically. The cache requires native prerequisites first: the later capture/fallback bodies are not delivered before their own native clock prefix. Network readiness is not simulated here.

On Node 26.13.0, 21 native controls pass. No ownership assignments, flow allocation envelopes, semantic reducer, history, validation gate, or MW-08 factory is exercised by this probe. Its logical resource labels are native test identifiers, not fully certified action envelopes. It does not establish that filtered component traversal, private-home visibility after split undo, or the combined algorithm works. These remain the explicit acceptance tests above.

The unchanged previous gap probe also passes its 31 controls, confirming the old encoding still has the gap. The actual unchanged generated reducer suite reports 23 passed and one failed: positive seed `34064` still raises the empty-source diagnostic. Those results are consistent: this revision proposes a contract and native encoding, not an implementation fix.

### Empty-basis revision evidence and limits

Run the additional probe from the checkout:

```sh
node docs/proposals/mw04-home-cell-probes/empty-cohorts.mjs > /tmp/empty-cohort-results.json
```

On Node 26.13.0 with Yjs 13.6.33, 74 named controls pass. Four traces independently vary semantic actor order and relative native author-client order. Each native author starts from the same genesis body. All six dependency-ready orders of A1/A2/B1/B2 reconstruct identical native snapshots and the specified complete raw block order. The controls check same-source end cuts, concurrent start/right cuts, repeated start/right and end/left splits, distinct node/flow/run/occurrence/home/insertion-slot identities, unchanged source sentinels, duplicate bodies, all 16 effect-activity subsets, reactivation, and later bracketed Unicode home text. Equal empty cuts share one source marker; native-client reversal does not create different cut positions.

`empty-cohorts.mjs:proposedBuckets()` is a proposal-local model of the new cohort rule. It reads real `NativeTapeCache` snapshots through the actual `CellIndex` and feeds buckets to the actual `LayoutPrefix`. Expected block orders are separately asserted constants; they are not model inputs. The probe supplies no cell ownership assignments and does not call or modify `reduceOwnership()`. Activity subsets are direct replay inputs, not published MW-10 history controls. The logical layout inputs are not certified action envelopes. The model checks the cut's native membership and endpoint but does not implement full author-closure validation. Later typing checks native/domain stability, not text ownership or visibility. This is native/layout ordering evidence for review, not combined semantic, history, or MW-08 acceptance.

The six prior dependency-free review controls pass unchanged: their baseline exceptions still reproduce the unchanged runtime's missing empty-basis support. The actual generated reducer suite still has 23 passes and one positive failure at seed `34064`, with the same empty-source diagnostic. Neither the generated test nor its fixture/generator decisions changed. Implementation of the home convention and the acceptance matrix above remains gated by Proposal Review.

Implementation checks: `npm run build`, `npm run test -- src/markdown/multiwriter/`, `npm run lint`, `npm run check:boundaries`, both `analyze:unused` scripts, and `npm run format:check`. Run the full Node suite if shared fixtures/types change. No browser run is needed while the issue stays within its headless scope.

Proposal preparation checks source paths, fixture names, the dependency modules, and agreement with the authoritative contract. It does not establish runtime correctness.

## Suggested implementation shape

1. Obtain normal Proposal Review approval for the named home-contract amendments. Keep the already approved one-facet corpus correction and its positive regressions.
2. Specify and test the home-convention author validator and lowering plan against the real native cache. Extend `cells.ts` with derived bindings and reserved-cell classification. Re-author fixtures without changing seed `34064` or its semantic operations.
3. Implement `traversal.ts` for skeleton/attachment order, ghost slots, and exact fragment visitation.
4. Extend `ownership.ts` for split-born home seeding and empty-basis splits; use content adjacency for split components. Keep complete raw coverage separate.
5. Implement `cohorts.ts` for the disjoint content/empty-home keys, author-certified empty domains, native cut ranking and explicit equal-cut ties through `OccurrenceBucket`. Preserve MW-03 unit ordering; do not compare markers across tapes.
6. Add `index.ts`, focused corpus-facet comparisons, generated checks, and consumer documentation. Keep production optimization out of the reference path.
7. Continue draft PR #81 against `yjs`; mark it ready only after positive regressions and required checks pass. Record remaining MW-08/MW-16 and authoring integration limits.

## Success criteria

- Every ready native cell, including empty and hidden cells, has exactly one effective run/occurrence assignment.
- Authored skeleton endpoints and ghost slot identities survive both semantic cut orders, retraction/reactivation, and fresh reconstruction; effective assignments are asserted separately.
- Different-position cuts yield `ab | c | def` in both semantic orders; same-gap cuts retain distinct empty locations.
- Empty same-source cuts share one home-domain cohort; different empty homes never share a native comparator. The two-generation trace, equal-cut ties, repeated splits, activity changes, and fresh reconstruction have the exact raw orders specified above.
- Joins, repeated/cross-tape transfers, and split retraction preserve exact native identities and ghost addresses.
- Split selection uses the coupled action prefix, and cohorts display in native cut order without moving authored outer contexts.
- Equal validated ready sets and activity yield equal raw ownership/layout after independent native reconstruction.
- Every flow retains its own reserved home cells after any admitted content transfer/split, including seed `34064`, later home typing, and repeated evacuation.
- Home bindings and protected-edge invariants are certified from author facts; malformed conventions fail before publication.
- Replay performs no shared writes. No new CBOR field, dependency, browser change, canonical pruning, forced genesis, or combined-algorithm claim is introduced.
