#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
const help =
  'Usage: node benchmarks/multiwriter/summarize-structural.mjs <result-directory>\n\nWrite or replace summary.json and summary.md from retained raw reports.\n';
if (process.argv[2] === '--help' || process.argv[2] === '-h') {
  process.stdout.write(help);
  process.exit(0);
}
if (process.argv.length !== 3) {
  process.stderr.write(help);
  process.exit(2);
}
const directory = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(directory, 'report.json')));
const cases = [];
for (const sample of manifest.samples) {
  if (!sample.label.endsWith('-attribution')) continue;
  const attribution = JSON.parse(readFileSync(join(directory, sample.report)));
  const wallFile = sample.report.replace('-attribution', '-wall');
  const wall = JSON.parse(readFileSync(join(directory, wallFile)));
  const rows = attribution.trace.map((row) => {
    const phaseMs = {};
    let total = 0,
      last = 0;
    for (const span of row.exclusive.spans) {
      assert.equal(span.start, last, 'span continuity');
      assert(span.end >= span.start);
      last = span.end;
      const elapsed = span.end - span.start;
      total += elapsed;
      phaseMs[span.phase] = (phaseMs[span.phase] ?? 0) + elapsed;
    }
    assert(Math.abs(total - row.exclusive.wallMs) < 1e-6, 'exclusive reconciliation');
    return {
      name: row.name,
      wallMs: wall.trace.find((s) => s.name === row.name).wallMs,
      attributionWallMs: row.wallMs,
      exclusiveMs: row.exclusive.wallMs,
      phaseMs,
      work: row.exclusive.work,
      resources: row.exclusive.resources,
      committedFrontier: {
        from: row.diagnostics.ownership.lastReplayFrom,
        length: row.diagnostics.ownership.lastReplayLength,
      },
      oracleMs: row.oracleMs,
    };
  });
  cases.push({
    label: sample.label.replace('-attribution', ''),
    prefixActions: attribution.prefixActions,
    deleted: attribution.deleted,
    cold: {
      wall: wall.coldLoadMs,
      attribution: attribution.coldLoadMs,
      referenceWall: wall.oracleColdMs,
      referenceAttribution: attribution.oracleColdMs,
    },
    rows,
  });
}
const classification = existsSync(join(directory, 'classification.json'))
  ? JSON.parse(readFileSync(join(directory, 'classification.json')))
  : null;
const result = {
  source: manifest.source,
  complete: manifest.complete,
  failure: manifest.failure ?? null,
  method:
    'raw single samples; wall and attribution workers have different new identities; no percentile, uninterrupted trace, persistence or browser claim',
  cases,
  classification: classification?.evidence.map(({ mapping, ...e }) => e) ?? null,
};
writeFileSync(join(directory, 'summary.json'), JSON.stringify(result, null, 2));
const lines = [
  '# MW-13A short measurements',
  '',
  `Measured source: \`${manifest.source}\`. Complete: ${manifest.complete}.`,
  '',
  result.method + '.',
  '',
  '| Input | Edit | Wall ms (diagnostics off) | Attribution wall ms | Pub replayed actions | Pub sort inputs | Full deletion indexes |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
];
for (const c of cases)
  for (const r of c.rows)
    lines.push(
      `| ${c.label} | ${r.name} | ${r.wallMs.toFixed(2)} | ${r.attributionWallMs.toFixed(2)} | ${r.committedFrontier.length} | ${r.work['publication/ownership.sortInputs'] ?? 0} | ${r.work['publication/deletion.fullIndexesConstructed'] ?? 0} |`,
    );
lines.push(
  '',
  '## Exclusive spans, milliseconds',
  '',
  'Every row includes driver overhead and reconciles with its attribution interval. Public API durations are separate and can nest.',
  '',
  '| Input | Edit | Draft/query | Native | Exact author | Coupled replay | Visibility/normalization | Selection/address | Append | Publication | Overhead |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
);
const phases = [
  'draft-query',
  'native-preparation',
  'exact-author',
  'coupled-replay',
  'visibility-normalization',
  'selection-address',
  'canonical-append',
  'publication',
  'overhead',
];
for (const c of cases)
  for (const r of c.rows)
    lines.push(
      `| ${c.label} | ${r.name} | ${phases.map((p) => (r.phaseMs[p] ?? 0).toFixed(2)).join(' | ')} |`,
    );
lines.push(
  '',
  '## Cold costs, milliseconds',
  '',
  'Cold/reference work is outside edit timers. Persistence is unmeasured.',
  '',
  '| Input | Candidate wall worker | Reference wall worker | Candidate attribution worker | Reference attribution worker |',
  '| --- | ---: | ---: | ---: | ---: |',
);
for (const c of cases)
  lines.push(
    `| ${c.label} | ${c.cold.wall.toFixed(2)} | ${c.cold.referenceWall.toFixed(2)} | ${c.cold.attribution.toFixed(2)} | ${c.cold.referenceAttribution.toFixed(2)} |`,
  );
if (manifest.failure)
  lines.push(
    '',
    `Incomplete workload: ${JSON.stringify(manifest.failure)}. A protective stop does not pass this case.`,
  );
writeFileSync(join(directory, 'summary.md'), lines.join('\n') + '\n');
process.stdout.write(join(directory, 'summary.md') + '\n');
