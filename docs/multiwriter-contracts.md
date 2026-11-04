# Multi-writer contracts and expected traces

MW-00 implements the contract freeze for **grain/81**. Its source is the complete
proposal attached to that issue, version 1, reviewed against `yjs` commit
`1d76dddbd8620c5dc92b02ccb1c45e67af7ddc46`. Yjs remains exactly **13.6.33**.

The new files specify schema 3. They do not change schema-2 authoring, implement a
reducer, or demonstrate native multi-writer convergence. **MW-08 remains the
required integrated reference gate before browser cutover.**

## Files and use

- `src/markdown/multiwriter/contracts.ts` defines the shared logical types and
  policies. It has no authority, browser, parser, or Yjs runtime dependency. It is
  a Knip entry because downstream workstreams consume this contract directly.
- `test/multiwriter/trace.ts` defines versioned semantic traces, observations and
  `runContractTrace()`. It contains comparisons, not a reference reducer.
- `test/multiwriter/corpus.ts` contains fixed inputs and expected observations.
  Expectations are independent of the future engine.
- `test/multiwriter/compatibility.ts` inventories every baseline test file. The
  inventory test detects a removed suite or an unclassified new suite outside
  this workstream. Update the inventory with an explicit disposition when moving
  coverage. A file's presence alone does not establish behavioral compatibility.
- `src/markdown/multiwriter/*.test.ts` checks the contract types, policies, fixture
  consistency, baseline inventory and comparison runner. It does not run the
  corpus against a multi-writer engine.

Run these checks with:

```sh
npm run build
npm run test -- src/markdown/multiwriter/
```

MW-07 supplies an independent-replica adapter. MW-08 connects it to real action
storage, Yjs insertion bodies and the reference reducers. For each trace, call
`runContractTrace(adapter, trace, (actual, expected, context) =>
expect(actual, context).toEqual(expected))`. The comparison callback must throw on
a mismatch. The runner always disposes the adapter, including after failure.

Do not implement an adapter by returning the expected observations or replaying
expected Markdown. Author the intents in each peer's own causal view, exchange
real envelopes, and observe the actual engine. Compare fresh full replay as well
as the incremental state. Trace adapters must not share a writer, action store,
text cache, reducer, or history stack between A, B and C.

## Frozen identity and envelope contract

Actor IDs identify writer instances, not accounts or native Yjs clients. The
logical API uses 32 lowercase hex digits for 128 random bits; the codec encodes
them as 16 bytes. Each process/tab receives a fresh actor and native client.
Sessions identify separate local navigation stacks within an actor. Groups name
one session's actions. Resources are identified by birth action (or shared
genesis) and allocation ordinal. Ordinals are unique across resource domains;
the domain checks reference type and does not create another identity. IDs do not encode current
ownership, visible position, accepted revision, wall time or authority epoch.

`ActionEnvelope` has protocol version 3, document/genesis IDs, action ID, Lamport
counter, dependencies, group ID, allocations, exact native insertion update
bytes, native birth manifest and semantic effects. The MW-01 codec must use RFC
8949 core deterministic CBOR with definite lengths, no duplicate map keys, no
floating point and no optional tags. Sequence and Lamport counters are exact
unsigned 64-bit integers. Native clocks, lengths, allocation ordinals and effect
ordinals must be nonnegative safe integers at validation boundaries. Actor
comparison is bytewise. Effect order is `(lamport, actor, sequence, ordinal)`.
Array arrival order is never semantic order.

An action depends on its contiguous actor predecessor and all observed semantic
heads. Lamport time is one plus the largest dependency time. Identical envelopes
are idempotent; different payloads for one ID remain observable and quarantine
that identity and its dependents. Full validated dependency closure is required
before native bodies enter the private cache. Independent ready branches keep
progressing. Author-local validity uses the author's dependency closure, not a
later merged projection or a later undo.

Only append-only `actionDoc` envelopes are canonical and synchronized. Insertion
bodies build a private `textDoc` cache. The new path cannot use native text delete,
formatting or `Y.UndoManager`. Failed unpublished preparation or a newly detected
fork requires rebuilding contaminated native cache state with a fresh native
client before authoring resumes. Allocation facts outlive retraction.

## Frozen structure, visibility and editing addresses

Block and flow placement use the same cycle-safe kernel in typed domains.
Permanent occurrences preserve old locations as anchors. Concurrent followers
use descending effect order. Raw roles are immutable; presentation is mutable.
Deletion does not remove raw edges or make a previously cyclic move safe.

A cell has one effective occurrence/run; a run has one flow parent; flow ancestry
is acyclic. Empty insertion cells remain addressable. Structural ranges use open
permanent marker endpoints and include later native insertions within them.
Text deletion instead tags exact observed native ID ranges. Joining nests a flow
and suppresses its source header; it does not delete text or the source node.
Transfers change cell ownership, retaining ghost destination slots. Splits use
the captured-basis contiguous-component rule, including empty cells. Same-basis,
same-gap split cohorts use native cut order, with one bucket ranked against
ordinary sibling occurrences. Beginning splits retain the original right node.
Explicit later moves leave a split cohort.

