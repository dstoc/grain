# Incremental materialization

The opt-in materializer reuses native bodies, readiness certificates and document
state between edits. It preserves readable old publications while preparing the
next one. It remains an unfinished implementation of
[grain/94](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/94). The reference
reader remains the default, and browser cutover requires separate acceptance.

## Open a replica

Choose the implementation through the existing bootstrap API:

```ts
const replica = await openBootstrap({
  genesis: genesisBytes,
  persistedGenesis: genesisBytes,
  journal,
  mode: 'bidirectional',
  materialization: 'incremental-native',
});
```

Keep and distribute the exact genesis bytes. The local implementation choice is
absent from genesis, action envelopes, bundles and provider settings. Unknown
implementation names fail before journal attachment. Both readers certify actions
against their exact author closures. `openReferenceDocument()` and
`projectMarkdown()` retain independent full reconstruction.

Large callers can set native decode capacity when constructing an editor:

```ts
const editor = new LocalEditor(document, genesis, {
  nativeDecodeOperations: 10_000_000,
});
```

## Reuse and fallback behavior

`IndexedActionStore` evaluates changed facts and their reverse dependency closure.
Missing dependencies retain waiters. Late variants can withdraw ready descendants;
independent branches retain their exact-fact certificates. Public readiness
snapshots remain detached exports. Private ready roots let ordinary commands avoid
exporting those arrays and cloning complete closures.

Activity, placement and ownership use persistent roots. Each reducer saves a
checkpoint every 128 actions and retains up to eight historical checkpoints.
Exact payloads and prior decisions determine compatibility. Controls invalidate
older targets; changed native read intervals can invalidate earlier splits.
Placement and ownership resume together in semantic order. Unknown compatibility,
marker withdrawal and reordering retain conservative replay.

Newly ready native bodies integrate once. Immutable native indexes copy paths for
the affected final Yjs items, including retained text merged into those items.
Marker-stable text can reuse cell topology. Native position discovery, marker
refinement and affected-tape text ordering can still traverse retained data.
Explicit snapshot exports and `encodeState()` diagnostics pay for detached full
results; they are outside the intended ordinary-input path.

Literal input, exact deletion/replacement and checked/info changes have local
projection paths under their eligibility checks. Unchanged fragments, addresses
and unaffected view records can retain identity. General structural, subtree
visibility and interpretation changes retain full projection fallbacks over the
coupled ownership result. Materialized structural visibility indexes active exact
text-deletion ranges; the reference path scans those declarations independently.
Subtree coverage, tag order and normalization keep their shared semantic rules.

Commands use action-local text overlays. Registered immutable native publications
answer untouched planned reads directly; the first write loads that tape's
snapshot. Arbitrary native facades keep snapshot behavior. Structural commands
still construct the isolated command tree when needed. Private command queries
fork committed activity/ownership roots, and managed selection is staged before
append. Structural drafts and general affected projection remain acceptance gaps.

## Publication and maintenance

A publication contains one coherent ready set, native view, ownership result,
legal view and editing addresses. Candidate roots commit together. Failure,
cancellation or changed receipts leave the prior tuple intact. Deferred work does
not authorize editing from partial state. Duplicate receipts and unrelated
pending branches can preserve authoring after readiness confirms the same ready
set.

`MaterializedPublication.evict()` releases rebuildable readiness, certification,
native and reducer caches. The active immutable publication stays readable.
Subsequent growth rebuilds the required caches. Cache eviction writes no canonical
data or journal entries. If an integrated payload leaves readiness, the native
cache rebuilds from the remaining exact ready set; canonical variants remain.

MW-18 lossless journal consolidation is a separate provider operation. It does not
prune actions, replace genesis, expire an offline replica or reset a live writer.
Its integration evidence does not replace dependency review and merge.

## Inspect work

Diagnostics are cumulative and include attempted work from cancelled candidates.
They report work and retained counts, not heap or persistence sizes:

- `store.readinessDiagnostics()` reports changed facts, evaluated entries,
  dependency/closure work and detached exports.
- `document.activityDiagnostics()` reports payload comparisons, replayed actions,
  causal-frontier work and checkpoint reuse.
- `document.ownershipDiagnostics()` reports coupled suffix length, checkpoint
  restores, native-reader invalidations, tape reads and resource/coverage work.
- `document.projectionDiagnostics()` reports full/local projection counts, replaced
  records, text-tape work and exact-deletion index/query work.
- `document.commandOwnershipDiagnostics()` reports unpublished command-query work.
- `document.publication.diagnostics()` reports newly integrated bodies, affected
  tape/item indexing, exceptional rebuilds and unchanged refreshes. An affected
  final Yjs item can contain retained text.

Full snapshots, explicit native exports and public inventories can be expensive.
Counters do not establish latency targets, total/shared/peak cache memory or a
completed 10,000-action trace. See the
[implementation status](mw13-materialization-status.md) for exact tested sources,
measurements and outstanding gates. The
[approved proposal](proposals/2026-11-05-mw13-incremental-materialization.md) defines
acceptance, and the [benchmark guide](../benchmarks/multiwriter/README.md) explains
fixture reuse and measurement scope.
