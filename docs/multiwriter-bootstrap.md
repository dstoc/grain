# Create and join schema-3 documents

The headless bootstrap API creates one shared genesis from Markdown. Distribute its
exact bytes to every peer so that text, markers, flows and placements have the
same identities. Parsing the same Markdown independently creates separate
lineages, even when the document ID and visible text match.

Import the API from
[`bootstrap/index.ts`](../src/markdown/multiwriter/bootstrap/index.ts).
It uses the [reference composition](multiwriter-reference.md) and the directional
provider. Yjs stays pinned to 13.6.33. Browser commands, session navigation and
performance acceptance have separate integration gates.

## Create or reopen a document

The host owns immutable document metadata and a separate journal namespace for
each writer. Install the genesis metadata durably before attaching the journal or
exposing the new document as durable. The following storage functions stand for
host implementations; bootstrap does not add a metadata database.

```ts
const genesis = createGenesis(documentId, markdown);
await metadata.install(documentId, genesis); // atomic install, or compare existing bytes

const replica = await openBootstrap({
  genesis,
  persistedGenesis: await metadata.read(documentId),
  journal: ownJournal,
  mode: 'bidirectional',
});
```

Keep authoring suspended until `openBootstrap()` resolves. The returned `session`
has a fresh actor and local session ID for the host writer. Restart creates a new
session; baseline genesis contributes no navigation entry. A missing or different
`persistedGenesis` fails before journal attachment. For restart, read the original
metadata and open the writer's own journal. Never regenerate missing metadata
from exported Markdown. The host must implement atomic metadata installation,
namespace selection and recovery from metadata storage failure.

Creation parses through the neutral block parser. Empty Markdown creates one
shared empty paragraph and flow. Initial content is the baseline, with no undoable
import action. Nonempty inlines have two interior brackets plus permanent tape
endpoints; the sentinel-adjacent cells stay text-free. No per-character markers
are allocated. Unsupported parsed output, invalid Unicode and failed native or
projection validation fail creation.

## Join and catch up

The sender captures its full retained carrier, including pending outer Yjs
structs and invalid/forked envelope variants:

```ts
const bundleBytes = sender.captureBundle();
// Send/retry bundleBytes through the host's transport.

const bundle = decodeBundle(bundleBytes);
const descriptor = decodeGenesis(bundle.genesis);
if (descriptor.documentId !== documentId) throw new Error('Wrong document');
await metadata.install(documentId, bundle.genesis);
const receiver = await openBootstrap({
  genesis: bundle.genesis,
  persistedGenesis: await metadata.read(documentId),
  journal: receiverOwnJournal,
  mode: 'inbound-only',
});
const result = receiver.receiveBundle('catch-up', bundleBytes);
await receiver.provider.flush();
```

`receiveBundle()` returns `admitted`, `disabled`, or `backpressured`, using the
provider's existing meanings. Admission does not imply persistence or peer
acknowledgment. On backpressure, raise the relevant local capacity before retry.
A receive-disabled peer opens the common genesis and its own journal but imports
no remote tail. Enable receiving and retry the bundle to catch up.

For an already open receiver, call `receiveBundle()` directly. Exact descriptor
mismatch raises `BootstrapCompatibilityError` before any carrier application.
Matching duplicates are idempotent. Catch-up keeps the existing document, writer
and host-owned navigation state. Strict one-way links can periodically retransmit
complete bundles without reverse acknowledgments or state vectors.

Before attaching an ordinary update channel, the host must verify the peer's
exact descriptor through the bootstrap exchange. Raw carrier messages have no
descriptor field. Every remote action-update route, including ordinary provider
messages, must then use the attached directional provider. Do not restore remote tails through the local
journal path or call the store's raw `applyUpdate()` while attached.

Before shutdown, suspend authoring and await `replica.close()`. If persistence
fails, repair storage, call `replica.provider.retryPersistence()`, then close
again. A failed close retains the attachment for this retry.

## Encoding and local capacity

Bootstrap version 1 uses the existing deterministic CBOR subset. Descriptor keys
are exactly `protocolVersion`, `bootstrapVersion`, `documentId`, `genesisId`,
`allocations`, `births`, `initialProperties`, `nativeInsertUpdates`, and
`nativeManifest`. Versions are 3 and 1. Allocations appear once. Resource, property
and native fields share action-envelope encoding and validation. Bundle keys are
exactly `protocolVersion`, `bootstrapVersion`, `genesis` (descriptor bytes), and
`actionUpdate` (complete carrier bytes).

`decodeGenesis()` checks canonical encoding, unique genesis ordinals, closed
references, birth bindings, private homes, native integration and projection.
It returns detached data. Descriptor compatibility compares the entire canonical
byte array, including IDs, properties and original native insertion bytes.
This checks equality; it does not authenticate the sender.

`createGenesis()`, `encodeGenesis()`, `decodeGenesis()`, `encodeBundle()` and
`decodeBundle()` accept local bootstrap limits. `openBootstrap()` accepts them as
`bootstrapLimits`. Defaults are 8 MiB of encoded bytes, depth 64, 100,000 CBOR
operations and 100,000 native decode operations. Large documents can require
larger capacities. `IngestCapacityError` is retryable with the same input and
larger limits. Provider message/persistence capacities remain separate settings.
`captureBundle(limits)` and `receiveBundle(route, bytes, limits)` accept per-call
bundle limits. These do not update live native certification or publication
capacity. For a native capacity error, call
`replica.document.setNativeDecodeLimit(operations)`, then retry
`replica.document.publication.refresh()` and resume any deferred continuation.
The method updates both native capacities and cancels unfinished store and
publication computations. It preserves canonical facts, the last publication,
the provider and the live session. Already admitted facts need no retransmission.
If envelope decoding also exceeds capacity, raise
`replica.document.store.setDecodeLimits({ depth, operations })` before retrying.
These are decoder capacities, not latency or retained-storage budgets.

## Export and retention

Use `serializeProjection(publication.value.view)` for Markdown export. Export and
reparse preserve supported canonical Markdown meaning, with the parser's existing
spacing and marker normalization. Reimport creates a new lineage. It cannot
replace a bootstrap descriptor or a lossless checkpoint.

Repeated projection, export and bundle capture author no facts. Keep the original
genesis artifact through cache eviction, history eviction and lossless journal
maintenance. Preserve complete carrier bytes rather than rebuilding a carrier
from ready envelopes. Never retire offline writers or prune canonical facts as
part of bootstrap.

Schema-2 conversion is excluded. Unsupported bundle versions fail before apply;
incompatible envelopes inside valid schema-3 carriers remain quarantined under
the action store's validation. They do not become editable content.

## Verify bootstrap

Run `npm run test` for the ordinary Node regressions, including 10/150-paragraph
bootstrap cases. Run `npm run test:bootstrap:wide` for the required 1,000/5,000-
paragraph construction, bundle, cold-open and exact native reconstruction checks.
The wide command enables `MULTIWRITER_BOOTSTRAP_WIDE=1`, logs sizes/timings and
uses a separate 60-minute per-case deadline. These reference replay checks can
take minutes; they are explicit workloads, like the repository's extensive parser
and canonical-history checks. A normal Node pass does not claim that they ran.
