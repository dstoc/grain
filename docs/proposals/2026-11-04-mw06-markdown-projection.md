# Proposal: MW-06 Markdown interpretation and edit addresses

- **Issue:** grain/87.
- **Status:** Proposed; requires Proposal Review before implementation.
- **Authority:** [MW-00 proposal, version 2](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/81), especially §§6.6, 7, 8, 9.1, 13 and 14. Preserve the approved MW-04 home-cell convention recorded on grain/85. This proposal does not amend the frozen conflict outcomes.
- **Inspected baseline:** `origin/yjs` at `0a67b2d37dff6fc352a2a700bfa99338601264da`, including MW-03, MW-04 and MW-05. Yjs remains pinned to 13.6.33.
- **Proposal branch:** `docs/87-markdown-projection-proposal`, based on `origin/yjs`. Implementation and eventual PR target `yjs`.

## Motivation

Q contains `# x`. A converts Q to a heading, consuming the exact identities for `# `. A then joins Q into P. Q's text must render inside P as `x`; joining must not expose Q's prefix or hide P's unrelated characters. If B independently converts Q to code and B's packet wins, the old heading mask becomes inactive and Q's original `# x` is literal again. Raw text identities, flow slots and Q's children survive either result.

MW-06 supplies a legal Markdown view and stable editing addresses for those results. It does not edit canonical state while reading it.

## Problem statement

`src/markdown/multiwriter/contracts.ts` already defines `InterpretationPacket`, `Interpret`, `SetProperties`, `LiftChildren` and `ProjectionAddress`. No `multiwriter/projection/` implementation exists.

`layout/layout.ts:LayoutPrefix.step()` handles ordinary moves, joins and explicit lifting. It registers interpretation occurrences but does not execute packet placements or decide which packet applies. `ownership/ownership.ts:reduceOwnership()` interleaves every effect ordinal with that layout. Applying packet placements after ownership reduction would bypass the shared move kernel and could change ancestry too late. `visibility/visibility.ts:reduceVisibility()` handles insertion activity, deletion and weak birth suppression, but does not select packets or apply syntax masks. Action-level birth activity alone cannot hide a wrapper allocated by a losing conversion in an otherwise active action.

`block-parser/types.ts:ParserConversionPlan` already records exact UTF-16 retained slices, synthesized pieces and consumed ranges. `block-parser.provenance.test.ts` checks headings, tasks, fences, repeated text, chunk schedules and snapshot/resume. `canonical-promotion.ts` validates and lowers those plans into the existing canonical draft. Its consumed-source deletion is unsuitable for schema 3, where interpretation hides syntax until a packet loses or is retracted.

`semantic/normalize.ts:normalizeSemanticTree()` mutates a draft: it reparents sections, merges wrappers, renumbers lists, removes empty containers and creates a paragraph at an empty root. Calling it on shared state would publish replica-local repair actions and lose wrapper origins. A derived implementation must audit all these behaviors, including empty-root creation.

## Proposal

Implement a headless reference module in `src/markdown/multiwriter/projection/`. Reuse the frozen logical types and parser provenance. Add no dependency, wire field, canonical cache, authority or browser cutover. First callers are focused headless tests; MW-08 composes the reference replica, MW-09 lowers commands, and MW-14 mounts the view.

### Select packets before placement replay

Add a pure interpretation selection pass over the complete ready set and MW-05 activity. For each stable `packet.source`, choose the last active `Interpret` by the existing semantic effect order. Parentage, displayed kind and delivery order do not participate. Reactivation uses the original priority.

Return the winning packet IDs, properties, exact masks, packet-owned wrapper requirements and a placement applicability lookup keyed by the original action/effect ordinal. Do not rewrite envelopes, flatten packets into independently ordered public effects or renumber effects. An interpretation remains effective when its source flow is joined or its characters transfer elsewhere.

Execute winning packet placements through `LayoutPrefix` at their original `Interpret` ordinal, with the same role and cycle checks as explicit placements. Losing packets install retained allocations and occurrences but apply no conversion placements or masks. A later winner change requires full reference replay from genesis. It cannot patch the final tree. Atomic packet applicability does not imply every cycle-checked placement succeeds.

