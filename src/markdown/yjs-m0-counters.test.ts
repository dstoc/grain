import { afterEach, describe, expect, it } from 'vitest';
import type * as Y from 'yjs';

import { measureNativeOperations } from '../../benchmarks/yjs-m0/counters.js';
import { CanonicalDocument, canonicalWriterAccess } from './canonical-model.js';

let document: CanonicalDocument | undefined;

afterEach(() => {
  document?.close();
  document = undefined;
});

function createDocument(): CanonicalDocument {
  return CanonicalDocument.fromMarkdown('counter control', {
    documentId: 'yjs-m0-counter-control',
    authorityEpoch: 'yjs-m0-counter-control',
    actionId: 'yjs-m0-counter-control-import',
    makeId: (role, ordinal) => `yjs-m0-counter-control-${role}-${ordinal}`,
  });
}

describe('Yjs M0 native operation counters', () => {
  it('counts known delete-set clients and ranges from Map-backed Yjs data', () => {
    document = createDocument();
    const state = canonicalWriterAccess(document).state;
    const probe = state.getMap('m0-counter-delete-control');
    state.transact(() => probe.set('known', 'value'), 'seed');

    const measured = measureNativeOperations(document, () => probe.delete('known'));

    expect(measured.counts.mapDeletes).toBe(1);
    expect(measured.counts.deleteSetClients).toBe(1);
    expect(measured.counts.deleteSetRanges).toBe(1);
  });

  it('reports public Doc.transact calls and preserves distinct object origins', () => {
    document = createDocument();
    const state: Y.Doc = canonicalWriterAccess(document).state;
    const firstOrigin = { label: 'same display value' };
    const secondOrigin = { label: 'same display value' };

    const measured = measureNativeOperations(document, () => {
      state.transact(() => {}, firstOrigin);
      state.transact(() => {}, secondOrigin);
    });

    expect(measured.counts.publicDocTransactCalls).toBe(2);
    expect(measured.counts.publicDocTransactCallsByOrigin).toEqual({
      'object#1': 1,
      'object#2': 1,
    });
  });
});
