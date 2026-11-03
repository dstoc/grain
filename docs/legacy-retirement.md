# Legacy retirement ledger

This ledger records the R0 compatibility boundary from the Grain Yjs refactor proposal attached to `grain/58`. It describes the repository at post-M5 commit `c3a8812e8bbee69c805a50347dd29d11c076d2de` on branch `yjs`.

R0 establishes the baseline. It does not authorize broad deletion. Keep each candidate until its production consumers and test cases have a named disposition.

## R1 extraction boundary

R1 places neutral node and draft contracts, selection types, tracked queries, and the shared normalizer under `src/markdown/semantic/`. `canonical-actions.ts` keeps the supported writer surface and re-exports its existing action and receipt types from `canonical/action-types.ts`. The ordinary `DraftNode` no longer exposes canonical spans.

`canonical/schema.ts` owns the shared schema readers. `canonical/indexes.ts` owns the accepted-state indexes. `canonical/plan/child-splices.ts` owns the pure child-list splice compiler. Semantic edits and parser helpers import neutral contracts directly; the parser still uses `MarkdownTree` until R4.

Both draft backends now provide live node views, immutable child snapshots, strict detach, UTF-16 range checks, and draft-local move-only fragments. Parser cleanup uses the explicitly tolerant `detachSemanticNodeIfAttached` helper. The canonical backend retains lazy cell and tape dependency tracking.

## Import and parser contracts

`package.json` declares the package `private` and has no `exports`, `main`, `module`, or `types` entry. Grain has no declared npm package import surface. The paths below are current direct source imports used by the demo host and repository consumers. Preserve their behavior during R0, but do not promise compatibility for arbitrary deep imports from external consumers.

