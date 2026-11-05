# Proposal: Independent browser and headless replicas

- **Issue:** grain/95 (MW-14).
- **Status:** Proposed; runtime implementation requires proposal approval.
- **Authority:** grain/81 proposal v2, especially §§7.3–7.4, 9, 11 and 13–14.
- **Inspected baseline:** `yjs` at `ac7acc5507e53da4c53b2908f93fe5353eb1e66e`.
  Branch and implementation PR target: `yjs`. Keep Yjs pinned to 13.6.33.

## Motivation

A and B open the same document in two panes associated with one account. A
switches to outbound-only and keeps editing. B receives A's work and makes its
own changes. A continues to show its intentionally different view. Both panes
retain their own undo/redo. When A enables receiving, it merges B's actions into
its existing engine without replacing its branch or resetting its history.

The same sequence must work through headless semantic commands. Browser mounting
adds input, selection and rendering; it must not introduce a structural authority.

## Problem statement

`src/main.ts` mounts `md-canonical-editor`. Its two-pane experiment passes the
same `CanonicalWriter` to both panes. `src/editing/two-client-experiment.ts`
opens two schema-2 checkpoints and relays consecutive authority revisions. It
cannot represent independent offline edits or directional synchronization.

`src/editing/browser/session-runner.ts`, `selection-controller.ts` and
`composition-controller.ts` depend on schema-2 writer, node and anchor types.
`src/editing/browser/clipboard.ts` also takes canonical nodes for block copy.
Changing only the harness transport would leave those authority dependencies
in the editing path.

The schema-3 components already exist:

- `multiwriter/bootstrap/` creates exact genesis bytes, restores a replica's own
  journal and gates remote bundle tails through its provider.
- `multiwriter/authoring/` lowers existing semantic commands. `LocalEditor`
  creates an independent actor/native writer and exposes managed sessions.
- `multiwriter/history/` supplies grouping, retraction controls, scoped history
  and stable selection capture/resolution, including deletion fallback.
- `multiwriter/providers/` enforces all four modes and separates persistence
  from delivery. Its IndexedDB namespaces belong to individual replicas.
- `multiwriter/reference/document.ts` supplies an independently reconstructed
  document and publication. `projection/types.ts` carries normalized node
  origins, visible fragments and retained text boundaries.

`ReadonlyMarkdownNodeView` in `src/markdown/node-view.ts` is already the renderer
boundary. Schema-3 `ViewNode` does not yet provide that interface's stable local
IDs, parent/sibling links, render signals or versions. Browser controllers also
need current projection addresses rather than `construction:*` handles retained
across publications.

At this baseline, `LocalEditor.refresh()` and the reference publication still
rebuild native/projection state. MW-13 PR #88 is open. The authoritative §13
forbids a full reconstruction per ordinary production keystroke. Reference-backed
mounting can establish behavior while integration develops, but normal harness
cutover must use the accepted MW-13 path and demonstrate that input avoids full
rebuilds. A passing small browser fixture cannot waive that requirement.

## Proposal

### One engine per instance

Add a small DOM-free composition entry point under `multiwriter/`, with
`openReplica()` as its first host-facing operation. Compose `openBootstrap()`,
one `LocalEditor` and one managed `HistorySession`. Reuse descriptor conversion
from `bootstrap/descriptor.ts`; expose that existing conversion through the
bootstrap entry point if needed instead of rebuilding genesis fields in callers.

The facade owns opening, publication refresh and closing. Expose semantic edit,
undo/redo, history status, current publication, mode changes, provider status,
bundle capture/receive and persistence retry through those existing components.
It must not expose a second envelope compiler or introduce another wire format.
Use the `LocalEditor` actor as the authoring identity; bootstrap's session token
must not become a competing writer identity. Account identity remains host data.

The host installs exact genesis metadata before opening each independent journal.
It calls `createGenesis()` once per new document and distributes the same bytes.
Each replica receives a detached descriptor and its own persistence namespace.
Opening completes restoration/publication before authoring or peer attachment.
Metadata mismatch fails opening; Markdown export is never a replacement genesis
for an existing replica.

