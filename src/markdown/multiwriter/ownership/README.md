# Ownership reference reducer

`reduceOwnership()` assigns every retained native cell to one run and occurrence.
Splits select contiguous components in the current flow layout. Joins preserve
whole flows. Transfers preserve native text identities and authored range order.
Replay reads native snapshots and allocates no shared data.

The implementation follows [grain/85's approved home convention](../../../../docs/proposals/2026-11-04-mw04-ownership-algebra.md),
approved in issue comment `cmt_LZgff2jBdgMdcR2k`. The generated empty-source
regression at seed `34064` now passes. The frozen corpus correction remains
limited to the approved reverse-cut retained L skeleton; effective ownership is
still `ab/c/def`.

## Reduce a complete ready set

Supply one validated, dependency-closed set to native, layout, activity, and
ownership reduction. Include inactive allocations and every ready tape snapshot.

```ts
const result = reduceOwnership({
  genesis, // LayoutGenesis: allocations and retained node/birth bindings
  actions, // LayoutActionInput[], including inactive actions
  snapshots, // NativeTapeCache.snapshot(tape) for every ready tape
  isActive, // original effect priorities, from history/activity
});
```

Each flow has one root run. Its last skeleton range is its own fresh full private
home tape. Earlier ranges retain captured source content. `deriveHomes()` checks
this pairing from each birth batch. An optional `homes` input must equal those
bindings exactly. `result.homeBindings` returns the derived bindings.

The first and last refined cells of each home tape stay text-free and assigned
to its root. Structural captures use strictly interior endpoints. These reserved
cells remain in raw traversal but do not enter split bases or content adjacency.
Ordinary interior empty cells still participate. A transfer can therefore move
all source content while leaving an independently editable home.

Empty splits capture no content. They reuse the source root's trailing home
slot. Their cohorts use that retained source domain and authored outer gap.
Content cohorts use the original ordered basis and gap. Equal cuts sort by
ascending effect order inside a cohort; MW-03 ranks distinct cohorts and ordinary
followers by descending unit priority. Later source text does not reclassify a
recorded empty split or become its captured content.

`assignments`, `runLayouts`, `flowPlacements`, `blockPlacement()`, `children()`, and
`homeBindings` return detached values. `raw(flow)` includes exact text fragments,
empty cells, ghost slots, and attachment locations. `resolveSlot()` preserves the
original run, boundary, affinity, and predecessor. `owner()`, `tokenOwners()`,
`inlineOwner()`, and `contains()` query native identities and permanent intervals.
Text range queries reject surrogate-pair splits.

## Certify before readiness

Use the ownership adapter through MW-15's exact-author native validator:

```ts
const validate = createIngestValidator({
  genesis: nativeGenesis,
  validateAuthor: createOwnershipAuthorValidator({
    genesis: layoutGenesis,
    births: retainedBirthBindings, // MW-03 node/occurrence bindings for an envelope
  }),
});
```

`births` must derive deterministic bindings from retained allocations and effects.
A `SplitFlow` explicitly names its new node and birth occurrence. The adapter
checks the binding against the retained slots and private home. It does not
invent bindings by allocation order. Validate the host's genesis before opening
an editable document.

The adapter uses only MW-15's isolated dependency closure plus the candidate.
It checks home uniqueness, interior captures, non-overlapping skeletons, authored
basis occurrences and captured components, and canonical empty cuts at each
effect prefix. Nonempty basis cells must follow the cut source's current top-level
content traversal in adjacent order, including joined flows. Only reserved home
cells leave this adjacency check. An empty basis must omit no ordinary content
cell, including joined or text-free interior content. The new root captures no source content.
Same-action dependent splits must follow their source's creating effect.

Native manifests must leave text-free home edges. Edge typing also needs two
interior markers allocated by that author action, even when one new marker would
make the final edges text-free. `HomeIndex.planTextInsertion()` returns native operations
for an explicit slot and brackets the whole string when the adjacent cell is
reserved. Both queries use the same snapshot. The caller owns the marker
allocator, publication transaction, native insertion identities,
and selection mapping. Prefer an ordinary content slot for continued typing;
use the flow's own trailing home slot after evacuation. Old ghost addresses
continue to address their original cells.

`certifyOwnership()` exposes the ownership-only checks for an already isolated
author closure. It does not replace native manifest certification. Never run
these author-local checks against a merged cache: later concurrent text and
ownership can differ from the author's valid view. `reduceOwnership()` replays
certified facts without repeating author-local emptiness or ownership checks.

## Verify and integrate

Run the owned controls with:

```sh
npm run test -- src/markdown/multiwriter/ownership/
```

The tests compare raw ownership, retained skeletons, slots, native identities,
component order, independent native reconstruction, and exact-author readiness.
They include real ActionStore exchanges and owner group control envelopes.
The 501-group retention control preserves complete native facts and accepts an
old-checkpoint writer; it does not simulate history-limit eviction.

The adapter supplies ownership/home validation. Compose it with MW-06's remaining
projection/address validation. MW-09 must lower real commands using the same
home/capture convention. MW-05 must derive `containsBirthContent()` from each
node's birth-causal intervals, including home text, rather than current ownership.
`destinationRequirements` identifies effective scaffold needs by original effect
reference; deletion masks and visibility remain separate.

These controls do not provide the MW-08 replica factory, MW-10 history navigation,
normalized Markdown projection, MW-13 incremental replay, or MW-16 browser gate.
They do not establish the combined algorithm's acceptance. A persisted rollout
requires the approved capability/version agreement. This change introduces no
wire field, migration, mixed-convention writer support, canonical pruning, or
old-replica expiration.
