# R5 metrics and benchmark results

This report records the retirement and boundary work in R5. Source comparisons use R4 commit `67e8acb611af3da5380d6fe6dc461b77af8b7048` and R5 implementation commit `04d265fca185da68a8cd60673b94397a9585b6e0`. Matched benchmark comparisons use the exact post-M5 commit `c3a8812e8bbee69c805a50347dd29d11c076d2de` and that R5 implementation commit. Yjs remains pinned to `13.6.33`; schema 2, action and wire formats, normalization, and history semantics are unchanged.

The benchmark artifacts are committed beside the harness:

- [Core fixtures, five fresh processes per revision](../benchmarks/yjs-m0/results/r5-core.json)
- [Browser editor, five fresh processes per revision](../benchmarks/yjs-m0/results/r5-editor.json)
- [Browser harness, five fresh processes per revision](../benchmarks/yjs-m0/results/r5-harness.json)
- [Candidate retained history and three completed long traces](../benchmarks/yjs-m0/results/r5-retention-candidate.json)
- [Candidate retained history progress](../benchmarks/yjs-m0/results/r5-retention-candidate.progress.jsonl)
- [Exact-baseline retention-depth progress](../benchmarks/yjs-m0/results/r5-retention-baseline-depths.progress.jsonl)
- [R4-to-R5 core isolation run](../benchmarks/yjs-m0/results/r5-r4-core-isolation.json)

## Environment and commands

The runner was Linux x64 on an AMD Ryzen 9 5900X, Node `v26.13.0`, npm `12.2.1`, Yjs `13.6.33`, and Chromium `156.0.8078.73`. Browser tests and browser benchmarks used `/usr/bin/chromium` through a temporary Vitest Playwright launch override. The same override was applied to both sides of each comparison; `vitest.config.ts` and the benchmark runner were restored afterwards.

The exact-baseline comparisons ran:

```sh
npm run bench:yjs-m0 -- --profile core --runs 5 --against c3a8812e8bbee69c805a50347dd29d11c076d2de --output benchmarks/yjs-m0/results/r5-core.json --force
npm run bench:yjs-m0 -- --profile editor --runs 5 --against c3a8812e8bbee69c805a50347dd29d11c076d2de --output benchmarks/yjs-m0/results/r5-editor.json --force
npm run bench:yjs-m0 -- --profile harness --runs 5 --against c3a8812e8bbee69c805a50347dd29d11c076d2de --output benchmarks/yjs-m0/results/r5-harness.json --force
npm run bench:yjs-m0 -- --profile retention --runs 3 --output benchmarks/yjs-m0/results/r5-retention-candidate.json --progress-file benchmarks/yjs-m0/results/r5-retention-candidate.progress.jsonl
```

Core and browser comparisons use 200 measured actions per fixture after 25 warmups, with each run in a fresh process. Table P50 values are the median of the five process P50s. Parenthesized P95 values are the 95th percentile across those process P50s, as recorded by the harness. They are not per-action P95 values. The profile artifacts contain per-process P50/P95 distributions, counters, resource snapshots, and fixture identities.

## Structural metrics and analyzer results

The source boundary checker and Knip were run at R4 and R5. R4 Knip counts use the R5 reviewed roots/configuration overlaid onto R4, so both revisions are analyzed with the same entry policy. Knip's compact export and type counts are source-file rows, not symbol totals.

| Measure                                                    | R4 `67e8acb` | R5 `04d265f` |
| ---------------------------------------------------------- | -----------: | -----------: |
| Production TypeScript modules                              |          114 |          111 |
| Static import, re-export, and literal dynamic-import edges |          597 |          586 |
| Type-only edges, included in edge count                    |          278 |          275 |
| External edges                                             |           51 |           51 |
| Runtime cycles                                             |            2 |            0 |
| Full-project Knip unused files                             |            3 |            0 |
| Full-project Knip unused-export rows                       |           16 |            0 |
| Full-project Knip unused-type rows                         |           13 |            0 |
| Production Knip unused files                               |            3 |            0 |
| Production Knip unused-export rows                         |           15 |            0 |
| Production Knip unused-type rows                           |           13 |            0 |

The R5 boundary checker also reports the final layer sizes: shared 14, editing 25, host 1, parsing 23, rendering 8, canonical 34, and semantic 6 modules. Its type-only policy self-check passes. The 111-module graph has 586 edges (275 type-only, 51 external) and zero runtime cycles. Oxlint enforces `import/no-cycle` in CI, and the boundary checker runs in CI alongside both Knip modes. Knip is pinned to development-only version `6.41.0`; its one dynamic Babel dependency is explicitly ignored because `vite.config.ts` loads it by name.

R5 deletes three proven-dead files and localizes reviewed private helpers and types. The documented direct-source facades remain covered by `src/markdown/canonical-facades.test.ts`. The ten active custom elements remain covered by the main-entry browser smoke test. See the [module map](module-map.md), [edit-authoring guide](edit-authoring.md), and [retirement ledger](legacy-retirement.md) for ownership, authoring contracts, and the full disposition record.

## Matched core and editor workload results

The core table reports `prepareThroughPublish` for all seven required fixtures. Each side has five fresh-process runs, with 200 measured operations per fixture. The exact post-M5 baseline is compared directly with R5.