Every remote route enters the attached provider, through `receiveBundle()` for
bundles or provider ingress for action updates. No UI callback, self-echo,
catch-up or cross-tab path calls `ActionStore.applyUpdate()` directly. The
facade refreshes after local edits/controls and admitted receives, including
receives that emit no update event. It publishes the tree, addresses and native
view together. Deferred work retains the last complete view and blocks authoring
until a current authorable publication is available. Report blocked/capacity
status and allow the existing retry path; do not manufacture a new document.

Close stops input and peer callbacks before destroying the editor/document.
A persistence failure keeps the attachment and queued bytes available for retry.
Do not destroy the engine on failed close. Restart reopens the same replica's
durable namespace with a fresh authoring actor and empty navigation stacks, and
reports that history reset. Mode changes retain the existing editor/session.

### Renderer projection and browser mounting

Add a schema-3 renderer facade implementing `ReadonlyMarkdownNodeView` and a
`md-multiwriter-editor` browser adapter. Keep schema-2 editor APIs available to
their existing callers during this workstream; normal harness editing switches
to the schema-3 adapter after its tests pass. Schema-2 retirement is separate.

Cache renderer facades by normalized representative origin. Map current
constituents to their representative for selection/address lookup. Reconcile
parent/sibling links and presentation from complete publications. Give each
facade a stable local numeric renderer ID; never use preorder command handles as
renderer keys. Signal/version changes reflect actual rendered changes. Preserve
unaffected facade and inline DOM identity through distant edits. A representative
change follows current aliases and stable selection; it does not create shared
identity or mutate the semantic projection.

The empty-root caret is a local renderer affordance backed by the existing
`emptyRoot` address. Its first input uses `HistorySession.editEmptyRoot()`.
Rendering, selection resolution and remote deletion do not author a paragraph.

Extract only the browser controller dependencies required by the two concrete
adapters: current node/address lookup, stable selection capture/resolve,
publication notification, command dispatch and history navigation. Preserve the
existing input translator, renderer and recovery mechanisms. Replace canonical
`instanceof` checks in shared paths with adapter-owned lookup. Do not emulate
`CanonicalWriter`, authority epochs, receipts or native UndoManager history.

Resolve command handles from current origins immediately before dispatch.
Route all browser mutations through the managed session: text, Enter,
Shift+Enter, Backspace/Delete, indent/outdent, selected-block replacement,
Markdown paste, task toggles and parser promotion. Supply host and scope roots
separately. A declined/no-op command creates no history entry. Literal typing
uses MW-10 coalescing; composition, replacement and paste form isolated groups.
Seal on selection/focus/host changes. Keep input and successful promotion in one
group and preserve literal input if optional promotion declines.

An exact retained edit/control is already applied even if publication or an
observer subsequently throws. Show the error, refresh and recover selection
without rerunning that semantic command. Persistence retry never repeats input.
No remote acknowledgment is required before local command completion.

### Selection, composition and clipboard

Use MW-10 stable selections for native neighbors, caller affinity, directional
block endpoints and host origin. Resolve through current ownership after remote
transfers, joins, normalization and deletion. Mutation address validity remains
separate from caret fallback. Deletion fallback follows MW-10: nearest visible
inline within the initiating host, predecessor on a tie, or the existing local
empty-root caret. Unavailable/deleted host restoration stays unavailable.

Capture the initiating pane/session, publication identity and focus-intent guard
before asynchronous rendering. Wait for every ancestor block on the resolved
path, then revalidate after each await. If publication changed, resolve again;
if the user moved focus to another pane, Source or toolbar, cancel stale focus
work. Remote publication can remap an already focused selection but cannot focus
an inactive pane. Undo/redo buttons and mobile toolbar target the initiating
pane's managed history and honor scoped/nested-host ownership.

Retain composition's provisional DOM validation, UTF-16 checks, cancellation,
block-level remount and queued-input handoff. Capture stable endpoints at
composition start. A remote structural change or deletion invalidates the native
branch; recover it from the current publication before replay. Commit valid
composition data once, or cancel it when its mutation target is unavailable.
Never replay committed text and queued input twice. Preserve nested HostContext
and recheck pane/session/focus guards during recovery. Mode changes alone do not
cancel a valid composition or reset history.

