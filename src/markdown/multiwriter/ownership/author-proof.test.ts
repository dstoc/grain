import { expect, test } from 'vitest';
import type { IndexedValidation } from '../actions/validation.js';
import { action } from '../actions/test-fixtures.js';
import { commandGenesis } from '../../../../test/multiwriter/commands/replica.js';
import { NativeTapeCache } from '../text/cache.js';
import { nativeView } from '../ingest/publication.js';
import { reduceActivity } from '../visibility/activity.js';
import {
  openLocalAuthorAttempt,
  bindAuthorNative,
  localAuthorBase,
  bindAuthorPublication,
  completeAuthorProof,
  consumeAuthorProof,
  discardAuthorProof,
} from './author-proof.js';
import type { AuthorProof, AuthorProofRequest } from './author-proof.js';

function fixture() {
  const genesis = commandGenesis(),
    candidate = action(),
    cache = new NativeTapeCache();
  cache.apply('genesis', genesis.body);
  const indexed: IndexedValidation = {
    past: {
      identity: {},
      contains: () => false,
      allocation: () => undefined,
      groupSealed: () => false,
    },
    resultIdentity: {},
    dependencies: [{}, {}],
  };
  let current = true;
  const assertCurrent = () => {
    if (!current) throw new Error('stale generation');
  };
  const base = {
    owner: {},
    version: 0,
    generation: 0,
    ready: [],
    payloads: { get: () => undefined },
    assertCurrent,
  };
  const close = openLocalAuthorAttempt(indexed, candidate, base),
    native = nativeView(cache);
  const request: AuthorProofRequest = {
    invocation: {},
    indexed,
    action: candidate,
    native,
    input: { genesis: genesis.layout, actions: [], snapshots: [], isActive: () => true },
    activity: reduceActivity([]),
  };
  const bindings = {
    genesis: {},
    ready: {},
    native: {},
    checkpoint: {},
    projection: {},
    revision: 0,
    ownershipRevision: 0,
  };
  const bind = () => {
    bindAuthorNative(indexed, candidate, native);
    bindAuthorPublication(request, bindings, assertCurrent);
  };
  const mint = () =>
    completeAuthorProof(request, bindings, {
      ordinals: candidate.effects.length,
      replayFrom: 0,
      replayTo: 1,
      refinement: [],
    });
  return {
    indexed,
    request,
    bindings,
    bind,
    mint,
    invalidate: () => {
      current = false;
    },
    close,
    destroy: () => {
      close();
      cache.destroy();
    },
  };
}

test('only a validated native attempt can request proof; completed proof is single use', () => {
  const p = fixture();
  try {
    expect(() => localAuthorBase(p.request)).toThrow('native attempt');
    p.bind();
    const proof = p.mint();
    consumeAuthorProof(p.request, proof);
    expect(() => consumeAuthorProof(p.request, proof)).toThrow('Invalid or expired');
    expect(() => consumeAuthorProof(p.request, {} as AuthorProof)).toThrow('Invalid or expired');
  } finally {
    p.destroy();
  }
});
for (const mutation of [
  'body',
  'past',
  'dependency-token',
  'native',
  'invocation',
  'closed',
  'stale',
  'publication',
  'partial',
] as const)
  test(`detached proof cannot survive a changed ${mutation} binding`, () => {
    const p = fixture();
    try {
      p.bind();
      const proof = p.mint();
      let request = p.request;
      if (mutation === 'body')
        request = {
          ...request,
          action: { ...request.action, groupId: { ...request.action.groupId, sequence: 99n } },
        };
      if (mutation === 'past') (p.indexed.past as { identity: object }).identity = {};
      if (mutation === 'dependency-token') (p.indexed.dependencies as object[])[0] = {};
      if (mutation === 'native') request = { ...request, native: { ...request.native } };
      if (mutation === 'invocation') request = { ...request, invocation: {} };
      if (mutation === 'closed') p.close();
      if (mutation === 'stale') p.invalidate();
      if (mutation === 'publication')
        bindAuthorPublication(request, { ...p.bindings, genesis: {} }, () => {});
      if (mutation === 'partial') {
        expect(() =>
          completeAuthorProof(request, p.bindings, {
            ordinals: -1,
            replayFrom: 0,
            replayTo: 1,
            refinement: [],
          }),
        ).toThrow('partial');
        discardAuthorProof(proof);
      }
      expect(() => consumeAuthorProof(request, proof)).toThrow();
    } finally {
      p.destroy();
    }
  });

test('equal IDs and bytes in another indexed context/store do not confer local proof authority', () => {
  const p = fixture(),
    other = fixture();
  try {
    p.bind();
    other.bind();
    const proof = p.mint();
    expect(() => consumeAuthorProof(other.request, proof)).toThrow('Invalid or expired');
    expect(localAuthorBase({ ...p.request, indexed: { ...p.indexed } })).toBeUndefined();
    expect(localAuthorBase({ ...p.request, indexed: undefined })).toBeUndefined();
  } finally {
    p.destroy();
    other.destroy();
  }
});
