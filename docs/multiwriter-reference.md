# Independent multiwriter reference composition

This is the headless MW-08 reference path for grain/89. It composes schema-3
admission, native insertion identity, layout, ownership, visibility and Markdown
projection. It has no structural authority. Yjs remains pinned to 13.6.33.
Implementation results do not authorize browser cutover, production command or
history acceptance, storage crash safety, performance budgets, or device/IME QA.

The constructor rule is the rule approved in grain/89 comment
`cmt_qJAhzP3sw8xuDeDU`: an inline birth covers its full private home; an explicit
SplitFlow birth additionally covers its certified constructor component. Transfers
and joins add no inherited birth coverage. Retraction and packet loss do not erase
retained constructor facts.

## Components and responsibility

- [`reference/document.ts`](../src/markdown/multiwriter/reference/document.ts)
  owns one store, validator and atomic publication. It clones its common-genesis
  package. Local preflight calls the actual store before canonical append.
- [`reference/provenance.ts`](../src/markdown/multiwriter/reference/provenance.ts)
  reconstructs node-to-birth bindings and constructor coverage from retained facts.
  An explicit split binds its node and occurrence. Ordinary births require a
  unique non-placement occurrence at the exact birth slot. Multiple births can
  form a predecessor chain. Ambiguous slots throw; array order is not a rule.
- [`reference/store.ts`](../src/markdown/multiwriter/reference/store.ts) reuses only
  complete readiness snapshots at the same facts version. A new fact, including
  unresolved outer structs, changes that version. Decode-limit changes clear the
  memo. A cold open runs the base admission algorithm.
- [`test/multiwriter/reference/`](../test/multiwriter/reference/) contains the
  independent port, narrow test author, original-carrier subset scheduler and
  structural scenarios. Symbolic trace names are observation aliases, not facts.
  Allocation-role ordinals help reconstruct test aliases; production birth
  reconstruction never uses that convention.

A factory prepares one immutable native genesis package. Each open clones that
package and owns its maps, runtime actor, native client, store, validator,
publication, navigation cursor and in-memory provider journal. NativeFixture is
used only to prepare that common genesis, never as an author or shared peer
registry. Every open allocates a fresh runtime actor; the first authored command starts at runtime sequence 1. Test session labels recover symbolic action names without sharing an actor registry. Peers share no mutable
writer, reducer, alias registry or persistence namespace.

## Preservation argument

The following argument identifies the implementation boundaries and their
regressions. It is an argument about this implementation, with finite executable
coverage. It is not a proof that the published tree-move theorem establishes the
combined text/layout/visibility algorithm for all executions.

### 1. Admission and the exact author past

`ActionStore.calculate()` first classifies malformed variants, forks, actor chains,
missing dependencies and Lamport order. Only a dependency-closed ready prefix
reaches validation. `validReferencesSteps()` restricts references to genesis,
that closure and the candidate. `createIngestValidator()` applies exactly those
native bodies before `createProjectionAuthorValidator()` certifies structural
prefixes. A concurrently received body cannot certify an origin in an earlier
candidate.

A successful store certificate refers to its immutable stored Variant and the
certificates of its direct ready dependencies. Equality of those certificate
identities implies equality of the full transitive facts by induction from
zero-dependency actions. A changed payload, fork or unready dependency cannot
reuse that certificate. Controls received later cannot invalidate the author's
original past. Failed or partial validation creates no success certificate.
Destroying/reopening drops derived certificates and reruns admission.

`checkLocal()` runs the same chain, closure, reference and validator boundaries
before append. The reference author aborts native preparation on rejection. The
local-abort regression stages two native homes/texts, rejects ambiguous births,
and compares canonical/native bytes and navigation with their original values.

Evidence: `actions/store.test.ts`, `ingest/origins.test.ts`, the four malformed/fork
frozen traces, exact joined-source birth certification, and fresh replay at every
explicit contract expectation.

### 2. Native identity and publication

`NativeTapeCache` admits insertion-only bodies with exact manifests, valid native
origins and complete clock prefixes. It rejects deletes, formatting, unknown
shared types and broken UTF-16 boundaries before integration. The reference
author prepares native operations once, captures their original insertion updates,
preflights the complete envelope, appends, then commits preparation. It never
implements semantic undo through a native delete or replacement character.

`IngestPublication` materializes one ready snapshot in a separate candidate cache
and publishes heads, reducer state, view and edit addresses together. Failure or
invalidation leaves no partial publication. Late forks rebuild the author and
publication caches; `retainReady()` also drops a withdrawn certification branch.
Detached native diagnostics cover author, publication and certification caches.
Their diagnostic union imports original structs and allocates no text.

Evidence: native adapter/ingest tests; `fork-quarantines-materialized-dependents`;
Unicode, synthesis and action-local transfer tests; canonical/native isolation
before and after receipts, reads, maintenance and fresh reconstruction.

