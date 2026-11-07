# Proposal: Structural locality diagnostics and refinement decision

- **Issue:** grain/102 (MW-13A); integration parent grain/94.
- **Status:** Proposed. This document requests approval to implement A's
  diagnostics and differential experiments. It does not establish a refinement
  theorem, approve a semantic amendment, or complete A.
- **Authority:** grain/94 `structural-execution-plan` v1, context
  `ctx_QlCIuCY1eBXN1ph4`, SHA-256
  `e63457a69a187e962b053452e1072ba24a630569ae43c4b676de13aa44b3adc7`,
  especially §§3–5 and 7–9. The broader
  [MW-13 proposal](2026-11-05-mw13-incremental-materialization.md) remains binding.
- **Inspected integration head:**
  `b8b965439fe41868fafb3737e80c37afc3138937`, freshly fetched and verified against
  draft PR #88 on November 6, 2026. Its reported tested source is
  `ba5ddc80a4976793a5f37f2b395f54973f09851f`; this proposal does not relabel old
  timings as measurements of the current head.
- **Combined evidence head:**
  `f461f2f4588675a2688e96f813e4f1284eb8ff71`, with reported tested source
  `838eea2cd74cc4ab65204d262a99cf7112e4809c`. This is not PR #88's branch.
- **Review branch:** `docs/102-structural-locality-proposal`, based on the exact
  integration head above. Its draft PR targets
  `feat/94-incremental-materialization`. Only the parent integration owner applies
  reviewed child changes to that branch.

## Motivation

An editor splits one paragraph, types in both halves, joins them, edits another
paragraph, undoes the join, and redoes it. An unrelated deleted subtree remains
in canonical history. Increasing unrelated retained history should not require
reconstructing every structural decision merely because the command creates
native markers.

A must first determine when a marker changes only representation. A later marker
can also affect an old split's adjacency, an empty insertion slot, a reserved home,
or a joined traversal. The distinction belongs to derived ownership and editing
address semantics. It cannot be decided from visible Markdown alone.

## Problem statement

Paths below are relative to `src/markdown/multiwriter/` unless stated otherwise.
At the inspected head:

- `materialization/coupled.ts` has `refineCheckpoint()`, which subdivides a
  checkpoint's own assignments and coverage. `markerReaderFrontier()` invalidates
  historical range, adjacency, and token readers. Retained marker identity and
  order are necessary compatibility checks, not a proof that a split commutes
  with subdivision.
- `materialization/ownership.ts` maps, deduplicates, and sorts the complete action
  input in `replayOwnershipSuffix()` before executing the suffix. The existing
  `actionsReplayed` count does not measure that preparation.
- `materialization/projection.ts` admits local text/property work through the
  global `stableVisibility` condition. Its structural path reconstructs
  provenance, calls `projectWithActivity()`, and indexes the result. The exact
  text-deletion index improves queries within this full path; constructing that
  index still consumes retained declarations.
- `authoring/draft.ts` lazily constructs
  `ConstructionTree(projectionDocument(...))` for structural commands.
  `authoring/editor.ts` prepares native operations, stages the managed history
  selection before append, certifies and appends, then refreshes publication.
  Several of these consumers can reconstruct structural state separately.
- `projection/validation.ts` and `ingest/validator.ts` distinguish exact author
  certification from merged replay. A concurrent live cache cannot replace the
  author's dependency closure.
- `benchmarks/multiwriter/phases.mjs` measures inclusive public boundaries. Its
  own comment correctly warns that those durations can nest. They do not provide
  exclusive phase attribution.

Existing `materialization/refinement.test.ts` and `readers.test.ts` cover important
positive and fallback cases. They do not supply the complete classification or
the end-to-end work ledger required by A. No new performance result or semantic
counterexample is claimed by this proposal.

## Proposal

### Preserve and identify the diagnostic inputs

Recover the inputs from grain/94 `structural-visibility-stage-measurements` v1.
Keep their original bytes and source records. The archive contains two different
genesi; do not regenerate one from the other's Markdown.