Subtree deletion captures observed nodes, owned ordered text intervals, joined
flows and causal heads. Its text mask follows covered identities through later
moves, splits and transfers. A causal prior transfer can escape that coverage;
a concurrent transfer cannot. Concurrent children inherit a covered parent's
deletion even if moved out. A child born after observing undo does not inherit an
irrevocable tag. A split sibling is not tombstoned merely for sharing a historical
source. Text placed under a deleted destination is hidden. There is no recovery
tree or automatic resurrection.

Each session retracts only its own grouped actions through replicated
`SetGroupActive` controls. The owner chain determines activity. Controls are not
recursively undoable. Retraction retains allocations and native identity; it
never clears another session's deletion tag. Reactivating an old move preserves
its old priority. Independent surviving work can keep an undone birth as a
scaffold; explicit deletion still wins. Remote actions and controls neither enter
local navigation nor clear local redo. Unscoped undo consumes the newest own
group even when ineffective. Scoped history can skip wholly outside groups but
must block a mixed-scope group; exact retained footprints and current owners,
not whole-tape membership, determine scope. The default limit is 500 local groups.

Interpretation properties, wrapper intentions and exact syntax masks form one
applicability packet. Masks follow lineage across joins; they do not expand to
concurrent or destination characters. Incompatible winning interpretations
deactivate losing masks. Editable synthesized characters have author-allocated
native identities. Normalization is a pure view transform: merged wrapper groups
have an existing representative and constituent origins; child edges and text
slots map to persistent placements. Deleting a group expands its observed
constituents. Projection never allocates shared resources. Empty import genesis
has one ordinary shared paragraph; a later empty-root caret maps to a root slot,
and its first edit explicitly creates a paragraph.

## Trace conventions

Trace version 3 is a test input format, not another replication protocol.
Symbolic aliases bind to real genesis/action allocations, occurrences, native
characters, intervals and slots. `P0` denotes the first native character of seed
paragraph P; `fP`, `rP` and `tP` denote its flow, home run and tape. A nonempty
`nativeText` entry describes a contiguous native character range. Empty entries
name zero-character insertion cells. Seed native ID ranges identify the named characters and expose the named slots.
The `cellRuns` facet flattens effective ownership to those native ranges and any
explicitly named empty cells; it is not a substitute for the full elementary-cell
index required at MW-08. `P:after-b` and `P:after-c` are stable gaps in
the seed lineage, not offsets reinterpreted on receipt. `P:birth` is its genesis
placement occurrence. Start/end slots refer to the permanent home run.

Seed entries list parents before children. Entries with the same parent define
sibling order. Genesis birth occurrences form a predecessor chain per parent:
the first sibling has no predecessor; each later sibling follows the previous
sibling's birth occurrence. Thus the seed `[root, P, U]` places P before U.
When P moves inside U, `P:birth` remains a non-rendering root anchor. A concurrent
split S authored after `P:birth` stays before U; the view preorder is `S, U, P`.
The two `split-sibling-keeps-authored-outer-context` traces swap the move and split
actors to check both semantic tie orders. The focused occurrence-order regression
also checks an equivalent sibling representation of genesis and both delivery
orders. This restricted check does not validate the full layout or split reducer.

Each peer starts from exactly the same genesis. Actors and native clients are
ordered A < B < C. Fixed native client IDs must also be distinct from the genesis
client. Thus concurrent same-gap native insertions in these fixtures follow Yjs's
specified native ordering (A then B); their order is not inferred from actor
Lamport order. Where cuts share a gap, allocate A's cut before B's in converged
native order. Adapters must bind aliases once and preserve those bindings across
replay, checkpoint reload, retraction and peers.

Every specified observation facet is an exact comparison. Unspecified facets
remain subject to the full engine invariants; they are not invented expected
values. Action-ID arrays use ascending semantic order. `visible` lists native
character aliases in rendered order and excludes empty cells. `hidden` includes
characters hidden by tags, inactive insertion effects, interpretations or deleted
destinations. `skeletons` retain obsolete run occurrences; `cellRuns` names the
effective owner. `view` is preorder after legal projection and normalization.
`flowParents` distinguishes `block:P` from `flow:fP@P:end`. `variants` counts
distinct immutable payloads for each action identity, not network duplicates.
History arrays run from oldest to newest. `emittedActions` counts actions authored
by the observed peer; receiving, projection and maintenance do not author them.

The runner checks actual resource identities, native ID/length bindings and duplicate native ranges
in addition to requested facets. It inspects genesis and the affected peer after
each step, so a later adapter cannot hide identity substitution by relabeling the
final Markdown. Native clocks and lengths are UTF-16 units; grapheme movement is
a separate editing/browser obligation.

An `author` control intent means invoke that peer's real history navigation and
verify it selected the named group and emitted the specified control. Do not
force-retract a group to bypass local selection rules. Receiving a control before
its target must leave it pending. A `deliver` step is a delivery attempt, gated by
both endpoint modes before the destination action store, including catch-up,
self-echo and cross-tab routes. Strict one-way fixtures contain no reverse control
traffic. Relays export known prerequisites, including other actors' actions.