### 3. One assignment per cell and stable birth coverage

`deriveHomes()` binds each fresh tape to one root run. `CellIndex` refines every
complete native tape into open permanent-marker cells. Installation assigns each
new home cell once. Reserved edge cells stay on their home root. Transfer and
split overwrite assignments; join changes flow containment and retains native
identities. Traversal emits a cell only at its effective run and occurrence.

Author certification compares a split's expanded retained skeleton with the
source's actual pre-effect traversal in its exact past. Joined source components
and same-action prefixes participate. Empty splits must capture no source
content. Merged replay permits specified component shortening; it does not
recertify against unrelated concurrent ownership.

`reconstructProvenance()` consumes this certified ready set. It takes ordinary
coverage from the private home and split coverage from the certified root
skeleton. It does not inspect final owners, collect all content visits, or remove
coverage after undo. Permanent intervals therefore include later native
insertions while preserving the constructor's scope.

`assertCoverage()` checks structural births and raw layout/ownership edits.
InsertText, DeleteText, DeleteSubtree, SetProperties and SetGroupActive do not
change raw assignments at their effect step. Native refinement is already present
in the initial index; controls alter activity when the entire prefix is replayed.
Skipping redundant checks at those steps does not skip a raw mutation.

Evidence: 24 fixed birth/provenance regressions; the frozen cut, transfer and
retention traces; every ordered structural pair; raw full-cell/home/ghost state
comparison during convergence and fresh replay. The approved reverse-cut L
skeleton stays `cdef`, while effective owners remain `ab/c/def`.

### 4. Legal placement and deterministic ordering

`LayoutPrefix` uses the same cycle-safe edge replacement in the block and flow
domains. Immutable roles constrain edges before mutation. One effective parent
and acyclicity hold at each applied step; ineffective intentions retain their
previous placement and permanent occurrence. Native split ranking supplies
cohort buckets to the occurrence traversal. A bucket has one rank against other
followers and native cut order within it; no mixed pairwise comparator is used.

Births, obsolete occurrences and empty locations remain available as anchors.
The reference observation's `raw` facet includes every cell assignment, full run
skeleton, home, block/flow placement, raw sibling order and slot/attachment
traversal. It also includes exact per-unit visibility, interpretation packets and
the complete projection with native edit origins. Its sparse
symbolic `skeletons` map lists text aliases only; it is not the empty-cell proof.

Evidence: both actor tie orders in the frozen cut and moved-predecessor traces;
225 ordered structural pairs; same-gap empty-cell identity, endpoint cuts,
opposing joins, overlapping transfers and multi-intent move/transfer controls.

### 5. Activity, deletion and independent survivors

`reduceActivity()` preserves original effect order and retained allocations.
Owner controls target complete groups and extend the previous owner control.
Independent deletion tags and exact observed character ranges remain independent
of insertion activity and current ownership. `reduceVisibility()` follows
birth-parent concurrency and the constructor intervals for inherited coverage.

Projection weakly suppresses a split derivation when an active concurrent
subtree deletion covers its source path. It adds no historical-source tombstone.
The split's own birth/layout requirement does not retain that empty header;
visible peer text, surviving children and independent layout requirements still
retain the node as a scaffold. A previously separated causal sibling is excluded.
Undo of the deleting tag restores the header and original text identities.

Evidence: independent delete-tag undo, causal move-out, stale split, deleted
destination, child inheritance and wrapper scaffolding traces; direct preservation
controls for peer text, move, child and deletion undo; paste-shaped multi-block
construction followed by undo with surviving peer typing.

### 6. Pure view, packet selection and edit origins

`selectInterpretations()` selects whole packets. Projection uses the same ready
closure, native fragments, masks and activity as ownership/visibility. Losing
packets retract their placements, wrappers and masks together. Parser conversion
uses `prepareParserConversion()` and `bindParserConversion()` for supported single
inline outputs. Editable synthesis has real fresh native births. Typed task and
presentation edits use SetProperties. Normalization uses existing representative
origins and never writes shared nodes.

Every visible fragment retains a native origin and every empty editable view has
an origin slot. The port verifies that view/raw reads and serialization leave
canonical and native bytes unchanged. Export/reparse checks cover heading,
setext and fenced-code conversion. This does not claim new Markdown conformance
beyond the parser's supported contract.

Evidence: frozen packet, normalized-wrapper and empty-root traces; the integrated
parser/fence/demotion/task/wrapper/Unicode/synthesis tests; existing parser-plan
and projection-address negative tests for duplicate identities, stale mappings,
incomplete synthesis and half-surrogates.

### 7. Delivery, navigation and lifetime

