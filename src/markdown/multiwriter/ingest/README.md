# Validate and publish schema-3 actions

MW-15 (`grain/96`) keeps malformed actions out of derived native state and makes
local resource pressure retryable. Use these headless APIs with the actual
reducer-owned author checks. The schema-2 demo does not use them.

## Configure certification

```ts
import { ActionStore } from '../actions/index.js';
import { createIngestValidator } from './index.js';

const validate = createIngestValidator({
  genesis, // Common NativeBody, including semantic genesis allocations.
  validateAuthor, // MW-04/MW-06 author-view validation; never a success stub.
});
const store = new ActionStore({
  documentId: 'document-123',
  genesisId: 'genesis-789',
  genesisAllocations: genesis.allocations,
  validate,
});
```

Certification uses exactly common genesis, the ready dependency closure and the
candidate's own births. Concurrent live caches cannot supply missing origins.
Successful certificates compare immutable envelope bytes and dependency facts.
An exact causal append reuses its private native branch. Other branches can
reconstruct it; `validate.destroy()` discards that derived cache and certificates.
Call `store.destroy()` before disposing its validator.

The built-in checks cover native body/manifest agreement, insertion origins,
permanent markers, Unicode boundaries, exact native ranges, allocation
consistency and existing history-owner rules. Structural allocations and effects
require `validateAuthor`. An absent hook throws `MissingAuthorValidatorError`.
This checkout has no MW-04 ownership or MW-06 projection implementation. Those
checks must be integrated before structural actions can be certified. Test
callbacks in storage/transport tests do not provide that integration.

The hook receives detached actions/dependencies and a read-only native facade.
It returns `null`, a deterministic quarantine reason, or a `Work` generator of
that result. It must validate the author's view without mutating external state.
Use generator visits for expensive work. Unexpected failures must throw; do not
convert them to data errors.

## Finish work across slices

```ts
let result = store.compute(10_000);
while (result.state === 'deferred') {
  await yieldToHost();
  result = result.continuation.resume(10_000);
}
const snapshot = result.value;
```

A deferred result has no snapshot or shorter ready set. Each continuation is
single-use. `cancel()` releases its private work. A receipt, replacement
computation, synchronous `snapshot()`, limit change or store close invalidates
outstanding work. Start a fresh computation after invalidation.

Work charges envelope values, container completions, 1 KiB payload chunks,
dependency/resource visits, native items/origin walks and reducer-owned visits.
Yjs decode/integration, schema conversion, sorting and detached result copies
are indivisible operations after the corresponding visits. These are work units,
not a hard memory or wall-clock sandbox. `snapshot()` drains the same reference
calculation synchronously. MW-13 owns the production incremental replay path.

Default local policy uses 64 CBOR container levels, 100,000 decoder visits per
carrier message, envelope or native update, and 10,000 readiness visits per slice.
The decoder guard runs before the downstream Yjs decoder or schema conversion. `IngestCapacityError` identifies
the stage, limit and minimum required capacity. It is retryable and never a
quarantine reason. Raise `store.setDecodeLimits({ depth, operations })` and retry
held facts or the refused update. Native certification accepts `decodeOperations`
at construction and `validate.setDecodeLimit(operations)` for retry. Cancel an
outstanding computation before changing or destroying its validator. A standalone
`NativeTapeCache` and the reference publication accept the same optional decoder
capacity in their constructor. Limit changes do not delete canonical bytes.
Repeated nonempty continuation slices advance the cursor; a capacity error needs
a larger configured limit rather than another identical slice.

The update-v1 preflight recognizes the pinned Yjs 13.6.33 carrier and native
insertion subset. It checks lengths, safe counters, permitted roots/content and
append-only storage before Yjs decode. Outer rejection changes neither canonical
state nor persistence. Invalid admitted envelopes remain held for diagnostics,
exchange and deterministic quarantine. Missing dependencies remain pending.

## Publish one complete result

`IngestPublication` is a reference boundary for the real integrated reducer:

```ts
const publication = new IngestPublication(store, genesis, reduce);
let result = publication.refresh(10_000);
while (result.state === 'deferred') {
  await yieldToHost();
  result = result.continuation.resume(10_000);
}
// One result owns matching native state, heads, reducer state and edit addresses.
const completed = result.value;
```

`reduce(actions, native)` must be a generator returning reducer state, projection
and addresses together. No candidate native state escapes before it finishes.
A failed or deferred refresh leaves the previous publication visible through
`status()` with explicit `stale` and `canAuthor` fields. Check this status before
starting an edit. A late fork prevents authoring against withdrawn facts until
reconstruction completes. An unrelated pending branch does not invalidate an
otherwise current publication. Received ready work must be published before
further authoring. A receipt invalidates outstanding continuations. Dispose the
publication with `destroy()` before destroying the store.

This class deliberately performs reference replay. It supplies no ownership,
normalization, address algorithm, local compiler or browser cutover. MW-08 must
supply the real reducer and run the three-replica fault matrix. MW-13 performance
and MW-16 end-to-end/mobile acceptance remain separate gates.

## Admission and verification

Use the [directional provider](../providers/README.md) for every remote route.
It gates mode, message size and outstanding persistence capacity before copying
or importing a message. Admitted unresolved raw bytes remain durable even while
envelope computation is deferred. No limit permits pruning canonical history or
expiring offline replicas.

Run focused tests with:

```sh
npm run test -- src/markdown/multiwriter/
npm run test:browser -- src/markdown/multiwriter/providers/
npm run build
```

The ingest tests use real independently authored common-genesis native bodies,
malformed CBOR/update prefixes, seeded mutations, closure violations, small
budgets, continuation invalidation and late forks. Publication probes use an
explicit test reducer and do not establish MW-08 composition acceptance.
