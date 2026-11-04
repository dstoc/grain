# Proposal: Per-instance history and selection grouping

- **Issue:** grain/91 (MW-10).
- **Status:** Proposed v1; implementation requires proposal review.
- **Authority:** grain/81 proposal v2, especially §§7.4, 9.1–9.3, 10.2 and 13–14. MW-05 owns the retraction algebra. This proposal supplies the local navigation policy and its MW-09 integration.
- **Inspected baseline:** `yjs` at `415363a4e85549a33eee3010d69e55ce6161002d`. Branch and eventual implementation PR target: `yjs`. Yjs remains exactly 13.6.33.

## Motivation

A and B open one genesis in separate instances associated with the same account.
A types a Markdown prefix and promotes it to a list. B independently types in
that list. A undoes while outbound-only. Its control retracts its own input and
promotion together. B's independent input remains governed by the existing
visibility and scaffold rules. B receives A's control without adding it to B's
undo stack or clearing B's redo. After A enables receiving, its existing history
still works against the merged document.

This requires two kinds of state with different lifetimes: replicated immutable
group controls, and bounded session-local navigation and selection metadata.

## Problem statement

`src/markdown/multiwriter/authoring/editor.ts` already supplies a fresh actor and
native client, local action sequencing, synchronous publication, caller-selected
`AuthorSession` group IDs, `StableSelection`, and exact allocation/effect
footprints. It does not choose groups or implement undo/redo. Its
`RetainedEditError` reports an action that reached canonical storage even when
an observer or publication failed afterward.

`src/markdown/multiwriter/visibility/activity.ts` already requires owner-only
`SetGroupActive` chains, complete nonempty group membership, dependency closure,
and sealing at first control. It retracts effects without deleting allocations.
It deliberately has no local navigation cursor.

`test/multiwriter/commands/control.ts` manually manufactures controls for MW-09
tests. `test/multiwriter/reference/factory.ts` tracks symbolic undo/redo arrays
for fixed traces. Neither provides production session ownership, selection
restoration, grouping or exact-footprint scope classification.

`src/editing/browser/session-runner.ts` demonstrates one-second typing groups
and explicit boundaries, but calls the schema-2 `CanonicalWriter`. Its history
implementation depends on a different storage/history model. Reusing that
coordinator would import the authority and native undo assumptions MW-10 removes.

`src/markdown/multiwriter/projection/addresses.ts` captures native `TextPoint`s
and checks lineage availability. It does not resolve a complete saved selection
to the current normalized view after transfer, masking, deletion or undo.

## Proposal

### Session ownership and public entry points

Add a headless coordinator under `src/markdown/multiwriter/history/`. Each
`LocalEditor` owns one coordinator and admits a default session plus optional
explicit local sessions. A session belongs to that editor's actor and document;
account identity is irrelevant. Duplicate admission of a live local session
returns the same stack. Separate editors never share navigation metadata.

Provide a session facade with `edit`, `editEmptyRoot`, `sealGroup`, `undo`,
`redo`, `status`, and explicit `reset` operations. `status` reports undo/redo
availability, the configured horizon, and whether navigation was reset. The
first callers are headless command replicas opened from detached copies of one
exact genesis. Browser mounting remains MW-14 work.

The facade chooses group counters and calls the existing MW-09 compiler. Keep
low-level `LocalEditor.edit(AuthorSession, ...)` available for existing callers,
but document that it does not populate managed navigation. Reject reuse of a
managed session identity through that low-level route before append. This keeps
the facade's group membership complete without inferring ownership from received
updates. Neither receiving a self-echo nor replaying a journal registers edits.

Use a shared private writer primitive in `LocalEditor` for edit and control
publication. It owns actor sequence, Lamport time, current heads, certification,
append detection and retained-failure recovery. Do not expose a general API for
publishing caller-built envelopes or copy the test helper's sequencer into a
second production writer.

### Groups and boundaries

Default commands, paste, replacement and composition commits form isolated
groups. Literal typing can opt into coalescing. Coalesce only within one session,
one stable inline lineage, contiguous collapsed selection, and at most 1,000 ms
between successful inputs. Inject the clock for deterministic tests; wall time
never enters replicated ordering.

Seal on explicit selection movement, focus/host changes, structural commands,
undo/redo, reset, and the caller's `sealGroup()`. Compare stable points rather
than projection-local handles. A remote publication can close the open typing
group if continuity is lost; it never changes either navigation stack or clears
redo. Transport disconnect, reconnect and mode changes alone preserve history.

Use MW-09's `{ promote }` path to keep literal input and parser promotion in one
action. Explicit `interpretMarkdown()` composition likewise stays in its command
group. A successful promotion seals the typing group after that action so the
next input starts a new group. If optional promotion declines, retain the literal
input with its ordinary typing policy. An explicit declined conversion, handled
no-op, invalid range or inapplicable command creates no history entry and does
not clear redo. A group can contain several already-published typing actions;
undo seals it before selecting its complete action list.

Store each group's ordered action IDs, exact footprint, earliest before-selection,
latest after-selection and last published control ID. Never add controls to a
navigation group. Clone retained metadata so a caller cannot mutate it.