| Archived input                                    |     Bytes | SHA-256                                                            | Meaning                                                          |
| ------------------------------------------------- | --------: | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `reports/measurements/structural/fixture-150.bin` |   560,489 | `539a15b5ae5a26471bddba9b6bb2b0018c1826a2903526b4535048d5bbd914f1` | Original common genesis: 150 root paragraphs                     |
| `reports/inputs/fixture-150-tasks.bin`            |   678,615 | `ef32258c31e23f3c78a68ed5d0dee7e8d2386d9b082935c0fa257b20d9ae8776` | Original common genesis: 150 task items, each with one paragraph |
| `reports/inputs/prefix-100.bin`                   |   761,219 | `3899bbff6054f0e64573b6a9509c4f69c8b9ff121a4e3f94b45dae886246488a` | Task genesis plus 100 original carrier frames                    |
| `reports/inputs/prefix-1000.bin`                  | 1,568,062 | `23385dcb9c5c5513c8cd64e49727ffe756201722f49bfa18ed1dd78c0e69aa6b` | Task genesis plus 1,000 original carrier frames                  |

The prefix objects contain `{ genesis, carriers }`. Their carrier payload totals
are 82,176 and 885,415 bytes respectively, separate from the table's V8 container
sizes. Both embedded genesi serialize to the task-genesis hash above. These are
separate captures: the 100-frame file is not the start of the 1,000-frame file.
Their author identities differ. Neither matches the later cancelled cdd8db3
stream or the 0af6b0e long stream. Do not attribute either input to those streams.
The same input hashes also occur in `native-interval-stage-measurements` v1;
that archive's `reports/prefix-1000.frames.bin` matches all 1,000 frames exactly.
The inspected input containers do not identify their original capture source SHA.

Add a retained-input manifest with hashes, archive/version/path, runtime and
serialization format, capture source when verified, carrier order, and extracted
envelope identities/dependencies/effect kinds. Preserve the decoded mixed schedule:
positions 0–79 are replacements, 80–89 and 94–99 are task edits, and 90–93 are
split/join/undo/redo in each 100-action period. Verify each file against its own
archived hash and known frame source. Keep the captures independent. Do not
regenerate a convenient shared stream and present it as either retained input.
Record an unresolved original capture SHA as unknown with its artifact provenance;
a profiling source SHA is not evidence of the capture source. A missing input or
hash mismatch stops the case and records a provenance failure.

A new local trace gets its own exact captured carriers and schedule. Record the
current feature and combined heads, measured source SHA, working-tree patch or
clean status, runtime, CPU, Yjs version, capacities, input hashes, and completeness
for each result. Label restored old streams and newly generated continuations
separately. Restoring a prefix starts a new writer/session and does not restore
its original navigation stack or prove uninterrupted long-run performance.

### One short managed fixture

Add `benchmarks/multiwriter/structural-locality.mjs` with a dedicated command:

```sh
node benchmarks/multiwriter/structural-locality.mjs --inputs /tmp/mw13a-inputs --output /tmp/mw13a-results
```

Both directories have defined roles: `--inputs` contains the verified original
files listed above; `--output` must be new. The command runs diagnostic cases,
not a repeated 10k workload. Use the existing TypeScript loader and public
`LocalEditor.session()` facade, `insertParagraph`, `insertText`,
`joinWithPrevious`, and `deleteBlocks` from `authoring/index.ts`.
`test/multiwriter/commands/replica.ts` supplies the reader fixture adapter.

Run the root-paragraph genesis at depth zero and the exact task prefixes at
depths 100 and 1,000. Run each with and without an unrelated active
`DeleteSubtree`. For the deletion variant, delete a distant existing task item
and its paragraph, or a distant paragraph in the root fixture, through
`deleteBlocks` in a setup session. Assert that the emitted effect is an active
subtree deletion and its retained content is outside the edited component.
Do not change the genesis to add the variant.

In a structural session: split the first target, type into each half in isolated
groups, and join them. In a separate unrelated session, edit a distant surviving
paragraph. Return to the structural session for undo and redo, so the top group
is still the join. Supply native before-selection and assert returned/restored
stable selection, continued typing, visible structure, and the persistence of
the unrelated edit and deletion. Identify targets through retained origins,
not fixed child indexes after structural edits.

Capture every new carrier. Compare every completed step with fresh independent
reference reconstruction from the same genesis and exact canonical bytes outside
the candidate timer. Preserve a prior publication throughout the trace. Check
its native reads, ownership, view, and addresses after later publication and
eviction. Run a cold reopen check and continued authoring separately. A restored
session's history covers its new continuation only.

### Exclusive spans and complete work accounting

