# Proposal: Compile local semantic commands into multiwriter actions

- **Issue:** grain/90 (MW-09).
- **Status:** v1 approved in grain/90 comment `cmt_3vzrzLicPnEhq3j8`; v3 approved by Douglas in grain/90 comment `cmt_xGRGQJOVnsUL4mCm` for PR #87 at `4fed8f5`. The approval removes nonexistent legacy-reader deployment and rollback concerns as blockers; canonical retention, encoding, certification and independent replay remain required.
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

| Current code                                         | Reusable behavior                                                                   | Gap for MW-09                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/editing/context.ts`, `outcomes.ts`, `commands/` | Scoped commands, selections, command precedence and explicit outcomes               | `TreeDraft` does not distinguish destructive removal from join or unwrap  |
| `src/editing/prepare-edit.ts`                        | Captures selection and checks inapplicable commands                                 | Calls `CanonicalWriter.prepareCommand()` and returns authority requests   |
| `src/markdown/canonical/plan/draft.ts`               | Draft-local text pieces and move-only fragments                                     | Emits schema-2 operations and read guards                                 |
| `src/markdown/semantic/construction-tree.ts`         | Plain parser tree and semantic draft ergonomics                                     | Does not retain native origin pieces                                      |
| `src/markdown/multiwriter/reference/document.ts`     | Certification, provenance and atomic projection                                     | Deliberately leaves production authoring to its caller                    |
| `src/markdown/multiwriter/projection/addresses.ts`   | Exact selection ranges, caret origins, wrapper constituents and empty-root requests | Needs a command-side consumer                                             |
| `src/markdown/multiwriter/projection/parser-plan.ts` | Exact retained/consumed pieces and synthesis binding                                | Leaves structural lowering and publication to MW-09                       |
| `test/multiwriter/reference/author.ts`               | Demonstrates native preparation and envelope certification                          | Uses symbolic trace aliases, allocation roles and a test-only native plan |

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

| Local intent                        | Schema-3 lowering                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a placed inline              | Allocate node, flow, root run, birth occurrence and distinct private home tape; set initial presentation and allocate literal text once                  |
| Create a wrapper                    | Allocate immutable raw role and unambiguous birth occurrence; place via its authored slot                                                                |
| Type or replace selected characters | Map visible selected fragments to exact `DeleteText` ranges, then insert new identities with `InsertText`                                                |
| Enter split                         | Emit explicit `SplitFlow` with exact pre-effect `FlowBasis`, permanent cut, retained side and authored outer slot; selected text deletion stays separate |
| Backspace join                      | Emit `JoinFlow` with the source flow and destination seam; preserve source node, home and tape; carry child-lifting intent in the same action            |
| Explicit range transfer             | Emit `TransferRange` and a fresh placement run; retain the source's insertion location                                                                   |
| Indent, outdent or reorder          | Emit authored `MoveBlock` occurrences; inline moves assert standalone flow                                                                               |
| Unwrap or lift children             | Emit `LiftChildren` placements for observed children; leave the empty raw wrapper retained, with view cleanup supplied by pure normalization             |
| Explicit block deletion             | Expand selected view constituents and capture `DeleteSubtree` scopes from the author's actual ownership and causal heads                                 |
| Property/task change                | Emit `SetProperties`, independent of parser packet activity                                                                                              |
| Parser conversion                   | Prepare and bind an `Interpret` packet with exact masks, outputs and author-allocated synthesis; lower its required structural effects                   |

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

## V3 amendment: applicability and encoding of additional parser outputs

### Decision requested

The decision requested from the MW-06/shared-contract owner is approval of the
exact additive schema-3 policy below, including its byte-identity and incompatible
reader boundary. MW-06 is grain/87; the authoritative shared contract is grain/81.
Approval must be recorded on grain/90 by the responsible owner and identify this
proposal version. Neither v1 approval nor the v2 review grants that approval.
The inspected grain/87 and grain/81 records contain no approval of these fields.

This revision responds to grain/90 review `cmt_DfwJdV6Mco6zR46Y`. It replaces the
choice deferred in v2 with one concrete recommendation. All normative statements
in this amendment describe the proposed contract, pending that owner's approval.
Do not implement the fields, alter shared context, or claim the amendment is
resolved from this document alone. The approved CommandDraft, native planning,
publication, provider and command semantics remain in force.

### Motivation and observed boundary

One literal paragraph contains `first\n\n# second`. The parser plan produces a
paragraph containing `first` and a section containing `second`. The first inline
keeps the source identity. The second output needs a fresh inline/home, retained
text ownership, and section properties. If a peer concurrently interprets the
same source as code, the losing conversion's output behavior must be explicit.

