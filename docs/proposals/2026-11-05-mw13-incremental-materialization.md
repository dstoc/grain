# Proposal: Incremental multiwriter materialization

**Status:** Approved for grain/94 in `cmt_USmhE0iLC7CKFIS9` on 2026-11-04.
Approval covers the design; implementation and acceptance remain separate.

**Authority:** grain/81 proposal artifact version 2, especially §§3–8, 9.3,
10.2–10.3, 13 and 14. Preserve the approved MW-04 private-home and MW-08
constructor rules. This proposal changes derived computation, not those semantics.

**Inspected baseline:** `yjs` at
`415363a4e85549a33eee3010d69e55ce6161002d`, including MW-08, MW-09 and MW-12.
Branch and eventual implementation PR target: `yjs`. Keep Yjs exactly 13.6.33.

## Motivation

A types into one paragraph of a 150-paragraph document while outbound-only.
B receives A's changes and edits independently. After 10,000 actions, A enables
receiving and incorporates B's retained changes. Ordinary input should update
only affected derived state. Catch-up may replay an earlier structural suffix,
but must preserve the original insertion identities and A's live session.

The optimized result must equal fresh reference materialization for each peer's
own ready set. Different intentionally asymmetric ready sets need not have equal
views. Neither cached state nor acknowledgments authorize canonical pruning.

## Problem statement

The current implementation deliberately favors a readable reference algorithm:

- `actions/store.ts` retains decoded variants and ready certificates, but
  `calculate()` scans and sorts the complete inventory. `checkLocal()` constructs
  the candidate's full transitive closure. Paths below are relative to
  `src/markdown/multiwriter/` unless another root is stated.
- `reference/store.ts` memoizes a complete snapshot by `factsVersion`. It clones
  results and recalculates when facts change; it is not incremental readiness.
- `ingest/validator.ts` reuses one exact causal native branch and certificates.
  It still enumerates dependency closures. Structural author validation remains
  separate from merged replay and must stay that way.
- `ingest/publication.ts` creates a new `NativeTapeCache`, applies genesis and all
  ready bodies, then calls the supplied reducer on every refresh.
- `reference/document.ts` reconstructs all provenance and calls
  `projection/project.ts`. The projector reduces activity, interpretation,
  ownership and visibility, enumerates native characters, and normalizes the view.
- `ownership/ownership.ts` couples block placement, flow layout and ownership in
  semantic order. `ownership/cells.ts` constructs cells from all tape snapshots.
  A late earlier structural effect can change later cycle or split decisions.
- `authoring/draft.ts` uses a `ConstructionTree`; `authoring/compiler.ts` copies
  the projected tree, snapshots all tapes, and calls the full projector for
  intermediate command state. Optimizing publication alone leaves these costs.

The inspected head has the MW-11 append-only journal adapter. It does not yet
contain MW-18 checkpoint/consolidation APIs or MW-10 production history stacks.
Their actual merged APIs must supply the retention and history integration tests;
reference navigation and synthetic storage controls cannot substitute for them.

## Proposal

### Keep the reference oracle and introduce one optimized reader

Add a `materialization/` module beside `reference/`. Its first consumer is the
headless MW-09 editor opened through the MW-12 bootstrap path. Provide an explicit
reference/optimized selection in the internal document-opening seam so tests can
run both against the same detached genesis and original carrier updates. Keep
`openReferenceDocument()`, full readiness calculation and `projectMarkdown()`
callable as independent full-replay oracles. Do not make the reference entry call
the optimized reducer.

Use a narrow structural document interface for the editor's store, publication,
local certification and lifecycle needs instead of requiring
`ReturnType<typeof openReferenceDocument>`. Preserve existing editor results and
provider IO. New document-opening options select only a local implementation;
they never enter an envelope, genesis descriptor or synchronized setting.

The optimized reader owns readiness indexes, native cache, reducer checkpoints,
projection records and diagnostics. It shares the existing typed model and pure
semantic rules. It introduces no second editable document model, dependency,
worker, wire format, canonical snapshot format or independently replicated cache.

### Index readiness by exact immutable facts

Factor collection notifications and decoded-fact access out of `ActionStore` into
a private reusable seam. Keep the canonical Y.Doc private. Record newly decoded
variants, forked identities, dependency edges and integrity changes, including
facts unlocked by an old pending outer prefix. A receipt with no observer event
still invalidates suspended work; do not infer canonical completeness from events
or a state vector alone.

The optimized readiness reader maintains reverse dependencies, missing-identity
waiters, actor predecessor/successor checks, semantic order and current heads.
Drain changed identities and their dependent closure. An exact duplicate creates
no semantic change. A conflicting variant withdraws its identity and all affected
dependents, including previously published ready actions. Preserve diagnostics,
all variants and unrelated ready branches.

