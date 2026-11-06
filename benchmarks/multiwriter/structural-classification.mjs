import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import {
  emptyHomeCounterexample,
  rawObservation,
  refinementMap,
} from '../../test/multiwriter/structural-refinement.js';
import { commandGenesis } from '../../test/multiwriter/commands/replica.js';
import { projectWithActivity } from '../../src/markdown/multiwriter/projection/project.js';
import { reconstructProvenance } from '../../src/markdown/multiwriter/reference/provenance.js';
import { independentCheck, runRemoteFixture, json, hash } from './structural-fixture.mjs';
const output = process.argv[2];
const evidence = [];
for (const count of [1, 2]) {
  const result = emptyHomeCounterexample(count),
    { p, before, candidate } = result;
  try {
    independentCheck(p);
    const publication = p.document.publication.status().publication;
    const input = {
      genesis: p.genesis.layout,
      genesisManifest: p.genesis.body.nativeManifest,
      initialProperties: p.genesis.initialProperties,
      ...reconstructProvenance(p.genesis.layout, p.document.store.snapshot().ready),
      native: publication.native,
    };
    const candidateProjection = projectWithActivity(input, publication.value.activity, {
      ownership: candidate.value,
      snapshots: candidate.snapshots,
    });
    const visible = (root) => {
      const out = [];
      const visit = (n) => {
        if (['paragraph', 'section', 'code-block'].includes(n.type)) out.push(n.content);
        n.children.forEach(visit);
      };
      visit(root);
      return out;
    };
    const mapped = refinementMap(before, candidate);
    const expected = count === 1 ? ['a', 'bc'] : ['ac', 'b'];
    assert.deepEqual(
      p.nodes().map((n) => n.content),
      expected,
    );
    assert.deepEqual(visible(candidateProjection.view.root), ['a', 'bc']);
    assert.equal(
      json(rawObservation(candidate.value)) === json(rawObservation(publication.value.ownership)),
      count === 1,
    );
    const bytes = p.document.store.encodeUpdate();
    writeFileSync(
      `${output}/counterexample-${count}.bin`,
      serialize({
        genesis: p.genesis,
        canonical: bytes,
        prefixCanonical: result.beforeCanonical,
        actions: p.document.store.snapshot().ready,
      }),
      { flag: 'wx' },
    );
    evidence.push({
      markers: count,
      kind: 'new-local-native-trace',
      actions: 3,
      before: result.beforeText,
      candidate: visible(candidateProjection.view.root),
      reference: expected,
      canonicalSha256: hash(bytes),
      mapping: mapped,
      readerInvalidations: p.document.ownershipDiagnostics().nativeReaderInvalidations,
      outcome: count === 1 ? 'mapped-equivalence' : 'counterexample',
    });
  } finally {
    p.close();
  }
}
const remote = runRemoteFixture(commandGenesis('abcdef\n\nxyz\n\ntail'), { instrumented: true });
const { canonical, genesis, localCarriers, remoteCarriers, ...report } = remote;
writeFileSync(
  `${output}/remote.bin`,
  serialize({ genesis, canonical, localCarriers, remoteCarriers }),
  { flag: 'wx' },
);
writeFileSync(`${output}/classification.json`, json({ complete: true, evidence, remote: report }), {
  flag: 'wx',
});
