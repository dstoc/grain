# Grain/Yjs M1 measurements

These matched runs compare the M1 working tree with the `yjs` base at `4f9c93f` (the merged M0 revision). They use Yjs `13.6.33`, fixture seed `520052`, Node.js `v26.13.0`, Linux x64, and an AMD Ryzen 9 5900X with 24 logical CPUs. The harness runs use Chromium `156.0.8078.73` at `1280 × 720`.

Each side ran in two fresh processes. Each process used 25 warm-up and 200 measured operations. The table gives the median of the two process p50 values and the median of the two process p95 values. These are observations from this runner, not portable performance claims.

| Profile and stage                             |    M0 p50 |    M1 p50 |    M0 p95 |    M1 p95 |
| --------------------------------------------- | --------: | --------: | --------: | --------: |
| Core, prepare through publish, 150 paragraphs | 48.577 ms | 14.931 ms | 86.282 ms | 17.892 ms |
| Core, prepare text input                      | 11.452 ms |  3.577 ms | 23.023 ms |  5.085 ms |
| Core, apply and publish                       | 36.942 ms | 11.207 ms | 63.144 ms | 13.561 ms |
| Browser harness, 150 paragraphs               | 61.450 ms | 38.100 ms | 92.650 ms | 43.950 ms |

The harness rebuilt its Markdown parser 200 times in each M0 process and zero times in each M1 process. Both sides produced the same serialized output length.

The harness flushes before source copy, save reads, playback, scrubbing, and tab transitions. `markdownForSave()` returns the latest Markdown to a host; this demo has no persistence backend.

The separate untimed native counter sample for the 150-paragraph core fixture recorded:

- M0: 326 `Y.Map.set` calls, including 298 unchanged-value writes.
- M1: 30 `Y.Map.set` calls, including zero unchanged-value writes.
- Mean accepted update size across the measured actions: 1,832.145 bytes in M0 and 85.13 bytes in M1.
- Accepted update size in the counter sample: 1,980 bytes in M0 and 124–125 bytes in M1.

M1's sample includes the new session watermark writes. The complete path-level native counters, delete-set counts, state sizes, and per-process timing distributions are in [the core report](./results/core-paragraphs-150.json). The two-process browser distributions and parser rebuild counts are in [the harness report](./results/harness-paragraphs-150.json).

The 2 ms p50 and 5 ms p95 target for 150-paragraph acceptance was not met: M1 measured 14.931 ms p50 and 17.892 ms p95 for prepare through publish. This run covers the 150-paragraph fixture and harness profile only; it does not replace the full seven-fixture core profile or retention profile.
