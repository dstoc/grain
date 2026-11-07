# Proposal: Validate an exact local structural suffix before building inventories

- **Issue:** grain/105 (MW-13D); integration parent grain/94.
- **Status:** Proposed preservation plan. Review is required before changing this
  validation route or the two additional diagnostic expectations below.
- **Authority:** parent `structural-execution-plan` v1, SHA-256
  `e63457a69a187e962b053452e1072ba24a630569ae43c4b676de13aa44b3adc7`;
  grain/105 comments `cmt_MqFy1CRc7FyFtF7F` and `cmt_AUg094B0AlMUVT4O`.
  Their approved worker amendment and strict candidate-presence checks are already
  implemented; that approval does not extend to this proposal.
- **Inspected source:** child PR97 at
  `2c28bef9b7bf912ea82698dd3d506b602ae33c05`, tree
  `3bbf074feb0938ebaa203c77ab9fb4fc264804e3`, on
  `feat/105-prepared-structural-command`. Production code is identical to
  `065c3e2f7a305a1f5aa27de3d3b300e8af280ac8`.
- **Integration base:** `21890d7babf2052490c117e459c0aa157e42d8fe`.
  PR97 remains draft against `feat/94-incremental-materialization`. The parent
  owns integration. Preserve subsequent commits and the separate evidence ref.

## Motivation

Use the existing managed `abcdef` paragraph split at offset 2, after 0, 8 or 32
unrelated births. It already earns an exact-local author proof with one B suffix
and zero old author replay. The proof still receives inventories of every action,
allocation, home and native tape. That preparation grows with unrelated history
before the proof provider can decline or accept anything.

The original 150-paragraph alternating protocol at production source `065c3e2`
reports split/join p50 73.993/40.169 ms and p95 91.155/52.710 ms. The 15 ms p50
target fails. This changed-source measurement follows a joined-flow footprint
correction; it does not replace the earlier failed f7562cc result. Host idleness
was not established. The observed inventories identify work to remove, not a
measured attribution of the whole latency gap or a promise that this slice meets
15 ms.

## Problem statement

Paths below are relative to `src/markdown/multiwriter/`.

1. `projection/validation.ts:createProjectionAuthorValidator()` reads
   `context.dependencies` before requesting a structural proof. The getter enters
   `materialization/readiness.ts` and materializes, sorts and clones the closure.
   It then reconstructs ancestor births/activity/interpretations, allocations and
   every tape snapshot.
2. `ownership/validation.ts` shares those inputs but still inventories homes and
   runs `assertEdgeBrackets()` through a full `CellIndex`. Sharing the preamble
   prevents duplication; it does not make the preamble local.
3. `materialization/document.ts:prepareAuthorProof()` then builds another complete
   snapshot map before selecting the candidate's changed tapes. The B suffix only
   needs the exact retained roots and candidate contributions.
4. The indexed ingest checks already certify ancestor payloads and dependencies,
   apply/validate candidate native bytes, validate native references and allocations,
   then bind the native attempt. None of these obligations may be removed.
5. Existing `materialization/author-proof.test.ts` explicitly requires the current
   growing inventory counts. Those assertions need a separate reviewed migration.
   The already approved four-line worker correction does not authorize it.

## Proposal

### Try the existing eligible class before the eager preamble

Add a narrow internal early local-proof callback to the projection author
validator. Invoke it after ingest has called `bindAuthorNative()`, before reading
`context.dependencies`. Its request contains invocation, final action, indexed
context and exact native view. Split the common attempt identity fields from the
existing full `AuthorProofRequest`; full ownership input/activity remain available
on the existing fallback request. The mint/consume registry stays private.

Keep eligibility exactly as `prepareAuthorProof()` currently defines it: one
`SplitFlow` or `JoinFlow`, optionally `SetProperties`, `InsertText` and `DeleteText`,
with an internally established exact local attempt and matching authorable
publication. Do not add `MoveBlock`, packets, controls, multiple structural effects,
remote contexts or different author closures. A compiler's permission or staged
view cannot confer eligibility. Ancestor packets, deletions and hidden births are
not blanket exclusions; their certified indexed roots remain authoritative.

