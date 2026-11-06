# MW-13A: structural locality decision and execution contract

Grain's current split replay does **not** commute with every later native marker
subdivision. The counterexample below changes ownership and visible text. Keep
the independent reference and production reader guard. This investigation does
not change split semantics, enable a fast path, or complete grain/94.

This document records grain/102's outcome for review. The shared plan is
`structural-execution-plan` v1 on grain/94, SHA-256
`e63457a69a187e962b053452e1072ba24a630569ae43c4b676de13aa44b3adc7`.
Proposal v1 was approved in `cmt_LPbVuXpQH0YowEbu`. Parent integration ownership
and PR #88 remain unchanged.

## Reproduce

Use Node with `module.registerHooks`, installed dependencies (`npm install`),
and Yjs 13.6.33. Run on an idle host:

```sh
node benchmarks/multiwriter/structural-locality.mjs --output /tmp/mw13a-results
```

The destination must be new. `--case root`, `tasks`, `100`, or `1000` selects a
smaller diagnostic. Each worker has a five-minute limit. Failure or interruption
leaves `complete: false`; a stopped worker is incomplete evidence. The command
retains exact input containers, newly generated carriers, reports, and logs.

The old 100- and 1,000-action inputs share the exact task genesis but come from
different captures with different actors. The 100-action input is not a prefix
of the 1,000-action carrier sequence. Original capture source SHAs remain
unknown. `test/multiwriter/fixtures/structural-locality/provenance.json` preserves
the source artifact names, versions, hashes, schedule, and this provenance gap.
The runner records its own source SHA separately. These are restored diagnostic
inputs; none is an uninterrupted long-run result.

Each managed continuation splits a paragraph, types in both halves, joins them,
edits a distant paragraph in another session, undoes and redoes the join, then
types again. The deletion variant first deletes a distant paragraph through
`deleteBlocks`. It asserts the exact target and active `DeleteSubtree`; the task
wrapper remains canonical. Target lookup uses retained origins. The runner
checks exact selection restoration, the unrelated edit/deletion, prior-publication
reads, canonical/native retention, eviction, and continued typing after eviction.

## Minimal counterexample

Start with two paragraphs: `abc` and an empty paragraph. Keep their original
native identities and private homes.

1. Join the empty flow into the first flow at the retained slot after `b`.
   The empty home has only its permanent endpoints. Its sole cell is reserved.
2. Split the first paragraph after `a`, retaining the left side. The split author
   observes the join. Its basis contains `a`, `b`, and `c`, with the original
   occurrence binding. Both implementations show `a` / `bc`.
3. Append one valid native-only action that inserts two markers inside the empty
   home. The new middle cell is text-free but **not reserved**. It lies between
   the basis cells for `b` and `c` in the joined component.

The full reference replays the split against the new native subdivision. Its
content adjacency excludes only the two current reserved edge cells. The new
ordinary empty cell breaks the selected contiguous sequence after `b`.

| Observation                      | Checkpoint assignment subdivision | Independent full replay |
| -------------------------------- | --------------------------------- | ----------------------- |
| Original first flow              | `a`                               | `ac`                    |
| Split flow                       | `bc`                              | `b`                     |
| Original native identity for `c` | Split run                         | Original run            |
| Block order                      | Unchanged                         | Unchanged               |

This is not a cell-list formatting difference. The same original character `c`
has a different owner and visible position. A one-marker control creates two
reserved edge cells without an ordinary middle cell and preserves equivalence.
Three characters are needed to put the new separator between two selected basis
cells. Removing the join or second new marker removes this trigger.

`emptyHomeCounterexample()` in `test/multiwriter/structural-refinement.ts`
constructs and certifies all three complete actions at their exact author
closures. The join uses the public canonical admission boundary with an original
occurrence allocation; the split uses managed public authoring; marker preparation
uses `NativeTapeCache.prepare()`. No invalid hand-built cell list or final-owner
copy is used. The dedicated command archives the exact genesis, actions, canonical
bytes, mapping, and both observations in `counterexample-{1,2}.bin` and
`classification.json`. A fresh independent document verifies the production
result. No semantic code or oracle was amended to make this case pass.

## Classification and proposed amendment

The proposed universal refinement law is false. Amend the optimization contract:

> Native identity/order preservation is necessary but insufficient. Reuse of a
> historical split also needs preservation of its **content adjacency**, including
> reserved-home classification, empty gaps, component ancestry, and cut ranking.

Preserve current semantics. A transition from a reserved old cell to ordinary
interior descendants is a semantic reader dependency when the home is traversed
inside the split's component, even if no visible text was inserted. Retain the
current replay frontier for this case. Changing empty-cell adjacency to make it
transparent would be a separate semantic amendment requiring approval. A does
not enact or require that alternative.