Every peer/catch-up/echo/cross-tab receive calls `DirectionalActionProvider` before
canonical application. Sending is separately gated. Per-peer feedback uses actual
Yjs state vectors, and strict one-way delivery needs no feedback. Original outer
carrier items retain their client, clock, origins, parent and payload when a test
sends a subset. Missing outer/native prefixes remain pending. Full checkpoints
preserve pending structs and all variants.

The reference cursor groups local user actions only. Remote receipt never pushes
navigation or clears redo. Owner controls are replicated envelopes, not local
rewinds. Mode changes and cache maintenance preserve the live cursor. Restart
opens a fresh actor and resets navigation. The 500-group horizon and explicit
history eviction remove only navigation entries. Complete canonical bytes remain
available to an old-prefix writer.

Evidence: all four modes/routes, outbound-only structural editing, control-before-
target, real peer-specific state-vector deltas, original-prefix subset tests,
restart, cache eviction, checkpoint reload and old-prefix frozen traces. The
501-group trace additionally checks horizon eviction and later old-anchor typing.
In-memory journals establish reference IO behavior, not IndexedDB crash safety.
MW-18 storage consolidation/crash acceptance remains a separate gate.

## Executable coverage crosswalk

| Master proposal §13 requirement                                              | Integrated reference coverage                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline text/new blocks/list/paste/conversion/undo                           | Frozen corpus; task/property, parser conversion and paste-shaped multi-block tests                                                                |
| Cut tie orders, equal/distinct gaps, beginning/end, retained side            | Frozen cut traces; 15×15 ordered structural matrix                                                                                                |
| Cross-tape joins/splits, opposing joins, move versus join                    | Frozen layout traces; ordered matrix                                                                                                              |
| Repeated/overlapping transfer, seams, action-local text                      | Frozen overlapping-transfer trace; round-transfer pairs; explicit left/right cut affinity; original-lineage insertion after action-local transfer |
| Causal move-out versus concurrent deletion                                   | Frozen deletion traces and fresh raw replay                                                                                                       |
| New child/split/move versus deletion and stale split                         | Frozen deletion traces; source-deletion survivor regressions                                                                                      |
| Independent delete tags and identity-preserving undo                         | Frozen selective-undo and exact-text-delete traces                                                                                                |
| Peer typing after split/wrapper undo, old move redo, no-effect newest undo   | Frozen retraction traces; generated owner controls; paste-shaped peer survivor                                                                    |
| Losing packets, exact masks/demotion, fences/tasks, repeated text, synthesis | Frozen packet traces; integrated parser/property/synthesis tests                                                                                  |
| Unicode native intervals                                                     | Emoji/combining-source split with peer insertion; native and parser/address negative suites                                                       |
| Wrapper aliases/lifting, empty roots, export/reparse                         | Frozen projection traces; parser conversion and paste-shaped cases                                                                                |
| Three peers, modes/routes, duplicates/reordering/merge/loss                  | Frozen operational traces; eight seeded 60-turn schedules and their serialized replay                                                             |
| Pending/fork/malformed branches and unrelated progress                       | Frozen ingest traces; raw pending inventory; payload-aware canonical-set comparison                                                               |
| Restart, maintenance, old anchors and >500 groups                            | Frozen lifetime traces, complete-byte checks and explicit reconstruction checkpoints                                                              |

The exhaustive small-state bound is 15 initial structural choices at A × 15 at B.
C is an independent receiver; all peers catch up and reopen. The generated bound
is eight seeds, three initial independent authors and 60 subsequent scheduling turns per seed, with controls
selected only when the current ready closure and live navigation permit them.
This is finite coverage, not arbitrary command generation or a production command
compiler. New failures save their complete schedule to `/tmp/mw08-*.json` for replay
and reduction. No failing random seed was found in the recorded bounds.

The reduced fixed failures discovered during composition are the source-deletion
empty-header regression and the harness's previous comparison of variant counts
instead of payloads. Their original frozen traces remain executable regressions;
no frozen expected output was changed to accommodate the implementation.

## Verification and limits

Run `npm run test -- --maxWorkers=4 --testTimeout=60000` for the full node suite.
The 501-group test has its own longer deadline and reports each 50 published
actions. It retains all 501 groups and assertions. Run build, lint, format check,
boundary checks and both unused-code checks before requesting review. Final
counts and timings belong in the issue/PR with the tested commit.

This reference may replay the full closure. It does not satisfy MW-13 latency or
retained-memory budgets. The narrow parser author declines multi-output/nested
conversions and conversions requiring implicit synthesis; explicit structural
intents and native synthesis controls exercise those underlying contracts. General
semantic-draft/compiler parity belongs to MW-09. Grapheme movement, focus,
selection UI, physical IME behavior and browser rendering remain downstream gates.
No old saved-document conversion, new dependency, protocol field, canonical
pruning, new genesis after maintenance, or offline expiration is introduced.