Fault delivery appends a changed complete envelope to the destination:
`fork-payload` changes A1's inserted `x` to `!` while preserving its ID;
`unsupported-version` sets protocol version 4; `native-delete` adds a native
delete operation outside the insertion manifest; `unknown-resource` changes the
insertion's tape reference to an unallocated ID. Implement these faults against
real encoded envelopes/native bodies. Do not add rejection shortcuts keyed by the
fixture name. Restarts reload held canonical facts and reset local interactive
history. `evict-history` explicitly clears local navigation metadata;
`drop-caches` and `checkpoint-reload` retain all canonical facts and genesis.

## Direction and retention policy

| Mode          | Send | Receive | Local editing/history                                |
| ------------- | ---- | ------- | ---------------------------------------------------- |
| bidirectional | yes  | yes     | available                                            |
| outbound-only | yes  | no      | available indefinitely                               |
| inbound-only  | no   | yes     | host decides edit permission; edits can remain local |
| disconnected  | no   | no      | available with local persistence                     |

Receive-disabled updates are blocked before `actionDoc`, including every provider
route. Optional acknowledgment/state-vector control traffic does not advance
semantic heads. Strict one-way publication requires no reverse traffic. Changing
modes preserves identity, unsent work and live local history. Re-enabling sending
publishes the necessary accumulated closure; re-enabling receiving merges into
the existing store. Restart explicitly resets navigation, not canonical actions
or published controls. Applied, persisted and optional delivered status are
separate; delivery is not document equality or a safe pruning frontier.

No offline or outbound-only replica expires. History eviction, inactivity,
acknowledgments and invisibility do not permit canonical pruning. Cache eviction
and crash-safe lossless journal consolidation are allowed. A checkpoint retains
the full canonical action collection, native action-store identity, protocol,
genesis and exact closure/frontier. It does not start a new genesis. `gc:false`
remains the native-cache policy. Storage may grow indefinitely. A future
compactor must separately establish equivalence for permitted old-prefix future
actions, ownership/identity, causal validity and eligible history; current
Markdown equality or passing lossless-reload tests is insufficient.

## Compatibility inventory and remaining gates

The machine-readable inventory covers these baseline areas:

| Category   | Existing contracts to preserve                                                                                                                             | Main suites                                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commands   | split identity, Enter/Backspace precedence, list/task state, scope, paste, deletion, undo                                                                  | `commands.test.ts`, `commands.review.test.ts`, `commands.scope.test.ts`, `insert-markdown.replacement.test.ts`, `delete-blocks.review68.test.ts`, `prepare-edit.test.ts`, `semantic-draft-parity.test.ts` |
| parser     | full and streamed construction, chunk schedules, incomplete preview, snapshot/resume, provenance, Unicode, ordered lists, inline conformance               | `block-parser*.test.ts`, `ordered-list.test.ts`, `parser-unicode.review.test.ts`, `inline-parser*.test.ts`, `inline-parser/*.test.ts`                                                                     |
| semantic   | draft behavior and shared normalization invariants                                                                                                         | `semantic/draft-conformance.test.ts`, `semantic-normalize.test.ts`, `review-normalization-regression.test.ts`                                                                                             |
| browser    | trusted input, caret/selection direction, history restoration, clipboard, composition cancellation/replay, nested hosts, renderer identity, mobile toolbar | `canonical-editor*.browser.test.ts`, `composition-controller.browser.test.ts`, `mobile-keyboard-toolbar.browser.test.ts`, renderer suites, `main*.browser.test.ts`                                        |
| schema2    | present writer, protocol, ownership, history, promotion, focus and collaboration coverage; retire authority mechanics only after crosswalk                 | `canonical-*.test.ts`, `two-client-experiment.test.ts`                                                                                                                                                    |
| dependency | native Yjs negative controls and instrumentation                                                                                                           | `yjs-dependency-controls.test.ts`, `yjs-m0-counters.test.ts`                                                                                                                                              |
| benchmark  | matched workloads and historical evidence, not correctness passes                                                                                          | `canonical-actions.benchmark.test.ts`, `canonical-m0.benchmark.test.ts`                                                                                                                                   |

`docs/legacy-test-crosswalk.md` remains the existing per-behavior R-series ledger.
MW-00 deletes or migrates no baseline suite. Schema-2 independent-writer negative
controls must retain their meaning until replaced by named schema-3 coverage.
Current browser two-client tests share authority behavior and do not establish
the independent-replica contract.

The corpus freezes representative structural, visibility, interpretation,
history, readiness, directional and retention outcomes. Full parser conversion
permutations, arbitrary cross-tape seams and affinities, scoped mixed-history
navigation, Unicode/grapheme interaction, model-generated traces and every
malformed native/codec case must expand these fixtures with their owning
workstreams. MW-18 additionally tests interruption at each checkpoint replacement
boundary. MW-08 must compare actual raw graphs, native IDs, cells, slots and
projection against fresh reconstruction on three independent replicas. MW-16
adds the complete command/parser/browser matrix, physical mobile/IME checks and
performance gates. No static fixture audit or restricted review model proves
that combined algorithm.