Generalize block-copy traversal to the read-only projection/selection boundary
while preserving semantic roots, section spacing, task/list markers and code
text. Paste continues to use the existing semantic commands. Clipboard write
failure must leave a cut selection and document intact. Test native text/plain
paste separately from deterministic DataTransfer serialization. Do not use DOM
text as the canonical document or add caret sentinel characters to copied text.

### Harness transport and controls

Replace the normal harness's authority experiment with independent replicas
created from one exact genesis. A headless scheduler owns opaque outbound
messages for each directed link. Browser controls drive that scheduler; the
engine/provider owns admission. Offer automatic/manual delivery, deliver selected
message, reorder, duplicate, drop and retry/catch-up. Queue copies of original
update bytes; never synthesize subsets by re-encoding action arrays.

Use provider attachment and publication for sending. Check the sender's current
policy before handing an update to the scheduler and receiver policy at actual
delivery. Already handed-off messages can arrive after sending is disabled;
receive-disabled delivery is blocked before canonical ingress. The receiver does
not keep a hidden remote queue. Retrying asks the sender to publish current full
coverage, so a dropped prerequisite can be repaired without reverse traffic.
Initial common genesis is host-provided; subsequent remote action tails always
pass through provider ingress.

Expose per-pane mode, Undo, Redo, Restart, local edit/control counts and errors.
All four modes permit editing in this development harness, including inbound-only.
Explain that enabling sending publishes accumulated held work. Show applied and
persisted status separately; show delivered only when an explicit peer receipt
supports it. Successful queueing is not a receipt or a synchronization claim.
Describe receive-disabled views as intentional. Report equality only after
comparing the same retained/ready facts and complete projections; never infer it
from a local version counter. Use a local projection version, not a global revision.

Source/Serialize/Tree output must name the pane they represent. During a live
multiwriter experiment, Source is an export of the selected pane. Loading edited
source is an explicit new-experiment operation: create one new genesis and fresh
replicas/history. It never replaces a live branch as a synchronization operation.
Keep construction streaming in its existing parser preview path; switching to
editing creates genesis once from the completed construction tree/Markdown.
Changing display tabs does not reopen engines or reset history.

Use actual IndexedDB for browser persistence/restart and injected journals for
headless tests. Replica namespaces differ even for the same account/document.
Keep immutable genesis metadata separate from action updates, with metadata
installation complete before opening. Add no BroadcastChannel side door or
production network service. A three-replica headless harness covers strict A→B
and A→C delivery without requiring a third visible pane.

## Non-goals

- No new agent service, production hosting, authentication or account protocol.
- No wire/schema changes, authority coordinator or native text provider.
- No durable interactive undo cursor, recovery tree or resurrection of deleted
  content. Same-account replicas remain independent instances.
- No canonical pruning, replica expiration or new checkpoint algorithm. Use
  approved lossless persistence facilities when available.
- No claim that browser examples replace MW-08 correctness, MW-13 performance
  or later release acceptance. Physical mobile/IME evidence remains distinct
  from Chromium automation.

## Suggested implementation shape

1. Confirm MW-08 acceptance and merged MW-09/MW-10/MW-11 dependencies. The
   inspected `yjs` includes reference gate PR #83, authoring PR #87 and history
   PR #89. Record exact dependency SHAs at implementation. Coordinate changes
   to publication APIs with MW-13; do not absorb its optimization work. Before
   normal harness cutover, record the accepted incremental implementation and
   verify no full native/log reconstruction on ordinary input. Keep any earlier
   reference-backed mount explicitly experimental.
2. Add the DOM-free replica composition and controlled network tests first.
   Verify exact genesis, independent actors/history and persistence lifecycle.
3. Add renderer facades and browser dispatch, then move selection/composition
   dependencies behind the narrow adapter operations. Retain named schema-2
   compatibility cases while adding real schema-3 replacements.
