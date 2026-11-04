# Proposal: Compose the independent multiwriter reference gate

**Status:** Proposed for grain/89; no integrated acceptance result yet.

**Authority:** The proposal attached to grain/81, version 2, especially §§4–8,
12–14; the approved MW-04 private-home contract recorded on grain/85. The
superseding amendment removes old saved-document conversion only. This proposal
preserves the other contracts and does not authorize browser cutover.

**Inspected baseline:** `yjs` at
`c3144a6dc4b5a369bf27f937e24c17c829ce4359`. Branch and PR base: `yjs`.
Yjs remains exactly 13.6.33.

## Motivation

A and B start from the same native genesis and split one paragraph while offline.
C receives their real action-store updates in a different order. All three must
retain the same original character identities, the specified split components,
empty insertion locations, and authored sibling positions. If A then undoes its
split after B types into the tail, B's insertion must survive through the same
native identity. Deleting that interval independently must still hide it.

Existing layer tests cannot establish this result. MW-08 must execute the entire
path from complete envelopes through native integration, coupled reduction,
visibility and legal Markdown projection on independent replicas.

## Problem statement

The inspected tree already provides these pieces:

| Component | Existing implementation | Remaining composition obligation |
| --- | --- | --- |
| Immutable envelopes and readiness | `src/markdown/multiwriter/actions/store.ts` | Supply real native and author validation on every replica |
| Native insertion identity | `src/markdown/multiwriter/text/cache.ts` | Prepare local bodies and rebuild only the ready closure |
| Placement and ownership | `src/markdown/multiwriter/ownership/ownership.ts` | Assemble births, homes, coupled effect replay and exact native snapshots |
| Activity and deletion | `src/markdown/multiwriter/visibility/` | Reconstruct birth-causal coverage and exercise real owner control chains |
| Legal view and addresses | `src/markdown/multiwriter/projection/project.ts` | Supply complete provenance rather than fixture-side metadata |
| Atomic publication | `src/markdown/multiwriter/ingest/publication.ts` | Call the actual projector and return its state and addresses together |
| Directional IO | `src/markdown/multiwriter/providers/adapter.ts` | Route every receive through the existing gate with a separate journal per replica |
| Fault scheduler and expectations | `test/multiwriter/network.ts`, `trace.ts`, `corpus.ts` | Implement `ReplicaFactory` and run every structural trace |

`test/multiwriter/transport-probe.ts` uses a restricted text/tag model and a private
carrier format. It is not the schema-3 factory. Likewise,
`src/markdown/multiwriter/ownership/test-fixtures.ts` owns shared symbolic maps,
body inventories and explicit birth bindings. Its independently allocated native
caches are useful layer controls, but its coordinator cannot become the replica
implementation. Projection tests supply birth coverage from selected fixture run
skeletons. That shortcut does not establish arbitrary birth-causal coverage.

The missing production command compiler and history UI are downstream MW-09 and
MW-10 work. Making those prerequisites of this reference gate would invert the
issue graph. MW-08 needs narrow test authoring and local reference navigation
that exercise the specified envelopes and retraction algebra without claiming
production command or scoped-history acceptance.

## Proposal

### Composition and first caller

Add a headless reference composition under
`src/markdown/multiwriter/reference/`, with ready-snapshot assembly and provenance
reconstruction. Its first caller is an independent test factory under
`test/multiwriter/reference/`. Keep symbolic trace interpretation, fault injection,
fixture aliasing and schedule generation in the test directory. Do not expose a
new public editor API or replace the canonical browser writer.

Each `ReplicaFactory.open()` creates a separate `ActionStore`, ingest validator,
private authoring cache, publication/reducer state, local navigation state and
provider attachment. Return those actual handles to the harness. No mutable
object, alias registry, native writer or persisted namespace is shared. A factory
may retain an immutable genesis byte package, copied on open. Genesis is prepared
once per document fixture; peers apply identical bytes rather than independently
parsing identical Markdown.

Compose `createProjectionAuthorValidator()` with `createIngestValidator()` for
`ActionStore.validate`. The birth lookup used by that callback must depend only
on genesis and the supplied action facts. It must not consult a different peer's
registry. Run author certification on genesis plus the exact dependency closure
and candidate. Concurrent merged replay is a different calculation; it must not
reject a valid earlier split merely because ownership later changed.

