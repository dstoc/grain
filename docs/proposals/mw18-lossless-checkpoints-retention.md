# Proposal: Lossless actionDoc checkpoints and retention controls

- **Issue:** grain/99 (MW-18).
- **Status:** Proposed v2; requires proposal review before implementation.
- **Revision:** Addresses proposal-v1 review on grain/99: fence unsupported readers, define complete-journal reads, and specify migration and rollback.
- **Authority:** [MW-00 proposal, version 1](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/81), especially §§3, 7.4, 9.3, 10.2–10.4, 13, and 14.
- **Inspected baseline:** `origin/yjs` at `1104978893c1f76201db7d13a5ae5b6c76d51f56`, including MW-01, MW-07, and MW-11. Yjs remains pinned to 13.6.33.
- **Branch:** `feat/99-lossless-checkpoints`; implementation PR targets `yjs`.

## Motivation

A stays offline on an old document prefix. B continues editing, exceeds 500 local history groups, drops derived caches, and consolidates its storage journal. A then authors an insertion against an old native character or placement slot. B must still validate and integrate A's action against the original common genesis.

B can remove redundant persisted update batches and disposable caches. It cannot remove canonical envelopes, native insertion bodies, deletion tags, controls, dependencies, or old ordering anchors. A checkpoint must preserve these facts even when they are invisible, quarantined, or waiting for prerequisites.

## Problem statement

`src/markdown/multiwriter/actions/store.ts` keeps a private append-only `actionDoc` with `gc:false`. `encodeUpdate()` exports complete held native state. `snapshot()` exposes identified variants, readiness, the ready closure, and heads. It does not expose anonymous malformed payloads or unresolved outer structs through its semantic action list.

`src/markdown/multiwriter/contracts.ts` already defines `CheckpointManifest` and `RETENTION_POLICY`. There is no checkpoint container, loader, or executable storage replacement contract. The manifest has protocol, document, genesis, covered action IDs, and heads; it must not be mistaken for the complete canonical payload.

`src/markdown/multiwriter/providers/types.ts` defines `ActionJournal.read()`, `append()`, and `close()`. `adapter.ts` serializes writes and tracks contiguous durability. `indexeddb.ts` stores namespace identity and an append-only update journal in separate object stores. There is no checkpoint record or consolidation operation.

The provider journals raw admitted ingress as well as emitted updates. Existing `adapter.test.ts` and `indexeddb.browser.test.ts` cover no-event and mixed-message unresolved updates. An integrated state vector or ready action list alone would lose that coverage during consolidation.

`test/multiwriter/network.ts` already has checkpoint/restart and maintenance seams. The corpus includes `old-prefix-after-lossless-maintenance` and `history-limit-retains-canonical-facts`, including 501 groups. The current branch has no integrated schema-3 text/history implementation. Those traces are acceptance inputs, not proof that the combined engine passes.

## Proposal

### Ownership and first caller

Add a headless `src/markdown/multiwriter/checkpoints/` module. It owns the versioned checkpoint container, capture/verification helpers, and canonical byte accounting. Extend the existing provider and journal for optional atomic consolidation. Keep transport, semantic validation, history navigation, and cache ownership in their current layers.

The first caller is a provider test with independent real `ActionStore`s and separate durable namespaces. Later the MW-08 replica factory and MW-10/MW-13 owners connect their actual history and caches to the maintenance fixtures. Do not introduce another writer, semantic authority, storage service, or CRDT dependency.

### Versioned full-state container

Encode checkpoint format version 1 with the deterministic CBOR subset already implemented in `actions/cbor.ts`. Reuse that codec without changing the immutable envelope wire format. Keep format version independent of schema/protocol version.

The container holds:

| Field | Meaning |
| --- | --- |
| Format version | Checkpoint container version, initially 1 |
| Protocol/document/genesis | Binding to the existing shared document; protocol remains 3 |
| Full actionDoc update | Exact detached `ActionStore.encodeUpdate()` bytes, including unresolved outer structs |
| Manifest | Existing `CheckpointManifest` describing the exact ready dependency closure and its heads at capture |
| Payload digest | SHA-256 of the full update bytes, to detect accidental payload damage |

Use platform Web Crypto for the digest; add no package. A digest is a corruption check, not authentication or permission to delete history. The container's identity fields and the embedded manifest must agree with the host's expected document binding.

Capture the update and semantic snapshot synchronously, with no await between them. Hash and encode those detached values afterward. Actions arriving during hashing belong to the journal tail. Do not compute a manifest from the later live store.

