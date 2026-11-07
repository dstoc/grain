import { expect, test } from 'vitest';
import { A, B, C, action } from '../actions/test-fixtures.js';
import { commandGenesis } from '../../../../test/multiwriter/commands/replica.js';
import { IndexedActionStore } from './readiness.js';
import { bindAuthorNative, localAuthorBase } from '../ownership/author-proof.js';
import type { AuthorProofRequest } from '../ownership/author-proof.js';
import type { NativeView } from '../ingest/publication.js';
import { reduceActivity } from '../visibility/activity.js';

function fixture() {
  const genesis = commandGenesis(),
    seen: { local: boolean; request: AuthorProofRequest }[] = [];
  let callback: (() => void) | undefined;
  const native = {} as NativeView;
  const store = new IndexedActionStore({
    documentId: 'D',
    genesisId: 'G',
    genesisAllocations: genesis.layout.allocations,
    validate(candidate, context) {
      bindAuthorNative(context.indexed, candidate, native);
      const request: AuthorProofRequest = {
        action: candidate,
        invocation: {},
        indexed: context.indexed,
        native,
        input: { genesis: genesis.layout, actions: [], snapshots: [], isActive: () => true },
        activity: reduceActivity([]),
      };
      seen.push({ local: !!localAuthorBase(request), request });
      callback?.();
      return null;
    },
  });
  return {
    store,
    seen,
    setCallback: (fn?: () => void) => {
      callback = fn;
    },
  };
}
for (const mode of ['missing-head', 'complete', 'redundant'] as const)
  test(`local author eligibility requires the complete ready heads: ${mode}`, () => {
    const p = fixture(),
      first = action(A),
      next = action(A, 2n, [first]),
      peer = action(B);
    try {
      for (const a of [first, next, peer]) p.store.append(a);
      p.store.readReady();
      expect(p.seen.every((entry) => !entry.local)).toBe(true);
      p.seen.length = 0;
      const dependencies =
        mode === 'missing-head' ? [next] : mode === 'complete' ? [next, peer] : [first, next, peer];
      expect(p.store.checkLocal(action(C, 1n, dependencies))).toBe(null);
      expect(p.seen.map((entry) => entry.local)).toEqual([mode !== 'missing-head']);
      expect(localAuthorBase(p.seen[0].request)).toBeUndefined();
    } finally {
      p.store.destroy();
    }
  });

test('reentrant facts invalidate the attempt before a local certificate is staged', () => {
  const p = fixture(),
    candidate = action(A),
    peer = action(B);
  try {
    p.setCallback(() => {
      p.setCallback();
      p.store.append(peer);
    });
    expect(() => p.store.checkLocal(candidate)).toThrow('invalidated');
    expect(p.store.cacheDiagnostics().stagedCertificates).toBe(0);
    expect(localAuthorBase(p.seen[0].request)).toBeUndefined();
    expect(p.store.readReady().ready).toEqual([peer]);
  } finally {
    p.store.destroy();
  }
});
