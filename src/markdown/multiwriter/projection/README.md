# Headless Markdown projection

MW-06 projects one ready schema-3 snapshot into legal Markdown and persistent edit
addresses. A converted heading's exact prefix mask follows its native characters
through joins and transfers. Competing conversions select one whole packet before
layout replay. Reading, normalization and export publish no actions.

Import the public API from `./index.js`. Supply the complete unique ready set,
node-to-birth-occurrence bindings, and a read-only native cache of exactly that set:

```ts
const result = projectMarkdown({
  genesis,
  genesisManifest: nativeGenesis.nativeManifest,
  actions: ready.map((action) => ({ action, births: births(action) })),
  native,
  initialProperties,
  birthContent,
});
const markdown = serializeProjection(result.view);
```

The genesis insertion manifest distinguishes common bootstrap text from unready
native origins. Unknown text/markers and mismatched manifest text fail before
publication.

`initialProperties` contains imported genesis presentation, markers, code info and
task state. Action properties come from interpretation packets and independent
`SetProperties` effects. Supply `birthContent` for every retained node, including
empty arrays for nodes without birth content. These are MW-05's exact birth-causal
intervals; reconstructing them from final ownership is incorrect after transfers.
MW-08 owns snapshot assembly and this provenance. Projection rejects incomplete
coverage. It does not certify untrusted envelopes on merged state.

`result.view` is detached and frozen. It includes normalized nodes, original raw
child-edge slots, wrapper representatives and observed constituents, exact native
text fragments (including hidden syntax), and permanent text boundaries. Absorbed
headers contribute text through the destination flow once. Their surviving children
lift at the header's raw position. Paragraph/code children also lift. Deleted
children remain hidden.

Normalization uses the existing semantic normalizer against detached records. It
preserves its section rules, adjacent-wrapper merging, list numbering, task state
and one-pass empty-container cleanup. It disables shared empty-root paragraph
creation. `serializeProjection()` handles the resulting empty document explicitly.
No fixed-point cleanup or new conflict outcome is introduced.

## Lower an edit address

- `selectionRanges(node, from, to)` maps a visible UTF-16 selection to exact native
  identities across masks, cells and tapes. It rejects half-surrogate boundaries.
- `textPoint(node, offset, affinity)` returns a persistent text origin and either a
  native character neighbor or a permanent marker slot. `nativePointIndex()` lowers
  a character neighbor to the current tape index. For a marker slot, use MW-04's
  `HomeIndex.planTextInsertion()` to retain private homes and allocate edge brackets.
- `wrapperBoundary(node, index, side)` returns the specific constituent container
  and its original gap on the requested side. View grouping does not change it.
- `deletionTargets(node)` captures the observed constituent IDs. Keep that set when
  authoring a group deletion; do not recompute it after receiving another action.
- `resolveAddress(address, ownership, visibility)` returns the captured address or
  `unavailable`. It never redirects a ghost address to its former text's new owner.

After deletion leaves no editable block, `view.emptyRoot` contains a local root
slot. `requestEmptyRootEdit(view, text)` returns a request, without allocating or
publishing. MW-09 must create a real paragraph, flow, run, occurrence, fresh home and
bracketed native text in one action. Independent requests may create two ordered
paragraphs. Initially empty imports must already contain one ordinary shared empty
paragraph/flow in genesis.

## Prepare a parser conversion

Pass `prepareParserConversion()` the exact parser input string, ordered native
fragments, its `ParserConversionPlan`, and explicit stable output bindings. It
checks path coverage, output reconstruction, UTF-16 boundaries and unique retained
ownership. Consumed offsets become exact native masks. Synthesized pieces become
requests, with no editable character invented by projection.

Allocate the requests in the author action. `bindParserConversion()` takes their
native ranges, the prepared output bindings, the new interpretation ID, the full
author envelope, a native range reader and retained allocations. It checks fresh
occurrences, node/flow/run bindings, insertion effects and manifest births. It
returns a packet plus identity-bound output pieces. Synthesis identities must be
distinct from all retained and consumed parser-source identities, including text
born in the same action. MW-09 still lowers the required
splits, transfers and per-output properties before publication. Empty output needs
no synthesis. Invalid optional conversions throw `ProjectionError`; keep literal
input or decline the edit rather than publishing a partial packet.

## Certify author facts

Install `createProjectionAuthorValidator({ genesis, births })` as MW-15's
`createIngestValidator({ genesis: nativeGenesis, validateAuthor })` callback. It
composes MW-04 ownership/home certification with packet checks. MW-15 supplies an
isolated native cache containing exactly genesis, dependencies and the candidate.
The callback checks source masks against the pre-effect author traversal and checks
synthesis against the candidate's insertion manifest. It validates losing packet
placements too. Never call author certification against a cache containing unrelated
concurrent origins.

Packets can also declare `derivedInlineOutputs` and original `effectOrdinals`.
These optional lists are absent on older canonical bytes; the encoder omits empty
logical lists and the decoder rejects present-empty wire lists. Output births,
member properties and structural effects share packet selection. Independent
properties and transfers retain their own activity. Allocations, native insertions,
markers and split constructor coverage remain retained when a packet loses.
Certification checks each packet's own intentions, including superseded packets,
against exact author prefixes. See `docs/edit-authoring.md` for command lowering.

Lower layers accept explicit interpretation eligibility and wrapper-birth activity.
Their defaults preserve existing callers: without eligibility, layout registers
interpretation occurrences but does not apply their placements. MW-06 supplies the
winner lookup at original action/effect ordinals. Effective placements participate
in ordinary cycle checks and scaffold destination requirements.

The focused tests execute five frozen MW-00 projection facets with real native
caches. They also cover parser schedules, origins, lifting, normalization parity and
exact-author ingest. This module does not provide the MW-08 independent-replica
factory, MW-09 commands, MW-10 history or MW-16 browser acceptance.