Define `coveredActions` as every ready action ID, in `compareActions()` order; `heads` uses the store's existing semantic order. It is the exact materializable closure, not an actor maximum or merely the frontier. The complete held canonical coverage is the full native update. Pending/quarantined variants, anonymous malformed records, duplicate native array entries, and unresolved outer structs are retained there even though they are outside the ready closure. Do not claim that the ready manifest enumerates them.

On load, decode strictly and reject unsupported formats, malformed fields, identity mismatch, native delete sets, digest mismatch, or inconsistent manifests. Restore into a fresh store configured with the host's actual genesis allocations and deterministic validator. Recompute the ready closure and heads and compare them with the manifest. Also verify that re-export preserves the held native state, including unresolved structs. Never reconstruct an actionDoc by appending decoded ready envelopes: that changes native array identities and discards unready data.

An integrity-failed source store cannot produce a successful maintenance checkpoint. A valid append-only store containing diagnostic or quarantined payloads can. Do not repair corruption by exporting only valid records. Restore failure rejects opening; discard the failed fresh store. Do not silently fall back to an empty document. A derived cache mismatch instead discards that cache and triggers canonical replay.

Checkpoints are local persistence artifacts. Network exchange continues to use actionDoc update bytes through the provider's receive gate. A restart allocates a fresh author/native client and resets interactive navigation; consolidation in a live provider preserves its store, actor, history, and synchronization mode.

### Atomic journal replacement

Retain `ActionJournal` compatibility for hosts that only append. Add an optional checkpoint-capable extension with two operations:

- Read a detached checkpoint, if present, together with subsequent update batches from one consistent storage snapshot.
- Atomically replace the previously persisted checkpoint and update prefix with a verified checkpoint. Resolve only after durable commit. Reject without losing the previous recoverable state.

The provider detects this capability explicitly. `consolidate()` on an append-only journal rejects as unsupported before changing storage. It does not emulate replacement with `clear()` followed by `append()`. Existing headless journals keep their append-only behavior when consolidation is unused.

`ActionJournal.read()` means a complete replay source for the namespace, never only the suffix after a checkpoint. On a capable journal without a checkpoint it returns the complete detached update list as today. Once any checkpoint record exists, this inherited method rejects with a checkpoint-aware-read-required error, for both empty and nonempty tails. It must not return an empty list, a tail, or unchecked bytes extracted from the container. It checks checkpoint presence and reads updates in the same storage snapshot. This requirement applies to every host adapter that implements the capability, not only IndexedDB.

A checkpoint-aware provider uses the capability's consistent checkpoint-plus-tail read instead of the inherited method. It verifies the container before applying its full native update, then replays the tail through the existing private startup path. A legacy journal without a checkpoint loads unchanged. If a caller uses an older provider with a new capable journal, the inherited read rejects before the provider subscribes, seeds persistence, or returns control for authoring. A corrupt or unsupported checkpoint also fails opening; its presence cannot be treated as absence. All modes permit restoration of that replica's own storage. No other namespace or cross-tab journal becomes a receive bypass.

Use the provider's single ordered persistence queue for replacement as well as append. At a consolidation request, synchronously capture a checkpoint and its queue boundary and insert a replacement barrier before later persistence work. Earlier admitted bytes must complete durably before replacement. Later local events and raw receives queue after the barrier and become the new checkpoint's tail. Hashing must not allow those appends to overtake replacement.

This ordering lets the journal replace its whole current persisted prefix without a second cutoff/lease protocol. Namespace exclusivity is already a host obligation in MW-11; direct journal writes while the provider owns it are disallowed. The provider must serialize concurrent consolidation requests. No host-wide editing pause is needed for consolidation, and no incoming message bypasses the current mode gate.

Keep existing publication durability monotonic. An already persisted publication remains persisted if consolidation fails, because its old journal still exists. Later queued writes remain unsaved until they commit. Replacement completion is its own returned promise, not evidence of remote delivery or semantic acceptance. `flush()` and `close()` must account for queued maintenance barriers as well as raw ingress. Failure retains retryable work and reports a persistence error; `retryPersistence()` retries in order. Do not resolve a consolidation promise on an individual storage request's success.

### IndexedDB implementation and migration

Use the existing `metadata` and `updates` stores and database name `grain-actionDoc:<namespace>`. Add a versioned checkpoint record under a new metadata key. Change the checkpoint-capable `IndexedDBActionJournal.open()` to request database version **2**. This storage-layout version is separate from checkpoint format version 1 and protocol version 3. The document/genesis identity record stays unchanged.