Use `IngestPublication` with a reducer that assembles provenance and calls
`projectMarkdown()`. Preserve the ownership, visibility, interpretation, view and
address results from that call as one publication. The reference path may replay
fully. It is not the production keystroke path or an MW-13 performance result.

### Reconstruct provenance from retained facts

Reconstruction is required after restart, cache eviction and late fork recovery.
Neither a saved projection nor an external alias map may be its source of truth.

Derive node-to-birth-occurrence bindings from the birth slot and retained
occurrences. Use explicit node/occurrence relationships in structural effects
where available, such as `SplitFlow.newNode` and its occurrence. For ordinary
creation, match a unique retained birth occurrence in that allocation batch to
its block slot, excluding occurrences used only by later placement intentions.
The test author emits an unambiguous predecessor chain for multiple births at
one parent. Validate one binding per non-root node, matching slots and resource
births. Do not choose the first matching occurrence or allocate one on replay.

A slot alone need not distinguish arbitrary colliding allocations. Add a negative
control for this ambiguity. If an authoritative corpus operation cannot be encoded
unambiguously with existing facts, retain the witness and return to shared-contract
review. This proposal does not introduce a hidden allocation-order protocol or a
new envelope field. Genesis explicitly includes its immutable `LayoutGenesis`
bindings, native body/manifest and initial presentation properties.

Derive home bindings using MW-04's existing `deriveHomes()` convention. Each root
run ends with its fresh full private home tape. Captures use interior endpoints;
edge typing allocates the required brackets before publication. Reserved home
cells remain in raw traversal and are omitted only from content adjacency. Do
not reintroduce old sentinel-capturing fixtures or mix home conventions.

For `BirthContent`, reconstruct each allocating action's exact causal view,
including its same-action structural effect prefixes. Record the permanent
intervals initially assigned to each newly allocated node after its birth's
structural construction, including transferred split content and its private
home. Later transfers in other actions do not change this coverage. Wrappers
without owned inline content have empty coverage. Preserve all retained nodes,
including retracted and packet-ineligible births. Membership uses permanent
intervals, so later insertions inside them are covered. Final merged owners,
visible strings and historical source names cannot substitute for this replay.

Test a node receiving content and then transferring it away in its birth action;
make the construction prefix explicit rather than using the final owner as a
shortcut. If the current envelope effects do not identify that birth construction
uniquely, stop with a reduced witness for review. Do not silently broaden coverage
to every interval the node ever touches. Memoization may key on exact immutable
birth closure, but eviction must yield the same result from retained facts.

### Author real test actions

Lower each `Intent` in `test/multiwriter/trace.ts` using only the originating
replica's published addresses and causal view. Allocate logical resources from
its runtime actor and allocation ordinals. Prepare native markers/text through
`NativeTapeCache.prepare()`, capture the returned manifest and exact insertion
updates, construct the complete envelope and append through the real codec/store.
On prepublication failure, abort and rebuild the private cache with a fresh native
client. Never publish compensating native deletion.

Runtime actors and clients change on restart. Trace action names and cell names
are observation aliases, not reused runtime actor sequences. Derive fixture
resource aliases from the trace command's deterministic allocation roles; bind
native ranges from the actual insertion manifest. Reconstruct observation aliases
from immutable trace definitions and each peer's held envelopes, without passing
expected observations to a port. A checkpoint contains canonical bytes and the
common genesis descriptor, not a dependency on another live port.

Use `HomeIndex.planTextInsertion()` and projection address helpers for insertion
and selection. Capture exact visible native ranges for text deletion and the
author's actual subtree coverage for subtree deletion. Interpretation uses real
packets and parser conversion plans where syntax conversion is exercised. Keep
synthesis identities distinct from retained and consumed text. Invalid optional
conversion keeps literal input or declines before append; never publish half a
packet. A symbolic operation unavailable in the peer's view fails explicitly.

Maintain a small reference session cursor with the default 500-group horizon.
Group only local user actions. Explicit control intents become real
`SetGroupActive` envelopes with the target group and previous owner control.
Controls are not undoable edits. Remote receipt never pushes navigation entries
or clears redo. Mode changes and cache maintenance preserve live navigation;
restart resets it and preserves already-published controls. Eviction drops only
navigation metadata. This supports MW-08's algebra and retention checks; scoped
selection, focus bookmarks and production command grouping remain MW-10 work.

