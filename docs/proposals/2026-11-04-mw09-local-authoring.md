# Proposal: Compile local semantic commands into multiwriter actions

- **Issue:** grain/90 (MW-09).
- **Status:** Proposed; implementation requires Proposal Review approval.
- **Authority:** grain/81 proposal v2, especially §§4.3, 6–9, 13–14; the approved MW-04 private-home contract and MW-08 constructor rule.
- **Inspected baseline:** `yjs` at `0b500005bb26ebdbd0b8b891428ddd2b84bc4f30`, including accepted MW-08 PR #83. Branch and eventual PR target: `yjs`. Yjs stays pinned to 13.6.33.

## Motivation

A and B open the same genesis and disconnect. A types into a paragraph, presses
Enter, indents the tail into a list, pastes Markdown, and joins two paragraphs
with Backspace. Each command must publish locally before the next command runs.
B can concurrently delete the original paragraph. On later delivery, both peers
must preserve original text identities and apply deletion-wins consistently.
A must neither wait for B's acknowledgment nor replace its authored branch.

MW-08 now supplies the accepted headless reference composition. MW-09 must make
ordinary semantic commands use it. Test trace authoring is insufficient: callers
need Enter, Backspace, indent, paste and literal input against their own projected
tree, including after remote changes.

## Problem statement

The current code has useful command logic but the wrong publication boundary:

| Current code | Reusable behavior | Gap for MW-09 |
| --- | --- | --- |
| `src/editing/context.ts`, `outcomes.ts`, `commands/` | Scoped commands, selections, command precedence and explicit outcomes | `TreeDraft` does not distinguish destructive removal from join or unwrap |
| `src/editing/prepare-edit.ts` | Captures selection and checks inapplicable commands | Calls `CanonicalWriter.prepareCommand()` and returns authority requests |
| `src/markdown/canonical/plan/draft.ts` | Draft-local text pieces and move-only fragments | Emits schema-2 operations and read guards |
| `src/markdown/semantic/construction-tree.ts` | Plain parser tree and semantic draft ergonomics | Does not retain native origin pieces |
| `src/markdown/multiwriter/reference/document.ts` | Certification, provenance and atomic projection | Deliberately leaves production authoring to its caller |
| `src/markdown/multiwriter/projection/addresses.ts` | Exact selection ranges, caret origins, wrapper constituents and empty-root requests | Needs a command-side consumer |
| `src/markdown/multiwriter/projection/parser-plan.ts` | Exact retained/consumed pieces and synthesis binding | Leaves structural lowering and publication to MW-09 |
| `test/multiwriter/reference/author.ts` | Demonstrates native preparation and envelope certification | Uses symbolic trace aliases, allocation roles and a test-only native plan |

`join-with-previous.ts` and `delete-backward.ts` currently append a source's text
and detach its node. `operations/inline.ts:splitInlineInto()` deletes a selection
and transfers a suffix into a newly created node. `operations/containers.ts`
lifts children and detaches an empty wrapper. `delete-blocks.ts` also detaches
nodes, but intentionally deletes selected content. A compiler cannot infer these
meanings from the final tree or translate every detach into `DeleteSubtree`.

The approved constructor rule makes that ambiguity observable. An explicit
`SplitFlow` birth covers its captured component for inherited deletion. Ordinary
create-plus-transfer does not. Likewise, a join must retain the source's flow so
later typing into that lineage follows the join. Reconstructing final strings
loses both contracts.

The semantic node ID is currently a string; schema-3 IDs are structured resources.
Normalized views can also merge wrappers and lift edges. A view representative
alone cannot identify every raw deletion target or insertion container.

## Proposal

### Preserve command intent at the command boundary

Add an editing-specific `CommandDraft` interface extending `TreeDraft`, under
`src/editing/`. Give it explicit operations for inline split, inline join,
subtree deletion and child lifting. Each operation carries the node IDs, selection
range, retained side or destination needed at the moment of the command. Keep
ordinary `place`, text splice, fragment transfer, conversion and property methods.

Use `CommandDraft` in `EditContext`. Adapt the existing canonical and construction
drafts with ordinary local tree implementations of those four operations. The
schema-3 draft implements the same operations while retaining the distinct intent.
Do not add collaboration IDs or effect types to the parser-facing `TreeDraft`.
Existing direct `TreeDraft` users remain supported; arbitrary legacy mutation
callbacks are not automatically schema-3 commands.

Route all relevant branches of Enter, Backspace, selected deletion, replacement,
outdent and paste through these operations. Audit every editing-layer `detach()`
and every call to the inline/container helpers. Shared helpers may still perform
ordinary tree mutations inside a legacy adapter; schema-3 lowering must not
recognize a join by matching a transfer/detach pattern afterward.

