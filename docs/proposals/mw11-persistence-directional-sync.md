# Proposal: Persist actionDoc and enforce directional transport

**Status:** Proposed for grain/92; implementation has not started.

**Authority:** The proposal attached to grain/81, version 1, especially §§3,
4.3, 9.2–9.3, 10 and 13–14. This document specifies the MW-11 adapter;
it does not replace those contracts.

**Inspected baseline:** `yjs` at `c55d6082952526ce58923a33e815197be94dc8f9`.
Yjs stays pinned to 13.6.33.

## Motivation

A writes while outbound-only. B receives A's actions and independently edits the
same document. A must persist its own work without importing B's work through a
provider handshake, cross-tab broadcast or shared persistence journal. Later A
enables receiving and merges B's actions into the existing store. Its live writer
and history stay intact.

The adapter must also work on a strict A→B channel. B cannot be required to return
a state vector or acknowledgment before A can publish a usable dependency closure.

## Problem statement

`src/markdown/multiwriter/actions/store.ts` already owns a private `Y.Doc` with
`gc:false` and an append-only `envelopes` array. `ActionStore` exposes
`onUpdate()`, `applyUpdate()`, `encodeUpdate()` and `encodeStateVector()`. Its
README delegates directional gating and IndexedDB durability to a future adapter.
`applyUpdate()` rejects native delete sets but has no mode policy.

`src/markdown/multiwriter/contracts.ts` freezes `SyncMode`, `SYNC_DIRECTIONS`,
`DeliveryRoute` and `PublicationStatus`. The directional traces in
`test/multiwriter/corpus.ts` require all receive routes to honor the same policy.
The existing store tests cover readiness and update exchange, not provider
lifecycle or storage transaction completion.

There is no schema-3 provider or IndexedDB implementation in the inspected tree.
`src/main.ts` still mounts the schema-2 canonical editor. MW-11 must provide an
independently testable adapter without switching that editor to schema 3.

`onUpdate()` is not a complete record of received bytes. On Yjs 13.6.33, an
update missing outer native struct prerequisites can enter the store's pending
structs without emitting an event or changing its state vector. A merged message
can emit an event for an independent action while omitting its unresolved structs.
Persisting only emitted events loses that held data on restart. A semantic
snapshot does not expose these structs; a full `encodeUpdate()` includes them.

## Proposal

### Ownership and first caller

Add `src/markdown/multiwriter/providers/` with a transport adapter, an IndexedDB
journal and a public `index.ts`. Keep IndexedDB globals out of the transport
module so headless callers can use an injected storage implementation. Use the
platform IndexedDB API; add no runtime dependency.

The first caller is the provider test harness: three independent `ActionStore`
instances with the same document/genesis and separate persistence namespaces.
Later MW-08/MW-14 integration supplies the document and editing sessions. The
adapter does not create a writer, native text cache, reducer or history stack.

Use the existing action-store methods and events. Route all remote application
through the adapter while it is attached; direct caller use of `applyUpdate()`
would bypass both the receive gate and ingress journaling. Local authoring still
uses the store's append methods. Never expose or attach a provider to `textDoc`.
Keep envelope validation and causal readiness in MW-01's
store and its required validator; mode checks do not certify semantic validity.

### One remote ingress

Expose a remote-update entry point that accepts a `DeliveryRoute`. Peer delivery,
catch-up, self-echo and cross-tab callbacks must all enter here. Check
`SYNC_DIRECTIONS[mode].receive` immediately before synchronous
`ActionStore.applyUpdate()`. A blocked update changes neither store bytes, heads,
storage nor publication state. Do not retain a hidden remote queue in the adapter;
senders retransmit when receiving becomes available.

Copy incoming bytes before application. After `applyUpdate()` returns normally,
enqueue that exact copy for persistence even if no update event fired. Each
admitted receive also triggers the publication/retry path when sending is enabled;
an event is not required to discover newly held unresolved data. Rejected input
must not enter the journal. Stage events emitted synchronously during remote
application until the call succeeds; discard that staging if it throws. Report
the failure without marking it durable or delivered. Pending or quarantined
envelopes retained by a successful call are admitted data, not rejected updates.

If delivery involves an asynchronous wait, check the current mode after that wait.
Do not let a callback captured in an earlier mode import data after receiving has
been disabled. Apply the equivalent rule immediately before handing data to the
outbound transport. Bytes already handed to a transport cannot be recalled.

Restore this replica's own persisted journal through a separate private startup
path. Restoration is permitted in every mode. It must finish before network
attachment and before the host resumes editing. A failed restore fails opening;
it must not silently open an empty document.

### Persistence isolation and durability