The native differential tests compare each checkpoint's **own** assignments with
fresh independent reconstruction. An explicit map sends each old interval to its
ordered refined intervals and retains old marker identities/sides. They compare
owners through this map, then complete raw flows, occurrences, normalized view,
visibility, old and new address resolution, and saved bookmarks. More address
entries are permitted. Equal text offsets do not identify distinct empty gaps.

| Class                       | Evidence and result                                                                                   | Required fallback or obligation                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Marker-stable text          | Replacement changes insertion/deletion visibility and preserves raw owners                            | Controls and deleted lineages still need semantic checks                                                         |
| Interior subdivision        | Both affinities; read and retained source intervals; mapped owners and full view match                | Do not infer safety for a changed component or home classification                                               |
| Split boundaries            | Both affinities at an original cut; old/new addresses and bookmarks match                             | Keep native marker identity/order and explicit side                                                              |
| Reserved-home edges         | Simple edge cases and one-marker empty-home control match                                             | Two-marker joined-empty counterexample disproves unconditional reuse                                             |
| Empty gaps                  | Consecutive markers retain distinct slots; undo/subdivide/redo and continued typing match reference   | Dormant decisions need renewed checks when controls reactivate them                                              |
| Joined/transferred ranges   | Original and ghost slots remain in raw traversal and full address comparisons                         | Inspect relevant joined tapes outside the authored basis                                                         |
| Inactive split readers      | Subdivision while dormant matches; production redo replays and matches reference                      | Inactivity cannot certify future reactivation                                                                    |
| Cohorts                     | Three native cuts, equal-cut ties, both deliveries, anchored follower, and explicit move              | Recompute mapped cut rank and changed cohort membership; equal-text cuts with different bases are not one cohort |
| Earlier concurrent effect   | Independent public writer's earlier join forces replay; blind checkpoint reuse rejects semantic order | Find a compatible earlier frontier; local append locality gives no remote bound                                  |
| Invalid mutation boundaries | Cross-tape/deleted addresses stay unavailable; exterior adjacency and surrogate-half insertion reject | Caret fallback and lineage availability do not authorize a mutation                                              |

The positive rows are bounded evidence, not a new universal proof. In particular,
these tests do not authorize suppressing the existing reader guard.

### Chosen next mechanism for B

Use **conditional subdivision of checkpoint-owned assignments**, with an exact
reader dependency on content adjacency and reserved-home classification. Index
ordered effects/resources so a known suffix does not first enumerate and sort
all retained actions. For each affected reader, preserve the old-to-new interval
map, content/reserved status, component traversal and boundary dependencies.
Update ghost addresses, coverage, and cohort ranking explicitly. Refine each
checkpoint's own assignments; never borrow final merged ownership.

If these certificates fail, or earlier order, activity, interpretation eligibility,
placement, resource withdrawal, or unknown component dependencies change, replay
from the first affected reader or an earlier compatible checkpoint. Keep a named
reason and its work count. B must bring this conditional rule and its implementation
through review. An unconditional marker-only fast path is ruled out. C can work
independently against the resource contract below. No B/C implementation starts
in this child.

## Shared candidate and change-set contract

This is a derived, local execution contract for B/C/D. Reuse existing `ReadySource`,
`NativeView`, `OwnershipCheckpoint`, `RangeRef`, and resource IDs. This does not
add a replicated type or a generic executor. Field names below identify required
meaning; a module can retain existing types that express it exactly.

| Part               | Required fields and obligations                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base               | Exact genesis bytes/identity; coherent publication identity; ready root with exact payload certificates; native read generation. Heads and counts alone are insufficient.                                       |
| Candidate identity | Exact action ID and encoded payload; private draft revision; exact author-closure/native evidence; merged-base identity separately. A draft query can advance the private revision without accepting an action. |
| Structural delta   | Ordered interval subdivision map and before/after assignments; run/flow/block/occurrence placements and ordering; affected tape/run/flow/container IDs.                                                         |
| Semantic delta     | Insert/delete activity; exact/inherited deletion contributions and tags; birth/interpretation eligibility; masks; projection origins; editable slots; normalization boundaries.                                 |
| Retractions        | Removed/withdrawn facts or resources, former and new locations, invalidated readers, negative dependencies, changed ghost addresses, and withdrawn slot availability. Absence is observable state.              |
| Prepared result    | Immutable candidate roots, exact validation evidence, change set, resolved managed selection, attempted/committed work ledger, and explicit fallback/frontier reason.                                           |