### Control publication and stack movement

Unscoped undo selects the newest group on that session's undo stack. It must not
search for an older group merely because the selected group no longer changes
visible output. Redo uses the newest redo entry. A new applied local user edit
clears only its session's redo metadata; it does not reactivate abandoned groups.

Publish one ordinary certified envelope containing only `SetGroupActive`:

- Target the complete sealed group's original action IDs.
- Use `active: false` for undo and `true` for redo.
- Name the last retained control in `previousControl`, or null initially.
- Observe the target actions, previous control, current publication heads and
  preceding local action, with duplicate dependencies removed.
- Allocate no resources or native insertion bodies. Use a fresh envelope group
  ID in the owning session that never becomes a navigation entry.

Advance the cursor exactly once when the exact envelope is retained. Before
append, failure leaves stacks and canonical state unchanged. If append succeeded
but refresh or an observer failed, record the control ID and cursor movement,
return a retained-publication error, and require refresh before more work. Do
not append the same undo again on retry. Apply the same registration boundary
to managed edits: a retained edit enters its group and clears its own redo once,
even if ordinary `LocalEditResult` construction did not complete. Stage its
footprint and before-selection before append; finish its after-selection after
successful refresh. Recovery must not replay the semantic command.

Return explicit outcomes for empty history, blocked scope, applied control and
retained publication failure. Report the selected group even when its visible
effect is absent. Selection unavailability is separate from control success.
A stale/unavailable publication blocks navigation before append; capacity and
operational failures propagate rather than silently choosing another group.

### Scoped navigation from exact footprints

Accept an optional current projection scope address. Validate it against the
current publication before selecting a group. A normalized wrapper scope uses
all of its constituent origins and projected descendants. An unavailable scope
returns `invalid-scope` without publishing or moving a cursor.

Classify each group's retained footprint as inside, outside or mixed using the
current ownership, retained raw placement and normalized origin mappings:

| Footprint component | Scope evidence |
| --- | --- |
| Insert/delete text and interpretation masks/synthesis | Exact native ID ranges, partitioned at current ownership boundaries |
| Split/transfer | Exact captured intervals, permanent empty cells, and structural source/destination endpoints |
| Join | Source flow lineage, destination slot, and lifted children |
| Node birth, move, property update or wrapper placement | Affected raw node and relevant retained source/destination edges |
| Subtree deletion | Recorded observed nodes, owned intervals and joined flows |
| Interpretation | Source, output nodes, wrapper/placement intentions and packet-owned effects |

Ignore infrastructure-only allocations when they add no semantic footprint.
Do not classify all characters on a tape as one target. Two disjoint ranges of
one tape can have different current owners. Do not drop hidden or inactive
footprints: resolve their retained identities and placement context, including
empty slots, so redo and deletion groups remain classifiable. A transfer or move
that spans a scope boundary is mixed even if only one endpoint is visible.

Scoped undo/redo may pass wholly outside groups, leaving those entries in place.
The first inside group is selectable. The first mixed group blocks navigation;
never split its action list or scan past it. If retained evidence cannot establish
containment, block with an unresolved-footprint reason rather than treating it
as outside. Successful navigation removes only the chosen entry and appends it
to the opposite stack. A wholly inside no-effect group still consumes one step.

### Selection restoration

Resolve a group's before-selection after undo and after-selection after redo
against the newly published view. Preserve native character neighbors, run/marker
origins, affinities, anchor/focus direction and ordered block constituents.
Reuse `StableSelection` and extend it only where block endpoint or empty-root
intent cannot currently be represented. Projection-local `construction:*`
handles and numeric pre-edit offsets are never saved as durable anchors.

Add a pure selection resolver beside the existing projection address helpers.
Follow a retained text point's current effective flow and visible fragment
mapping. When its native neighbor is hidden, use the nearest visible boundary
in that same retained lineage according to affinity, with scalar-safe UTF-16
offsets. Do not redirect a deleted source to an unrelated replacement node or
search by matching text. If the lineage is unavailable, return unavailable.

Resolve block selections through their saved constituent addresses and directional
endpoints. Restore the complete range only when those endpoints and constituents
remain available in the requested host scope. Otherwise return an available saved
focus as a collapsed caret; if it too is unavailable, return unavailable. When
the saved selection explicitly names the empty-root caret, restore it only while
that view exists. Resolution allocates no paragraph or shared marker.

Return a restoration request with the publication version and session identity.
The headless caller can inspect resolved node origins and offsets. The later
browser adapter must revalidate its active host/session and publication after
render waits before applying native focus. A remote update does not itself steal
focus. MW-10 tests the pure resolution contract; mounted DOM and physical IME
acceptance remain later gates.

### Bounded navigation and lifetime

Use `DEFAULT_HISTORY_LIMIT` (500) as a per-session bound on retained navigable
groups across undo and redo together. Moving a group between stacks does not
consume additional capacity. On a new applied edit, clear that session's redo
and evict its oldest undo entries until within the limit. Allow a nonnegative
host-configured limit, including zero; changing it evicts oldest group metadata
by original local group order. Never reuse an evicted group counter.