Reuse readiness/certification only for the same exact payload and direct
certificate identities. Track causal membership through shared dependency links
and memoized queries rather than storing a copied ancestor set per action. Supply
an internal immutable closure view for reference, activity and author checks;
keep detached public snapshots as explicit diagnostic exports. Ordinary input
must not request a full public snapshot or clone its envelopes. Compatibility
validators that require arrays may materialize them on the reference path.

Author certification remains against genesis plus the exact author closure.
Reuse certified resources, immutable birth bindings, membership checks and native
branches at that closure; never certify against the unrelated merged live cache.
A structurally unfamiliar closure can rebuild privately and report that cost.
Ordinary causal text append must reuse its branch without a full ancestor scan.
Capacity deferral remains distinct from malformed-data quarantine.

### Reuse native bodies and index affected intervals

On monotone ready growth, integrate each newly ready native body once in
causally valid order. Record affected tapes and native ID intervals from validated
updates/manifests. Maintain tape-local marker order, cell intervals, text births,
range coverage and reverse readers of those intervals. Text insertion within an
existing cell preserves its owner. Marker refinement divides the previous cell
and gives each refined cell its prior assignment, including empty cells.

Keep native resource checks on ingestion. Ordinary projection reads use certified
immutable resources and update affected indexes, rather than rescanning all
manifests and characters. Native insertion and active insertion visibility are
separate: undo never deletes a native body. Retained birth-content intervals stay
constructor-derived even when their current owner changes.

If a fork removes a body from readiness, discard the contaminated private native
cache and reconstruct the remaining exact ready closure with a fresh client.
This exceptional rebuild follows the current safety rule. It is not a shortcut
for ordinary text, deletion, undo, marker insertion or late ready growth.

### Replay the deterministic affected suffix

Index actions/effects by `(lamport, actor, sequence, effectOrdinal)` using the
existing comparator. Preserve original ordinals, inactive allocations and every
retained occurrence. Replay block placement and flow/cell ownership together.
Do not update final joins and then replay older splits against that final graph.

The replay frontier is the earliest of:

1. An inserted, withdrawn or replaced ready action's semantic position.
2. The earliest effect in any group whose final activity changes.
3. The earliest interpretation candidate whose applicability changes, including
   its associated placement, properties and masks.
4. The earliest structural reader invalidated by a changed native interval,
   marker order, split cohort, range membership or destination requirement.

Reverse indexes map groups, sources, ranges, occurrences and destinations to
those readers. Recompute final activity and interpretation decisions before
choosing a usable prefix. A control's own late position is insufficient: undo
can invalidate the older target's prefix. Native markers exist independently of
activity, so checkpoint validity also depends on relevant native refinements.

Restore the last compatible checkpoint strictly before that frontier and replay
the suffix in the original coupled order. A checkpoint contains persistent roots
for placement forests, occurrences, run attachments, cell ownership, cohort ranks,
activity/interpretation state and their reverse indexes. Use copy-on-write
records and changed-map paths; do not clone complete maps on every input or
checkpoint. Start with checkpoints every 128 semantic actions, retain at most
8 historical checkpoints per reader, and measure alternative intervals. These
are disposable local tuning values, not retention or replication policies.

A checkpoint identifies protocol, exact genesis, reducer/cache version, ordered
payload identities and the activity/native revision dependencies of its prefix.
Heads, action counts and variant counts alone cannot establish compatibility.
Intern identical immutable payloads; rolling fingerprints can locate a candidate
prefix but cannot replace exact identity checks.

When new markers refine an old interval, rebase checkpoint cell assignments only
when refinement preserves that prefix's structural decisions. Otherwise replay
from the earliest recorded reader, conservatively from genesis if necessary.
Unknown effects or incomplete dependency indexes also use conservative replay.
Report every fallback and its reason. Large structural catch-up can legitimately
replay the whole prefix; warm ordinary input cannot routinely take that path.

### Update legal projection and command drafts locally

Maintain reverse links from changed owners, deletion tags, inherited birth
coverage, interpretation masks and placements to projected records and addresses.
Reproject affected flows and legal container boundaries. Continue until lifting,
wrapper grouping, representative choice and list numbering stabilize. Reuse
unchanged view records, source fragments and address records. Changes can spread
across adjacent wrappers or numbered siblings; do not assume one changed raw node
means one changed view node.

Reuse existing pure normalization rules with explicit affected-container inputs.
Do not mutate shared records or allocate editable text during projection. Compare
all normalized output and address semantics with the full projector.