Use an explicit host-supplied persistence namespace for a durable replica, bound
to protocol version, document ID and genesis ID. Store and verify that metadata
when opening the journal. Independent tabs/panes must use independent namespaces;
the host must not open one namespace for concurrent independent writers. Document
this ownership requirement. Do not automatically merge a shared IndexedDB journal
or install a BroadcastChannel provider. Any future cross-tab exchange uses remote
ingress and therefore the receive gate.

Persist actionDoc update bytes in an append-only, ordered IndexedDB journal.
Capture three sources of coverage:

1. After startup restoration, subscribe to `onUpdate()` and enqueue a full
   `encodeUpdate()` seed before exposing the adapter or attaching transport.
   Keep this attachment step synchronous so host edits cannot fall between the
   subscription and seed. The seed includes preexisting unresolved outer structs,
   not just integrated actions. Restore must not recursively journal its replay.
2. Enqueue emitted updates from local authoring. Events alone cover these local
   append operations, but do not cover all remote ingress.
3. Enqueue the copied raw bytes of every successfully admitted receive, on every
   route, even when its state vector and semantic snapshot are unchanged. Also
   retain any staged emitted updates after successful application. Redundant
   bytes are acceptable: Yjs replay is idempotent. Never substitute the emitted
   subset for the complete incoming message.

Use one ordered in-memory write queue for these sources. Assign each queued
entry a monotonically increasing journal position. Copy bytes before queueing
so later caller mutation cannot alter pending storage. No state-vector or
snapshot comparison may suppress an admitted receive. Do not persist blocked
or rejected updates, derived caches or interactive history.

Resolve a persistence fence only on the IndexedDB transaction's `complete` event,
not on an individual request's success. A fence captures the queue tail and covers
every entry through that position, including raw receives with no update event.
Advance the durable position only for a completed contiguous prefix. Serialize
journal writes and retain failed and subsequent unsaved updates in memory for an
explicit retry. Report open, quota, abort and write errors. A persistence failure
leaves the local edit applied and unsaved; it does not issue compensating edits
or stop local authoring.

Closing stops new transport callbacks, unsubscribes listeners and attempts to
flush pending persistence, including every admitted raw receive captured before
closing. The host must stop local authoring before close. Reject close/flush on
a failed durable write rather than claiming success. Never delete the journal
on close. Restart replays the seed and journal bytes through the private startup
path; unresolved structs must survive even before prerequisites arrive. It restores
canonical updates into a new process instance; it does not restore the old actor
or interactive navigation stack.

### Sending and strict one-way retransmission

Expose an explicit publication/retry operation and invoke it on initial transport
attachment, newly held updates and transitions that enable sending. Without peer
feedback, export the full held actionDoc with `encodeUpdate()`. This deliberately
includes known records from other actors, pending records and retained variants.
It preserves prerequisites and original native action-store identity.

The host invokes retry on reconnect and periodically on an unreliable strict
one-way channel. Make this requirement part of the transport contract and test
it with a controlled scheduler. A send that was accepted but lost must remain
recoverable through full-coverage retry without any reverse message. Do not add
an implicit process-wide timer or require a bidirectional handshake.

With optional peer state-vector feedback, the adapter may use
`encodeUpdate(peerStateVector)` to avoid retransmitting integrated outer structs.
Feedback is a per-peer optimization, not a prerequisite. It never changes the
action store, semantic heads or Lamport dependencies. A new peer starts without
an assumed frontier. Missing prerequisites in a held store remain subject to the
normal readiness rules; exporting a store cannot invent absent records.

When receiving becomes enabled, notify the host transport to request/retry
catch-up when that channel supports it. Strict one-way receivers obtain catch-up
from the sender's scheduled retransmission. Merge into the same `ActionStore`;
do not replace it or reset sessions. Mode changes never disable local persistence
or decide whether the host permits editing.

### Publication status

Use the existing `PublicationStatus` contract for local publications. `applied`
comes from successful local authoring/publication, not from receipt of an
unvalidated envelope. The provider supplies persistence and optional delivery
progress for the publication's captured actionDoc coverage.

`persisted` becomes true after a completed journal transaction covers those
bytes. Capture the queue position after enqueueing all updates for that
publication; full flush also covers admitted ingress through its captured tail.
Neither an unchanged state vector nor an update callback proves durable coverage.
Later unsaved work must not make earlier durable work appear unsaved.
`delivered` is omitted without an acknowledgment facility. With that facility,
only an explicit peer acknowledgment covering the publication can set it true;
successful send completion alone cannot. Qualify delivery by peer. Out-of-order
or duplicate acknowledgments cannot advance unrelated publications.