This needs small integration changes in `layout/layout.ts`, `ownership/ownership.ts` and `visibility/visibility.ts`. Keep packet selection in projection. Supply explicit eligibility to these lower modules without importing projection into them or changing activity for unrelated effects. Continue consuming every ordinal. Extend effective destination requirements to packet placements that actually win, so scaffolds follow the same rule as explicit moves.

Wrapper availability must distinguish packet activation from action activity. A wrapper used only by a losing packet is suppressed from the view while its allocation remains retained. Independently surviving children, text or effective destination requirements can retain it as a scaffold. Do not hide unrelated allocations from that action. Visibility must expose this distinction rather than infer it from the normalized parent tree.

Apply ordinary `SetProperties` as independent field updates in semantic order. Checking a task does not deactivate its conversion, wrappers or masks. Parser-authored incompatible conversions use a replacement `Interpret` packet. Add tests for the existing presentation field on `SetProperties`: changing a field alone must not implicitly retract a packet. No new compatibility relation inferred from displayed kinds is proposed.

### Exact identity masks and synthesis

Match masks by tape, native client and half-open clock interval. Never use string search, current offsets, a surrounding marker interval, or current outer owner to decide mask membership. Intersect masking with insertion/deletion visibility; removing a mask cannot revive deleted or inactive text. Keep the origin mapping for masked fragments available to later explicit demotion commands.

A concurrent insertion inside an observed prefix remains literal unless its own identities were explicitly masked. Equal strings on another tape or elsewhere in one tape remain unchanged. Joins and transfers retain masks on their source identities and carry fragment origins into the destination. They create no mask over destination characters.

An intentional demotion that observed hidden syntax can emit a normal `DeleteText` for those exact identities in its author action. A concurrent incompatible conversion merely replaces the packet. Projection never authors that deletion or guesses that the author intended it.

Every synthesized editable piece must resolve to text born once in that author action's native manifest. The parser adapter describes synthesis; the authoring compiler allocates identities and publishes the insertion. Projection validates and uses those identities without creating a newline or other editable character. Synthesis follows normal insertion activity, deletion and ownership; losing interpretation does not invent a native deletion. Derived numbering and export delimiters are noneditable display data.

### Parser-facing conversion plan

Retain `ParserConversionPlan` as the parser's offset-based contract. Add a projection-side preparation function that accepts the exact source string, its ordered native-fragment mapping, the parser plan and explicit output-node bindings. Return a validated authoring plan with retained identity pieces, exact consumed identity ranges, synthesis requests, properties and wrapper/placement requests. This is input to MW-09, not a second parser or an action publisher.

Validate output paths, exact piece reconstruction, source coverage, nonoverlap and UTF-16 boundaries before returning a plan. Resolve consumed ranges against the author's source mapping, never a later merged string. Parser-local paths and temporary construction IDs must not escape into `InterpretationPacket`. Source text already assembled from transferred or joined fragments can map to several tapes; retain that segmentation.

Separate preparation from final binding: the caller supplies stable node, flow, run, occurrence, marker and interpretation identities, plus the native identities for each synthesis request. Finalization checks that every editable output character has a retained or newly allocated identity and that synthesis matches the native manifest. Empty output contains no synthesized character. Reject incomplete or inconsistent bindings with a typed error and no partial action. For optional parser conversion, the caller can keep literal input; it must not publish a partly converted packet.

Reuse validation ideas from `canonical-promotion.ts` without calling its canonical mutation path. Keep existing parser and schema-2 behavior unchanged. The adapter does not decide multi-block split/transfer lowering; that remains MW-09's command contract.

### Legal view and child lifting

Read raw children in MW-03/MW-04 effective occurrence order, and read inline content from `OwnershipResult.raw()`. Apply deletion/availability and interpretation without discarding raw nodes or ghost slots. A nested source flow contributes text through its destination traversal exactly once; its absorbed header does not render a second copy.

A visible section may own visible blocks. A paragraph, code block or absorbed header cannot own blocks in the legal view. Walk its children in raw order and emit them immediately after that header's position into the nearest legal containing view. If the header is absorbed, its position still supplies the deterministic lifting position. Keep a section's retained body when its presentation changes to paragraph/code or its header is joined. Never treat absorption as subtree deletion, or lift deleted descendants back into view.

