import { expect, test } from 'vitest';
import { commandGenesis, commandReplica } from '../../../../test/multiwriter/commands/replica.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { insertParagraph } from '../../../editing/commands/insert-paragraph.js';
import { joinWithPrevious } from '../../../editing/commands/join-with-previous.js';
import { insertText } from '../../../editing/commands/insert-text.js';
import { resource } from '../actions/test-fixtures.js';
import { resourceKey } from '../layout/index.js';
import { compareBytes } from '../actions/cbor.js';
import { MaterializedPublication } from './publication.js';
import { OwnershipCoverage } from './coverage.js';

const a = resource('flow', 1),
  b = resource('flow', 2);

test('coverage rejects duplicates against unchanged roots and within a changed traversal', () => {
  const coverage = new OwnershipCoverage();
  coverage.invalidate(a);
  coverage.invalidate(b);
  coverage.check(
    2,
    (flow) => (flow === a ? ['a'] : ['b']),
    () => {},
  );
  const changed = coverage.fork();
  changed.invalidate(a);
  expect(() =>
    changed.check(
      2,
      () => ['b'],
      () => {},
    ),
  ).toThrow(/more than once/);
  const repeated = coverage.fork();
  repeated.invalidate(a);
  expect(() =>
    repeated.check(
      2,
      () => ['a', 'a'],
      () => {},
    ),
  ).toThrow(/more than once/);
  const missing = coverage.fork();
  missing.invalidate(a);
  expect(() =>
    missing.check(
      2,
      () => [],
      () => {},
    ),
  ).toThrow(/unreachable/);
  // Failed candidate checks cannot mutate the retained certificate.
  coverage.check(
    2,
    () => {
      throw new Error('Unchanged root was traversed');
    },
    () => {},
  );
});

test('coverage moves membership between components and refines each retained prefix independently', () => {
  const coverage = new OwnershipCoverage();
  coverage.invalidate(a);
  coverage.invalidate(b);
  coverage.check(
    2,
    (flow) => (flow === a ? ['a'] : ['b']),
    () => {},
  );
  const joined = coverage.fork();
  joined.invalidate(b);
  joined.invalidate(a);
  joined.check(
    2,
    (flow) => (flow === a ? ['a', 'b'] : undefined),
    () => {},
  );
  const refined = joined.fork();
  refined.refine(new Map([['b', ['b-left', 'b-right']]]));
  refined.check(
    3,
    () => {
      throw new Error('Subdivision traversed an unchanged component');
    },
    () => {},
  );
  // Detach into a standalone flow after subdivision, in reverse invalidation order.
  refined.invalidate(b);
  refined.invalidate(a);
  const seen: string[] = [];
  refined.check(
    3,
    (flow) => {
      seen.push(resourceKey(flow));
      return flow === a ? ['a'] : ['b-left', 'b-right'];
    },
    () => {},
  );
  expect(seen).toEqual([resourceKey(b), resourceKey(a)]);
  coverage.check(
    2,
    () => {
      throw new Error('Old prefix was invalidated');
    },
    () => {},
  );
  joined.check(
    2,
    () => {
      throw new Error('Joined prefix was invalidated');
    },
    () => {},
  );
  const duplicate = joined.fork();
  expect(() => duplicate.refine(new Map([['b', ['a']]]))).toThrow(/more than once/);
  expect(() => joined.fork().refine(new Map([['missing', ['x']]]))).toThrow(/certificate/);
});

for (const size of [10, 150])
  test(`structural coverage checks only affected components through history and refinement (${size})`, () => {
    const p = commandReplica(
      commandGenesis(Array.from({ length: size }, () => 'abcdef').join('\n\n')),
      undefined,
      'materialized',
    );
    const oracle = createMaterializationOracle();
    if (!('ownershipDiagnostics' in p.document)) throw new Error();
    const diagnostics = p.document.ownershipDiagnostics;
    const history = p.editor.session('coverage');
    try {
      const held = p.document.publication.status().publication!,
        original = held.native.encodeState(),
        assignments = held.value.ownership.assignments;
      const nodeId = p.handle(p.nodes()[Math.floor(size / 2)]),
        before = diagnostics();
      expect(history.edit(insertParagraph, { nodeId, from: 3 }).status).toBe('applied');
      const split = diagnostics();
      expect(split.coverageFlowsTraversed - before.coverageFlowsTraversed).toBeLessThanOrEqual(3);
      expect(split.coverageCellsVisited - before.coverageCellsVisited).toBeLessThan(40);
      expect(
        p
          .nodes()
          .slice(Math.floor(size / 2), Math.floor(size / 2) + 2)
          .map((n) => n.content),
      ).toEqual(['abc', 'def']);
      oracle.check(p.document, p.genesis);
      const tailId = p.handle(p.nodes()[Math.floor(size / 2) + 1]);
      expect(history.edit(joinWithPrevious, { nodeId: tailId }).status).toBe('applied');
      const joined = diagnostics();
      // The join adds markers inside the preceding split's read interval. Its
      // invalidated prefix predates checkpoint 128, so genesis needs one complete
      // certificate. Replayed effects must not traverse all roots again.
      const cold = joined.coldReplays - split.coldReplays;
      expect(
        joined.coverageFlowsTraversed - split.coverageFlowsTraversed - size * cold,
      ).toBeLessThanOrEqual(4);
      expect(
        joined.coverageCellsVisited - split.coverageCellsVisited - size * 8 * cold,
      ).toBeLessThan(40);
      oracle.check(p.document, p.genesis);
      // Native subdivision follows a transferred/joined path. It must refine the
      // certificate without borrowing membership from the later split undo.
      const active = p.handle(p.nodes()[Math.floor(size / 2)]);
      expect(history.edit(insertText, { nodeId: active, from: 4, text: '😀' }).status).toBe(
        'applied',
      );
      oracle.check(p.document, p.genesis);
      expect(history.undo().state).toBe('applied');
      expect(history.undo().state).toBe('applied');
      oracle.check(p.document, p.genesis);
      expect(history.redo().state).toBe('applied');
      expect(history.redo().state).toBe('applied');
      oracle.check(p.document, p.genesis);
      expect(compareBytes(held.native.encodeState(), original)).toBe(0);
      expect(held.value.ownership.assignments).toEqual(assignments);
      const publication = p.document.publication;
      if (!(publication instanceof MaterializedPublication)) throw new Error();
      const bytes = p.document.store.encodeUpdate();
      publication.evict();
      expect(history.undo().state).toBe('applied');
      oracle.check(p.document, p.genesis);
      expect(history.redo().state).toBe('applied');
      const restarted = commandReplica(p.genesis, p.document.store.encodeUpdate());
      try {
        expect(restarted.observe()).toEqual(p.observe());
        expect(p.document.store.encodeUpdate().length).toBeGreaterThan(bytes.length);
      } finally {
        restarted.close();
      }
    } finally {
      oracle.destroy();
      p.close();
    }
  }, 60000);