`src/markdown/multiwriter/authoring/parser-boundary.test.ts` is an executable
native/store/projection probe. A candidate made from the existing `Interpret`,
`TransferRange`, and `SetProperties` effects certifies and projects the desired
serial result. B's independently certified source-code packet then wins. A's
mask retracts, while its transfer and second section properties remain active.
The merged result contains code `first\n\n` and a section whose literal content
is `# second`. Both independent documents agree. Convergence does not establish
that these are the intended conversion semantics.

The gap is in the shared contract, not native identity binding:

- `InterpretationPacket.properties` applies to its stable source only.
- `InterpretationPacket.wrappers` can activate only list, list-item, and quote roles.
  `validatePacket()` rejects an inline in that field.
- `InterpretationPacket.placements` controls block placements, not `TransferRange`
  ownership or another inline's presentation.
- `selectInterpretations()` applies ordinary `SetProperties` independently.
- `reduceOwnership()` applies ordinary split/transfer effects by group activity.
  It has no packet membership for those effects.
- `bindParserConversion()` returns all prepared outputs and leaves structural
  and property lowering to its caller. It does not provide that missing membership.

Single-inline heading, task, quote, and fence conversions do not need additional
inline properties or ownership. They remain within the approved implementation
scope. Synthesized text keeps the accepted MW-06 insertion-activity rule; this
amendment does not make a losing packet delete synthesized native characters.

### Exact proposed wire policy

Keep `protocolVersion: 3`, the original document/genesis IDs and Yjs 13.6.33.
Extend only `InterpretationPacket`, with two optional logical fields:

```ts
readonly derivedInlineOutputs?: readonly NodeId[];
readonly effectOrdinals?: readonly number[];
```

The first field identifies additional inline births whose activation belongs to
the packet. The second identifies conversion-specific effects in the containing
action's original `effects` array. Neither field changes allocation order, resource
IDs, native bodies, effect ordinals or the packet's existing required fields.

| Input or operation                                                | Proposed rule                                                                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field absent on the wire                                          | Decode with the property absent. Semantic lookup uses an empty list without mutating the packet.                                                    |
| Field absent or `[]` in a new logical value passed to the encoder | Omit the key from canonical wire output. Do not materialize an empty key.                                                                           |
| Field present and nonempty on the wire                            | Decode and retain the exact list. The list must satisfy the ordering and membership rules below.                                                    |
| Field present as `[]`, `null` or another type on the wire         | Reject. Present-empty is a new noncanonical spelling, not an alias to rewrite.                                                                      |
| Encode a nonempty list                                            | Use the existing deterministic CBOR map/array and resource encodings. Preserve list order; reject invalid ordering instead of sorting the envelope. |
| Decode then re-encode an old canonical envelope                   | Produce exactly the original bytes. Do not add either key or change existing arrays.                                                                |
| Retain, transmit, checkpoint or replay                            | Preserve original encoded envelope bytes, including invalid variants. Do not decode/re-encode canonical storage as a migration.                     |

`derivedInlineOutputs` must be in strictly increasing allocation ordinal order.
All entries are nodes born in the same action, so this is a total order without
locale or actor ordering. `effectOrdinals` must be strictly increasing safe
nonnegative integers. Empty omission is field-local: a packet can contain either
nonempty field without the other. Existing wrapper-only packets need no new field.
Unknown fields remain errors; this is not a general permissive decoder.

The existing `record(fields, optional)` mechanism in
`src/markdown/multiwriter/actions/schema.ts` preserves absence. Its optional-field
support does not by itself implement nonempty-list or encoder-omission rules.
Those checks must be explicit at the packet codec boundary. The decoder must
never attach `[]` as an own property to an old decoded packet. Semantic accessors
may return empty lists; canonical encoders and retained payloads must not depend
on those accessors' default objects.

`actions/store.ts` compares retained envelope bytes to detect forks. Preserve that
rule. Adding an empty key to an existing action is a different payload; it must
still quarantine the identity and its descendants rather than silently replacing,
normalizing or deduplicating the variant. Repeated local publication and retries
must use the original envelope, action ID and encoded bytes.

### Reader, upgrade and rollback boundary