The version upgrade is the unsupported-reader fence. The existing reader explicitly requests database version 1 and cannot inspect checkpoints. Keeping database version 1 would let that reader silently open only a tail after consolidation. With version 2 committed, that reader fails with IndexedDB `VersionError` before returning a journal. A container version alone cannot provide this fence. Retaining a second complete update stream for old readers would avoid the version change but retain the redundant storage that consolidation is intended to remove.

#### Open and migration

1. The host suspends authoring and owns the namespace exclusively before opening, as required by MW-11. Close the previous provider and connection before migration. Do not upgrade a namespace that an independent writer is using.
2. Open version 2. For a new database, create the existing stores. For a version-1 database, preserve both stores and every identity/update record in the upgrade transaction. Do not clear updates or create a checkpoint during migration. Do not run unconditional `createObjectStore()` calls against an existing database.
3. Resolve the database open only after the upgrade transaction commits. Verify the identity as today, then read checkpoint plus tail consistently. Validate a present checkpoint and restore complete held state before exposing the provider or allowing authoring or network attachment. Version-1 journals without checkpoints import through this path without changing their native contents.
4. Continue to close connections on `versionchange`. A blocked upgrade rejects with an actionable close-other-connections error; it must not delete, rename, or reset the database. Close a connection that opens after its request was already rejected. An aborted upgrade leaves the version-1 journal intact. Opening a database with a version newer than 2 rejects rather than attempting a downgrade.

The version fence commits at open, before the first replacement, even if consolidation is never requested or later fails. After that upgrade, old version-1 applications cannot open this namespace. A failed identity or checkpoint validation after the upgrade does not undo the committed database version; retain the data and report the error. This deliberate local-storage compatibility boundary needs proposal approval. It does not change common-genesis synchronization or expire any offline replica.

#### Replacement and failure

Replace the checkpoint record and clear the covered update journal in one read/write transaction spanning both stores. Because the provider serializes all writes, later tail appends start after that transaction. Copy input buffers synchronously. Read checkpoint and tail in one readonly transaction. Continue to treat transaction completion as the commit boundary.

On abort, quota error, or process interruption before commit, the old checkpoint/journal remains recoverable. After commit, the new checkpoint remains recoverable, with whatever later tail transactions completed. Never expose a state with the old journal deleted and its replacement absent. Request success followed by transaction abort is failure.

#### Rollback and recovery

Reopening an upgraded namespace after an application rollback requires a checkpoint-capable reader. Never delete the database or copy only its tail to make a version-1 application open. IndexedDB cannot downgrade an existing database in place.

If a host must return to a version-1 application, stop authoring and close the provider. With a capable reader and the actual genesis allocations/validator, restore and verify the complete checkpoint plus committed tail. Export the restored store's full `encodeUpdate()` bytes, including unresolved structs. Write those bytes and the unchanged protocol/document/genesis binding to a **separate host-owned version-1 namespace**. Verify full native-state equality after reopening that destination with the old reader before switching the host's namespace binding. Keep the original version-2 namespace intact until recovery is verified. A pre-upgrade backup alone is insufficient after later edits unless those edits are also included. If the older application cannot validate the current action protocol, this storage export does not make it compatible; keep a capable application instead.

This is a host recovery procedure, not a second live replica or a new genesis. It preserves action/native identities and does not transfer interactive history. MW-18 documents and tests the procedure; it does not add an automatic downgrade API or delete the source. A corrupt checkpoint requires a known complete backup/recovery source or operator intervention; it never authorizes opening an empty document.

A non-IndexedDB host must provide the same all-or-nothing replacement guarantee, for example through its own transaction or atomic generation publication. It must also fence unsupported readers before discarding their complete replay source, through a storage version or an equivalent enforced compatibility boundary. An optional capability flag or checkpoint metadata that those readers ignore is insufficient. A write/delete sequence without atomicity does not implement the capability. Document the contract rather than adding a filesystem adapter to this issue.

### Disposable caches and local history

Keep maintenance operations separate:

| Operation | Allowed effect |
| --- | --- |
| Consolidate journal | Replace redundant persisted batches with full checkpoint plus tail |
| Drop caches | Release derived native/reducer/projection indexes and rebuild before their next use |
| Evict history | Remove only the owning session's undo/redo navigation metadata |

