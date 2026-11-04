import type {
  ActionId,
  Allocation,
  DeletionId,
  NativeId,
  NativeTextRange,
  NodeId,
  RangeRef,
  TapeId,
} from '../contracts.js';
import type { Activity, EffectRef } from './activity.js';
import { resourceKey } from './identity.js';

/** One native UTF-16 text unit, never a permanent boundary embed. */
export interface TextToken {
  readonly tape: TapeId;
  readonly native: NativeId;
  /** Verified native manifest birth; null denotes shared genesis text. */
  readonly birth: ActionId | null;
}

export type VisibilityNode = Extract<Allocation, { type: 'node' }>;

/** MW-02–04 supply these queries from the same ready set and activity reduction. */
export interface VisibilityLayout {
  /** All retained allocations, including inactive births. */
  readonly nodes: readonly VisibilityNode[];
  /** Current raw effective block parent, unaffected by visibility/normalization. */
  parent(node: NodeId): NodeId | null;
  /** Final cell → run → flow ancestry → inline owner, including hidden text. */
  owner(token: TextToken): NodeId;
  /**
   * Effective layout effects that require this node as a destination/scaffold.
   * Exclude losing/unsafe intentions, obsolete anchors and the birth fallback.
   */
  requirements(node: NodeId): readonly EffectRef[];
  /** Open permanent marker interval membership in converged native order. */
  contains(interval: RangeRef, token: TextToken): boolean;
  /**
   * Membership in intervals initially owned by this node in its birth action's
   * causal view, including later native insertions inside those boundaries.
   * This is stable coverage, not current ownership or historical-source equality.
   */
  containsBirthContent(node: NodeId, token: TextToken): boolean;
}

export interface NodeVisibility {
  readonly node: NodeId;
  /** Exact direct/inherited tags, excluding tags on current ancestors. */
  readonly tags: readonly DeletionId[];
  /** Explicit deletion on this node or its current raw ancestors. */
  readonly deleted: boolean;
  readonly suppressed: boolean;
  readonly scaffold: boolean;
  /** Passes this layer; projection can still absorb/lift a header. */
  readonly available: boolean;
}

export interface TextVisibility {
  readonly token: TextToken;
  readonly insertionActive: boolean;
  /** Exact-text or captured-subtree interval tags, independent of current owner. */
  readonly tags: readonly DeletionId[];
  readonly deletedDestination: boolean;
  readonly visible: boolean;
}

export interface Visibility {
  readonly nodes: readonly NodeVisibility[];
  /** Preserves input order and identity; this reducer does not perform layout. */
  readonly text: readonly TextVisibility[];
}

function inExactRange(range: NativeTextRange, token: TextToken): boolean {
  return (
    resourceKey(range.tape) === resourceKey(token.tape) &&
    range.client === token.native.client &&
    range.clock <= token.native.clock &&
    token.native.clock - range.clock < range.length
  );
}

