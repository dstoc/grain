import type {
  ActionEnvelope,
  Allocation,
  InlineProperties,
  InterpretationPacket,
  NativeTextRange,
  RunId,
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

/** Property-only updates cannot change raw placement, ownership or packet membership. */
export function isPropertyUpdate(action: ActionEnvelope): boolean {
  return (
    !action.allocations.length &&
    !action.nativeManifest.length &&
    !action.nativeInsertUpdates.length &&
    action.effects.length > 0 &&
    action.effects.every((effect) => effect.type === 'SetProperties')
  );
}

/** Complete snapshot selection. Reactivated packets keep their original priority. */
export function selectInterpretations(
  activity: Activity,
  initial: readonly { readonly node: NodeId; readonly values: Partial<PresentedProperties> }[] = [],
  validating?: EffectRef,
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
      for (const wrapper of [
        ...effect.packet.wrappers,
        ...(effect.packet.derivedInlineOutputs ?? []),
      ]) {
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
  if (validating) {
    const effect = activity.actions.find(
      (a) => a.id.actor === validating.action.actor && a.id.sequence === validating.action.sequence,
    )?.effects[validating.ordinal];
    if (effect?.type !== 'Interpret') throw new ProjectionError('Unknown validation packet');
    winners.set(resourceKey(effect.packet.source), { ref: validating, packet: effect.packet });
  }
  const selected = new Set([...winners.values()].map(({ ref }) => refKey(ref)));
  const packetIds = new Set([...winners.values()].map(({ packet }) => resourceKey(packet.id)));
  const members = new Map<string, string>();
  for (const action of activity.actions)
    for (const [ordinal, effect] of action.effects.entries())
      if (effect.type === 'Interpret')
        for (const member of effect.packet.effectOrdinals ?? [])
          members.set(
            refKey({ action: action.id, ordinal: member }),
            refKey({ action: action.id, ordinal }),
          );
  const effectEligible = (ref: EffectRef): boolean => {
    const packet = members.get(refKey(ref));
    return !packet || selected.has(packet);
  };
  const properties = new Map(
    initial.map(({ node, values }) => [resourceKey(node), { ...defaults, ...values }]),
  );
  for (const entry of activity.effects) {
    if (entry.effect.type === 'Interpret' && selected.has(refKey(entry))) {
      const packet = entry.effect.packet;
      const key = resourceKey(packet.source);
      properties.set(key, { ...defaults, ...properties.get(key), ...packet.properties });
    } else if (entry.effect.type === 'SetProperties' && effectEligible(entry)) {
      const key = resourceKey(entry.effect.node);
      properties.set(key, { ...defaults, ...properties.get(key), ...entry.effect.values });
    }
  }
  const packets = structuredClone([...winners.values()].map(({ packet }) => packet));
  const masks = packets.flatMap((packet) => packet.syntaxMask);
  return {
    packets,
    effectEligible,
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
  effectEligible(ref: EffectRef): boolean;
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

/** Validate explicit membership even when selection will hide the packet. */
export function validateMembership(
  action: ActionEnvelope,
  allocations: readonly Allocation[],
): void {
  if (!action.effects.some((effect) => effect.type === 'Interpret')) return;
  const byId = new Map(allocations.map((a) => [resourceKey(a.id), a]));
  const own = new Set(action.allocations.map((a) => resourceKey(a.id)));
  const outputs = new Set<string>(),
    members = new Set<number>();
  for (const [ordinal, effect] of action.effects.entries()) {
    if (effect.type !== 'Interpret') continue;
    const packet = effect.packet;
    const derived = packet.derivedInlineOutputs ?? [];
    let previous = -1;
    for (const id of derived) {
      const key = resourceKey(id),
        allocation = byId.get(key);
      if (
        id.ordinal <= previous ||
        !own.has(key) ||
        key === resourceKey(packet.source) ||
        allocation?.type !== 'node' ||
        allocation.role !== 'inline' ||
        outputs.has(key)
      )
        throw new ProjectionError('Invalid packet output birth');
      outputs.add(key);
      previous = id.ordinal;
    }
    const derivedKeys = new Set(derived.map(resourceKey));
    const wrapperKeys = new Set(packet.wrappers.map(resourceKey));
    const inlineKeys = new Set([resourceKey(packet.source), ...derivedKeys]);
    const inlineFlow = (runId: RunId) => {
      const run = byId.get(resourceKey(runId));
      if (run?.type !== 'run') return undefined;
      return allocations.find(
        (a) => a.type === 'node' && a.flow && resourceKey(a.flow) === resourceKey(run.flow),
      )?.id;
    };
    previous = ordinal;
    for (const index of packet.effectOrdinals ?? []) {
      if (
        !Number.isSafeInteger(index) ||
        index <= previous ||
        index >= action.effects.length ||
        members.has(index)
      )
        throw new ProjectionError('Invalid packet effect ordinal');
      previous = index;
      members.add(index);
      const member = action.effects[index];
      if (member.type === 'SplitFlow') {
        const source = inlineFlow(member.cut.run);
        if (
          !derivedKeys.has(resourceKey(member.newNode)) ||
          !source ||
          !inlineKeys.has(resourceKey(source)) ||
          (resourceKey(source) !== resourceKey(packet.source) &&
            source.ordinal >= member.newNode.ordinal)
        )
          throw new ProjectionError('Invalid packet split target');
      } else if (member.type === 'TransferRange') {
        const target = inlineFlow(member.destination.run);
        if (!target || !inlineKeys.has(resourceKey(target)))
          throw new ProjectionError('Invalid packet transfer target');
      } else if (member.type === 'SetProperties') {
        const key = resourceKey(member.node),
          target = byId.get(key);
        const allowed = derivedKeys.has(key)
          ? ['presentation', 'marker', 'info']
          : wrapperKeys.has(key) && target?.type === 'node'
            ? target.role === 'list-item'
              ? ['marker', 'checked']
              : ['marker']
            : [];
        const keys = Object.keys(member.values);
        if (!keys.length || keys.some((k) => !allowed.includes(k)))
          throw new ProjectionError('Invalid packet property member');
      } else throw new ProjectionError('Forbidden packet effect member');
    }
  }
}