Replace eager command tree/tape copying with an action-local overlay on published
records. Keep existing command intent and semantic draft interfaces. Resolve
handles through a publication-local origin index; initialize text pieces and
native tape plans only when read or touched. Intermediate compiler queries use
the same reducer with an unpublished suffix overlay, preserving allocation order,
private homes, same-action placement and parser-synthesis rules. Literal input
must not call the full projector, copy every tape, or reconstruct the whole tree.
Structural command overlays use conservative suffix replay when necessary.

### Publish atomically and discard derived state safely

Keep one coherent tuple of ready-set identity, native read view, reducer state,
legal view and editing addresses. Build a candidate with copy-on-write derived
roots. The private native cache may accept certified bodies during preparation,
but the previous publication reads versioned tape/index roots and cannot expose
those bodies early. Full `encodeState()` diagnostics may reconstruct exact bytes
for that publication on explicit request; they are outside the ordinary input
path. Test old published range/marker/text reads while a candidate is deferred.

Retain MW-15 generation checks, resumable work and cancellation on new receipts,
limit changes, replacement work and destruction. Publish once after complete
validation/replay. A failed or deferred candidate leaves the last tuple intact and
stale; authoring follows the existing current-publication guard. Do not append a
new local action from partial state. Preserve `RetainedEditError` after an append;
retry publication/persistence without repeating the edit.

Cache checkpoints in this proposal are initially in-memory. Eviction releases
historical roots, memoized causal queries and rebuildable indexes, while preserving
an active coherent publication or explicitly requiring refresh. Restart rebuilds
from retained canonical data. A persistent derived-cache file format is not
needed for this first implementation and would need separate compatibility work.

Use MW-18's lossless canonical checkpoint to consolidate journals. Keep its
crash-safe replacement and old-reader fence unchanged. Never write a reducer
checkpoint in place of canonical envelopes or clear storage through an MW-13
cache operation. Never replace genesis, expire writers or prune canonical facts.

## Non-goals

- Browser cutover, physical IME validation and removal of the authority path.
- New undo semantics or durable reconstruction of interactive history stacks.
- Bounded canonical history, causal compaction or an offline-replica expiry policy.
- A generic incremental execution framework or persisted derived-cache schema.
- Constant-time late merge, undo or structural normalization in every document.

## Verification

### Equivalence and failure tests

Run the frozen `test/multiwriter/corpus.ts` through optimized independent replicas
and the reference factory. Add differential observation at each completed
publication for the same ready set, not only after convergence. Compare readiness
and exact payload variants; raw block/flow edges and occurrences; cell-to-run
assignments including empty cells; native IDs and text; active tags and masks;
normalized tree; origin/address resolution and exported Markdown. Compare native
bytes using `compareBytes`, avoiding object expansion of large typed arrays.

Extend seeded commands and delivery schedules with earlier semantic arrivals,
controls before targets, forks after publication, pending outer prefixes, repeated
transfers, opposing joins, same-gap cuts, both retained sides, concurrent deletion,
constructor coverage, competing conversions, synthesized text, surrogate pairs,
empty-root edits, normalized wrappers and continued editing after catch-up.
Preserve failing seeds. Run real Enter, Backspace, paste, indent, outdent, selected
deletion and parser conversion through MW-09 rather than only reducer helpers.

For each replay checkpoint, compare resumed execution with cold full replay.
Exercise boundaries immediately before/after controls, cohort changes and native
marker refinement. Evict checkpoints and causal/native caches between actions.
Test malformed/mismatched checkpoint rejection, cancellation at yielded steps,
capacity retry and prior-publication immutability. Assert zero canonical writes
from materialization and maintenance.

After MW-10/MW-18 integration, run real 501-group eviction, retained old-prefix
writers, cache eviction, crash-safe consolidation, restart and later stale-anchor
actions. Test local undo and redo, including outbound-only undo and independent
peer history. Label missing dependency coverage as incomplete acceptance.

### Deterministic work gates

Instrument phase work in addition to timing: decoded/validated actions, causal
edges visited, native bodies integrated, tapes/cells rebuilt, effects replayed,
projection records replaced, tree records copied and fallback counts/reasons.
After warm-up, literal input in one paragraph must not integrate old bodies,
scan every ancestor, enumerate unaffected tapes, copy the document or invoke the
full reference projector. Test this at 10, 150, 1,000 and 5,000 nodes and at
increasing retained action depths. Verify unaffected node/address identity.
Report touched-tape work honestly for long tapes; range indexes should avoid
rebuilding the entire tape for each character.

