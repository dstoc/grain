# Draft ownership reference reducer

`reduceOwnership()` replays raw cell ownership with the existing native tape and
layout modules. It preserves authored run skeletons while assigning each refined
native cell to one run and occurrence. It reads native data and performs no
shared writes.

**Status:** incomplete implementation for grain/85. The `empty-source-gap` issue
artifact demonstrates that concurrent split components and later transfers can
leave an addressable flow with no independently editable cell. The approved
proposal requires a stop at this encoding gap. Generated seed `34064` remains a
positive failing regression. Do not treat this draft as MW-04 acceptance.

## Inputs and queries

Supply the same complete, validated ready closure to all layers:

```ts
const result = reduceOwnership({
  genesis, // LayoutGenesis: allocations and node-to-birth-occurrence bindings
  actions, // LayoutActionInput[], including inactive allocations
  snapshots, // NativeTapeCache.snapshot(tape) for every ready tape
  homes, // explicit initial CellAssignment intervals from each tape's birth batch
  isActive, // effect activity from history/visibility, in original priority
});
```

Home bindings must cover each tape exactly once, use retained birth endpoints,
and identify the home run and its birth occurrence. Overlapping split and
transfer skeletons do not establish home ownership. This draft requires one
root run per flow; transfer runs retain their destination occurrence locations.

`assignments`, `runLayouts`, `flowPlacements`, `blockPlacement()`, and `children()`
return detached raw facts. `raw(flow)` walks retained skeletons and occurrence
locations, including ghosts, and emits cells only at their effective assignment.
It includes empty cells, exact native text fragments, slots, and attachment
locations. An inactive transfer location can lead to later active followers
without assigning the transfer's cells or asserting a flow edge.

`resolveSlot()` preserves the run, boundary, side, and predecessor.
`owner()` maps one native UTF-16 identity to its cell assignment without slicing
characters. `contains()` checks permanent-range membership for that identity.
`tokenOwners()` and `inlineOwner()` accept complete native text ranges; they
reject ranges that split surrogate pairs. `destinationRequirements` identifies
effective destination/scaffold needs by original action/effect reference.

## Integration obligations

Readiness, author-closure certification, and group activity remain upstream.
Results do not filter deletion, hide absorbed headers, normalize Markdown, or
provide a replica factory. The visibility adapter must derive
`containsBirthContent()` from each node's birth-causal intervals and retain that
coverage through later transfers. Current ownership is not birth coverage.

Structural replay cannot allocate native endpoints to rescue a source. The
current safeguard rejects a transfer when it leaves a source with no assigned
cell. The attached counterexample shows why this safeguard also rejects some
independently valid ready sets. A reviewed allocation or semantic contract is
needed before implementation can continue.

Run the focused controls with:

```sh
npm run test -- src/markdown/multiwriter/ownership/
```

The corpus-facet tests compare actual native ownership, layout, and authored
skeleton coverage. Empty-only ranges have separate native assertions; the
existing split-at-zero symbolic fixture omits its empty run from `skeletons`.
These tests do not implement action-store readiness, visibility, projection,
full history, or MW-08/MW-16 composition gates.
