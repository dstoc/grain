# Independent-replica harness

MW-07 (`grain/88`) implements the network harness for the proposal attached to
`grain/81`. It builds on the frozen MW-00 traces. Yjs remains pinned to 13.6.33.
The scheduler owns no document reducer and admits no commands through an authority.

`network.ts` provides:

- `ReplicaNetwork`: three independent ports, directed links, optional reverse
  control traffic, and a queue of copied transport bytes.
- `NetworkTrace` version 1: executable commands, a uint32 seed, and the schema-3
  semantic fixture. Exact uint64 counters use decimal strings in JSON artifacts.
  This is a test format; it does not replace the envelope codec.
- `SeededRandom` and `generate()`: deterministic scheduling and a local-command
  callback that receives the chosen peer's actual observation. A command must
  observe that peer's ready closure. Owners supply valid structural commands.
- `replicaTraceAdapter()`: connects real ports to the existing
  `runContractTrace()` comparison runner. Expected observations never enter the
  port factory.
- `replayNetworkTrace()`: executes a saved schedule and disposes its replicas on
  success or failure.

## Adapter obligations

Implement `ReplicaFactory.open()` with separate action store, private native
cache, reducer, and history objects for each call. Return their actual handles;
sharing a facade around one writer does not satisfy this contract. All peers
must load the same genesis rather than independently parse Markdown.

`author()` lowers symbolic aliases into actual envelope/resource/native IDs in
that peer's own causal view. Bindings must remain stable across delivery, undo,
checkpoint reload, and fresh replay. A restarted endpoint owns a fresh writer
instance and session; old aliases retain their original identities. Generated
trace sequences count symbolic commands at an endpoint and do not authorize
reuse of a runtime actor after restart. Runtime actor chains remain the action
store adapter's validation responsibility.

`exportUpdate()` returns real Yjs action-store update bytes. A subset can omit
semantic prerequisites to exercise pending readiness. Exporting the full held
set must bootstrap a new receiver, including records by other actors. Mutations
use the MW-00 fault names and change complete envelopes in the owner adapter.
The scheduler does not manufacture invalid native bytes or validate envelopes.

`isolationState()` returns complete canonical and native Yjs state bytes, including
pending outer structs and data outside the visible projection. The scheduler
compares these bytes for unaffected and receive-disabled replicas. Transport
control metadata must remain separate. The canonical bytes must be the complete
`Y.encodeStateAsUpdate(actionDoc)` result. Restart, fresh replay, and maintenance
must preserve these bytes, including outer native identities and coverage.

`receive()` must enforce the current receive policy before canonical ingestion
on every route. The scheduler deliberately calls it while receiving is disabled.
`control()` and `receiveControl()` exchange optional transport metadata only.
Acknowledgments must not import document actions, advance heads, or alter local
history. They are never required to author, send, or deliver document updates.

`checkpoint()` returns lossless canonical state, without relying on a saved
projection or interactive history. Opening it must reconstruct every document
facet and reset undo/redo navigation. `maintain()` exposes the existing history
eviction, cache eviction, and checkpoint-reload controls. These operations must
retain canonical facts; cache/checkpoint maintenance also preserves live local
navigation. Unsupported owner operations must throw instead of passing as no-ops.

## Schedule and assertions

Links start disabled. `link` enables one document direction and independently
allows reverse controls for that direction. `send` captures bytes when the
source can send. `deliver` picks any queued message. A disabled link keeps it
queued; a receive-disabled target consumes the attempt without incorporating it.
Disabling sending does not recall bytes already sent. `duplicate`, `merge`, and
`drop` exercise retransmission, merged outer updates, and loss. Merged messages
must have the same endpoints and route. `ack` requires an allowed reverse path
and a completed delivery; it does not imply convergence or safe pruning.

Every step checks all peers, not just its target. The runner checks closed ready
sets, symbolic actor continuity, causal heads, pending-body exclusion, exclusive
native ranges and visible identities, total cell ownership, stable resource and
native bindings, retained facts, and receive-disabled isolation. Remote delivery
cannot enter local history or clear redo. Equal ready sets must have equal
materialized views even when pending inventory differs. Different ready sets
may have different views. Restart and fresh replay compare all document facets,
including hidden content, origin mappings, and canonical inventory. Each peer's
held identities and payload-variant counts must retain its previous inventory
after every step. Pending and quarantine status can change without removing
held identities or reducing variant counts.

Use the existing semantic corpus with an integrated factory:

```ts
await runContractTrace(replicaTraceAdapter(factory, equal), trace, equal);
```

For a generated run, catch a failure while the network is still available and
save `encodeNetworkTrace(network.trace())`. The recorded schedule includes the
failing command. Replay it with `replayNetworkTrace(factory,
decodeNetworkTrace(saved), equal)`. Reduce the schedule to the failing causal
prefix and retain it as an ordinary regression test. Always dispose the network
in `finally`.

## Verification and remaining owner work

```sh
npm run build
npm run test -- src/markdown/multiwriter/
```

`transport-probe.ts` is a harness test instrument. Each port owns real independent
Yjs action and text documents. Its small text/tag model supports single-unit
insertion, exact-cell deletion, and group controls. It rejects other intents and
fault mutations. Its carrier-envelope encoding is private to these tests and
must never become the schema-3 wire format. It does not implement placement,
interval refinement, interpretation, or legal Markdown projection.

The tests cover the 16 source/target mode combinations on all four routes,
one-way bootstrap, optional acknowledgments, missing prerequisites, independent
ready progress, outbound isolation against a separate control, unsent edits,
reordering, duplication, merged updates, loss, maintenance, and restart. Four
seeds generate local insert/delete/undo commands, repeat the schedules, complete
catch-up, and compare fresh replay. Negative controls reject shared handles,
receive leaks (including hidden raw-state contamination), unclosed readiness,
control-data and navigation leaks, loss of previously held identities or payload
variants, and checkpoint data loss or replacement of outer native identities.
A separate incremental transport control sends original action-store structs
with a state-vector delta. It delivers a queued tail after restart, so the tail
must resolve against the checkpoint's original native prefix. The ordinary
probe's subset carriers do not exercise that outer native prerequisite. Another
control checkpoints an unintegrated tail, then delivers its missing native
prefix after restart; semantic observations alone cannot detect loss of that tail.

MW-08 must supply the actual combined factory and run the full structural corpus
and structural command generator. MW-01/MW-15 own malformed-envelope and fork
validation; MW-02 owns native-body validation. MW-10 supplies actual bounded and
scoped history, including the 501-group trace. MW-11 owns provider route gates and
state-vector catch-up. MW-18 extends checkpoint tests with its crash boundaries
and retained-byte accounting. The probe's Yjs reload is not a crash-safe storage
adapter. These harness checks do not establish combined semantic correctness,
physical device behavior, or performance budgets.