| Fixture                   | Baseline P50 (P95), ms | R5 P50 (P95), ms |
| ------------------------- | ---------------------: | ---------------: |
| `paragraphs-10`           |          0.376 (0.392) |    0.409 (0.429) |
| `paragraphs-150`          |          0.424 (0.430) |    0.454 (0.475) |
| `paragraphs-1000`         |          0.623 (0.641) |    0.686 (0.699) |
| `paragraphs-5000`         |          0.823 (0.837) |    0.887 (0.899) |
| `long-tape-16384`         |          0.477 (0.487) |    0.511 (0.533) |
| `wide-list-1000`          |          0.755 (0.771) |    0.811 (0.812) |
| `fragmented-ownership-32` |          1.160 (1.176) |    1.223 (1.240) |

The matched core medians are about 6–10% higher on R5 than on the post-M5 baseline, while the `paragraphs-150` median remains below the proposal's 2 ms absolute target. The separate three-process R4-to-R5 isolation run is recorded in the artifact above. Across the seven `prepareThroughPublish` medians, R5 is between 2.3% faster and 2.1% slower than R4. The larger difference from post-M5 is already present by R4; these measurements do not identify which earlier stage introduced it. Do not use source size or line count to infer runtime performance.

The `wide-list-1000` sample retained the same native counter shape on both revisions: 2,002 array inserts, no array deletes, three map sets, one text insert and delete, nine update events, seven delete-set clients, and 2,011 delete-set ranges. Median accepted update bytes and receipt bytes per measured operation were 92.325 and 364.91 on both sides. The raw report preserves each process's exact counters and byte totals.

The editor workload uses a 150-paragraph document at 1280×720, with 200 measured edits per process. The harness workload measures the demo Source editing path on the same document and viewport. Both use Chromium 156 in five fresh processes per revision.

| Browser workload | Baseline P50 (P95), ms | R5 P50 (P95), ms | Other observed checks                                                                                          |
| ---------------- | ---------------------: | ---------------: | -------------------------------------------------------------------------------------------------------------- |
| Canonical editor |            16.6 (16.7) |      16.7 (16.7) | 200 affected-block mutations; zero unaffected-block mutations; affected and distant node identities preserved. |
| Demo harness     |            33.3 (33.3) |      33.3 (33.4) | Zero parser rebuilds; serialized output length 7,914.                                                          |

## Retained-history and long-session results

The R5 probe calibrated the private retained-session registry before collecting measurements. It selected `writer.history.sessions` on R5 and observed counts 0, 64, and 500. The exact post-M5 baseline calibration selected `writer.sessions` and observed those same counts. Unknown layouts and missing nonzero sessions fail the probe. Calibration writers are disposable and are outside measured operations and counters.

The candidate retention-depth profile was run in three fresh processes. For each depth, it recorded 200 measured operations and 25 warmups. The table reports the median process P50 and the P95 across process P50s.

| Retained groups | Prepare P50 (P95), ms | Apply/publish P50 (P95), ms | Callback count during samples | Active callbacks after close |
| --------------: | --------------------: | --------------------------: | ----------------------------: | ---------------------------: |
|               0 |         3.774 (3.877) |               0.589 (0.615) |                             1 |                            0 |
|              64 |         0.088 (0.092) |               0.349 (0.351) |                             1 |                            0 |
|             500 |         0.093 (0.094) |               0.376 (0.384) |                             1 |                            0 |

All three candidate processes completed an uninterrupted 10,000-action writer trace with a 500-group cap and observed exactly 500 retained groups. Across those processes, median process P50 was 0.050 ms for prepare and 0.264 ms for apply/publish; the corresponding P95 across process P50s was 0.050 ms and 0.264 ms. The raw report includes per-run operation counts, update and receipt bytes, callback/resource snapshots, and memory measurements.

The exact post-M5 baseline completed one 0/64/500 depth run with the same calibrated counts, then the comparison runner was stopped after depth 500 before starting its long trace. That completed partial run is preserved in the progress artifact; no full baseline long-session result is claimed. The approved gate requires three uninterrupted baseline traces against exact post-M5. This runner has a 120-minute limit; the earlier project journal records a much longer estimate from a separate, explicitly non-matching partial baseline. Run the exact baseline trace on a pinned long-job worker and retain its progress output. Do not replace historical artifacts or count the partial run as completion.

Lifecycle, physical mobile/IME, and maintenance release gates remain visible and unverified by these desktop benchmark and automated test runs.

## Verification

The R5 implementation passed:

- `npm run build`
- `npm run build:web`
- `npm run lint` with cycle diagnostics denied
- `npm run format:check`
- `npm run check:boundaries`
- `npm run analyze:unused` (full-project Knip)
- `npm run analyze:unused:production`
- `npm run test`: 42 files passed, 1 existing skipped; 590 tests passed, 192 existing skipped
- `npm run test:browser`: 13 files passed, 2 existing skipped; 200 tests passed, 2 existing skipped
- `npm run test:extensive-smoke`: 8,660 parser cases passed

The boundary run reported 111 production modules, 586 edges (275 type-only), and zero runtime cycles. No skip shortcut was added. Browser tests used the installed system Chromium because Playwright's bundled browser was absent; the temporary provider configuration was restored and is not part of the branch.
