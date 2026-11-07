import { afterEach, expect, test, vi } from 'vitest';
import type { ActionEnvelope } from '../contracts.js';
import type { ReferenceGenesis } from '../reference/document.js';
import { openReferenceDocument } from '../reference/document.js';
import * as provenance from '../reference/provenance.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { NativeTapeCache } from '../text/cache.js';
import { captureDiagnostics } from '../diagnostics.js';
import { compareBytes } from '../actions/cbor.js';
import { resourceKey } from '../layout/index.js';
import { MaterializedActivity } from './activity.js';
import { MaterializedOwnership } from './coupled.js';
import { openMaterializedDocument } from './document.js';
import { createMaterializationOracle } from '../../../../test/multiwriter/materialization-oracle.js';
import { IngestCapacityError } from '../ingest/work.js';

afterEach(() => vi.restoreAllMocks());

function fixture(unrelated = 0) {
  return new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [{ id: 'P0', text: 'abc' }],
    },
    { id: 'Q', parent: 'root', role: 'inline', flow: 'fQ', run: 'rQ', tape: 'tQ', cells: [] },
    ...Array.from({ length: unrelated }, (_, i) => ({
      id: `U${i}`,
      parent: 'root',
      role: 'inline' as const,
      flow: `fU${i}`,
      run: `rU${i}`,
      tape: `tU${i}`,
      cells: [],
    })),
  ]);
}
function documents(f: NativeFixture) {
  const genesis: ReferenceGenesis = {
    documentId: 'D',
    genesisId: 'G',
    layout: f.genesis,
    body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
  };
  const actual = openMaterializedDocument(genesis),
    reference = openReferenceDocument(genesis);
  for (const doc of [actual, reference]) {
    let result = doc.publication.refresh();
    while (result.state === 'deferred') result = result.continuation.resume();
  }
  return {
    actual,
    reference,
    close: () => {
      actual.destroy();
      reference.destroy();
      f.destroy();
    },
  };
}

for (const unrelated of [0, 8, 32])
  for (const variant of [
    'split',
    'join',
    'bracketed',
    'bare',
    'one-bracket',
    'marker-only-partition',
    'home',
    'birth-slot',
    'marker-native',
    'missing-marker',
  ] as const)
    test(`early exact-local validation agrees with full: ${unrelated} unrelated homes / ${variant}`, () => {
      const f = fixture(unrelated);
      f.author('A1', (f) => {
        if (variant === 'bracketed') f.insert('', '😀', 'Q:end');
        if (variant === 'bare')
          f.native([{ type: 'text', tape: f.id('tQ', 'tape'), index: 1, text: '😀' }]);
        if (variant === 'one-bracket')
          f.native([
            {
              type: 'marker',
              tape: f.id('tQ', 'tape'),
              index: 1,
              marker: f.allocate('one', 'marker'),
              affinity: 'left',
            },
            { type: 'text', tape: f.id('tQ', 'tape'), index: 2, text: '😀' },
          ]);
        return [variant === 'join' ? f.join('fQ', 'P:end') : f.split('P', 'S', 'P0')];
      });
      let action = f.envelope('A1');
      if (variant === 'home')
        action = {
          ...action,
          allocations: action.allocations.map((a) =>
            a.type === 'run' ? { ...a, skeleton: a.skeleton.slice(0, -1) } : a,
          ),
        };
      if (variant === 'birth-slot')
        action = {
          ...action,
          allocations: action.allocations.map((a) =>
            a.type === 'node'
              ? {
                  ...a,
                  birthSlot: { ...a.birthSlot!, predecessor: f.id('Q:birth', 'occurrence') },
                }
              : a,
          ),
        };
      if (variant === 'marker-native')
        action = {
          ...action,
          allocations: action.allocations.map((a) =>
            a.type === 'marker' ? { ...a, native: { ...a.native, clock: a.native.clock + 1 } } : a,
          ),
        };
      if (variant === 'missing-marker') {
        const marker = action.allocations.find((a) => a.type === 'marker')!;
        action = { ...action, allocations: action.allocations.filter((a) => a !== marker) };
      }
      const p = documents(f),
        held = p.actual.publication.status().publication!,
        before = p.actual.store.encodeUpdate();
      if (variant === 'marker-only-partition') {
        expect(action.nativeManifest.some((b) => b.type === 'text')).toBe(false);
        const snapshot = NativeTapeCache.prototype.snapshot;
        vi.spyOn(NativeTapeCache.prototype, 'snapshot').mockImplementation(function (
          this: NativeTapeCache,
          tape,
        ) {
          const result = snapshot.call(this, tape);
          if (resourceKey(tape) === resourceKey(f.id('tP', 'tape'))) {
            const part = result.parts[1];
            Object.assign(part, { index: part.index + 1 });
          }
          return result;
        });
      }
      try {
        const expected = p.reference.store.checkLocal(action);
        const { value, report } = captureDiagnostics(() => p.actual.store.checkLocal(action));
        expect(value).toBe(expected);
        const valid = ['split', 'join', 'bracketed'].includes(variant);
        expect(value).toBe(
          valid ? null : variant === 'marker-native' ? 'native-body' : 'reference',
        );
        expect(p.actual.authorProofDiagnostics().hits).toBe(valid ? 1 : 0);
        if (valid) {
          expect(report.work['author/authorProof.candidateActionsValidated']).toBe(1);
          expect(report.work['author/authorProof.affectedTapesValidated']).toBe(
            variant === 'join' ? 0 : variant === 'bracketed' ? 3 : 2,
          );
          expect(report.work['author/projectionAuthor.candidateBirthCallbacks']).toBe(1);
          expect(report.work['author/authorProof.fullCertifications'] ?? 0).toBe(0);
          expect(report.work['author/authorProof.snapshotBindingsIndexed'] ?? 0).toBe(0);
        }
        expect(p.actual.publication.status().publication).toBe(held);
        expect(compareBytes(p.actual.store.encodeUpdate(), before)).toBe(0);
      } finally {
        p.close();
      }
    });