/** Pure full reference visibility reduction. It never changes raw placement. */
export function reduceVisibility(
  activity: Activity,
  layout: VisibilityLayout,
  tokens: readonly TextToken[],
  /** Packet-owned births may be dormant while their allocating action remains active. */
  birthEnabled: (node: NodeId) => boolean = () => true,
): Visibility {
  const nodes = new Map(layout.nodes.map((node) => [resourceKey(node.id), node]));
  if (nodes.size !== layout.nodes.length) throw new Error('Duplicate node allocation');
  const tags = new Map<string, Map<string, DeletionId>>();
  for (const key of nodes.keys()) tags.set(key, new Map());

  function requireNode(id: NodeId): VisibilityNode {
    const node = nodes.get(resourceKey(id));
    if (!node) throw new Error('Layout references an unknown node');
    return node;
  }
  function ancestors(id: NodeId): VisibilityNode[] {
    const result: VisibilityNode[] = [];
    const seen = new Set<string>();
    let current: NodeId | null = id;
    while (current) {
      const key = resourceKey(current);
      if (seen.has(key)) throw new Error('Raw block placement contains a cycle');
      seen.add(key);
      result.push(requireNode(current));
      current = layout.parent(current);
    }
    return result;
  }

  const deletes = activity.effects.filter(
    (entry) => entry.effect.type === 'DeleteText' || entry.effect.type === 'DeleteSubtree',
  );
  const inheritedCoverage = new Map<string, NodeId[]>();
  for (const { action, effect } of deletes) {
    if (effect.type !== 'DeleteSubtree') continue;
    const covered = new Set([effect.scope.target, ...effect.scope.observedNodes].map(resourceKey));
    const inherited: NodeId[] = [];
    // Birth parents, not current parents or a split's historical source. Repeat
    // to propagate through concurrent descendants in any allocation order.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of layout.nodes) {
        const key = resourceKey(node.id);
        if (
          !covered.has(key) &&
          node.birthSlot &&
          covered.has(resourceKey(node.birthSlot.parent)) &&
          node.id.birth.type === 'action' &&
          activity.concurrent(node.id.birth.action, action)
        ) {
          covered.add(key);
          inherited.push(node.id);
          changed = true;
        }
      }
    }
    inheritedCoverage.set(resourceKey(effect.tag), inherited);
    for (const key of covered) {
      const nodeTags = tags.get(key);
      if (!nodeTags) throw new Error('Deletion scope references an unknown node');
      nodeTags.set(resourceKey(effect.tag), effect.tag);
    }
  }

  const paths = new Map(layout.nodes.map((node) => [resourceKey(node.id), ancestors(node.id)]));
  const deleted = new Set(
    layout.nodes
      .filter((node) =>
        paths.get(resourceKey(node.id))!.some((n) => tags.get(resourceKey(n.id))!.size),
      )
      .map((node) => resourceKey(node.id)),
  );
  const text = tokens.map((token): TextVisibility => {
    const owner = layout.owner(token);
    requireNode(owner);
    const insertionActive = token.birth === null || activity.isActive(token.birth);
    const tokenTags = new Map<string, DeletionId>();
    for (const { effect } of deletes) {
      if (effect.type !== 'DeleteText' && effect.type !== 'DeleteSubtree') continue;
      const covered =
        effect.type === 'DeleteText'
          ? effect.observed.some((range) => inExactRange(range, token))
          : effect.type === 'DeleteSubtree' &&
            (effect.scope.ownedIntervals.some(
              (interval) =>
                resourceKey(interval.tape) === resourceKey(token.tape) &&
                layout.contains(interval, token),
            ) ||
              inheritedCoverage
                .get(resourceKey(effect.tag))!
                .some((node) => layout.containsBirthContent(node, token)));
      if (covered) tokenTags.set(resourceKey(effect.tag), effect.tag);
    }
    const deletedDestination = deleted.has(resourceKey(owner));
    return {
      token,
      insertionActive,
      tags: [...tokenTags.values()],
      deletedDestination,
      visible: insertionActive && !tokenTags.size && !deletedDestination,
    };
  });

  const kept = new Set<string>();
  function keep(id: NodeId): void {
    if (deleted.has(resourceKey(id))) return;
    for (const ancestor of paths.get(resourceKey(id))!) kept.add(resourceKey(ancestor.id));
  }
  function birthActive(node: VisibilityNode): boolean {
    return (
      (node.id.birth.type === 'genesis' || activity.isActive(node.id.birth.action)) &&
      birthEnabled(node.id)
    );
  }
  for (const node of layout.nodes) {
    if (
      birthActive(node) ||
      layout.requirements(node.id).some((ref) => activity.isEffectActive(ref))
    )
      keep(node.id);
  }
  for (const entry of text) if (entry.visible) keep(layout.owner(entry.token));

  return {
    text,
    nodes: layout.nodes.map((node) => {
      const key = resourceKey(node.id);
      const inactive = !birthActive(node);
      return {
        node: node.id,
        tags: [...tags.get(key)!.values()],
        deleted: deleted.has(key),
        suppressed: inactive && !kept.has(key),
        scaffold: inactive && kept.has(key),
        available: kept.has(key) && !deleted.has(key),
      };
    }),
  };
}
