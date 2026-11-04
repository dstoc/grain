import type {
  Allocation,
  InlineProperties,
  InterpretationPacket,
  NativeTextRange,
  NodeId,
} from '../contracts.js';
import { resourceKey } from '../layout/index.js';
import { NativeValidationError } from '../text/identity.js';
import type { Activity, EffectRef } from '../visibility/index.js';

export class ProjectionError extends Error {}

export interface PresentedProperties extends InlineProperties {
  readonly checked: boolean | null;
}
const defaults: PresentedProperties = {
  presentation: 'paragraph',
  marker: null,
  info: null,
  checked: null,
};
const refKey = (ref: EffectRef) => `${ref.action.actor}:${ref.action.sequence}:${ref.ordinal}`;

/** Complete snapshot selection. Reactivated packets keep their original priority. */
export function selectInterpretations(
  activity: Activity,
  initial: readonly { readonly node: NodeId; readonly values: Partial<PresentedProperties> }[] = [],
): Interpretations {
  const winners = new Map<
    string,
    { readonly ref: EffectRef; readonly packet: InterpretationPacket }
  >();
  const wrapperPackets = new Map<string, Set<string>>();
  // Include inactive packets: their allocations remain, but are not ordinary active births.
  for (const action of activity.actions)
    for (const effect of action.effects) {
      if (effect.type !== 'Interpret') continue;
      for (const wrapper of effect.packet.wrappers) {
        const key = resourceKey(wrapper);
        const packets = wrapperPackets.get(key) ?? new Set<string>();
        packets.add(resourceKey(effect.packet.id));
        wrapperPackets.set(key, packets);
      }
    }
  for (const entry of activity.effects)
    if (entry.effect.type === 'Interpret')
      winners.set(resourceKey(entry.effect.packet.source), {
        ref: entry,
        packet: entry.effect.packet,
      });
  const selected = new Set([...winners.values()].map(({ ref }) => refKey(ref)));
  const packetIds = new Set([...winners.values()].map(({ packet }) => resourceKey(packet.id)));
  const properties = new Map(
    initial.map(({ node, values }) => [resourceKey(node), { ...defaults, ...values }]),
  );
  for (const entry of activity.effects) {
    if (entry.effect.type === 'Interpret' && selected.has(refKey(entry))) {
      const packet = entry.effect.packet;
      const key = resourceKey(packet.source);
      properties.set(key, { ...defaults, ...properties.get(key), ...packet.properties });
    } else if (entry.effect.type === 'SetProperties') {
      const key = resourceKey(entry.effect.node);
      properties.set(key, { ...defaults, ...properties.get(key), ...entry.effect.values });
    }
  }
  const packets = structuredClone([...winners.values()].map(({ packet }) => packet));
  const masks = packets.flatMap((packet) => packet.syntaxMask);
  return {
    packets,
    eligible(ref: EffectRef): boolean {
      return selected.has(refKey(ref));
    },
    birthEnabled(node: NodeId): boolean {
      const packets = wrapperPackets.get(resourceKey(node));
      return !packets || [...packets].some((packet) => packetIds.has(packet));
    },
    properties(node: NodeId): PresentedProperties {
      return { ...defaults, ...properties.get(resourceKey(node)) };
    },
    masks,
    masked(range: NativeTextRange): boolean {
      return masks.some((mask) => exactContains(mask, range));
    },
  };
}
export interface Interpretations {
  readonly packets: readonly InterpretationPacket[];
  readonly masks: readonly NativeTextRange[];
  eligible(ref: EffectRef): boolean;
  birthEnabled(node: NodeId): boolean;
  properties(node: NodeId): PresentedProperties;
  masked(range: NativeTextRange): boolean;
}

export function exactContains(outer: NativeTextRange, inner: NativeTextRange): boolean {
  return (
    resourceKey(outer.tape) === resourceKey(inner.tape) &&
    outer.client === inner.client &&
    inner.clock >= outer.clock &&
    inner.clock + inner.length <= outer.clock + outer.length
  );
}

/** Validate identities without consulting final ownership or substring matching. */
export function validatePacket(
  packet: InterpretationPacket,
  allocations: readonly Allocation[],
  read: (range: NativeTextRange) => string,
): void {
  const byId = new Map(allocations.map((allocation) => [resourceKey(allocation.id), allocation]));
  const source = byId.get(resourceKey(packet.source));
  if (source?.type !== 'node' || source.role !== 'inline')
    throw new ProjectionError('Interpretation source must be inline');
  if (byId.get(resourceKey(packet.id))?.type !== 'interpretation')
    throw new ProjectionError('Unknown interpretation identity');
  if (new Set(packet.wrappers.map(resourceKey)).size !== packet.wrappers.length)
    throw new ProjectionError('Duplicate wrapper');
  for (const wrapper of packet.wrappers) {
    const allocation = byId.get(resourceKey(wrapper));
    if (allocation?.type !== 'node' || !['list', 'list-item', 'quote'].includes(allocation.role))
      throw new ProjectionError('Interpretation wrapper must be a retained container');
  }
  function nativeText(range: NativeTextRange): string {
    try {
      return read(range);
    } catch (error) {
      if (error instanceof NativeValidationError) throw new ProjectionError(error.message);
      throw error;
    }
  }
  for (const range of [...packet.syntaxMask, ...packet.synthesizedText]) {
    if (
      !Number.isSafeInteger(range.length) ||
      range.length <= 0 ||
      nativeText(range).length !== range.length
    )
      throw new ProjectionError('Incomplete native interpretation range');
  }
}
