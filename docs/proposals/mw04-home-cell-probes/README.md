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