Keep `observePhases()`'s inclusive API measurements under a separate field. Add
a small opt-in diagnostic recorder at existing internal boundaries. A stack of
active phase labels charges elapsed synchronous work only to the innermost phase.
Pause accounting across generator suspension; resume it only during execution.
Handle observer reentry with the same stack and distinguish attempted from
committed candidates. No recorder changes scheduling, validation, or publication.
The default path has no clock calls or retained trace objects.

| Exclusive phase              | First boundaries to instrument                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Draft/query                  | Command execution and compiler queries in `authoring/editor.ts`, `draft.ts`, `compiler.ts`, and `native-plan.ts` |
| Native preparation           | Writer `NativeTapeCache.prepare()` and publication native apply/index work; distinguish these sites              |
| Exact-author certification   | `certifyLocal()` and ingest author validation, including its private reference work                              |
| Coupled replay               | Ownership preparation, resource preparation, refinement, and effect replay                                       |
| Visibility/normalization     | Provenance reconstruction, full/local projection, exact-deletion indexing, view normalization                    |
| Selection/address resolution | Before/after selection capture, address lookup, and history resolution                                           |
| Canonical append             | Canonical mutation and listener dispatch, excluding nested labeled work                                          |
| Publication                  | Readiness and final tuple preparation/commit, excluding nested labeled work                                      |

Report uncategorized command/driver overhead so the exclusive spans reconcile
with the instrumented wall interval. Keep all raw spans and phase invocation
counts. In particular, exact-author time excludes a nested replay span while
its inclusive envelope still includes it. Record purpose (`author`, `staging`,
or `publication`) so duplicated obligations remain visible. Do not add inclusive
API durations to exclusive totals.

Use separate fresh workers over the same captured initial state for
uninstrumented wall samples and instrumented attribution. Fresh writers get
different new identities; retain each output and verify each against its own
reference. Record that distinction rather than call these identical carrier
replays. Reference checks, fixture loading, and setup edits stay outside edit
timers. Report cold-load, canonical replay, and persistence barriers separately.
When no journal is attached, persistence is explicitly unmeasured. Existing
physical-storage reports remain attributed to their sources; A adds no storage
performance claim.

Extend existing diagnostic counts at actual loops and construction sites:

- Actions enumerated, materialized, deduplicated, sorted, cloned, and compared;
  include comparator calls and compared payload bytes.
- Structural effects inspected, causal/dependency edges visited, and author
  closure elements materialized, even if no effect is replayed.
- Native tape parts, marker bindings, cells and visibility/deletion entries
  traversed; separate index construction from queries.
- Flows, containers and view/address records visited or rebuilt; full
  `ConstructionTree`, provenance reconstruction and projector constructions.
- Allocations and resource/home/coverage/deletion/command indexes built, copied,
  or updated; report affected tape/flow/container identities.

Retain existing `actionsReplayed` and replay-frontier fields. Do not rename a
full scan as a cache hit. Attribute counts to all attempts, with separate
committed-result counts. Sanity checks must detect the full action map/sort and
deletion-index build on today's structural path. Instrumentation tests use an
injected clock to prove non-overlap, reentry, suspension, and restoration when a
phase throws. No production cache or execution mechanism is added in A.

### Test refinement without assuming it commutes

Add native differential fixtures under
`materialization/structural-refinement.test.ts`. Share fixture capture and
observation helpers with the benchmark, not reference reducer state. The
independent side must continue to reconstruct native/provenance/ownership from
the original facts; it must not call the candidate materializer.

The experimental candidate starts from one exact prefix checkpoint. Subdivide
that checkpoint's own cell assignments using `MaterializedCells.refine()` and
the existing `refineCheckpoint()` operation, exposed through a minimal internal
test seam if necessary. Install only resources born by that prefix, using the
existing constructor-derived home and occurrence bindings. A later action's
births enter only at its semantic position. Never copy final merged owners into
an earlier checkpoint. Preserve the production reader guard throughout A.

For prefix P and later native subdivision N, compare candidate refinement of
replay(P, old native) with independent replay(P, refined native), then compare
both after the actual suffix. N must come from a valid native body with its
original marker/native identities. Validate the complete authored actions against
their exact closures first. The commuting equation is the observation under
test, not an admission condition or an assertion used to construct the answer.

