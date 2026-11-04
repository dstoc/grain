# Multi-writer visibility and retraction

MW-05 implements the pure reference visibility algebra for **grain/86**, from
§7 of the approved proposal attached to grain/81. The shared schema-3 wire types
remain in `src/markdown/multiwriter/contracts.ts`. Yjs remains pinned to 13.6.33.

The entry point is `src/markdown/multiwriter/visibility/index.ts`. This module has
no Yjs, browser, authority, parser, persistence, or local history dependency. It
neither changes the current editor nor implements the MW-08 composition gate.

## Activity before layout

Call `reduceActivity(readyEnvelopes)` with an immutable, unique, fully validated,
dependency-closed ready set. It returns all retained actions and the active
editable effects in their original `(lamport, actor, sequence, ordinal)` order.
Allocations, insertion bodies, markers and inactive actions remain available.
Reactivating an old move preserves its old priority. An ineffective structural
intention does not deactivate an unrelated insertion in the same action.

Controls must come from the target group's actor and session. They must observe
the complete target group and extend its previous control chain. The first control
seals group membership. A control contains only `SetGroupActive`: no allocations,
native bodies, or other effects. Controls cannot themselves be retracted.

Malformed controls and incomplete input throw before a result is returned. The
action-store/ingest layer must validate history rules in the author's dependency
closure and quarantine invalid actions and their dependents before supplying a
ready set. This reducer does not choose between forked payloads or implement
pending queues. Duplicate network envelopes must already have been deduplicated.

`isActive()` resolves group activity. `isEffectActive()` additionally excludes
controls and validates the effect ordinal. `observes()` and `concurrent()` use
transitive dependencies, independent of arrival and semantic tie order.

MW-03/04 must reduce the active layout effects while retaining every allocation
and permanent anchor. Deletion must not remove raw edges, change cell ownership,
rescue a transfer, or make an unsafe move safe.

## Visibility after layout

Call `reduceVisibility(activity, layout, tokens)` on that same ready set. Tokens
are unique native text units from verified manifests, with their birth action;
shared-genesis tokens have a null birth. Permanent boundary embeds are excluded.
Native clocks count UTF-16 units. Grapheme navigation and Unicode validation
remain outside this layer.

`VisibilityLayout` supplies these queries:

| Query                               | Required meaning                                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodes`                             | All retained node allocations, including inactive births and their immutable birth slots.                                                                                               |
| `parent(node)`                      | Current raw effective parent, before deletion or normalization.                                                                                                                         |
| `owner(token)`                      | Current inline owner through cell, run and flow ancestry, including hidden text.                                                                                                        |
| `requirements(node)`                | Effective placement or layout effects that require the node as a scaffold. Exclude losing/unsafe intentions, obsolete anchors and birth fallbacks.                                      |
| `contains(interval, token)`         | Membership inside the permanent open marker boundaries in converged native order. Include later native insertions within them.                                                          |
| `containsBirthContent(node, token)` | Membership in the intervals initially owned by a concurrently born node in its birth action's causal view. Include later insertions inside those boundaries, regardless of final owner. |

These callbacks are read-only. Their adapters belong to MW-02–04; supplying final
numeric offsets or current ownership as captured interval membership is invalid.
The birth-content query prevents a concurrent child from escaping inherited
deletion by transferring its initial content elsewhere.

Text is visible at this layer only when its insertion action is active, no active
text/subtree tag covers it, and its final destination has no deleted raw ancestor.
An exact `DeleteText` tag selects only recorded native client/clock ranges on the
recorded tape. It never expands to unseen concurrent insertions. A subtree tag
covers the recorded nodes and open intervals through subsequent ownership
changes. Coverage already excludes content causally moved out before deletion.
`joinedFlows` records captured context; the captured intervals include its owned
content. Final membership in a named flow is not a replacement for that coverage.

An unobserved node inherits a tag only when its immutable birth parent is covered
and its birth is concurrent with the delete action. This propagates through
concurrent descendants. It never uses a split's historical source as a parent.
A birth that observed an undo is causally after the delete and acquires no
permanent inherited tag, including when the delete is later reactivated. Placement
under a currently deleted ancestor still hides that node.

An undone birth is suppressed when no surviving content, child, or effective
layout requirement needs it. Otherwise its creation placement remains a scaffold.
Explicit deletion always wins over this scaffold rule. Active empty births remain
available; projection owns any suppression of empty derived split headers.

Results retain the input token order and original token identities. Node results
report direct/inherited tags, effective deletion, suppression and scaffolds.
`available` means the node passes this layer; MW-06 can still absorb a joined
header, apply interpretation packet masks, lift children and normalize the view.
Text results report insertion activity, covering tags and deleted destinations.
No projection or allocation is generated here.

## Verification and remaining gates

Run:

```sh
npm run build
npm run test -- src/markdown/multiwriter/visibility/
```

The unit suite checks control ownership/chains, sealed groups, complete retraction,
original effect priority, duplicate-delete undo, exact native ranges, captured
coverage, causal escapes, concurrent birth propagation, post-undo births,
deleted destinations and weak birth suppression. An overlapping-delete oracle
checks all eight three-tag retraction states and all input permutations. Tests
also verify that inputs and raw placement remain unchanged.

A pinned-Yjs test uses separate native caches, actual insertion updates and native
IDs. It checks duplicate delivery, selective delete undo/redo, unseen insertion
survival, transferred subtree masking and fresh native reconstruction. The
structural unit fixtures supply synthetic marker/ownership queries. They do not
execute the actual placement or ownership reducer.

MW-08 must compose the real action store, native adapter, layout, ownership and
projection on independent replicas, run the complete MW-00 corpus and compare
fresh replay. MW-10 owns local group selection, bounded navigation stacks, scoped
history, redo preservation and selection restoration. MW-13 owns incremental
indexes and performance. This full reference implementation deliberately stores
transitive causal sets and scans tokens/deletions; it is not the production
per-keystroke path or a performance claim.