Eviction and explicit reset discard only local group/selection metadata. They
must not append compensating controls, delete action-store records, run native
GC, alter another session, or change the native ID set. A process restart opens
a fresh actor/session and explicitly reports reset navigation. Restore persisted
actions and controls through existing bootstrap/provider paths, then start with
empty stacks. Do not reconstruct the old cursor from remote envelopes.

Provider mode changes, disconnection, cache disposal and lossless checkpoint
consolidation keep the live session coordinator. Provider persistence errors
remain unsaved status, not reasons to roll back history. Use existing provider
receive/publication routes so inbound-only and disconnected behavior remains
host policy and outbound-only controls need no reverse acknowledgment.

## Non-goals

- No changes to the frozen control encoding, MW-05 retraction/scaffold algebra,
  deletion-wins, insertion identity or placement priority.
- No native `Y.UndoManager`, global account history, durable interactive stack,
  cross-process session adoption, authority or branch replacement.
- No canonical pruning, replica expiration, dependency upgrade or new storage.
- No browser cutover or MW-13 performance claim. The reference path remains the
  correctness implementation; mounted history integration belongs to MW-14/16.

## Suggested implementation shape

1. Extract the private local append/sequence boundary and add managed session
   ownership with retained-failure registration. Preserve low-level MW-09 tests.
2. Add local groups, bounded stacks, control publication and deterministic grouping
   tests using real `LocalEditor` commands and `openReferenceDocument()`.
3. Add exact-footprint scope classification and pure selection resolution. Cover
   normalized wrappers, split/join/transfer, inactive content and empty-root cases.
4. Extend independent command replicas with the managed facade and provider-backed
   delivery. Retain the fixed reference corpus as an independent algebra oracle;
   its symbolic stack bookkeeping alone does not establish MW-10 acceptance.
5. Document the managed API, reset signal and retained-error recovery. Update the
   test compatibility inventory and analysis entries as required by new modules.

## Verification

Use actual commands, retained envelopes and independent native caches. Observe
Markdown, raw ownership/placement, visible native IDs, action readiness, local
stack contents and resolved selections. Compare equal ready sets with cold replay;
do not demand equal projections during asymmetric delivery.

- Two independent instances for the same account, plus two explicit sessions in
  one editor: isolate stacks, typing groups, controls, limits and redo clearing.
- Text plus heading/list/task/code promotion: one undo retracts the complete
  group; redo restores original native identities. Include explicit parser
  composition and invalid optional promotion retaining literal input.
- Selection replacement, paste, Enter split, Backspace join, indent/outdent,
  block deletion and task edits through real commands; inspect output and
  before/after directional text/block selections through undo/redo.
- Peer insertion after a split, peer child under an undone wrapper, two delete
  tags, and redo of an older move after a newer peer move. A no-effect newest
  undo consumes that group and never chooses an older group.
- Same tape with ranges in different scopes, hidden text, empty split cells,
  cross-scope move/transfer/join, merged wrappers and deletion footprints. Verify
  outside skipping, mixed blocking and unchanged stacks/bytes on rejection.
- Remote prepend, transfer, join, syntax masking, deleted anchors, surrogate
  pairs and backward block ranges. Resolve by identities; verify unavailable
  fallback without extra actions or synthesized canonical content.
- Three common-genesis replicas with partitions, duplicate/reordered delivery,
  strict A→B publication and a control received before its targets. Use MW-11
  providers, not direct receive bypasses. Verify local controls work outbound-only,
  remote edits/controls leave redo intact, and enabling receive preserves stacks.
- All four modes across disconnection/reconnection; restore an own journal and
  checkpoint into a fresh process with empty/reset stacks and retained controls.
- 501 actual local groups: retain only the newest 500 metadata entries. Compare
  complete actionDoc bytes and native identities before/after explicit eviction;
  round-trip through MW-18 lossless checkpoint and accept an old-prefix peer edit.
  Repeat limit changes and reset without affecting another session.
- Inject certification/preappend failures, observer throws after canonical append,
  refresh failures and persistence failures during edits and controls. Verify
  exact-once group/cursor registration and recovery without command repetition.
- Run focused history, authoring, projection, provider and checkpoint suites;
  `npm run test`, `npm run build`, `npm run lint`, `npm run format:check`,
  `npm run check:boundaries`, and both unused-code analyses. Report actual results
  and existing skips. Browser suites remain required when browser code changes.

## Success criteria

1. Each live session has independent bounded navigation. Remote input never enters
   it or clears redo; restart reports an explicit reset.
2. Undo/redo emits valid owner controls for whole sealed groups, preserves original
   effects/identities, and consumes a no-effect selected group exactly once.
3. Scoped navigation uses exact current ownership, skips outside groups and blocks
   mixed or unresolved groups without partial retraction.
4. Grouped input/promotion and stable directional selection restoration pass real
   command tests, with explicit unavailable-selection fallback.
5. One-way delivery, retained-failure recovery and 501-group checkpoint controls
   pass without canonical pruning or claims about later release/browser gates.