### Transport, pending state and checkpoints

Use the existing provider receive path for peer, catch-up, self-echo and cross-tab
routes. Supply separate headless in-memory journals to exercise real adapter IO;
these are not IndexedDB crash-safety evidence. Persist admitted raw ingress,
including unresolved outer structs. Only canonical action-store bytes are
transported. Never connect a provider to a native cache.

Capture original outer Yjs updates at append time and support real state-vector
catch-up. Subset exports must preserve original carrier structs and may leave
outer prerequisites unresolved. Do not re-encode selected envelopes into fresh
replacement carriers to fake continuity. Checkpoint and `isolationState()` use
complete canonical updates, including pending structs and variants. Native
isolation diagnostics must include all materialized native state; if a diagnostic
export is needed, keep it detached and read-only rather than exposing the Doc.

An unavailable maintenance operation throws. Do not satisfy retention fixtures
with a no-op. Reopening preserves original outer identities and rebuilds derived
state, while cache eviction preserves the current live session cursor. Where
MW-18 storage consolidation is available, run it with the same factory and old
anchors; its storage crash matrix remains a separate owner check.

### Failure behavior

Pending branches do not enter the private native cache. Independent ready work
continues. Quarantined variants remain retained. A late fork withdraws affected
ready facts and rebuilds derived caches before further authoring. A deferred or
failed publication exposes its stale status and does not expose partial heads,
new native text or mismatched addresses. Capacity failures remain retryable,
not semantic quarantine. Reducer invariant failures stop the gate with a saved
counterexample; there is no authority fallback, branch replacement or recovery
content tree.

## Verification

Run all existing `corpus.ts` traces through
`runContractTrace(replicaTraceAdapter(factory, equal), trace, equal)`. No skips,
expected-output adapters or reduced feature ports count as passing this gate.
Preserve the approved reverse-cut retained skeleton `cdef` while effective owners
remain `ab/c/def`. Do not change frozen outcomes to accommodate the implementation.

Add a traceable matrix from master proposal §13 to executable test names:

| Conflict family | Required cases |
| --- | --- |
| Cuts | Both actor tie orders, both delivery orders, distinct/equal gaps, zero/end cuts, both retained sides, empty home reuse, authored outer context |
| Layout | Cross-tape join/split, opposing joins, join versus split/move, overlapping/repeated transfers, joined destinations, empty ghost slots, seam affinities, action-local text |
| Deletion | Exact independent delete tags; causal move-out versus concurrent transfer; split/move/new child against subtree delete; causal creation after undo; deleted destinations; stale split across already-separated content |
| Retraction | Peer typing after split, wrapper scaffolds with surviving peer children/text, no-effect newest undo, old move redo priority, controls before targets, per-instance navigation |
| Projection | Losing heading/code packets, exact masks and demotion, fences/tasks, repeated text, fresh synthesis, wrapper aliases/lifting, empty genesis and post-deletion roots, Unicode boundaries, Markdown export/reparse |
| Delivery | Two active peers plus three active peers, partitions, all four modes/routes, strict one-way without controls, duplicates/reordering/merged messages/loss, native-prefix gaps, malformed/forked envelopes, unrelated ready progress |
| Lifetime | Restart, full replay, cache eviction, more than 500 groups, old-prefix future actions, complete pending checkpoint state and original carrier prefix continuity |

Compare raw block parents, flow ancestry, every refined cell's run/occurrence,
retained skeletons and ghost slots, hidden native text, visible identity multiset,
normalized tree, Markdown and origins. Equal ready sets require equal document
facets; intentionally asymmetric sets do not. Compare receive-disabled A with a
separate isolated control under the same local commands. Complete catch-up must
merge into existing identities and preserve live history.

At every schedule checkpoint, reconstruct independently from canonical bytes and
genesis with fresh caches and provenance. Compare it with the live publication.
Capture canonical/native bytes before and after repeated projection, serialization
and address reads to prove those reads author nothing. Pending/fork variants must
not disappear during checkpoints or maintenance.

