import type { DeletionId } from '../contracts.js';
import { resourceKey } from '../visibility/identity.js';
import type { Activity } from '../visibility/activity.js';
import type { TextToken } from '../visibility/visibility.js';
import { reduceVisibilityWithTextTags } from '../visibility/visibility.js';
import type { reduceVisibility } from '../visibility/visibility.js';

interface Interval {
  readonly start: number;
  readonly end: number;
  readonly tag: DeletionId;
  readonly order: number;
}
interface Root extends Interval {
  readonly left?: Root;
  readonly right?: Root;
  readonly maximum: number;
}
function build(intervals: readonly Interval[], from = 0, to = intervals.length): Root | undefined {
  if (from === to) return undefined;
  const at = (from + to) >>> 1,
    left = build(intervals, from, at),
    right = build(intervals, at + 1, to),
    interval = intervals[at];
  return {
    ...interval,
    left,
    right,
    maximum: Math.max(interval.end, left?.maximum ?? -Infinity, right?.maximum ?? -Infinity),
  };
}
export interface TextDeletionWork {
  exactDeletionRangesIndexed: number;
  exactDeletionQueries: number;
  exactDeletionNodesVisited: number;
}

/** One immutable projection's active exact deletions. Native clocks are ordered
 * only within a tape/client pair. Subtree coverage stays in the shared semantic
 * reducer and never uses these exact insertion intervals.
 */
export class ExactTextDeletions {
  private readonly tapes = new Map<string, Map<number, Root | undefined>>();
  constructor(
    activity: Pick<Activity, 'effects'>,
    private readonly work: TextDeletionWork,
  ) {
    const tapes = new Map<string, Map<number, Interval[]>>();
    for (const [order, { effect }] of activity.effects.entries()) {
      if (effect.type !== 'DeleteText') continue;
      for (const range of effect.observed) {
        const key = resourceKey(range.tape);
        let clients = tapes.get(key);
        if (!clients) tapes.set(key, (clients = new Map()));
        let intervals = clients.get(range.client);
        if (!intervals) clients.set(range.client, (intervals = []));
        intervals.push({
          start: range.clock,
          end: range.clock + range.length,
          tag: effect.tag,
          order,
        });
        work.exactDeletionRangesIndexed++;
      }
    }
    for (const [tape, clients] of tapes) {
      const roots = new Map<number, Root | undefined>();
      for (const [client, intervals] of clients)
        roots.set(client, build(intervals.sort((a, b) => a.start - b.start || a.order - b.order)));
      this.tapes.set(tape, roots);
    }
  }
  tags(token: Pick<TextToken, 'tape' | 'native'>): readonly DeletionId[] {
    this.work.exactDeletionQueries++;
    const found: Interval[] = [],
      clock = token.native.clock;
    const visit = (root: Root | undefined): void => {
      if (!root || root.maximum <= clock) return;
      this.work.exactDeletionNodesVisited++;
      visit(root.left);
      if (root.start > clock) return;
      if (clock < root.end) found.push(root);
      visit(root.right);
    };
    visit(this.tapes.get(resourceKey(token.tape))?.get(token.native.client));
    return found.sort((a, b) => a.order - b.order).map((entry) => entry.tag);
  }
}

/** Use the reference node/subtree rules with an independently indexed exact-text
 * query. No query or activity callback escapes into a publication/checkpoint.
 */
export function indexedVisibility(work: TextDeletionWork): typeof reduceVisibility {
  return (activity, layout, tokens, birthEnabled = () => true) => {
    const index = new ExactTextDeletions(activity, work);
    return reduceVisibilityWithTextTags(activity, layout, tokens, birthEnabled, (token) =>
      index.tags(token),
    );
  };
}
