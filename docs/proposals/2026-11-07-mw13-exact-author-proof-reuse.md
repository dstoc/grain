# Proposal: Reuse exact author ownership with an attempt-specific proof

- **Issue:** grain/104; integration parent grain/94. The parent assigns this
  bounded D-owned slice to the existing C/PR96 executor. grain/105 and grain/106
  remain blocked and undispatched.
- **Status:** Proposed. Technical proposal review must complete before production
  changes. Implementation authorization in `cmt_cnRiPYg8rHt1LuEU` retains this gate.
- **Authority:** grain/94 `structural-execution-plan` v1, SHA-256
  `e63457a69a187e962b053452e1072ba24a630569ae43c4b676de13aa44b3adc7`,
  especially §§3–5, the D specification, and §§8–9; grain/104 owner instructions
  `cmt_YoIxrx9OX1uxZrB0` and `cmt_cnRiPYg8rHt1LuEU`.
- **Inspected source:** PR96 head
  `a2ca56b27d98e4a3efab47547e3461def2d5b541`, tree
  `109b46a1b0190d9cfa6532811dda2d5f2aaa1914`, on
  `integration/104-production-projection`.
- **Existing designs:** the [production adapter](2026-11-06-mw13c-production-adapter.md),
  [selected cohort readers](2026-11-07-mw13c-selected-cohort-readers.md), and
  [MW-13 materialization proposal](2026-11-05-mw13-incremental-materialization.md)
  retain their contracts outside this explicitly assigned slice.

## Motivation

A managed editor repeatedly splits the unrelated `xyz` paragraph, then splits
`abcdef` at offset 2. The complete depth-0/8/32 fixture in
`materialization/execution.test.ts` includes construction of every prior managed
command, B preparation, inventory guards, and an independent cold oracle. Keep
all of that work and every assertion inside the existing test.

At the inspected head, CI run 42288746450 failed only the depth-32 case in the
ordinary partition: 6,399 ms against its unchanged 5,000 ms deadline. The owner
recorded the exact diagnostic in `cmt_LCOtVi9sQYZMgIn9`. This proposal does not
rerun it or turn the earlier clean local pass into CI acceptance. The owner also
reports a Node 24.22.2 attribution control that identifies repeated exact-author
and staging work. Instrumented attribution does not predict CI wall time.

The first use case is a managed paragraph split or join at the complete current
publication. Its already certified author past should not need another complete
ownership replay merely to validate the next candidate. The new candidate still
needs its own author checks. A prior certificate alone cannot prove them.

## Problem statement

Paths in this document are relative to `src/markdown/multiwriter/` unless stated
otherwise. These are source observations at the inspected head:

1. `authoring/editor.ts:performEditMeasured()` prepares and binds the final native
   body. Managed history calls `stageLocalAction()` before `appendMeasured()`
   calls `certifyLocal()`. Selection staging and certification have distinct
   obligations and do not currently share one prepared command.
2. `materialization/readiness.ts:checkLocal()` constructs an exact indexed author
   context. `IndexedValidation.past.identity` and the direct dependency tokens
   refer to immutable payload/certificate facts. They are stronger than matching
   action IDs, Lamport time, heads, or visible output.
3. `ingest/validator.ts` already checks references, group sealing/control validity,
   candidate native application, native references, and allocations. It reuses an
   exact native branch where possible. A certificate hit for the *same* bytes and
   dependency certificates is different from certifying a *new* structural action.
4. `projection/validation.ts:createProjectionAuthorValidator()` resolves birth
   callbacks, activity, interpretation selection, allocations and native snapshots,
   then validates membership and calls `createOwnershipAuthorValidator()`.
5. `ownership/validation.ts` again builds the exact inputs, derives homes and runs
   `assertEdgeBrackets()`. Its call to `certifyOwnership()` enters
   `ownership/ownership.ts:replayOwnershipMeasured()`, which clones, deduplicates,
   sorts and replays the complete dependency closure plus candidate.
6. The full replay has author-only checks before each active candidate `SplitFlow`:
   source availability at that ordinal, empty-basis validity, basis occurrence and
   traversal adjacency, and exact captured skeleton. Ordinary B suffix replay in
   `materialization/ownership.ts` intentionally omits those checks. Its successful
   merged result is therefore insufficient proof of author validity.
7. B already owns immutable coupled checkpoints, resource checks, coverage and
   guarded native refinement. `MaterializedOwnership.fork()` separates its private
   generation from the publication. `MaterializedProjection.commandOwnership()`
   exposes such a fork to the compiler, but neither a compiler query nor a staged
   result currently certifies the final author envelope.