A candidate has one lifecycle:

1. **Prepare privately.** Queries can return immutable intermediate roots. They
   cannot install reader refinements, expose mutation addresses, or add history.
2. **Validate and stage.** Certify against the exact author's dependency closure,
   separately from merged-state derivation. Resolve managed selection against the
   exact staged author result before canonical append.
3. **Retain canonically.** Append the original payload once. Before this boundary,
   failure discards the candidate, aborts native preparation, and adds no history.
4. **Publish coherently.** Only the existing publication owner installs the native,
   activity, ownership, projection, and address tuple. Modules share prepared
   results and never independently accept or publish actions.

After retention, preserve `RetainedEditError`, the original action ID, and exactly
one history registration. Retry publication/persistence; do not compile and append
the user's command again. Reentrant observers preserve the existing behavior.

Reuse needs the same exact payload, relevant base/author closure, native generation,
and private revision. New ingress, cancellation, changed limits, eviction, payload
replacement, activity retraction, or a changed base invalidates the affected evidence.
Unrelated roots survive only through an explicit exact compatibility check. A rejected
or suspended candidate cannot publish partial changes. Old published roots stay
readable. Certificates are local derived evidence, never peer-supplied exemptions.

Two paths have different obligations:

- **Local causally subsequent append:** coherent base → private command/query work
  → exact-author certification and selection staging → canonical retention → one
  publication. Only a reviewed compatible refinement class reuses old decisions.
- **Late/concurrent remote delivery:** retain original carrier bytes → establish
  readiness and the remote author's exact closure → certify there → find the merged
  semantic frontier → replay/refine and publish. Earlier arrivals, controls, changed
  component ancestry, and negative dependencies can require a larger suffix or cold
  replay. Record the reason. Local append cost is not a bound for this path.

The dedicated command creates independently opened public writers, performs a real
unrelated local edit before a split, authors the remote join at the original closure,
and delivers both carrier orders, an unresolved prefix, and duplicates. It verifies
exact canonical/native convergence and independent semantic reconstruction.

## Measurement boundaries

`trace[].wallMs` is one complete public edit/navigation call. Wall-only and
instrumented samples use separate fresh workers over the same original inputs.
Their newly authored native identities differ; each output is checked against its
own reference. The runner preserves those carriers and hashes.

`exclusive` records raw synchronous spans, invocation counts, retained-work counts,
and resource IDs. A stack charges only the innermost phase. Generator resumes and
return cleanup execute inside their phase; suspension time belongs to the driver.
The injected-clock tests cover nesting, observer reentry, throws, suspension,
cleanup and disabled diagnostics. Disabled execution performs no clock reads and
retains no recorder, trace, counters, or resource sets.

The phases are draft/query, native preparation, exact-author certification,
coupled replay, visibility/normalization, selection/address resolution, canonical
append, publication, and uncategorized driver overhead. Purpose is author, staging,
publication, or driver. Exact-author certification excludes nested replay/native
work in the exclusive report. `inclusive` retains existing public API durations;
these can nest and must never be summed into an exclusive total.

Work counts include attempted computations. Separate commit counters and the
existing last-committed frontier identify publication results. The ledger exposes:

- Full action materialization/deduplication/sort inputs and comparator calls before
  `replayOwnershipSuffix()`; cloned layout actions, allocations/effects and causal
  edges; author closure materialization/sorting/cloning and exact byte comparisons.
- Structural effects and retained candidates inspected; cell ranges, raw flows,
  runs, occurrences, home/skeleton/resource reconstruction and native tape parts.
- Full command trees, provenance/projector/visibility/deletion-index constructions;
  indexed visibility entries, inherited coverage/ancestor visits, view/address
  records, command indexes, native index copies and container rebuilds.
- Resource identities for rebuilt tapes/containers and traversed flows. These are
  source-level operations, not a JavaScript/Yjs heap allocation census. Several
  counters deliberately describe separate passes over the same retained facts.

`coldLoadMs`, independent-oracle cold setup/check costs, carrier merging, and
post-eviction work remain separate. Independent checks retain only their own exact
reference author certificates; native, provenance, ownership and semantic projection
reconstruct through the reference path. Persistence is explicitly unmeasured because
no journal is attached. No browser, physical storage, memory-scale, or uninterrupted
10k claim follows from this diagnostic.

## Verification and measurements

Final source-scoped results and command output are attached to grain/102. Reports
must identify their exact tested source, current parent heads and input hashes.
No upper percentile is inferred from this handful of operations. Review the raw
short samples, exclusive totals, full-input work and fallback reasons together.