For a split, record the destination's construction intent before it is finalized
as a published ordinary allocation. New nodes can exist as draft-local records
before their first placement. Endpoints and effect ordinals remain ordered by
command intent, even when the compiler delays final resource allocation.

This is a small command adapter, not a second document model or generic extension
framework. The first callers are the existing Enter and Backspace commands. Keep
the existing canonical browser runner active until the later integration gates.

### Draft reads and identity mapping

Add a multiwriter command draft under `src/markdown/multiwriter/authoring/`. It
reads one coherent published projection and keeps an action-local overlay of
changed records and text pieces. It never adopts or mutates the browser DOM.
Unchanged nodes retain their persistent origins. Do not parse exported Markdown
to obtain an editable copy of the document.

Use opaque local string handles to satisfy the existing semantic command API.
Each handle maps explicitly to its `ProjectionAddress`; each new draft handle
maps to its planned allocation. These handles never enter an envelope or become
persistent IDs. Resolve wrapper boundaries and selected constituents through the
existing address helpers. Do not treat a normalized wrapper as a new raw node.

Represent inline pieces as retained native ranges or slices of immutable
unpublished buffers. Preserve their order across cut, transfer, insertion and
conversion. A fragment is move-only within its draft. Inserting it twice or into
another draft fails before publication. Action-local transfers must resolve from
these pieces rather than asking the committed cache for unpublished identities.
Discard insert-then-delete text that has no final use; never discard published
facts. Snapshot an operation's source and destination in pre-operation coordinates
so same-node moves do not change the meaning of their numeric arguments.

Reads and bookmarks allocate no shared resources. Validate UTF-16 boundaries
through the existing semantic checks. Native IDs are bound only after native
preparation. Explicitly retain origins for empty intervals and all repeated-text
pieces; never recover identity with substring search.

### Lowering rules

| Local intent | Schema-3 lowering |
| --- | --- |
| Create a placed inline | Allocate node, flow, root run, birth occurrence and distinct private home tape; set initial presentation and allocate literal text once |
| Create a wrapper | Allocate immutable raw role and unambiguous birth occurrence; place via its authored slot |
| Type or replace selected characters | Map visible selected fragments to exact `DeleteText` ranges, then insert new identities with `InsertText` |
| Enter split | Emit explicit `SplitFlow` with exact pre-effect `FlowBasis`, permanent cut, retained side and authored outer slot; selected text deletion stays separate |
| Backspace join | Emit `JoinFlow` with the source flow and destination seam; preserve source node, home and tape; carry child-lifting intent in the same action |
| Explicit range transfer | Emit `TransferRange` and a fresh placement run; retain the source's insertion location |
| Indent, outdent or reorder | Emit authored `MoveBlock` occurrences; inline moves assert standalone flow |
| Unwrap or lift children | Emit `LiftChildren` placements for observed children; leave the empty raw wrapper retained, with view cleanup supplied by pure normalization |
| Explicit block deletion | Expand selected view constituents and capture `DeleteSubtree` scopes from the author's actual ownership and causal heads |
| Property/task change | Emit `SetProperties`, independent of parser packet activity |
| Parser conversion | Prepare and bind an `Interpret` packet with exact masks, outputs and author-allocated synthesis; lower its required structural effects |

For Enter at zero, preserve the existing original-on-right identity behavior.
Include both retained-side rules, selection replacement, end cuts and empty cuts.
A section-at-zero command that only inserts an empty paragraph before the heading
is ordinary creation; do not invent a split merely because the key was Enter.
When a command really partitions a flow, use `SplitFlow`, including list Enter.
Its new root run ends with its fresh full private home. Capture the component in
the exact pre-split prefix, including joined content and ordinary empty cells.

Use MW-04 interior structural endpoints. Edge typing uses
`HomeIndex.planTextInsertion()` and two author-allocated brackets when required.
Reserved edge cells remain text-free. Transferred content keeps its source tape;
only genuinely new text and private homes allocate new native content. Resolve
native positions through projected text points, `nativePointIndex()` and retained
marker order, never through visible offsets in a remote envelope.

A subtree delete records observed nodes, owned intervals, joined flows and heads
at its command prefix. Lifting unselected section children occurs before capturing
the selected header's remaining deletion scope. A join and an unwrap contribute
no subtree deletion. Wrapper cleanup must not tombstone unseen peer children.
Deletion against a normalized wrapper expands its observed constituents rather
than deleting only the representative.

Ordinary Markdown paste copies clipboard content into new nodes and native text,
as `operations/parsed-content.ts` already specifies. It does not transfer the
source document's identities. Preserve existing replacement preflight, scope,
marker and task behavior. A consumed empty active paragraph is an explicit delete,
not a heuristic that removes unrelated empty paragraphs. A post-deletion empty-root
view creates a real paragraph/home and the first input in one action; projection
alone still allocates nothing.