The smallest operation to replace is **the complete ownership replay inside one
new local structural action's `certifyOwnership()` call**. This proposal keeps the
validation work before that call, including its full dependency/snapshot/home
preparation. It does not claim to make that preparation local.

## Proposal

### Restrict reuse to an internally established exact local append

Add an internal local-attempt binding in `IndexedActionStore.checkLocal()` and
carry it through `createIngestValidator()` to the materialized author validator.
Use a private registry and opaque tokens. Do not accept a caller-provided boolean,
peer field, serialized certificate, or structurally similar object as evidence.
The reference store and reference document receive no proof provider.

The binding records the store owner, facts version, exact ready source and payload
root, `indexed.past.identity`, direct dependency certificate tokens, and an owned
copy of `encodeEnvelope(action)`. It also names the publication's genesis, B
checkpoint and preparation generation with opaque identities. Bind the final
envelope, including native update bytes, manifest, allocations, effects, group,
dependencies, and action identity. Do not use `copyLayoutAction()` as body identity.

Establish closure equality without exporting the retained action inventory:

1. `checkLocal()` has a complete, integrity-checked ready view. Every supplied
   dependency must be ready, as today. Require the candidate's dependencies to
   include every current ready head; redundant ready dependencies are allowed.
2. Every ready action is an ancestor of a ready head. Thus these dependencies
   cover the entire ready set and include no fact outside it. Bind this reasoning
   to the exact dependency certificates and current immutable ready/payload root,
   not to an independently supplied list of head IDs.
3. The document must have a current authorable publication for the same ready
   source, genesis and facts version. B must own the matching committed checkpoint
   and resource roots. Check all participants before preparation and again before
   consuming the proof.

Empty readiness uses the store's own empty-past identity and a matching genesis
checkpoint. Missing B state declines to the existing full validator. A different
closure, missing head, changed certificate, stale publication or unindexed context
also declines. A remote validator invocation gets no local-attempt binding, even
when its IDs happen to match current heads.

This establishes an exact author state that happens to equal the merged state for
this invocation. It does not generally equate author and merged states.

### Keep the validation preambles and failure order

Retain the existing readiness and ingest checks in their current order. The new
path cannot run before native preflight/application, native references and
allocation validation succeed. Keep `validateMembership()`, host birth callbacks,
activity/interpretation selection, snapshot reads, `deriveHomes()` and
`assertEdgeBrackets()` on the ownership validation path before proof consumption.

Add an optional internal proof provider to the projection/ownership validator
options. Call it only after those preambles succeed, with one invocation token
and the exact ownership inputs that would enter `certifyOwnership()`. The provider
returns a completed opaque proof or an explicit unavailable result. It must not
return an `OwnershipResult` whose existence is treated as certification.

The proof type and mint/consume registry belong in a small internal
`ownership/author-proof.ts` module. The request includes the invocation token,
exact indexed identities, detached action bytes, genesis, selected activity and
the already read snapshots. Only the materialized document wires a provider.
There is no editing command, wire format, persistent schema or public mode switch.

Preserve the current preamble error boundaries. Invoke the optional provider
outside broad semantic rejection catches: a provider/host failure, cancellation
or capacity error must propagate, not quarantine a peer as `reference`. A proven
candidate-data failure returns the existing semantic rejection. Unavailable
evidence invokes the unchanged full `certifyOwnership()` path. Do not convert an
unexpected exception into an unavailable result or successful certification.

### Earn the proof on a private B fork

Add an internal `MaterializedOwnership.prepareAuthor()` entry point. It uses the
existing preparation/refinement and coupled suffix machinery, with a strict
one-action-append requirement and author-check mode. It never commits its fork.
It returns detached completed evidence or a named decline, not publication roots.

The first supported candidate contains exactly one `SplitFlow` or `JoinFlow` plus
the ordinary `SetProperties`/`InsertText`/`DeleteText` effects produced by paragraph
commands. Existing birth/resource validation applies to all candidate allocations.
Other structural effects, multiple structural effects, candidate `Interpret`,
and candidate `SetGroupActive` retain full author certification. Prior deletions,
suppressed births, scaffolds and interpretations are not global exclusions.

Preparation must establish all of the following:

- The retained B prefix is exactly the bound author past, with unchanged payloads,
  order, activity and interpretation decisions. Supply the certified ready prefix
  plus the final candidate; do not reuse an intermediate compiler envelope.
