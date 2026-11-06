import { compareEffects } from '../contracts.js';
import type {
  ActionEnvelope,
  ActionId,
  DeletionId,
  NodeId,
  RangeRef,
  TapeId,
} from '../contracts.js';
import type { BirthContent } from '../projection/types.js';
import type { Activity, EffectRef } from '../visibility/activity.js';
import type { TextToken, VisibilityNode } from '../visibility/visibility.js';
import { resourceKey } from '../layout/index.js';
import { countWork } from '../diagnostics.js';
import { PersistentMap } from './map.js';

export const deletionEffectKey = (ref: EffectRef) =>
  `${ref.action.actor}:${ref.action.sequence}:${ref.ordinal}`;
interface Declaration {
  readonly action: Pick<ActionEnvelope, 'id' | 'lamport'>;
  readonly ordinal: number;
  readonly effect: Extract<ActionEnvelope['effects'][number], { type: 'DeleteSubtree' }>;
  readonly active: boolean;
  readonly covered: readonly string[];
  readonly inherited: readonly string[];
}
interface Group {
  readonly declarations: readonly Declaration[];
  readonly inherited: readonly RangeRef[];
  readonly tapes: readonly TapeId[];
}
export interface SubtreeMatch {
  readonly action: Pick<ActionEnvelope, 'id' | 'lamport'>;
  readonly ordinal: number;
  readonly tag: DeletionId;
}
/** Captured coverage stays independent of placement. Birth edges and reverse
 * contributions include dormant declarations, so new concurrent births and
 * controls can invalidate only their own tag groups. No native/activity reader
 * or previous index wrapper escapes preparation.
 */