Explicit `LiftChildren` and a join's authored child-lifting intent remain retained command facts. Projection handles any remaining illegal children, including concurrent arrivals, by this same view rule. It does not publish extra placements. Preserve source slots on lifted edges so later commands can author a real move instead of editing a fabricated parent.

### Audit normalization as a derived pass

Run one forward normalization pass over detached view records. Preserve current rule order and compare against the existing normalizer on legal nonconflicting inputs:

| Existing rule | Derived behavior |
| --- | --- |
| Trailing blocks enter the preceding section | Change view edges only; retain raw edge origins. |
| Contiguous sections nest by marker depth and first-section rules | Reproduce the existing containment/order rules; record every moved edge's origin. |
| Adjacent lists merge | Use the first wrapper as representative and append constituent IDs in traversal order. |
| Adjacent quotes merge | Use the same representative/constituent rule. |
| Lists derive item markers | Compute numbering from the first marker, preserving delimiter and existing BigInt behavior; do not write markers. |
| Task state normalization | Project checked state without emitting property writes. |
| Empty list/item/quote removal | Omit empty view containers under the same forward cleanup policy; retain canonical allocations and origins. |
| Empty root gets a paragraph | Return a local caret address, without creating a shared node. |

Do not add a fixed-point loop to change current one-pass output. Preserve authored empty paragraphs and supported literal-paragraph encodings. Any discrepancy from baseline Markdown output needs a focused fixture and an explicit conflict explanation; do not silently update corpus expectations.

### Addresses for every editable surface

Return immutable view records with a parallel origin map using `ProjectionAddress`. View-local keys identify records only within that result; they are never canonical mutation targets.

- A visible node records an existing representative and all observed constituents. Merging U and V does not allocate a group ID.
- Each child edge records its actual underlying `BlockSlot`, including lifted and normalized edges. Its displayed parent is not a replacement mutation address.
- Each text fragment and caret boundary records the persistent run/marker/side, native fragment identity and retained `RangeRef`. Keep enough segment data to translate visible UTF-16 selections into exact native ranges across masks, joins and transfers.
- At a merged wrapper boundary, expose the specific constituent container and slot for each side. A boundary resolver takes explicit side/affinity; it does not return the representative for every insertion.
- Group deletion expands to the observed constituents, not a newly computed set after another update. MW-09 captures deletion scopes in the author view.

Empty or fully masked text still has an insertion address. Use MW-04 home bindings and `HomeIndex.planTextInsertion()` for evacuated flows and reserved-edge typing. Do not replace a ghost slot with the current owner of its former characters. Stale address resolution returns the original address or an explicit unavailable result for the caller to re-resolve against a fresh projection; it never silently changes lineage.

### Empty root

Distinguish empty genesis from post-deletion emptiness. Bootstrap owns one ordinary shared paragraph/flow for initially empty Markdown; projection does not create it. After deletion leaves no visible editable block, return an `empty-root` address for the root insertion slot, separate from the semantic view node array. Repeated projection allocates nothing and emits no action.

The first edit through that address returns an authoring request to create a real paragraph, flow, run, home tape and occurrence at the captured root slot, with the typed text in the same action. MW-09 supplies IDs, native brackets, publication and history. Validate this request in MW-06 headless tests with real native allocations. Two independent edits create two ordered paragraphs. Neither revives the deleted genesis paragraph or merges the new identities. Browser caret presentation remains MW-14.

### Errors and publication

All stages take one consistent ready-set snapshot. Unknown origins, missing bindings, invalid masks or mismatched inputs fail before returning a new view or authoring plan. Do not substitute guessed root slots or reparsed text. MW-15 owns ingest quarantine and backpressure; the projection validator supplies checks against the exact author closure. Concurrent merged replay must not rerun author-local assumptions against unrelated concurrent text.

A valid conflict is an output, not an error: losing packets, cycle-rejected placements, deleted nodes, retained scaffolds and independently created empty-root paragraphs all have deterministic results. Return enough origin data for callers to explain them without exposing internal diagnostics in ordinary editing flows.

## Non-goals

- Native decoding, action readiness, provider transport, persistence, checkpoints or history navigation.
- Replacing ownership, deletion coverage or cycle resolution with projection-specific algorithms.
- Browser facades, selection restoration, IME handling or switching the mounted editor to schema 3.
- Full command lowering, general arbitrary-position incremental parsing, incremental projection optimization or a new Markdown grammar.
- Canonical pruning, offline expiration, old-data migration or mixed home-cell conventions.