- Candidate native data comes from the isolated ingest author branch after its
  existing validation. Bind a fresh native-attempt token after candidate application.
  A facade's object identity, Yjs state vector or marker existence is insufficient.
- The changed-tape set comes from the validated candidate body, including every
  manifest tape and fresh tape/marker allocation. Its snapshots come from the
  exact request. The untouched native prefix is justified by identical genesis
  and exact author-past payloads. Do not assume continuity merely because a caller
  supplied `stagedTapes`.
- Retained permanent/native identities, order and contents survive. Use the
  existing marker-refinement, subdivision and historical-reader checks. Refine
  each checkpoint's own ownership and reserved classifications. Do not copy final
  ownership backward or waive the reserved-to-ordinary reader guard.
- The selected resume point is exactly the full author-past count. Detect a need
  for earlier replay before executing that replay and decline with its real reason.
  This proof path must not hide a second full prefix replay in preparation.

At the candidate action, install all births before consuming effect ordinals, as
today. In author-check mode, run the existing author-only split predicates against
the detached **pre-effect** state, immediately before applying that split:

1. Reject a source run created by a split at the current or a later ordinal.
2. For an empty basis, require a standalone source and no ordinary content in its
   current top-level traversal. Retain the canonical trailing-home cut and
   no-capture skeleton checks in the resource validation.
3. For a nonempty basis, require each expanded cell's actual occurrence to equal
   the authored occurrence. Require the expanded cells, in authored order, to be
   consecutive in the source's top-level traversal after excluding reserved cells.
4. Compute the cut with the existing native rules. Require the new run's captured
   skeleton, excluding its fresh full home, to equal the selected authored side.

Retain the ordinary B birth, run-skeleton/capture, slot, placement, join/cycle and
coverage checks, including checks on unsuccessful structural intentions. Execute
every effect ordinal in order. A join does not need a split-basis predicate, but
it still needs all ordinary constructor/layout/coverage validation.

The proof must also cover the full replay's constructor audits: exact tape and
marker coverage, retained endpoint/native bindings, unique private homes, complete
and nonoverlapping skeletons, nonreserved captures, immutable occurrence/flow
bindings, reachable owned cells and preserved reserved assignments. Establish
unchanged-prefix obligations from the exact retained resource/coverage roots plus
the guarded native refinement; check candidate contributions before minting.
Implementation review must map every skipped full-replay check to a retained
invariant or a newly executed check. A missing mapping requires full certification.
Passing the four author-only split predicates alone is insufficient.

The independent `ownership/ownership.ts` replay and its author predicates remain
intact. Implement the candidate predicates against B's read interfaces and compare
them with that independent implementation. Do not teach the oracle to consume a
candidate checkpoint or proof. No author-check mode is enabled during ordinary
concurrent merged replay, where component shortening remains valid.

### Consume only completed, detached, attempt-specific evidence

A proof attests that this exact candidate's complete ownership obligation finished
against this exact author past and native refinement. Its internal record contains:

- store/genesis/base-ready/checkpoint identities and the checked generations;
- invocation and candidate-native attempt tokens;
- an owned immutable action-byte preimage, author-past identity and dependency tokens;
- detached refinement/read witnesses and completion of all candidate ordinals and
  author predicates under the exact selected activity.

The consumer checks the invocation, bytes, identities, generations and completion
before replacing the full replay. A missing, forged, stale, partial or mismatched
proof never returns success. A mismatch caused by invalidated work aborts that
attempt; an ordinary unsupported condition falls back before proof consumption.
The existing same-action ingest/readiness certificate reuse remains separate.

Minting is the final operation after all fallible reads and validation. Consume
the proof once inside the same synchronous certification attempt. Discard it in
`finally` on success, rejection, throw or cancellation. Do not keep a proof cache
per action, per session or per checkpoint. A retry earns a new proof. Existing
successful ingest certificates retain their current lifetime and invalidation.

No proof or escaping reader may retain a mutable Y.Doc/native cache, live ingest
facade, activity callback, generator, commit closure, document, previous State
chain or private B fork. Copy the needed witness data before minting; retain only
opaque identities and detached values. Cancel the fork on every path. Keep B's
existing eight-checkpoint bound. Charge temporary candidates and discarded work.

Held publication/native/address/ownership readers remain tied to their original
immutable roots. Preparing, failing, consuming or discarding a proof cannot change
them. The proof produces no canonical, history, activity, B or C installation.