| Source path                           | Current imported surface                                                                                                    | Compatibility note                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/markdown/block-parser/api.ts`    | `createBlockParser`, `parseBlocks`, `parseMarkdownTree`, `isLiteralParagraphInput`, `classifyInlineInput`, and parser types | The active host imports `createBlockParser` and `parseMarkdownTree`. Tests and preview flows use the other helpers. |
| `src/markdown/inline-parser/index.ts` | `parse`, `parser`, and inline-tree types                                                                                    | `parse(text)` returns an `InlineTree`; `parser.parse` is the same function.                                         |
| `src/markdown/canonical-model.ts`     | `CanonicalDocument`, `CanonicalNode`                                                                                        | The active host creates canonical documents and passes their nodes to the editor and renderer.                      |
| `src/markdown/canonical-actions.ts`   | `CanonicalWriter`, `TreeDraft`, action and receipt types                                                                    | The active editor and host use the writer directly. Supported draft and action types remain compatibility exports.  |
| `src/markdown/block-serializer.ts`    | `serializeToString`                                                                                                         | The host serializes parser and canonical projections through this module.                                           |
| `src/markdown/node.ts`                | `DocumentNode` and Markdown node types                                                                                      | The parser and host use these structural return types.                                                              |

The block parser contract is:

- `createBlockParser(snapshot?, options?)` returns a `BlockParser` backed by a mutable `MarkdownTree`.
- `push(text)` applies the chunk and returns that same `MarkdownTree`. Pending text is projected before a final newline arrives.
- `finish()` closes the stream and returns that same tree. `getTree()` also returns it.
- `getPendingText()` returns the unconsumed line suffix. `snapshot()` returns the resumable parser state.
- `getConversionPlan(source)` is available only when provenance is enabled and the parser is finished. The source length must match the received input length.
- `parseBlocks(markdown)` returns `{ node: DocumentNode }`. With `{ provenance: true }`, it returns `{ node, provenance }`.
- `parseMarkdownTree(markdown)` finishes a parser and returns its `MarkdownTree`, not a plain node record.
- `classifyInlineInput(markdown)` returns either `{ kind: 'literal' }` or `{ kind: 'conversion', plan }`.

The current active custom elements are registered through the `src/main.ts` import graph:

| Element                            | Registration source                      | Status                                                                                             |
| ---------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `md-dev-harness`                   | `src/main.ts`                            | Demo application root.                                                                             |
| `md-canonical-editor`              | `src/editing/canonical-editor.ts`        | Active editor.                                                                                     |
| `md-mobile-keyboard-toolbar`       | `src/editing/mobile-keyboard-toolbar.ts` | Active mobile toolbar.                                                                             |
| `md-transclusion`                  | `src/markdown/transclusion.ts`           | Active renderer extension.                                                                         |
| `md-inline`, `md-span`             | `src/markdown/inline-render.ts`          | Active inline projection.                                                                          |
| `md-block`, `md-block-render`      | `src/markdown/block-render.ts`           | Active block projection.                                                                           |
| `md-section-ui`, `md-list-item-ui` | `src/markdown/block-ui.ts`               | Active block controls.                                                                             |
| `md-editor`                        | `src/editing/editor.ts`                  | Legacy editor element. It is not imported by the application entry; browser tests still import it. |

`src/main.browser.test.ts` now asserts that the ten active application elements register when `src/main.ts` loads.

## Entry graphs

| Graph                  | Current roots and path                                                                                                                                                         | Current reachability                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web application        | `index.html` loads `src/main.ts`.                                                                                                                                              | The host imports the canonical editor, toolbar, transclusion renderer, parser API, canonical document/writer, serializer, and legacy view-model preview utilities. The canonical editor loads block, inline, and block UI elements. The block parser still constructs `MarkdownTree`. |
| Headless source use    | There is no dedicated public headless barrel. Current source roots are the block parser API, inline parser API, canonical document/writer modules, serializer, and node types. | Tests and the demo host import these paths directly. These are analysis roots, not a published package contract.                                                                                                                                                                      |
| Node tests             | `vitest.config.ts`: `src/**/*.test.ts`, excluding `src/**/*.browser.test.ts`.                                                                                                  | Includes parser, model, edit, history, collaboration, dependency-control, and review suites. Some benchmark tests are included but are gated by environment variables.                                                                                                                |
| Browser tests          | `vitest.config.ts`: `src/**/*.browser.test.ts`, Chromium provider.                                                                                                             | Includes the active canonical editor and demo harness, legacy editor tests, renderer tests, toolbar tests, and custom-element registration.                                                                                                                                           |
| Parser extensive smoke | `npm run test:extensive-smoke` enables `MARKDOWN_EXTENSIVE_SMOKE_TESTS=1` for `src/markdown/block-parser.permutations.test.ts`.                                                | Exercises the parser permutation corpus beyond its normal skipped defaults.                                                                                                                                                                                                           |
| Benchmarks             | `benchmarks/yjs-m0/run.mjs`, `benchmarks/yjs-m0/fixtures.ts`, `benchmarks/yjs-m0/counters.ts`, and benchmark tests under `src/markdown/`.                                      | `bench:yjs-m0` runs the retained M0 comparison harness. `bench:canonical-history` runs the current canonical history benchmark. Historical M0/M1 JSON remains reference evidence.                                                                                                     |

`knip.json` names the application, headless source, active custom-element, test, and benchmark roots. It does not mark every source file as an entry. Production source entries and the source project pattern use Knip's trailing `!` marker. The production project excludes `src/**/*.test.ts` with `!src/**/*.test.ts!`; test and benchmark roots remain in the full-project analysis.

## Retirement classification

| Path or group                                                                                                                                                                                                            | R0 classification                          | Evidence and disposition                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/editing/canonical-editor.ts`, `src/editing/canonical-edits.ts`, `src/markdown/canonical-actions.ts`, `src/markdown/canonical-model.ts`                                                                              | Live production                            | Imported by the active host and editor. Keep the public class names and schema 2 behavior. The two accepted-action regressions below mark behavior to fix in the browser factoring stage.                  |
| `src/markdown/block-parser/**`, `src/markdown/inline-parser/**`, `src/markdown/block-serializer.ts`                                                                                                                      | Live production and headless use           | Used by the demo host and parser/render tests. Keep chunking, previews, provenance, snapshot/resume, and structural serialization.                                                                         |
| `src/markdown/view-model.ts`, `view-model-node.ts`, `view-model-ops.ts`, `semantic-tree-draft.ts`                                                                                                                        | Live production                            | The parser API and preview still construct and mutate `MarkdownTree`; `canonical-model.ts` also imports the old tree and cache types. Replace construction before retirement.                              |
| `src/markdown/normalize.ts`, `semantic-normalize.ts`, `canonical-normalize.ts`                                                                                                                                           | Live production                            | `normalize.ts` adapts the old tree to the shared normalizer. `canonical-normalize.ts` is a forwarding alias used by canonical actions. Remove each adapter only after its consumers move.                  |
| `src/markdown/view-model-util.ts`                                                                                                                                                                                        | Mixed live and legacy                      | The active host context imports document ordering helpers. Legacy editor and editing helpers use other traversal functions. Extract active read-only helpers before deleting the old mutating remainder.   |
| `src/markdown/block-ui.ts`, `src/markdown/host-context.ts`                                                                                                                                                               | Live browser path with known ownership gap | The active renderer uses these modules. The checkbox branch writes through `canonicalWriter` without the configured session ID; route it through the session-owned editor path in the later browser stage. |
| `src/editing/editor.ts`, `src/editing/edits/**`, `src/editing/block-selection-util.ts`, `src/editing/copy-paste-util.ts`, `src/editing/keyboard.ts`, `src/indent-util.ts`                                                | Test-only legacy path                      | `src/editing/editor.browser.test.ts` imports the old editor. Its helpers are imported by that editor or its old handlers. Port behavior cases to canonical tests before removal.                           |
| `src/editing/block-util.ts`                                                                                                                                                                                              | Unused file candidate                      | Knip reports this file as unused under the configured full-project roots. Confirm repository history and test disposition before any later deletion.                                                       |
| `src/markdown/block-parser.permutations.default-skips.ts`, `src/markdown/block-parser/conversion-boundary.ts`, `src/markdown/inline-parser/commonmark-html.ts`, `src/markdown/inline-parser/commonmark.default-skips.ts` | Test or conformance support                | These files are reachable through the full-project test roots but not the selected production roots. Keep them with their tests and fixtures until those cases are migrated or retired.                    |
| Unused exports reported by Knip                                                                                                                                                                                          | Unused-symbol candidates                   | Knip reports source-file rows, not individual symbol counts, in its compact export and type headings. Review each listed export with its import graph; do not remove them as a group.                      |
| `src/markdown/canonical-actions.*.test.ts`, canonical review tests, Yjs dependency controls                                                                                                                              | Test-only correctness controls             | These are not application roots. Keep named history, rejection, publication, ownership, and dependency invariants while moving code.                                                                       |
| `benchmarks/yjs-m0/results/**`, `benchmarks/yjs-m1/**`                                                                                                                                                                   | Reference data                             | Preserve historical results and manifests. Update runnable harness imports separately; do not rewrite past measurements.                                                                                   |