for (const outcome of [
  'unavailable-activity',
  'unavailable-suffix',
  'callback-error',
  'callback-reentry',
  'snapshot-error',
  'capacity-error',
] as const)
  test(`early proof preserves failure and fallback boundaries: ${outcome}`, () => {
    const f = fixture();
    f.author('A1', (f) => [f.split('P', 'S', 'P0')]);
    const births = vi.spyOn(provenance, 'reconstructBirths');
    const p = documents(f),
      action = f.envelope('A1'),
      held = p.actual.publication.status().publication!,
      before = p.actual.store.encodeUpdate();
    births.mockClear();
    if (outcome === 'unavailable-activity')
      vi.spyOn(MaterializedActivity.prototype, 'authorBase').mockReturnValue(undefined);
    if (outcome === 'unavailable-suffix')
      vi.spyOn(MaterializedOwnership.prototype, 'prepareAuthor').mockImplementation(function* () {
        yield;
        return { state: 'unavailable', reason: 'test-suffix' };
      });
    if (outcome === 'callback-error')
      births.mockImplementation(() => {
        throw new Error('host birth failure');
      });
    if (outcome === 'callback-reentry')
      births.mockImplementation((a: ActionEnvelope) => {
        p.actual.publication.refresh();
        return a.effects.flatMap((e) =>
          e.type === 'SplitFlow' ? [{ node: e.newNode, occurrence: e.occurrence }] : [],
        );
      });
    if (outcome === 'snapshot-error')
      vi.spyOn(NativeTapeCache.prototype, 'snapshot').mockImplementation(() => {
        throw new Error('native reader failure');
      });
    if (outcome === 'capacity-error')
      vi.spyOn(NativeTapeCache.prototype, 'snapshot').mockImplementation(() => {
        throw new IngestCapacityError('validation', 'local-test', 123);
      });
    try {
      if (outcome.startsWith('unavailable')) {
        const { value, report } = captureDiagnostics(() => p.actual.store.checkLocal(action));
        expect(value).toBe(null);
        expect(p.actual.authorProofDiagnostics()).toMatchObject({
          requests: 1,
          hits: 0,
          misses: {
            [outcome === 'unavailable-activity' ? 'unavailable-activity-base' : 'test-suffix']: 1,
          },
        });
        expect(report.work['author/authorProof.fullCertifications']).toBe(1);
        expect(report.work['author/authorProof.preambleActions']).toBe(1);
        expect(report.work['author/authorProof.snapshotBindingsIndexed']).toBe(3);
        expect(report.work['author/projectionAuthor.candidateBirthCallbacks']).toBe(1);
      } else
        expect(() => p.actual.store.checkLocal(action)).toThrow(
          outcome === 'callback-error'
            ? 'host birth failure'
            : outcome === 'snapshot-error'
              ? 'native reader failure'
              : outcome === 'capacity-error'
                ? 'local-test'
                : 'invalidated',
        );
      expect(births).toHaveBeenCalledTimes(1);
      expect(compareBytes(p.actual.store.encodeUpdate(), before)).toBe(0);
      expect(p.actual.publication.status().publication).toBe(held);
    } finally {
      p.close();
    }
  });

test('a missing author head uses its own closure, not the merged publication', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'S', 'P0')]);
  f.author('B1', (f) => [f.split('Q', 'T', null)]);
  const p = documents(f),
    oracle = createMaterializationOracle();
  try {
    for (const doc of [p.actual, p.reference]) {
      doc.store.append(f.envelope('B1'));
      let state = doc.publication.refresh();
      while (state.state === 'deferred') state = state.continuation.resume();
    }
    const action = f.envelope('A1');
    expect(p.reference.store.checkLocal(action)).toBe(null);
    const { value, report } = captureDiagnostics(() => p.actual.store.checkLocal(action));
    expect(value).toBe(null);
    expect(report.work['author/authorProof.hits'] ?? 0).toBe(0);
    expect(report.work['author/authorProof.fullCertifications']).toBe(1);
    // The candidate's closure has the two genesis tapes and its own new home.
    // The concurrently born T tape must not enter author certification.
    expect(report.work['author/projectionAuthor.preambleSnapshots']).toBe(3);
    p.actual.store.append(action);
    let state = p.actual.publication.refresh();
    while (state.state === 'deferred') state = state.continuation.resume();
    oracle.check(p.actual, {
      documentId: 'D',
      genesisId: 'G',
      layout: f.genesis,
      body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
    });
  } finally {
    oracle.destroy();
    p.close();
  }
});

test('a split with a move companion keeps ordinary full validation', () => {
  const f = fixture();
  f.author('A1', (f) => [f.split('P', 'S', 'P0'), f.move('Q', 'root', 'P:birth')]);
  const p = documents(f);
  try {
    const action = f.envelope('A1');
    expect(p.reference.store.checkLocal(action)).toBe(null);
    const { value, report } = captureDiagnostics(() => p.actual.store.checkLocal(action));
    expect(value).toBe(null);
    expect(p.actual.authorProofDiagnostics()).toMatchObject({
      hits: 0,
      misses: { 'unsupported-effect-shape': 1 },
    });
    expect(report.work['author/authorProof.fullCertifications']).toBe(1);
    expect(report.work['author/projectionAuthor.candidateBirthCallbacks']).toBe(1);
  } finally {
    p.close();
  }
});
