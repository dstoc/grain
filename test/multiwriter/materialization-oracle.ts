import { expect } from 'vitest';
import { equal } from './equal.js';
import type { ReferenceFactoryOptions } from './reference/factory.js';
import { openReferenceDocument } from '../../src/markdown/multiwriter/reference/document.js';
import { compareBytes } from '../../src/markdown/multiwriter/actions/cbor.js';

type Check = NonNullable<ReferenceFactoryOptions['onPublication']>;

/** Independent full-reference readiness/native/projection for every publication.
 * Reuse only the reference implementation's exact immutable certification cache.
 * Native cache, provenance, ownership and semantic projection are rebuilt each time.
 * New candidate instances (including checkpoint/replay opens) get a cold oracle.
 */
export function createMaterializationOracle() {
  const oracles = new Map<Parameters<Check>[0], ReturnType<typeof openReferenceDocument>>();
  const check: Check = (document, genesis) => {
    const bytes = document.store.encodeUpdate();
    let oracle = oracles.get(document);
    if (!oracle) {
      oracle = openReferenceDocument(genesis);
      oracles.set(document, oracle);
    }
    // Preserve the original carrier identities, including pending outer structs.
    // The oracle already holds earlier prefixes; avoid rescanning their transport
    // bytes. Exact complete carrier equality below verifies this optimization.
    oracle.store.applyUpdate(document.store.encodeUpdate(oracle.store.encodeStateVector()));
    expect(compareBytes(oracle.store.encodeUpdate(), bytes)).toBe(0);
    let result = oracle.publication.refresh();
    while (result.state === 'deferred')
      result = result.continuation.resume(Number.MAX_SAFE_INTEGER);
    const actual = document.publication.status().publication!;
    const expected = result.value;
    equal(document.store.snapshot(), oracle.store.snapshot());
    equal(actual.heads, expected.heads);
    equal(actual.value.view, expected.value.view);
    equal(actual.value.visibility, expected.value.visibility);
    equal(actual.value.activity.actions, expected.value.activity.actions);
    equal(actual.value.activity.effects, expected.value.activity.effects);
    equal(actual.value.interpretations.packets, expected.value.interpretations.packets);
    equal(actual.value.interpretations.masks, expected.value.interpretations.masks);
    const o = actual.value.ownership,
      e = expected.value.ownership;
    equal(o.assignments, e.assignments);
    equal(o.buckets, e.buckets);
    equal(o.homeBindings, e.homeBindings);
    equal(o.flowPlacements, e.flowPlacements);
    equal(o.runLayouts, e.runLayouts);
    equal(o.destinationRequirements, e.destinationRequirements);
    equal(o.nodeAllocations, e.nodeAllocations);
    for (const node of o.nodeAllocations) {
      equal(o.blockPlacement(node.id), e.blockPlacement(node.id));
      equal(o.children(node.id), e.children(node.id));
      equal(
        actual.value.interpretations.properties(node.id),
        expected.value.interpretations.properties(node.id),
      );
      if (node.flow) equal(o.raw(node.flow), e.raw(node.flow));
    }
    expect(compareBytes(actual.native.encodeState(), expected.native.encodeState())).toBe(0);
    expect(compareBytes(document.store.encodeUpdate(), bytes)).toBe(0);
  };
  return {
    check,
    destroy() {
      for (const oracle of oracles.values()) oracle.destroy();
      oracles.clear();
    },
  };
}
