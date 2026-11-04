# MW-04 private-home native encoding controls

Run from the Grain checkout with dependencies installed and Node 26:

```sh
node docs/proposals/mw04-home-cell-probes/probe.mjs > /tmp/home-cell-results.json
```

The script prints the exact native manifests and 21 passing assertions. It uses
Yjs 13.6.33 through `NativeTapeCache`. Each author starts from the same genesis.
The six independent body orders preserve the original suffix captures while
adding separate empty native home tapes. Later controls test concurrent bracketed
Unicode typing, interior recapture of all home text, and fallback typing outside
that capture. The whole-tape negative control explains why separate tapes alone
are insufficient. Duplicate complete ready bodies reconstruct identically.

These are native encoding controls. They supply no ownership assignments and do
not run semantic reduction, action envelopes/readiness, flow layout, history,
visibility, or the combined replica algorithm. Later dependent bodies are applied
only after their native prerequisites. No full reducer proof is claimed.

The adjacent MW-04 proposal specifies binding, ordering, capture restrictions,
reserved-cell contiguity, retraction behavior, alternatives, and required positive
acceptance tests. Those rules are proposed for review. Production code and the
positive failing seed `34064` remain unchanged.

`resolve-ts.mjs` registers a Node source resolver for this repository's `.js`
imports in TypeScript. It affects this standalone probe process only.

## Empty-basis cohort revision

With the same prerequisites, run:

```sh
node docs/proposals/mw04-home-cell-probes/empty-cohorts.mjs > /tmp/empty-cohort-results.json
```

Expect JSON with `checks: 74`, the passing control names, exact native bodies,
and logical layout inputs. The probe tests the two-generation empty-source
ordering witness, same-source start/end cuts, repeated empty splits, both
semantic actor orders and relative native author-client orders, all six ready
body orders, all 16 activity subsets, duplicates, later home typing, and fresh
native reconstruction. It asserts full block order and distinct home/slot IDs.
Equal empty cuts reuse the same source marker; changing native-client order does
not give them different native cut positions.

This probe feeds real native snapshots to `CellIndex` and real layout inputs to
`LayoutPrefix`. Its `proposedBuckets()` function models the proposed rule locally.
It supplies no ownership assignments, certified action envelopes, or history
controls. Activity inputs do not test history navigation. Later typing tests
native/domain stability, not text ownership or visibility. Runtime cohort and
ownership code remains unchanged. The proposal's certified authoring, reducer,
history, and MW-08 acceptance tests remain required after proposal approval.