An unavailable early result runs the existing full validator, including its current
preamble and full exact-author fallback. A proved result must be consumed against
the same invocation before returning success. Proven candidate-data failures retain
the current rejection result. Host/provider failures, cancellation, invalidation
and capacity errors propagate under their existing boundaries. Do not catch them
as a successful proof or a convenient fallback.

### Reuse exact roots; check candidate contributions

Use the current `localAuthorBase()`, `bindAuthorPublication()` and
`projection.authorOwnership()` bindings. Require the exact store owner, facts
version, ready/payload roots, author-past identity, ordered direct dependency
certificate tokens, complete action-byte preimage, native-attempt token, genesis,
B checkpoint, C projection and preparation generations. Recheck after callbacks,
resumable boundaries and before consumption. Semantic equality, action IDs, state
vectors and a convenient merged view are insufficient.

Fork the matching `MaterializedActivity` and B resource/home/checkpoint roots.
The activity fork must verify its source is that exact bound publication before
appending the candidate through indexed `readyAppend()`. Use its indexed queries
and the committed interpretation eligibility readers. No `.actions`, `.effects`,
packet export or `selectInterpretations()` over the retained inventory is allowed
on the successful early route. A candidate without `Interpret`/controls cannot
change ancestor membership or activity; ingest still checks group sealing and
references. Check candidate eligibility explicitly, as the current provider does.

Resolve `options.births(action)` once for this candidate, outside semantic rejection
catches. Keep the callback's operational failures visible. Do not invoke ancestor
birth callbacks. Keep `validateMembership(action, [])`: for this unchanged class it
returns immediately because there is no `Interpret`; packet candidates decline
before this point and still get the full membership validator.

Derive changed/new tapes from the already validated native manifest and tape/marker
allocations, including marker-only changes. Fetch and validate each selected exact
snapshot once through a command-local map. Derive fresh homes from candidate
births/effects, and read retained homes through indexed tape/flow queries. Add a
narrow internal B author-input reader if needed; do not export full resource roots
or store historical complete author results. Reads needed by skeletons, captures
or author-visible traversal remain charged to that affected dependency component.

Run the existing author-only B suffix and all constructor/coverage/refinement
checks. It must resume at the full author-past count and consume exactly one action.
An earlier replay requirement declines before that replay. Replace the all-snapshot
map in `document.ts` with selected exact reads; callbacks must not quietly rebuild
it. Untouched native/resources are justified by the exact retained prefix and
continuous candidate insertion branch, not by final ownership copied backward.

### Preservation mapping