## Analyzer reports

The reports are evidence for review, not deletion authorization. Both commands ran on the R0 branch at `d5ab7ac96d5af1c728598eb3dd85aca5f8decc8d`, whose source baseline is post-M5 commit `c3a8812e8bbee69c805a50347dd29d11c076d2de`. The debug output shows the production-marked source entries and project pattern, plus the test exclusion.

| Command                                                                                                                                                                      | Result                                                                                                                                 | Interpretation                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run analyze:unused -- --no-exit-code --debug` (`knip@6.41.0`)                                                                                                           | 1 unused file, 14 unused-export source-file rows, 13 unused-exported-type source-file rows, and 1 reported dev dependency.             | `src/editing/block-util.ts` is the only unused file in the full-project scan. Knip reports `@babel/plugin-proposal-decorators`, which `vite.config.ts` names dynamically in the decorator preset. Review each export row individually.                          |
| `npm run analyze:unused:production -- --no-exit-code --debug` (`knip@6.41.0`)                                                                                                | 20 unused files, 18 unused-export source-file rows, and 14 unused-exported-type source-file rows; no unused runtime dependencies.      | These files are unreachable from the configured production roots. The full-project roots retain their test and benchmark use. The production file candidates are listed below; review them individually and do not treat this report as deletion authorization. |
| `./node_modules/.bin/oxlint --import-plugin --deny import/no-cycle --format json $(find src -name '*.ts' ! -name '*.test.ts') > /tmp/grain-r0-cycles.json` (`oxlint@1.88.0`) | Exit 1: 26 cycle diagnostics and 5 other lint warnings. Cycle paths repeat rotations; they are not 26 distinct architecture decisions. | Known groups include parser cleanup/container management; parser API/ViewModel and parser-state/construction-draft loops; renderer/transclusion; and legacy editor/edit-handler cycles. The detailed paths are recorded below.                                  |

Knip's compact reporter counts source-file rows in its unused export and type headings. Those numbers are not counts of individual symbols. The corrected production roots remove the three earlier false-positive runtime dependency findings.

The 20 production-unused file candidates are:

```text
src/editing/block-selection-util.ts
src/editing/block-util.ts
src/editing/copy-paste-util.ts
src/editing/editor.ts
src/editing/edits/delete-content-backwards.ts
src/editing/edits/edit-inline-node.ts
src/editing/edits/indent-block-selection.ts
src/editing/edits/indent-inline.ts
src/editing/edits/insert-paragraph.ts
src/editing/edits/remove-selected-nodes.ts
src/editing/edits/replace-selected-blocks.ts
src/editing/keyboard.ts
src/editing/test/lifecycle.ts
src/editing/test/markdown_node_snapshot.ts
src/editing/test/test_state.ts
src/indent-util.ts
src/markdown/block-parser.permutations.default-skips.ts
src/markdown/block-parser/conversion-boundary.ts
src/markdown/inline-parser/commonmark-html.ts
src/markdown/inline-parser/commonmark.default-skips.ts
```

The full-project report marks only `src/editing/block-util.ts` unused. The other production-unused paths remain reachable from the configured test or benchmark roots and require their existing test/reference dispositions.

## Existing direct cycles

The source-only Oxlint scan finds these dependency groups:

| Cycle group                                                                                               | Classification                                                                                    |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `block-parser/cleanup.ts` ↔ `block-parser/container-management.ts`                                        | Direct parser helper cycle.                                                                       |
| `block-parser/api.ts` ↔ `view-model.ts`                                                                   | Direct parser-factory and old-model cycle.                                                        |
| `view-model.ts` → `normalize.ts` → `semantic-tree-draft.ts` → `view-model.ts`                             | Old model and normalization adapter cycle.                                                        |
| `block-parser/state.ts` → `semantic-tree-draft.ts` → `view-model.ts` → `block-parser/api.ts` → `state.ts` | Parser construction cycle through the legacy model.                                               |
| `block-render.ts` ↔ `transclusion.ts`                                                                     | Direct active renderer cycle.                                                                     |
| `editing/editor.ts` ↔ `editing/edits/*.ts`                                                                | Legacy editor and handler cycles, including delete, indent, split, and selected-block operations. |

Type-only import boundaries still need separate review. Moving a type import does not remove a runtime cycle or establish the semantic/canonical/browser layer rules in proposal §10.

## Baseline commands and results

Environment: Node `v26.13.0`, npm `12.2.1`, Yjs `13.6.33`, Vitest `5.0.5`, TypeScript `7.0.2`, Chromium `156.0.8078.73`.

| Command                                                                                             | Result on the baseline                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                                                                     | Pass.                                                                                                                                                                                                                                       |
| `npm run build:web`                                                                                 | Pass; Vite transformed 130 modules and emitted the app bundle.                                                                                                                                                                              |
| `npm run lint`                                                                                      | Exit 0 with one existing `unicorn(no-useless-spread)` warning at `src/editing/edits/delete-content-backwards.ts:52`.                                                                                                                        |
| `npm run test`                                                                                      | 39 files passed, 2 skipped; 595 tests passed, 192 skipped.                                                                                                                                                                                  |
| `npm run test:browser`                                                                              | Playwright's downloaded Chromium was absent. With a temporary Vitest provider override to `/usr/bin/chromium`, the pre-R0 suite had 11 files passed, 2 skipped; 278 tests passed, 2 skipped. `vitest.config.ts` was restored after the run. |
| `npm run test:extensive-smoke`                                                                      | Pass; 8,660 parser permutation cases.                                                                                                                                                                                                       |
| `npm run test -- src/markdown/yjs-dependency-controls.test.ts src/markdown/yjs-m0-counters.test.ts` | Pass; 2 files and 7 tests.                                                                                                                                                                                                                  |

R0 does not rerun the long benchmark matrix. Keep the proposal's previously recorded lifecycle budget result and the separate host-maintenance and physical mobile QA gates open. The browser suite uses desktop Chromium; it does not establish physical mobile or IME behavior.

## R0 behavior gates

`src/editing/canonical-editor.browser.test.ts` now contains two Vitest expected-failure regressions. Their existing bodies and assertions remain intact. `test.fails` makes an unexpected pass fail the suite.

1. **Nondefault-session checkbox:** with `sessionId = 'review-custom-session'`, clicking a task checkbox stores undo under `local`. Expected: the configured session owns the action.
2. **Child-list-only structure:** a child-list-only accepted action has `childLists` but no cell changes or births. The editor does not seal its current typing group. Expected: one undo after the structural effect removes only the later text input.

These tests record existing failures for the later integration correction. R0 does not alter editor or renderer integration to make them pass. In R3, remove `test.fails` and keep each test as an ordinary passing regression after the integration correction.

With the expected-failure markers on PR #51 head `d5ab7ac96d5af1c728598eb3dd85aca5f8decc8d`, the local full browser run reported 11 files passed, 2 skipped; 279 tests passed, 2 expected failures, and 2 skipped. The active-element registration test passed. GitHub status checks on that exact head passed. An earlier CI run at `fadd6d20608d0ea62efef9c91dfffa2ea27beacb`, before the expected-failure markers, reported the two named behavior gates as failures and a separate failure in `src/editing/editor.browser.test.ts` for `copies and cuts blocks through trusted keyboard events` (`body\n` received instead of `hello\n\nworld\n`). The local runs did not reproduce that separate clipboard failure; it remains a historical CI observation, and this R0 correction does not change or mask the legacy test. The `chrome-devtools` daemon did not remain available across runner command invocations, so browser results use Vitest's Playwright provider with Chromium 156.0.8078.73. No physical mobile or IME behavior is claimed.
