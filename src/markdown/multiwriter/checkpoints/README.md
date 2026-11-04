# Lossless checkpoints and retention

MW-18 (`grain/99`) consolidates redundant actionDoc journal batches into a full
checkpoint and later updates. It preserves the common genesis, all held native
state, and the ability to receive old offline edits. Canonical storage can grow
without a bound.

## Consolidate an attached provider

Open a `DirectionalActionProvider` with a `CheckpointActionJournal`, such as
`IndexedDBActionJournal`. The host must exclusively own the namespace. Independent
writers need separate namespaces. Do not write directly to the journal while the
provider owns it.

```ts
await provider.consolidate();
```

The provider captures state and reserves a persistence barrier synchronously.
Earlier writes commit first. Edits and admitted receives during hashing or
replacement queue after that barrier and become the checkpoint's tail. Live
editing continues with the same store, actor, history and synchronization mode.
All four modes can consolidate their own storage; remote messages still enter
through `receive()` and its mode gate.

A failed replacement preserves the old recoverable journal. Earlier persisted
publications remain persisted. Later queued entries stay unsaved. Fix storage,
then call `await provider.retryPersistence()` to retry the retained barrier and
tail in order. The original failed `consolidate()` promise remains rejected.
`flush()` and `close()` include maintenance barriers. Stop authoring before close;
keep the store alive until close succeeds. Concurrent consolidation calls use
the same ordered queue. Hash/encoding failures retry the same detached capture,
without capturing later edits into the checkpoint. Append-only journals reject consolidation without
changing storage and keep their existing append behavior.

## Capture and restore without a provider

```ts
import { captureCheckpoint, restoreCheckpoint } from './index.js';

const bytes = await captureCheckpoint(store);
const restored = await restoreCheckpoint(bytes, store);
try {
  // restored is a fresh ActionStore with the same binding, genesis and validator.
  const fullNativeUpdate = restored.encodeUpdate();
  saveVerifiedExport(fullNativeUpdate);
} finally {
  restored.destroy();
}
```

The template store supplies the host's actual genesis allocations and
synchronous deterministic validator. It is not mutated. Restore failure destroys
the candidate and rejects. Never open an empty replacement after validation
failure. Provider open validates a checkpoint before applying it, then replays
the committed tail before subscribing or returning control for authoring. On
open failure, discard the failed host store.

The deterministic CBOR container has format version 1, protocol version 3,
document/genesis binding, a full `ActionStore.encodeUpdate()` payload, a manifest,
and a SHA-256 payload digest. The manifest repeats the binding and records every
ready action ID in semantic order plus the ordered heads. It describes the exact
ready closure, not all held canonical coverage. The full update also preserves
pending/forked/quarantined variants, anonymous malformed bytes, duplicate native
array records and unresolved outer structs. Capture detaches bytes and the
manifest before hashing yields.

Restore rejects unknown fields/versions, malformed values, mismatched binding,
native delete sets, digest damage, incorrect ready coverage or heads, and any
change in full native state on re-export. `decodeCheckpoint()` only checks
container syntax; it does not verify the digest, native payload or readiness.
A digest detects accidental payload damage; it is not authentication.
An integrity-failed source cannot produce a checkpoint. Restoration uses native
updates, never reconstructed arrays of decoded ready actions.

Network messages remain actionDoc update bytes. Checkpoints are local storage
artifacts, not provider messages. Restore creates a fresh native actionDoc client.
On restart, the host supplies a fresh author/session and resets interactive
history navigation. Consolidation keeps those live objects unchanged.

## Implement a host journal

`CheckpointActionJournal` extends `ActionJournal` with:

| Method                         | Required behavior                                                                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readCheckpoint()`             | Return detached checkpoint bytes, if present, and all later update batches from one consistent storage snapshot. A present invalid record must fail, including a stored `undefined`.                                                |
| `replaceWithCheckpoint(bytes)` | Copy synchronously. Atomically replace the previous checkpoint and the entire persisted prefix. Resolve only at durable transaction completion; rejection leaves the previous recoverable generation intact.                        |
| Inherited `read()`             | Without a checkpoint, return the complete journal. With any checkpoint present, reject for both empty and nonempty tails. Never return only a tail or unchecked bytes from a container. Check presence and updates in one snapshot. |

The provider validates a captured checkpoint before replacement. A host that
calls replacement directly must verify the checkpoint first. A sequence of
independent writes/deletes is not atomic replacement. Filesystem or other
adapters need their own transaction or atomic generation publication, and an
enforced unsupported-reader fence before they discard a complete replay source.
A capability flag or metadata that an old reader ignores is insufficient.
No filesystem adapter or generic cache-registration system is supplied.

IndexedDB keeps `metadata` and `updates` in `grain-actionDoc:<namespace>`.
Replacement puts the checkpoint under `metadata['checkpoint']` and clears updates
in one transaction spanning both stores. Append and replacement request strict
durability; only transaction completion resolves them. On abort, including after
a request succeeds, the previous generation survives. After commit, recovery
uses the new checkpoint and every later committed tail transaction. This atomic
contract does not establish physical power-loss behavior on every device.

## Upgrade or roll back IndexedDB storage

The capable opener requests **database version 2**, independently of checkpoint
format version 1 and protocol version 3. Close the previous provider and database
connection before upgrading. Migration preserves version-1 identity and updates;
it does not consolidate them. The version fence commits at open, even before the
first consolidation. Unchanged version-1 applications then fail with
`VersionError`, rather than silently restoring only a tail.

Blocked upgrades reject with an instruction to close other connections. A late
successful connection after rejection is closed. An aborted upgrade retains the
version-1 journal. Newer unsupported database versions reject without reset.
Identity or checkpoint validation failure after a committed upgrade preserves
the data and the version-2 fence. It cannot roll the database version back.

To return to a version-1 application:

1. Stop authoring and close the provider. Use a capable reader with the real
   genesis and validator to restore and verify checkpoint plus committed tail.
2. Export the restored store's full `encodeUpdate()`, including unresolved structs.
3. Write the full bytes and unchanged document/genesis/protocol binding to a
   **separate host-owned version-1 namespace**. Do not modify the source.
4. Reopen the destination with the old reader and verify complete native-state
   equality and readiness before switching the host's namespace binding.
5. Keep the original version-2 source until recovery is verified. If the old
   application cannot validate the current action protocol, keep a capable one.

IndexedDB cannot downgrade a database in place. A pre-upgrade backup alone omits
later edits. A tail alone omits the checkpoint. Do not delete the source, create a
new genesis, or fall back to an empty document to make an old application open.
This is a host recovery procedure, not an automatic downgrade API or a second
live writer. Interactive history is not transferred.

## Keep maintenance and measurements separate

| Operation           | Data it can remove                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Consolidate journal | Redundant persistence batches, replaced by full canonical native state                             |
| Evict caches        | Derived indexes, native caches and projections; rebuild from retained ready envelopes before reuse |
| Evict local history | Only the owning session's undo/redo navigation metadata                                            |

`NativeTapeCache.destroy()` closes its document and clears its registry maps.
Release the owning cache reference so the native document can be reclaimed. Create a new
cache and replay the retained genesis and exact ready native bodies, or use
`rebuild()` with that closure. Replay uses `gc:false` and a fresh client while
preserving insertion and marker IDs. It does not author actions or change
history membership. A bad derived cache falls back to full canonical replay;
a bad canonical checkpoint is a recovery error. Selection belongs to the editing
layer and must be preserved there when this maintenance is integrated.

```ts
import { journalBytes } from './index.js';

const canonical = store.retainedBytes();
const persisted = journalBytes(await journal.readCheckpoint());
```

`retainedBytes()` reports actual stored binary record count, envelope payload
bytes including duplicates/anonymous records, embedded native insertion-body
bytes from decodable records, and the full encoded actionDoc update size including
pending outer structs. Embedded native bytes are a subset of canonical payloads;
undecodable payloads remain in the total with an unknown native portion.
`journalBytes()` reports checkpoint bytes, tail update bytes, tail batch count and
their total, including container/manifest overhead. These are serialized sizes,
not JavaScript heap sizes. Persistence and canonical categories overlap; do not
sum them as disjoint memory categories.

Record these values before and after each maintenance operation. Record cache
and local-history group/metadata measurements from their actual owners; report
unavailable heap measurements as unavailable, not zero. Redundant fixtures should
shrink after consolidation; a tiny journal can grow because of container overhead.
Cache/history cleanup must leave canonical facts unchanged. No metric promises
bounded canonical growth.

## Future compaction requires a separate proof and policy

The MW-00 proposal §10.3 requires:

```text
materialize(fullHistory, permittedFutureActions)
  == materialize(compactCheckpoint, permittedFutureActions)
```

A future destructive summary must preserve resource identities or sufficient
translation, causal/author-local validation context, active deletion effects,
eligible undo targets/control chains, ordering anchors and structural decisions
needed by later replay. Test stale/offline descendants, delayed insertions,
moves, cuts, joins, overlapping deletion and eligible undo/redo. Compare native
identity, ownership, readiness and projection; equal current Markdown is
insufficient. MW-18 supplies no destructive summary or compactor.

The current policy accepts indefinitely old/offline/outbound-only replicas within
the common genesis and accepts canonical growth. Age, invisibility, an empty undo
stack, delivery acknowledgments or a published frontier never authorize pruning.
Receipt does not mean that a peer has stopped referencing an old anchor.

Managed membership, retirement, history finalization, forced resynchronization
and the treatment of outstanding old edits require a separate approved policy.
Retirement alone does not prove a record disposable. Deletion-wins is separate
from secure erasure. Routine maintenance introduces none of those policy changes.

## Verification and remaining integration gates

Checkpoint node tests validate strict load/capture and native equality, including
unresolved structs before and after missing prerequisites arrive. Provider tests
exercise delayed/failed barriers and live tail writes in all four modes, retry,
close/flush, strict one-way retransmission and state-vector exchange. Chromium
IndexedDB tests cover legacy migration, reader fences, corrupt records, transaction
aborts after request success, synchronous quota failures and rollback export.
A native-cache test destroys/rebuilds a real cache and then integrates an offline
insertion using old native character/marker anchors with author-closure native
validation. A separate regression covers decoded envelope/native-subset replay.

These controls do not certify the combined reducer/history algorithm. The actual
MW-08/MW-10/MW-13 replica/history factory is not on this branch. Required corpus
traces `old-prefix-after-lossless-maintenance` and
`history-limit-retains-canonical-facts` (501 groups) remain integration gates.
Connect `ReplicaPort.maintain()` to the real components and compare raw layout,
native IDs/cells/slots, deletion state, ready closure, Markdown and fresh replay.
Include hidden/deleted ranges, moved predecessor occurrences, controls, an
outbound-only old-prefix writer and fresh structural actions after history
eviction. Cache tests and storage tests do not replace those gates, MW-16,
physical crash testing, or browser selection/IME validation.
