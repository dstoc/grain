import { compareEffects } from '../contracts.js';
import type { ActionEnvelope, InterpretationPacket, NodeId, TapeId } from '../contracts.js';
import type { Activity, EffectRef } from '../visibility/activity.js';
import type { Interpretations, PresentedProperties } from '../projection/interpretation.js';
import { presentedProperties } from '../projection/interpretation.js';
import { resourceKey } from '../layout/index.js';
import { countWork } from '../diagnostics.js';
import { PersistentMap, set, remove } from './map.js';
import type { MapRoot } from './map.js';
import { ExactSyntaxMasks } from './masks.js';
import { deletionEffectKey } from './subtree-deletions.js';

interface Contribution {
  readonly action: Pick<ActionEnvelope, 'id' | 'lamport'>;
  readonly ordinal: number;
  readonly effect: Extract<
    ActionEnvelope['effects'][number],
    { type: 'Interpret' | 'SetProperties' }
  >;
  readonly active: boolean;
}
interface Winner {
  readonly winner: Contribution & {
    readonly effect: Extract<Contribution['effect'], { type: 'Interpret' }>;
  };
  /** First active source declaration determines full-export source order. */
  readonly first: Contribution;
}
const ref = (entry: Contribution): EffectRef => ({
  action: entry.action.id,
  ordinal: entry.ordinal,
});
const nodeOf = (entry: Contribution) =>
  entry.effect.type === 'Interpret' ? entry.effect.packet.source : entry.effect.node;
const propertyOrder = (entry: Contribution) =>
  `${entry.action.lamport.toString().padStart(20, '0')}:${entry.action.id.actor}:${entry.action.id.sequence.toString().padStart(20, '0')}:${entry.ordinal.toString().padStart(16, '0')}`;
const fieldNames = ['presentation', 'marker', 'info', 'checked'] as const;
const fieldValues = (entry: Contribution) =>
  entry.effect.type === 'Interpret' ? entry.effect.packet.properties : entry.effect.values;
const enabledProperty = (
  entry: Contribution,
  selected: PersistentMap<true>,
  members: PersistentMap<string>,
) => {
  const id = deletionEffectKey(ref(entry));
  return (
    entry.active &&
    (entry.effect.type === 'Interpret'
      ? selected.has(id)
      : !members.has(id) || selected.has(members.get(id)!))
  );
};
/** A publication facade captures current roots only. Complete exports are lazy,
 * explicit and charged; property, membership and mask queries do not export. */
function selection(
  winners: PersistentMap<Winner>,
  selected: PersistentMap<true>,
  packetIds: PersistentMap<number>,
  members: PersistentMap<string>,
  wrappers: PersistentMap<readonly string[]>,
  properties: PersistentMap<PresentedProperties>,
  masks: ExactSyntaxMasks,
  effects: PersistentMap<Contribution>,
): Interpretations {
  let packets: readonly InterpretationPacket[] | undefined;
  const allPackets = () => {
    if (!packets) {
      countWork('interpretation.sourcesExported', winners.size);
      packets = structuredClone(
        [...winners.values()]
          .sort((a, b) => compareEffects(a.first, b.first))
          .map((entry) => entry.winner.effect.packet),
      );
    }
    return packets;
  };
  return {
    get packets() {
      return allPackets();
    },
    get masks() {
      return allPackets().flatMap((p) => p.syntaxMask);
    },
    eligible: (ref) => selected.has(deletionEffectKey(ref)),
    effectEligible: (ref) => {
      const packet = members.get(deletionEffectKey(ref));
      return !packet || selected.has(packet);
    },
    birthEnabled: (node) => {
      const packets = wrappers.get(resourceKey(node));
      return (
        !packets?.length ||
        packets.some((id) => {
          countWork('interpretation.birthPacketEdgesVisited');
          const entry = effects.get(id);
          return (
            entry?.effect.type === 'Interpret' &&
            (packetIds.get(resourceKey(entry.effect.packet.id)) ?? 0) > 0
          );
        })
      );
    },
    properties: (node) => presentedProperties(properties.get(resourceKey(node))),
    masked: (range) => masks.masked(range),
  };
}
/** Retains losing/dormant packets, explicit member eligibility and per-node
 * ordered property contributions. Updating one source never scans other sources
 * or retained actions. Canonical validation belongs to the existing author path.
 */