export class SubtreeDeletions {
  private constructor(
    private readonly nodes = new PersistentMap<VisibilityNode>(),
    private readonly children = new PersistentMap<readonly string[]>(),
    private readonly birthContent = new PersistentMap<readonly RangeRef[]>(),
    private readonly declarations = new PersistentMap<Declaration>(),
    private readonly coveredBy = new PersistentMap<readonly string[]>(),
    private readonly groups = new PersistentMap<Group>(),
    private readonly tapeGroups = new PersistentMap<readonly string[]>(),
  ) {}
  static create(
    actions: Iterable<ActionEnvelope>,
    nodes: Iterable<VisibilityNode>,
    birthContent: readonly BirthContent[],
    activity: Activity,
  ): SubtreeDeletions {
    countWork('subtree.fullIndexesConstructed');
    return new SubtreeDeletions().update(actions, nodes, birthContent, activity).index;
  }
  update(
    actions: Iterable<ActionEnvelope>,
    additions: Iterable<VisibilityNode>,
    content: readonly BirthContent[],
    activity: Activity,
    withdrawn: readonly EffectRef[] = [],
  ) {
    const nodes = this.nodes.fork(),
      children = this.children.fork(),
      birthContent = this.birthContent.fork(),
      declarations = this.declarations.fork(),
      coveredBy = this.coveredBy.fork(),
      groups = this.groups.fork(),
      tapeGroups = this.tapeGroups.fork();
    const dirty = new Set<string>(),
      tags = new Set<string>(),
      affectedNodes = new Set<string>(),
      tapes = new Map<string, TapeId>();
    for (const entry of content) {
      const id = resourceKey(entry.node);
      if (birthContent.has(id)) throw new Error('Birth coverage is immutable');
      birthContent.set(id, entry.intervals);
    }
    for (const node of additions) {
      const id = resourceKey(node.id);
      if (nodes.has(id)) throw new Error('Duplicate visibility birth');
      if (!birthContent.has(id)) throw new Error('Missing birth-causal visibility coverage');
      nodes.set(id, node);
      if (node.birthSlot) {
        const parent = resourceKey(node.birthSlot.parent);
        children.set(parent, [...(children.get(parent) ?? []), id]);
        // Direct parent coverage is enough to find every declaration which can
        // inherit this new birth. Recompute after all same-action births exist.
        for (const declaration of coveredBy.get(parent) ?? []) dirty.add(declaration);
      }
      countWork('subtree.birthsIndexed');
    }
    const replace = (id: string, after?: Declaration) => {
      const before = declarations.get(id);
      for (const [entry, adding] of [
        [before, false],
        [after, true],
      ] as const) {
        if (!entry) continue;
        tags.add(resourceKey(entry.effect.tag));
        for (const node of entry.covered) {
          const prior = coveredBy.get(node) ?? [];
          coveredBy.set(node, adding ? [...prior, id] : prior.filter((d) => d !== id));
          affectedNodes.add(node);
          countWork('subtree.coverageEdgesUpdated');
        }
      }
      if (after) declarations.set(id, after);
      else declarations.delete(id);
      countWork('subtree.contributionsChanged');
    };
    for (const ref of withdrawn) replace(deletionEffectKey(ref));
    for (const action of actions)
      for (const [ordinal, effect] of action.effects.entries()) {
        countWork('subtree.changedEffectsInspected');
        if (effect.type !== 'DeleteSubtree') continue;
        const id = deletionEffectKey({ action: action.id, ordinal }),
          prior = declarations.get(id),
          active = activity.isEffectActive({ action: action.id, ordinal });
        if (prior && prior.effect === effect && prior.active === active) continue;
        declarations.set(id, {
          action: { id: action.id, lamport: action.lamport },
          ordinal,
          effect,
          active,
          covered: prior?.covered ?? [],
          inherited: prior?.inherited ?? [],
        });
        dirty.add(id);
        tags.add(resourceKey(effect.tag));
        if (prior) tags.add(resourceKey(prior.effect.tag));
      }
    for (const id of dirty) {
      const entry = declarations.get(id);
      if (!entry) continue;
      const covered = new Set(
          [entry.effect.scope.target, ...entry.effect.scope.observedNodes].map(resourceKey),
        ),
        inherited: string[] = [],
        queue = [...covered];
      for (let i = 0; i < queue.length; i++) {
        const parent = queue[i];
        if (!nodes.has(parent)) throw new Error('Unknown captured visibility node');
        for (const child of children.get(parent) ?? []) {
          countWork('subtree.birthEdgesVisited');
          const birth = nodes.get(child)!.id.birth;
          if (
            covered.has(child) ||
            birth.type !== 'action' ||
            !activity.concurrent(birth.action, entry.action.id)
          )
            continue;
          covered.add(child);
          inherited.push(child);
          queue.push(child);
        }
      }
      replace(id, { ...entry, covered: [...covered], inherited });
    }
    // Each reused tag uses the LAST active declaration's inherited birth set.
    // Captured intervals and direct node coverage still belong to declarations.
    for (const tag of tags) {
      const old = groups.get(tag),
        ids = new Set<string>();
      for (const declaration of old?.declarations ?? [])
        ids.add(deletionEffectKey({ action: declaration.action.id, ordinal: declaration.ordinal }));
      for (const id of dirty) {
        const entry = declarations.get(id);
        if (entry && resourceKey(entry.effect.tag) === tag) ids.add(id);
      }
      const entries = [...ids]
        .flatMap((id) => {
          const d = declarations.get(id);
          return d && d.active && resourceKey(d.effect.tag) === tag ? [d] : [];
        })
        .sort(compareEffects);
      const inherited = (entries.at(-1)?.inherited ?? []).flatMap((id) => birthContent.get(id)!);
      const afterTapes = new Map(
        [...entries.flatMap((d) => d.effect.scope.ownedIntervals), ...inherited].map((r) => [
          resourceKey(r.tape),
          r.tape,
        ]),
      );
      for (const tape of old?.tapes ?? []) {
        const key = resourceKey(tape);
        tapeGroups.set(
          key,
          (tapeGroups.get(key) ?? []).filter((t) => t !== tag),
        );
        tapes.set(key, tape);
      }
      for (const [key, tape] of afterTapes) {
        tapeGroups.set(key, [...(tapeGroups.get(key) ?? []), tag]);
        tapes.set(key, tape);
      }
      if (entries.length)
        groups.set(tag, { declarations: entries, inherited, tapes: [...afterTapes.values()] });
      else groups.delete(tag);
      countWork('subtree.tagGroupsUpdated');
    }
    return {
      index: new SubtreeDeletions(
        nodes,
        children,
        birthContent,
        declarations,
        coveredBy,
        groups,
        tapeGroups,
      ),
      nodes: affectedNodes,
      tapes: [...tapes.values()],
    };
  }
  nodeTags(node: NodeId): readonly DeletionId[] {
    const entries = (this.coveredBy.get(resourceKey(node)) ?? [])
      .map((id) => this.declarations.get(id)!)
      .filter((d) => d.active)
      .sort(compareEffects);
    return [...new Map(entries.map((d) => [resourceKey(d.effect.tag), d.effect.tag])).values()];
  }
  /** The full projector tests concurrency against ANY active declaration of a
   * tag present on the source's current raw path, including reused tags. */
  hidesSplit(
    source: NodeId,
    action: ActionId,
    parent: (node: NodeId) => NodeId | null,
    activity: Activity,
  ): boolean {
    const seen = new Set<string>();
    for (let node: NodeId | null = source; node; node = parent(node)) {
      const id = resourceKey(node);
      if (seen.has(id)) throw new Error('Raw visibility placement contains a cycle');
      seen.add(id);
      countWork('subtree.splitAncestorEdgesVisited');
      for (const tag of this.nodeTags(node))
        if (
          this.groups
            .get(resourceKey(tag))
            ?.declarations.some((entry) => activity.concurrent(action, entry.action.id))
        )
          return true;
    }
    return false;
  }
  matches(
    token: TextToken,
    contains: (range: RangeRef, token: TextToken) => boolean,
  ): readonly SubtreeMatch[] {
    const matches: SubtreeMatch[] = [];
    for (const tag of this.tapeGroups.get(resourceKey(token.tape)) ?? []) {
      const group = this.groups.get(tag)!;
      countWork('subtree.tapeGroupsQueried');
      const inside = (range: RangeRef) => {
        countWork('subtree.intervalsQueried');
        return resourceKey(range.tape) === resourceKey(token.tape) && contains(range, token);
      };
      const inherited = group.inherited.some(inside);
      const declaration = group.declarations.find(
        (d) => inherited || d.effect.scope.ownedIntervals.some(inside),
      );
      if (declaration)
        matches.push({
          action: declaration.action,
          ordinal: declaration.ordinal,
          tag: declaration.effect.tag,
        });
    }
    return matches.sort(compareEffects);
  }
}
