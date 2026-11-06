import type { NativeTextRange } from '../contracts.js';
import type { Interpretations } from '../projection/interpretation.js';
import { resourceKey } from '../layout/index.js';
import { countWork } from '../diagnostics.js';
import { PersistentMap, set, remove } from './map.js';
import type { MapRoot } from './map.js';
import { summarizeIntervals, clockIntervalsAt } from './clock-intervals.js';

interface Interval {
  readonly start: number;
  readonly end: number;
}
const pair = (range: NativeTextRange) => `${resourceKey(range.tape)}:${range.client}`;
const key = (range: NativeTextRange, packet: string, ordinal: number) =>
  `${range.clock.toString().padStart(16, '0')}:${packet}:${ordinal}`;
export interface MaskChange {
  readonly packet: string;
  /** Missing ranges withdraw only this packet's masks. */
  readonly ranges?: readonly NativeTextRange[];
}
/** Exact native syntax masks; visible text/substring offsets never enter this
 * index. It stores current packet contributions and no interpretation callbacks.
 */
export class ExactSyntaxMasks {
  private constructor(
    private readonly roots = new PersistentMap<MapRoot<Interval> | undefined>(),
    private readonly packets = new PersistentMap<readonly NativeTextRange[]>(),
  ) {}
  static create(packets: Interpretations['packets']): ExactSyntaxMasks {
    countWork('masks.fullIndexesConstructed');
    return new ExactSyntaxMasks().update(
      packets.map((p) => ({ packet: resourceKey(p.id), ranges: p.syntaxMask })),
    );
  }
  update(changes: readonly MaskChange[]): ExactSyntaxMasks {
    const roots = this.roots.fork(),
      packets = this.packets.fork();
    for (const change of changes) {
      const prior = packets.get(change.packet);
      if (prior === change.ranges) continue;
      for (const [ranges, adding] of [
        [prior, false],
        [change.ranges, true],
      ] as const)
        for (const [ordinal, range] of ranges?.entries() ?? []) {
          const tape = pair(range),
            id = key(range, change.packet, ordinal);
          const root = adding
            ? set(roots.get(tape), id, { start: range.clock, end: range.clock + range.length })
            : remove(roots.get(tape), id);
          summarizeIntervals(root, () => countWork('masks.intervalNodesSummarized'));
          roots.set(tape, root);
          countWork(adding ? 'masks.rangesIndexed' : 'masks.rangesRemoved');
        }
      if (change.ranges) packets.set(change.packet, change.ranges);
      else packets.delete(change.packet);
    }
    return new ExactSyntaxMasks(roots, packets);
  }
  masked(range: NativeTextRange): boolean {
    countWork('masks.queries');
    return clockIntervalsAt(
      this.roots.get(pair(range)),
      range.clock,
      () => countWork('masks.queryNodesVisited'),
      range.length === 0,
    ).some((mask) => mask.end >= range.clock + range.length);
  }
}