| Existing obligation                                        | Retained evidence or candidate check before minting                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ancestor bytes, causal references, groups and certificates | Existing readiness/ingest certificates, exact past identity, dependency tokens and payload roots. Keep all ingest checks and same-body certificate checks.                                                                                                                                                                                                      |
| Candidate native preflight/application and references      | Existing ingest order is unchanged; bind only after application, native references and allocation checks succeed. No direct provider or store bypass.                                                                                                                                                                                                           |
| Candidate births and immutable occurrence/flow bindings    | Resolve only candidate bindings; B installs every birth before effects using the existing constructor validation. Malformed or ambiguous provenance still fails.                                                                                                                                                                                                |
| Tape/marker coverage and permanent endpoints               | Retain certified resource counts/roots for untouched tapes. Existing `OwnershipResources.append()` audits every changed/new marker tape and global exact counts. Unknown, missing, repeated or wrong-native markers fail.                                                                                                                                       |
| Native partition, including marker-only input              | Construct the existing `CellIndex` for every changed/new tape, even with no text insertion. Reuse only certified untouched partitions under exact native continuity. No snapshot or partition check may be omitted because `inserted` is empty.                                                                                                                 |
| Private homes and skeleton/capture rules                   | Existing `deriveHomes`, indexed `MaterializedHomes`, resource append, skeleton overlap/order, capture and reserved-home checks. Query affected retained homes; do not rederive or scan unrelated homes.                                                                                                                                                         |
| Edge typing brackets                                       | Extract a selected-tape version of the current `assertEdgeBrackets` algorithm. On each actual home tape touched by candidate native changes, remove only candidate interior markers from the prior-marker view, retain sentinels, and require two fresh interior brackets at a home edge. Compare with the unchanged full helper on valid and malformed inputs. |
| Retained native order and historical readers               | Keep strict continuity/subdivision, marker identity, content and reserved classification dependencies at each checkpoint. Preserve the reserved-home/content-adjacency counterexample and conditional refinement rule; marker-only change is never unconditional reuse permission.                                                                              |
| Ownership reachability, cover and placements               | Existing B suffix constructor/layout/coverage checks, joins/cycles and all effect ordinals, including unsuccessful intentions. Retained coverage roots require the exact certified prefix.                                                                                                                                                                      |
| Author-visible split basis                                 | Preserve `materialization/ownership.ts` author predicates at the pre-effect state: source availability, standalone empty-basis rule, occurrence identity, consecutive top-level content traversal excluding reserved cells, and exact captured-side skeleton. Ordinary merged replay is not author certification.                                               |
| Activity and interpretation eligibility                    | Exact indexed activity fork and committed eligibility roots, plus explicit candidate ordinal checks. No packet/control eligibility expansion; no lazy full activity export.                                                                                                                                                                                     |
| Proof completion and consumption                           | Mint last after all checks. Keep detached byte/refinement witnesses, opaque identities, every ordinal, exact replay bounds and single consumption. Clear proof/attempt registries and forks in `finally`.                                                                                                                                                       |
| Selection, history and publication                         | Existing final prepared command and one publication owner remain unchanged. Revalidate candidate identity before append; stage selection against the exact result. Retained append still registers once and raises `RetainedEditError` without duplicating the action.                                                                                          |
| Held reads and lifetime                                    | Keep immutable old native/view/address/resource roots. Temporary readers capture completed roots rather than live owners or prior-State chains. No new persistent cache or checkpoint family.                                                                                                                                                                   |

A missing mapping, an unproven prefix/root or a required broad read declines to
ordinary full validation. This table does not authorize dropping an obligation.

### Exact diagnostic migration requested for review

Only these two existing growing-count expectations would change in
`materialization/author-proof.test.ts`; preserve all independent oracle assertions,
existing deadlines and the positive proof/suffix counts:

```ts
// Replaces the triangular snapshotBindingsIndexed expectation.
expect(report.work['author/authorProof.snapshotBindingsIndexed'] ?? 0).toBe(0);
expect(report.work['author/authorProof.affectedTapesValidated']).toBe(2 * (depth + 1));

// Replaces the triangular preambleActions expectation.
expect(report.work['author/authorProof.preambleActions'] ?? 0).toBe(0);
expect(report.work['author/authorProof.candidateActionsValidated']).toBe(depth + 1);
```

The exact existing fixture changes two native tapes per split: its cut-source tape
and fresh home tape. Count a distinct validated tape once per attempt. This is not
a universal two-tape bound for arbitrary payloads. The old counter remains live on
fallback inventory construction; the new counters charge actual successful local
work, not attempted callback calls. Keep the existing action-byte/refinement-copy
assertions and compiler-query versus author-suffix assertions unchanged.

Add strict zero expectations for `readiness.authorClosureMaterialized`,
`authorClosureCloned`, `authorClosureSortInputs`, both full preamble snapshot/home
inventories, full reconstructions and old author replay on eligible warm commands.
Require one final prepared and published candidate per command. Preserve the
approved unconditional presence checks. Keep fallback tests with positive full
validation counts so zero counters cannot mean an unexercised route.

Instrument lazy activity ordered traversal/actions/effects exports, candidate and
ancestor birth callbacks, home/tape queries, snapshot traversal/copies, resource
exports, native body copying, causal/frontier/index visits, suffix work, allocations
and discarded candidates. Count actual reads behind callbacks/getters. Separate
necessary affected-component fragmentation from unrelated-history growth.