4. Mount independent panes and directional/manual controls in `src/main.ts`.
   Port Source/export, toolbar and restart behavior. Remove authority delivery
   from the normal harness path.
5. Update `test/multiwriter/compatibility.ts` and the test crosswalk with named
   schema-3 replacements and deliberate historical cases. Document headless
   opening/editing/history/mode/restart usage against the same facade.

## Verification

Run these through the composed facade; browser cases use mounted schema-3
editors and real input where specified. Provider-only fixtures are supporting
evidence, not substitutes.

- Partition A/B from common genesis. Edit text and structure independently, then
  exchange duplicate/reordered messages and compare retained envelope variants,
  ready sets, raw placement/ownership, native identity multisets and Markdown.
  Compare with fresh full replay of each peer's exact held facts.
- Keep A outbound-only through text, split/join, move, conversion and undo/redo
  while B edits. Compare A with an isolated control, including heads, canonical
  bytes and private native state. Enable receiving without replacing A's
  engine/session; converge and continue A's existing undo/redo.
- Run the full 4×4 endpoint mode matrix headlessly. Repeat manual, catch-up,
  self-echo and cross-tab route admission; disable a direction while delivery
  waits. Inbound-only edits remain unsent until sending is enabled. Disconnected
  edits persist without either direction becoming active.
- Drop strict A→B traffic, then retry without reverse acknowledgments/state
  vectors. B obtains the full dependency closure. Let A learn B1 before switching
  outbound-only, then send an action depending on B1 to fresh C; retain B1.
- Give two mounted panes the same host account label but separate actors,
  journals and histories. A's undo retracts only A's effects; B's redo survives
  remote input/controls. Deliver a control before its target and resolve normally.
- B deletes a selected block while stale A types, splits or pastes there. B
  suppresses covered content without a recovery tree. After catch-up A resolves
  the documented caret fallback and cannot mutate the deleted address. Include
  transferred birth content, surviving peer children, two tagged text deletes,
  partial selection loss and empty-root concurrent input.
- Port trusted typing/Enter/Shift+Enter, Backspace joins, list/task edits,
  indent/outdent, scoped selection/replacement, clipboard and toolbar cases.
  Assert visible output, native selection direction, continued typing and
  undo/redo in each pane. Test text/code trailing LF and Unicode boundaries.
- Deliver remote edits during composition before commit and during recovery.
  Cover cancellation, valid commit, deleted target, nested host, queued input
  exactly once and focus changes to the other pane/Source/toolbar during awaits.
  Use CDP IME preedit/commit as desktop evidence; list physical IME gaps.
- Assert stable unaffected renderer/DOM identities and current selection after
  remote prepend, transfer and normalized wrapper changes. Remote updates never
  steal focus. Poll final caret geometry at desktop and 390×667/390×844 bounds.
- Restart each pane after local persistence and admitted no-event/mixed outer
  updates. Preserve exact genesis, unresolved carrier bytes, old identities and
  controls; explicitly reset only restarted navigation. Inject open/write/close
  failure, retained observer failure and deferred publication. Retry without
  losing queued bytes, duplicating actions or replacing the other pane.
- Run focused replica/browser suites, `npm run test`, `npm run test:browser`,
  `npm run build`, `npm run build:web`, `npm run lint`, `npm run format:check`,
  `npm run check:boundaries` and both unused-code analyses. Report actual results
  and source skips. Do not replace combined algorithm or release gates with
  browser/provider pass counts.

## Success criteria

1. Normal browser panes and headless callers use separate common-genesis
   engines, with no shared writer or authority acceptance path.
2. All four modes, manual delivery and strict one-way repair pass; intentional
   asymmetry is visible and never labeled globally synchronized.
3. Independent same-account history survives mode changes and remote work;
   restart preserves canonical data and explicitly resets local navigation.
4. Mounted focus, composition, clipboard, scoped commands and deletion behavior
   pass named compatibility cases using stable native identities.
5. Exact-fact cold replay and failure/retry controls pass without canonical
   pruning, duplicate input or new hosting/dependency commitments.