### Preserve append and publication behavior

Keep `LocalEditor.appendMeasured()` as the append boundary and
`MaterializedPublication.build()` as the publication owner. Keep pre-append
selection capture in its current position. An invalid candidate must fail before
the canonical append, native commit and history registration, as today.

Reentrant ingress, facts changes, competing preparations, cancellation, decode
limit changes, eviction and destruction invalidate the attempt. Recheck after
any host callback or resumable boundary. Do not keep proof eligibility merely
because the selected native tape did not change.

If append retains the exact envelope before an observer or persistence failure,
preserve the existing retained-action detection, native commit, history registration
and `RetainedEditError` behavior. Recovery does not append another action or reuse
an expired proof. Existing readiness certificates can still recognize retained
identical bytes under their existing rules. Publication failure after append
retains facts and retries publication; the proof is not a new publication cache.

### Explicit fallback conditions

| Condition | Required behavior |
| --- | --- |
| Reference document, remote admission or unindexed author context | Existing full author validator. |
| Author dependencies do not cover the current exact ready set | Full validation against that author's own closure. |
| Missing/cold/evicted B base or unsupported candidate effect shape | Named proof miss, then full author validation. |
| Earlier order/activity change, native withdrawal/reorder, or reserved-content reader frontier | Decline before earlier replay; retain full exact-author reconstruction and conservative guards. |
| Candidate packet/control, transfer/move/lift, or multiple structural effects | Existing complete certification, including alternate interpretation and effect-prefix checks. |
| Invalid references, manifests, Unicode boundary, homes, brackets, membership or candidate author predicate | Existing rejection; no proof and no append. |
| Stale generation, changed facts or operational/capacity/host failure | Cancel/propagate for retry; do not accept or misclassify as peer data. |
| Lost/stale/forged/partial proof | No bypass; abort an invalidated attempt or use full validation for an ordinary miss. |

Record these operation/input reasons separately. Ordinary supported warm paragraph
split/join must hit the proof path when all stated conditions hold. A generic
"structural edit" miss does not satisfy this slice. The depth-0/8/32 fixture must
show actual hits for its managed splits, including warm-prefix commands.

## Alternatives and scope

**Use a prior successful certificate to skip replay.** Reject this shortcut.
Ancestor certificates establish old envelopes in their own author/native states;
they do not check this candidate's basis, skeleton, ordinal or refined topology.

**Reuse compiler or selection staging output directly.** Current compiler queries
can replace an unpublished envelope, and `stageStructure()` does not run the
author-only split checks. A future D prepared-command path can produce the same
proof contract, but must bind the final bytes and earn the same predicates.

**Replace pre-append staging first.** D's full prepared-command design could remove
`reconstructProvenance()` and `projectWithActivity()` during selection staging.
It also changes compiler/query, selection and publication lifetimes. It leaves
the current full ownership certification unless that separate obligation is
addressed. The chosen slice changes the replay obligation first, retains staging
behavior, and measures its remaining cost separately. Neither route alone is a
promise that the original CI deadline will pass.

**Keep another retained author replay engine.** Do not add one. Use a bounded fork
of the existing producer when the exact author base is already available. Other
closures keep reconstruction. This limits the first change to local supported
commands without weakening offline multi-writer validation.

## Non-goals

- Removing full dependency, birth, activity, snapshot, home or edge-bracket
  preambles; optimizing the compiler or replacing structural staging.
- General remote author-state caching, packet/control/multi-effect proof coverage,
  a second replay engine, normalizer, publication owner or proof-history cache.
- Changed Markdown, ownership/conflict/history semantics, independent reference,
  default mode, wire/persistence formats, Yjs 13.6.33 or canonical retention.
- D's whole-command p50 15 ms acceptance, E's scale/retention gate, B/C/parent
  acceptance, readiness authorization, approval, merge or issue completion.
- Changing B/PR94, PR88/shared feature, evidence refs, parent/D/E state, labels,
  dependencies, workflows, protections, fixtures, assertions or deadlines.

## Suggested implementation shape

After technical proposal review:

1. Add the internal request/proof contract and exact local-attempt registration.
   Test forged tokens, byte/dependency changes, incomplete head coverage and
   cross-store/genesis attempts before wiring a production hit.
2. Add B's private author-check mode and strict append/refinement requirement.
   Cover the reference's candidate predicates and invalid constructor inputs.
   Keep all normal B preparation paths and reference certification unchanged.