A capable reader admits both old envelopes with absent fields and valid new
nonempty membership under the original genesis. An offline pre-extension writer
can continue its old chain and deliver it later without expiry, rebasing, native
ID replacement or prefix rewriting. Its actions keep their original semantics;
membership is never inferred retroactively.

The pre-extension encoder and decoder reject either new key. In this checkout,
`decodeEnvelope()` reports an `EnvelopeDecodeError` with reason `reference` for
an unknown packet field, not a version error. `ActionStore` retains the bytes and
quarantines that action and dependent actions; it must not apply the envelope
with membership ignored. The unchanged old reader cannot certify or reproduce
the extended document. This proposal does not claim transparent mixed-reader
operation or that the old host automatically stops all further authoring.

Deploy capable readers before enabling nonempty membership authoring. An
incapable reader must not be used as a live editor of a document containing the
extension. This is a deployment boundary, not a negotiated capability, a new
shared metadata record or a promise to retrofit old binaries. Old-prefix writers
that have not received the extension remain valid offline authors; capable peers
must still admit their valid tails. Test those tails explicitly.

Before any extended action exists, reverting the implementation preserves the
old wire format. After an extended action is retained, rollback to an incapable
reader cannot preserve complete semantic editing for that document. Retain the
full original bytes and use a capable reader to reopen it. Do not strip fields,
remove actions, regenerate genesis, or roll back to an old checkpoint as a way
to resume the same document. Markdown export/import creates a separate document
and is not identity-preserving rollback. An owner who requires live old-reader
compatibility must reject this policy and request a different proposal; there is
no automatic protocol-revision fallback in this amendment.

### Exact membership and target rules

A packet's source keeps its current `properties` field. Every additional inline
output appears exactly once in `derivedInlineOutputs`, has raw role `inline`, and
is allocated by the containing action. It cannot equal the source, a wrapper,
a genesis node or a node from another action. An output cannot belong to two
packets, including two packets that convert the same source in one action.
Birth activation follows packet selection; independent content, children and
placements can preserve a scaffold under the existing creation-undo rules.

An ordinal belongs to at most one packet in its action. It must name an effect
strictly after the owning `Interpret`. This makes the source mask's pre-effect
traversal available before conversion-specific ownership changes. Membership
can refer forward to those effects, but cannot reference another action. Source
text insertion can precede `Interpret`; no text insertion is a packet member.
The compiler must place the packet before its member effects and retain their
original semantic order. Do not relocate an existing retained effect.

Only these effect/target combinations are permitted:

| Member effect                                  | Permitted targets and values                                                                                                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SplitFlow`                                    | `newNode` is one of this packet's derived inline outputs. Its cut source is the packet source or an earlier derived output of the same packet. Validate the exact pre-effect basis and fresh home using the existing split rules.                                           |
| `TransferRange`                                | The destination run belongs to the packet source or a derived inline output. Captured cells come from that packet's source/output flow traversal at the member's exact author prefix. Validate retained ranges, order and destination through real ownership certification. |
| `SetProperties` on a derived inline output     | A nonempty subset of `presentation`, `marker`, `info`. `checked` is forbidden, including `null`. Source presentation belongs in `packet.properties`.                                                                                                                        |
| `SetProperties` on a node in `packet.wrappers` | A nonempty subset of `marker` for a list or quote, or `marker` and `checked` for a list-item. `presentation` and `info` are forbidden. Wrapper identities remain author-allocated under the existing rule.                                                                  |

No other member type is permitted. In particular, reject `InsertText`,
`DeleteText`, `DeleteSubtree`, `JoinFlow`, `MoveBlock`, `LiftChildren`, `Interpret`
and `SetGroupActive`. Packet placements already carry conversion placement
intent; they are not independent `MoveBlock` members. A future parser lowering
that needs another effect kind must expose that boundary before expanding this
whitelist.

Parser-authored marker/checked initialization for a fresh wrapper is a member
`SetProperties`. An independent task checkbox edit is an ordinary nonmember
`SetProperties`, even when another conversion is in the same action. The compiler
must split mixed intent into separate effects; one effect cannot combine a
packet-owned marker initialization with an independent task toggle. An ordinary
independent transfer likewise stays outside `effectOrdinals`. Membership is
explicit, not inferred from target identity, adjacency, allocation order, action
ID or final ownership. Existing envelopes with absent membership keep their
current independent property behavior.

### Applicability, certification and retained facts

Select the winning active packet for each stable source using the existing
semantic order. Resolve membership before replay. A member is effective exactly
when its action/group is active and its owning packet is selected. An ordinary
nonmember retains existing activity. Source presentation, additional output
activation and properties, wrappers, packet placements, masks and member
ownership changes therefore share one applicability decision. Independent
property edits retain their own order and can override packet initialization.

Pass the combined effect eligibility to ownership/layout replay, property
selection and destination/scaffold requirements. Updating only the existing
`interpretationEligible` callback is insufficient: that callback currently
controls `Interpret` placements. The shared activity/history model must still
retain independent effects and the complete action. Replay consumes every
original ordinal, including an inactive member, without filtering or renumbering
`action.effects`. Retraction/reactivation preserves original priority.

Allocation, native insertion manifests, permanent markers, private homes and
birth-causal constructor coverage are retained regardless of packet selection.
In particular, a member `SplitFlow` still contributes its approved retained
capture plus private home to birth coverage when its ownership effect is
inactive. Ordinary creation plus transfer still covers only the private home.
Do not derive either coverage from the merged owner map. Synthesis keeps the
accepted insertion-activity rule; losing a packet does not delete native text.
A preserved scaffold gets default paragraph presentation plus effective
independent edits, rather than the losing packet's heading/code properties.
Deletion-wins and existing scaffold availability rules remain unchanged.

Validate membership structure and all target roles before selection can hide an
invalid member. `createProjectionAuthorValidator()` must compose the MW-04
validator against genesis plus the exact candidate dependency closure and native
body. Validate every candidate packet's members at their original pre-effect
prefix, including a packet superseded later in that action. Use a candidate
validation replay in which that packet's own intentions are checked; do not let
the final winner bypass an invalid split basis, range, destination or property.
Unrelated concurrent state is not an author-certification input.

Reject duplicate, unsorted, out-of-range, pre-packet or cross-packet ordinal
membership; invalid output births; source/output collisions; wrong property keys
or roles; and foreign ownership ranges. Bad membership rejects the complete
candidate before local append, or quarantines it on remote ingest. Never drop
just the bad field/member. Native preparation aborts through the approved
compiler failure path. Existing packet/source/synthesis validation still applies.

### Suggested implementation ownership

After explicit owner approval, change the shared contract in this order:

1. MW-01/shared-contract code: add the optional fields in `contracts.ts` and packet
   codec rules in `actions/schema.ts`. Keep all existing canonical byte fixtures.
2. MW-06 with MW-04 integration: extend `projection/interpretation.ts`,
   `projection/project.ts` and `projection/validation.ts` with one membership
   decision used for effects, output births, properties and author certification.
   Audit visibility destination requirements and split suppression too.
   `reference/provenance.ts` must preserve retained constructor coverage.
3. MW-09: bind `PreparedConversion.outputs` and explicit command intent to these
   fields in `authoring/`. Complete multi-inline and same-action origin mapping.
4. Run compatibility acceptance and the real-command matrix below before
   requesting implementation review. Keep the existing browser path active.

These are shared-contract changes, not private compiler fields. The amendment
does not authorize storage ownership changes, new provider modes, a capability
negotiation service, new effect types, new dependencies or frozen-corpus edits.

### Alternatives

- **Recommended: explicit shared membership.** This preserves atomic conversion
  applicability and permits type/convert/independent-transfer within one action.
  It requires MW-06/shared-schema approval and corresponding ingest/replay tests.
- **Accept persistent structural conversion effects.** Keep today's schema and
  explicitly accept the probe's merged result, including the second heading and
  transferred text after its packet loses. This needs an authoritative conflict
  decision and revised acceptance examples. The implementation must not assume it.
- **Limit MW-09 to single-inline promotion.** Keep multi-inline literal input
  literal and decline explicit unsupported conversion without facts. This is the
  current safe draft behavior, but it does not satisfy the complete approved
  parser/command matrix. Accepting it as completion would change issue scope.

### Fallback and current implementation boundary

The draft implementation returns a specific `unsupported-conversion` decline
for explicit multi-inline conversion. Optional promotion keeps its literal edit
and omits the complete conversion. Planning consumes no native clocks; the rejected
conversion allocates no canonical facts. Operational errors and reducer invariant
failures propagate and do not trigger literal fallback.

The implementation remains a draft. Parser conversion is terminal within an edit;
full same-action type/convert/transfer mapping, discarded-buffer elimination across structural intents, multi-inline lowering, the complete
wrapper/scope matrix, and the full approved verification remain completion work.
The parser-facing TreeDraft and shared wire/reducer semantics remain unchanged.
No browser cutover, navigation stack, storage ownership, or performance acceptance
is claimed. Reference full replay is used; the release fast path remains MW-13 work.

### Compatibility acceptance after approval

Implement executable acceptance in `actions/codec.test.ts`, `actions/store.test.ts`
and `authoring/parser-membership.test.ts` (new). These tests must use the production
codec, real author certification and full reference projection, not a callback
that only disables ownership. Until that implementation exists, these are required
acceptance tests, not passing evidence:

1. **Old bytes:** freeze exact pre-extension packet bytes from `3cdb6bd` plus the
   existing codec golden. Assert absent own properties after decode and exact
   byte equality after re-encode. Exercise each logical field as `[]` at encode
   and assert the same bytes. Reject present-empty wire keys. Reopen old complete
   canonical bytes and verify unchanged actions, native IDs and projection.
2. **New bytes:** golden-round-trip a real paragraph-plus-heading conversion with
   both nonempty fields and a wrapper-only conversion with `effectOrdinals` only.
   Certify and project them. Assert stable canonical bytes, original ordinals,
   retained allocations and complete birth coverage. Reject every invalid
   membership/target class listed above before local append and on remote ingest.
3. **Incompatible reader:** run a frozen pre-extension codec/store control against
   the new encoded envelope. Assert whole-envelope rejection, retained original
   bytes, quarantined descendants and no partial native/semantic publication.
   Do not assert a version diagnostic the old codec does not emit. Keep that
   old-reader control independent of the newly changed codec.
4. **Mixed reopen:** build an old prefix, append a new member-bearing action,
   checkpoint/close and reopen under the same genesis in a capable reader. Then
   deliver a valid old writer's offline tail based only on the old prefix. Try
   both receipt orders, duplicates and deferred dependencies. Compare complete
   retained envelope payloads, raw owners, placements, native identities, legal
   tree and Markdown across three independent replicas and cold reconstruction.
5. **No false fork:** republish the exact old and new payloads through append,
   duplicate Yjs delivery, refresh, close/reopen and persistence retry. Assert one
   variant per ID, a ready descendant and identical original envelope bytes.
   Also inject the altered old payload with an empty key: retain both variants
   and assert fork quarantine. The fix must not weaken actual fork detection.

Use `compareBytes(actual, expected) === 0` for large canonical/native byte
comparisons. Preserve the frozen MW-08 corpus and native boundary probe. The
attached `review-v2-probes` remains evidence for the current behavior and its
compatibility hazard; it does not test the proposed new codec or membership.

### Command and conflict acceptance after approval

Through real parser commands, cover paragraph-plus-heading, multiple list items,
fenced output, repeated text, fresh synthesis, parser-authored wrapper task state,
and independent task edits. Check serial output, both merge orders, duplicate
delivery, conversion undo/redo and cold replay. When a competing source-code
packet wins, retained source text stays with the winning source flow; the losing
packet contributes no heading properties or ownership transfer. An otherwise
unneeded additional output is suppressed. Independent peer content, children or
placements may preserve its scaffold with ordinary effective properties.

Exercise an independent same-action transfer and task toggle beside member
effects; neither retracts with the packet. Test peer typing in an additional
output before its conversion loses, same-action type/convert/transfer, discarded
buffers across structural intents, concurrent delete/transfer and a member split
whose constructor coverage outlives applicability. Compare raw ownership,
packet selection, retained native identities, legal tree and Markdown. Run the
full approved wrapper/scope and seeded scheduler/replay matrix from v1.

### Success criteria for this decision

- The MW-06/shared-contract owner explicitly approves this version's wire,
  applicability and incompatible-reader/rollback boundary on grain/90.
- The production codec preserves old canonical bytes and implements the exact
  nonempty/absence policy without weakening fork detection.
- Real certification and projection pass all five compatibility controls and
  the command/merge/retraction/scaffold matrix above.
- The compiler completes the v1 obligations before MW-09 implementation review.

This revision proposes an exact policy; it does not supply owner agreement or
production membership acceptance. If the owner rejects it, keep the current
safe fallback and revise the proposal before implementation. MW-10 history,
MW-13 performance and browser/mobile/release gates remain separate.
