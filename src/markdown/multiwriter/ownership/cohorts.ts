import { compareEffects } from '../contracts.js';
import type { SemanticEffect } from '../contracts.js';
import type { EffectOrder, LayoutPrefix, OccurrenceBucket } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { cellKey, sameId } from './cells.js';
import type { CellIndex } from './cells.js';

type Split = Extract<SemanticEffect, { type: 'SplitFlow' }>;
export interface SplitBirth {
  readonly effect: Split;
  readonly order: EffectOrder;
}
export function cutPosition(effect: Split, index: CellIndex): number {
  const cells = effect.basis.ranges.flatMap((entry) => index.range(entry.range));
  if (new Set(cells.map((cell) => cellKey(cell.range))).size !== cells.length)
    throw new Error('Overlapping captured flow basis');
  const positions = new Set<number>();
  for (const [i, cell] of cells.entries()) {
    if (sameId(cell.range.start, effect.cut.boundary)) positions.add(i);
    if (sameId(cell.range.end, effect.cut.boundary)) positions.add(i + 1);
  }
  if (positions.size !== 1) throw new Error('Cut is not a unique boundary in captured basis');
  return [...positions][0];
}
export function splitBuckets(
  births: readonly SplitBirth[],
  layout: LayoutPrefix,
  index: CellIndex,
): readonly OccurrenceBucket[] {
  const groups = new Map<string, SplitBirth[]>();
  for (const birth of births) {
    const { effect } = birth;
    const placement = layout.blockPlacement(effect.newNode);
    if (!placement || !sameId(placement.occurrence, effect.occurrence)) continue;
    const key = JSON.stringify([
      effect.basis.ranges.map(({ range, occurrence }) => [cellKey(range), resourceKey(occurrence)]),
      resourceKey(effect.outerSlot.parent),
      effect.outerSlot.predecessor && resourceKey(effect.outerSlot.predecessor),
    ]);
    const group = groups.get(key) ?? [];
    group.push(birth);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      roots: group
        .sort(
          (a, b) =>
            cutPosition(a.effect, index) - cutPosition(b.effect, index) ||
            compareEffects(a.order, b.order),
        )
        .map((birth) => birth.effect.occurrence),
    }));
}