3. Wire the optional provider only in `openMaterializedDocument()`, at the full
   ownership replay boundary after the original preambles. Add hit/miss/work
   diagnostics and failure/retention controls. Never consume compiler output as proof.
4. Verify the unchanged managed fixture and focused semantics/lifetime cases on
   Node 24.22.2 with two workers. Then run required applicable final-source checks
   and publish a coherent candidate for independent implementation review.

The likely production surface is `materialization/document.ts`,
`materialization/readiness.ts`, `ingest/validator.ts`, `projection/validation.ts`,
`ownership/validation.ts`, the new internal proof module, and the narrow
`materialization/coupled.ts`/`ownership.ts` author-mode plumbing. Existing context
types may need an optional internal binding. Add no peer-supplied field. Any wider
API/lifetime change returns to technical review.

## Verification

Proposal-stage evidence consists of source/contract review, exact source hashes,
protected-ref/PR receipts and document checks. No new timing retry, broad suite,
long workload, CI rerun or denied download/artifact retry is part of this proposal.

Implementation verification must include:

- The complete unchanged depth-0/8/32 `execution.test.ts` fixture and oracle, under
  the original 5,000 ms test deadline, two workers and unchanged CI partitions.
  Count actual proof hits and full author reconstructions across its complete warm
  setup. Do not time only the final split or move the setup/reference outside the test.
- Work counts for proof requests, hits, each miss/rejection, candidate ordinals,
  author predicates, snapshot parts read/copied, native/refinement cells visited,
  prefix actions replayed and discarded work. A supported hit replays zero old
  author actions and runs one candidate suffix. Existing preamble enumerations
  remain charged; inclusive phase timings must not be added as exclusive spans.
- Independent full-validator comparison for valid/invalid split bases, both sides,
  empty and joined sources, ordinary empty cells, wrong occurrences/skeletons,
  unavailable same-action source runs, duplicate births, overlapping captures,
  reserved/sentinel transfers, invalid native manifests and UTF-16 boundaries.
  Candidate transfers/packets/controls can decline while still requiring identical
  full-path rejection and operational error behavior.
- Byte/body mutation with unchanged IDs, changed dependency certificate with equal
  IDs, missing/redundant heads, changed genesis/store, attempted peer proof reuse,
  concurrent text and empty-cut author-versus-merged states in both arrival orders,
  native withdrawal/reorder and reserved-to-ordinary historical-reader invalidation.
- Managed split/type/join/distant-edit and undo/redo with selection and subsequent
  typing, cold/warm/evicted caches, distant deletion/suppression/scaffold and prior
  interpretations. Compare complete normalized output, origins, masks, visibility
  tags/order, empty slots, ownership, both-affinity addresses and canonical/native
  bytes with the independent reference, including held old-publication reads.
- Host birth/snapshot/provider failures, capacity retry, cancelled/suspended work,
  stale native/projection generations, competing preparation, late fork/withdrawal,
  reentrant ingress, pre-append rejection, retained observer/persistence failures,
  single history registration and retry without duplicate append.
- Bounded WeakRef/GC controls proving temporary proofs/forks are released with old
  readers held. Check repeated success, fallback, rejection, cancellation, eviction
  and destroy. Retain the eight-checkpoint bound and existing certificate retention.

Extend the existing ownership/projection validation, ingest, readiness, publication,
eviction and managed-history controls rather than replacing their assertions.
Keep the independent oracle outside candidate timing when collecting new diagnostic
timings, while preserving its original placement in the unchanged CI fixture.

Use approximately five-minute individual-workload limits without changing existing
test deadlines. A protective stop remains incomplete evidence. No 10k or comparable
long run follows from this slice. Required final-head CI and independent
implementation review remain gates; do not rerun unchanged CI to seek green.

## Success criteria

- A supported exact local split/join earns and consumes one detached proof after
  all original preambles, with zero old author actions replayed on the proof path.
- Every mismatched, unsupported, remote or unsafe attempt retains full exact-author
  validation or the existing invalid-input/failure result, with no canonical writes.
- The independent reference, complete semantic/lifetime controls and unchanged
  depth-0/8/32 fixture pass at the implemented source under the retained settings.
- Accounting includes preambles, misses and discarded work; staging costs and any
  remaining CI failure are reported separately without a whole-command claim.
- PR96 stays draft with auto-merge unset until fresh readiness authorization. The
  technical review of this proposal and independent implementation review remain
  separate from user authorization and B/C/parent acceptance.
