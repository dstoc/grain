import { compareEffects } from '../contracts.js';
import type { SemanticEffect } from '../contracts.js';
import type { EffectOrder, LayoutPrefix, OccurrenceBucket } from '../layout/index.js';
import { resourceKey } from '../layout/index.js';
import { cellKey, sameId } from './cells.js';
import type { CellIndex } from './cells.js';
import type { HomeIndex } from './homes.js';

type Split = Extract<SemanticEffect, { type: 'SplitFlow' }>;
export interface SplitBirth {
  readonly effect: Split;
  readonly order: EffectOrder;
}
export function cutPosition(
  effect: Split,
  index: Pick<CellIndex, keyof CellIndex>,
  homes?: HomeIndex,
): number {
  if (!effect.basis.ranges.length) {
    if (!homes) throw new Error('Empty split requires its retained home domain');
    const home = homes.home(effect.cut.run);
    if (
      !sameId(effect.cut.boundary, home.cell.end) ||
      effect.cut.side !== 'left' ||
      effect.cut.predecessor !== null
    )
      throw new Error('Empty split needs the canonical trailing home cut');
    return index.range(home.cell).length;
  }
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
  layout: Pick<LayoutPrefix, keyof LayoutPrefix>,
  index: Pick<CellIndex, keyof CellIndex>,
  homes?: HomeIndex,
): readonly OccurrenceBucket[] {
  const groups = new Map<string, SplitBirth[]>();
  for (const birth of births) {
    const { effect } = birth;
    const placement = layout.blockPlacement(effect.newNode);
    if (!placement || !sameId(placement.occurrence, effect.occurrence)) continue;
    const key = JSON.stringify([
      effect.basis.ranges.length
        ? [
            'content',
            effect.basis.ranges.map(({ range, occurrence }) => [
              cellKey(range),
              resourceKey(occurrence),
            ]),
          ]
        : ['empty-home', resourceKey(effect.cut.run)],
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
            cutPosition(a.effect, index, homes) - cutPosition(b.effect, index, homes) ||
            compareEffects(a.order, b.order),
        )
        .map((birth) => birth.effect.occurrence),
    }));
}