A no-change refresh reuses the published tuple. Duplicate delivery changes no
semantic output. A local suffix append replays only new applicable effects;
undo starts at the earliest affected target, and late structural arrival starts
at the recorded invalidation frontier. Check expected work against those cases,
not a machine-dependent elapsed-time threshold.

### Matched timing and retained storage

Add `benchmarks/multiwriter/` with a committed manifest, executable workloads,
phase counters and raw JSON/JSONL results. Pin the baseline commit, candidate
commit, Yjs, runtime, host, seed, genesis bytes and exact operation schedule.
Capture the same original envelope/carrier stream for full-reference versus
optimized replay. Also run identical semantic command scripts against the
schema-2 post-M5 baseline `c3a8812e8bbee69c805a50347dd29d11c076d2de`; label its
different model and capabilities. Do not compare unmatched random edits or use
the older M0 trace as a post-M5 baseline.

Use at least three paired fresh-process runs on one host, alternate execution
order, and retain raw samples. Separate warm and cold materialization, continuous
writers and fresh-writer traces. Exclude oracle execution from timed candidate
intervals; capture/replay the exact ready set for differential verification
outside them. A deadline or partial trace is incomplete evidence, never an
extrapolated 10,000-action result.

Cover 10/150/1,000/5,000-node documents, long tapes, wide sibling lists and heavy
fragmentation. Complete uninterrupted 10,000-action continuous traces with mixed
text/structural changes and undo controls. Include long-lived outbound-only A,
independently editing B and a third receiver C; A must match an isolated control
until receiving is enabled. Measure strict A→B retransmission with zero reverse
traffic and later bidirectional catch-up into the same A instance.

Report local edit p50/p95 by phase, core apply+projection, full command latency,
local undo, reconnect materialization, cold/warm checkpoint load, replayed suffix
length and checkpoint hit/miss/fallback distribution. Preserve the parent targets:
warm ordinary input on 150 short paragraphs p50 2 ms / p95 5 ms for core
apply+projection, and ordinary split/join p50 15 ms. These are targets, not claimed
results or browser input-to-paint measurements.

Report the following separately before/after history eviction, cache eviction
and MW-18 lossless consolidation:

| Category           | Measurement                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical facts    | Exact envelope bytes, embedded native bytes as a separately identified subset, full actionDoc export including pending native carrier state |
| Storage journal    | Actual persisted checkpoint plus tail and redundant batches, genesis descriptor separately                                                  |
| Rebuildable caches | Native-cache heap, readiness/reducer/projection/index heap, retained checkpoint roots and peak candidate overhead                           |
| Local history      | Real session navigation and selection metadata, separate from replicated controls                                                           |
| Retained structure | Tape/cell/marker/slot counts and retained native text versus visible UTF-16 units, with empty output reported explicitly                    |
| Transport          | One-way bootstrap/prerequisite bytes, retransmission bytes, catch-up bytes and materialization time                                         |

Heap deltas require controlled GC and a stated method; serialized cache bytes are
not heap. Avoid double-counting shared checkpoint roots. Canonical body growth is
not a cache leak, and journal reduction is not semantic-history compaction.

## Suggested implementation shape

1. Add differential observations, phase counters and exact replay capture. Establish
   the full-reference baseline before modifying the optimized path.
2. Add the private fact-change seam and indexed readiness/certification. Preserve
   reference calculation and detached diagnostic snapshots.
3. Add affected native interval indexes, append reuse and checkpointed coupled
   suffix replay, with atomic versioned publication and exceptional rebuild tests.
4. Add local projection/normalization and command overlays. Run the complete
   corpus, generated schedules and deterministic work gates.
5. Integrate real MW-10 history and MW-18 retention controls; record matched
   measurements and completed long traces before claiming MW-13 acceptance.

Use `npm run build`, `npm run lint`, `npm run format:check` and relevant Node
suites during implementation, followed by the complete Node correctness gates.
Run browser storage tests when the MW-18 integration changes storage behavior.
No implementation or performance pass is claimed by this proposal.

## Success criteria

- Optimized publications and resumed checkpoints equal fresh reference output
  for every completed publication in the required corpus and generated schedules.
- Warm ordinary input passes the deterministic work gates without full-state
  rebuild, full closure cloning or hidden full-reference calls.
- Completed matched reports cover required scales, 10,000-action traces, one-way
  sending, later catch-up and distinct storage/cache/history accounting.
- Actual MW-10/MW-18 maintenance preserves old-prefix editing and all canonical
  identities; no cache or history policy prunes facts or replaces a live branch.
- The reference oracle remains available and browser cutover remains a later gate.