Extend the existing seeded scheduler with valid local structural-command choices
from each peer's current view. Include multi-intent actions, undo/redo and deletion.
Run fixed reproducible seeds and an elementary small-state conflict enumeration,
recording seeds, bounds and operation counts. Save the exact failing schedule via
`encodeNetworkTrace()`, replay it, then reduce commands and deliveries while
preserving dependencies, native prefixes and the same failure. Commit reduced
failures as ordinary regressions. No failures found means no failing seed to
publish; report the executed bounds instead of fabricating a witness.

After implementation run `npm run build`, `npm run test`, `npm run lint`,
`npm run check:boundaries`, both unused-code scripts and `npm run format:check`.
Use explicit longer test deadlines for exhaustive/generated workloads; retain
all seeds and assertions. Browser tests are not a substitute for this headless
gate. Do not wait for PR CI before handing off the implementation for review.

## Written preservation argument

The implementation must deliver a code-linked argument alongside test results.
Use the following obligations; these are proof obligations, not a completed proof:

1. Readiness yields a unique dependency-closed action set and validates each native
   origin against its exact author past. No unrelated pending body enters that set.
2. Insertion-only native replay yields the same marker/text order from those bodies.
   Rebuild preserves original identities and introduces no redo replacements.
3. Each refined cell starts at one certified home. Coupled split/transfer replay
   overwrites one assignment; join changes flow containment, not text identity.
   Reserved cells preserve independent empty-source insertion locations.
4. Both placement domains preserve one parent, legal roles and acyclicity at each
   prefix. Occurrence traversal and cohort buckets define total deterministic order,
   including ghost anchors and late safety reclassification.
5. Activity keeps allocations and original semantic priority. Independent deletion
   tags, birth-causal inherited coverage and destination deletion remain separate
   from ownership and packet activity. Retraction cannot manufacture native text.
6. Packet selection, pure normalization and origin mapping use the same closure.
   Each visible native unit appears at most once, and each editable view point has
   a retained origin. Read operations allocate no shared facts.
7. Directional gating changes which facts arrive, not interpretation. Checkpoints
   preserve complete canonical bytes. History limits cannot remove facts needed by
   an old offline writer. Therefore equal ready sets reconstruct equal document
   facets after all required messages arrive, with separate local navigation.

For each obligation identify the responsible functions, induction step or boundary
check, and positive/negative regression. Explicitly state unproved cases and test
bounds. Placement research and the historical restricted model do not prove this
composition. A failing obligation keeps the gate closed even if Markdown matches.

## Non-goals

- Browser cutover, focus/IME/clipboard/device acceptance, or removal of schema-2 code.
- The production semantic command compiler, complete parser command parity, scoped
  history UI or public multiwriter document API.
- Incremental replay optimization or performance budget acceptance.
- New dependencies, protocol fields, mixed home conventions or schema migration.
- Canonical pruning, offline expiration, new genesis after maintenance, structural
  authority, or deleted-conflict recovery.

## Suggested implementation shape

1. Add provenance reconstruction and its ambiguity/birth-prefix regressions. Prove
   restart reconstruction without the fixture coordinator.
2. Connect actual validation, native preparation and publication. Run text, split
   and transfer identity smoke traces on three independent ports.
3. Complete intent lowering, owner controls, provider routing and checkpoint APIs.
   Run the whole frozen corpus and the structural conflict matrix.
4. Add structural generation, reduction of failures, old-prefix retention and the
   written preservation argument. Record actual commands, counts and limitations.
5. Open a conventional-title PR against `yjs`, attach it to grain/89 and request
   implementation review. Keep normal browser integration gated on acceptance.

If composition exposes a shared-contract ambiguity, publish the smallest native
witness and request review from the owning workstream before changing facts or
expectations. Dependency implementation fixes must be reviewed with those owners.

## Success criteria

- The full frozen corpus passes using independent common-genesis native replicas.
- Every matrix row has executable integrated coverage and recorded bounded results.
- Fresh reconstruction equals live state, including hidden identities and addresses.
- Directional isolation, per-instance controls and lossless retention pass on that
  same factory; no unsupported maintenance is reported as successful.
- Reduced discovered failures and a code-linked preservation argument are committed.
- No browser, production-authoring or performance acceptance is inferred from this
  reference gate, and no shared contract is changed without review.