Cache rebuild uses retained ready envelopes and a fresh native client, with `gc:false`. It cannot author envelopes, replace the action store, regenerate shared identities, or change local history membership. Preserve live selection through the owning editing layer when that integration exists. An unusable cached closure falls back to full canonical replay.

Use the existing `ReplicaPort.maintain()` seam for acceptance fixtures. Do not add a generic cache-registration framework or pretend a counter reset evicts a real cache. MW-10 owns the actual default 500-group limit; MW-13 owns optimized disposable caches. MW-18 must test these actual components when they become available. Their absence is a named integration limitation, not a passing retention test.

### Retained-byte accounting

Report separate, labeled measurements before and after each maintenance operation:

- Encoded canonical envelope payload bytes, including retained variants, anonymous records, and duplicate stored entries. Count actual stored records, not only the deduplicated snapshot.
- Embedded native insertion-body bytes, as a subset of decodable envelope payloads. Undecodable payload bytes remain in the canonical total; do not guess their embedded portion.
- Complete encoded actionDoc update bytes, including native collection overhead and pending structs.
- Persisted checkpoint bytes, tail update bytes, batch count, and their total. Include container/manifest overhead; do not add this total to canonical bytes as if they were disjoint categories.
- Derived cache measurements and local history group/metadata measurements, supplied by their owners.

Add a detached store accounting read over the private envelope array rather than exposing the mutable Y.Doc. Label serialized byte sizes as serialized sizes. Report unavailable cache/history heap measurements as unavailable, rather than zero; do not invent portable JavaScript heap sizes. MW-13 can provide controlled heap measurements separately.

Consolidation should reduce redundant journal bytes in a deliberately redundant fixture. It need not reduce a tiny journal whose container overhead dominates. Cache and history eviction can reduce their own retained state while canonical bytes stay unchanged. No metric promises bounded canonical growth.

### Future compaction and policy boundary

Document the master proposal's §10.3 obligation:

```text
materialize(fullHistory, permittedFutureActions)
  == materialize(compactCheckpoint, permittedFutureActions)
```

A future destructive summary must preserve resource identities or sufficient translation, causal and author-local validation context, active deletion effects, eligible undo targets/control chains, ordering anchors, and structural decisions needed by later replay. Test stale/offline descendants, delayed insertions, moves, cuts, joins, overlapping deletion, and eligible undo/redo. Compare native identities, ownership, readiness, and projection, not only Markdown. No such summary or compactor is enabled by MW-18.

The current policy permits indefinitely old/offline/outbound-only replicas within the common genesis and accepts canonical storage growth. Age, invisibility, empty history, delivery acknowledgments, and a sender's published frontier never authorize pruning. A receipt does not prove that a peer has stopped referencing an old anchor.

Managed membership, explicit retirement, history finalization, forced resynchronization, and the treatment of outstanding old edits require a separate approved policy. Retirement alone does not prove a particular record disposable. Deletion-wins is also separate from secure erasure. Routine maintenance introduces none of these policy changes.

## Non-goals

- Canonical envelope deletion, semantic garbage collection, a new genesis, or rewriting native IDs.
- Mandatory replica expiry, leases, membership tracking, acknowledgment-based pruning, or secure erasure.
- Durable restoration of interactive history or a new implementation of the history/reducer algorithms.
- Network checkpoint messages, a textDoc provider, browser cutover, or a new storage dependency.
- Claiming that storage-only fixtures prove MW-08 or MW-16.

## Verification

