# Schema-3 action storage

MW-01 implements `grain/82` from the proposal on `grain/81`. Import the shared
codec and `ActionStore` from `./index.js`. This module does not use the schema-2
writer, accepted revisions, a structural authority, or a native text cache.

## Wire format

`encodeEnvelope()` maps the logical `ActionEnvelope` in `../contracts.ts` to
text-keyed CBOR records with the same field names. Each actor field is a 16-byte
string; its logical form remains 32 lowercase hex digits. All other strings are
UTF-8. Resource IDs retain their typed birth/ordinal records. Native insertion
updates are byte strings and remain byte-for-byte unchanged. Arrays retain their
logical order, including dependencies, allocations, manifests and effects.

The codec follows [RFC 8949 §4.2.1](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2.1):
preferred unsigned integer/length encodings, definite lengths and bytewise sorted
encoded map keys. It rejects duplicate or out-of-order keys, trailing data,
negative numbers, floats, tags, undefined values and invalid Unicode. Sequence and
Lamport values are unsigned 64-bit `bigint`s; native integers and ordinals must
be nonnegative safe integers. Unknown fields and discriminants are errors.

`decodeEnvelope()` returns a detached logical envelope or throws
`EnvelopeDecodeError` for established data errors. Operational failures propagate;
`IngestCapacityError` reports retryable local capacity. When a structurally decodable record has an action ID,
the error retains that ID so unsupported versions and malformed variants can be
quarantined. Records without a trustworthy ID remain collection diagnostics.
The codec never repairs or normalizes received bytes. `decodeCbor()` and
`validReferences()` remain synchronous reference utilities for wire decoding and
causal resource existence. They do not certify native bodies or author semantics.

## Collection and readiness

Each `ActionStore` owns one private `Y.Doc` with `gc:false` and a top-level
`Y.Array<Uint8Array>` named `envelopes`. `append()` encodes a logical record;
`appendEncoded()` also retains malformed and unsupported bytes for diagnosis and
lossless exchange. These are low-level storage methods, not successful-edit or
durability acknowledgments. Authoring must validate before publication.

Use `encodeUpdate()`, `encodeStateVector()`, `applyUpdate()` and `onUpdate()` to
persist or exchange this action document. An update includes held prerequisites
from every actor, not just local actions. `onUpdate()` reports both local and
received updates, and gives each subscriber its own byte copy. The transport
adapter must prevent disallowed receive routes **before** `applyUpdate()`;
this module does not implement synchronization modes or IndexedDB durability.
Use the [MW-11 provider](../providers/README.md) for those IO boundaries.
Only actionDoc updates travel through these methods. Never attach a provider to
a derived native text cache.

`snapshot()` calculates full reference readiness. Action sequence numbers start
at 1. Each later action must explicitly depend on its actor predecessor. Every
dependency must have a complete valid closure. Lamport time must equal one plus
the maximum direct dependency time, or 1 for an empty dependency set. The store
also checks document/genesis identity, duplicate dependencies, allocation births,
unique allocation ordinals across domains, and typed reference existence in
genesis, the dependency closure or the action's own allocations. Retraction does
not remove these allocation facts.

The required `validate(action, { dependencies })` callback must certify native
bodies/manifests and author-local semantic validity. It receives detached values
and only the action's full dependency closure in semantic order. It must return
`null`, a quarantine reason, or a resumable `Work` generator of that result.
It must be deterministic and must not modify external state. Exceptions abort the snapshot; no partial ready set
is returned. MW-02/MW-15 supply this validation. Passing an unconditional success
callback does not validate nonempty native or semantic actions.

Do not validate against the final merged view or apply bodies while collecting
records. Missing prerequisites remain pending, with the transitive missing IDs
reported in actor/sequence order. Known-invalid dependencies quarantine their
dependents. Independent ready branches continue.

A snapshot includes all identified records with sorted distinct byte variants,
readiness, the ready envelopes in `(lamport, actor, sequence)` order, and ready
heads in that same order. Equal duplicate payloads are semantically idempotent.
Different payloads for the same actor/sequence quarantine the identity and its
dependents. Both versions remain observable and persisted, regardless of arrival
order. A fork can remove actions from a previously ready closure. Consumers must
compare closures and rebuild contaminated native/reducer caches with a fresh
native client before authoring resumes, as the proposal requires.

Snapshots, validator arguments and envelope bytes are detached from internal
facts. Array position has no semantic meaning. `applyUpdate()` preflights the
pinned append-only update subset before Yjs decode or integration. Forbidden
collection deletions, nonbinary entries, map writes and unknown roots throw
without poisoning the existing store or emitting persistence events. The
private document also checks observed integrity defensively. This is corruption
detection, not a Byzantine-safe protocol.

Envelope collection queues bytes without decoding inside Yjs observers.
`compute(operations)` returns a complete snapshot or a deferred continuation;
it never returns an incomplete ready set as complete. `snapshot()` drains the
same calculation synchronously. See [MW-15 ingest](../ingest/README.md) for
continuation lifecycle, capacity changes, actual native certification and the
reference publication boundary.

## Verification and limits

Run `npm run test -- src/markdown/multiwriter/actions/` and `npm run build`.
Tests cover CBOR byte vectors and malformed encodings, every logical variant,
all truncated envelope prefixes, causal closure, actor chains, duplicates,
forks discovered after readiness, author-local validation, three independent
Yjs collections, merged/reordered updates, state-vector catch-up and reload.

This is a reference calculation, not the optimized editing path. A snapshot
revisits the held graph and constructs per-action dependency closures. MW-13
owns incremental indexes and performance gates. MW-02 owns native cache
materialization and rebuild. MW-15 composes native validation and reducer-owned semantic hooks, and
provides resource/backpressure limits. MW-08 must compose these components with actual
reducers and run the independent-replica corpus before browser cutover.
No canonical pruning, replica expiry, history navigation, projection, checkpoint
replacement protocol or complete multi-writer convergence is implemented here.