Acknowledgments and state vectors describe outer actionDoc receipt. They do not
prove semantic readiness, visible effect, equal documents or safe pruning. Keep
delivery errors separate from persistence errors. Neither affects history or
permits removal of canonical facts.

## Non-goals

- No semantic server, relay hosting, authentication scheme or new CRDT runtime.
- No browser editor cutover, new history implementation or durable undo stack.
- No canonical pruning, automatic replica expiration or journal consolidation.
  MW-18 owns lossless checkpoint manifests and crash-safe journal replacement.
- No per-actor export filter or confidentiality policy. Enabling sending can
  publish all accumulated held work; the host must explain this behavior.
- No claim that provider tests prove deletion-wins, native flow ownership or the
  integrated multiwriter algorithm. MW-08 and MW-16 retain those gates.

## Suggested implementation shape

1. Add a headless adapter and small storage/transport contracts. Reuse the frozen
   mode and route types. Test independent stores with controlled asynchronous IO.
2. Add the IndexedDB journal and actual-browser durability/reopen tests. Keep
   database schema versioning separate from envelope protocol versioning.
3. Add retry, optional feedback and publication-fence tests. Add public API usage
   notes, a Knip entry and the required compatibility-inventory entries.
4. Connect the adapter to the reference composition harness with its owner once
   available. Browser integration continues in its owning workstream.

## Verification

- Test every pair of endpoint modes and every `DeliveryRoute`. Assert blocked
  delivery leaves encoded store state, heads and journal writes unchanged.
- Disable receiving during a delayed callback. Disable sending during queued
  publication. Verify current policy wins before the respective handoff.
- Start A, B and C independently. Let A learn B1, switch A outbound-only, author
  A1 depending on B1, and deliver to fresh C without reverse control traffic.
  Drop an initial message; retry, reorder and duplicate real Yjs updates. C must
  acquire B1 and A1 with the same IDs and complete ready closure.
- Accumulate local actions and published retraction controls while sending is
  disabled. Enable sending and verify full catch-up. Enable receiving on the
  existing store and verify that the adapter never replaces caller-owned state.
- Exercise all modes with persistence enabled. In actual Chromium IndexedDB,
  reopen a completed journal and compare retained envelopes, variants, pending
  actions and controls. Validate document/genesis metadata mismatch failure.
- Reproduce the no-event outer-update case: A emits U1 containing A1, then U2
  containing A2. B receives only U2, then authors unrelated B1. Assert U2 changed
  full encoded bytes but emitted no event and left the state vector unchanged.
  Flush and restart B before U1 arrives. Deliver only U1 to B and an uninterrupted
  control. Compare retained actions, variants, readiness and full encoded Yjs
  bytes, preserving original native action-store IDs. Repeat through every
  receive route and with actual IndexedDB reopen.
- Repeat with U2 merged with an independent action's update. Assert an event
  fires but contains only the integrated subset; the journal must retain the
  complete admitted message. Restart before U1, deliver only U1, and compare
  against the uninterrupted control. Test duplicate and reordered journal replay.
  A semantically pending envelope already integrated into the outer array is a
  separate fixture and cannot substitute for either outer-struct regression.
- Attach to a store already holding unresolved U2 and verify its full seed
  survives reopen. Delay or abort the raw-ingress write in both regressions;
  flush/close must wait or reject even if no event fired. Retry must complete
  coverage without retransmission from the peer. Mutating the original receive
  buffer after admission must not change the journal. Blocked and rejected
  inputs must add no journal entries, including staged callbacks on failure.
- Inject write aborts, quota errors, delayed completion and close during writes.
  Verify persistence fences, retry and unsaved status. Independently test send
  failure, absent acknowledgments and acknowledgments for older coverage.
- Restore while outbound-only and disconnected. Show that a second replica's
  writes cannot enter through its separate persistence namespace; cross-tab
  delivery still uses the remote gate.
- Run focused Node/provider browser suites, `npm run build`, `npm run lint`,
  `npm run format:check`, `npm run check:boundaries` and unused-code analysis.
  Report actual results and any environmental limitation at implementation time.

## Success criteria

1. Only actionDoc is persisted and exchanged; every remote route obeys its mode
   before application.
2. A strict one-way sender can repair lost bootstrap/prerequisites without reverse
   traffic or actor filtering.
3. Mode changes preserve the store and caller-owned live identity/history, and
   publish accumulated work when sending is enabled.
4. Completed journal writes preserve integrated and unresolved outer data across
   reopen, including no-event and mixed-message receives. Flush/close fences
   cover that data; failed writes stay visibly unsaved and retryable. Applied,
   persisted and delivered status remain distinct.
5. No provider operation expires a replica or deletes canonical facts. Real
   provider tests pass without claiming the independent composition gates pass.
