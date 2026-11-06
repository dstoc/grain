import { countWork } from '../diagnostics.js';
import { compareEffects } from '../contracts.js';
import type { ActionEnvelope, DeletionId, NativeTextRange } from '../contracts.js';
import { resourceKey } from '../visibility/identity.js';
import type { Activity, EffectRef } from '../visibility/activity.js';
import type { TextToken, OrderedDeletionTag } from '../visibility/visibility.js';
import { PersistentMap, set, remove } from './map.js';
import type { MapRoot } from './map.js';
import { summarizeIntervals, clockIntervalsAt } from './clock-intervals.js';

interface Interval {
  readonly start: number;
  readonly end: number;
  readonly tag: DeletionId;
  readonly order: number;
}
type Root<T extends Interval> = MapRoot<T> | undefined;
function maximum<T extends Interval>(root: Root<T>): number {
  return summarizeIntervals(root, () => countWork('deletion.intervalNodesSummarized'));
}
const position = (value: number) => value.toString().padStart(16, '0');
const pair = (tape: TextToken['tape'], client: number) => `${resourceKey(tape)}:${client}`;
function query<T extends Interval>(root: Root<T>, clock: number, work: TextDeletionWork): T[] {
  work.exactDeletionQueries++;
  return clockIntervalsAt(root, clock, () => {
    countWork('deletion.queryNodesVisited');
    work.exactDeletionNodesVisited++;
  });
}
function insert<T extends Interval>(root: Root<T>, key: string, value: T): Root<T> {
  const result = set(root, key, value);
  // Summarize while preparing, so a selected-address read never pays deferred
  // whole-index work. Unchanged child roots already have their summaries.
  maximum(result);
  return result;
}
export interface TextDeletionWork {
  exactDeletionRangesIndexed: number;
  exactDeletionQueries: number;
  exactDeletionNodesVisited: number;
}

/** Cold numeric-order adapter retained for callers of the full visibility pass. */
class NumericTextDeletions {
  private readonly roots = new Map<string, Root<Interval>>();
  constructor(
    activity: Pick<Activity, 'effects'>,
    private readonly work: TextDeletionWork,
  ) {
    countWork('deletion.fullIndexesConstructed');
    for (const [order, { effect }] of activity.effects.entries()) {
      countWork('deletion.retainedEffectsInspected');
      if (effect.type !== 'DeleteText') continue;
      for (const [ordinal, range] of effect.observed.entries()) {
        const key = pair(range.tape, range.client);
        this.roots.set(
          key,
          insert(this.roots.get(key), `${position(range.clock)}:${order}:${ordinal}`, {
            start: range.clock,
            end: range.clock + range.length,
            tag: effect.tag,
            order,
          }),
        );
        countWork('deletion.rangesIndexed');
        work.exactDeletionRangesIndexed++;
      }
    }
  }
  matches(token: Pick<TextToken, 'tape' | 'native'>): readonly OrderedDeletionTag[] {
    return query(
      this.roots.get(pair(token.tape, token.native.client)),
      token.native.clock,
      this.work,
    ).map(({ tag, order }) => ({ tag, order }));
  }
}

export interface DeletionDeclaration extends Interval {
  /** Stable semantic order, independent of dense active-effect positions. */
  readonly action: Pick<ActionEnvelope, 'id' | 'lamport'>;
  readonly ordinal: number;
}
interface Contribution {
  readonly declaration: DeletionDeclaration;
  readonly ranges: readonly NativeTextRange[];
  readonly active: boolean;
}
const effectKey = (ref: EffectRef) => `${ref.action.actor}:${ref.action.sequence}:${ref.ordinal}`;
const intervalKey = (clock: number, ref: EffectRef, ordinal: number) =>
  `${position(clock)}:${effectKey(ref)}:${ordinal}`;

/** Immutable exact-deletion contributions. Updates touch only the named effects
 * and their tape/client search paths. Inactive declarations remain available for
 * controls; withdrawal removes only that declaration, never a reused tag group.
 * No activity callback or previous index wrapper is retained.
 */
