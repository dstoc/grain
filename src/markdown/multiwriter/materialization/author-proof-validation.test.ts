import { expect, test } from 'vitest';
import { captureDiagnostics } from '../diagnostics.js';
import { NativeFixture } from '../ownership/test-fixtures.js';
import { openMaterializedDocument } from './document.js';
import { openReferenceDocument } from '../reference/document.js';
import type { ReferenceGenesis } from '../reference/document.js';
import type { ActionEnvelope, SemanticEffect } from '../contracts.js';

function genesis(f: NativeFixture): ReferenceGenesis {
  return {
    documentId: 'D',
    genesisId: 'G',
    layout: f.genesis,
    body: { ...f.bodies.get('G')!, allocations: f.genesis.allocations },
  };
}
function check(f: NativeFixture, action: ActionEnvelope, past: readonly string[] = []) {
  const input = genesis(f),
    materialized = openMaterializedDocument(input),
    reference = openReferenceDocument(input);
  try {
    for (const doc of [materialized, reference]) {
      for (const name of past) doc.store.append(f.envelope(name));
      let state = doc.publication.refresh();
      while (state.state === 'deferred') state = state.continuation.resume();
    }
    const expected = reference.store.checkLocal(action);
    expect(materialized.store.checkLocal(action)).toBe(expected);
    return { expected, counts: materialized.authorProofDiagnostics() };
  } finally {
    materialized.destroy();
    reference.destroy();
  }
}
function fixture(text = ['a', 'b', 'c']) {
  return new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: text.map((text, i) => ({ id: `P${i}`, text })),
    },
    {
      id: 'Q',
      parent: 'root',
      role: 'inline',
      flow: 'fQ',
      run: 'rQ',
      tape: 'tQ',
      cells: [{ id: 'Q0', text: 'X' }],
    },
  ]);
}
function split(action: ActionEnvelope) {
  return action.effects[0] as Extract<SemanticEffect, { type: 'SplitFlow' }>;
}

for (const side of ['left', 'right'] as const)
  for (const variant of [
    'ordered',
    'joined',
    'disconnected',
    'reordered',
    'empty-cell-gap',
    'wrong-occurrence',
    'wrong-skeleton',
    'unavailable-source',
    'invalid-cut',
  ] as const)
    test(`private author mode agrees with full certification: ${side} / ${variant}`, () => {
      const f = fixture(variant === 'empty-cell-gap' ? ['a', '', 'c'] : undefined);
      try {
        const past = variant === 'joined' ? ['A1'] : [];
        if (past.length) f.author('A1', (f) => [f.join('fQ', 'P:end')]);
        const names =
          variant === 'disconnected'
            ? ['P0', 'P1', 'Q0']
            : variant === 'reordered'
              ? ['P0', 'P2', 'P1']
              : variant === 'empty-cell-gap'
                ? ['P0', 'P2']
                : ['P0', 'P1', 'P2', ...(past.length ? ['Q0'] : [])];
        const basis = names.map((name) => ({
          range: f.ranges.get(name)!,
          occurrence: f.id(`${name[0]}:birth`, 'occurrence'),
        }));
        const name = past.length ? 'A2' : 'A1';
        f.author(
          name,
          (f) => [f.split('P', 'S', 'P0', side, 'root', side === 'left' ? 'P:birth' : null, basis)],
          past,
          BigInt(past.length + 1),
        );
        const action = f.envelope(name),
          effect = split(action);
        if (variant === 'wrong-occurrence')
          (effect.basis.ranges[0] as { occurrence: typeof effect.occurrence }).occurrence = f.id(
            'Q:birth',
            'occurrence',
          );
        if (variant === 'wrong-skeleton')
          (action as { allocations: ActionEnvelope['allocations'] }).allocations =
            action.allocations.map((a) =>
              a.type === 'run' ? { ...a, skeleton: a.skeleton.slice(-1) } : a,
            );
        if (variant === 'unavailable-source')
          (effect.cut as { run: typeof effect.newRun }).run = effect.newRun;
        if (variant === 'invalid-cut')
          (effect.cut as { boundary: typeof effect.cut.boundary }).boundary = f.id(
            'P:start',
            'marker',
          );
        const result = check(f, action, past);
        expect(result.expected).toBe(
          variant === 'ordered' || variant === 'joined' ? null : 'reference',
        );
        if (result.expected === null) expect(result.counts.hits).toBe(1);
        else expect(result.counts.hits).toBe(0);
      } finally {
        f.destroy();
      }
    });

