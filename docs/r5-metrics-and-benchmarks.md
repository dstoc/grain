# R5 metrics and benchmark results

This report records the retirement and boundary work in R5. Source comparisons use R4 commit `67e8acb611af3da5380d6fe6dc461b77af8b7048` and R5 implementation commit `04d265fca185da68a8cd60673b94397a9585b6e0`. Matched benchmark comparisons use the exact post-M5 commit `c3a8812e8bbee69c805a50347dd29d11c076d2de` and that R5 implementation commit. Yjs remains pinned to `13.6.33`; schema 2, action and wire formats, normalization, and history semantics are unchanged.

The benchmark artifacts are committed beside the harness:

- [Core fixtures, five fresh processes per revision](../benchmarks/yjs-m0/results/r5-core.json)
- [Browser editor, five fresh processes per revision](../benchmarks/yjs-m0/results/r5-editor.json)
- [Browser harness, five fresh processes per revision](../benchmarks/yjs-m0/results/r5-harness.json)
- [Candidate retained history and three completed long traces](../benchmarks/yjs-m0/results/r5-retention-candidate.json)
- [Candidate retained history progress](../benchmarks/yjs-m0/results/r5-retention-candidate.progress.jsonl)
- [Exact post-M5 and R5 retained-history comparison](../benchmarks/yjs-m0/results/r5-retention-post-m5-worker.json)
- [Exact post-M5 and R5 per-100-action progress](../benchmarks/yjs-m0/results/r5-retention-post-m5-worker.progress.jsonl)
- [Earlier exact-baseline depth progress](../benchmarks/yjs-m0/results/r5-retention-baseline-depths.progress.jsonl)
- [R4-to-R5 core isolation run](../benchmarks/yjs-m0/results/r5-r4-core-isolation.json)

## Environment and commands

The runner was Linux x64 on an AMD Ryzen 9 5900X, Node `v26.13.0`, npm `12.2.1`, Yjs `13.6.33`, and Chromium `156.0.8078.73`. Browser tests and browser benchmarks used `/usr/bin/chromium` through a temporary Vitest Playwright launch override. The same override was applied to both sides of each comparison; `vitest.config.ts` and the benchmark runner were restored afterwards.

The exact-baseline comparisons ran:

```sh
npm run bench:yjs-m0 -- --profile core --runs 5 --against c3a8812e8bbee69c805a50347dd29d11c076d2de --output benchmarks/yjs-m0/results/r5-core.json --force
npm run bench:yjs-m0 -- --profile editor --runs 5 --against c3a8812e8bbee69c805a50347dd29d11c076d2de --output benchmarks/yjs-m0/results/r5-editor.json --force
npm run bench:yjs-m0 -- --profile harness --runs 5 --against c3a8812e8bbee69c805a50347dd29d11c076d2de --output benchmarks/yjs-m0/results/r5-harness.json --force
npm run bench:yjs-m0 -- --profile retention --runs 3 --output benchmarks/yjs-m0/results/r5-retention-candidate.json --progress-file benchmarks/yjs-m0/results/r5-retention-candidate.progress.jsonl
npm run bench:yjs-m0 -- --profile retention --runs 3 --against c3a8812e8bbee69c805a50347dd29d11c076d2de --output benchmarks/yjs-m0/results/r5-retention-post-m5-worker.json --progress-file benchmarks/yjs-m0/results/r5-retention-post-m5-worker.progress.jsonl
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

The exact post-M5 source at `c3a8812e8bbee69c805a50347dd29d11c076d2de` and the R5 workspace at `c3c58ce40421ed65717198cdfe2df750fbf81734` both passed the retained-session probe before measurement. The baseline probe selected `writer.sessions`; the R5 probe selected `writer.history.sessions`. Each observed 0, 64, and 500 groups. Unknown layouts and missing nonzero sessions fail the probe. Calibration writers are disposable and stay outside measured samples and counters.

The exact-baseline comparison completed three fresh processes on each side. Each process measured 200 operations after 25 warmups at each retained-history depth. The table reports the median process P50 and the P95 across process P50s. Times are milliseconds.

| Retained groups | Baseline prepare P50 (P95) | R5 prepare P50 (P95) | Baseline apply/publish P50 (P95) | R5 apply/publish P50 (P95) |
| --------------: | -------------------------: | -------------------: | -------------------------------: | -------------------------: |
|               0 |              3.553 (3.655) |        3.493 (3.597) |                    0.502 (0.531) |              0.524 (0.531) |
|              64 |              0.076 (0.076) |        0.088 (0.088) |                    0.319 (0.321) |              0.343 (0.348) |
|             500 |              0.081 (0.081) |        0.090 (0.090) |                    0.337 (0.339) |              0.365 (0.365) |

Both sides recorded one callback during samples and zero active callbacks after writer close at all three depths. The 64-group sample ends at 264 groups after its 200 measured operations. The 500-group sample remains capped at 500.

All three exact-baseline processes completed uninterrupted 10,000-action traces. Their measured trace durations were 3,089.737, 3,085.861, and 3,026.321 ms. All three R5 processes also completed 10,000 actions, in 3,231.191, 3,319.603, and 3,275.672 ms. Each trace retained exactly 500 groups and reported one active callback. The progress JSONL stores every 100-action chunk, per-action timings, accepted-update and receipt bytes, heap and RSS samples, probe results, and process completion events.

| Long-trace stage | Exact post-M5 baseline P50 (P95) |        R5 P50 (P95) | R5 / baseline |
| ---------------- | -------------------------------: | ------------------: | ------------: |
| Prepare          |              0.045501 (0.045690) | 0.048070 (0.049231) |         +5.7% |
| Apply/publish    |              0.235654 (0.236294) | 0.251704 (0.257293) |         +6.8% |

Here P50 is the median of three process P50 values. P95 is the 95th percentile across those process P50 values, not the per-action P95. The matched run measured higher R5 medians for both long-trace stages on this machine. These measurements do not establish the cause. The raw report preserves per-process depth and trace results, operation counts, byte totals, callback and resource checks, and memory observations.

The earlier depth-only progress artifact remains unchanged as a record of its separate partial attempt. The new comparison has completed the three-process exact post-M5 retention gate; it does not replace the original M0 baseline trace or its historical partial files.

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
