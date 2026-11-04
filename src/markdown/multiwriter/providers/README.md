# Persist and exchange schema-3 actions

MW-11 (`grain/92`) persists an `ActionStore` and gates remote updates by mode.
Only actionDoc bytes pass through this provider. A writer, history stack and
native text cache remain caller-owned. The schema-2 demo is unchanged.

## Open one durable replica

Provide an already configured `ActionStore` with the document's real validator.
Use the same document and genesis IDs for the store and journal. Allocate a
stable, unique namespace per durable replica. Independent writers, including
tabs and panes, must never open the same namespace concurrently. The provider
verifies the journal's protocol/document/genesis binding, but does not allocate
replica identities or enforce exclusive namespace ownership.

```ts
import { DirectionalActionProvider, IndexedDBActionJournal } from './index.js';

const journal = await IndexedDBActionJournal.open({
  namespace: 'document-123:replica-456',
  protocolVersion: 3,
  documentId: 'document-123',
  genesisId: 'genesis-789',
});
const provider = await DirectionalActionProvider.open({
  store, // An ActionStore for these document/genesis IDs.
  journal,
  mode: 'outbound-only',
  onError: ({ operation, error, peer }) => reportFailure(operation, error, peer),
});
```

Suspend authoring until `open()` resolves. Opening replays this replica's own
journal in every mode. Replay failure rejects opening and closes the journal;
discard the failed store rather than using its partially restored state.
The provider subscribes and queues a full attachment seed synchronously after
replay. Call `await provider.flush()` to confirm that seed is durable.

For headless callers, inject an `ActionJournal` with `read()`, `append()` and
`close()`. `append()` must resolve only after durable completion. The adapter
module itself needs no IndexedDB globals.

## Connect and retry

```ts
const detach = provider.attachPeer('peer-B', {
  send: ({ id, update }) => channel.send({ id, update }),
  requestCatchUp: () => channel.requestCatchUp(), // Optional reverse control.
});
// Every incoming callback, including delayed deliveries, must enter here:
provider.receive('peer', incoming.update);
provider.setMode('bidirectional');
await provider.publish(); // Also call on reconnect and periodic one-way retry.
```

`send` receives only actionDoc bytes and an opaque acknowledgment token.
Its completion means handoff, not receipt. The host owns channel callback
registration, peer authentication and reconnect/retry scheduling. A detached or
closed provider stops queued sends; the host must also stop its callbacks.
`receive()` throws after close. A send already handed to the transport cannot be
recalled. `publish()` rejects on a send failure; automatic failures use `onError`.

| Mode            | Send actions | Receive actions | Persist local actions |
| --------------- | ------------ | --------------- | --------------------- |
| `bidirectional` | Yes          | Yes             | Yes                   |
| `outbound-only` | Yes          | No              | Yes                   |
| `inbound-only`  | No           | Yes             | Yes                   |
| `disconnected`  | No           | No              | Yes                   |

`peer`, `catch-up`, `self-echo` and `cross-tab` routes use the same receive gate.
Call `receive()` after asynchronous channel waits so the current mode decides.
Blocked messages are discarded, with no hidden queue. Senders must retransmit.
Do not call the store's `applyUpdate()` directly while attached: that bypasses
both the mode gate and raw-ingress persistence. No BroadcastChannel or shared
foreign journal is installed.

A strict one-way channel needs no handshake, acknowledgment or state vector.
`publish()` exports all held native actionDoc coverage, including other actors'
prerequisites, unresolved outer structs and retained variants. A lost send is
repaired by a later explicit retry. There is no automatic timer. Automatic
publication skips identical full encoded state to bound duplicate/echo loops;
explicit retry and re-enabling sending retransmit even unchanged state.

Receiving can be enabled without replacing the store or its live history. The
provider invokes optional `requestCatchUp()` on attachment and when receiving
becomes enabled. A strict one-way receiver depends on sender retries instead.
Enabling sending can disclose all held work from every actor; there is no
actor filter or confidentiality policy.

## Track durability and optional receipt

After the host successfully validates and publishes a local edit, capture its
coverage. The provider does not certify successful edits by observing received
envelopes or low-level `append()` calls.

```ts
const publication = provider.capturePublication();
publication.status(); // { applied: true, persisted: false } until durable.
await provider.flush();
publication.status(); // persisted: true; later unsaved work does not undo this.
```

`flush()` captures the current queue tail, including raw ingress with no event.
It resolves after a contiguous prefix through that position completes. IndexedDB
request success is insufficient; only transaction completion advances durability.
Local edits remain applied after storage failure. Failed entries and all later
entries stay queued; report them as unsaved. Fix the storage problem, then call
`await provider.retryPersistence()`. Open, abort, quota and write errors propagate;
background write failures also call `onError` with `operation: 'persistence'`.

For optional per-peer delivery status, attach with `acknowledgments: true`, then
pass explicit receiver confirmation to `provider.acknowledge(peerId, messageId)`.
A captured publication's `status(peerId)` includes `delivered` only for a peer
with acknowledgment support attached at capture time. Capture binds to that
attachment; a reused peer ID cannot acknowledge older work. Successful sends
never set `delivered`. Unknown, duplicate and older tokens cannot advance newer
coverage. Capture a new publication when tracking a newly attached peer.

Optional `setPeerStateVector(peerId, vector)` optimizes future sends. Feedback
must describe that peer's actual outer actionDoc receipt. It imports no document
facts and is permitted in receive-disabled modes. A new peer attachment has no
assumed vector. Receipt does not prove semantic readiness, equal views, effective
intentions or permission to prune facts.

Stop authoring before `await provider.close()`. Close unsubscribes local updates,
drops peers and attempts a flush. Failed close rejects and retains pending bytes;
call `retryPersistence()` and `close()` again after fixing storage. Close never
deletes the journal. A new process restores canonical facts, not the old actor,
writer or interactive history navigation stack.

## Verification and limits

Run:

```sh
npm run test -- src/markdown/multiwriter/providers/
npm run test:browser -- src/markdown/multiwriter/providers/
npm run build
```

The provider tests use independent real `ActionStore`s with empty-effect actions
and explicit test validators. They cover all endpoint modes/routes, strict
one-way loss/retry, full known dependency closure, duplicate/echo publication,
optional feedback, per-peer acknowledgments and delayed/failed durability fences.
Actual Chromium IndexedDB tests cover reopen, namespace binding/isolation,
variants, pending actions, controls, buffer copies, quota errors and transaction
abort after request success. Both suites retain no-event and mixed-message raw
outer updates before their prerequisites arrive and compare full native bytes
with uninterrupted stores after restart.

These are storage and transport tests. They do not compose the full native text,
layout, deletion, selection or history algorithms. MW-08 owns that reference
composition; MW-14 owns browser integration and MW-16 owns end-to-end acceptance,
including physical mobile/IME checks. There is no semantic server, replica expiry,
canonical pruning, journal consolidation or persistent interactive history here.