1. Round-trip versioned containers with exact full update bytes, manifest closure, and heads. Reject every truncated prefix, unknown version/field, mismatched identity, altered digest, native delete set, and missing/extra covered action. Preserve bigint counters without rounding. Confirm capture remains consistent when the live store changes during hashing.
2. Check ready, semantically pending, quarantined/forked, anonymous malformed, and duplicate records. Include no-event unresolved outer updates and mixed messages. Reload before their missing prerequisites arrive; then deliver those prerequisites and compare full native bytes and readiness with uninterrupted independent stores.
3. Delay and fail the replacement barrier while later local edits and admitted raw receives queue. Verify no lost tail, correct flush/close fences, monotonic publication status, ordered retry, concurrent consolidation behavior, and unchanged mode gating. Repeat in all four modes. Mutate caller buffers after invocation to verify copying.
4. In actual Chromium IndexedDB, reopen a legacy journal and consolidate it. Interrupt before replacement, after each request success but before transaction completion, after commit, and during later tail appends. Inject quota and abort failures. Recovery must yield the complete old journal or the new checkpoint plus every committed tail entry. Repeat consolidation/reopen and namespace-mismatch/isolation checks.
   - Migrate a populated version-1 journal without a checkpoint. Verify native byte equality before and after the upgrade and after the first consolidation. Abort the upgrade and verify that the original version-1 reader can still recover all updates. Test a blocked upgrade, late open success after rejection, identity mismatch, and a newer unsupported database version without data loss.
   - For checkpoint plus empty tail and checkpoint plus nonempty tail, the unchanged version-1 reader must fail with `VersionError`; the capable reader must restore complete held state. The inherited `read()` must reject in both cases, and an older provider using it must fail before subscribing or appending a startup seed. Test unsupported/corrupt containers with both tail states. Repeat the inherited-read checks with an in-memory capable adapter.
   - Verify the version-1 reader also refuses a migrated version-2 database before its first consolidation. Exercise blocked migration while an old connection is held. Verify no database reset or fallback namespace appears.
   - Exercise the documented rollback export into a separate version-1 namespace with a committed tail and unresolved native structs. Reopen with the old reader and compare complete native bytes and readiness, then deliver missing prerequisites to both stores and compare again. Verify the source remains unchanged and the host switches only after successful destination validation.
5. Use three independent common-genesis stores to test post-checkpoint state-vector exchange, duplicate/reordered updates, strict one-way retransmission without acknowledgments, and fresh actions depending on retained old actions. Storage-only actions may use explicit narrow validators; do not certify nonempty native/semantic bodies with an unconditional validator.
6. Run `old-prefix-after-lossless-maintenance` and `history-limit-retains-canonical-facts` through the actual integrated replica factory when available. Extend coverage to an old-prefix outbound-only writer, deleted/hidden native ranges, moved predecessor occurrences, markers, controls, and fresh structural actions after more than 500 groups. Compare raw layout, native IDs, cells/slots, deletion state, ready closure, normalized Markdown, and fresh full replay. Compare peers only once their valid held sets match. Keep these as required integration work if the factory/history is not yet present.
7. Measure canonical, embedded native, actionDoc, journal, cache, and history categories independently before/after maintenance. Prove duplicate batch reduction, unchanged canonical facts, actual cache release/rebuild, and actual history-only eviction. Record cold checkpoint load and suffix batch count; performance gates remain MW-13/MW-16.

For implementation run focused node checkpoint/provider/action/network tests, `npm run build`, `npm run lint`, `npm run check:boundaries`, both Knip scripts, `npm run format:check`, and the real IndexedDB browser suite. Run the full node suite if shared contracts or corpus fixtures change. Browser editing/IME validation belongs to later integration if editing code changes.

Proposal preparation checks source paths, existing fixtures, the dependency pin, and document whitespace. It does not execute a checkpoint algorithm or establish runtime correctness.

## Suggested implementation shape

1. Review the container, exact-ready-closure meaning, optional journal capability and inherited-read failure, queued replacement semantics, version-2 reader fence and rollback policy, and byte categories in this document.
2. Implement detached capture/strict restore and store accounting in `checkpoints/`, with focused tests and an intended production entry in `knip.json`.
3. Add the optional journal capability and provider barrier; test failures and live tail writes with an in-memory transactional test adapter.
4. Implement the version-2 IndexedDB migration/fence, complete-journal read contract, and atomic replacement. Add real browser migration, unsupported-reader, rollback-export, and crash-boundary tests.
5. Connect actual cache/history maintenance to the existing network harness as their owners land. Preserve the required full integration fixtures and identify outstanding evidence explicitly.
6. Document the host contract, retention policy, measurements, and limits. Open the implementation PR against `yjs`, attach it to grain/99, and request review without waiting for CI.

## Success criteria

- Full checkpoints restore all held canonical native state, the exact ready closure, and original document/genesis identity.
- Interrupted consolidation always leaves a valid old journal or a valid new checkpoint with its committed tail.
- Unsupported readers fail before opening a partial replay source. Capable readers import version-1 journals losslessly; inherited reads reject once a checkpoint exists. Rollback export preserves complete state in a separate namespace.
- Live queue ordering, publication durability, receive isolation, and retry semantics survive consolidation.
- Cache cleanup and 500-group eviction leave old native/structural references and canonical effects usable.
- Accounting distinguishes canonical payloads, native bodies, storage batches, caches, and history without claiming bounded canonical storage.
- Required full-replica retention evidence is reported separately from storage-only coverage; no canonical pruning or replica expiry is introduced.
