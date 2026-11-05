# Native materialization and command overlays

The opt-in materializer reuses ready native bodies and keeps old publications
readable while preparing the next view. It also avoids building an isolated
command tree for literal input. This is the first implementation stage of
[grain/94](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/94), not completed
MW-13 acceptance. Readiness uses a dirty dependency index; author closure
construction, detached snapshot exports and semantic projection retain full-state
costs.

Open through the existing bootstrap API with a local implementation choice:

```ts
const replica = await openBootstrap({
  genesis: genesisBytes,
  persistedGenesis: genesisBytes,
  journal,
  mode: 'bidirectional',
  materialization: 'incremental-native',
});
```

The default remains `reference`. Unknown implementation names fail before journal attachment. The choice is absent from genesis, action
envelopes, bundles and provider settings. Both implementations certify against
exact author closures. `openReferenceDocument()` and `projectMarkdown()` remain
independent full-replay oracles.

## Readiness

The optimized document uses `IndexedActionStore`. It shares the private decoded
fact collection with `ActionStore`, whose full readiness calculation remains the
independent reference. New payload variants invalidate their identity and the
transitive reverse dependency closure. Missing identities retain waiters. A later
arrival can release pending descendants; a later fork withdraws ready descendants.
Independent branches retain their successful exact-fact certificates. Duplicate
payloads do not trigger readiness evaluation.

Intrinsic failures and known noncausal edges are established before dependency
propagation. Candidates then use the same semantic order and failure precedence
as the reference. Cancellation retains the dirty closure until evaluation finishes;
no partial ready result escapes. Changing decoder limits cancels suspended work.
Public snapshots and validator arguments remain detached from retained facts.

`store.readinessDiagnostics()` reports changed facts, evaluated entries,
dependency and closure edges, author checks and full snapshot builds. Unchanged
facts reuse the existing exact-version snapshot memo; public reads still clone it.
A causal suffix append evaluates one new entry; an exact duplicate evaluates none.
This does not eliminate full closure construction for a new author check, full
snapshot export or full semantic projection. Those costs remain acceptance gaps.

## Publication and cancellation

`MaterializedPublication` applies each newly ready native body once. It does not
require the new ready sequence to extend the old semantic-order array: an earlier
concurrent arrival can integrate without reapplying old bodies. If an integrated
payload is withdrawn or replaced, it rebuilds the private native cache from the
remaining exact ready set. Conflicting variants remain in canonical storage.

A publication owns immutable AVL roots for tape snapshots and marker bindings.
Updating a touched tape copies map paths and rebuilds that tape's native-ID index.
Old numeric, range, lookup, marker and snapshot reads retain their old meaning.
`encodeState()` reconstructs the exact published native bytes on explicit request;
that diagnostic is outside ordinary editing work.

Cancellation during native indexing discards the private integration cache. It
leaves the previous publication intact. Cancellation after indexing can retain
complete unpublished native bodies for the next refresh. The readiness check
removes any subsequently withdrawn bodies before reuse. A deferred or failed
publication does not grant authoring from partial state.

An unchanged refresh returns the same complete tuple. Duplicate receipts and
unrelated pending branches can retain authoring after readiness confirms that the
published exact ready set is unchanged. Status reads do not replace an in-flight
readiness calculation.

## Commands and maintenance

`LocalEditor` accepts a narrow `AuthoringDocument` interface. The opt-in document
requests command overlays; the reference document keeps the existing command
path. Literal drafts keep touched text in an action-local overlay. Native planning
loads tapes on demand and uses the published base projection before the first
change. A structural operation constructs the established isolated tree and
replays earlier overlay text before continuing. Intermediate semantic changes
still use full projection when needed.

Large callers can supply a local native decode capacity when constructing
`LocalEditor`:

```ts
const editor = new LocalEditor(document, genesis, {
  nativeDecodeOperations: 10_000_000,
});
```

`MaterializedPublication.evict()` releases private native integration state. The
active publication stays readable and current; subsequent growth reconstructs its
native integration cache. Eviction writes no canonical data or journal entries.
It does not consolidate storage. MW-18 consolidation remains a separate API and
integration gate.

## Work counters and limits

`diagnostics()` returns cumulative counts. They include attempted work, including
tape indexes completed before a later cancellation:

- `nativeBodiesIntegrated`: completed native-body/index applications, including
  genesis and new empty native bodies; old ready bodies are skipped.
- `tapesIndexed` and `partsIndexed`: complete touched tapes and their Yjs parts.
  Long tapes are still rebuilt as a whole.
- `nativeRebuilds`: rebuilds caused by ready-payload withdrawal or replacement.
- `discardedNativeCandidates`: interrupted or failed native/index applications.
- `fullProjections`: calls to the full semantic projection fallback.
- `unchangedRefreshes`: refreshes that reused the complete publication.

This stage does not meet the complete ordinary-input work gate. Detached readiness exports
and certification still enumerate or clone closures; semantic projection still
rebuilds the view. Command preparation still indexes projected handles and scans
allocation/manifest metadata. Structural suffix replay, reducer checkpoints,
affected-container projection and stable unaffected view/address identity remain
required by the approved proposal. No 10,000-action, production-history or
consolidation performance pass follows from these counters.

The next implementation steps and full acceptance requirements are in the
[approved proposal](proposals/2026-11-05-mw13-incremental-materialization.md).
[The benchmark runner](../benchmarks/multiwriter/README.md) retains exact fixtures
and separates complete replay checks from timing.