### Parser conversion and normalization

Use parser conversion plans and `prepareParserConversion()` instead of comparing
before/after strings. Bind retained fragments from the draft's origin pieces and
allocate synthesized editable text once through native preparation. Then call
`bindParserConversion()` and publish the complete packet with its structural
lowering. Synthesis identities must differ from retained and consumed source,
even when all were born in this action.

Keep optional typing promotion atomic with its literal insertion. If an optional
conversion is invalid, keep the literal input and omit the entire conversion.
An explicit invalid command declines without publication. Operational exceptions
and reducer invariant failures propagate; they are not silently converted into
literal fallback. Explicit demotion may delete exact previously masked syntax
that it observed; a competing conversion must not delete those identities.

Run legal-view normalization through the existing projector. Do not call
`ConstructionTree.normalize()` or the mutating semantic normalizer on shared
schema-3 records to manufacture wrapper merges, numbering or caret paragraphs.
An isolated simulation may still support paste preflight. Validate its final
scope constraints against actual projection origins before append.

### Local preparation and publication

Provide a headless local editor with a synchronous `edit(session, command, input)`
entry point. It owns its actor chain, resource ordinals and private native authoring
cache. It consumes the reference document's store/publication interface and does
not own transport or storage. Sessions provide group IDs; MW-10 will own history
navigation and grouping policy.

Each successful edit follows this order:

1. Read an authorable publication and its exact ready heads. Run the scoped command
   synchronously in a fresh draft. Reject invalid input or an inapplicable command
   before native preparation. Inapplicable commands must leave no mutations.
2. Finalize the intent plan and local buffers. Allocate resources uniquely across
   kinds. Use a fresh random actor for each writer instance; compute contiguous
   action sequence and Lamport time from the prior actor action and observed heads.
   Reject overflow rather than wrapping counters.
3. Prepare the insertion-only native body with `NativeTapeCache.prepare()`. Capture
   only that action's update events and manifest. Bind all local text references,
   deletion tags, parser synthesis and focus anchors to the resulting identities.
4. Certify the complete envelope through the document's real `checkLocal` boundary
   against its exact dependency closure. Append to `ActionStore`, commit native
   preparation, then publish one matching projection/address set. Do not expose a
   draft projection or partially bound action.
5. Return the action ID, group, exact edit footprint and stable selection/focus
   origins, with `applied` status. Storage acknowledgment is separate. Return no
   action/history entry for a handled command with no canonical change.

Commit or abort native preparation within that synchronous edit. A and then B
local calls are ordered by local publication; B sees A immediately even if neither
is persisted, sent or acknowledged. This is ordinary single-threaded mutation,
not the old one-outstanding-authored-action protocol. Never retain a prepared
native transaction while waiting for IO. Reject recursive edit calls explicitly;
do not introduce a network-dependent admission queue.

On a preappend failure, abort the native preparation, rebuild with a fresh native
client and leave canonical bytes, actor sequence, published heads and projection
unchanged. Reuse no unpublished native clocks. Once append succeeds, the action
cannot be rolled back as though it never happened. Persistence failure reports
unsaved state and uses the provider's retry path. If projection fails after append,
retain the action, expose stale/non-authorable status and rebuild publication before
another command. Never retry by authoring a replacement action under another ID.

A publication deferred by ingest work is not authorable until it is coherent.
Unrelated missing remote dependencies do not block an otherwise ready local past.
Recheck publication after a fork invalidates that past and rebuild the authoring
cache from the certified closure. Synchronization modes do not enter the compiler;
all remote routes remain provider-owned. `applied`, `persisted` and optional
`delivered` must keep their existing distinct meanings.

Keep reference full replay as the correctness oracle. MW-13 owns the production
append/suffix fast paths; this issue must expose exact touched origins and effects
for that work. A reference-backed implementation is not performance acceptance,
and full reconstruction per ordinary keystroke remains forbidden at release.

### Failure and compatibility boundaries

Keep old browser/canonical behavior available while the new headless path is
reviewed. Do not remove authority types, retire historical tests, change the wire
schema or add a dependency. Unsupported or ambiguous address translation declines
before append with a specific local result; it must not choose the first wrapper,
restore text to a prior owner, or invent a recovery node.

A valid published command may lose constituent intentions after merge. Report local
application without promising remote semantic acceptance. Deletion-wins and the
approved constructor rule remain authoritative. If a command exposes an uncovered
shared-contract ambiguity, retain a minimal native regression and seek the owner's
review before changing the contract or expected corpus result.

## Non-goals

- Storage journals, provider mode policy, checkpoint formats or native synchronization.
- MW-10 navigation stacks, scoped undo selection or browser focus restoration.
- Browser/IME/clipboard cutover, physical device acceptance or authority retirement.
- New genesis/bootstrap policy, schema-2 saved-document conversion or canonical pruning.
- Incremental reducer redesign, performance-budget acceptance or new effect types.