| Class                         | Required positive and negative observations                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Marker-stable text            | Existing cells retain owners; insertion activity and exact deletion change visibility without inventing structural work               |
| Interior subdivision          | Subdivide a read and an unread interval; compare split-selected components and all retained insertion positions                       |
| Boundaries and reserved homes | Both affinities at split endpoints and private-home edges; keep reserved cells in raw traversal and outside content adjacency         |
| Empty gaps                    | Consecutive markers, zero text, and insertion on both sides; preserve slot meaning and reject out-of-tape addresses                   |
| Joined/transferred ranges     | Traverse ghost runs and joined tapes outside authored basis; compare retained source and destination addresses                        |
| Inactive split readers        | Undo, subdivide, redo; a dormant reader cannot justify unsafe reuse when reactivated                                                  |
| Cohorts                       | Both tie orders, multiple cuts at one sibling gap, followers, and explicit moves; compare native cut ranking and block order          |
| Concurrent earlier effects    | Author independent join/transfer/split actions at an old closure, then deliver both orders; a changed component must invalidate reuse |

Define an explicit refinement map from each old range to its ordered new ranges
and from old boundaries to the same retained markers/sides. Compare ownership
after mapping, visible UTF-16 text, insertion identities, block/flow/occurrence
order, reserved status, and mutation-address validity. New refined addresses can
legitimately add entries. Check their containing old range, native neighbor
meaning, side, and ordering rather than byte-identical cell lists. Do not collapse
distinct empty gaps just because their numeric text offsets match.

Resolve saved old bookmarks in the refined state; exercise new boundaries by
continued typing and compare exact independent replay. Previously invalid
mutation addresses must remain invalid unless an identified semantic change
explains their availability. Caret fallback does not authorize mutation through
a deleted lineage. Preserve surrogate-boundary rejection, deletion-wins,
interpretation masks, and old-publication immutability.

Each class ends with a supported rule and preservation argument, a conservative
fallback with its dependency, or a minimal valid counterexample. Minimize a
failure by removing unrelated actions/resources while retaining valid births,
causality, and native origin order. Record the first changed observable result.
An unknown result stays a named gap, never a positive classification.

### Proposed shared change-set and candidate lifecycle contract

Freeze the following behavioral contract in A's reviewed output before B, C,
or D adds a production consumer. Reuse `ReadySource`, `NativeView`,
`OwnershipCheckpoint`, `RangeRef`, resource IDs and the existing `prepare()` /
`commit()` pattern. A specifies fields and obligations; it does not build a
generic executor or a new replicated type.

| Part               | Required identity or contents                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base               | Exact genesis, coherent publication identity, ready root with exact payload certificates, and native read generation; heads/counts alone are insufficient |
| Candidate          | Exact action ID and encoded payload, private draft revision, exact author-closure/native evidence, and merged-base identity separately                    |
| Structural changes | Before/after interval subdivision and assignments; block/flow/occurrence placement and order; affected tapes/runs/flows/containers                        |
| Semantic changes   | Insert/delete activity, inherited coverage/tags, interpretation eligibility, masks, projection origins, text slots, and normalization boundaries          |
| Retractions        | Removed or withdrawn resources, invalidated readers/negative dependencies, previous and new locations, and ghost-address changes                          |
| Prepared result    | Immutable candidate roots, validation evidence, change set, resolved selection, work ledger, and explicit fallback/frontier reason                        |

A candidate progresses from private preparation to complete validation/staging,
then canonical retention, then one coherent publication. Queries do not commit.
Only the existing publication owner installs roots. No child independently
accepts an action. Derived evidence is local and never accepted from a peer.

Reuse requires the same action payload, exact relevant base/closure, native
generation, and private draft revision. New ingress, cancellation, limit changes,
eviction, or changed ready payloads invalidate the affected evidence. Unrelated
roots may survive only through an explicit exact compatibility check. A suspended
or rejected candidate cannot install reader refinements or expose new addresses.
Previously published roots stay readable.

Before canonical retention, failure discards the candidate and aborts native
preparation without adding history. After retention, preserve `RetainedEditError`,
the original action ID, and one history registration. Refresh/retry publication
or persistence; never compile and append the user command again. Resolve managed
selection against the exact staged author result before append, preserving the
existing reentrant-observer behavior.

Define and measure two paths independently:

1. **Local causally subsequent append:** start from a coherent publication,
   prepare and certify at its exact author closure, stage selection, append,
   and publish once. Only a proven refinement class can reuse prior structural
   decisions. Unknown dependencies retain today's suffix/cold fallback.
