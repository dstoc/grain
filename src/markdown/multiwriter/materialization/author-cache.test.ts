import { expect, test, vi } from 'vitest';
import { commandGenesis } from '../../../../test/multiwriter/commands/replica.js';
import { A, action } from '../actions/test-fixtures.js';
import { actionKey } from '../actions/references.js';
import { encodeEnvelope } from '../actions/codec.js';
import { createIngestValidator } from '../ingest/validator.js';
import { finish } from '../ingest/work.js';
import { IndexedActionStore } from './readiness.js';

function open() {
  const genesis = commandGenesis('abc');
  const validate = createIngestValidator({ genesis: genesis.body });
  const store = new IndexedActionStore({
    documentId: genesis.documentId,
    genesisId: genesis.genesisId,
    genesisAllocations: genesis.layout.allocations,
    validate,
  });
  return {
    store,
    validate,
    close: () => {
      store.destroy();
      validate.destroy();
    },
  };
}

test('author branch checks changed payload keys and drops withdrawn facts without changing held roots', () => {
  const p = open(),
    first = action(),
    second = action(A, 2n, [first]);
  try {
    p.store.append(first);
    const held = p.store.readReady();
    p.validate.retainReadyFacts(held.variants);
    p.store.append(second);
    const current = p.store.readReady(),
      before = p.validate.cacheDiagnostics();
    const reads = vi.spyOn(current.variants, 'get');
    try {
      p.validate.retainReadyFacts(current.variants);
      expect(reads.mock.calls.map(([key]) => key)).toEqual([actionKey(second.id)]);
      reads.mockClear();
      p.validate.retainReadyFacts(current.variants);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
    expect(p.validate.cacheDiagnostics().retainedFactsCompared - before.retainedFactsCompared).toBe(
      1,
    );
    expect(p.validate.cacheDiagnostics().nativeBranch).toBe(true);
    p.store.append({ ...first, groupId: { ...first.groupId, sequence: 99n } });
    const withdrawn = p.store.readReady();
    expect(withdrawn.ready).toEqual([]);
    expect(p.validate.cacheDiagnostics().nativeBranch).toBe(true);
    p.validate.retainReadyFacts(withdrawn.variants);
    expect(p.validate.cacheDiagnostics().nativeBranch).toBe(false);
    expect(held.variants.get(actionKey(first.id))).toEqual(encodeEnvelope(first));
    expect(current.variants.get(actionKey(second.id))).toEqual(encodeEnvelope(second));
    const continued = action(A, 3n);
    // Sequence 3 cannot skip its forked causal predecessor; no native branch may
    // make this ready merely because its key sorts after the old branch.
    p.store.append(continued);
    expect(p.store.readReady().ready).toEqual([]);
  } finally {
    p.close();
  }
});

test('an unappended certified candidate is checked even when ready payloads do not change', () => {
  const p = open(),
    first = action(),
    second = action(A, 2n, [first]);
  try {
    p.store.append(first);
    const held = p.store.readReady();
    p.validate.retainReadyFacts(held.variants);
    const certify = p.validate(second, { dependencies: [first] });
    expect(certify && typeof certify === 'object' ? finish(certify) : certify).toBe(null);
    expect(p.validate.cacheDiagnostics().nativeBranch).toBe(true);
    const canonical = p.store.encodeUpdate();
    p.validate.retainReadyFacts(held.variants);
    expect(p.validate.cacheDiagnostics().nativeBranch).toBe(false);
    expect(p.store.encodeUpdate()).toEqual(canonical);
    p.store.append(second);
    const after = p.store.readReady();
    p.validate.retainReadyFacts(after.variants);
    expect(after.ready).toEqual([first, second]);
    expect(p.validate.cacheDiagnostics().nativeBranch).toBe(true);
  } finally {
    p.close();
  }
});

test('ordinary maps use a complete exact-byte compatibility check, including same-count replacements', () => {
  const p = open(),
    first = action(),
    second = action(A, 2n, [first]);
  try {
    p.store.append(first);
    p.store.append(second);
    const current = p.store.readReady();
    p.validate.retainReadyFacts(current.variants);
    const before = p.validate.cacheDiagnostics();
    const payloads = new Map(
      [first, second].map((entry) => [actionKey(entry.id), encodeEnvelope(entry)]),
    );
    p.validate.retainReadyFacts(payloads);
    expect(p.validate.cacheDiagnostics().retainedFactsCompared - before.retainedFactsCompared).toBe(
      2,
    );
    expect(p.validate.cacheDiagnostics().nativeBranch).toBe(true);
    payloads.set(
      actionKey(second.id),
      encodeEnvelope({ ...second, groupId: { ...second.groupId, sequence: 99n } }),
    );
    p.validate.retainReadyFacts(payloads);
    expect(p.validate.cacheDiagnostics().nativeBranch).toBe(false);
  } finally {
    p.close();
  }
});