export class MaterializedInterpretations {
  private constructor(
    private readonly effects = new PersistentMap<Contribution>(),
    private readonly byNode = new PersistentMap<MapRoot<Contribution> | undefined>(),
    private readonly wrappers = new PersistentMap<readonly string[]>(),
    private readonly packetDeclarations = new PersistentMap<readonly string[]>(),
    private readonly members = new PersistentMap<string>(),
    private readonly winners = new PersistentMap<Winner>(),
    private readonly selected = new PersistentMap<true>(),
    private readonly packetIds = new PersistentMap<number>(),
    private readonly initial = new PersistentMap<PresentedProperties>(),
    private readonly properties = new PersistentMap<PresentedProperties>(),
    private readonly fields = new PersistentMap<MapRoot<unknown> | undefined>(),
    readonly masks = ExactSyntaxMasks.create([]),
  ) {}
  static create(
    actions: Iterable<ActionEnvelope>,
    activity: Activity,
    initial: readonly {
      readonly node: NodeId;
      readonly values: Partial<PresentedProperties>;
    }[] = [],
  ): MaterializedInterpretations {
    countWork('interpretation.fullIndexesConstructed');
    const base = new MaterializedInterpretations();
    for (const { node, values } of initial) {
      base.initial.set(resourceKey(node), presentedProperties(values));
      base.properties.set(resourceKey(node), presentedProperties(values));
    }
    return base.update(actions, activity).index;
  }
  update(
    actions: Iterable<ActionEnvelope>,
    activity: Activity,
    withdrawn: readonly EffectRef[] = [],
  ) {
    const effects = this.effects.fork(),
      byNode = this.byNode.fork(),
      wrappers = this.wrappers.fork(),
      packetDeclarations = this.packetDeclarations.fork(),
      changedPacketIds = new Set<string>(),
      members = this.members.fork(),
      winners = this.winners.fork(),
      selected = this.selected.fork(),
      packetIds = this.packetIds.fork(),
      properties = this.properties.fork(),
      fields = this.fields.fork(),
      propertyRefs = new Set<string>(),
      changedNodes = new Map<string, NodeId>(),
      sources = new Set<string>(),
      changedBirths = new Map<string, NodeId>(),
      eligibility = new Map<string, EffectRef>();
    const replace = (id: string, after?: Contribution) => {
      const before = effects.get(id);
      if (
        before &&
        after &&
        before.effect === after.effect &&
        before.active === after.active &&
        before.action.lamport === after.action.lamport
      )
        return;
      for (const [entry, adding] of [
        [before, false],
        [after, true],
      ] as const) {
        if (!entry) continue;
        const node = nodeOf(entry),
          key = resourceKey(node);
        changedNodes.set(key, node);
        propertyRefs.add(id);
        if (entry.effect.type !== 'Interpret') continue;
        if (entry.active)
          byNode.set(
            key,
            adding
              ? set(byNode.get(key), propertyOrder(entry), entry)
              : remove(byNode.get(key), propertyOrder(entry)),
          );
        sources.add(key);
        const packet = entry.effect.packet,
          packetKey = resourceKey(packet.id),
          declarations = packetDeclarations.get(packetKey) ?? [];
        packetDeclarations.set(
          packetKey,
          adding ? [...declarations, id] : declarations.filter((ref) => ref !== id),
        );
        for (const member of packet.effectOrdinals ?? []) {
          const ref = { action: entry.action.id, ordinal: member },
            key = deletionEffectKey(ref);
          if (adding) members.set(key, id);
          else members.delete(key);
          eligibility.set(key, ref);
        }
        for (const node of [...packet.wrappers, ...(packet.derivedInlineOutputs ?? [])]) {
          const key = resourceKey(node),
            prior = wrappers.get(key) ?? [];
          // Store declaration refs, then map them to packet IDs below. Distinct
          // declarations can name the same retained interpretation identity.
          wrappers.set(key, adding ? [...prior, id] : prior.filter((value) => value !== id));
          changedBirths.set(key, node);
        }
      }
      if (after) effects.set(id, after);
      else effects.delete(id);
      countWork('interpretation.contributionsChanged');
    };
    for (const value of withdrawn) replace(deletionEffectKey(value));
    for (const action of actions)
      for (const [ordinal, effect] of action.effects.entries()) {
        countWork('interpretation.changedEffectsInspected');
        if (effect.type === 'Interpret' || effect.type === 'SetProperties') {
          const value = { action: action.id, ordinal };
          replace(deletionEffectKey(value), {
            action: { id: action.id, lamport: action.lamport },
            ordinal,
            effect,
            active: activity.isEffectActive(value),
          });
        }
      }
    const maskChanges: Parameters<ExactSyntaxMasks['update']>[0][number][] = [],
      tapes = new Map<string, TapeId>();
    for (const source of sources) {
      const before = winners.get(source),
        root = byNode.get(source);
      let first = root,
        last = root;
      while (first?.left) {
        first = first.left;
        countWork('interpretation.sourceCandidateNodesRead');
      }
      while (last?.right) {
        last = last.right;
        countWork('interpretation.sourceCandidateNodesRead');
      }
      const winner = last?.value,
        after =
          winner?.effect.type === 'Interpret'
            ? { winner: { ...winner, effect: winner.effect }, first: first!.value }
            : undefined;
      const beforeId = before && deletionEffectKey(ref(before.winner)),
        afterId = after && deletionEffectKey(ref(after.winner));
      for (const [entry, adding] of [
        [before, false],
        [after, true],
      ] as const) {
        if (!entry) continue;
        const winner = entry.winner,
          id = deletionEffectKey(ref(winner)),
          packet = winner.effect.packet,
          packetKey = resourceKey(packet.id);
        propertyRefs.add(id);
        if (adding) selected.set(id, true);
        else selected.delete(id);
        packetIds.set(packetKey, (packetIds.get(packetKey) ?? 0) + (adding ? 1 : -1));
        changedPacketIds.add(packetKey);
        if (beforeId !== afterId || before?.winner.effect !== after?.winner.effect) {
          maskChanges.push({ packet: id, ...(adding ? { ranges: packet.syntaxMask } : {}) });
          for (const range of packet.syntaxMask) tapes.set(resourceKey(range.tape), range.tape);
        }
        for (const ordinal of packet.effectOrdinals ?? []) {
          const value = { action: winner.action.id, ordinal };
          eligibility.set(deletionEffectKey(value), value);
        }
        for (const node of [...packet.wrappers, ...(packet.derivedInlineOutputs ?? [])])
          changedBirths.set(resourceKey(node), node);
      }
      if (after) winners.set(source, after);
      else winners.delete(source);
      countWork('interpretation.sourcesUpdated');
    }
    for (const packet of changedPacketIds) {
      if ((this.packetIds.get(packet) ?? 0) > 0 === (packetIds.get(packet) ?? 0) > 0) continue;
      for (const id of packetDeclarations.get(packet) ?? []) {
        const entry = effects.get(id);
        if (entry?.effect.type !== 'Interpret') continue;
        for (const node of [
          ...entry.effect.packet.wrappers,
          ...(entry.effect.packet.derivedInlineOutputs ?? []),
        ])
          changedBirths.set(resourceKey(node), node);
        countWork('interpretation.birthPacketEdgesVisited');
      }
    }
    for (const [id] of eligibility) propertyRefs.add(id);
    for (const id of propertyRefs) {
      for (const [entry, adding] of [
        [this.effects.get(id), false],
        [effects.get(id), true],
      ] as const) {
        if (!entry) continue;
        const node = nodeOf(entry),
          nodeKey = resourceKey(node);
        changedNodes.set(nodeKey, node);
        if (
          !enabledProperty(
            entry,
            adding ? selected : this.selected,
            adding ? members : this.members,
          )
        )
          continue;
        for (const [field, value] of Object.entries(fieldValues(entry))) {
          const key = `${nodeKey}|${field}`,
            order = propertyOrder(entry);
          fields.set(
            key,
            adding ? set(fields.get(key), order, value) : remove(fields.get(key), order),
          );
          countWork('interpretation.propertyContributionsInspected');
        }
      }
    }
    for (const [key] of changedNodes) {
      const values = { ...(this.initial.get(key) ?? presentedProperties()) };
      for (const field of fieldNames) {
        let root = fields.get(`${key}|${field}`);
        if (!root) continue;
        while (root.right) {
          root = root.right;
          countWork('interpretation.propertyOrderNodesRead');
        }
        Object.assign(values, { [field]: root.value });
      }
      properties.set(key, values);
    }
    const masks = this.masks.update(maskChanges);
    const index = new MaterializedInterpretations(
      effects,
      byNode,
      wrappers,
      packetDeclarations,
      members,
      winners,
      selected,
      packetIds,
      this.initial,
      properties,
      fields,
      masks,
    );
    return {
      index,
      nodes: [...changedNodes.values()],
      births: [...changedBirths.values()],
      eligibility: [...eligibility.values()],
      tapes: [...tapes.values()],
    };
  }
  value(): Interpretations {
    return selection(
      this.winners,
      this.selected,
      this.packetIds,
      this.members,
      this.wrappers,
      this.properties,
      this.masks,
      this.effects,
    );
  }
}
