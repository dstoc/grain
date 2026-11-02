# Grain/Yjs M0 benchmark

This harness records a repeatable baseline for canonical editing, the Chromium editor, the full demo harness, and retained history. It separates timing from test-only native operation counters. The baseline ref and fixture definitions are in [manifest.json](./manifest.json). Visible behavior cases and the intentional identity difference are in [parity-corpus.json](./parity-corpus.json).

The current baseline measurements and exact environment are indexed in [results/README.md](./results/README.md). Timing reports are observations for that runner; they do not prove that later engineering targets pass.

Run a profile from the Grain repository root:

```sh
npm run bench:yjs-m0 -- --profile core --runs 5 --output benchmarks/yjs-m0/results/core.json
```

The runner starts a new npm/Vitest process for each run. It writes progress to stderr and the report to stdout, unless `--output` is set. Output files are created without replacement; pass `--force` to replace one.

Available profiles are:

- `core`: paired prepare-through-publish acceptance, its prepare and apply/publish sub-stages, projection, serialization, checkpoint export, and native operation counts across the fixture tiers. The 1,000-item wide-list fixture also records one untimed structural move's native writes, receipt, and checkpoint delta.
- `editor`: 200 mounted Chromium editor input operations on 150 paragraphs.
- `harness`: 200 mounted Chromium demo harness input operations, including the current parser rebuild path.
- `retention`: 0, 64, and 500 retained groups, plus a 10,000-action trace.

The default fresh-process counts are five for core, editor, and harness, and three for retention. Override them with `--runs`. Use `--profile all` to run every profile.

Use `--fixture <id>` with `--profile core` to run one fixture. The full core profile reports progress before and after each fixture, so long tiered runs show which shape is active.

To compare one candidate with a ref, run the same profile on both:

```sh
npm run bench:yjs-m0 -- --profile core --against origin/yjs --runs 5
```

The runner creates a detached temporary worktree for the ref, overlays the checked-in M0 harness files, and reuses the current `node_modules`. It removes the worktree after the run. The ref must be available locally and must pin `yjs@13.6.33`. Keep each candidate ref focused on one change when using this command for an ablation.

Each process reports nearest-rank p50 and p95, mean, and population standard deviation over operations. The runner reports the median and median absolute deviation of process p50 values, and p95 across those process p50 values. It also records update bytes, delete-set ranges, receipts, native writes by shared-type path and key, introduced client IDs, live/deleted structures, marker/tape/span counts, node ownership by tape, active `afterTransaction` callbacks, and heap and RSS observations. Engineering budgets in the manifest are targets, never measured results.

The counter adapter wraps Yjs 13.6.33 public mutation methods and reads a small set of Yjs internals for client, struct, and observer counts. `publicDocTransactCalls` counts calls to `Y.Doc.prototype.transact`, including calls that reuse an already active native transaction; it is not a native transaction lifecycle count. Origin labels preserve primitive types and use per-sample identity numbers for object, function, and symbol origins. Counter samples use a separate action from the timed distributions. Browser input uses Vitest's Chromium keyboard driver; it does not represent physical keyboard, mobile, or IME latency. Timing results describe the recorded machine and are not portable performance claims.

Use `--counters-only` with the core profile to refresh its untimed native operation samples without repeating timing distributions. This is useful when counter instrumentation changes; the output is a separate correction report that can be merged into the existing timing report without replacing its distributions.

The retention profile writes a JSONL progress file beside its final report (`<output>.progress.jsonl`) or to a unique file in `benchmarks/yjs-m0/results/` when no output is supplied. Each completed 0/64/500-depth case is appended before the long trace starts. The single 10,000-action trace then appends the exact per-action timing samples and cumulative byte totals every 100 actions. This file remains useful when the run is interrupted; a partial trace is progress data, not a completed measurement. Pass `--progress-file <file>` to choose another location.

The browser profiles use the Chromium configured by Vitest. If Playwright's bundled Chromium is absent but the runner has system Chromium, temporarily set the browser provider's `launchOptions.executablePath` (for example, `/usr/bin/chromium`) for the measurement, then restore the config before committing.

The test-only benchmark is skipped by normal test commands unless the runner selects its profile. The parity corpus and baseline operation-count assertion run in normal CI. Existing collaboration and checkpoint reconstruction tests remain part of that suite.
