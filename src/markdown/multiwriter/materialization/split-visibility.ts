import type { ActionEnvelope, NodeId } from '../contracts.js';
import type { OwnershipResult } from '../ownership/ownership.js';
import type { Activity, EffectRef } from '../visibility/activity.js';
import { resourceKey } from '../layout/index.js';
import { countWork } from '../diagnostics.js';
import { PersistentMap } from './map.js';
import { deletionEffectKey, SubtreeDeletions } from './subtree-deletions.js';

interface Split {
  readonly ref: EffectRef;
  readonly source: NodeId;
  readonly output: NodeId;
}
/** Weak split derivation is separate from deletion and raw ownership. Retained
 * source readers let tag/placement changes revisit the dependent splits only. */
export class SplitVisibility {
  private constructor(
    private readonly effects = new PersistentMap<Split>(),
    private readonly sources = new PersistentMap<readonly string[]>(),
    private readonly hiddenNodes = new PersistentMap<true>(),
    private readonly hiddenEffects = new PersistentMap<true>(),
  ) {}
  static create(
    actions: Iterable<ActionEnvelope>,
    ownership: OwnershipResult,
    homes: { get(id: string): NodeId | undefined },
    activity: Activity,
    coverage: SubtreeDeletions,
  ): SplitVisibility {
    countWork('splitVisibility.fullIndexesConstructed');
    return new SplitVisibility().update(actions, [], ownership, homes, activity, coverage).index;
  }
  update(
    actions: Iterable<ActionEnvelope>,
    changedSources: Iterable<NodeId>,
    ownership: OwnershipResult,
    homes: { get(id: string): NodeId | undefined },
    activity: Activity,
    coverage: SubtreeDeletions,
  ) {
    const effects = this.effects.fork(),
      sources = this.sources.fork(),
      hiddenNodes = this.hiddenNodes.fork(),
      hiddenEffects = this.hiddenEffects.fork(),
      dirty = new Set<string>();
    for (const source of changedSources)
      for (const id of sources.get(resourceKey(source)) ?? []) dirty.add(id);
    for (const action of actions)
      for (const [ordinal, effect] of action.effects.entries()) {
        countWork('splitVisibility.changedEffectsInspected');
        if (effect.type !== 'SplitFlow') continue;
        const ref = { action: action.id, ordinal },
          id = deletionEffectKey(ref),
          source = homes.get(resourceKey(ownership.runLayout(effect.cut.run).flow));
        if (!source) throw new Error('Split source lacks a retained home');
        const before = effects.get(id);
        if (before && resourceKey(before.source) !== resourceKey(source))
          throw new Error('Split source identity changed');
        if (!before)
          sources.set(resourceKey(source), [...(sources.get(resourceKey(source)) ?? []), id]);
        effects.set(id, { ref, source, output: effect.newNode });
        dirty.add(id);
      }
    const nodes = new Map<string, NodeId>(),
      changedEffects: EffectRef[] = [];
    for (const id of dirty) {
      const split = effects.get(id)!,
        hidden =
          activity.isEffectActive(split.ref) &&
          coverage.hidesSplit(
            split.source,
            split.ref.action,
            (node) => ownership.blockPlacement(node)?.slot.parent ?? null,
            activity,
          );
      countWork('splitVisibility.readersChecked');
      if (hidden === hiddenEffects.has(id)) continue;
      if (hidden) {
        hiddenEffects.set(id, true);
        hiddenNodes.set(resourceKey(split.output), true);
      } else {
        hiddenEffects.delete(id);
        hiddenNodes.delete(resourceKey(split.output));
      }
      nodes.set(resourceKey(split.output), split.output);
      changedEffects.push(split.ref);
    }
    return {
      index: new SplitVisibility(effects, sources, hiddenNodes, hiddenEffects),
      nodes: [...nodes.values()],
      effects: changedEffects,
    };
  }
  hidden(node: NodeId): boolean {
    return this.hiddenNodes.has(resourceKey(node));
  }
  permits(ref: EffectRef): boolean {
    return !this.hiddenEffects.has(deletionEffectKey(ref));
  }
}
