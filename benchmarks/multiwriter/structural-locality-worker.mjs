import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { parseArgs } from 'node:util';
import { mergeUpdates } from 'yjs';
import { runStructuralFixture, hash, json } from './structural-fixture.mjs';
const { values } = parseArgs({
  options: {
    fixture: { type: 'string' },
    output: { type: 'string' },
    instrumented: { type: 'boolean' },
    deleted: { type: 'boolean' },
  },
});
const raw = readFileSync(values.fixture),
  input = deserialize(raw);
const start = performance.now();
const initial = input.carriers ? mergeUpdates(input.carriers) : undefined;
const mergeMs = performance.now() - start;
const result = runStructuralFixture(input.genesis ?? input, initial, {
  instrumented: values.instrumented,
  deleted: values.deleted,
  onSetup: (row) => {
    process.stderr.write(`${row.phase}: ${row.wallMs.toFixed(1)} ms\n`);
    appendFileSync(values.output + '.setup.jsonl', json(row) + '\n');
  },
  onStep: (row, state) => {
    process.stderr.write(`${row.name}: ${row.wallMs.toFixed(1)} ms\n`);
    appendFileSync(values.output + '.steps.jsonl', json(row) + '\n');
    writeFileSync(values.output + '.partial.bin', serialize(state));
  },
});
const { canonical, carriers, ...report } = result;
writeFileSync(
  values.output + '.bin',
  serialize({ genesis: input.genesis ?? input, initial, carriers, canonical }),
  { flag: 'wx' },
);
writeFileSync(
  values.output + '.json',
  json({
    ...report,
    mergeMs,
    fixtureSha256: hash(raw),
    instrumented: !!values.instrumented,
    deleted: !!values.deleted,
    kind: 'new-local-continuation-of-old-capture',
    prefixActions: input.carriers?.length ?? 0,
    canonicalSha256: hash(canonical),
    newCarrierHashes: carriers.map(hash),
  }),
  { flag: 'wx' },
);
