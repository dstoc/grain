# Proposal: MW-15 ingest validation and resource limits

**Issue:** grain/96.  
**Status:** Proposed; implementation requires proposal review.  
**Authority:** [MW-00 proposal, version 1](https://tines.tbuckley.dev/issues/prj_L8Cva7P0y96K81kq/81),
especially §§4, 6–8, 10.1, 13 and 14.  
**Inspected baseline:** `origin/yjs` at
`046410d155fcb9d93414696113a23a7bf4151472`. This includes MW-01, MW-02,
MW-03, MW-05, MW-07 and MW-11. Yjs remains pinned to 13.6.33.

## Motivation

A receives an action whose manifest names a valid tape but whose native body
contains an unauthorized insertion. B receives the same action after its
prerequisites. Both must retain the record for diagnosis and exchange, quarantine
the action and its dependents, and keep its text out of the editable projection.
An independent valid branch must remain usable.

The same receiver can receive a valid but expensive backlog. Exhausting its local
work budget must postpone work without declaring that backlog invalid. After
resuming, receivers with the same facts must compute the same result regardless
of their budgets, delivery order or machine speed.

## Problem statement

Validation exists in separate modules:

- `actions/cbor.ts` checks canonical CBOR and input lengths, but recursively decodes
  containers without explicit depth or work limits. `codec.ts` converts decode
  failures into `EnvelopeDecodeError`, with `version` or `reference` reasons.
- `actions/store.ts` retains variants, checks actor chains, computes author
  closures and calls `validReferences()` plus a required injected validator.
  `snapshot()` synchronously walks the held graph, copies closures and validates
  candidates. It has no resumable work limit. The store does not supply a
  production native/semantic validator.
- `actions/references.ts` checks resource existence and kind in the author's past
  and current allocations. Existence alone does not establish native range
  validity, ownership or legal allocation relationships.
- `text/validate.ts:inspectBody()` checks permitted native content, manifests,
  origins, tape membership, marker births, Unicode and insertion ordering.
  `text/cache.ts:NativeTapeCache.apply()` validates before integration and rebuilds
  after an integration failure. It expects already-ready bodies and cannot alone
  certify readiness against an action's own causal base.
- `providers/adapter.ts:receive()` checks direction, copies and applies bytes, then
  journals admitted raw ingress, including unresolved outer structs. There is no
  message or queue admission limit. `ActionStore.applyUpdate()` invokes
  `Y.decodeUpdate()` before any explicit resource gate.

The current store tests cover forks, version errors, missing dependencies and
validator failures. Native tests cover forbidden content and malformed origins.
The fault harness has corresponding corpus cases, but its transport probe is not
the integrated schema-3 replica. MW-04 ownership and MW-06 projection are absent
from this inspected checkout. MW-15 must not replace their semantics with a test
model or claim that the full composition gate has passed.

## Proposal

### Ownership and validation order

Add a headless `src/markdown/multiwriter/ingest/` module for validation composition,
resource accounting and typed operational outcomes. Keep CBOR checks in
`actions/`, native checks in `text/`, and directional admission in `providers/`.
Reuse `ActionReadiness`; do not introduce another envelope format or semantic
acceptance revision. The first callers are the action-store and provider tests;
MW-08 supplies the integrated replica caller.

Apply these stages in order:

1. Check receive direction and host admission capacity before copying or decoding
   remote bytes. Local journal restoration uses the same decode safeguards but
   remains permitted in every synchronization mode.
2. Preflight the outer update with bounded parsing before Yjs integration. Check
   complete encoding, lengths, struct counts, nesting and permitted append-only
   carrier structure. Reject native deletion before integration, including cold
   checkpoints. Missing outer native prerequisites remain admissible pending
   data, not malformed data.
3. Retain admitted canonical bytes. Decode envelope entries within explicit work
   limits. A deferred decode remains undecided, including when no trustworthy
   action ID is available; it is not an anonymous malformed-record diagnostic.
4. Run existing version, fork, document/genesis, chain and causal-closure checks.
   Missing dependencies stay pending. Quarantine known malformed actions and
   their dependents; do not select a payload by arrival order.
5. Validate native bodies and semantic references against exactly the action's
   ready dependency closure plus common genesis and its own births.
6. Materialize and reduce the certified closure privately. Publish its native
   view, reduced state, addresses and heads together only after completion.

The canonical store may hold quarantined envelopes. Admission to storage does
not certify an edit or expose its native body. Malformed outer carrier data must
fail preflight before mutating canonical state or emitting persistence events.
Do not rely on catching `Y.applyUpdate()` after it has begun to mutate a document.

### Author-closure certification

Provide a validator factory that fits `ActionStoreOptions.validate`. Its inputs
include the common genesis native body and semantic genesis, not just the
allocation list. Native origins must come from genesis, the supplied dependency
closure or the same action. A cache containing unrelated concurrent actions must
not make an otherwise invalid origin or reference pass.

Reuse `NativeTapeCache` and `inspectBody()` for native certification. Isolate the
candidate from the published cache. The slow reference path may reconstruct the
exact causal base for a test or cold replay. Cache successful certification by
immutable envelope bytes and exact dependency facts; retain an incremental path
for ordinary local appends. Full reconstruction per ordinary keystroke remains a
release failure under MW-00 §13. Cache eviction discards derived state only.

Complete the following checks without duplicating the native decoder:

- Allocation ownership/ordinal uniqueness; tape/marker and node/flow/home
  consistency; occurrence slots and their permanent predecessors.
- Exact native manifest coverage, ID uniqueness, safe nonzero range lengths,
  overflow checks and UTF-16 boundaries. Reject delete/format, nested shared
  types, unexpected embeds/maps, wrong tapes and missing or reversed origins.
- Native references in effects must identify the claimed strings/markers in the
  author's closure. Being present in the merged live cache is insufficient.
- Author-local split bases, transfer ranges, deletion coverage, interpretation
  masks and group-control targets must satisfy their owning reducer contracts.
  Use the existing reference/control checks and the MW-04/MW-06 author-view
  validators when those modules are available. Require those validators for
  affected effects; never silently certify an unsupported effect with `null`.

Preserve the distinction between malformed input and concurrent interpretation.
For example, a cycle-rejected move remains a valid retained intention under the
layout reducer. Do not quarantine it because it loses in the merged view.
A later undo must not retroactively invalidate an earlier author's references.

A known data-validation failure maps to the existing readiness reasons. Version
and fork errors remain explicit. Unexpected exceptions propagate as operational
failures and prevent publication; they must not permanently quarantine valid
facts. Replace string-matching of native exceptions with typed internal errors
where needed. Public diagnostics include stage, stable code and trustworthy
identity when available, without copying entire payloads into error messages.

### Resource limits are operational

Keep three concepts separate:

| Outcome | Meaning | Required behavior |
| --- | --- | --- |
| Quarantined | Deterministically invalid protocol facts | Retain admitted bytes and reason; exclude action and dependent bodies. |
| Pending | Missing causal prerequisites | Retain facts; retry when prerequisites arrive; continue independent work. |
| Deferred/backpressured | Local capacity or work budget exhausted | Report retryable operational status; do not assign a quarantine reason. |

Do not add resource exhaustion to `ActionReadiness.reason`. A completed readiness
snapshot keeps its existing meaning. Add a separate budgeted computation entry
point whose result is either complete or deferred with a continuation. Deferred
results must not masquerade as a complete snapshot with a shorter `ready` array.
Keep the existing synchronous snapshot as the reference/oracle entry point.

Proposed default local limits, subject to review:

- Remote update admission: 8 MiB per message, checked before copying or Yjs decode.
- Decoder slice: 100,000 visited values/structs and 64 nested containers.
- Validation/reduction slice: 10,000 charged operations. Charge dependency edges,
  resource/range visits, native-origin traversal and reducer effects, not just
  the number of actions.
- Provider outstanding persistence capacity: 32 MiB of queued bytes. Apply remote
  backpressure before admission when the queue has no capacity; reserve a
  conservative allowance for both raw ingress and emitted integrated updates.
  Local publications remain applied and visibly unsaved if storage cannot keep
  up, as required by MW-11.

These are local scheduling/admission defaults, not new protocol maxima. A host
can raise them. A size refusal imports no bytes and acknowledges no successful
receipt. The sender retains the message and retries with sufficient capacity or
uses smaller ordinary Yjs updates that preserve original native identities.
Do not assume every large update can be split safely; the fallback can require
a larger configured limit. Do not discard an already-held record after a limit
change or require a new genesis to resume.

Check lengths and counters before allocation, recursion or loops. Use a bounded
iterative scanner before calling Yjs's decoder, including its variable-length
fields and embedded values. Keep the scanner restricted to the pinned carrier
and insertion-body formats and calibrate it against actual Yjs-generated updates.
A scanner budget failure is retryable; an established encoding violation is a
data error. Do not call Yjs decode first and count its output afterward.

Decoder continuations retain copied input and cursor state within the admitted
capacity. Replace unbounded recursive paths where a long valid origin chain
would otherwise exhaust the JavaScript stack. No timeout, allocation failure or
stack overflow may be converted into semantic rejection. A depth deferral that
cannot proceed under the current limit must say which limit the host must raise.

MW-13 owns optimized replay and production performance. MW-15 defines charged
work units and tests the budget contract with the reference path. A wall-clock
budget may decide when to yield, but never which facts survive. Each resume must
make progress or return an explicit capacity requirement; repeated small slices
must not restart the entire calculation indefinitely.

### Publication, invalidation and persistence

Stage derived changes behind one publication boundary. An incomplete action,
failed native apply, failed reducer or exhausted slice cannot expose partial
text, ownership or addresses. The previous completed projection can remain
visible only with explicit stale status; it cannot be used to author against an
invalidated causal base.

A newly discovered fork or invalid dependency can withdraw a previously
materialized closure. Immediately invalidate its authoring certification and
rebuild derived state from the new certified closure with a fresh native client,
as specified by MW-00 §4.3 and the existing cache recovery path. If that rebuild
is deferred, suspend edits against the invalidated cache until it completes.
Ordinary unrelated missing dependencies do not suspend valid independent editing.
Continuations are tied to their input facts; new variants invalidate affected
work before publication. A new outer receipt alone need not invalidate an
unaffected completed certification.

Preserve MW-11's admitted-raw-ingress durability rule. Deferred envelope decoding
still retains the admitted outer update, including unresolved native structs and
mixed integrated/unresolved messages. Rejected or backpressured messages enter
neither the store nor journal. Every provider route uses the same admission gate
following its mode check. Journal replay must fail or explicitly wait for enough
capacity; it must not open an apparently successful partial document.

## Non-goals

- No authentication protocol. The host authenticates and authorizes document
  writers; actor IDs and hashes remain identifiers, not credentials.
- No Byzantine-safe Yjs store, process sandbox or hard memory guarantee against
  malicious authorized writers. Bound documented parser work and admission.
- No canonical pruning, replica expiry, history eviction policy, checkpoint
  replacement format, new genesis or forced branch replacement.
- No competing ownership/projection algorithm, browser cutover or production
  incremental-replay implementation. MW-04/MW-06/MW-08/MW-13/MW-16 keep their gates.
- No new package dependency or change to the pinned Yjs version.

## Suggested implementation shape

1. Add operational outcomes and accounting in `ingest/`, plus bounded CBOR/native
   preflight. Keep semantic readiness unchanged and preserve codec vectors.
2. Connect native and author-reference certification to the action-store validator.
   Introduce typed native validation errors. Add causal-base tests with real
   independently authored native bodies before broad fuzzing.
3. Add budgeted readiness/reference reduction with continuations and atomic
   publication tests. Coordinate author-view hooks with MW-04/MW-06. Unsupported
   hooks remain explicit incomplete integration, never passing stubs.
4. Add provider admission/backpressure and restart regressions. Update public API
   notes, module boundaries and compatibility inventory as needed.
5. Run the fault matrix through MW-08's real factory when available. Report
   missing composition coverage before merge; dependency prerequisites remain
   required for acceptance even if development starts against frozen fixtures.

## Verification

Use deterministic seeded generators and save minimized failures as regressions.
Do not add a fuzzing dependency merely to generate byte mutations.

- Extend all-prefix truncation tests with canonical/noncanonical CBOR mutations,
  length inflation, deep containers, invalid UTF-8, counter overflow, unknown
  variants and version errors. Assert limits trigger before prohibited allocation
  or decoder entry; report deferred input separately from malformed input.
- Generate real native bodies using Yjs 13.6.33; mutate manifests, origins,
  parent/tape references, struct clocks, content types, marker allocations and
  Unicode boundaries. Include same-body cycles and reversed origin bounds.
- Send a body that only passes with a concurrent unrelated origin. Certify in
  both arrival orders and after checkpoint/restart; both must quarantine it.
  Repeat for semantic resources and later undo controls.
- Deliver forks after their descendants were visible. Verify both variants stay
  retained, dependent bodies are withdrawn, the cache is rebuilt, independent
  work survives and subsequent local edits cannot reference contaminated state.
- Compare budgets of 1, 7 and 10,000 charged operations against complete reference
  replay. Check multiple delivery orders, repeated resume, empty slices, new
  input during replay and failure after an earlier effect in one action. Compare
  completed heads, native identities and reduced state; observe every publication
  to prove that no partial action escapes. A single operation larger than a
  slice must yield a capacity requirement or have its own resumable substeps.
- Test remote size/queue refusal through every `DeliveryRoute` and all four modes.
  Assert full canonical bytes, state vector, heads, private cache, journal and
  local history remain unchanged. Raise capacity and retry the original bytes;
  compare with an unlimited control. Acknowledge no refused receipt.
- Repeat MW-11's no-event and mixed-message pending-struct persistence probes with
  deferred validation, failed writes, retry, flush/close and restart. Compare full
  outer encoded bytes, not only semantic inventory.
- Use at least three real independent common-genesis replicas for schema-3
  malformed/version/fork fault traces. Compare fresh replay and all document
  facets through the MW-08 factory. A test adapter or store/cache-only test must
  be labeled as such and cannot satisfy the composition gate.

At implementation time run focused ingest/action/native/provider Node tests,
`npm run build`, `npm run lint`, `npm run format:check` and
`npm run check:boundaries`. Run provider IndexedDB browser tests for ingress or
restore changes. Record actual results and remaining integration limits on the
issue. This proposal changes no executable code; those checks have not run here.

## Success criteria

1. Every materialized action passes version, fork, causal, body/manifest and
   relevant author-view validation. Invalid native bodies never reach projection.
2. Resource pressure has a retryable outcome distinct from quarantine. Raising
   limits or finishing continuations reaches the same complete result as replay.
3. No published document contains part of an action or combines heads and derived
   state from different computations. Invalidated caches cannot author edits.
4. Every remote route gates before decode; admitted unresolved bytes survive
   persistence and restart. No resource limit removes canonical facts.
5. Focused fuzz/regression tests pass with pinned Yjs. Remaining MW-08/MW-16
   acceptance work is stated explicitly, without claiming standalone tests prove
   the combined algorithm.
