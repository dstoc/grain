import { compareEffects } from '../contracts.js';
import type {
  ActionEnvelope,
  BlockSlot,
  InlineSlot,
  OccurrenceId,
  ResourceId,
  ResourceKind,
} from '../contracts.js';

/** Logical equality for decoded IDs. These private index keys are not a wire encoding. */
export function resourceKey(id: ResourceId<ResourceKind>): string {
  return JSON.stringify([
    id.kind,
    id.birth.type === 'genesis'
      ? ['genesis', id.birth.genesisId]
      : ['action', id.birth.action.actor, id.birth.action.sequence.toString()],
    id.ordinal,
  ]);
}
export interface EffectOrder {
  readonly action: Pick<ActionEnvelope, 'id' | 'lamport'>;
  readonly ordinal: number;
}
export interface OrderedOccurrence {
  readonly id: OccurrenceId;
  readonly slot: BlockSlot | InlineSlot;
  /** Genesis is earlier than any action; genesis siblings must form a chain. */
  readonly order: EffectOrder | null;
}
/** A local ordering bucket supplied by MW-04, in converged cut order. It has
 * no persistent ID. Members must be action occurrences at the same sibling gap.
 * The earliest birth ranks the whole bucket against ordinary followers.
 */
export interface OccurrenceBucket {
  readonly roots: readonly OccurrenceId[];
}
export function slotSequence(slot: BlockSlot | InlineSlot): string {
  return 'parent' in slot
    ? JSON.stringify(['block', resourceKey(slot.parent)])
    : JSON.stringify(['inline', resourceKey(slot.run), resourceKey(slot.boundary), slot.side]);
}
export function sameSlot(left: BlockSlot | InlineSlot, right: BlockSlot | InlineSlot): boolean {
  return (
    slotSequence(left) === slotSequence(right) &&
    (left.predecessor === null
      ? right.predecessor === null
      : right.predecessor !== null &&
        resourceKey(left.predecessor) === resourceKey(right.predecessor))
  );
}

/** Complete predecessor traversal, including ghosts. Filtering happens after traversal.
 * MW-04 supplies cohort membership/cut order; this traversal preserves followers.
 */
export function orderOccurrences(
  occurrences: readonly OrderedOccurrence[],
  buckets: readonly OccurrenceBucket[] = [],
): OrderedOccurrence[] {
  const byId = new Map(occurrences.map((entry) => [resourceKey(entry.id), entry]));
  if (byId.size !== occurrences.length) throw new Error('Duplicate occurrence');
  const sequences = new Set(occurrences.map((entry) => slotSequence(entry.slot)));
  if (sequences.size > 1) throw new Error('Order one slot sequence at a time');
  const bucketById = new Map<string, { entries: OrderedOccurrence[]; order: EffectOrder }>();
  for (const bucket of buckets) {
    if (!bucket.roots.length) throw new Error('Empty occurrence bucket');
    const entries = bucket.roots.map((id) => {
      const entry = byId.get(resourceKey(id));
      if (!entry?.order) throw new Error('Bucket member must be an allocated action occurrence');
      return entry;
    });
    const first = entries[0];
    if (entries.some((entry) => !sameSlot(entry.slot, first.slot)))
      throw new Error('Bucket members must share a sibling gap');
    const order = entries.reduce(
      (earliest, entry) => (compareEffects(entry.order!, earliest) < 0 ? entry.order! : earliest),
      first.order!,
    );
    const unit = { entries, order };
    for (const entry of entries) {
      const key = resourceKey(entry.id);
      if (bucketById.has(key)) throw new Error('Occurrence belongs to multiple buckets');
      bucketById.set(key, unit);
    }
  }
  const followers = new Map<string | null, OrderedOccurrence[]>();
  for (const entry of occurrences) {
    const predecessor = entry.slot.predecessor;
    if (predecessor !== null) {
      const previous = byId.get(resourceKey(predecessor));
      if (!previous || slotSequence(previous.slot) !== slotSequence(entry.slot))
        throw new Error('Predecessor is missing or belongs to another slot sequence');
      if (
        entry.order === null
          ? previous.order !== null
          : previous.order !== null && compareEffects(previous.order, entry.order) > 0
      )
        throw new Error('Predecessor must be earlier than its follower');
    }
    const key = predecessor === null ? null : resourceKey(predecessor);
    const group = followers.get(key) ?? [];
    group.push(entry);
    followers.set(key, group);
  }
  for (const [predecessor, group] of followers) {
    // A valid genesis sequence has one follower per predecessor. Never use allocation order.
    if (group.filter((entry) => entry.order === null).length > 1)
      throw new Error('Genesis occurrences must form a predecessor chain');
    const units: { entries: OrderedOccurrence[]; order: EffectOrder | null }[] = [];
    const added = new Set<object>();
    for (const entry of group) {
      const bucket = bucketById.get(resourceKey(entry.id));
      if (bucket) {
        if (!added.has(bucket)) units.push(bucket);
        added.add(bucket);
      } else units.push({ entries: [entry], order: entry.order });
    }
    units.sort((a, b) =>
      a.order === null
        ? b.order === null
          ? 0
          : 1
        : b.order === null
          ? -1
          : compareEffects(b.order, a.order),
    );
    for (let i = 1; i < units.length; i++) {
      const left = units[i - 1].order;
      const right = units[i].order;
      if (left && right && compareEffects(left, right) === 0)
        throw new Error('Equal-priority followers must form a predecessor chain');
    }
    followers.set(
      predecessor,
      units.flatMap((unit) => unit.entries),
    );
  }
  const result: OrderedOccurrence[] = [];
  const stack = [...(followers.get(null) ?? [])].reverse();
  const visited = new Set<string>();
  while (stack.length) {
    const entry = stack.pop()!;
    const key = resourceKey(entry.id);
    if (visited.has(key)) throw new Error('Cyclic occurrence predecessors');
    visited.add(key);
    result.push(entry);
    const children = followers.get(key) ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  if (result.length !== occurrences.length) throw new Error('Cyclic occurrence predecessors');
  return result;
}