## Non-goals

No cold/evicted staging optimization, history-control proof, edge Enter move,
packet/remote exemption, eligibility expansion, authority fallback, persistent
format, provider bypass, pruning, public command rewrite or generic incremental
framework. No E/parent acceptance or new UI/history behavior. Existing exact native
branch setup may still load a cold prefix before this callback; report that cost
rather than attributing it to removed preamble work.

## Suggested implementation shape

1. After review, add the early attempt request/provider and selected preamble checks
   without changing the full route. Extend the exact committed author readers with
   only the required activity/home/resource lookups and generation guards.
2. Wire the already-supported class, mint/consume the existing detached proof, and
   retain all named conservative declines before old replay. Add work counters at
   actual traversal/allocation sites, including lazy activity readers.
3. Apply only the reviewed diagnostic migration. Keep full-scan/reference validators
   independent and compare selected validation with them on the finite corpus.
4. Validate correctness/lifetime first, then short 0/100 work and phase diagnostics.
   Run a new original alternating 150-node measurement only after the source and
   smaller gate justify it. No unchanged-source favorable retiming.

## Verification

Use Node 24.22.2 and two workers where prescribed. Preserve the current 685-case
inventory (the original 679 plus six joined-footprint regressions), seven static
checks, complete 13-control worker/lifetime command, original fixtures, assertions
outside the reviewed migration, deadlines and independent oracle placement.

Finite added controls cover both accepted and declined outcomes:

- Exact-local split and join after 0/8/32 unrelated births, original 10/150 fixtures,
  unrelated deletion and ancestor interpretations; typing both halves, join,
  distant edit, selection undo/redo and continued typing. Compare complete native,
  origins/visibility/tags/masks, ownership, empty slots, both-affinity addresses and
  held identities with independent replay.
- One mutation each for invalid birth binding/private home, wrong/missing marker,
  repeated/extra tape, malformed marker-only partition, missing edge bracket,
  overlapping/reserved capture and noncontiguous/wrong-occurrence/captured-side
  split basis. Compare rejection with full exact-author validation; canonical
  bytes, history and prior publications remain unchanged on rejection.
- Changed final payload, missing/different dependency closure, remote author versus
  merged publication, changed native attempt, late ingress, earlier frontier and
  guarded refinement miss. Require a named conservative decline/full validation
  or existing invalidation result, never a forged local hit.
- Cancellation/reentrancy at callback and resumable boundaries, provider/host errors,
  retained observer/persistence failure, retry without duplicate history/action,
  and expired proof/fork collection while old readers remain held.

Keep individual expensive commands near five minutes. Retain failed/guarded runs as
incomplete. Record separate prefix/branch setup costs, non-overlapping draft/query,
native, certification, B replay, visibility, selection, append and publication phases,
and independent uninstrumented wall samples. Do not sum inclusive envelopes or
claim text-core 2/5 ms from full-command times. Continue deferring the known expensive
1,000-prefix diagnostic until smaller gates justify it; no new 10k attempt.

## Success criteria

- The unchanged eligible warm class performs zero historical closure construction,
  unrelated tape/home inventories or full author reconstruction, with one author
  suffix, zero old replay and one final prepared/published command.
- Every listed obligation has executed candidate evidence or a bound immutable
  retained invariant; negative controls reject or fall back correctly.
- Full remote/different-closure/unsupported validation and the independent reference
  remain intact. Lifetime, cancellation, retained-error and selection contracts pass.
- Actual work/phase/wall and setup/memory costs are source-pinned. The 150-node p50
  15 ms target and broader D acceptance remain gates, even if this slice passes.
- Independent plan review precedes production mutation; Check, implementation Review,
  Manual Review and parent integration remain separate decisions. PR97 stays draft,
  auto-merge unset, with Needs-Manual-Review, dependency links and shared refs intact.