for (const variant of [
  'valid',
  'content-omitted',
  'wrong-side',
  'wrong-boundary',
  'duplicate-birth',
  'overlap',
  'reserved-capture',
] as const)
  test(`private author mode preserves constructor/empty checks: ${variant}`, () => {
    const f = fixture(variant === 'content-omitted' ? undefined : []);
    try {
      f.author('A1', (f) => [
        f.split(
          'P',
          'S',
          null,
          'left',
          'root',
          'P:birth',
          variant === 'content-omitted' ? [] : undefined,
        ),
      ]);
      const action = f.envelope('A1'),
        effect = split(action);
      if (variant === 'wrong-side') (effect.cut as { side: 'left' | 'right' }).side = 'right';
      if (variant === 'wrong-boundary')
        (effect.cut as { boundary: typeof effect.cut.boundary }).boundary = f.id(
          'P:start',
          'marker',
        );
      if (variant === 'duplicate-birth')
        (action as { allocations: ActionEnvelope['allocations'] }).allocations = [
          ...action.allocations,
          action.allocations[0],
        ];
      if (variant === 'overlap' || variant === 'reserved-capture')
        (action as { allocations: ActionEnvelope['allocations'] }).allocations =
          action.allocations.map((a) =>
            a.type === 'run'
              ? {
                  ...a,
                  skeleton:
                    variant === 'overlap'
                      ? [...a.skeleton, ...a.skeleton]
                      : [
                          {
                            tape: f.id('tP', 'tape'),
                            start: f.id('P:start', 'marker'),
                            end: f.id('P:end', 'marker'),
                          },
                          ...a.skeleton,
                        ],
                }
              : a,
          );
      const result = check(f, action);
      expect(result.expected).toBe(variant === 'valid' ? null : 'reference');
      expect(result.counts.hits).toBe(variant === 'valid' ? 1 : 0);
    } finally {
      f.destroy();
    }
  });

test('reserved-to-ordinary historical readers decline before any old B replay', () => {
  const f = new NativeFixture([
    { id: 'root', parent: null, role: 'root' },
    {
      id: 'P',
      parent: 'root',
      role: 'inline',
      flow: 'fP',
      run: 'rP',
      tape: 'tP',
      cells: [...'abc'].map((text, i) => ({ id: `P${i}`, text })),
    },
    { id: 'Q', parent: 'root', role: 'inline', flow: 'fQ', run: 'rQ', tape: 'tQ', cells: [] },
    {
      id: 'T',
      parent: 'root',
      role: 'inline',
      flow: 'fT',
      run: 'rT',
      tape: 'tT',
      cells: [...'xyz'].map((text, i) => ({ id: `T${i}`, text })),
    },
  ]);
  let materialized: ReturnType<typeof openMaterializedDocument> | undefined;
  let reference: ReturnType<typeof openReferenceDocument> | undefined;
  try {
    f.author('A1', (f) => [f.join('fQ', 'P:after-b')]);
    f.author('A2', (f) => [f.split('P', 'S', 'P0')], ['A1'], 2n);
    f.author(
      'A3',
      (f) => {
        f.native(
          [1, 2].map((index) => ({
            type: 'marker',
            tape: f.id('tQ', 'tape'),
            index,
            marker: f.allocate(`new-${index}`, 'marker'),
            affinity: 'right',
          })),
        );
        return [f.split('T', 'U', 'T0')];
      },
      ['A2'],
      3n,
    );
    const input = genesis(f);
    materialized = openMaterializedDocument(input);
    reference = openReferenceDocument(input);
    for (const doc of [materialized, reference]) {
      for (const name of ['A1', 'A2']) {
        doc.store.append(f.envelope(name));
        let state = doc.publication.refresh();
        while (state.state === 'deferred') state = state.continuation.resume();
      }
    }
    const candidate = f.envelope('A3');
    expect(reference.store.checkLocal(candidate)).toBe(null);
    const result = captureDiagnostics(() => materialized!.store.checkLocal(candidate));
    expect(result.value).toBe(null);
    expect(materialized.authorProofDiagnostics().misses['reserved-content-reader']).toBe(1);
    expect(result.report.work['author/ownership.suffixActions'] ?? 0).toBe(0);
    expect(result.report.work['author/referenceOwnership.fullReconstructions']).toBe(1);
  } finally {
    materialized?.destroy();
    reference?.destroy();
    f.destroy();
  }
});