2. **Late/concurrent remote action:** receive original carrier bytes, establish
   readiness and the remote author's exact closure, certify there, then derive
   the merged replay frontier. Earlier order, changed activity, component
   ancestry, or reader dependencies can require suffix or cold replay. Preserve
   that reason and work cost. Local append locality is no bound on this path.

Use public authoring on two independently opened replicas to create the remote
case. Include an unrelated arrival and a genuinely earlier join/transfer touching
the component; deliver both orders and a duplicate. Do not manufacture favorable
Lamport times or certify against the receiving merged cache.

## Non-goals

- Implementing B's structural replay index, C's local projector, or D's shared
  prepared command path in this child.
- Changing split, empty-gap, private-home, cohort, history, or address semantics.
  A counterexample can propose an amendment but cannot enact it.
- New wire formats, dependencies, canonical pruning, persistence mechanisms,
  authority fallback, broad memory studies, or browser cutover.
- Whole-document optimization, a new normalizer, long mixed traces, 10k retries,
  or claiming restored prefixes as uninterrupted results.
- Advancing or merging PR #88, integrating other children, or closing grain/94.

## Suggested implementation shape

After this proposal is approved:

1. Import and verify the original fixture files into a small versioned fixture
   directory with provenance. Add the short managed runner and focused command
   assertions first. Keep large profiles in issue artifacts.
2. Add opt-in exclusive instrumentation and the missing work counts. Run the
   smallest depth first, then restored 100/1,000 cases. Keep each expensive
   worker around five minutes maximum. A protective stop writes an incomplete
   report; it does not pass the case or authorize a larger run.
3. Run the native differential matrix with the current guard intact. Publish a
   limited rule with its preservation argument or a minimized counterexample
   and proposed amendment. Review the result before choosing B's mechanism.
4. Publish the measured phase/work table, classification, and final shared
   contract. Name the selected B mechanism and exact fallback conditions. If a
   semantic amendment is necessary, B remains blocked on its approval; C can
   continue independent locality work against the reviewed resource contract.

## Verification

Before proposal submission, the existing refinement, readers, structural
visibility, tag-reuse, and ownership cohort files passed unchanged: 20 tests in
five files, 18.35 seconds on Node v26.13.0. This is a baseline correctness check,
not a run of the proposed fixture. The four input hashes above were checked
directly from the retrieved artifact. Outer reconstruction found 100/1,000
envelopes with no pending outer structs or delete set and confirmed their command
schedule and different author identities. This is not semantic replay. Original
capture source SHAs remain unverified. No new benchmark was run for this proposal.

Implementation verification will include:

```sh
npm run build
npm run lint
npm run format:check
node --test benchmarks/multiwriter/worker.test.mjs
npm run test -- src/markdown/multiwriter/materialization/structural-refinement.test.ts src/markdown/multiwriter/materialization/refinement.test.ts src/markdown/multiwriter/materialization/readers.test.ts src/markdown/multiwriter/materialization/structural-visibility.test.ts src/markdown/multiwriter/materialization/tag-reuse.test.ts src/markdown/multiwriter/ownership/cohorts.test.ts --maxWorkers=4
node benchmarks/multiwriter/structural-locality.mjs --inputs /tmp/mw13a-inputs --output /tmp/mw13a-results
```

Add focused recorder/runner tests to the benchmark harness test command. Test
the recorder's disabled path, non-overlap and discarded candidates. Compare
complete observations and canonical/native retention outside timing. Report raw
short samples or medians; no p95 claim from a handful of commands. Full suite,
browser/storage and broad scale acceptance remain with the parent and later
children unless an A change exposes a specific regression requiring them.

## Success criteria

- One dedicated short command replays the exact inputs and completes the managed
  sequence, deletion variant, and paired local/remote cases with independent
  checks and explicit completeness.
- Exclusive spans reconcile with instrumented wall time; uninstrumented wall,
  inclusive APIs, cold load, and persistence scope remain separate.
- The work ledger exposes every retained-history/tree/index traversal on the
  measured path, including work before the reported replay frontier.
- Every required refinement class has evidence and a named result. A supported
  class has a preservation argument and negative tests; a semantic failure has
  a minimal valid counterexample and an amendment awaiting separate review.
- The reviewed lifecycle/change-set contract identifies additions, retractions,
  exact identities, invalidation, and one publication owner. B receives a chosen
  mechanism or an explicit semantic approval blocker; C receives usable resource
  boundaries.
- Yjs stays at 13.6.33, the reference stays independent and default, later parent
  commits remain intact, and A makes no parent-completion claim.