export class ExactTextDeletions {
  private constructor(
    private readonly roots = new PersistentMap<Root<DeletionDeclaration>>(),
    private readonly effects = new PersistentMap<Contribution>(),
  ) {}
  static fromEffects(
    activity: Pick<Activity, 'effects'>,
    work: TextDeletionWork,
  ): NumericTextDeletions {
    return new NumericTextDeletions(activity, work);
  }
  static empty(): ExactTextDeletions {
    return new ExactTextDeletions();
  }
  static create(
    actions: Iterable<ActionEnvelope>,
    active: (ref: EffectRef) => boolean,
    work: TextDeletionWork,
  ): ExactTextDeletions {
    countWork('deletion.fullIndexesConstructed');
    return ExactTextDeletions.empty().update(actions, active, work);
  }
  update(
    actions: Iterable<ActionEnvelope>,
    active: (ref: EffectRef) => boolean,
    work: TextDeletionWork,
    withdrawn: readonly EffectRef[] = [],
  ): ExactTextDeletions {
    const roots = this.roots.fork(),
      effects = this.effects.fork();
    const replace = (ref: EffectRef, after?: Contribution) => {
      const id = effectKey(ref),
        before = effects.get(id);
      if (before === after) return;
      for (const [contribution, adding] of [
        [before, false],
        [after, true],
      ] as const) {
        if (!contribution?.active) continue;
        for (const [ordinal, range] of contribution.ranges.entries()) {
          const tape = pair(range.tape, range.client),
            key = intervalKey(range.clock, ref, ordinal);
          const root = adding
            ? insert(roots.get(tape), key, {
                ...contribution.declaration,
                start: range.clock,
                end: range.clock + range.length,
              })
            : remove(roots.get(tape), key);
          maximum(root);
          roots.set(tape, root);
          countWork(adding ? 'deletion.rangesIndexed' : 'deletion.rangesRemoved');
          if (adding) work.exactDeletionRangesIndexed++;
        }
      }
      if (after) effects.set(id, after);
      else effects.delete(id);
      countWork('deletion.contributionsChanged');
    };
    for (const ref of withdrawn) replace(ref);
    for (const action of actions)
      for (const [ordinal, effect] of action.effects.entries()) {
        countWork('deletion.changedEffectsInspected');
        if (effect.type !== 'DeleteText') continue;
        const ref = { action: action.id, ordinal },
          enabled = active(ref);
        const before = effects.get(effectKey(ref));
        // Exact payload compatibility is the producer's obligation. Still keep
        // declaration replacement explicit for changed payloads and eligibility.
        if (
          before &&
          before.ranges === effect.observed &&
          before.active === enabled &&
          before.declaration.action.lamport === action.lamport &&
          resourceKey(before.declaration.tag) === resourceKey(effect.tag)
        )
          continue;
        replace(ref, {
          declaration: {
            action: { id: action.id, lamport: action.lamport },
            ordinal,
            tag: effect.tag,
            order: 0,
            start: 0,
            end: 0,
          },
          ranges: effect.observed,
          active: enabled,
        });
      }
    return new ExactTextDeletions(roots, effects);
  }
  declarations(
    token: Pick<TextToken, 'tape' | 'native'>,
    work: TextDeletionWork,
  ): readonly DeletionDeclaration[] {
    return query(
      this.roots.get(pair(token.tape, token.native.client)),
      token.native.clock,
      work,
    ).sort(compareEffects);
  }
  tags(token: Pick<TextToken, 'tape' | 'native'>, work: TextDeletionWork): readonly DeletionId[] {
    return [
      ...new Map(this.declarations(token, work).map(({ tag }) => [resourceKey(tag), tag])).values(),
    ];
  }
  /** Bridge only at a full projection boundary; dense ranks never enter roots. */
  matches(
    token: Pick<TextToken, 'tape' | 'native'>,
    work: TextDeletionWork,
    order: ReadonlyMap<string, number>,
  ): readonly OrderedDeletionTag[] {
    return this.declarations(token, work).map((declaration) => {
      const rank = order.get(
        effectKey({ action: declaration.action.id, ordinal: declaration.ordinal }),
      );
      if (rank === undefined)
        throw new Error('Exact deletion index differs from active projection');
      return { tag: declaration.tag, order: rank };
    });
  }
}
