# MW-13D prepared structural commands

Issue: grain/105. Integration parent: grain/94. This is an implementation
candidate under the adopted structural execution plan v1, SHA-256
`e63457a69a187e962b053452e1072ba24a630569ae43c4b676de13aa44b3adc7`.
Independent Check/Review and parent acceptance remain required. This document
does not establish D's 15 ms target or authorize integration, E, or cutover.

## Invariants and ownership

The editing layer keeps the existing commands, selections and history groups.
`authoring/record-draft.ts` borrows indexed published records and materializes
only read/changed fields and sibling links. The command draft and compiler have
separate private revisions. Neither reconstructs a `ConstructionTree` in overlay
mode. Parser construction and the reference command path retain their existing
trees. Reading a container's complete children still enumerates that container;
placing a sibling uses selected links and first/last boundaries.

Compiler native queries use `MaterializedOwnership.prepareCommand()` and a
one-action indexed ready wrapper. Full iteration is an explicit fallback and is
charged. The wrapper is private input, never canonical readiness evidence.

`MaterializedPublication` remains the only publication owner. For a supported
structural command it requires a complete indexed native base, a fresh action
later than that base, and dependencies covering every published head. It owns
final payload bytes and a detached envelope, certifies the exact author closure,
then prepares private native, activity, B and C roots. It binds the candidate to
the base publication, facts version, generation, exact ready source and payload.
The compiler cannot supply a certification exemption.

Managed history captures its native selection against those exact roots before
append. One immutable command record carries that selection, footprint, outcome,
envelope and publication candidate through history registration and recovery.
After append, canonical readiness must prove exactly the same single addition
and payload. Only then can the publication owner install the prepared roots.
Their ready tokens are rebound to the admitted canonical root in the same commit;
no semantic or native result is rebuilt for publication.

Different-ready ingress discards the candidate and uses ordinary reconstruction.
A refresh during private native/C construction first discards the unpublished
native branch. Generation guards prevent its later installation. Failed staging,
explicit cancellation, competing preparation, eviction and destruction release
candidate handles. A retained envelope still advances the writer and registers
history once; `RetainedEditError` requires refresh/recovery, not a repeated edit.
Previously returned native/view/address reads remain valid.

## Exact author validation

The existing attempt-specific ownership proof remains required. Reference and
remote validation retain their own exact causal closure. No command is certified
against an unrelated merged publication. Candidate packets retain full validation.

Projection and ownership checks share one invocation's birth inputs, activity,
allocations and snapshots through a scoped private registry. Every membership,
home, edge-bracket, constructor and author-only split check still runs. The
registry checks action/native identity and releases its inputs in `finally`.
Genesis home descriptors are cached only inside their owning validator. Packet
validation creates its separate full validator lazily. No history of complete
author-result projections is retained.

Readiness orders local dependency certificates in the same order as canonical
admission. It starts frontier merging from the newest dependency root, so
redundant ancestors preserve that exact root. Concurrent frontiers still merge
explicitly. This preserves certificate/native identity without substituting
semantic equality, action IDs or a merged cache for exact evidence.

## History footprint

A single supported split reads the **pre-command** source traversal. Final native
marker coordinates locate new subdivisions within those old assignments. Moving
its freshly split destination does not alter pre-command ownership. Joins query
the retained home and placement directly. Other transfers or compound structural
commands retain the complete-assignment fallback. The independent full-scan
footprint test checks joined sources and both edge/interior splits.

## Work boundaries

Do not describe this pipeline as one validation. Necessary work is separate:

| Boundary                   | Expected supported warm behavior                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Command/compiler overlay   | Touched fields/links; zero full construction trees. Private compiler query revisions remain separately counted.                                 |
| Native writer              | One `prepare`; original body/reference/native checks remain.                                                                                    |
| Exact author certification | One final local certification. Existing reference checks and one author-only B proof suffix remain; preamble inventory scans are still charged. |
| Candidate application      | One native application and one activity/B/C preparation. B consumes one suffix action for an ordinary append.                                   |
| Selection and footprint    | Capture before append using the candidate and pre-command ownership; no full assignment export for the supported split/join.                    |
| Canonical append/admission | One append and exact certificate/payload/dependency checks.                                                                                     |
| Publication                | Install the same candidate; zero second B/C preparation or full projector for an exact admitted append.                                         |

`publication/*` work includes the publication owner's preparation before append.
It does not mean all work occurred after append. Exclusive phase spans and
uninstrumented wall samples are separate. Historical preamble counters describe
inventory sizes; `authorProof.preambleInputsReused` records shared input reuse,
and native snapshot counters record actual traversal/copying. Dependency sorting
charges only direct dependencies; author closure materialization/sorting remains
visible under its existing counters.

## Lifetimes and fallbacks

Each publication owns at most one pending final candidate. Its immutable result
and exact payload coexist with the previous publication until commit/cancellation.
External expired handles retain immutable results but cannot retain live document,
store, editor or publication owners. The overlay and compiler revisions are
command-local. Genesis homes live with their validator; scoped preambles live
only during one synchronous validation call. This is a lifetime inventory, not a
measurement of total/shared/peak cache heap.

Named candidate declines include a different published causal base, incomplete
native integration and competing preparation. Cold/evicted caches retain the
legacy staging/reseeding path. Text and shallow properties retain their existing
resource-local staging and history work. Full author validation remains for
unsupported proof shapes, controls, different closures and guarded refinement
misses. Start-of-paragraph Enter can include a move and still use full author
certification. These are correctness paths, not acceptance passes.

The 150-short-paragraph p50 15 ms target remains unmet in development evidence.
Full exact-author preamble/closure scans, cold/evicted staging and full history
control certification remain costs. Required final-source raw reports and the
acceptance crosswalk belong to the issue artifacts. Broader MW10/MW18 storage,
scale, uninterrupted history and total cache accounting remain E/parent work.

## Verification

Keep the original fixture, assertions and deadlines. Verify actual managed
Enter/Backspace, typing in both halves, unrelated edits/deletion, undo/redo,
selection, complete semantic/native/address observations and independent replay.
Also check body mutation, different author closures, ingress during private C
construction, retained observer failure, cancellation and expired-handle lifetime.

Run the detached lifetime controls with Node 24.22.2:

```sh
node --expose-gc --import ./benchmarks/multiwriter/resolve-ts.mjs \
  --test benchmarks/multiwriter/prepared-command-gc.test.mjs \
  benchmarks/multiwriter/author-proof-gc.test.mjs
```

Use the original alternating fresh-process measurement protocol. Restore exact
prefixes outside edit timing and report their load cost separately. Never treat
protective stops, a native-only microbenchmark, or a short prefix as full D/E
acceptance.
