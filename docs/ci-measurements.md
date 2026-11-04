# yjs CI measurement report

Measured engine/test-helper revisions: accepted MW-08 merge `0b500005bb26ebdbd0b8b891428ddd2b84bc4f30` and candidate `92eac5d59ca38275539995e9ce3fd5b57b613a53`. Later implementation commits change CI validation and documentation; `src/` and `test/` remain byte-identical to that candidate.

## Hosted paired controls

[Run 41842450308](https://github.com/dstoc/grain/actions/runs/41842450308) uses Node 24.22.1, Yjs 13.6.33, Vitest 5.0.5 and Vite+ 1.3.0 on ubuntu-24.04. Each of three VMs checks out both revisions with separate installs and runs the existing build/static, full Node, full browser and full extensive-smoke commands. Node uses two fork workers. Repetition 2 runs candidate first; the others run baseline first. Python standard-library measurement wrappers are identical for both revisions.

Installation and Chromium provisioning are measured separately. The second revision can benefit from a warm download/OS package cache; the reversed pair controls order. Every Node process and replica is fresh. Per-test JSON and full CPU/kernel/memory/tool manifests are retained in the run artifacts. Compact summaries are also retained in job-step metadata.

Completed matched pairs: **2/3**. The remaining paired job is pending. Acceptance of the three-run hosted comparison requires its terminal success and summary.

| Pair / order             | CPU / image                                      | Node wall before → after (s) | Retention case before → after (s) | Node CPU before → after (s) | Peak tree RSS before → after (KiB) |
| ------------------------ | ------------------------------------------------ | ---------------------------: | --------------------------------: | --------------------------: | ---------------------------------: |
| 2 / candidate → baseline | AMD EPYC 9V45 96-Core Processor / 20261026.354.1 |           1350.693 → 866.148 |                1274.372 → 789.973 |         2032.178 → 1486.583 |                  2009676 → 1802600 |
| 3 / baseline → candidate | AMD EPYC 9V45 96-Core Processor / 20261026.354.1 |           1454.316 → 923.375 |                1370.411 → 838.877 |         2170.424 → 1597.115 |                  1843380 → 1928080 |
| 1                        | pending                                          |                      pending |                           pending |                     pending |                            pending |

Resources match exactly within each completed pair: four logical CPUs, 16,367,524 KiB RAM, the same CPU model and image build, Node patch and package versions. Compare paired results when CPU/image differs between VMs. RSS is sampled every 100ms, includes descendants and can double-count shared pages; short peaks can be missed.

| Pair | Sum of sequential measured command wall before → after (s) | Combined two-revision job runner time (s) |
| ---- | ---------------------------------------------------------: | ----------------------------------------: |
| 2    |                                         1398.659 → 935.829 |                                      2349 |
| 3    |                                         1524.174 → 974.732 |                                      2513 |

Command totals exclude shared Actions checkout/setup/upload and small between-command wrapper overhead. Combined job time includes both revisions and that shared overhead; it cannot be assigned to one revision. Node CPU is child CPU, including descendants. Full phase CPU/memory and every test duration are in the artifacts. These controls measure the sequential legacy commands, not three repetitions of the new parallel layout.

## Required parallel workflow

All required jobs and the exact Node/browser/smoke runtime occurrence inventories passed at implementation commit `626828af425c768617e36e40ccb8a1925e452e4a`, [run 41844992735](https://github.com/dstoc/grain/actions/runs/41844992735). GitHub PR metadata reports the stable `test` aggregate as required and successful. Branch-rule administration APIs remain unavailable; no branch-protection change was needed. A documentation-only follow-up starts a new final-head run, which Check must follow to completion.

| Workflow revision | Critical-path wall including setup/scheduling (s) | Sum of runner job execution (s) |
| ----------------- | ------------------------------------------------: | ------------------------------: |
| `92eac5d`         |                                              1465 |                            2449 |
| `2d3dc5d`         |                                              1044 |                            2114 |
| `626828a`         |                                              1510 |                            2459 |

These are successful configuration iterations, not three repetitions of one pinned final workflow. Their runner images/CPUs were not controlled across jobs. They establish real fast feedback and completion tracking; they do not establish a controlled whole-layout speedup or final-layout variability. The first static check completed in 20 seconds of job execution and ordinary Node in 77 seconds; retention remained required until the aggregate passed. Parallel setup consumes extra runner time.

## Preserved coverage and independent replay

Every completed hosted revision passes the full legacy gate: baseline 1,705 Node tests versus candidate 1,706 (one added regression), with 192 unchanged skips; browser 330 passed/two existing skips; extensive smoke 8,660 passed/no skips. The entire 501-group history/old-prefix workload, 225 ordered structural pairs, eight generated/replayed schedules and original assertions remain unchanged. Nine frozen corpus/author/schedule/replay sources have matching SHA-256 hashes.

The new workflow also runs 24 orchestration controls, covering failed/cancelled/timed-out/skipped jobs, missing/duplicate/stale/malformed reports, lost duplicate occurrences, missing browser/smoke cases and failed local retries. Real disposable GitHub controls observed an actual failed test, cancelled timeout and skipped job; an always-running observer verified them and rejected missing reports in run 41837864440.

Fresh replay still opens a separate replica from canonical bytes, decodes/certifies/reduces independently and compares document observations, complete canonical bytes and materialized native identities. The optimization shares a tape snapshot only during one replica materialization and computes stable membership/location sort keys once. No production algorithm, public API, test deadline, expected result or source skip changed.

## Local controls and profiles

Three full local runs per revision passed on Linux/Node 26.13.0, Ryzen 9 5900X, two workers. These overlap other work and are exploratory; they are separate from the hosted pairs. All original case/status occurrence counts match, and all eight seeded operation/delivery/restart summaries match across all six runs.

| Local metric       |      Baseline median (range) |     Candidate median (range) |
| ------------------ | ---------------------------: | ---------------------------: |
| Node wall (s)      | 1823.321 (1643.738–1867.862) | 1172.188 (1065.414–1200.343) |
| Child CPU (s)      | 2624.904 (2473.310–2700.312) | 1976.617 (1902.545–2042.644) |
| Retention case (s) | 1716.736 (1617.675–1769.667) | 1076.883 (1039.881–1104.598) |
| Matrix file (s)    |    515.773 (510.561–549.594) |    525.835 (510.761–558.040) |

A 64-action author/observation CPU profile was 9.494s before and 7.910s after. A separate 64-action cold fresh-replay profile was 1.489s before and 1.436s after. These are single instrumented diagnostics, not substitute workloads or statistically established cold-replay improvements. Cold replay still spends substantial time in unchanged certification/reduction: the baseline ingest validator alone accounted for about 711ms inclusive (692ms after). Nested profile costs must not be summed.

The large retention trace remains the bottleneck. Initial experiment targets were retention below 85% of its baseline and matrix critical path below 60% of serial matrix. Matched Node/retention results can test the first target; the final matrix/layout target lacks a matched whole-layout control and is not claimed. Further production reducer/certification optimizations require a separate design and equivalence evidence.

## Reproduction and limits

Run commands and layout are in [ci-efficiency.md](ci-efficiency.md). The grain/100 `implementation-measurement-evidence` artifact contains raw local per-test/resource files, hosted job metadata, workflow source, profiles, source fingerprints and runnable report scripts. `tools/report.py raw --output local-report.json` rebuilds local tables. `tools/hosted-report.py raw/paired-jobs.json --output hosted-report.json` verifies all three paired counts/resources and rebuilds hosted summaries. Hosted full resource/per-test artifacts remain attached to run 41842450308; this runner’s proxy blocks their blob download with HTTP 403. Operator download is needed to inspect those raw files beyond the readable compact job summaries.

Excluded timing evidence: run 41837077277 failed static checks because generated outputs were inside the checkout; run 41837864440 used rolling Node patch/image versions. Neither is pooled into the paired comparison. The old historical 33m59s observation is also not a controlled baseline.

The external 20-minute watcher is shorter than observed successful workflows (24m25s and 25m10s). No watcher implementation/setting was found in this repository. Save exact PR head/run/job URLs, classify queued/running as pending, and resume bounded polling of that same run. A watcher deadline or unreadable API is not a test failure. The Tines supervisor/runner operator must identify the setting; propose a resumable observation budget covering the measured gate with margin. No global test timeout was increased.