## Verification

1. Import actual expectations from `test/multiwriter/corpus.ts` for `losing-interpretation-restores-only-own-mask`, `joined-interpretation-keeps-lineage-mask`, `normalized-wrapper-addresses`, `empty-root-creates-two-independent-paragraphs` and `undone-wrapper-scaffolds-peer-child`. Check output and origins, not a helper returning expected observations.
2. Exercise real native text with heading, code fence, checkbox, repeated text and surrogate-pair inputs. Add concurrent insertions inside and beside consumed syntax, partial transfers, joins, explicit demotion deletion, deletion retraction and packet reactivation. Assert exact native identities, visible strings and retained masks after checkpoint reconstruction.
3. Compete packets with different wrappers and placements. Assert the loser contributes no conversion effects, retained wrappers scaffold independent peer content, cycle decisions replay at original ordinals, and task/property edits remain independent. Test changed winners in both arrival orders.
4. Compare parser plans across full parse, every two-chunk split, character streaming and snapshot/resume. Validate identity mapping over fragmented/multitape source, real synthesis and incomplete prefixes. Invalid source coverage and synthesis bindings must publish nothing.
5. Compare the pure normalizer with `normalizeSemanticTree()` on legal trees and generated nested section/list/quote combinations. Compare observable Markdown and semantic output while independently checking origins. Cover empty-container cascades, mixed list markers, large ordered numbers and authored empty paragraphs.
6. Exercise lifting for paragraph/code demotion, joined section headers, nested containers, concurrent children and deleted ancestors. Assert raw tree/flow identity is unchanged and each surviving child/text identity appears once.
7. Resolve insertion on both sides of merged-wrapper boundaries and across lifted edges. Check group deletion targets all observed constituents. Map selections across masks, transferred fragments and empty runs, then validate the resulting native edits through MW-04 homes.
8. Verify initial empty genesis uses one common lineage. Delete it, project repeatedly, author two independent empty-root creations, exchange their real actions and confirm both IDs and texts survive. Check retraction/reactivation without reviving deleted identities.
9. Freeze inputs and compare complete native bytes, allocation counts, heads and emitted updates before/after projection, normalization, export and address lookup. Equal ready sets in separately reconstructed caches must produce equal semantic views and logical origins under permutations and duplicate deliveries.

After implementation, run `npm run build`, `npm run test`, `npm run lint`, `npm run check:boundaries`, both `analyze:unused` scripts and `npm run format:check`. Focused iteration can run the projection, layout, ownership, visibility, provenance and normalization suites. Browser checks become required only if the implementation expands into mounted editing, which this proposal excludes.

These checks establish owned module behavior. They do not satisfy MW-08's composed independent-replica gate, MW-09's real command coverage, MW-10 history navigation or MW-16 browser acceptance. Proposal preparation itself runs document/source checks only and establishes no runtime correctness claim.

## Suggested implementation shape

1. Review packet applicability, lower-module integration and address contracts before coding.
2. Add `projection/interpretation.ts` and the narrow layout/ownership/visibility hooks with packet competition tests.
3. Add `projection/parser-plan.ts` for identity-bound parser preparation and synthesis finalization.
4. Add `projection/normalize.ts` and `projection/project.ts` for legal views, lifting and audited normalization.
5. Add `projection/addresses.ts`, empty-root authoring requests and a narrow `projection/index.ts`. Register the production entry in `knip.json`.
6. Run corpus facets using real native modules, then hand the contracts to MW-08/MW-09. Open the implementation PR against `yjs`, attach it to grain/87 and request review without waiting for CI.

## Success criteria

- Packet properties, wrappers, placements and exact masks share one applicability decision.
- Visible editable characters always retain native identity; projection authors no shared writes.
- Every visible node, wrapper group, edge and text boundary has a persistent origin.
- Pure normalization preserves baseline behavior or documents an explicit tested conflict result.
- Absorption and presentation changes preserve surviving children and ghost addresses.
- Empty-root edits explicitly create real identities and preserve concurrent creations.
- Tests distinguish owned projection coverage from the outstanding combined algorithm gates.