## Verification

Extend the existing headless command tests with a schema-3 runner. Keep legacy
command parity checks for serial observable behavior, without treating legacy
identity accidents as distributed semantics. Test real commands rather than only
compiler helpers. Record executable names for these obligations:

1. Enter at start/middle/end, both retained sides, selected ranges, list/task Enter,
   section Enter, literal code Enter and structural line break. Verify node and
   native identity, empty cells and exported Markdown after every step.
2. Backspace joins across tapes, inside quotes and lists, section/code demotion,
   first-root-item promotion and child lifting. Type into retained source lineage
   after join; confirm that it follows its flow without duplication or deletion.
3. Indent/outdent, wrap/unwrap, selected deletion and moves preserve scope and
   native identity. Cover adjacent normalized wrappers, both wrapper boundaries,
   inherited child deletion, causal move-out and concurrent delete/transfer.
4. Markdown paste, plain literal input, block replacement and empty-target rules
   retain existing markers/tasks and scope. Reject ambiguous replacements without
   facts. Include clipboard-authored empty paragraphs and post-deletion empty roots.
5. Parser promotion and demotion preserve repeated text, exact masks, fences,
   checkboxes and fresh synthesis. Run losing conversion conflicts, same-action
   type/convert/transfer, surrogate pairs and combining sequences.
6. Multi-operation drafts include type→split→type, transfer→resize→transfer,
   same-node moves, same-gap insertions with both affinities and unpublished text
   removal. Check source pieces, final cell owners and fresh reconstruction.
7. Three independent common-genesis replicas execute command sequences during a
   partition and merge duplicate/reordered original updates. Compare raw placement,
   flow ancestry, cell assignments, slots, visible identity multiset, legal tree
   and Markdown once ready sets match. Reopen from canonical bytes after each
   schedule checkpoint; projection/serialization reads author no facts.
8. Repeat with outbound-only A and an isolated control. A performs at least 100
   consecutive mixed type/Enter/Backspace/indent/paste edits while persistence and
   delivery acknowledgments are held. B concurrently edits/deletes. A receives no
   B facts until enabled; later catch-up converges without replacing IDs or local
   chains. Exercise disconnected and inbound-only local editing as well.
9. Inject failure before native preparation, during binding/certification, at
   append, after append during projection and during provider persistence. Assert
   preappend atomicity, fresh native clients after abort, postappend retention,
   recoverable stale publication and no duplicate edit on persistence retry.
10. Apply real MW-05 group controls to compiler-produced actions: undo/redo split
    after peer typing, join, transfer, deletion, paste and text-plus-promotion.
    Compare native identities and footprints. These tests exercise retraction
    compatibility; MW-10 still owns navigation, scope classification and grouping.

Extend the existing seeded scheduler with these command choices from each peer's
current projected state. Include deletion and multi-operation commands. Record
seeds, executed operations, bounds and replay commands; reduce discovered failures
and commit them as regressions. Retain the frozen MW-08 corpus and constructor
controls unchanged. Test-local trace aliases must not enter production authoring.

After implementation run `npm run build`, `npm run test`, `npm run lint`,
`npm run check:boundaries`, both unused-code scripts and `npm run format:check`.
Run browser tests if shared command adapters change browser-observable behavior;
these do not authorize browser cutover. Do not wait for CI before Request Review.
This proposal itself requires source/path and formatting checks, not runtime tests.

## Suggested implementation shape

1. Introduce the explicit command draft operations and legacy adapters. Route the
   existing helper/command branches through them and preserve serial behavior.
2. Add origin-backed draft pieces and effect lowering under `multiwriter/authoring/`.
   Cover split/join/delete/lift distinctions before adding broad command support.
3. Add local envelope/native preparation and publication against the reference
   composition. Verify sequential authoring with held IO and failure injection.
4. Complete parser/paste/address lowering and command parity. Add distributed
   conflicts, control compatibility, reconstruction and seeded command schedules.
5. Document exposed footprints and remaining MW-10/MW-13/MW-14 obligations. Open a
   conventional-title implementation PR against `yjs`, reference grain/90, attach
   it as `pr`, then request implementation review.

## Success criteria

- Existing headless Enter, Backspace, indent, paste and type publish schema-3 actions.
- Join, split, transfer, lifting and deletion remain observably distinct under merge.
- Consecutive local actions require no remote acceptance, persistence or delivery ACK.
- Native identities, empty homes, constructor coverage and deletion-wins survive replay.
- Command outcomes, stable origins and exact footprints are usable by downstream history.
- The command parity and three-replica partition matrix pass without changing frozen contracts.
- Tests and limitations explicitly preserve the later history, performance and browser gates.
