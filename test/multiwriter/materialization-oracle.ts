import { expect } from 'vitest';
import type { ReferenceFactoryOptions } from './reference/factory.js';
import { openReferenceDocument } from '../../src/markdown/multiwriter/reference/document.js';
import { compareBytes } from '../../src/markdown/multiwriter/actions/cbor.js';

export const checkMaterializedPublication: NonNullable<ReferenceFactoryOptions['onPublication']> = (
  document,
  genesis,
) => {
  const bytes = document.store.encodeUpdate();
  const oracle = openReferenceDocument(genesis);
  try {
    oracle.store.applyUpdate(bytes);
    let result = oracle.publication.refresh();
    while (result.state === 'deferred')
      result = result.continuation.resume(Number.MAX_SAFE_INTEGER);
    const actual = document.publication.status().publication!;
    const expected = result.value;
    expect(document.store.snapshot()).toEqual(oracle.store.snapshot());
    expect(actual.heads).toEqual(expected.heads);
    expect(actual.value.view).toEqual(expected.value.view);
    expect(actual.value.visibility).toEqual(expected.value.visibility);
    expect(actual.value.activity.actions).toEqual(expected.value.activity.actions);
    expect(actual.value.activity.effects).toEqual(expected.value.activity.effects);
    expect(actual.value.interpretations.packets).toEqual(expected.value.interpretations.packets);
    expect(actual.value.interpretations.masks).toEqual(expected.value.interpretations.masks);
    const o = actual.value.ownership,
      e = expected.value.ownership;
    expect(o.assignments).toEqual(e.assignments);
    expect(o.buckets).toEqual(e.buckets);
    expect(o.homeBindings).toEqual(e.homeBindings);
    expect(o.flowPlacements).toEqual(e.flowPlacements);
    expect(o.runLayouts).toEqual(e.runLayouts);
    expect(o.destinationRequirements).toEqual(e.destinationRequirements);
    expect(o.nodeAllocations).toEqual(e.nodeAllocations);
    for (const node of o.nodeAllocations) {
      expect(o.blockPlacement(node.id)).toEqual(e.blockPlacement(node.id));
      expect(o.children(node.id)).toEqual(e.children(node.id));
      expect(actual.value.interpretations.properties(node.id)).toEqual(
        expected.value.interpretations.properties(node.id),
      );
      if (node.flow) expect(o.raw(node.flow)).toEqual(e.raw(node.flow));
    }
    expect(compareBytes(actual.native.encodeState(), expected.native.encodeState())).toBe(0);
    expect(compareBytes(document.store.encodeUpdate(), bytes)).toBe(0);
  } finally {
    oracle.destroy();
  }
};
